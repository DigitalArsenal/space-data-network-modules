// files/geotiff: GeoTIFF and Cloud-Optimized GeoTIFF images as globe imagery
// (owner 2026-10-13: "add arbitrary imagery layers as well").
//
// describe  the file's header -> one SDS $GDI (format, footprint polygon in
//           EPSG:4326, source CRS) and the level table the caller tiles by.
// render    the file's byte ranges + a window in EPSG:4326 -> that window as
//           8-bit RGBA, resampled (nearest) from the coarsest level at least
//           as fine as the window's pixels, through the source projection.
//
// Both methods read a sparse file: the byte ranges the caller has. When a
// read falls outside them the method answers on port "need" with the ranges
// to fetch (offset, length pairs, float64) and nothing else; the caller
// fetches them and calls again. A COG is read with a header fetch and one
// fetch of the tiles each window needs.
//
// Port "descriptor": a size-prefixed SDS $NCD FlatBuffer describing the file
// (FORMAT PROVIDER_DEFINED, PROVIDER_DEFINED_FORMAT_NAME "GeoTIFF");
// SOURCE_BYTE_LENGTH, when stated, is the whole file's size.
// Port "ranges" (raw bytes, no SDS identity): [u32le count] and per range
// [u64le offset][u32le length][bytes], pieces of the TIFF file.
// Port "request" (render): float64 little-endian
//   [1, level (-1: automatic), west, south, east, north (degrees), width, height,
//    lo0, hi0, lo1, hi1, lo2, hi2 (stretch; NaN: 2-98 % of the window's samples), 0, 0].
// Port "levels" (describe): float64 [1, levelCount, epsg, bands, bits,
//   sampleFormat, photometric, compression, west, south, east, north,
//   maxLevel, stretched, width, height], then per level [width, height,
//   chunkWidth, chunkHeight, chunks]. maxLevel is the finest level of a
//   256-pixel geographic tiling (level 0: two tiles) the image's resolution
//   fills; stretched is 1 when samples are not 8-bit and need a stretch.
// Port "image" (render): width x height x 4 bytes, RGBA, rows north to south.
// Port "stats" (render): float64 [lo0, hi0, lo1, hi1, lo2, hi2] the stretch used.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <vector>

#include "space_data_module_invoke.h"

namespace {

constexpr uint32_t kMaxSide = 4096;
constexpr uint64_t kMaxDecoded = uint64_t(768) << 20;
constexpr uint64_t kCoalesceGap = 64 * 1024;

int32_t fail(const char* code, const std::string& message, int32_t status = 400) {
  plugin_set_error(code, message.c_str());
  return status;
}

// Raw bytes on a wildcard port (the SDK's raw lane): plugin_push_output_ex with
// the aligned-binary wire format is the SDK's only way to emit variable-length
// bytes with no SDS identity.
int32_t push(const char* port, const void* data, size_t size) {
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 8,
                               static_cast<const uint8_t*>(data), uint32_t(size)) < 0
             ? 500
             : 0;
}

struct FileInput {
  tiff::Sparse sparse;
  uint64_t size = 0;
};

uint32_t le32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }
uint64_t le64(const uint8_t* p) { return uint64_t(le32(p)) | uint64_t(le32(p + 4)) << 32; }

const plugin_input_frame_t* inputFrame(const char* port) {
  const int32_t index = plugin_find_input_index(port, 0);
  return index >= 0 ? plugin_get_input_frame(uint32_t(index)) : nullptr;
}

int32_t readFile(FileInput* in) {
  const plugin_input_frame_t* d = inputFrame("descriptor");
  if (!d || !d->payload || d->payload_length < 8) return fail("missing-descriptor", "A size-prefixed $NCD frame on port \"descriptor\" is required.");
  const uint32_t prefix = le32(d->payload);
  if (size_t(prefix) + 4 != size_t(d->payload_length)) return fail("malformed-descriptor", "The $NCD size prefix does not match the frame.");
  if (!::flatbuffers::BufferHasIdentifier(d->payload, NCDIdentifier(), true)) return fail("malformed-descriptor", "The frame on port \"descriptor\" is not a size-prefixed $NCD.");
  ::flatbuffers::Verifier verifier(d->payload, size_t(d->payload_length));
  if (!VerifySizePrefixedNCDBuffer(verifier)) return fail("malformed-descriptor", "The $NCD descriptor does not verify.");
  in->size = uint64_t(GetSizePrefixedNCD(d->payload)->SOURCE_BYTE_LENGTH());

  const plugin_input_frame_t* frame = inputFrame("ranges");
  if (!frame || !frame->payload || frame->payload_length < 4) return fail("missing-ranges", "A frame of the file's byte ranges on port \"ranges\" is required.");
  const uint8_t* p = frame->payload;
  const size_t n = size_t(frame->payload_length);
  size_t at = 0;
  const uint32_t count = le32(p + at);
  at += 4;
  for (uint32_t i = 0; i < count; ++i) {
    if (at + 12 > n) return fail("malformed-ranges", "A range header overruns the frame.");
    tiff::Sparse::Range r;
    r.off = le64(p + at);
    r.len = le32(p + at + 8);
    at += 12;
    if (at + r.len > n) return fail("malformed-ranges", "A range's bytes overrun the frame.");
    r.data = p + at;
    at += size_t(r.len);
    in->sparse.ranges.push_back(r);
  }
  if (in->sparse.ranges.empty()) return fail("malformed-ranges", "The frame carries no byte range of the file.");
  return 0;
}

// The missing ranges, merged, as float64 pairs on port "need".
int32_t pushNeed(tiff::Sparse& s) {
  auto& need = s.need;
  std::sort(need.begin(), need.end());
  std::vector<double> out;
  for (size_t i = 0; i < need.size();) {
    uint64_t start = need[i].first, end = need[i].first + need[i].second;
    size_t j = i + 1;
    while (j < need.size() && need[j].first <= end + kCoalesceGap) {
      end = std::max(end, need[j].first + need[j].second);
      ++j;
    }
    out.push_back(double(start));
    out.push_back(double(end - start));
    i = j;
  }
  return push("need", out.data(), out.size() * sizeof(double));
}

// Pixel corner (i, j) of the full-resolution image -> lon, lat.
void pixelToLonLat(const image::Image& im, const project::Projector& pj, double i, double j, double* lon, double* lat) {
  const double x = im.gt[0] + i * im.gt[1] + j * im.gt[2];
  const double y = im.gt[3] + i * im.gt[4] + j * im.gt[5];
  pj.inverse(x, y, lon, lat);
}

struct Footprint {
  std::vector<std::pair<double, double>> ring;
  double west = 180, south = 90, east = -180, north = -90;
};

Footprint footprintOf(const image::Image& im, const project::Projector& pj) {
  Footprint fp;
  const double W = im.levels[0].w, H = im.levels[0].h;
  const double corners[5][2] = {{0, H}, {W, H}, {W, 0}, {0, 0}, {0, H}};
  constexpr int kSteps = 16;
  for (int e = 0; e < 4; ++e)
    for (int s = 0; s < kSteps; ++s) {
      const double t = double(s) / kSteps;
      double lon, lat;
      pixelToLonLat(im, pj, corners[e][0] + t * (corners[e + 1][0] - corners[e][0]), corners[e][1] + t * (corners[e + 1][1] - corners[e][1]), &lon, &lat);
      fp.ring.emplace_back(lon, lat);
      fp.west = std::min(fp.west, lon); fp.east = std::max(fp.east, lon);
      fp.south = std::min(fp.south, lat); fp.north = std::max(fp.north, lat);
    }
  fp.ring.push_back(fp.ring.front());
  fp.west = std::max(fp.west, -180.0); fp.east = std::min(fp.east, 180.0);
  fp.south = std::max(fp.south, -90.0); fp.north = std::min(fp.north, 90.0);
  return fp;
}

// Degrees per full-resolution pixel at the image centre (the finer axis).
double degreesPerPixel(const image::Image& im, const project::Projector& pj) {
  const double ci = im.levels[0].w / 2.0, cj = im.levels[0].h / 2.0;
  double lon0, lat0, lon1, lat1, lon2, lat2;
  pixelToLonLat(im, pj, ci, cj, &lon0, &lat0);
  pixelToLonLat(im, pj, ci + 1, cj, &lon1, &lat1);
  pixelToLonLat(im, pj, ci, cj + 1, &lon2, &lat2);
  const double a = std::hypot(lon1 - lon0, lat1 - lat0), b = std::hypot(lon2 - lon0, lat2 - lat0);
  return std::min(a, b);
}

int32_t loadImage(FileInput& in, image::Image& im) {
  im.file.src = &in.sparse;
  if (image::load(im)) return 0;
  if (im.missing()) return -1;
  return fail("unreadable-geotiff", "This GeoTIFF cannot be drawn: " + im.file.error + ".");
}

}  // namespace

extern "C" int samples() {
  FileInput in;
  if(const int status=readFile(&in))return status;
  const auto* frame=inputFrame("request");
  if(!frame || frame->payload_length!=5*sizeof(double))return fail("invalid-window","samples needs float64 [1, x, y, width, height]");
  double a[5];std::memcpy(a,frame->payload,sizeof(a));
  if(a[0]!=1)return fail("invalid-window","unknown scalar request version");
  for(size_t i=1;i<5;++i)if(!std::isfinite(a[i])||a[i]<0||a[i]>10000000||a[i]!=std::floor(a[i]))return fail("invalid-window","window coordinates must be nonnegative integers");
  const scalar::Window w{uint32_t(a[1]),uint32_t(a[2]),uint32_t(a[3]),uint32_t(a[4])};
  const uint8_t* magic=in.sparse.view(0,4);
  if(!magic)return pushNeed(in.sparse);
  scalar::Result out;
  const bool isTiff=(magic[0]=='I'&&magic[1]=='I')||(magic[0]=='M'&&magic[1]=='M');
  const bool ok=isTiff?scalar::tiffWindow(in.sparse,w,out):scalar::cubeWindow(in.sparse,in.size,w,out);
  if(!ok) {
    if(!in.sparse.need.empty())return pushNeed(in.sparse);
    return fail("unreadable-elevation",out.error,422);
  }
  const double layout[]={1,double(out.width),double(out.height),double(out.bits),double(out.format),out.scale,out.offset,out.nodata,out.hasNodata?1.0:0.0};
  if(const int status=push("layout",layout,sizeof(layout)))return status;
  if(const int status=push("values",out.values.data(),out.values.size()*sizeof(double)))return status;
  return push("valid",out.valid.data(),out.valid.size());
}

extern "C" int describe() {
  FileInput in;
  if (int32_t status = readFile(&in)) return status;
  image::Image im;
  const int32_t loaded = loadImage(in, im);
  if (loaded < 0) return pushNeed(in.sparse);
  if (loaded) return loaded;
  const project::Projector pj(im.crs);
  const Footprint fp = footprintOf(im, pj);
  const double res = degreesPerPixel(im, pj);
  const double maxLevel = std::clamp(std::ceil(std::log2(180.0 / (256.0 * res))), 0.0, 22.0);
  const bool stretched = !(im.bps == 8 && im.sampleFormat == 1) && im.photometric != 3;

  GDIT gdi;
  gdi.ID = "geotiff";
  gdi.FORMAT = imageFormat::GEOTIFF;
  gdi.FILESIZE = int64_t(in.size);
  std::string json = "{\"type\":\"Polygon\",\"coordinates\":[[";
  char point[64];
  for (size_t k = 0; k < fp.ring.size(); ++k) {
    std::snprintf(point, sizeof(point), "%s[%.9f,%.9f]", k ? "," : "", fp.ring[k].first, fp.ring[k].second);
    json += point;
  }
  json += "]]}";
  gdi.REGION_GEO_JSON = json;
  gdi.REGION_TYPE = "Polygon";
  gdi.REGION_NDIMS = 2;
  gdi.REGION_SRID = 4326;
  const char* kind = im.sampleFormat == 3 ? "floating-point" : im.sampleFormat == 2 ? "signed" : "unsigned";
  char notes[256];
  std::snprintf(notes, sizeof(notes), "%u x %u, %u band%s of %u-bit %s, %s, %zu level%s, EPSG:%d", im.levels[0].w, im.levels[0].h, im.spp,
                im.spp == 1 ? "" : "s", im.bps, kind, image::compressionName(im.compression), im.levels.size(), im.levels.size() == 1 ? "" : "s", im.crs.epsg);
  gdi.NOTES = notes;
  gdi.KEYWORDS.push_back("EPSG:" + std::to_string(im.crs.epsg));
  ::flatbuffers::FlatBufferBuilder fbb(1024);
  fbb.FinishSizePrefixed(CreateGDI(fbb, &gdi), GDIIdentifier());
  if (plugin_push_output_ex("info", "GDI.fbs", "$GDI", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "GDI", 0, 0, fbb.GetBufferPointer(), uint32_t(fbb.GetSize())) < 0)
    return 500;

  std::vector<double> t = {1, double(im.levels.size()), double(im.crs.epsg), double(im.spp), double(im.bps), double(im.sampleFormat),
                           double(im.photometric), double(im.compression), fp.west, fp.south, fp.east, fp.north, maxLevel, stretched ? 1.0 : 0.0,
                           double(im.levels[0].w), double(im.levels[0].h)};
  for (const image::Level& lv : im.levels) {
    t.insert(t.end(), {double(lv.w), double(lv.h), double(lv.chunkW), double(lv.chunkH), double(lv.across) * lv.down});
  }
  return push("levels", t.data(), t.size() * sizeof(double));
}

namespace {

struct Window {
  int level = -1;
  double west = 0, south = 0, east = 0, north = 0;
  uint32_t width = 0, height = 0;
  double lo[3], hi[3];
};

int32_t readRequest(Window* w) {
  const int32_t index = plugin_find_input_index("request", 0);
  const plugin_input_frame_t* frame = index >= 0 ? plugin_get_input_frame(uint32_t(index)) : nullptr;
  if (!frame || !frame->payload || frame->payload_length < 16 * 8) return fail("missing-request", "A 16-value float64 frame on port \"request\" is required.");
  double v[16];
  std::memcpy(v, frame->payload, sizeof(v));
  if (v[0] != 1) return fail("malformed-request", "The request's version is not 1.");
  w->level = int(v[1]);
  w->west = v[2]; w->south = v[3]; w->east = v[4]; w->north = v[5];
  if (!(w->west < w->east && w->south < w->north && w->west >= -180 && w->east <= 180 && w->south >= -90 && w->north <= 90))
    return fail("malformed-request", "The window is not west < east, south < north within the globe.");
  if (!(v[6] >= 1 && v[6] <= kMaxSide && v[7] >= 1 && v[7] <= kMaxSide)) return fail("malformed-request", "The window's size is not 1 to 4096 pixels a side.");
  w->width = uint32_t(v[6]);
  w->height = uint32_t(v[7]);
  for (int b = 0; b < 3; ++b) {
    w->lo[b] = v[8 + 2 * b];
    w->hi[b] = v[9 + 2 * b];
  }
  return 0;
}

// The level a window draws from: the coarsest at least as fine as its pixels.
size_t pickLevel(const image::Image& im, const project::Projector& pj, const Window& w) {
  if (w.level >= 0) return std::min<size_t>(size_t(w.level), im.levels.size() - 1);
  const double cx = (w.west + w.east) / 2, cy = (w.south + w.north) / 2;
  const double dx = (w.east - w.west) / w.width, dy = (w.north - w.south) / w.height;
  double x0, y0, x1, y1, x2, y2;
  pj.forward(cx, cy, &x0, &y0);
  pj.forward(cx + dx, cy, &x1, &y1);
  pj.forward(cx, cy + dy, &x2, &y2);
  const double outPixels = std::min(std::hypot(x1 - x0, y1 - y0), std::hypot(x2 - x0, y2 - y0));
  const double full = std::min(std::hypot(im.gt[1], im.gt[4]), std::hypot(im.gt[2], im.gt[5]));
  size_t pick = 0;
  for (size_t l = 1; l < im.levels.size(); ++l) {
    const double res = full * double(im.levels[0].w) / im.levels[l].w;
    if (res <= outPixels * 1.0001) pick = l;
  }
  return pick;
}

struct Sampler {
  const image::Image& im;
  const project::Projector& pj;
  const Window& w;
  const image::Level& lv;
  double sx, sy;  // full-resolution pixels per level pixel

  // Level pixel under output pixel (c, r), or false outside the image.
  bool at(uint32_t c, uint32_t r, uint32_t* px, uint32_t* py) const {
    const double lon = w.west + (c + 0.5) * (w.east - w.west) / w.width;
    const double lat = w.north - (r + 0.5) * (w.north - w.south) / w.height;
    double x, y;
    pj.forward(lon, lat, &x, &y);
    if (!std::isfinite(x) || !std::isfinite(y)) return false;
    const double i = im.inv[0] + x * im.inv[1] + y * im.inv[2];
    const double j = im.inv[3] + x * im.inv[4] + y * im.inv[5];
    const double li = std::floor(i / sx), lj = std::floor(j / sy);
    if (li < 0 || lj < 0 || li >= lv.w || lj >= lv.h) return false;
    *px = uint32_t(li);
    *py = uint32_t(lj);
    return true;
  }
};

double sampleValue(const image::Image& im, const uint8_t* p) {
  switch (im.bps) {
    case 8: return im.sampleFormat == 2 ? double(int8_t(*p)) : double(*p);
    case 16: {
      uint16_t v;
      std::memcpy(&v, p, 2);
      return im.sampleFormat == 2 ? double(int16_t(v)) : double(v);
    }
    default: {
      uint32_t v;
      std::memcpy(&v, p, 4);
      if (im.sampleFormat == 3) {
        float f;
        std::memcpy(&f, &v, 4);
        return double(f);
      }
      return im.sampleFormat == 2 ? double(int32_t(v)) : double(v);
    }
  }
}

}  // namespace

extern "C" int render() {
  FileInput in;
  if (int32_t status = readFile(&in)) return status;
  Window w;
  if (int32_t status = readRequest(&w)) return status;
  image::Image im;
  const int32_t loaded = loadImage(in, im);
  if (loaded < 0) return pushNeed(in.sparse);
  if (loaded) return loaded;
  const project::Projector pj(im.crs);
  const size_t li = pickLevel(im, pj, w);
  const image::Level& lv = im.levels[li];
  const image::Level* mask = lv.mask >= 0 ? &im.masks[size_t(lv.mask)] : nullptr;
  const Sampler sampler{im, pj, w, lv, double(im.levels[0].w) / lv.w, double(im.levels[0].h) / lv.h};
  const uint32_t planes = im.planar == 2 ? im.spp : 1;
  const uint32_t perPlane = lv.across * lv.down;

  // Pass 1: the chunks the window touches.
  std::vector<uint8_t> wanted(perPlane, 0);
  for (uint32_t r = 0; r < w.height; ++r)
    for (uint32_t c = 0; c < w.width; ++c) {
      uint32_t px, py;
      if (sampler.at(c, r, &px, &py)) wanted[(py / lv.chunkH) * lv.across + px / lv.chunkW] = 1;
    }
  uint64_t decodedBytes = 0;
  for (uint32_t k = 0; k < perPlane; ++k) {
    if (!wanted[k]) continue;
    for (uint32_t p = 0; p < planes; ++p) {
      const size_t idx = size_t(p) * perPlane + k;
      in.sparse.view(lv.offsets[idx], lv.counts[idx]);
      decodedBytes += uint64_t(lv.chunkW) * lv.chunkH * (im.planar == 2 ? 1 : im.spp) * (im.bps / 8);
    }
    if (mask && k < mask->offsets.size()) in.sparse.view(mask->offsets[k], mask->counts[k]);
  }
  if (decodedBytes > kMaxDecoded)
    return fail("window-too-large", "This view needs more of the GeoTIFF than can be decoded at once; a Cloud-Optimized GeoTIFF (with overviews) draws at every zoom.");
  if (!in.sparse.need.empty()) return pushNeed(in.sparse);

  // Pass 2: decode them.
  std::map<size_t, std::vector<uint8_t>> chunks, maskChunks;
  for (uint32_t k = 0; k < perPlane; ++k) {
    if (!wanted[k]) continue;
    for (uint32_t p = 0; p < planes; ++p) {
      const size_t idx = size_t(p) * perPlane + k;
      if (!image::decode(im, lv, idx, false, &chunks[idx])) return fail("unreadable-geotiff", "This GeoTIFF cannot be drawn: " + im.file.error + ".");
    }
    if (mask && k < mask->offsets.size() && !image::decode(im, *mask, k, true, &maskChunks[k]))
      return fail("unreadable-geotiff", "This GeoTIFF cannot be drawn: " + im.file.error + ".");
  }

  const bool palette = im.photometric == 3;
  const bool color = im.spp >= 3 && !palette;
  const int bands = color ? 3 : 1;
  const bool eight = im.bps == 8 && im.sampleFormat == 1;
  const uint32_t bytes = im.bps / 8;
  const uint32_t chunkChannels = im.planar == 2 ? 1 : im.spp;
  auto locate = [&](uint32_t px, uint32_t py, uint32_t band) -> const uint8_t* {
    const uint32_t k = (py / lv.chunkH) * lv.across + px / lv.chunkW;
    const size_t idx = im.planar == 2 ? size_t(band) * perPlane + k : k;
    const auto it = chunks.find(idx);
    if (it == chunks.end()) return nullptr;
    const size_t x = px % lv.chunkW, y = py % lv.chunkH;
    const size_t off = ((y * lv.chunkW + x) * chunkChannels + (im.planar == 2 ? 0 : band)) * bytes;
    return off + bytes <= it->second.size() ? it->second.data() + off : nullptr;
  };

  // The stretch: stated, or 2-98 % of the window's samples (8-bit and palette data draw as they are).
  double lo[3], hi[3];
  for (int b = 0; b < 3; ++b) {
    lo[b] = w.lo[b];
    hi[b] = w.hi[b];
  }
  if (!eight && !palette) {
    for (int b = 0; b < bands; ++b) {
      if (std::isfinite(lo[b]) && std::isfinite(hi[b]) && hi[b] > lo[b]) continue;
      std::vector<double> values;
      for (const auto& [idx, data] : chunks) {
        if (im.planar == 2 && idx / perPlane != size_t(b)) continue;
        const size_t samples = data.size() / bytes / chunkChannels;
        const size_t stride = std::max<size_t>(1, samples / 65536);
        for (size_t s = 0; s < samples; s += stride) {
          const double v = sampleValue(im, data.data() + (s * chunkChannels + (im.planar == 2 ? 0 : b)) * bytes);
          if (std::isfinite(v) && !(im.hasNodata && v == im.nodata)) values.push_back(v);
        }
      }
      if (values.empty()) {
        lo[b] = 0;
        hi[b] = 1;
        continue;
      }
      std::sort(values.begin(), values.end());
      lo[b] = values[size_t(0.02 * (values.size() - 1))];
      hi[b] = values[size_t(0.98 * (values.size() - 1))];
      if (!(hi[b] > lo[b])) hi[b] = lo[b] + 1;
    }
  }

  std::vector<uint8_t> rgba(size_t(w.width) * w.height * 4, 0);
  const size_t paletteSize = size_t(1) << std::min<uint32_t>(im.bps, 16);
  for (uint32_t r = 0; r < w.height; ++r)
    for (uint32_t c = 0; c < w.width; ++c) {
      uint32_t px, py;
      if (!sampler.at(c, r, &px, &py)) continue;
      uint8_t* out = &rgba[(size_t(r) * w.width + c) * 4];
      double v[3] = {0, 0, 0};
      bool ok = true;
      for (int b = 0; b < bands && ok; ++b) {
        const uint8_t* s = locate(px, py, uint32_t(b));
        if (!s) ok = false;
        else v[b] = sampleValue(im, s);
      }
      if (!ok || !std::isfinite(v[0]) || (im.hasNodata && v[0] == im.nodata)) continue;
      uint8_t alpha = 255;
      if (im.alphaBand >= 0) {
        const uint8_t* s = locate(px, py, uint32_t(im.alphaBand));
        if (s) {
          const double a = sampleValue(im, s);
          alpha = eight ? uint8_t(a) : uint8_t(std::clamp(a / ((1u << std::min<uint32_t>(im.bps, 31)) - 1.0) * 255.0, 0.0, 255.0));
        }
      }
      if (mask) {
        const uint32_t k = (py / mask->chunkH) * mask->across + px / mask->chunkW;
        const auto it = maskChunks.find(k);
        if (it != maskChunks.end()) {
          const size_t rowBytes = (mask->chunkW + 7) / 8;
          const size_t x = px % mask->chunkW, y = py % mask->chunkH;
          const size_t byte = y * rowBytes + x / 8;
          if (byte < it->second.size() && !((it->second[byte] >> (7 - x % 8)) & 1)) alpha = 0;
        }
      }
      if (alpha == 0) continue;
      if (palette) {
        const size_t index = std::min<size_t>(size_t(v[0]), paletteSize - 1);
        out[0] = uint8_t(im.colormap[index] >> 8);
        out[1] = uint8_t(im.colormap[paletteSize + index] >> 8);
        out[2] = uint8_t(im.colormap[2 * paletteSize + index] >> 8);
      } else {
        uint8_t q[3];
        for (int b = 0; b < bands; ++b)
          q[b] = eight ? uint8_t(v[b]) : uint8_t(std::lround(std::clamp((v[b] - lo[b]) / (hi[b] - lo[b]), 0.0, 1.0) * 255.0));
        if (!color) {
          const uint8_t g = im.photometric == 0 ? uint8_t(255 - q[0]) : q[0];
          q[0] = q[1] = q[2] = g;
        }
        out[0] = q[0];
        out[1] = q[1];
        out[2] = q[2];
      }
      out[3] = alpha;
    }
  if (int32_t status = push("image", rgba.data(), rgba.size())) return status;
  double stats[6];
  for (int b = 0; b < 3; ++b) {
    stats[2 * b] = (eight || palette || b >= bands) ? std::numeric_limits<double>::quiet_NaN() : lo[b];
    stats[2 * b + 1] = (eight || palette || b >= bands) ? std::numeric_limits<double>::quiet_NaN() : hi[b];
  }
  return push("stats", stats, sizeof(stats));
}
