#pragma once
// One GeoTIFF as an image pyramid: its full-resolution image and reduced
// levels (a Cloud-Optimized GeoTIFF's overviews), their masks, the sample
// layout, the georeferencing and the decoded chunks a window needs.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace image {

struct Level {
  size_t ifd = 0;
  uint32_t w = 0, h = 0, chunkW = 0, chunkH = 0, across = 0, down = 0;
  std::vector<uint64_t> offsets, counts;
  int mask = -1;  // index into Image::masks
};

struct Image {
  tiff::File file;
  std::vector<Level> levels, masks;
  uint32_t spp = 1, bps = 8, sampleFormat = 1, photometric = 1, compression = 1, planar = 1, predictor = 1, maskCompression = 1;
  std::vector<uint64_t> colormap;
  const uint8_t* jpegTables = nullptr;
  size_t jpegTablesLen = 0;
  int alphaBand = -1;
  double gt[6] = {0, 1, 0, 0, 0, -1};  // full-resolution pixel corner (i, j) -> CRS x, y
  double inv[6] = {0};
  project::Crs crs;
  bool hasNodata = false;
  double nodata = 0;

  bool fail(const std::string& why) {
    file.error = why;
    return false;
  }
  bool missing() const { return !file.src->need.empty(); }
};

inline const char* compressionName(uint64_t c) {
  switch (c) {
    case 1: return "none";
    case 5: return "LZW";
    case 6: return "old-style JPEG";
    case 7: return "JPEG";
    case 8: case 32946: return "DEFLATE";
    case 32773: return "PackBits";
    case 34887: return "LERC";
    case 34925: return "LZMA";
    case 50000: return "ZSTD";
    case 50001: return "WebP";
    case 50002: return "JPEG XL";
    default: return "an unknown method";
  }
}

inline bool readLevel(Image& im, size_t ifd, Level* lv, bool mask) {
  tiff::File& f = im.file;
  lv->ifd = ifd;
  lv->w = uint32_t(f.uint(ifd, 256, 0));
  lv->h = uint32_t(f.uint(ifd, 257, 0));
  if (!lv->w || !lv->h) return im.missing() ? false : im.fail("a TIFF image has no size");
  const uint32_t planes = (!mask && im.planar == 2) ? im.spp : 1;
  if (f.tag(ifd, 322)) {
    lv->chunkW = uint32_t(f.uint(ifd, 322, 0));
    lv->chunkH = uint32_t(f.uint(ifd, 323, 0));
    if (!f.uints(ifd, 324, &lv->offsets) || !f.uints(ifd, 325, &lv->counts)) return im.missing() ? false : im.fail("a tiled TIFF image has no tile offsets");
  } else {
    lv->chunkW = lv->w;
    lv->chunkH = uint32_t(std::min<uint64_t>(f.uint(ifd, 278, lv->h), lv->h));
    if (!f.uints(ifd, 273, &lv->offsets) || !f.uints(ifd, 279, &lv->counts)) return im.missing() ? false : im.fail("a TIFF image has no strip offsets");
  }
  if (!lv->chunkW || !lv->chunkH) return im.fail("a TIFF image has no tile or strip size");
  lv->across = (lv->w + lv->chunkW - 1) / lv->chunkW;
  lv->down = (lv->h + lv->chunkH - 1) / lv->chunkH;
  const uint64_t chunks = uint64_t(lv->across) * lv->down * planes;
  if (lv->offsets.size() < chunks || lv->counts.size() < chunks) return im.fail("a TIFF image lists fewer tiles or strips than its size needs");
  return true;
}

// GeoKeyDirectory value for one key (inline SHORT values only), or 0.
inline uint64_t geoKey(const std::vector<uint64_t>& dir, uint64_t key) {
  if (dir.size() < 4) return 0;
  const size_t n = size_t(dir[3]);
  for (size_t i = 0; i < n && 4 + i * 4 + 3 < dir.size(); ++i) {
    const uint64_t* k = &dir[4 + i * 4];
    if (k[0] == key && k[1] == 0) return k[3];
  }
  return 0;
}

inline bool load(Image& im) {
  tiff::File& f = im.file;
  if (!f.open()) return false;
  im.spp = uint32_t(f.uint(0, 277, 1));
  std::vector<uint64_t> bits;
  if (f.uints(0, 258, &bits) && !bits.empty()) {
    for (uint64_t b : bits)
      if (b != bits[0]) return im.fail("the bands have different bit depths");
    im.bps = uint32_t(bits[0]);
  } else if (im.missing()) return false;
  im.sampleFormat = uint32_t(f.uint(0, 339, 1));
  im.photometric = uint32_t(f.uint(0, 262, im.spp >= 3 ? 2 : 1));
  im.compression = uint32_t(f.uint(0, 259, 1));
  im.planar = uint32_t(f.uint(0, 284, 1));
  im.predictor = uint32_t(f.uint(0, 317, 1));
  if (im.missing()) return false;

  const uint32_t c = im.compression;
  if (c != 1 && c != 5 && c != 7 && c != 8 && c != 32946 && c != 32773)
    return im.fail(std::string("its compression, ") + compressionName(c) + ", is not read here");
  if (im.spp < 1 || im.spp > 16) return im.fail("it has an unsupported number of bands");
  if (!(im.bps == 8 || im.bps == 16 || im.bps == 32)) return im.fail("its samples are not 8, 16 or 32 bits");
  if (im.sampleFormat == 3 && im.bps != 32) return im.fail("its floating-point samples are not 32-bit");
  if (im.sampleFormat < 1 || im.sampleFormat > 3) return im.fail("its sample format is not integer or floating point");
  if (c == 7 && im.bps != 8) return im.fail("its JPEG samples are not 8-bit");
  if (c == 7 && im.planar == 2) return im.fail("its JPEG bands are stored as separate planes");
  if (im.photometric == 6 && c != 7) return im.fail("its YCbCr samples are not JPEG-compressed");
  if (!(im.photometric <= 3 || im.photometric == 6)) return im.fail("its color space is not gray, RGB, palette or YCbCr");
  if (im.predictor == 3 && im.sampleFormat != 3) return im.fail("its floating-point predictor is on integer samples");
  if (im.predictor > 3) return im.fail("its predictor is not none, horizontal or floating point");
  if (im.photometric == 3) {
    if (!f.uints(0, 320, &im.colormap)) return im.missing() ? false : im.fail("its palette has no color map");
    if (im.colormap.size() < 3 * (size_t(1) << std::min<uint32_t>(im.bps, 16))) return im.fail("its color map is short");
  }
  if (c == 7 && f.tag(0, 347) && !f.bytes(0, 347, &im.jpegTables, &im.jpegTablesLen)) return false;
  std::vector<uint64_t> extra;
  f.uints(0, 338, &extra);
  if (im.missing()) return false;
  // Alpha: the first extra sample marked associated (1) or unassociated (2) alpha.
  const size_t base = im.spp > extra.size() ? im.spp - extra.size() : 0;
  for (size_t i = 0; i < extra.size() && im.alphaBand < 0; ++i)
    if (extra[i] == 1 || extra[i] == 2) im.alphaBand = int(base + i);

  for (size_t i = 0; i < f.ifds.size(); ++i) {
    const uint64_t kind = f.uint(i, 254, 0);
    Level lv;
    if (kind & 4) {
      if (f.uint(i, 258, 1) != 1) continue;
      if (!readLevel(im, i, &lv, true)) {
        if (im.missing()) return false;
        im.file.error.clear();
        continue;
      }
      im.maskCompression = uint32_t(f.uint(i, 259, 1));
      im.masks.push_back(std::move(lv));
    } else {
      if (i > 0 && (f.uint(i, 277, 1) != im.spp || f.uint(i, 259, 1) != im.compression)) continue;
      if (!readLevel(im, i, &lv, false)) return false;
      im.levels.push_back(std::move(lv));
    }
    if (im.missing()) return false;
  }
  for (Level& lv : im.levels)
    for (size_t m = 0; m < im.masks.size(); ++m)
      if (im.masks[m].w == lv.w && im.masks[m].h == lv.h) lv.mask = int(m);
  std::sort(im.levels.begin(), im.levels.end(), [](const Level& a, const Level& b) { return a.w > b.w; });

  // Georeferencing: GeoKeys, then the model transformation or tie point + pixel scale.
  std::vector<uint64_t> keys;
  if (!f.uints(0, 34735, &keys)) return im.missing() ? false : im.fail("it has no georeferencing (no GeoTIFF keys)");
  const uint64_t model = geoKey(keys, 1024), raster = geoKey(keys, 1025);
  const uint64_t code = model == 2 ? geoKey(keys, 2048) : geoKey(keys, 3072);
  if (code == 0 || code == 32767) return im.fail("its coordinate system is user-defined, not an EPSG code");
  im.crs = project::fromEpsg(int(code));
  if (im.crs.kind == project::Kind::Unsupported)
    return im.fail("its coordinate system, EPSG:" + std::to_string(code) + ", is not one this reader projects (EPSG:4326, 3857 or UTM)");
  std::vector<double> m, tie, scale;
  if (f.doubles(0, 34264, &m) && m.size() >= 16) {
    im.gt[0] = m[3]; im.gt[1] = m[0]; im.gt[2] = m[1];
    im.gt[3] = m[7]; im.gt[4] = m[4]; im.gt[5] = m[5];
  } else if (f.doubles(0, 33922, &tie) && f.doubles(0, 33550, &scale) && tie.size() >= 6 && scale.size() >= 2) {
    im.gt[1] = scale[0]; im.gt[2] = 0;
    im.gt[4] = 0; im.gt[5] = -scale[1];
    im.gt[0] = tie[3] - tie[0] * scale[0];
    im.gt[3] = tie[4] + tie[1] * scale[1];
  } else {
    return im.missing() ? false : im.fail("it has no georeferencing (no tie point and pixel scale)");
  }
  if (raster == 2) {  // PixelIsPoint: the tie point is a pixel centre
    im.gt[0] -= 0.5 * (im.gt[1] + im.gt[2]);
    im.gt[3] -= 0.5 * (im.gt[4] + im.gt[5]);
  }
  const double det = im.gt[1] * im.gt[5] - im.gt[2] * im.gt[4];
  if (!(std::fabs(det) > 0)) return im.fail("its georeferencing is degenerate");
  im.inv[1] = im.gt[5] / det; im.inv[2] = -im.gt[2] / det;
  im.inv[4] = -im.gt[4] / det; im.inv[5] = im.gt[1] / det;
  im.inv[0] = -(im.inv[1] * im.gt[0] + im.inv[2] * im.gt[3]);
  im.inv[3] = -(im.inv[4] * im.gt[0] + im.inv[5] * im.gt[3]);
  const uint8_t* nd = nullptr;
  size_t ndLen = 0;
  if (f.tag(0, 42113) && f.bytes(0, 42113, &nd, &ndLen) && ndLen > 0) {
    std::string text(reinterpret_cast<const char*>(nd), ndLen);
    char* end = nullptr;
    const double v = std::strtod(text.c_str(), &end);
    if (end != text.c_str()) {
      im.hasNodata = true;
      im.nodata = v;
    }
  }
  return !im.missing();
}

// ── decoded chunks ─────────────────────────────────────────────────────────
inline uint32_t chunkRows(const Level& lv, uint32_t row, bool tiled) {
  return tiled ? lv.chunkH : std::min(lv.chunkH, lv.h - row * lv.chunkH);
}

inline void swapSamples(std::vector<uint8_t>* d, uint32_t bytes) {
  if (bytes == 2) for (size_t i = 0; i + 1 < d->size(); i += 2) std::swap((*d)[i], (*d)[i + 1]);
  if (bytes == 4)
    for (size_t i = 0; i + 3 < d->size(); i += 4) {
      std::swap((*d)[i], (*d)[i + 3]);
      std::swap((*d)[i + 1], (*d)[i + 2]);
    }
}

template <typename T>
void horizontal(std::vector<uint8_t>* d, uint32_t w, uint32_t rows, uint32_t channels) {
  T* p = reinterpret_cast<T*>(d->data());
  for (uint32_t r = 0; r < rows; ++r) {
    T* row = p + size_t(r) * w * channels;
    for (uint32_t i = channels; i < w * channels; ++i) row[i] = T(row[i] + row[i - channels]);
  }
}

inline void floatingPoint(std::vector<uint8_t>* d, uint32_t samples, uint32_t rows) {
  const size_t rowBytes = size_t(samples) * 4;
  std::vector<uint8_t> tmp(rowBytes);
  for (uint32_t r = 0; r < rows; ++r) {
    uint8_t* p = d->data() + r * rowBytes;
    for (size_t i = 1; i < rowBytes; ++i) p[i] = uint8_t(p[i] + p[i - 1]);
    std::memcpy(tmp.data(), p, rowBytes);
    for (uint32_t i = 0; i < samples; ++i) {
      const uint32_t v = uint32_t(tmp[i]) << 24 | uint32_t(tmp[samples + i]) << 16 | uint32_t(tmp[2 * samples + i]) << 8 | tmp[3 * samples + i];
      std::memcpy(p + size_t(i) * 4, &v, 4);
    }
  }
}

// Decode one chunk of a level (or of its mask) to native samples. false: refused or missing.
inline bool decode(Image& im, const Level& lv, size_t index, bool mask, std::vector<uint8_t>* out) {
  const bool tiled = im.file.tag(lv.ifd, 322) != nullptr;
  const uint32_t perPlane = lv.across * lv.down;
  const uint32_t row = uint32_t((index % perPlane) / lv.across);
  const uint32_t rows = chunkRows(lv, row, tiled);
  const uint32_t channels = mask ? 1 : (im.planar == 2 ? 1 : im.spp);
  const uint32_t bits = mask ? 1 : im.bps;
  const size_t rowBytes = (size_t(lv.chunkW) * channels * bits + 7) / 8;
  const size_t expect = rowBytes * rows;
  const uint8_t* raw = im.file.src->view(lv.offsets[index], lv.counts[index]);
  if (!raw) return false;
  const size_t n = size_t(lv.counts[index]);
  const uint32_t c = mask ? im.maskCompression : im.compression;
  bool ok = false;
  switch (c) {
    case 1: ok = n >= expect; if (ok) out->assign(raw, raw + expect); break;
    case 5: ok = codecs::lzw(raw, n, expect, out); break;
    case 8: case 32946: ok = codecs::inflate(raw, n, expect, out); break;
    case 32773: ok = codecs::packbits(raw, n, expect, out); break;
    case 7: ok = codecs::jpeg(raw, n, im.jpegTables, im.jpegTablesLen, int(channels), lv.chunkW, rows, out); break;
    default: ok = false;
  }
  if (!ok) return im.fail(std::string("a ") + compressionName(c) + " tile or strip does not decode");
  if (mask || c == 7) return true;
  const uint32_t bytes = im.bps / 8;
  if (im.file.be && bytes > 1 && im.predictor != 3) swapSamples(out, bytes);
  if (im.predictor == 2) {
    if (bytes == 1) horizontal<uint8_t>(out, lv.chunkW, rows, channels);
    else if (bytes == 2) horizontal<uint16_t>(out, lv.chunkW, rows, channels);
    else horizontal<uint32_t>(out, lv.chunkW, rows, channels);
  } else if (im.predictor == 3) {
    floatingPoint(out, lv.chunkW * channels, rows);
  }
  return true;
}

}  // namespace image
