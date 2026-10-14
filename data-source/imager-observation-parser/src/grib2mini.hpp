// Vendored from DigitalArsenal/Cesium_Weather orbpro-gaussian-clouds/native/grib2mini/grib2mini.hpp (commit e8fcb6e); checked there against ecCodes
// (compare_eccodes.py). Edit there and re-vendor.
// grib2mini: the part of GRIB2 (WMO FM 92 edition 2) that NOAA's GFS / GEFS products use, read from bytes in memory -
// no library. For the world-clouds model-field retriever module (spacedatanetwork-stack modules-nwp-field-retriever-
// 20261007): each message's identification, regular lat/lon grid and product definition, and its values as the packing's
// own integers X (value = (R + X * 2^E) / 10^D), so a record can carry them exactly.
//
// Covered: sections 0-8; grid template 3.0 (regular lat/lon); product templates 4.0, 4.1, 4.2, 4.8, 4.11, 4.12 (the
// fields read here: parameter, level, forecast time); data representation templates 5.0 (simple packing), 5.2 (complex
// packing) and 5.3 (complex packing with spatial differencing), missing-value management 0-2; bitmap 0 (present) / 254
// (the previous one) / 255 (none). Anything else is refused by name - never guessed.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace grib2mini {

constexpr uint32_t MISSING = 0xffffffffu;

struct Message {
  size_t offset = 0, length = 0;
  int discipline = 0, category = 0, number = 0;            // the parameter (discipline, category, number)
  int64_t referenceTimeMs = 0;                              // section 1 reference time (the run)
  int timeUnit = 1; int64_t forecastTime = 0;               // template 4.x: indicator of unit of time, forecast time
  int levelType = 255; int levelScale = 0; int64_t levelValue = 0;      // first fixed surface (type, scale factor, scaled value)
  int levelType2 = 255; int level2Scale = 0; int64_t level2Value = 0;   // second fixed surface
  int productTemplate = -1, ensembleType = -1;              // 4.1/4.11: type of ensemble forecast (perturbed/control...)
  int derivedForecast = -1;                                 // 4.2/4.12: derived forecast (0 mean, 2 standard deviation ...)
  // grid template 3.0
  uint32_t ni = 0, nj = 0; double la1 = 0, lo1 = 0, la2 = 0, lo2 = 0, di = 0, dj = 0; int scanMode = 0;
  // data representation
  int dataTemplate = -1; float R = 0; int E = 0, D = 0, nbits = 0; uint32_t numberOfValues = 0;
  // section positions (absolute offsets into the buffer)
  size_t sec5 = 0, sec6 = 0, sec7 = 0, sec7len = 0; int bitmapIndicator = 255;
  double levelHpa() const { return levelType == 100 ? double(levelValue) / std::pow(10.0, levelScale) / 100.0 : NAN; }
  int64_t forecastHours() const { return timeUnit == 1 ? forecastTime : timeUnit == 0 ? forecastTime / 60 : timeUnit == 2 ? forecastTime * 24 : -1; }
};

namespace detail {
inline uint64_t be(const uint8_t* p, int n) { uint64_t v = 0; for (int i = 0; i < n; i++) v = (v << 8) | p[i]; return v; }
// GRIB2 signed integers are sign-and-magnitude: the top bit is the sign
inline int64_t sm(const uint8_t* p, int n) { uint64_t v = be(p, n); const uint64_t sign = uint64_t(1) << (8 * n - 1); return (v & sign) ? -int64_t(v & (sign - 1)) : int64_t(v); }
inline float ieee(const uint8_t* p) { uint32_t u = uint32_t(be(p, 4)); float f; memcpy(&f, &u, 4); return f; }
inline int64_t daysFromCivil(int64_t y, int m, int d) {
  y -= m <= 2; const int64_t era = (y >= 0 ? y : y - 399) / 400; const int64_t yoe = y - era * 400;
  const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1; const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}
// a big-endian bit stream
struct Bits {
  const uint8_t* p; size_t n; size_t bit = 0;
  bool read(int width, uint32_t& out) {
    if (width == 0) { out = 0; return true; }
    if (width > 32 || bit + size_t(width) > n * 8) return false;
    uint64_t v = 0;
    for (int i = 0; i < width; i++) { v = (v << 1) | ((p[bit >> 3] >> (7 - (bit & 7))) & 1u); bit++; }
    out = uint32_t(v); return true;
  }
  void align() { bit = (bit + 7) & ~size_t(7); }
};
}  // namespace detail

// Every message in a buffer (a whole GRIB2 file or messages fetched by byte range, concatenated).
inline bool parse(const uint8_t* b, size_t n, std::vector<Message>& out, std::string& err) {
  using namespace detail;
  size_t at = 0;
  while (at + 16 <= n) {
    if (memcmp(b + at, "GRIB", 4) != 0) { err = "no GRIB indicator at byte " + std::to_string(at); return false; }
    if (b[at + 7] != 2) { err = "GRIB edition " + std::to_string(b[at + 7]) + " (only 2)"; return false; }
    Message m; m.offset = at; m.length = size_t(be(b + at + 8, 8)); m.discipline = b[at + 6];
    if (m.length < 16 + 4 || at + m.length > n) { err = "message length out of range at byte " + std::to_string(at); return false; }
    if (memcmp(b + at + m.length - 4, "7777", 4) != 0) { err = "no end section at byte " + std::to_string(at + m.length - 4); return false; }
    size_t s = at + 16; const size_t end = at + m.length - 4;
    int lastBitmap = -1; (void)lastBitmap;
    while (s + 5 <= end) {
      const size_t len = size_t(be(b + s, 4)); const int num = b[s + 4];
      if (len < 5 || s + len > end) { err = "section " + std::to_string(num) + " length out of range"; return false; }
      const uint8_t* p = b + s;
      if (num == 1) {
        const int y = int(be(p + 12, 2)), mo = p[14], d = p[15], h = p[16], mi = p[17], se = p[18];
        m.referenceTimeMs = (daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se) * 1000;
      } else if (num == 3) {
        const int tmpl = int(be(p + 12, 2));
        if (tmpl != 0) { err = "grid template 3." + std::to_string(tmpl) + " unsupported"; return false; }
        m.ni = uint32_t(be(p + 30, 4)); m.nj = uint32_t(be(p + 34, 4));
        const uint32_t basic = uint32_t(be(p + 38, 4)), sub = uint32_t(be(p + 42, 4));
        const double unit = (basic == 0 || basic == 0xffffffffu) ? 1e-6 : double(basic) / double(sub ? sub : 1);
        m.la1 = double(sm(p + 46, 4)) * unit; m.lo1 = double(sm(p + 50, 4)) * unit;
        m.la2 = double(sm(p + 55, 4)) * unit; m.lo2 = double(sm(p + 59, 4)) * unit;
        m.di = double(be(p + 63, 4)) * unit; m.dj = double(be(p + 67, 4)) * unit;
        m.scanMode = p[71];
      } else if (num == 4) {
        m.productTemplate = int(be(p + 7, 2));
        const int t = m.productTemplate;
        if (t != 0 && t != 1 && t != 2 && t != 8 && t != 11 && t != 12) { err = "product template 4." + std::to_string(t) + " unsupported"; return false; }
        m.category = p[9]; m.number = p[10];
        m.timeUnit = p[17]; m.forecastTime = int64_t(be(p + 18, 4));
        m.levelType = p[22]; m.levelScale = int(int8_t(p[23] & 0x80 ? -(p[23] & 0x7f) : p[23])); m.levelValue = sm(p + 24, 4);
        m.levelType2 = p[28]; m.level2Scale = int(int8_t(p[29] & 0x80 ? -(p[29] & 0x7f) : p[29])); m.level2Value = sm(p + 30, 4);
        if (t == 1 || t == 11) m.ensembleType = p[34];
        if (t == 2 || t == 12) m.derivedForecast = p[34];
      } else if (num == 5) {
        m.sec5 = s; m.numberOfValues = uint32_t(be(p + 5, 4)); m.dataTemplate = int(be(p + 9, 2));
        if (m.dataTemplate != 0 && m.dataTemplate != 2 && m.dataTemplate != 3) { err = "data representation template 5." + std::to_string(m.dataTemplate) + " unsupported"; return false; }
        m.R = ieee(p + 11); m.E = int(sm(p + 15, 2)); m.D = int(sm(p + 17, 2)); m.nbits = p[19];
      } else if (num == 6) {
        m.sec6 = s; m.bitmapIndicator = p[5];
        if (m.bitmapIndicator != 0 && m.bitmapIndicator != 255 && m.bitmapIndicator != 254) { err = "bitmap indicator " + std::to_string(m.bitmapIndicator) + " unsupported"; return false; }
      } else if (num == 7) {
        m.sec7 = s; m.sec7len = len;
        out.push_back(m);   // (a message may repeat sections 4-7 for further fields: each data section is a field)
      }
      s += len;
    }
    at += m.length;
  }
  return true;
}

// A field's packing integers X at every grid point, in the message's scan order (MISSING where the bitmap or the
// packing's missing-value management says so). value = (R + X * 2^E) / 10^D.
inline bool unpack(const uint8_t* b, const Message& m, const Message* previousBitmap, std::vector<uint32_t>& X, std::string& err) {
  using namespace detail;
  const size_t points = size_t(m.ni) * size_t(m.nj);
  X.assign(points, MISSING);
  // bitmap
  const uint8_t* bm = nullptr; size_t bmBytes = 0;
  if (m.bitmapIndicator == 0) { bm = b + m.sec6 + 6; bmBytes = size_t(be(b + m.sec6, 4)) - 6; }
  else if (m.bitmapIndicator == 254) {
    if (!previousBitmap || previousBitmap->bitmapIndicator != 0) { err = "bitmap 254 without a previous bitmap"; return false; }
    bm = b + previousBitmap->sec6 + 6; bmBytes = size_t(be(b + previousBitmap->sec6, 4)) - 6;
  }
  std::vector<uint32_t> packed(m.numberOfValues, 0);
  const uint8_t* data = b + m.sec7 + 5; const size_t dataLen = m.sec7len - 5;
  const uint8_t* s5 = b + m.sec5;
  if (m.dataTemplate == 0) {
    Bits bits{data, dataLen};
    for (uint32_t i = 0; i < m.numberOfValues; i++) if (!bits.read(m.nbits, packed[i])) { err = "data section short"; return false; }
  } else {
    // complex packing (5.2) and with spatial differencing (5.3)
    const int splitting = s5[21], mvm = s5[22];
    const uint32_t ng = uint32_t(be(s5 + 31, 4)); const int refWidth = s5[35], bitsWidth = s5[36];
    const uint32_t refLength = uint32_t(be(s5 + 37, 4)); const int lengthIncrement = s5[41]; const uint32_t lastLength = uint32_t(be(s5 + 42, 4)); const int bitsLength = s5[46];
    if (splitting != 1) { err = "group splitting method " + std::to_string(splitting) + " unsupported"; return false; }
    if (mvm > 2) { err = "missing value management " + std::to_string(mvm) + " unsupported"; return false; }
    int order = 0, ndesc = 0;
    if (m.dataTemplate == 3) { order = s5[47]; ndesc = s5[48]; if (order != 1 && order != 2) { err = "spatial differencing order " + std::to_string(order); return false; } }
    size_t pos = 0;
    int64_t h1 = 0, h2 = 0, minsd = 0;
    if (m.dataTemplate == 3) {
      if (size_t(ndesc) * size_t(order + 1) > dataLen) { err = "data section short"; return false; }
      h1 = sm(data, ndesc); pos += ndesc;
      if (order == 2) { h2 = sm(data + pos, ndesc); pos += ndesc; }
      minsd = sm(data + pos, ndesc); pos += ndesc;
    }
    Bits bits{data, dataLen, pos * 8};
    std::vector<uint32_t> refs(ng), widths(ng), lengths(ng);
    for (uint32_t g = 0; g < ng; g++) if (!bits.read(m.nbits, refs[g])) { err = "group references short"; return false; }
    bits.align();
    for (uint32_t g = 0; g < ng; g++) { uint32_t w; if (!bits.read(bitsWidth, w)) { err = "group widths short"; return false; } widths[g] = w + uint32_t(refWidth); }
    bits.align();
    for (uint32_t g = 0; g < ng; g++) { uint32_t l; if (!bits.read(bitsLength, l)) { err = "group lengths short"; return false; } lengths[g] = refLength + l * uint32_t(lengthIncrement); }
    if (ng) lengths[ng - 1] = lastLength;
    bits.align();
    // the values; missing (per mvm) kept apart so spatial differencing runs over the present values only
    std::vector<uint8_t> missing(m.numberOfValues, 0);
    size_t k = 0;
    const uint32_t refMissing1 = m.nbits ? (uint32_t(1) << m.nbits) - 1 : 0, refMissing2 = refMissing1 ? refMissing1 - 1 : 0;
    for (uint32_t g = 0; g < ng; g++) {
      const uint32_t w = widths[g];
      const uint32_t miss1 = w ? (w >= 32 ? 0xffffffffu : (uint32_t(1) << w) - 1) : 0, miss2 = miss1 ? miss1 - 1 : 0;
      for (uint32_t i = 0; i < lengths[g]; i++) {
        if (k >= m.numberOfValues) { err = "group lengths exceed the number of values"; return false; }
        uint32_t v = 0;
        if (w) { if (!bits.read(int(w), v)) { err = "packed values short"; return false; } }
        bool isMissing = false;
        if (mvm >= 1) {
          if (w == 0) isMissing = refs[g] == refMissing1 || (mvm == 2 && refs[g] == refMissing2);
          else isMissing = v == miss1 || (mvm == 2 && v == miss2);
        }
        if (isMissing) { missing[k] = 1; packed[k] = 0; }
        else packed[k] = refs[g] + v;
        k++;
      }
    }
    if (k != m.numberOfValues) { err = "groups hold " + std::to_string(k) + " of " + std::to_string(m.numberOfValues) + " values"; return false; }
    if (m.dataTemplate == 3) {
      // undo the spatial differencing over the present values, in order
      std::vector<int64_t> v; v.reserve(m.numberOfValues);
      for (uint32_t i = 0; i < m.numberOfValues; i++) if (!missing[i]) v.push_back(int64_t(packed[i]));
      if (!v.empty()) {
        if (order == 1) { v[0] = h1; for (size_t i = 1; i < v.size(); i++) v[i] = v[i] + minsd + v[i - 1]; }
        else { v[0] = h1; if (v.size() > 1) v[1] = h2; for (size_t i = 2; i < v.size(); i++) v[i] = v[i] + minsd + 2 * v[i - 1] - v[i - 2]; }
      }
      size_t j = 0;
      for (uint32_t i = 0; i < m.numberOfValues; i++) {
        if (missing[i]) continue;
        if (v[j] < 0 || v[j] > int64_t(0xfffffffe)) { err = "a reconstructed integer is out of range"; return false; }
        packed[i] = uint32_t(v[j++]);
      }
    }
    for (uint32_t i = 0; i < m.numberOfValues; i++) if (missing[i]) packed[i] = MISSING;
  }
  // spread the values over the grid points the bitmap marks
  if (bm) {
    if (bmBytes * 8 < points) { err = "bitmap shorter than the grid"; return false; }
    size_t k = 0;
    for (size_t i = 0; i < points; i++) if ((bm[i >> 3] >> (7 - (i & 7))) & 1u) { if (k >= packed.size()) { err = "bitmap marks more points than values"; return false; } X[i] = packed[k++]; }
    if (k != packed.size()) { err = "bitmap marks fewer points than values"; return false; }
  } else {
    if (packed.size() != points) { err = "values (" + std::to_string(packed.size()) + ") do not cover the grid (" + std::to_string(points) + ")"; return false; }
    X.swap(packed);
  }
  return true;
}

}  // namespace grib2mini
