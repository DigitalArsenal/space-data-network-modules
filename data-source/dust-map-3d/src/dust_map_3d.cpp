#include "space_data_module_invoke.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <vector>
#include "healpix_fits.hpp"
#include "pce_rows.hpp"

// The local 3D interstellar dust of Edenhofer et al. (2024), A&A 685, A82,
// doi:10.1051/0004-6361/202347628: the posterior mean of the published
// HEALPix-times-distance map (Zenodo record 10658339, v1.0.2,
// mean_and_std_healpix.fits; NSIDE 256 NESTED, 516 logarithmic shells from
// 69 to 1248 pc), resampled to a heliocentric Galactic Cartesian grid of 20 pc
// voxels and delivered as SDS $PCE rows, one per z plane, for the Milky Way
// model (analysis/milky-way-model load_dust_map).
//
// The 3.25 GB file is never downloaded whole. Every stage asks for ranges the
// previous one proved are needed:
//   plan_dust     the primary and MEAN headers;
//   advance (1)   the STD header, which locates the tables after it;
//   advance (2)   the radial tables and the integrated inner 68.8 pc sphere;
//   advance (3-12) the MEAN shells, 48 per stage in three 48 MiB ranges;
//   build_dust    the last 36 shells, then the rows, the ingest meta and the
//                 report. 1.63 GB of ranges in all; STD data is never read.
// Each voxel is the volume-weighted mean of every HEALPix sample whose centre
// falls in it (r^2 dr dOmega), so the integrated extinction is conserved; the
// inner sphere is the published inner integral spread uniformly in radius.
// Voxels whose centre lies beyond the last shell boundary carry NaN: no data.
// Units are the map's own, E of Zhang, Green & Rix (2023) per pc;
// A_V(540 nm) = 2.8 E (Edenhofer et al. 2024, section 5).
//
// Licence: CC BY 4.0 (the Zenodo record); the credit rides in every row and
// in the ingest meta, and so in every publication. The state between stages
// is a binary frame: "SDNDUST1", a u32 JSON length, the JSON, then the
// float32 accumulators.

using Json = nlohmann::json;
namespace {
constexpr const char* sourceUrl = "https://zenodo.org/records/10658339/files/mean_and_std_healpix.fits?download=1";
constexpr const char* providerId = "edenhofer2024";
constexpr const char* sourceName = "local-dust-1250pc";
constexpr const char* datasetId = "edenhofer2024-mean-20pc";
constexpr const char* credit =
    "3D dust: Edenhofer, Zucker, Frank, Saydjari, Speagle, Finkbeiner & Ensslin (2024), A&A 685, A82, "
    "doi:10.1051/0004-6361/202347628; data doi:10.5281/zenodo.10658339 (v1.0.2), posterior mean resampled to 20 pc";
constexpr const char* license = "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), Zenodo record 10658339";
constexpr const char* frameText = "heliocentric Galactic Cartesian, kpc: +X toward l=0 b=0, +Y toward l=90, +Z toward the NGP";

constexpr uint32_t kNside = 256, kPixels = 12u * kNside * kNside, kShells = 516;
constexpr size_t kShellBytes = size_t(kPixels) * 4;
constexpr uint32_t kShellsPerRange = 16, kRangesPerStage = 3, kShellsPerStage = kShellsPerRange * kRangesPerStage;
constexpr uint32_t kFirstChunkStage = 4, kBuildStage = 14;  // 516 = 10 x 48 + 36
constexpr size_t kHeaderBytes = 8 * 2880, kTailBytes = 8u * 1024u * 1024u;
constexpr size_t maxRangeBytes = 48u * 1024u * 1024u, maxControlBytes = 32u * 1024u * 1024u;
// The output grid: 125 x 125 x 61 voxels of 20 pc about the Sun.
constexpr uint32_t kNx = 125, kNy = 125, kNz = 61;
constexpr double kSpacingPc = 20, kMinXPc = -1250, kMinYPc = -1250, kMinZPc = -610;
constexpr size_t kVoxels = size_t(kNx) * kNy * kNz;
constexpr uint32_t kProbes = 48;
constexpr double kAvPerUnit = 2.8;

const char* error = "Invalid 3D dust map input.";
int fail(const char* message) { plugin_set_error("invalid-dust-map-3d-input", message); return 1; }
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)

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
uint32_t le32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }

// The response for request k is responses[k]: $HRB + int32 status + body.
struct Response { int status; const uint8_t* body; size_t length; };
bool responses(size_t expected, std::vector<Response>& out) {
  const auto list = frames("response");
  NEED(list.size() == expected, "One HTTP response per planned request is required.");
  out.clear();
  for (const auto* f : list) {
    NEED(f->payload && f->payload_length >= 8 && std::memcmp(f->payload, "$HRB", 4) == 0, "Expected raw-body-v1 HTTP responses.");
    NEED(f->payload_length - 8 <= maxRangeBytes, "An HTTP response is larger than its planned range.");
    out.push_back({int(le32(f->payload + 4)), f->payload + 8, f->payload_length - 8});
  }
  return true;
}
Json rangeRequest(size_t first, size_t last) {
  const std::string range = std::to_string(first) + "-" + std::to_string(last);
  return {{"method", "GET"}, {"url", std::string(sourceUrl) + "&sdn-range=" + range},
          {"headers", {{"Range", "bytes=" + range}, {"If-Modified-Since", "Thu, 01 Jan 1970 00:00:00 GMT"}}},
          {"timeoutMs", 900000}, {"maxBytes", last - first + 1}, {"responseWire", "raw-body-v1"}};
}

// ── state ──────────────────────────────────────────────────────────────────
struct State {
  Json meta;
  std::vector<float> sum, weight;  // sum of rho V and of V per voxel (V in pc^3 / dOmega)
};
bool readState(State& s) {
  const auto list = frames("state");
  NEED(list.size() == 1 && list[0]->payload && list[0]->payload_length >= 12 && list[0]->payload_length <= maxControlBytes,
       "Exactly one stage state is required.");
  const uint8_t* p = list[0]->payload;
  NEED(std::memcmp(p, "SDNDUST1", 8) == 0, "The stage state is not a 3D dust map state.");
  const uint32_t n = le32(p + 8);
  NEED(12 + size_t(n) <= list[0]->payload_length, "The stage state is truncated.");
  s.meta = Json::parse(p + 12, p + 12 + n, nullptr, false);
  NEED(s.meta.is_object() && s.meta.contains("stage") && s.meta["stage"].is_number_integer(), "The stage state has no stage.");
  const size_t rest = list[0]->payload_length - 12 - n;
  if (rest) {
    NEED(rest == kVoxels * 8, "The stage state's accumulators have the wrong size.");
    s.sum.resize(kVoxels);
    s.weight.resize(kVoxels);
    std::memcpy(s.sum.data(), p + 12 + n, kVoxels * 4);
    std::memcpy(s.weight.data(), p + 12 + n + kVoxels * 4, kVoxels * 4);
  }
  return true;
}
bool emit(const std::vector<Json>& requests, const State& s) {
  for (const auto& r : requests) NEED(output("request", r) >= 0, "Could not emit a request.");
  const std::string text = s.meta.dump();
  std::vector<uint8_t> frame(12 + text.size() + s.sum.size() * 4 + s.weight.size() * 4);
  std::memcpy(frame.data(), "SDNDUST1", 8);
  const uint32_t n = uint32_t(text.size());
  std::memcpy(frame.data() + 8, &n, 4);
  std::memcpy(frame.data() + 12, text.data(), text.size());
  if (!s.sum.empty()) {
    std::memcpy(frame.data() + 12 + text.size(), s.sum.data(), s.sum.size() * 4);
    std::memcpy(frame.data() + 12 + text.size() + s.sum.size() * 4, s.weight.data(), s.weight.size() * 4);
  }
  NEED(plugin_push_output_ex("state", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                             frame.data(), frame.size()) >= 0, "Could not emit the stage state.");
  return true;
}

// ── sampling ───────────────────────────────────────────────────────────────
const std::vector<float>& pixelVectors() {
  static std::vector<float> v;
  if (v.empty()) {
    v.resize(size_t(kPixels) * 3);
    double u[3];
    for (uint32_t p = 0; p < kPixels; ++p) {
      dustmap::nestToVector(kNside, p, u);
      v[size_t(p) * 3] = float(u[0]); v[size_t(p) * 3 + 1] = float(u[1]); v[size_t(p) * 3 + 2] = float(u[2]);
    }
  }
  return v;
}
// Probe sightlines for the report: one pixel inside each NSIDE-2 parent, kept
// within |b| < 26.7 deg so the 1234 pc integral stays inside the grid.
std::vector<uint32_t> probePixels() {
  std::vector<uint32_t> out;
  const auto& v = pixelVectors();
  for (uint32_t k = 0; k < kProbes; ++k) {
    const uint32_t p = k * (kPixels / kProbes) + kPixels / kProbes / 2;
    if (std::abs(v[size_t(p) * 3 + 2]) < 0.45f) out.push_back(p);
  }
  return out;
}
inline long voxelOf(double x, double y, double z) {
  const double fx = (x - kMinXPc) / kSpacingPc, fy = (y - kMinYPc) / kSpacingPc, fz = (z - kMinZPc) / kSpacingPc;
  if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx < kNx && fy < kNy && fz < kNz)) return -1;
  return long((size_t(fz) * kNy + size_t(fy)) * kNx + size_t(fx));
}
// One shell of densities at radius rc (pc) with weight V per sample.
void depositShell(State& s, const uint8_t* shell, double rc, double volume) {
  const auto& v = pixelVectors();
  for (uint32_t p = 0; p < kPixels; ++p) {
    const float rho = dustmap::bigEndianFloat(shell + size_t(p) * 4);
    if (!std::isfinite(rho)) continue;
    const long index = voxelOf(rc * v[size_t(p) * 3], rc * v[size_t(p) * 3 + 1], rc * v[size_t(p) * 3 + 2]);
    if (index < 0) continue;
    s.sum[size_t(index)] += float(rho * volume);
    s.weight[size_t(index)] += float(volume);
  }
}

// Shells [first, first+count) as ranges of at most 16 shells each.
std::vector<Json> chunkRequests(size_t meanData, uint32_t first, uint32_t count) {
  std::vector<Json> out;
  for (uint32_t s = first; s < first + count; s += kShellsPerRange) {
    const uint32_t n = std::min(kShellsPerRange, first + count - s);
    out.push_back(rangeRequest(meanData + size_t(s) * kShellBytes, meanData + size_t(s + n) * kShellBytes - 1));
  }
  return out;
}

bool depositChunk(State& s, const std::vector<Response>& rs) {
  const uint32_t first = s.meta["chunk_first"], count = s.meta["chunk_count"];
  const auto& bounds = s.meta["boundaries"];
  const auto& centers = s.meta["centers"];
  NEED(rs.size() == (count + kShellsPerRange - 1) / kShellsPerRange, "One response per planned shell range is required.");
  auto probes = s.meta["probe_integrals"];
  const auto probeList = s.meta["probe_pixels"];
  uint32_t shell = first;
  for (const auto& r : rs) {
    NEED(r.status == 206, "A shell range did not answer 206 Partial Content; the published map stays.");
    const uint32_t n = std::min(kShellsPerRange, first + count - shell);
    NEED(r.length == size_t(n) * kShellBytes, "A shell range is shorter or longer than planned.");
    for (uint32_t k = 0; k < n; ++k, ++shell) {
      const double lo = bounds[shell], hi = bounds[shell + 1], rc = centers[shell];
      NEED(rc > lo && rc < hi, "A radial pixel centre lies outside its boundaries.");
      const uint8_t* data = r.body + size_t(k) * kShellBytes;
      depositShell(s, data, rc, (hi * hi * hi - lo * lo * lo) / 3);
      for (size_t q = 0; q < probeList.size(); ++q) {
        const float rho = dustmap::bigEndianFloat(data + size_t(probeList[q].get<uint32_t>()) * 4);
        if (std::isfinite(rho) && hi <= s.meta["probe_radius"].get<double>()) probes[q] = probes[q].get<double>() + rho * (hi - lo);
      }
    }
  }
  s.meta["probe_integrals"] = probes;
  s.meta["shells_done"] = first + count;
  return true;
}

// Trilinear sample of the finished grid (E per pc) at a heliocentric point in pc.
double gridAt(const std::vector<double>& grid, double x, double y, double z) {
  const double u = (x - kMinXPc) / kSpacingPc - 0.5, v = (y - kMinYPc) / kSpacingPc - 0.5, w = (z - kMinZPc) / kSpacingPc - 0.5;
  if (!(u >= 0 && v >= 0 && w >= 0 && u <= kNx - 1 && v <= kNy - 1 && w <= kNz - 1)) return std::numeric_limits<double>::quiet_NaN();
  const uint32_t i = std::min(uint32_t(u), kNx - 2), j = std::min(uint32_t(v), kNy - 2), k = std::min(uint32_t(w), kNz - 2);
  const double fx = u - i, fy = v - j, fz = w - k;
  double sum = 0;
  for (unsigned dz = 0; dz < 2; ++dz) for (unsigned dy = 0; dy < 2; ++dy) for (unsigned dx = 0; dx < 2; ++dx)
    sum += grid[(size_t(k + dz) * kNy + (j + dy)) * kNx + (i + dx)] * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
  return sum;
}
}  // namespace

// config -> the primary and MEAN headers.
extern "C" int plan_dust() {
  const Json config = json("config");
  CHECK(config.is_object(), "Exactly one configuration object is required.");
  State s;
  s.meta = {{"stage", 1}};
  CHECK(emit({rangeRequest(0, kHeaderBytes - 1)}, s), error);
  return 0;
}

// state + responses -> next ranges + state (stages 1 to 13, see the top).
extern "C" int advance_dust() {
  State s;
  CHECK(readState(s), error);
  const int stage = s.meta["stage"].get<int>();
  CHECK(stage >= 1 && stage < int(kBuildStage), "advance_dust runs after stages 1 to 13.");
  std::vector<Response> rs;
  const size_t expected = stage < int(kFirstChunkStage) ? 1 : (s.meta["chunk_count"].get<uint32_t>() + kShellsPerRange - 1) / kShellsPerRange;
  CHECK(responses(expected, rs), error);
  if (stage == 1 && rs.size() == 1 && rs[0].status == 304)
    return output("status", {{"status", 304}, {"unchanged", true}, {"skipped", "not-modified"}}) < 0 ? 1 : 0;

  if (stage == 1) {
    CHECK(rs[0].status == 206 && rs[0].length == kHeaderBytes, "The FITS header range did not arrive whole.");
    dustmap::FitsHeader primary, mean;
    CHECK(primary.parse(rs[0].body, rs[0].length) && primary.text("SIMPLE") == "T", "The source is not a FITS file.");
    CHECK(primary.dataBytes() == 0, "The FITS primary unit is expected to carry no data.");
    const size_t at = primary.headerBytes;
    CHECK(mean.parse(rs[0].body + at, rs[0].length - at), "The MEAN header did not fit in the first range.");
    CHECK(mean.text("XTENSION") == "IMAGE" && mean.text("EXTNAME") == "MEAN" && mean.integer("BITPIX") == -32 &&
          mean.integer("NAXIS") == 2 && mean.integer("NAXIS1") == kPixels && mean.integer("NAXIS2") == kShells &&
          mean.integer("NSIDE") == kNside && mean.text("ORDERING") == "NEST" &&
          mean.text("CUNIT") == "E of Zhang, Green, and Rix (2023)",
          "The MEAN unit is not the published NSIDE-256 NESTED 516-shell map in E of ZGR23.");
    const size_t meanData = at + mean.headerBytes;
    s.meta = {{"stage", 2}, {"mean_data", meanData}, {"std_header", meanData + mean.dataBytes()},
              {"version", primary.text("VERSION")}, {"date", primary.text("DATE")}};
    CHECK(emit({rangeRequest(s.meta["std_header"], s.meta["std_header"].get<size_t>() + kHeaderBytes - 1)}, s), error);
    return 0;
  }
  if (stage == 2) {
    CHECK(rs[0].status == 206 && rs[0].length == kHeaderBytes, "The STD header range did not arrive whole.");
    dustmap::FitsHeader sd;
    CHECK(sd.parse(rs[0].body, rs[0].length) && sd.text("EXTNAME") == "STD." && sd.integer("NAXIS1") == kPixels &&
          sd.integer("NAXIS2") == kShells && sd.integer("BITPIX") == -32, "The STD unit is not where the MEAN unit says.");
    const size_t tail = s.meta["std_header"].get<size_t>() + sd.headerBytes + sd.dataBytes();
    s.meta["stage"] = 3;
    s.meta["tail"] = tail;
    CHECK(emit({rangeRequest(tail, tail + kTailBytes - 1)}, s), error);
    return 0;
  }
  if (stage == 3) {
    CHECK(rs[0].status == 206 && rs[0].length > 2880 && rs[0].length <= kTailBytes, "The table range did not arrive.");
    std::vector<double> centers, bounds;
    const uint8_t* inner = nullptr;
    double innerRadius = 0;
    for (size_t at = 0; at + 2880 <= rs[0].length;) {
      dustmap::FitsHeader h;
      CHECK(h.parse(rs[0].body + at, rs[0].length - at), "A table header is truncated.");
      const size_t data = at + h.headerBytes, bytes = h.dataBytes();
      CHECK(bytes != size_t(-1) && data + bytes <= rs[0].length + 2879, "A table unit is truncated.");
      const std::string name = h.text("EXTNAME");
      const auto column = [&](std::vector<double>& out, long long rows) {
        for (long long k = 0; k < rows; ++k) out.push_back(dustmap::bigEndianFloat(rs[0].body + data + size_t(k) * 4));
      };
      if (name == "RADIAL PIXEL CENTERS" && h.integer("NAXIS1") == 4 && h.text("TFORM1") == "E") column(centers, h.integer("NAXIS2"));
      else if (name == "RADIAL PIXEL BOUNDARIES" && h.integer("NAXIS1") == 4 && h.text("TFORM1") == "E") column(bounds, h.integer("NAXIS2"));
      else if (name.rfind("MEAN OF INTEGRATED INNER ", 0) == 0 && h.integer("NAXIS1") == kPixels && h.integer("BITPIX") == -32) {
        CHECK(data + kShellBytes <= rs[0].length, "The inner sphere is truncated.");
        inner = rs[0].body + data;
        innerRadius = std::atof(name.substr(25).c_str());
      }
      at = data + bytes;
    }
    CHECK(centers.size() == kShells && bounds.size() == kShells + 1 && inner && innerRadius > 0,
          "The radial tables or the inner sphere are missing.");
    for (size_t k = 0; k < kShells; ++k) CHECK(bounds[k] < bounds[k + 1] && centers[k] > bounds[k] && centers[k] < bounds[k + 1],
                                              "The radial tables are not increasing.");
    CHECK(innerRadius >= bounds[0] * 0.99 && innerRadius <= centers[0] * 1.01, "The inner sphere radius disagrees with the first shell.");
    s.sum.assign(kVoxels, 0.0f);
    s.weight.assign(kVoxels, 0.0f);
    // The inner sphere: the published integral over [0, r0] as a uniform
    // density, deposited on 8 sub-shells inside the first boundary.
    std::vector<uint8_t> uniform(kShellBytes);
    for (uint32_t p = 0; p < kPixels; ++p) {
      const float value = dustmap::bigEndianFloat(inner + size_t(p) * 4) / float(innerRadius);
      uint32_t bits;
      std::memcpy(&bits, &value, 4);
      const uint8_t be[4] = {uint8_t(bits >> 24), uint8_t(bits >> 16), uint8_t(bits >> 8), uint8_t(bits)};
      std::memcpy(uniform.data() + size_t(p) * 4, be, 4);
    }
    for (int k = 0; k < 8; ++k) {
      const double lo = bounds[0] * k / 8, hi = bounds[0] * (k + 1) / 8;
      depositShell(s, uniform.data(), (lo + hi) / 2, (hi * hi * hi - lo * lo * lo) / 3);
    }
    const auto probes = probePixels();
    Json integrals = Json::array();
    for (uint32_t p : probes) integrals.push_back(double(dustmap::bigEndianFloat(inner + size_t(p) * 4)) * bounds[0] / innerRadius);
    // Probe integrals end at the last boundary inside 1240 pc (the grid's last voxel centre).
    double probeRadius = bounds[0];
    for (double b : bounds) if (b <= 1240) probeRadius = b;
    s.meta["stage"] = int(kFirstChunkStage);
    s.meta["boundaries"] = bounds;
    s.meta["centers"] = centers;
    s.meta["inner_radius"] = innerRadius;
    s.meta["probe_pixels"] = probes;
    s.meta["probe_integrals"] = integrals;
    s.meta["probe_radius"] = probeRadius;
    s.meta["chunk_first"] = 0;
    s.meta["chunk_count"] = kShellsPerStage;
    CHECK(emit(chunkRequests(s.meta["mean_data"], 0, kShellsPerStage), s), error);
    return 0;
  }
  // Stages 4 to 13: deposit 48 shells, ask for the next.
  CHECK(s.sum.size() == kVoxels, "The stage state has no accumulators.");
  CHECK(depositChunk(s, rs), error);
  const uint32_t next = s.meta["shells_done"], count = std::min(kShellsPerStage, kShells - next);
  s.meta["stage"] = stage + 1;
  s.meta["chunk_first"] = next;
  s.meta["chunk_count"] = count;
  CHECK(emit(chunkRequests(s.meta["mean_data"], next, count), s), error);
  return 0;
}

// state + the last shells + receipt -> one $PCE row per z plane, meta, report.
extern "C" int build_dust() {
  State s;
  CHECK(readState(s), error);
  CHECK(s.meta["stage"].get<int>() == int(kBuildStage) && s.sum.size() == kVoxels, "build_dust runs after the last shell stage.");
  std::vector<Response> rs;
  CHECK(responses((s.meta["chunk_count"].get<uint32_t>() + kShellsPerRange - 1) / kShellsPerRange, rs), error);
  CHECK(depositChunk(s, rs), error);
  CHECK(s.meta["shells_done"].get<uint32_t>() == kShells, "Every shell must be deposited before the rows are built.");
  const Json receipt = json("receipt");
  CHECK(receipt.is_object() && receipt.contains("retrieved_at_ms") && receipt["retrieved_at_ms"].is_number_integer(), "Invalid retrieval epoch.");
  const auto peer = receipt.value("producer_peer_id", std::string());
  CHECK(!peer.empty() && peer.size() <= 128, "An authenticated producer peer ID is required.");
  const std::string when = isoTime(receipt["retrieved_at_ms"].get<int64_t>());

  const double maxRadius = s.meta["boundaries"].back().get<double>();
  std::vector<double> grid(kVoxels, std::numeric_limits<double>::quiet_NaN());
  size_t covered = 0;
  double total = 0;
  for (uint32_t k = 0; k < kNz; ++k) for (uint32_t j = 0; j < kNy; ++j) for (uint32_t i = 0; i < kNx; ++i) {
    const size_t v = (size_t(k) * kNy + j) * kNx + i;
    const double x = kMinXPc + (i + 0.5) * kSpacingPc, y = kMinYPc + (j + 0.5) * kSpacingPc, z = kMinZPc + (k + 0.5) * kSpacingPc;
    if (std::sqrt(x * x + y * y + z * z) > maxRadius || !(s.weight[v] > 0)) continue;
    grid[v] = double(s.sum[v]) / double(s.weight[v]);
    ++covered;
    total += grid[v] * kSpacingPc * kSpacingPc * kSpacingPc;
  }
  CHECK(covered > kVoxels / 3, "Fewer than a third of the voxels received data; the published map stays.");
  // Report: native line integrals against the resampled grid on the probes.
  const auto& vectors = pixelVectors();
  const double probeRadius = s.meta["probe_radius"];
  Json probeReport = Json::array();
  std::vector<double> ratios;
  for (size_t q = 0; q < s.meta["probe_pixels"].size(); ++q) {
    const uint32_t p = s.meta["probe_pixels"][q];
    double integral = 0;
    for (double t = 1; t < probeRadius; t += 2) {
      const double value = gridAt(grid, t * vectors[size_t(p) * 3], t * vectors[size_t(p) * 3 + 1], t * vectors[size_t(p) * 3 + 2]);
      if (std::isfinite(value)) integral += value * 2;
    }
    const double native = s.meta["probe_integrals"][q];
    const double l = std::atan2(vectors[size_t(p) * 3 + 1], vectors[size_t(p) * 3]) * 57.29577951308232;
    const double b = std::asin(std::clamp(double(vectors[size_t(p) * 3 + 2]), -1.0, 1.0)) * 57.29577951308232;
    probeReport.push_back({{"l", l < 0 ? l + 360 : l}, {"b", b}, {"a_v_native", kAvPerUnit * native}, {"a_v_grid", kAvPerUnit * integral}});
    if (native > 0) ratios.push_back(integral / native);
  }
  std::sort(ratios.begin(), ratios.end());
  const double medianRatio = ratios.empty() ? 0 : ratios[ratios.size() / 2];

  std::vector<uint8_t> stream;
  const std::vector<double> shape = {kNx, kNy, kNz};
  const std::vector<double> first = {(kMinXPc + kSpacingPc / 2) / 1000, (kMinYPc + kSpacingPc / 2) / 1000, (kMinZPc + kSpacingPc / 2) / 1000};
  const std::string source = std::string("Edenhofer et al. 2024 posterior mean, ") + sourceUrl + ", version " +
                             s.meta.value("version", std::string()) + " " + s.meta.value("date", std::string());
  for (uint32_t k = 0; k < kNz; ++k) {
    Row row;
    row.text("dataset", datasetId);
    row.number("plane", k);
    row.vector("shape", shape);
    row.vector("first_center", first, "kpc");
    row.number("spacing", kSpacingPc / 1000, "kpc");
    row.number("max_radius", maxRadius / 1000, "kpc");
    row.text("unit", "E(ZGR23) pc^-1");
    row.number("a_v_per_unit", kAvPerUnit, "mag A_V(540 nm) per E");
    row.vector("density", std::vector<double>(grid.begin() + size_t(k) * kNx * kNy, grid.begin() + size_t(k + 1) * kNx * kNy),
               "E(ZGR23) pc^-1; NaN = no data");
    row.text("frame", frameText);
    row.text("source", source);
    row.text("license", license);
    row.text("credit", credit);
    row.text("retrieved_at", when);
    row.finish(stream);
  }
  const std::string batch = ephem::sha256_hex(reinterpret_cast<const uint8_t*>(grid.data()), grid.size() * sizeof(double));
  const Json meta = {{"schema", "PCE.fbs"}, {"batch_id", batch}, {"provider_id", providerId}, {"source_name", sourceName},
                     {"source_url", sourceUrl}, {"source_peer", peer}, {"reconcile", "current"}, {"origin_id", "zenodo.org"},
                     {"origin_name", "Edenhofer et al. 2024 local 3D dust map (Zenodo 10658339)"},
                     {"dataset_id", std::string(providerId) + "/" + datasetId},
                     {"terms_url", "https://creativecommons.org/licenses/by/4.0/"}, {"citation", credit}, {"licence", license}};
  const Json report = {{"rows", kNz}, {"voxels", kVoxels}, {"covered_voxels", covered}, {"spacing_pc", kSpacingPc},
                       {"max_radius_pc", maxRadius}, {"total_e_pc2", total}, {"shells", kShells}, {"inner_radius_pc", s.meta["inner_radius"]},
                       {"probe_radius_pc", probeRadius}, {"probes", probeReport}, {"probe_median_grid_over_native", medianRatio},
                       {"batch_id", batch}, {"retrieved_at", when}, {"source_version", s.meta.value("version", std::string())}};
  if (output("meta", meta) < 0 || output("report", report) < 0) return 1;
  return plugin_push_output_ex("records", "PCE.fbs", "$PCE", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PCE", 0, 0,
                               stream.data(), stream.size()) < 0 ? 1 : 0;
}
