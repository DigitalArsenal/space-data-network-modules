// viewimagery: EUMETSAT's public view-service imagery (WMS GetMap PNG blocks) as the world-clouds reference producer
// reads it (DigitalArsenal/Cesium_Weather orbpro-gaussian-clouds/tools/raw_satellite.py: mtgview_fields,
// polarview_fields, imagery_cloud, sun_cosine, LatLonGrid, world_product, sample), ported formula for formula:
//   png       - 8-bit greyscale / RGB / palette / grey-alpha / RGBA PNG decoding (zlib via the caller's inflate);
//   filters   - scipy.ndimage uniform_filter / maximum_filter (modes reflect and wrap), binary_erosion, PIL's bilinear
//               resize (separable triangle filter, centre-aligned);
//   LatLon    - a regular latitude/longitude raster seen from a geostationary platform (or looking straight down: polar)
//               and its world product: the area mean of the pixels in each 4096 x 2048 cell, holes sampled at the
//               cell centre (imagerworld's rules on a lat/lon grid).
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <string>
#include <vector>
#include "imagerworld.hpp"

namespace viewimagery {

using Inflate = std::function<bool(const uint8_t*, size_t, uint8_t*, size_t)>;

// ---- PNG ----
struct Image { int w = 0, h = 0; std::vector<uint8_t> rgba; };   // 4 bytes a pixel

inline uint32_t be32(const uint8_t* p) { return uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | p[3]; }

inline bool decodePng(const uint8_t* b, size_t n, const Inflate& inflate, Image& out, std::string& err) {
  static const uint8_t sig[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
  if (n < 8 || memcmp(b, sig, 8)) { err = "not a PNG"; return false; }
  size_t at = 8; int w = 0, h = 0, depth = 0, type = -1, interlace = 0;
  std::vector<uint8_t> idat, palette, trns;
  while (at + 12 <= n) {
    const uint32_t len = be32(b + at); const uint8_t* t = b + at + 4; const uint8_t* d = b + at + 8;
    if (at + 12 + len > n) { err = "PNG chunk past the end"; return false; }
    if (!memcmp(t, "IHDR", 4)) { w = int(be32(d)); h = int(be32(d + 4)); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (!memcmp(t, "PLTE", 4)) palette.assign(d, d + len);
    else if (!memcmp(t, "tRNS", 4)) trns.assign(d, d + len);
    else if (!memcmp(t, "IDAT", 4)) idat.insert(idat.end(), d, d + len);
    else if (!memcmp(t, "IEND", 4)) break;
    at += 12 + len;
  }
  if (w <= 0 || h <= 0) { err = "PNG without IHDR"; return false; }
  if (depth != 8 || interlace) { err = "PNG bit depth " + std::to_string(depth) + (interlace ? " interlaced" : "") + " unsupported"; return false; }
  const int channels = type == 0 ? 1 : type == 2 ? 3 : type == 3 ? 1 : type == 4 ? 2 : type == 6 ? 4 : 0;
  if (!channels) { err = "PNG colour type " + std::to_string(type) + " unsupported"; return false; }
  const size_t stride = size_t(w) * channels;
  std::vector<uint8_t> raw((stride + 1) * size_t(h));
  if (!inflate(idat.data(), idat.size(), raw.data(), raw.size())) { err = "PNG image data does not inflate"; return false; }
  std::vector<uint8_t> prev(stride, 0), cur(stride);
  out.w = w; out.h = h; out.rgba.assign(size_t(w) * h * 4, 0);
  for (int y = 0; y < h; y++) {
    const uint8_t f = raw[size_t(y) * (stride + 1)]; const uint8_t* s = &raw[size_t(y) * (stride + 1) + 1];
    for (size_t i = 0; i < stride; i++) {
      const int a = i >= size_t(channels) ? cur[i - channels] : 0, up = prev[i], c = i >= size_t(channels) ? prev[i - channels] : 0;
      int v = s[i];
      switch (f) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += up; break;
        case 3: v += (a + up) / 2; break;
        case 4: { const int p = a + up - c, pa = std::abs(p - a), pb = std::abs(p - up), pc = std::abs(p - c); v += (pa <= pb && pa <= pc) ? a : pb <= pc ? up : c; break; }
        default: err = "PNG filter " + std::to_string(f); return false;
      }
      cur[i] = uint8_t(v);
    }
    uint8_t* o = &out.rgba[size_t(y) * w * 4];
    for (int x = 0; x < w; x++) {
      uint8_t r, g, bl, al = 255;
      if (type == 0) { r = g = bl = cur[x]; if (trns.size() >= 2 && cur[x] == trns[1]) al = 0; }
      else if (type == 2) { r = cur[3 * x]; g = cur[3 * x + 1]; bl = cur[3 * x + 2]; }
      else if (type == 3) {
        const size_t k = cur[x];
        if (3 * k + 2 >= palette.size()) { err = "PNG palette index past the palette"; return false; }
        r = palette[3 * k]; g = palette[3 * k + 1]; bl = palette[3 * k + 2]; if (k < trns.size()) al = trns[k];
      } else if (type == 4) { r = g = bl = cur[2 * x]; al = cur[2 * x + 1]; }
      else { r = cur[4 * x]; g = cur[4 * x + 1]; bl = cur[4 * x + 2]; al = cur[4 * x + 3]; }
      o[4 * x] = r; o[4 * x + 1] = g; o[4 * x + 2] = bl; o[4 * x + 3] = al;
    }
    prev.swap(cur);
  }
  return true;
}

// ---- scipy.ndimage filters on a row-major float32 image (h x w), one axis at a time ----
// mode reflect: (d c b a | a b c d | d c b a); wrap: (a b c d | a b c d)
inline int64_t extend(int64_t i, int64_t n, bool wrap) {
  if (wrap) { i %= n; return i < 0 ? i + n : i; }
  const int64_t period = 2 * n;
  i %= period; if (i < 0) i += period;
  return i < n ? i : period - 1 - i;
}
inline void filter1d(std::vector<float>& a, int h, int w, int axis, int size, bool wrap, bool maximum) {
  const int half = size / 2;
  const int64_t len = axis == 0 ? h : w, lines = axis == 0 ? w : h;
  std::vector<double> line(static_cast<size_t>(len)), out(static_cast<size_t>(len));
  for (int64_t l = 0; l < lines; l++) {
    for (int64_t i = 0; i < len; i++) line[size_t(i)] = a[size_t(axis == 0 ? i * w + l : l * w + i)];
    for (int64_t i = 0; i < len; i++) {
      double acc = maximum ? -INFINITY : 0;
      for (int k = -half; k < size - half; k++) {
        const double v = line[size_t(extend(i + k, len, wrap))];
        if (maximum) { if (v > acc) acc = v; } else acc += v;
      }
      out[size_t(i)] = maximum ? acc : acc / size;
    }
    for (int64_t i = 0; i < len; i++) a[size_t(axis == 0 ? i * w + l : l * w + i)] = float(out[size_t(i)]);
  }
}
// uniform_filter / maximum_filter over both axes (mode per axis: rows reflect, columns reflect or wrap)
inline void uniform(std::vector<float>& a, int h, int w, int size, bool wrapColumns) { filter1d(a, h, w, 0, size, false, false); filter1d(a, h, w, 1, size, wrapColumns, false); }
inline void maximum(std::vector<float>& a, int h, int w, int size, bool wrapColumns) { filter1d(a, h, w, 0, size, false, true); filter1d(a, h, w, 1, size, wrapColumns, true); }

// binary_erosion(mask, iterations, border_value=1) with the cross structuring element
inline void erode(std::vector<uint8_t>& m, int h, int w, int iterations) {
  std::vector<uint8_t> o(m.size());
  for (int it = 0; it < iterations; it++) {
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      auto at = [&](int yy, int xx) -> uint8_t { return (yy < 0 || yy >= h || xx < 0 || xx >= w) ? 1 : m[size_t(yy) * w + xx]; };
      o[size_t(y) * w + x] = at(y, x) && at(y - 1, x) && at(y + 1, x) && at(y, x - 1) && at(y, x + 1);
    }
    m.swap(o);
  }
}

// PIL Image.resize((W, H), BILINEAR) of a float image ('F'): separable triangle filter (support 1 when enlarging,
// scaled when shrinking), centre-aligned, weights normalised over the taps inside the image.
struct Taps { std::vector<int> first; std::vector<std::vector<double>> w; };
inline Taps taps(int in, int out) {
  Taps t; t.first.resize(size_t(out)); t.w.resize(size_t(out));
  const double scale = double(in) / out, support = scale > 1 ? scale : 1.0;
  for (int o = 0; o < out; o++) {
    const double centre = (o + 0.5) * scale;
    int lo = int(std::floor(centre - support)), hi = int(std::ceil(centre + support));
    if (lo < 0) lo = 0; if (hi > in) hi = in;
    double sum = 0; std::vector<double> ws;
    for (int j = lo; j < hi; j++) { double x = (j + 0.5 - centre) / support; double v = 1 - std::fabs(x); if (v < 0) v = 0; ws.push_back(v); sum += v; }
    for (double& v : ws) v = sum ? v / sum : 0;
    t.first[size_t(o)] = lo; t.w[size_t(o)] = ws;
  }
  return t;
}
inline std::vector<float> resize(const std::vector<float>& a, int h, int w, int H, int W) {
  const Taps tx = taps(w, W), ty = taps(h, H);
  std::vector<float> mid(size_t(h) * W), out(size_t(H) * W);
  for (int y = 0; y < h; y++) for (int x = 0; x < W; x++) {
    double s = 0; const auto& ws = tx.w[size_t(x)]; const int f = tx.first[size_t(x)];
    for (size_t k = 0; k < ws.size(); k++) s += ws[k] * a[size_t(y) * w + size_t(f) + k];
    mid[size_t(y) * W + x] = float(s);
  }
  for (int y = 0; y < H; y++) { const auto& ws = ty.w[size_t(y)]; const int f = ty.first[size_t(y)];
    for (int x = 0; x < W; x++) { double s = 0; for (size_t k = 0; k < ws.size(); k++) s += ws[k] * mid[(size_t(f) + k) * W + x]; out[size_t(y) * W + x] = float(s); } }
  return out;
}

// cosine of the solar zenith at a ground point (raw_satellite.py sun_cosine): degrees in; the date's declination and the
// sun's longitude worked out once
struct Sun {
  double decl = 0, solarLon = 0;
  explicit Sun(int64_t ms) {
    const double pi = imagerworld::PI;
    const int64_t days = ms / 86400000; int64_t z = days + 719468; const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const int64_t doe = z - era * 146097, yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t doyMar = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doyMar + 2) / 153, m = mp < 10 ? mp + 3 : mp - 9;
    int64_t y = yoe + era * 400; if (m <= 2) y++;
    auto dfc = [](int64_t yy, int mm, int dd) { yy -= mm <= 2; const int64_t e = (yy >= 0 ? yy : yy - 399) / 400; const int64_t yoe2 = yy - e * 400;
      const int64_t doy = (153 * (mm + (mm > 2 ? -3 : 9)) + 2) / 5 + dd - 1; return e * 146097 + yoe2 * 365 + yoe2 / 4 - yoe2 / 100 + doy - 719468; };
    const int64_t yday = days - dfc(y, 1, 1) + 1;   // (1-based)
    const double secs = double(ms % 86400000) / 1000.0;
    decl = 23.44 * pi / 180 * std::sin(2 * pi * double(yday - 81) / 365.2425);
    solarLon = (180 - secs / 3600.0 * 15) * pi / 180;
  }
  double at(double lat, double lon) const {
    const double pi = imagerworld::PI, la = lat * pi / 180, lo = lon * pi / 180;
    return std::sin(la) * std::sin(decl) + std::cos(la) * std::cos(decl) * std::cos(lo - solarLon);
  }
};

// ---- a regular lat/lon raster and its world product ----
struct LatLon {
  int nx = 0, ny = 0;
  double x0 = 0, dx = 0, y0 = 0, dy = 0;   // the first pixel centre and steps (dy < 0: rows north to south)
  bool polar = false;
  imagerworld::FixedGrid view;             // the geostationary platform (zenith); unused when polar
  std::vector<uint8_t> ok;                 // per pixel: zenith under the limit (worked out once: precompute())
  double lon(int c) const { return x0 + c * dx; }
  double lat(int r) const { return y0 + r * dy; }
  double zenith(double la, double lo) const { if (polar) return 0; double sx, sy, z; view.scanAngles(la, lo, sx, sy, z); return z; }
  void precompute() {
    ok.assign(size_t(nx) * ny, 1);
    if (polar) return;
    for (int r = 0; r < ny; r++) for (int c = 0; c < nx; c++) ok[size_t(r) * nx + c] = zenith(lat(r), lon(c)) < imagerworld::MAX_ZENITH_DEG;
  }
};

template <class F>
inline float sampleLL(const LatLon& g, const F& value, double la, double lo, bool categorical) {
  using namespace imagerworld;
  if (!(g.zenith(la, lo) < MAX_ZENITH_DEG)) return nanf();
  const double px = g.polar ? pymod(lo - g.x0, 360) / g.dx : (lo - g.x0) / g.dx, py = (la - g.y0) / g.dy;
  const int w = g.nx, h = g.ny;
  if (!(std::isfinite(px) && std::isfinite(py) && px > -.5 && py > -.5 && px < w - .5 && py < h - .5)) return nanf();
  auto clampi = [](double v, int64_t lo2, int64_t hi) { int64_t i = int64_t(v); return i < lo2 ? lo2 : i > hi ? hi : i; };
  const int64_t nxi = clampi(std::nearbyint(px), 0, w - 1), nyi = clampi(std::nearbyint(py), 0, h - 1);
  const float nearest = value(int(nyi), int(nxi));
  if (categorical) return nearest;
  const int64_t xa = clampi(std::floor(px), 0, w - 2), ya = clampi(std::floor(py), 0, h - 2);
  double fx = px - double(xa), fy = py - double(ya);
  fx = fx < 0 ? 0 : fx > 1 ? 1 : fx; fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
  const float a = value(int(ya), int(xa)), b = value(int(ya), int(xa + 1)), c = value(int(ya + 1), int(xa)), d = value(int(ya + 1), int(xa + 1));
  const double bil = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  return std::isfinite(bil) ? float(bil) : nearest;
}

// The world product of a lat/lon field: value(row, col) -> float (NaN missing).
template <class F>
inline imagerworld::World worldProduct(const LatLon& g, const F& value, bool categorical, bool worldMean) {
  using namespace imagerworld;
  const double d = 360.0 / WORLD_W;
  const size_t cells = size_t(WORLD_W) * WORLD_H;
  std::vector<double> total(cells, 0.0);
  std::vector<uint32_t> count(cells, 0);
  std::vector<uint8_t> seen(cells, 0);
  std::vector<uint8_t> okCol(size_t(g.nx));
  for (int r = 0; r < g.ny; r++) {
    const double la = g.lat(r);
    int64_t row = int64_t((90 - la) / d); row = row < 0 ? 0 : row > WORLD_H - 1 ? WORLD_H - 1 : row;
    for (int c = 0; c < g.nx; c++) {
      const double lo = g.lon(c);
      if (g.ok.empty() ? !(g.zenith(la, lo) < MAX_ZENITH_DEG) : !g.ok[size_t(r) * g.nx + c]) continue;
      int64_t col = int64_t((lo + 180) / d); col = col < 0 ? 0 : col > WORLD_W - 1 ? WORLD_W - 1 : col;
      const size_t cell = size_t(row) * WORLD_W + size_t(col);
      seen[cell] = 1;
      const float v = value(r, c);
      if (std::isfinite(v)) { total[cell] += double(v); count[cell]++; }
    }
  }
  World o;
  int first = -1, last = -1;
  for (int r = 0; r < WORLD_H; r++) { const uint8_t* s = &seen[size_t(r) * WORLD_W]; for (int c = 0; c < WORLD_W; c++) if (s[c]) { if (first < 0) first = r; last = r; break; } }
  if (first < 0) return o;
  o.r0 = first / WORLD_ROWS * WORLD_ROWS; o.r1 = (last / WORLD_ROWS + 1) * WORLD_ROWS;
  o.values.assign(size_t(o.r1 - o.r0) * WORLD_W, nanf());
  const bool cat = categorical && !worldMean;
  for (int r = o.r0; r < o.r1; r++) {
    const double la = 90 - (r + .5) * d;
    for (int c = 0; c < WORLD_W; c++) {
      const double lo = -180 + (c + .5) * d;
      const size_t cell = size_t(r) * WORLD_W + c;
      float v;
      if (cat) v = sampleLL(g, value, la, lo, true);
      else if (seen[cell]) v = count[cell] ? float(total[cell] / double(count[cell])) : nanf();
      else v = sampleLL(g, value, la, lo, categorical);
      o.values[size_t(r - o.r0) * WORLD_W + c] = v;
    }
  }
  return o;
}

}  // namespace viewimagery
