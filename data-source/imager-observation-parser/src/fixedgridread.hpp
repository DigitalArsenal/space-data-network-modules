// Vendored from DigitalArsenal/Cesium_Weather orbpro-gaussian-clouds/native/imagerworld/fixedgridread.hpp (commit 6c672cc); checked there against h5py and the
// reference producer (tools/raw_satellite.py). Edit there and re-vendor.
// fixedgridread: a geostationary imager's fixed-grid variable (a GOES ABI L1b/L2 NetCDF4 file) read through hdf5mini
// into an imagerworld::Field - the values as netCDF4's set_auto_maskandscale gives them (_Unsigned, _FillValue,
// valid_range, scale_factor, add_offset; float32), chunk by chunk, so a 0.5 km band (21696 x 21696) is reduced to its
// 2 km block means without ever holding the full-resolution array. Formulas as the reference producer
// (raw_satellite.py read_nc_var, block_mean), including numpy's float64 block-sum order.
#pragma once
#include "hdf5mini.hpp"
#include "imagerworld.hpp"
#include <string>

namespace imagerworld {

struct Scaling {
  size_t es = 0; bool isFloat = false, unsignedInt = false;
  bool hasFill = false, hasRange = false, hasScale = false, hasOffset = false;
  double fill = 0, lo = 0, hi = 0; float scale = 1, offset = 0;
};

inline Scaling scalingOf(const hdf5mini::Dataset& d) {
  Scaling s; s.es = d.type.size; s.isFloat = d.type.cls == 1;
  s.unsignedInt = !s.isFloat && (!d.type.isSigned || hdf5mini::File::attrString(d, "_Unsigned") == "true");
  auto wrapU = [&](double v) { return (!s.unsignedInt || v >= 0 || s.es >= 8) ? v : v + double(uint64_t(1) << (8 * s.es)); };   // a signed fill read as unsigned
  s.fill = wrapU(hdf5mini::File::attrNumber(d, "_FillValue", 0, &s.hasFill));
  const std::vector<double> range = hdf5mini::File::attrNumbers(d, "valid_range");
  if (range.size() == 2) { s.hasRange = true; s.lo = wrapU(range[0]); s.hi = wrapU(range[1]); }
  s.scale = float(hdf5mini::File::attrNumber(d, "scale_factor", 1, &s.hasScale));
  s.offset = float(hdf5mini::File::attrNumber(d, "add_offset", 0, &s.hasOffset));
  return s;
}

// one element (little-endian) as netCDF4 gives it: NaN where masked
inline float scaled(const Scaling& s, const uint8_t* e) {
  double v;
  if (s.isFloat) { if (s.es == 4) { float f; memcpy(&f, e, 4); v = f; } else memcpy(&v, e, 8); }
  else {
    uint64_t u = 0; memcpy(&u, e, s.es);
    if (!s.unsignedInt && s.es < 8 && (u >> (8 * s.es - 1)) & 1) u |= ~uint64_t(0) << (8 * s.es);
    v = s.unsignedInt ? double(u) : double(int64_t(u));
  }
  if ((s.hasFill && v == s.fill) || (s.hasRange && (v < s.lo || v > s.hi))) return nanf();
  float f = float(v);
  if (s.hasScale) f = f * s.scale;
  if (s.hasOffset) f = f + s.offset;
  return f;
}

// A 1-D coordinate variable (x / y scan angles), float32 as netCDF4 scales it, then float64 as the reference takes it.
inline bool readAxis(hdf5mini::File& h, const hdf5mini::Inflate& inflate, const std::string& path, std::vector<double>& out, std::string& err) {
  const hdf5mini::Dataset* d = h.find(path); if (!d || d->dims.size() != 1) { err = "no 1-D " + path; return false; }
  std::vector<uint8_t> raw; if (!h.read(*d, inflate, raw)) { err = h.error(); return false; }
  const Scaling s = scalingOf(*d); out.resize(size_t(d->dims[0]));
  for (size_t i = 0; i < out.size(); i++) out[i] = double(scaled(s, raw.data() + i * s.es));
  return true;
}

// The fixed grid's projection (CF grid_mapping "geostationary") from the goes_imager_projection variable's attributes.
inline bool readProjection(hdf5mini::File& h, FixedGrid& g, std::string& err) {
  const hdf5mini::Dataset* p = h.find("/goes_imager_projection"); if (!p) { err = "no goes_imager_projection"; return false; }
  bool ok = false;
  g.lon0 = hdf5mini::File::attrNumber(*p, "longitude_of_projection_origin", 0, &ok); if (!ok) { err = "no longitude_of_projection_origin"; return false; }
  g.req = hdf5mini::File::attrNumber(*p, "semi_major_axis", 6378137.0);
  g.rpol = hdf5mini::File::attrNumber(*p, "semi_minor_axis", 6356752.31414);
  g.H = hdf5mini::File::attrNumber(*p, "perspective_point_height", 0, &ok) + g.req; if (!ok) { err = "no perspective_point_height"; return false; }
  g.sweepX = hdf5mini::File::attrString(*p, "sweep_angle_axis") != "y";
  return true;
}

// A 2-D fixed-grid variable into a Field: block means of k x k pixels (k = 1: as read), each value first divided by
// `divisor` (rain rate: mm h-1 -> kg m-2 s-1 is 3600; 1 = none).
inline bool readField(hdf5mini::File& h, const hdf5mini::Inflate& inflate, const std::string& var, int k, float divisor, Field& out, std::string& err) {
  const hdf5mini::Dataset* d = h.find("/" + var);
  if (!d || d->dims.size() != 2) { err = "no 2-D variable " + var; return false; }
  const Scaling s = scalingOf(*d);
  const int64_t H = int64_t(d->dims[0]), W = int64_t(d->dims[1]);
  std::vector<double> xs, ys;
  if (!readAxis(h, inflate, "/x", xs, err) || !readAxis(h, inflate, "/y", ys, err)) return false;
  if (int64_t(xs.size()) != W || int64_t(ys.size()) != H) { err = "x/y do not match " + var; return false; }
  if (!readProjection(h, out.grid, err)) return false;
  out.w = int(W / k); out.h = int(H / k);
  out.data.assign(size_t(out.w) * size_t(out.h), nanf());
  out.grid.x.assign(size_t(out.w), 0); out.grid.y.assign(size_t(out.h), 0);
  for (int c = 0; c < out.w; c++) { double t = 0; for (int j = 0; j < k; j++) t += xs[size_t(c) * k + j]; out.grid.x[size_t(c)] = k == 1 ? xs[size_t(c)] : t / k; }
  for (int r = 0; r < out.h; r++) { double t = 0; for (int i = 0; i < k; i++) t += ys[size_t(r) * k + i]; out.grid.y[size_t(r)] = k == 1 ? ys[size_t(r)] : t / k; }
  // a band of whole rows (the chunks of one chunk-row), then each row in turn into the output / block sums
  std::vector<float> band; int64_t bandRow = -1, bandRows = 0;
  std::vector<double> total(size_t(out.w), 0.0); std::vector<int> count(size_t(out.w), 0);
  auto takeRow = [&](int64_t r, const float* v) {
    if (r >= int64_t(out.h) * k) return;                      // (rows past the last whole block: dropped, as the reference)
    if (k == 1) { memcpy(&out.data[size_t(r) * size_t(out.w)], v, size_t(out.w) * 4); return; }
    const int i = int(r % k);
    for (int c = 0; c < out.w; c++) {
      // float64, numpy's order for .sum(axis=(1, 3)): the block's row left to right, then the rows in turn
      // (a missing pixel adds 0, as np.where(valid, blocks, 0) has it)
      double row = 0; int n = 0;
      for (int j = 0; j < k; j++) { const float x = v[size_t(c) * k + j]; if (std::isfinite(x)) { row += double(x); n++; } }
      total[size_t(c)] = i ? total[size_t(c)] + row : row; count[size_t(c)] = (i ? count[size_t(c)] : 0) + n;
    }
    if (i == k - 1) {
      float* o = &out.data[size_t(r / k) * size_t(out.w)];
      for (int c = 0; c < out.w; c++) o[c] = count[size_t(c)] ? float(total[size_t(c)] / double(count[size_t(c)])) : nanf();
    }
  };
  auto flush = [&]() { for (int64_t i = 0; i < bandRows; i++) takeRow(bandRow + i, &band[size_t(i) * size_t(W)]); bandRow = -1; bandRows = 0; };
  const bool ok = h.forEachChunk(*d, inflate, [&](const std::vector<uint64_t>& off, const std::vector<uint64_t>& dims, const uint8_t* data) {
    const int64_t r0 = int64_t(off[0]), c0 = int64_t(off[1]), cr = int64_t(dims[0]), cc = int64_t(dims[1]);
    if (r0 != bandRow) {
      flush();
      bandRow = r0; bandRows = std::min<int64_t>(cr, H - r0);
      band.assign(size_t(bandRows) * size_t(W), nanf());
    }
    const int64_t ncols = std::min<int64_t>(cc, W - c0);
    for (int64_t i = 0; i < bandRows; i++)
      for (int64_t j = 0; j < ncols; j++) {
        float v = scaled(s, data + size_t(i * cc + j) * s.es);
        if (divisor != 1.0f) v = v / divisor;
        band[size_t(i) * size_t(W) + size_t(c0 + j)] = v;
      }
    return true;
  });
  if (!ok) { err = h.error(); return false; }
  flush();
  return true;
}

}  // namespace imagerworld
