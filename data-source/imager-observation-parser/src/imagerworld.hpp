// Vendored from DigitalArsenal/Cesium_Weather orbpro-gaussian-clouds/native/imagerworld/imagerworld.hpp (commit 5e8df5f); checked there against h5py and the
// reference producer (tools/raw_satellite.py). Edit there and re-vendor.
// imagerworld: a geostationary imager's field, on its fixed grid, as the world-clouds archive publishes it - the area
// mean of the native pixels in each cell of a 4096 x 2048 latitude/longitude grid (cells no pixel centre falls into, at
// the limb, take the field sampled at the cell centre), at 4096, 2048 and 1024 wide, quantized at the field's step and
// coded as $WXF InlineEncodedChunk / InlineQuantizedUint16 / InlineQuantizedUint8.
//
// A port of the reference producer (Cesium_Weather orbpro-gaussian-clouds/tools/raw_satellite.py: FixedGrid, sample,
// block_mean, world_product, world_level, quantize, encode_chunk), formula for formula, for the world-clouds retriever
// module (spacedatanetwork-stack modules-imager-observation-retriever-20261007). No allocation beyond std::vector.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

namespace imagerworld {

constexpr int WORLD_W = 4096, WORLD_H = 2048, WORLD_ROWS = 64;
constexpr double MAX_ZENITH_DEG = 82.0;
constexpr double PI = 3.14159265358979323846;
inline double rad(double d) { return d * (PI / 180.0); }
inline double deg(double r) { return r * (180.0 / PI); }
inline float nanf() { return std::numeric_limits<float>::quiet_NaN(); }
// Python's a % b for floats (the result takes the sign of b)
inline double pymod(double a, double b) { double m = std::fmod(a, b); if (m != 0 && ((m < 0) != (b < 0))) m += b; return m; }

// The imager's fixed grid: scan angles (radians) of the pixel centres; ABI sweeps x, AHI sweeps y.
struct FixedGrid {
  std::vector<double> x, y;
  double lon0 = 0, H = 0, req = 6378137.0, rpol = 6356752.31414;
  bool sweepX = true;

  // geodetic latitude/longitude of a scan-angle pair; false where the line of sight misses the Earth
  bool latLon(double sx, double sy, double& lat, double& lon) const {
    const double cx = std::cos(sx), sx_ = std::sin(sx), cy = std::cos(sy), sy_ = std::sin(sy);
    double dx, dy, dz;
    if (sweepX) { dx = cx * cy; dy = sx_; dz = cx * sy_; } else { dx = cx * cy; dy = sx_ * cy; dz = sy_; }
    const double k = req * req / (rpol * rpol);
    const double a = dx * dx + dy * dy + dz * dz * k, b = -2 * H * dx, c = H * H - req * req;
    const double disc = b * b - 4 * a * c;
    if (!(disc >= 0)) return false;
    const double t = (-b - std::sqrt(disc)) / (2 * a);
    const double vx = H - t * dx, vy = t * dy, vz = t * dz;
    lat = deg(std::atan(k * vz / std::hypot(vx, vy)));
    lon = pymod((lon0 + deg(std::atan2(vy, vx))) + 180, 360) - 180;
    return true;
  }

  // scan angles of a ground point and the local zenith angle of the platform there (degrees)
  void scanAngles(double lat, double lon, double& sx, double& sy, double& zen) const {
    const double e2 = 1 - rpol * rpol / (req * req);
    const double phi = std::atan(rpol * rpol / (req * req) * std::tan(rad(lat)));
    const double rc = rpol / std::sqrt(1 - e2 * std::cos(phi) * std::cos(phi));
    const double d = rad(pymod(lon - lon0 + 180, 360) - 180);
    const double vx = rc * std::cos(phi) * std::cos(d), vy = rc * std::cos(phi) * std::sin(d), vz = rc * std::sin(phi);
    const double tmp = H - vx;
    if (sweepX) { sx = std::atan(vy / std::hypot(vz, tmp)); sy = std::atan(vz / tmp); }
    else { sx = std::atan(vy / tmp); sy = std::atan(vz / std::hypot(vy, tmp)); }
    const double gx = vx, gy = vy, gz = vz, ux = H - gx, uy = -gy, uz = -gz;
    const double nx = std::cos(rad(lat)) * std::cos(d), ny = std::cos(rad(lat)) * std::sin(d), nz = std::sin(rad(lat));
    double cosz = (ux * nx + uy * ny + uz * nz) / std::sqrt(ux * ux + uy * uy + uz * uz);
    cosz = cosz < -1 ? -1 : cosz > 1 ? 1 : cosz;
    zen = deg(std::acos(cosz));
  }

  void pixel(double sx, double sy, double& px, double& py) const { px = (sx - x[0]) / (x[1] - x[0]); py = (sy - y[0]) / (y[1] - y[0]); }
};

// A field on its fixed grid: h rows of w float values (NaN missing).
struct Field {
  int w = 0, h = 0;
  std::vector<float> data;
  FixedGrid grid;
  float at(int64_t r, int64_t c) const { return data[size_t(r) * size_t(w) + size_t(c)]; }
};

// The field at a ground point: bilinear between the four pixels round it (a missing neighbour: the nearest pixel), or the
// nearest pixel for a categorical field; NaN beyond the zenith limit or off the grid.
inline float sample(const Field& f, double lat, double lon, bool categorical) {
  double sx, sy, zen, px, py;
  f.grid.scanAngles(lat, lon, sx, sy, zen);
  f.grid.pixel(sx, sy, px, py);
  const int w = f.w, h = f.h;
  const bool ok = zen < MAX_ZENITH_DEG && std::isfinite(px) && std::isfinite(py) && px > -.5 && py > -.5 && px < w - .5 && py < h - .5;
  if (!ok) return nanf();
  auto clampi = [](double v, int64_t lo, int64_t hi) { int64_t i = int64_t(v); return i < lo ? lo : i > hi ? hi : i; };
  const int64_t nx = clampi(std::nearbyint(px), 0, w - 1), ny = clampi(std::nearbyint(py), 0, h - 1);
  const float nearest = f.at(ny, nx);
  if (categorical) return nearest;
  const int64_t x0 = clampi(std::floor(px), 0, w - 2), y0 = clampi(std::floor(py), 0, h - 2);
  double fx = px - double(x0), fy = py - double(y0);
  fx = fx < 0 ? 0 : fx > 1 ? 1 : fx; fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
  const float a = f.at(y0, x0), b = f.at(y0, x0 + 1), c = f.at(y0 + 1, x0), d = f.at(y0 + 1, x0 + 1);
  // (float32 data times float64 weights: float64, as numpy promotes)
  const double bil = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  return std::isfinite(bil) ? float(bil) : nearest;
}

// Mean of k x k source pixels (missing skipped) on the matching coarser fixed grid: 0.5 km -> 2 km.
inline Field blockMean(const Field& f, int k) {
  Field o; o.w = f.w / k; o.h = f.h / k; o.data.assign(size_t(o.w) * o.h, nanf());
  for (int r = 0; r < o.h; r++)
    for (int c = 0; c < o.w; c++) {
      double total = 0; int count = 0;
      for (int i = 0; i < k; i++) for (int j = 0; j < k; j++) { float v = f.at(r * k + i, c * k + j); if (std::isfinite(v)) { total += v; count++; } }
      if (count) o.data[size_t(r) * o.w + c] = float(total / count);
    }
  o.grid = f.grid; o.grid.x.assign(o.w, 0); o.grid.y.assign(o.h, 0);
  for (int c = 0; c < o.w; c++) { double s = 0; for (int j = 0; j < k; j++) s += f.grid.x[size_t(c) * k + j]; o.grid.x[c] = s / k; }
  for (int r = 0; r < o.h; r++) { double s = 0; for (int i = 0; i < k; i++) s += f.grid.y[size_t(r) * k + i]; o.grid.y[r] = s / k; }
  return o;
}

// The world product of one field at 4096 x 2048: rows r0..r1 (64-row bands covering every cell the disc reaches).
struct World { int r0 = 0, r1 = 0; std::vector<float> values; };   // (r1 - r0) x WORLD_W

// categorical: the field's categories (cloud phase: the pixel nearest each cell centre); worldMean: a categorical field
// published as the mean of its categories (cloud mask).
inline World worldProduct(const Field& f, bool categorical, bool worldMean) {
  const double d = 360.0 / WORLD_W;
  const size_t cells = size_t(WORLD_W) * WORLD_H;
  std::vector<double> total(cells, 0.0);
  std::vector<uint32_t> count(cells, 0);
  std::vector<uint8_t> seen(cells, 0);
  for (int r = 0; r < f.h; r++)
    for (int c = 0; c < f.w; c++) {
      double lat, lon, sx, sy, zen;
      bool finite = f.grid.latLon(f.grid.x[c], f.grid.y[r], lat, lon);
      // (the reference takes the zenith at nan_to_num(lat/lon): 0, 0 where the sight misses)
      f.grid.scanAngles(finite ? lat : 0.0, finite ? lon : 0.0, sx, sy, zen);
      if (!(finite && zen < MAX_ZENITH_DEG)) continue;
      int64_t col = int64_t((lon + 180) / d), row = int64_t((90 - lat) / d);
      col = col < 0 ? 0 : col > WORLD_W - 1 ? WORLD_W - 1 : col;
      row = row < 0 ? 0 : row > WORLD_H - 1 ? WORLD_H - 1 : row;
      const size_t cell = size_t(row) * WORLD_W + size_t(col);
      seen[cell] = 1;
      const float v = f.at(r, c);
      if (std::isfinite(v)) { total[cell] += double(v); count[cell]++; }
    }
  World o;
  int first = -1, last = -1;
  for (int r = 0; r < WORLD_H; r++) { const uint8_t* s = &seen[size_t(r) * WORLD_W]; for (int c = 0; c < WORLD_W; c++) if (s[c]) { if (first < 0) first = r; last = r; break; } }
  if (first < 0) return o;
  o.r0 = first / WORLD_ROWS * WORLD_ROWS; o.r1 = (last / WORLD_ROWS + 1) * WORLD_ROWS;
  o.values.assign(size_t(o.r1 - o.r0) * WORLD_W, nanf());
  const bool cat = categorical && !worldMean;
  for (int r = o.r0; r < o.r1; r++) {
    const double lat = 90 - (r + .5) * d;
    for (int c = 0; c < WORLD_W; c++) {
      const double lon = -180 + (c + .5) * d;
      const size_t cell = size_t(r) * WORLD_W + c;
      float v;
      if (cat) v = sample(f, lat, lon, true);
      else if (seen[cell]) v = count[cell] ? float(total[cell] / double(count[cell])) : nanf();
      else v = sample(f, lat, lon, categorical);
      o.values[size_t(r - o.r0) * WORLD_W + c] = v;
    }
  }
  return o;
}

// A block of world rows at 1/factor the width: the area mean of each factor x factor block's valid cells (missing where
// none is), or a categorical field's cell at the block's centre.
inline std::vector<float> worldLevel(const std::vector<float>& values, int rows, int factor, bool categorical) {
  if (factor == 1) return values;
  const int w = WORLD_W / factor, h = rows / factor;
  std::vector<float> out(size_t(w) * h, nanf());
  for (int r = 0; r < h; r++)
    for (int c = 0; c < w; c++) {
      if (categorical) { out[size_t(r) * w + c] = values[size_t(r * factor + factor / 2) * WORLD_W + size_t(c * factor + factor / 2)]; continue; }
      // float32 sums in numpy's order for .sum(axis=(1, 3)): each of the block's rows left to right, then the row sums in
      // turn (missing cells add 0); the quotient float64, as float32 / int64 is
      float total = 0; int n = 0;
      for (int i = 0; i < factor; i++) {
        float row = 0;
        for (int j = 0; j < factor; j++) { float v = values[size_t(r * factor + i) * WORLD_W + size_t(c * factor + j)]; if (std::isfinite(v)) { row += v; n++; } }
        total = i ? total + row : row;
      }
      if (n) out[size_t(r) * w + c] = float(double(total) / double(n));
    }
  return out;
}

// ---- quantization and the InlineEncodedChunk codecs ----
struct Spec { bool u16 = true; double scale = 1, offset = 0; bool codecs = false; };

// codes at the field's step (the all-ones code: missing); returns the missing count
inline size_t quantize(const float* values, size_t n, const Spec& s, std::vector<uint16_t>& codes) {
  const uint32_t top = s.u16 ? 65534 : 254; size_t missing = 0;
  codes.resize(n);
  for (size_t i = 0; i < n; i++) {
    // (float32 values less a Python float, over one: float32 arithmetic, as numpy 2 keeps the array's type)
    const float q = std::nearbyint((values[i] - float(s.offset)) / float(s.scale));
    if (!std::isfinite(q)) { codes[i] = uint16_t(top + 1); missing++; continue; }
    codes[i] = uint16_t(q < 0 ? 0 : q > float(top) ? top : uint32_t(q));
  }
  return missing;
}

// CHUNK_CODECS ["delta", "zigzag", "shuffle"] over the codes as uint16 or uint8 elements
inline std::vector<uint8_t> encodeChunk(const std::vector<uint16_t>& codes, bool u16) {
  const size_t n = codes.size(); std::vector<uint8_t> out(u16 ? n * 2 : n);
  uint16_t prev = 0;
  for (size_t i = 0; i < n; i++) {
    uint16_t dlt = uint16_t(i ? codes[i] - prev : codes[i]); prev = codes[i];
    uint16_t z;
    if (u16) { int16_t s = int16_t(dlt); z = uint16_t(s >= 0 ? 2 * int32_t(s) : -2 * int32_t(s) - 1); out[i] = uint8_t(z & 0xff); out[n + i] = uint8_t(z >> 8); }
    else { int8_t s = int8_t(uint8_t(dlt)); z = uint8_t(s >= 0 ? 2 * int32_t(s) : -2 * int32_t(s) - 1); out[i] = uint8_t(z); }
  }
  return out;
}

}  // namespace imagerworld
