#include "space_data_module_invoke.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

// Planet, moon and asteroid imagery for the console's bodies, retrieved from
// public-domain NASA/USGS global mosaics and cut into the engine's tile
// pyramid: the WASM form of propagator/solar-system-bodies/tools/build-imagery.py
// (owner 2026-10-13: "the astreroids and all the other stuff need to be data
// retrieval modules on SDN").
//
// Each source is a global equirectangular GeoTIFF (USGS Astrogeology, NASA SVS,
// NASA/JPL Photojournal) of 8 MB to 800 MB: uncompressed or LZW strips, or LZW
// tiles. Nothing is held whole. The stages read:
//   plan_imagery  the first MiB of every source (the TIFF header and, for these
//                 files, the image file directory);
//   advance       any directory arrays outside that MiB (strip or tile offsets
//                 and byte counts, GeoTIFF keys), then the image data in whole
//                 strips or tile rows, at most three 48 MiB ranges per stage;
//                 every row is decoded, its latitude converted from IAU
//                 planetocentric to the planetodetic latitude the engine's
//                 geographic tiling uses on the body's PCK ellipsoid (a, c),
//                 and area-averaged into the output grid as it arrives, so a
//                 body holds only its output (4096 x 2048 at most);
//   build_imagery once every body is done, one tile pack and one whole-body
//                 texture per body, and an index, as file frames;
//   announce_imagery one $PNM per file (FILE_NAME, CID) after the host adapter
//                 added them to the node's IPFS, provider usgs-astrogeology,
//                 source body-imagery.
// A body whose source fails is left out (the console draws it in its albedo
// colour) and named in the report; the others are published.
//
// Output, per body (FILE_NAME imagery/<NAIF id>/...):
//   tiles.pack   "SDNTILE1", u32 version 1, u32 tile count, u8 maximum level,
//                u8 channels, u16 0; then per tile u8 level, u8 0, u16 x,
//                u16 y, u16 0, u32 offset, u32 length (offsets from the pack
//                start); then the JPEG tiles. The engine's
//                GeographicTilingScheme: 2 x 1 tiles of 256 px at level 0,
//                x from 180 W, y from the north pole, planetodetic latitude.
//   texture.jpg  the whole body, 2048 x 1024, same projection (the inactive
//                ellipsoid's texture).
//   imagery/index.json: per body its name, credit, licence, source and
//                maximum level.
//
// Licence: the sources are NASA mission products (public domain, or NASA Dawn
// data with its mission credit); each body's credit and licence ride in the
// index and the ingest meta. Coordinator D5 (multi-body round 2, 2026-10-13).

using Json = nlohmann::json;
namespace {
constexpr size_t maxControlBytes = 4u * 1024u * 1024u;
constexpr size_t headBytes = 1u << 20;               // the first stage reads 1 MiB of each source
constexpr size_t chunkBytes = 48u * 1024u * 1024u;   // under the host's 100 MB body ceiling
constexpr size_t chunksPerStage = 3;
constexpr size_t maxFrames = 60;
constexpr int maxLevel = 3;                          // 4096 x 2048 at most
constexpr int textureLevel = 2;                      // 2048 x 1024
constexpr int tileSize = 256;
constexpr int jpegQuality = 85;
constexpr double kPi = 3.14159265358979323846;
constexpr const char* providerId = "usgs-astrogeology";
constexpr const char* sourceName = "body-imagery";
constexpr const char* credit = "Planet and moon imagery: NASA mission global mosaics via USGS Astrogeology, NASA SVS and NASA/JPL Photojournal";
constexpr const char* licence = "NASA and USGS Astrogeology mosaics of NASA mission data: public domain; NASA Dawn data free with the mission credit";

struct Source {
  int32_t naif;
  const char* name;
  const char* url;
  double a, c;  // PCK radii (km): equatorial and polar (pck00011)
  bool georef;  // false: the file carries no GeoTIFF keys; it is a -180..180, 90..-90 global grid
  const char* credit;
  const char* licence;
};
const std::vector<Source>& sources() {
  static const char* pd = "public domain (USGS Astrogeology, NASA)";
  static const std::vector<Source> s = {
      {199, "Mercury", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_64ppd.tif", 2440.53, 2438.26, true, "NASA/JHUAPL/CIW MESSENGER MDIS, USGS Astrogeology", pd},
      {299, "Venus", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m.tif", 6051.8, 6051.8, true, "NASA/JPL Magellan, USGS Astrogeology", pd},
      {301, "Moon", "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_16k.tif", 1737.4, 1737.4, false, "NASA/GSFC/Arizona State University LRO LROC WAC, NASA Scientific Visualization Studio (CGI Moon Kit)", "public domain (NASA SVS)"},
      {499, "Mars", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_Viking_ClrMosaic_global_925m.tif", 3396.19, 3376.2, true, "NASA/JPL Viking Orbiter, USGS Astrogeology MDIM colour", pd},
      {599, "Jupiter", "https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia07/pia07782/PIA07782.tif", 71492.0, 66854.0, false, "NASA/JPL/Space Science Institute Cassini ISS (PIA07782)", "public domain (NASA/JPL Photojournal)"},
      {501, "Io", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif", 1829.4, 1815.7, true, "NASA/JPL Galileo SSI and Voyager, USGS Astrogeology", pd},
      {502, "Europa", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif", 1562.6, 1559.5, true, "NASA/JPL Galileo SSI and Voyager, USGS Astrogeology", pd},
      {503, "Ganymede", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif", 2631.2, 2631.2, true, "NASA/JPL Galileo SSI and Voyager, USGS Astrogeology", pd},
      {504, "Callisto", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif", 2410.3, 2410.3, true, "NASA/JPL Galileo SSI and Voyager, USGS Astrogeology", pd},
      {602, "Enceladus", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif", 256.6, 248.3, true, "NASA/JPL/Space Science Institute Cassini ISS, USGS Astrogeology", pd},
      {603, "Tethys", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Tethys_Cassini_mosaic_global_293m.tif", 538.4, 526.3, true, "NASA/JPL/Space Science Institute Cassini ISS, USGS Astrogeology", pd},
      {604, "Dione", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Dione_Cassini_Voyager_mosaic_global_154m.tif", 563.4, 559.6, true, "NASA/JPL/Space Science Institute Cassini ISS and Voyager, USGS Astrogeology", pd},
      {605, "Rhea", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Rhea_Cassini_Voyager_mosaic_global_417m.tif", 765.0, 762.4, true, "NASA/JPL/Space Science Institute Cassini ISS and Voyager, USGS Astrogeology", pd},
      {606, "Titan", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif", 2575.15, 2574.47, true, "NASA/JPL/Space Science Institute Cassini ISS, USGS Astrogeology", pd},
      {608, "Iapetus", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Iapetus_Cassini_Voyager_mosaic_global_783m.tif", 745.7, 712.1, true, "NASA/JPL/Space Science Institute Cassini ISS and Voyager, USGS Astrogeology", pd},
      {801, "Triton", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif", 1352.6, 1352.6, true, "NASA/JPL Voyager 2, USGS Astrogeology", pd},
      {999, "Pluto", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif", 1188.3, 1188.3, true, "NASA/JHUAPL/SwRI New Horizons LORRI and MVIC, USGS Astrogeology", pd},
      {901, "Charon", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif", 606.0, 606.0, true, "NASA/JHUAPL/SwRI New Horizons LORRI and MVIC, USGS Astrogeology", pd},
      {401, "Phobos", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Phobos_Viking_Mosaic_40ppd_DLRcontrol.tif", 13.0, 9.1, true, "NASA/JPL Viking Orbiter, USGS Astrogeology (DLR control network)", "public domain (NASA Viking mission data, USGS Astrogeology)"},
      {2000001, "Ceres", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif", 487.3, 446.0, true, "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA Dawn Framing Camera, USGS Astrogeology", "NASA Dawn mission data (Planetary Data System archive), free use with the mission credit (NASA/JPL image use policy)"},
      {2000004, "Vesta", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd.tif", 289.0, 229.0, true, "NASA/JPL-Caltech/UCLA/MPS/DLR/IDA Dawn Framing Camera, USGS Astrogeology", "NASA Dawn mission data (Planetary Data System archive), free use with the mission credit (NASA/JPL image use policy)"},
  };
  return s;
}

const char* error = "Invalid body imagery input.";
int fail(const char* message) { plugin_set_error("invalid-body-imagery-input", message); return 1; }
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)

// ── frames ─────────────────────────────────────────────────────────────────
std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> out;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, port) == 0) out.push_back(f);
  }
  return out;
}
Json json(const char* port) {
  const auto list = frames(port);
  if (list.size() != 1 || !list[0]->payload || list[0]->payload_length == 0 || list[0]->payload_length > maxControlBytes) return Json();
  return Json::parse(list[0]->payload, list[0]->payload + list[0]->payload_length, nullptr, false);
}
int output(const char* port, const Json& value) {
  const auto text = value.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t*>(text.data()), text.size());
}
int outputBytes(const char* port, const std::vector<uint8_t>& bytes) {
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, bytes.data(), bytes.size());
}
uint32_t le32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }

struct Response { int status; const uint8_t* body; size_t length; };
bool responses(size_t expected, std::vector<Response>& out) {
  const auto list = frames("response");
  NEED(list.size() == expected, "One HTTP response per planned request is required.");
  out.clear();
  for (const auto* f : list) {
    NEED(f->payload && f->payload_length >= 8 && std::memcmp(f->payload, "$HRB", 4) == 0, "Expected raw-body-v1 HTTP responses.");
    NEED(f->payload_length - 8 <= chunkBytes, "An HTTP response is larger than its planned range.");
    out.push_back({int(le32(f->payload + 4)), f->payload + 8, f->payload_length - 8});
  }
  return true;
}
// Every range has its own URL (a query the static servers ignore) and states
// its own validator: the host books a validator per URL on any 2xx and would
// otherwise make one range answer 304 to another's ETag.
Json rangeRequest(const std::string& url, uint64_t first, uint64_t last) {
  const std::string range = std::to_string(first) + "-" + std::to_string(last);
  return {{"method", "GET"}, {"url", url + "?sdn-range=" + range},
          {"headers", {{"Range", "bytes=" + range}, {"If-Modified-Since", "Thu, 01 Jan 1970 00:00:00 GMT"}}},
          {"timeoutMs", 900000}, {"maxBytes", last - first + 1}, {"responseWire", "raw-body-v1"}};
}

// ── binary state ───────────────────────────────────────────────────────────
struct Writer {
  std::vector<uint8_t> b;
  void raw(const void* p, size_t n) { const auto* q = static_cast<const uint8_t*>(p); b.insert(b.end(), q, q + n); }
  template <class T> void put(T v) { raw(&v, sizeof v); }
  void str(const std::string& s) { put<uint32_t>(uint32_t(s.size())); raw(s.data(), s.size()); }
  template <class T> void vec(const std::vector<T>& v) { put<uint64_t>(v.size()); if (!v.empty()) raw(v.data(), v.size() * sizeof(T)); }
};
struct Reader {
  const uint8_t* p; size_t n; size_t at = 0; bool ok = true;
  bool raw(void* out, size_t k) { if (at + k > n) { ok = false; return false; } std::memcpy(out, p + at, k); at += k; return true; }
  template <class T> T get() { T v{}; raw(&v, sizeof v); return v; }
  std::string str() { const uint32_t k = get<uint32_t>(); if (!ok || at + k > n) { ok = false; return {}; } std::string s(reinterpret_cast<const char*>(p + at), k); at += k; return s; }
  template <class T> std::vector<T> vec() {
    const uint64_t k = get<uint64_t>();
    if (!ok || k > (n - at) / sizeof(T)) { ok = false; return {}; }
    std::vector<T> v(k);
    if (k) raw(v.data(), k * sizeof(T));
    return v;
  }
};

enum Status : int32_t { kHead = 0, kArrays = 1, kData = 2, kDone = 3, kFailed = -1 };

// One TIFF tag whose values lie outside what has been read.
struct Need { uint16_t tag, type; uint32_t count; uint64_t offset; };

struct Body {
  int32_t src = 0, status = kHead;
  std::string why;
  // TIFF
  uint8_t le = 1;
  uint32_t w = 0, h = 0, spp = 1, bps = 8, comp = 1, pred = 1, planar = 1, rps = 0, tw = 0, th = 0;
  double lon0 = 0, dlon = 0, lat0 = 0, dlat = 0;
  std::vector<uint64_t> offs;
  std::vector<uint32_t> counts;
  std::vector<double> scale, tie, geoDoubles;
  std::vector<uint16_t> geoKeys;
  std::vector<Need> needs;
  // progress: the next TIFF segment (strip or tile) to read, in index order
  uint32_t next = 0;
  // output
  int32_t level = 0;
  uint32_t wo = 0, ho = 0, ch = 0;
  std::vector<uint8_t> plane;   // ch planes of wo x ho
  std::vector<uint8_t> valid;   // ch x ho row flags
  std::vector<int32_t> cur;     // per channel: the output row being accumulated
  std::vector<uint32_t> sum, cnt;  // ch x wo
  std::vector<uint8_t> texture, pack;
  uint32_t tiles = 0;
};

void writeBody(Writer& o, const Body& b) {
  o.put(b.src); o.put(b.status); o.str(b.why);
  o.put(b.le); o.put(b.w); o.put(b.h); o.put(b.spp); o.put(b.bps); o.put(b.comp); o.put(b.pred); o.put(b.planar);
  o.put(b.rps); o.put(b.tw); o.put(b.th);
  o.put(b.lon0); o.put(b.dlon); o.put(b.lat0); o.put(b.dlat);
  o.vec(b.offs); o.vec(b.counts); o.vec(b.scale); o.vec(b.tie); o.vec(b.geoDoubles); o.vec(b.geoKeys); o.vec(b.needs);
  o.put(b.next); o.put(b.level); o.put(b.wo); o.put(b.ho); o.put(b.ch);
  o.vec(b.plane); o.vec(b.valid); o.vec(b.cur); o.vec(b.sum); o.vec(b.cnt); o.vec(b.texture); o.vec(b.pack); o.put(b.tiles);
}
void readBody(Reader& r, Body& b) {
  b.src = r.get<int32_t>(); b.status = r.get<int32_t>(); b.why = r.str();
  b.le = r.get<uint8_t>(); b.w = r.get<uint32_t>(); b.h = r.get<uint32_t>(); b.spp = r.get<uint32_t>(); b.bps = r.get<uint32_t>();
  b.comp = r.get<uint32_t>(); b.pred = r.get<uint32_t>(); b.planar = r.get<uint32_t>(); b.rps = r.get<uint32_t>();
  b.tw = r.get<uint32_t>(); b.th = r.get<uint32_t>();
  b.lon0 = r.get<double>(); b.dlon = r.get<double>(); b.lat0 = r.get<double>(); b.dlat = r.get<double>();
  b.offs = r.vec<uint64_t>(); b.counts = r.vec<uint32_t>(); b.scale = r.vec<double>(); b.tie = r.vec<double>();
  b.geoDoubles = r.vec<double>(); b.geoKeys = r.vec<uint16_t>(); b.needs = r.vec<Need>();
  b.next = r.get<uint32_t>(); b.level = r.get<int32_t>(); b.wo = r.get<uint32_t>(); b.ho = r.get<uint32_t>(); b.ch = r.get<uint32_t>();
  b.plane = r.vec<uint8_t>(); b.valid = r.vec<uint8_t>(); b.cur = r.vec<int32_t>(); b.sum = r.vec<uint32_t>(); b.cnt = r.vec<uint32_t>();
  b.texture = r.vec<uint8_t>(); b.pack = r.vec<uint8_t>(); b.tiles = r.get<uint32_t>();
}

// The pending request of each response, in request order.
struct Pending { int32_t body; int32_t kind; uint32_t first, last; uint64_t start; };  // kind 0 head, 1 arrays, 2 data, 3 keep-alive
struct State {
  int32_t stage = 0;
  std::vector<Body> bodies;
  std::vector<Pending> pending;
};
constexpr char kMagic[8] = {'S', 'D', 'N', 'I', 'M', 'G', '0', '1'};
std::vector<uint8_t> serialize(const State& s) {
  Writer o;
  o.raw(kMagic, 8);
  o.put(s.stage);
  o.put<uint32_t>(uint32_t(s.bodies.size()));
  for (const auto& b : s.bodies) writeBody(o, b);
  o.vec(s.pending);
  return std::move(o.b);
}
bool deserialize(const uint8_t* p, size_t n, State& s) {
  NEED(n >= 8 && std::memcmp(p, kMagic, 8) == 0, "The stage state is not a body-imagery state.");
  Reader r{p, n, 8};
  s.stage = r.get<int32_t>();
  const uint32_t count = r.get<uint32_t>();
  NEED(r.ok && count == sources().size(), "The stage state names the wrong source list.");
  s.bodies.resize(count);
  for (auto& b : s.bodies) readBody(r, b);
  s.pending = r.vec<Pending>();
  NEED(r.ok && r.at == n, "The stage state is truncated or malformed.");
  return true;
}
bool readState(State& s) {
  const auto list = frames("state");
  NEED(list.size() == 1 && list[0]->payload, "Exactly one stage state is required.");
  return deserialize(list[0]->payload, list[0]->payload_length, s);
}

void failBody(Body& b, const std::string& why) {
  b.status = kFailed;
  b.why = why;
  std::vector<uint8_t>().swap(b.plane);
  std::vector<uint32_t>().swap(b.sum);
  std::vector<uint32_t>().swap(b.cnt);
  std::vector<uint64_t>().swap(b.offs);
  std::vector<uint32_t>().swap(b.counts);
}

// ── TIFF directory ─────────────────────────────────────────────────────────
uint16_t rd16(const uint8_t* p, bool le) { return le ? uint16_t(p[0] | p[1] << 8) : uint16_t(p[0] << 8 | p[1]); }
uint32_t rd32(const uint8_t* p, bool le) {
  return le ? uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24
            : uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | uint32_t(p[3]);
}
double rdf64(const uint8_t* p, bool le) {
  uint8_t t[8];
  for (int i = 0; i < 8; ++i) t[i] = le ? p[i] : p[7 - i];
  double v;
  std::memcpy(&v, t, 8);
  return v;
}
size_t typeSize(uint16_t type) {
  switch (type) { case 1: case 2: case 6: case 7: return 1; case 3: case 8: return 2; case 4: case 9: case 11: return 4; case 5: case 10: case 12: return 8; default: return 0; }
}
// Values of one tag from `p` (count values of `type`), as doubles.
std::vector<double> values(const uint8_t* p, uint16_t type, uint32_t count, bool le) {
  std::vector<double> v(count);
  for (uint32_t i = 0; i < count; ++i) {
    switch (type) {
      case 1: v[i] = p[i]; break;
      case 3: v[i] = rd16(p + 2 * i, le); break;
      case 4: v[i] = rd32(p + 4 * i, le); break;
      case 12: v[i] = rdf64(p + 8 * i, le); break;
      case 5: { const uint32_t a = rd32(p + 8 * i, le), d = rd32(p + 8 * i + 4, le); v[i] = d ? double(a) / d : 0; break; }
      default: v[i] = 0;
    }
  }
  return v;
}
void applyTag(Body& b, uint16_t tag, const std::vector<double>& v) {
  if (v.empty()) return;
  switch (tag) {
    case 256: b.w = uint32_t(v[0]); break;
    case 257: b.h = uint32_t(v[0]); break;
    case 258: b.bps = uint32_t(v[0]); break;
    case 259: b.comp = uint32_t(v[0]); break;
    case 277: b.spp = uint32_t(v[0]); break;
    case 278: b.rps = uint32_t(v[0]); break;
    case 284: b.planar = uint32_t(v[0]); break;
    case 317: b.pred = uint32_t(v[0]); break;
    case 322: b.tw = uint32_t(v[0]); break;
    case 323: b.th = uint32_t(v[0]); break;
    case 273: case 324: b.offs.assign(v.begin(), v.end()); break;
    case 279: case 325: b.counts.assign(v.begin(), v.end()); break;
    case 33550: b.scale = v; break;
    case 33922: b.tie = v; break;
    case 34735: b.geoKeys.assign(v.begin(), v.end()); break;
    case 34736: b.geoDoubles = v; break;
    default: break;
  }
}
bool wantedTag(uint16_t tag) {
  switch (tag) {
    case 256: case 257: case 258: case 259: case 277: case 278: case 284: case 317: case 322: case 323:
    case 273: case 324: case 279: case 325: case 33550: case 33922: case 34735: case 34736: return true;
    default: return false;
  }
}
// The header and directory from the first MiB; tags whose values lie beyond
// it become needs.
// The directory itself, when it lies beyond the first MiB, is a need with tag 0.
constexpr uint32_t kDirectoryBytes = 64u * 1024u;
bool readEntries(Body& b, const uint8_t* p, size_t n, uint64_t base, uint64_t ifd);
bool readDirectory(Body& b, const uint8_t* p, size_t n) {
  NEED(n >= 8, "The TIFF header is truncated.");
  NEED((p[0] == 'I' && p[1] == 'I') || (p[0] == 'M' && p[1] == 'M'), "Not a TIFF file.");
  b.le = p[0] == 'I';
  NEED(rd16(p + 2, b.le) == 42, "Only classic TIFF is read (not BigTIFF).");
  const uint32_t ifd = rd32(p + 4, b.le);
  if (ifd + 2 > n || ifd + 2 + size_t(rd16(p + ifd, b.le)) * 12 > n) {
    b.needs.push_back({0, 1, kDirectoryBytes, ifd});
    return true;
  }
  return readEntries(b, p, n, 0, ifd);
}
// Entries of the directory at file offset `ifd`, from bytes `p` that start at
// file offset `base`.
bool readEntries(Body& b, const uint8_t* p, size_t n, uint64_t base, uint64_t ifd) {
  const bool le = b.le;
  NEED(ifd >= base && ifd - base + 2 <= n, "The image file directory was not read.");
  const uint16_t count = rd16(p + (ifd - base), le);
  NEED(ifd - base + 2 + size_t(count) * 12 <= n, "The image file directory is larger than its range.");
  for (uint16_t i = 0; i < count; ++i) {
    const uint8_t* e = p + (ifd - base) + 2 + size_t(i) * 12;
    const uint16_t tag = rd16(e, le), type = rd16(e + 2, le);
    const uint32_t cnt = rd32(e + 4, le);
    if (!wantedTag(tag)) continue;
    const size_t size = typeSize(type) * cnt;
    NEED(typeSize(type) > 0 && cnt > 0 && cnt <= (1u << 24), "A TIFF tag has an unsupported type or count.");
    if (size <= 4) {
      applyTag(b, tag, values(e + 8, type, cnt, le));
    } else {
      const uint64_t off = rd32(e + 8, le);
      if (off >= base && off - base + size <= n) applyTag(b, tag, values(p + (off - base), type, cnt, le));
      else b.needs.push_back({tag, type, cnt, off});
    }
  }
  return true;
}

// The source grid in degrees, from the GeoTIFF keys (or the fixed global grid).
bool georeference(Body& b, const Source& s) {
  if (!s.georef) {
    b.lon0 = -180.0; b.dlon = 360.0 / b.w; b.lat0 = 90.0; b.dlat = 180.0 / b.h;
    return true;
  }
  NEED(b.scale.size() >= 2 && b.tie.size() >= 6, "The GeoTIFF has no pixel scale or tie point.");
  int model = 0;
  double semiMajor = 0, stdParallel = 0, centralMeridian = 0;
  if (b.geoKeys.size() >= 4) {
    const size_t keys = b.geoKeys[3];
    for (size_t k = 0; k < keys && 4 + 4 * k + 3 < b.geoKeys.size(); ++k) {
      const uint16_t id = b.geoKeys[4 + 4 * k], loc = b.geoKeys[5 + 4 * k], value = b.geoKeys[7 + 4 * k];
      const double d = (loc == 34736 && value < b.geoDoubles.size()) ? b.geoDoubles[value] : double(value);
      if (id == 1024) model = int(value);
      if (id == 2057) semiMajor = d;
      if (id == 3078) stdParallel = d;                                   // ProjStdParallel1
      if (id == 3080 || id == 3088 || id == 3084) centralMeridian = d;   // ProjNatOriginLong / ProjCenterLong / ProjFalseOriginLong
    }
  }
  const double sx = b.scale[0], sy = b.scale[1];
  const double x0 = b.tie[3] - b.tie[0] * sx, y0 = b.tie[4] + b.tie[1] * sy;
  if (model == 2) {  // geographic: degrees
    b.lon0 = x0; b.dlon = sx; b.lat0 = y0; b.dlat = sy;
  } else {
    const double r = semiMajor > 0 ? semiMajor : s.a * 1000.0;
    const double deg = 180.0 / kPi;
    const double kx = std::cos(stdParallel / deg);
    // Many mosaics centre on 180 E (Titan, Ganymede, Ceres...): x is from the central meridian.
    b.lon0 = centralMeridian + x0 / (r * kx) * deg; b.dlon = sx / (r * kx) * deg; b.lat0 = y0 / r * deg; b.dlat = sy / r * deg;
  }
  return true;
}

// Ready once every array is read: checks the layout and sizes the output.
bool prepare(Body& b, const Source& s) {
  NEED(b.w > 0 && b.h > 0 && b.bps == 8, "Only 8-bit images are read.");
  NEED(b.spp == 1 || b.spp == 3 || b.spp == 4, "Only grey, RGB or RGBA images are read.");
  NEED(b.comp == 1 || b.comp == 5, "Only uncompressed or LZW TIFF is read.");
  NEED(b.pred == 1 || b.pred == 2, "Only horizontal differencing is supported as a predictor.");
  NEED(b.planar == 1 || b.planar == 2, "Unknown planar configuration.");
  const bool tiled = b.tw > 0;
  if (!tiled && b.rps == 0) b.rps = b.h;
  const uint32_t across = tiled ? (b.w + b.tw - 1) / b.tw : 1;
  const uint32_t down = tiled ? (b.h + b.th - 1) / b.th : (b.h + b.rps - 1) / b.rps;
  const uint32_t bands = b.planar == 2 ? b.spp : 1;
  NEED(b.offs.size() == size_t(across) * down * bands && b.counts.size() == b.offs.size(), "The strip or tile table does not match the image size.");
  if (!georeference(b, s)) return false;
  NEED(std::fabs(b.w * b.dlon - 360.0) < 1.0 && std::fabs(b.h * b.dlat - 180.0) < 1.0, "The source is not a global equirectangular mosaic.");
  int level = 0;
  while (level < maxLevel && (512u << (level + 1)) <= b.w) ++level;
  NEED(level >= textureLevel, "The source is too small for the whole-body texture.");
  b.level = level;
  b.wo = 512u << level;
  b.ho = b.wo / 2;
  b.ch = b.spp == 1 ? 1 : 3;
  b.status = kData;
  return true;
}

// The output grid, made when the body's first data arrive: bodies wait their
// turn without one, so the state holds only the few bodies in progress.
void ensureOutput(Body& b) {
  if (!b.plane.empty()) return;
  b.plane.assign(size_t(b.ch) * b.wo * b.ho, 0);
  b.valid.assign(size_t(b.ch) * b.ho, 0);
  b.cur.assign(b.ch, -1);
  b.sum.assign(size_t(b.ch) * b.wo, 0);
  b.cnt.assign(size_t(b.ch) * b.wo, 0);
}

// ── decoding ───────────────────────────────────────────────────────────────
// TIFF LZW (MSB-first codes, 9 to 12 bits, early change).
bool lzwDecode(const uint8_t* in, size_t n, uint8_t* out, size_t want) {
  std::vector<uint32_t> prefix(4096);
  std::vector<uint8_t> suffix(4096), first(4096);
  std::vector<uint16_t> length(4096);
  for (int i = 0; i < 256; ++i) { prefix[i] = 0xffffffff; suffix[i] = uint8_t(i); first[i] = uint8_t(i); length[i] = 1; }
  size_t bit = 0, written = 0;
  int width = 9, next = 258;
  int old = -1;
  std::vector<uint8_t> stack(4096);
  const auto emit = [&](int code) -> bool {
    const int len = length[code];
    if (written + len > want) return false;
    int c = code;
    for (int i = len - 1; i >= 0; --i) { out[written + i] = suffix[c]; c = int(prefix[c]); }
    written += len;
    return true;
  };
  while (written < want) {
    if ((bit + width + 7) / 8 > n) break;
    uint32_t v = 0;
    for (int i = 0; i < width; ++i) { const size_t b = bit + i; v = (v << 1) | ((in[b >> 3] >> (7 - (b & 7))) & 1); }
    bit += width;
    const int code = int(v);
    if (code == 257) break;
    if (code == 256) { width = 9; next = 258; old = -1; continue; }
    if (old < 0) {
      if (code > 255 || !emit(code)) return false;
      old = code;
      continue;
    }
    int k;
    if (code < next) {
      if (!emit(code)) return false;
      k = first[code];
    } else if (code == next) {
      k = first[old];
      if (next >= 4096) return false;
      prefix[next] = uint32_t(old); suffix[next] = uint8_t(k); first[next] = first[old]; length[next] = uint16_t(length[old] + 1);
      if (!emit(next)) return false;
      ++next;
      old = code;
      if (next + 1 >= (1 << width) && width < 12) ++width;
      continue;
    } else {
      return false;
    }
    if (next < 4096) {
      prefix[next] = uint32_t(old); suffix[next] = uint8_t(k); first[next] = first[old]; length[next] = uint16_t(length[old] + 1);
      ++next;
    }
    old = code;
    if (next + 1 >= (1 << width) && width < 12) ++width;
  }
  return written == want;
}

// One segment's pixels: rows x cols x samples (samples = spp chunky, 1 planar).
bool decodeSegment(const Body& b, const uint8_t* data, size_t n, uint32_t rows, uint32_t cols, uint32_t samples, std::vector<uint8_t>& out) {
  const size_t want = size_t(rows) * cols * samples;
  out.resize(want);
  if (b.comp == 1) {
    NEED(n >= want, "An uncompressed segment is shorter than its rows.");
    std::memcpy(out.data(), data, want);
  } else {
    NEED(lzwDecode(data, n, out.data(), want), "An LZW segment did not decode to its rows.");
  }
  if (b.pred == 2) {
    for (uint32_t y = 0; y < rows; ++y) {
      uint8_t* row = out.data() + size_t(y) * cols * samples;
      for (size_t i = samples; i < size_t(cols) * samples; ++i) row[i] = uint8_t(row[i] + row[i - samples]);
    }
  }
  return true;
}

// ── area averaging into the planetodetic output grid ──────────────────────
int32_t outputRow(const Body& b, const Source& s, uint32_t y) {
  const double deg = 180.0 / kPi;
  const double centric = (b.lat0 - (y + 0.5) * b.dlat) / deg;
  // tan(detic) = (a/c)^2 tan(centric) on the body's PCK ellipsoid.
  const double k = (s.a / s.c) * (s.a / s.c);
  const double detic = std::atan2(k * std::sin(centric), std::cos(centric)) * deg;
  int32_t r = int32_t(std::floor((90.0 - detic) / 180.0 * b.ho));
  return r < 0 ? 0 : (r >= int32_t(b.ho) ? int32_t(b.ho) - 1 : r);
}
void columns(const Body& b, std::vector<uint32_t>& col) {
  col.resize(b.w);
  for (uint32_t x = 0; x < b.w; ++x) {
    double lon = std::fmod(b.lon0 + (x + 0.5) * b.dlon + 180.0, 360.0);
    if (lon < 0) lon += 360.0;
    uint32_t c = uint32_t(lon / 360.0 * b.wo);
    col[x] = c >= b.wo ? b.wo - 1 : c;
  }
}
void finalizeRow(Body& b, uint32_t band) {
  const int32_t r = b.cur[band];
  if (r < 0) return;
  uint32_t* sum = b.sum.data() + size_t(band) * b.wo;
  uint32_t* cnt = b.cnt.data() + size_t(band) * b.wo;
  uint8_t* row = b.plane.data() + (size_t(band) * b.ho + r) * b.wo;
  int last = -1;
  for (uint32_t i = 0; i < b.wo; ++i) {
    if (cnt[i]) { row[i] = uint8_t((sum[i] + cnt[i] / 2) / cnt[i]); last = row[i]; }
    else row[i] = uint8_t(last < 0 ? 0 : last);
    sum[i] = 0; cnt[i] = 0;
  }
  b.valid[size_t(band) * b.ho + r] = 1;
}
// One source row of one output channel; `stride` samples between pixels.
void feedRow(Body& b, const Source& s, uint32_t band, uint32_t y, const uint8_t* px, uint32_t stride, const std::vector<uint32_t>& col) {
  const int32_t r = outputRow(b, s, y);
  if (r != b.cur[band]) { finalizeRow(b, band); b.cur[band] = r; }
  uint32_t* sum = b.sum.data() + size_t(band) * b.wo;
  uint32_t* cnt = b.cnt.data() + size_t(band) * b.wo;
  for (uint32_t x = 0; x < b.w; ++x) { sum[col[x]] += px[size_t(x) * stride]; ++cnt[col[x]]; }
}
// Rows y0.. of decoded pixels (rows x w x samples) for band `band`
// (planar) or every channel (chunky).
void feedRows(Body& b, const Source& s, const uint8_t* px, uint32_t y0, uint32_t rows, uint32_t samples, int planarBand, const std::vector<uint32_t>& col) {
  for (uint32_t k = 0; k < rows && y0 + k < b.h; ++k) {
    const uint8_t* row = px + size_t(k) * b.w * samples;
    if (planarBand >= 0) {
      if (uint32_t(planarBand) < b.ch) feedRow(b, s, uint32_t(planarBand), y0 + k, row, 1, col);
    } else if (b.ch == 1) {
      feedRow(b, s, 0, y0 + k, row, samples, col);
    } else {
      for (uint32_t c = 0; c < 3; ++c) feedRow(b, s, c, y0 + k, row + c, samples, col);
    }
  }
}

// The last rows of a band (planar) or of the image (chunky) end the rows
// being accumulated.
void endRows(Body& b, uint32_t band) {
  if (b.planar == 2) { finalizeRow(b, band); b.cur[band] = -1; return; }
  for (uint32_t c = 0; c < b.ch; ++c) { finalizeRow(b, c); b.cur[c] = -1; }
}

// Segment geometry. Strips: index = band * stripsPerBand + strip. Tiles:
// index = band * tilesPerBand + row * across + col.
uint32_t segmentsPerBand(const Body& b) { return uint32_t(b.offs.size() / (b.planar == 2 ? b.spp : 1)); }

// Decodes segments [first, last] whose bytes lie in `data` from file offset
// `start`. Tiled images are fed one tile row at a time (a chunk always holds
// whole tile rows).
bool decodeChunk(Body& b, const Source& s, uint32_t first, uint32_t last, const uint8_t* data, size_t n, uint64_t start) {
  ensureOutput(b);
  std::vector<uint32_t> col;
  columns(b, col);
  std::vector<uint8_t> px;
  const uint32_t perBand = segmentsPerBand(b);
  const uint32_t samples = b.planar == 2 ? 1 : b.spp;
  const auto bytesOf = [&](uint32_t i, const uint8_t*& p, size_t& len) -> bool {
    NEED(b.offs[i] >= start && b.offs[i] + b.counts[i] <= start + n, "A segment lies outside its range.");
    p = data + (b.offs[i] - start);
    len = b.counts[i];
    return true;
  };
  if (b.tw == 0) {
    for (uint32_t i = first; i <= last; ++i) {
      const uint32_t band = b.planar == 2 ? i / perBand : 0, strip = i % perBand;
      const uint32_t y0 = strip * b.rps, rows = std::min(b.rps, b.h - y0);
      const uint8_t* p; size_t len;
      if (!bytesOf(i, p, len) || !decodeSegment(b, p, len, rows, b.w, samples, px)) return false;
      feedRows(b, s, px.data(), y0, rows, samples, b.planar == 2 ? int(band) : -1, col);
      if (strip == perBand - 1) endRows(b, band);
    }
  } else {
    const uint32_t across = (b.w + b.tw - 1) / b.tw;
    std::vector<uint8_t> strip;
    for (uint32_t i = first; i <= last; i += across) {
      const uint32_t band = b.planar == 2 ? i / perBand : 0, row = (i % perBand) / across;
      NEED(i % across == 0 && i + across - 1 <= last, "A chunk splits a tile row.");
      const uint32_t y0 = row * b.th, rows = std::min(b.th, b.h - y0);
      strip.assign(size_t(rows) * b.w * samples, 0);
      for (uint32_t t = 0; t < across; ++t) {
        const uint8_t* p; size_t len;
        if (!bytesOf(i + t, p, len) || !decodeSegment(b, p, len, b.th, b.tw, samples, px)) return false;
        const uint32_t x0 = t * b.tw, cols = std::min(b.tw, b.w - x0);
        for (uint32_t y = 0; y < rows; ++y) std::memcpy(strip.data() + (size_t(y) * b.w + x0) * samples, px.data() + size_t(y) * b.tw * samples, size_t(cols) * samples);
      }
      feedRows(b, s, strip.data(), y0, rows, samples, b.planar == 2 ? int(band) : -1, col);
      if (row == perBand / across - 1) endRows(b, band);
    }
  }
  return true;
}

// ── output: levels, tiles, texture ─────────────────────────────────────────
// Rows no source row reached take the nearest row that was reached.
void fillRows(Body& b) {
  for (uint32_t c = 0; c < b.ch; ++c) {
    uint8_t* plane = b.plane.data() + size_t(c) * b.wo * b.ho;
    const uint8_t* valid = b.valid.data() + size_t(c) * b.ho;
    for (uint32_t r = 0; r < b.ho; ++r) {
      if (valid[r]) continue;
      int up = int(r) - 1, down = int(r) + 1;
      while (up >= 0 && !valid[up]) --up;
      while (down < int(b.ho) && !valid[down]) ++down;
      const int from = up < 0 ? down : (down >= int(b.ho) ? up : (int(r) - up <= down - int(r) ? up : down));
      if (from >= 0 && from < int(b.ho)) std::memcpy(plane + size_t(r) * b.wo, plane + size_t(from) * b.wo, b.wo);
    }
  }
}
// 2 x 2 box filter of every channel plane.
std::vector<uint8_t> halve(const std::vector<uint8_t>& planes, uint32_t w, uint32_t h, uint32_t ch) {
  const uint32_t w2 = w / 2, h2 = h / 2;
  std::vector<uint8_t> out(size_t(ch) * w2 * h2);
  for (uint32_t c = 0; c < ch; ++c) {
    const uint8_t* p = planes.data() + size_t(c) * w * h;
    uint8_t* q = out.data() + size_t(c) * w2 * h2;
    for (uint32_t y = 0; y < h2; ++y)
      for (uint32_t x = 0; x < w2; ++x) {
        const size_t i = size_t(2 * y) * w + 2 * x;
        q[size_t(y) * w2 + x] = uint8_t((p[i] + p[i + 1] + p[i + w] + p[i + w + 1] + 2) / 4);
      }
  }
  return out;
}
std::vector<uint8_t> interleave(const std::vector<uint8_t>& planes, uint32_t w, uint32_t h, uint32_t ch, uint32_t x0, uint32_t y0, uint32_t tw, uint32_t th) {
  std::vector<uint8_t> out(size_t(tw) * th * ch);
  for (uint32_t y = 0; y < th; ++y)
    for (uint32_t x = 0; x < tw; ++x)
      for (uint32_t c = 0; c < ch; ++c) out[(size_t(y) * tw + x) * ch + c] = planes[size_t(c) * w * h + size_t(y0 + y) * w + x0 + x];
  return out;
}
void put16(std::vector<uint8_t>& v, uint16_t x) { v.push_back(uint8_t(x)); v.push_back(uint8_t(x >> 8)); }
void put32(std::vector<uint8_t>& v, uint32_t x) { for (int i = 0; i < 4; ++i) v.push_back(uint8_t(x >> (8 * i))); }

void finishBody(Body& b) {
  fillRows(b);
  jpeg::Encoder encoder(jpegQuality);
  struct Tile { uint8_t level; uint16_t x, y; std::vector<uint8_t> jpg; };
  std::vector<Tile> tiles;
  std::vector<uint8_t> planes = std::move(b.plane);
  uint32_t w = b.wo, h = b.ho;
  for (int level = b.level; level >= 0; --level) {
    if (level == textureLevel) b.texture = encoder.encode(interleave(planes, w, h, b.ch, 0, 0, w, h).data(), int(w), int(h), int(b.ch));
    for (uint32_t ty = 0; ty < h / tileSize; ++ty)
      for (uint32_t tx = 0; tx < w / tileSize; ++tx)
        tiles.push_back({uint8_t(level), uint16_t(tx), uint16_t(ty),
                         encoder.encode(interleave(planes, w, h, b.ch, tx * tileSize, ty * tileSize, tileSize, tileSize).data(), tileSize, tileSize, int(b.ch))});
    if (level > 0) { planes = halve(planes, w, h, b.ch); w /= 2; h /= 2; }
  }
  std::vector<uint8_t>& pack = b.pack;
  pack.clear();
  const char magic[8] = {'S', 'D', 'N', 'T', 'I', 'L', 'E', '1'};
  pack.insert(pack.end(), magic, magic + 8);
  put32(pack, 1);
  put32(pack, uint32_t(tiles.size()));
  pack.push_back(uint8_t(b.level));
  pack.push_back(uint8_t(b.ch));
  put16(pack, 0);
  uint32_t offset = uint32_t(pack.size() + tiles.size() * 16);
  for (const auto& t : tiles) {
    pack.push_back(t.level); pack.push_back(0); put16(pack, t.x); put16(pack, t.y); put16(pack, 0);
    put32(pack, offset); put32(pack, uint32_t(t.jpg.size()));
    offset += uint32_t(t.jpg.size());
  }
  for (const auto& t : tiles) pack.insert(pack.end(), t.jpg.begin(), t.jpg.end());
  b.tiles = uint32_t(tiles.size());
  b.status = kDone;
  std::vector<uint8_t>().swap(b.plane);
  std::vector<uint8_t>().swap(b.valid);
  std::vector<uint32_t>().swap(b.sum);
  std::vector<uint32_t>().swap(b.cnt);
  std::vector<uint64_t>().swap(b.offs);
  std::vector<uint32_t>().swap(b.counts);
}

// ── stage logic ────────────────────────────────────────────────────────────
// Applies the responses to the pending requests.
bool apply(State& st) {
  std::vector<Response> rs;
  if (!responses(st.pending.size(), rs)) return false;
  const auto& src = sources();
  for (size_t k = 0; k < st.pending.size(); ++k) {
    const Pending& p = st.pending[k];
    if (p.kind == 3) continue;  // keep-alive
    Body& b = st.bodies[p.body];
    if (b.status == kFailed) continue;
    const Response& r = rs[k];
    if (r.status != 206 && r.status != 200) { failBody(b, "The source answered HTTP " + std::to_string(r.status) + "."); continue; }
    const uint8_t* data = r.body;
    size_t n = r.length;
    uint64_t start = p.start;
    if (r.status == 200) {  // a server that ignored the range sent the file from its start
      if (start >= n) { failBody(b, "The source ignored a byte range."); continue; }
      data += start; n -= size_t(start);
    }
    error = "";
    bool ok = true;
    if (p.kind == 0) {
      ok = readDirectory(b, data, n);
      if (ok) b.status = b.needs.empty() ? kData : kArrays;
      if (ok && b.needs.empty()) ok = prepare(b, src[b.src]);
    } else if (p.kind == 1) {
      std::vector<Need> rest, directory;
      for (const auto& need : b.needs) if (need.tag == 0) directory.push_back(need);
      for (const auto& need : directory) {
        if (!(ok = readEntries(b, data, n, start, need.offset))) break;
      }
      for (const auto& need : b.needs) {
        if (need.tag == 0) continue;
        const size_t size = typeSize(need.type) * need.count;
        if (need.offset >= start && need.offset + size <= start + n) applyTag(b, need.tag, values(data + (need.offset - start), need.type, need.count, b.le));
        else rest.push_back(need);
      }
      if (ok) {
        b.needs.erase(std::remove_if(b.needs.begin(), b.needs.end(), [](const Need& x) { return x.tag == 0; }), b.needs.end());
        // Arrays named by a directory just read are new needs.
        std::vector<Need> all = rest;
        for (const auto& need : b.needs) {
          bool known = false;
          for (const auto& r : rest) known = known || (r.tag == need.tag && r.offset == need.offset);
          if (!known && !(need.offset >= start && need.offset + typeSize(need.type) * need.count <= start + n)) all.push_back(need);
        }
        b.needs = all;
        if (b.needs.empty()) ok = prepare(b, src[b.src]);
      }
    } else {
      ok = decodeChunk(b, src[b.src], p.first, p.last, data, n, start);
      if (ok && p.last + 1 >= b.offs.size()) finishBody(b);
      else if (ok) b.next = p.last + 1;
    }
    if (!ok) failBody(b, error && *error ? error : "The source could not be read.");
  }
  return true;
}

// The next requests: every body's directory first (small), then data, in
// body order, at most three 48 MiB ranges per stage.
std::vector<Json> plan(State& st) {
  std::vector<Json> requests;
  st.pending.clear();
  const auto& src = sources();
  size_t chunks = 0;
  for (int32_t i = 0; i < int32_t(st.bodies.size()) && requests.size() < maxFrames; ++i) {
    Body& b = st.bodies[i];
    if (b.status == kArrays) {
      // One range over the arrays still needed (they sit together in these files).
      uint64_t lo = UINT64_MAX, hi = 0;
      for (const auto& need : b.needs) { lo = std::min(lo, need.offset); hi = std::max<uint64_t>(hi, need.offset + typeSize(need.type) * need.count); }
      if (hi - lo > chunkBytes) { failBody(b, "The TIFF arrays are spread over more than one range."); continue; }
      requests.push_back(rangeRequest(src[b.src].url, lo, hi - 1));
      st.pending.push_back({i, 1, 0, 0, lo});
    }
  }
  for (int32_t i = 0; i < int32_t(st.bodies.size()) && chunks < chunksPerStage && requests.size() < maxFrames; ++i) {
    Body& b = st.bodies[i];
    while (b.status == kData && chunks < chunksPerStage && b.next < b.offs.size()) {
      // Whole segments (whole tile rows for tiles) from `next`, at most 48 MiB of file.
      const uint32_t step = b.tw > 0 ? (b.w + b.tw - 1) / b.tw : 1;
      uint32_t last = b.next + step - 1;
      if (last >= b.offs.size()) { failBody(b, "The tile table ends inside a tile row."); break; }
      auto span = [&](uint32_t a, uint32_t z, uint64_t& lo, uint64_t& hi) {
        lo = UINT64_MAX; hi = 0;
        for (uint32_t k = a; k <= z; ++k) { lo = std::min(lo, b.offs[k]); hi = std::max<uint64_t>(hi, b.offs[k] + b.counts[k]); }
      };
      uint64_t lo, hi;
      span(b.next, last, lo, hi);
      if (hi - lo > chunkBytes) { failBody(b, "One strip or tile row is larger than a range."); break; }
      while (last + step < b.offs.size()) {
        uint64_t lo2, hi2;
        span(b.next, last + step, lo2, hi2);
        if (hi2 - lo2 > chunkBytes) break;
        last += step; lo = lo2; hi = hi2;
      }
      requests.push_back(rangeRequest(src[b.src].url, lo, hi - 1));
      st.pending.push_back({i, 2, b.next, last, lo});
      b.next = last + 1;  // planned; apply() confirms
      ++chunks;
    }
  }
  if (requests.empty()) {
    // The flow has a fixed number of stages; a run that finished early keeps
    // the chain going with one one-byte range.
    requests.push_back(rangeRequest(src[0].url, 0, 0));
    st.pending.push_back({0, 3, 0, 0, 0});
  }
  return requests;
}

bool emitStage(State& st) {
  const auto requests = plan(st);
  for (const auto& r : requests) NEED(output("request", r) >= 0, "Could not emit a request.");
  ++st.stage;
  NEED(outputBytes("state", serialize(st)) >= 0, "Could not emit the stage state.");
  return true;
}
}  // namespace

// config -> the first MiB of every source + state.
extern "C" int plan_imagery() {
  const Json config = json("config");
  CHECK(config.is_object() && config.value("access", std::string()) == "anonymous", "Body imagery is anonymous public data; set access to anonymous.");
  // Optional: only these bodies (NAIF ids) this run, e.g. to refresh one.
  std::vector<int32_t> only;
  if (config.contains("bodies")) {
    CHECK(config["bodies"].is_array(), "bodies must be a list of NAIF ids.");
    for (const auto& id : config["bodies"]) { CHECK(id.is_number_integer(), "bodies must be a list of NAIF ids."); only.push_back(id.get<int32_t>()); }
  }
  State st;
  const auto& src = sources();
  st.bodies.resize(src.size());
  std::vector<Json> requests;
  for (int32_t i = 0; i < int32_t(src.size()); ++i) {
    st.bodies[i].src = i;
    if (!only.empty() && std::find(only.begin(), only.end(), src[i].naif) == only.end()) {
      st.bodies[i].status = kFailed;
      st.bodies[i].why = "not in this run's body list";
      continue;
    }
    requests.push_back(rangeRequest(src[i].url, 0, headBytes - 1));
    st.pending.push_back({i, 0, 0, 0, 0});
  }
  CHECK(!requests.empty() && requests.size() <= maxFrames, "No body to retrieve.");
  for (const auto& r : requests) CHECK(output("request", r) >= 0, "Could not emit a request.");
  st.stage = 1;
  return outputBytes("state", serialize(st)) < 0 ? 1 : 0;
}

// state + responses -> next requests + state.
extern "C" int advance_imagery() {
  State st;
  CHECK(readState(st), error);
  CHECK(apply(st), error);
  CHECK(emitStage(st), error);
  return 0;
}

// state + the last responses -> one file frame per output file + job.
extern "C" int build_imagery() {
  State st;
  CHECK(readState(st), error);
  CHECK(apply(st), error);
  const auto& src = sources();
  Json index = {{"format", "SDNTILE1 tile packs: JPEG tiles of 256 px in the geographic tiling scheme (2 x 1 at level 0, x from 180 W, y from the north), planetodetic latitude on the body's PCK ellipsoid; texture.jpg 2048 x 1024, same projection"},
                {"bodies", Json::object()}};
  Json job = {{"files", Json::array()}, {"failed", Json::object()}};
  std::vector<std::pair<std::string, const std::vector<uint8_t>*>> files;
  for (auto& b : st.bodies) {
    const Source& s = src[b.src];
    if (b.status != kDone) {
      job["failed"][std::to_string(s.naif)] = b.status == kFailed ? b.why : "did not finish within the flow's stages";
      continue;
    }
    const std::string dir = "imagery/" + std::to_string(s.naif) + "/";
    files.push_back({dir + "tiles.pack", &b.pack});
    files.push_back({dir + "texture.jpg", &b.texture});
    index["bodies"][std::to_string(s.naif)] = {{"name", s.name}, {"credit", s.credit}, {"licence", s.licence}, {"source", s.url},
                                               {"maximumLevel", b.level}, {"tiles", b.tiles}, {"channels", b.ch}};
  }
  CHECK(!files.empty(), "No body's imagery could be built; nothing is published.");
  const std::string indexText = index.dump(1);
  const std::vector<uint8_t> indexBytes(indexText.begin(), indexText.end());
  files.push_back({"imagery/index.json", &indexBytes});
  for (const auto& f : files) {
    std::vector<uint8_t> frame(4 + f.first.size() + f.second->size());
    const uint32_t n = uint32_t(f.first.size());
    std::memcpy(frame.data(), &n, 4);
    std::memcpy(frame.data() + 4, f.first.data(), n);
    if (!f.second->empty()) std::memcpy(frame.data() + 4 + n, f.second->data(), f.second->size());
    CHECK(outputBytes("file", frame) >= 0, "Could not emit a file.");
    job["files"].push_back({{"file", f.first}, {"bytes", f.second->size()}, {"sha256", ephem::sha256_hex(f.second->data(), f.second->size())}});
  }
  return output("job", job) < 0 ? 1 : 0;
}

// job + receipt + one "added" frame per file ({name, cid, bytes}) -> one $PNM
// per file, meta and report.
extern "C" int announce_imagery() {
  const Json job = json("job"), receipt = json("receipt");
  CHECK(job.is_object() && job.contains("files") && job["files"].is_array(), "The build job is required.");
  CHECK(receipt.is_object() && receipt.contains("retrieved_at_ms") && receipt["retrieved_at_ms"].is_number_integer(), "Invalid retrieval epoch.");
  const auto peer = receipt.value("producer_peer_id", std::string());
  CHECK(!peer.empty() && peer.size() <= 128, "An authenticated producer peer ID is required.");
  std::map<std::string, Json> added;
  for (const auto* f : frames("added")) {
    const Json a = Json::parse(f->payload, f->payload + f->payload_length, nullptr, false);
    CHECK(a.is_object() && a.contains("name") && a.contains("cid") && a["cid"].is_string(), "An IPFS add result is malformed.");
    added[a["name"].get<std::string>()] = a;
  }
  CHECK(added.size() == job["files"].size(), "Every imagery file must be added to IPFS before it is announced.");
  const int64_t ms = receipt["retrieved_at_ms"].get<int64_t>();
  const int64_t sec = ms / 1000, day = sec / 86400, rem = sec % 86400;
  int64_t z = day + 719468; const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = unsigned(z - era * 146097), yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
  const unsigned dd = doy - (153 * mp + 2) / 5 + 1, mm = mp < 10 ? mp + 3 : mp - 9;
  const int64_t yy = int64_t(yoe) + era * 400 + (mm <= 2);
  char when[32];
  std::snprintf(when, sizeof when, "%04lld-%02u-%02uT%02lld:%02lld:%02lldZ", (long long)yy, mm, dd, (long long)(rem / 3600), (long long)(rem % 3600 / 60), (long long)(rem % 60));
  std::vector<uint8_t> stream;
  std::string digest;
  for (const auto& file : job["files"]) {
    const std::string name = file["file"], sha = file["sha256"];
    const auto& a = added[name];
    CHECK(a.value("bytes", int64_t(-1)) == file["bytes"].get<int64_t>(), "An added file's length differs from the built file.");
    const std::string cid = a["cid"];
    flatbuffers::FlatBufferBuilder b(256);
    const auto addr = b.CreateString("/ipfs/" + cid);
    const auto ts = b.CreateString(when);
    const auto cidOffset = b.CreateString(cid);
    const auto fileName = b.CreateString(name);
    const auto fileId = b.CreateString(std::string(providerId) + ":" + sourceName + ":" + name + ":" + sha);
    PNMBuilder pnm(b);
    pnm.add_MULTIFORMAT_ADDRESS(addr);
    pnm.add_PUBLISH_TIMESTAMP(ts);
    pnm.add_CID(cidOffset);
    pnm.add_FILE_NAME(fileName);
    pnm.add_FILE_ID(fileId);
    FinishSizePrefixedPNMBuffer(b, pnm.Finish());
    stream.insert(stream.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
    digest += name + ":" + sha + "\n";
  }
  const std::string batch = ephem::sha256_hex(reinterpret_cast<const uint8_t*>(digest.data()), digest.size());
  const Json meta = {{"schema", "PNM.fbs"}, {"batch_id", batch}, {"provider_id", providerId}, {"source_name", sourceName},
                     {"source_url", "https://astrogeology.usgs.gov/search"}, {"source_peer", peer},
                     {"reconcile", "current"}, {"origin_id", "astrogeology.usgs.gov"}, {"origin_name", "USGS Astrogeology / NASA"},
                     {"dataset_id", "usgs-astrogeology/body-imagery"}, {"terms_url", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits"},
                     {"citation", credit}, {"licence", licence}};
  const Json report = {{"files", job["files"].size()}, {"batch_id", batch}, {"failed", job.value("failed", Json::object())}, {"retrieved_at", when}};
  if (output("meta", meta) < 0 || output("report", report) < 0) return 1;
  return plugin_push_output_ex("records", "PNM.fbs", "$PNM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PNM", 0, 0,
                               stream.data(), stream.size()) < 0 ? 1 : 0;
}
