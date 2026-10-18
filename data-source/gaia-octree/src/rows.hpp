// One star as the module holds it, its $STR row (both ways) and its packed
// SKTPoint / SKTPoint3D (24 bytes each, little-endian, as SKT.fbs lays them).
#pragma once
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

namespace gaia_octree {

constexpr const char* kBailerJones2021 = "2021AJ....161..147B";
constexpr const char* kEdsd2015 = "2015PASP..127..994B";
constexpr double kGaiaEpoch = 2016.0;
constexpr double kHipparcosEpoch = 1991.25;

struct Star {
  uint64_t gaia = 0;  // GAIA_DR3_SOURCE_ID; 0 for a Hipparcos-only star
  uint32_t hip = 0;
  double epoch = kGaiaEpoch, ra = NAN, dec = NAN, raUnc = NAN, decUnc = NAN;  // deg, arcsec
  double plx = NAN, plxUnc = NAN, pmra = NAN, pmraUnc = NAN, pmdec = NAN, pmdecUnc = NAN, rv = NAN, rvUnc = NAN;
  double g = NAN, gUnc = NAN, bp = NAN, bpUnc = NAN, rp = NAN, rpUnc = NAN;
  double dist = NAN, distLo = NAN, distHi = NAN;
  uint8_t method = 0;  // strDistanceEstimator
  bool var = false, mult = false, gModeled = false;
  double ra16 = NAN, dec16 = NAN;  // the catalog place at J2016.0

  bool hipparcosOnly() const { return gaia == 0; }
  double fracUnc() const { return dist > 0 && std::isfinite(distHi - distLo) ? (distHi - distLo) / dist : NAN; }
  std::string id() const { return gaia ? "gaia-dr3:" + std::to_string(gaia) : "hip2007:" + std::to_string(hip); }
};

inline const char* distanceRef(uint8_t method) {
  return method == uint8_t(strDistanceEstimator::EDSD_POSTERIOR) ? kEdsd2015
         : method ? kBailerJones2021 : nullptr;
}

// The full row of the angular layer, size-prefixed, appended to `out`.
inline void appendRow(const Star& s, std::vector<uint8_t>& out) {
  flatbuffers::FlatBufferBuilder b(640);
  const auto id = b.CreateString(s.id());
  const auto version = b.CreateString(s.gaia ? "Gaia DR3" : "Hipparcos 2007");
  const auto origin = b.CreateString(s.gaia ? "Gaia DR3 (gaiadr3.gaia_source)" : "Hipparcos, the new reduction (van Leeuwen 2007)");
  const char* ref = distanceRef(s.method);
  const auto distRef = ref ? b.CreateString(ref) : flatbuffers::Offset<flatbuffers::String>();
  STRBuilder r(b);
  r.add_ID(id);
  if (s.gaia) r.add_GAIA_DR3_SOURCE_ID(s.gaia);
  if (s.hip) r.add_HIP_CAT_ID(s.hip);
  r.add_CAT_VERSION(version);
  r.add_ASTROMETRY_ORIGIN(origin);
  r.add_STAR_EPOCH(s.epoch);
  r.add_RA(s.ra); r.add_RA_UNC(s.raUnc);
  r.add_DEC(s.dec); r.add_DEC_UNC(s.decUnc);
  r.add_PARALLAX(s.plx); r.add_PARALLAX_UNC(s.plxUnc);
  r.add_PMRA(s.pmra); r.add_PMRA_UNC(s.pmraUnc);
  r.add_PMDEC(s.pmdec); r.add_PMDEC_UNC(s.pmdecUnc);
  r.add_GMAG(s.g); r.add_GMAG_UNC(s.gUnc);
  r.add_BPMAG(s.bp); r.add_BPMAG_UNC(s.bpUnc);
  r.add_RPMAG(s.rp); r.add_RPMAG_UNC(s.rpUnc);
  r.add_VAR_FLAG(s.var); r.add_MULT_FLAG(s.mult);
  r.add_RADIAL_VELOCITY(s.rv); r.add_RADIAL_VELOCITY_UNC(s.rvUnc);
  r.add_DISTANCE_PC(s.dist); r.add_DISTANCE_LO_PC(s.distLo); r.add_DISTANCE_HI_PC(s.distHi);
  r.add_DISTANCE_METHOD(strDistanceEstimator(s.method));
  if (ref) r.add_DISTANCE_REF(distRef);
  FinishSizePrefixedSTRBuffer(b, r.Finish());
  out.insert(out.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

// The octree's minimal row: identity, photometry and distance.
inline void appendOctreeRow(uint64_t gaia, uint32_t hip, float g, float bp, float rp, float d, float lo, float hi, uint8_t method,
                            std::vector<uint8_t>& out) {
  flatbuffers::FlatBufferBuilder b(256);
  const auto id = b.CreateString(gaia ? "gaia-dr3:" + std::to_string(gaia) : "hip2007:" + std::to_string(hip));
  const char* ref = distanceRef(method);
  const auto distRef = ref ? b.CreateString(ref) : flatbuffers::Offset<flatbuffers::String>();
  STRBuilder r(b);
  r.add_ID(id);
  if (gaia) r.add_GAIA_DR3_SOURCE_ID(gaia);
  if (hip) r.add_HIP_CAT_ID(hip);
  r.add_GMAG(g); r.add_BPMAG(bp); r.add_RPMAG(rp);
  r.add_DISTANCE_PC(d); r.add_DISTANCE_LO_PC(lo); r.add_DISTANCE_HI_PC(hi);
  r.add_DISTANCE_METHOD(strDistanceEstimator(method));
  if (ref) r.add_DISTANCE_REF(distRef);
  FinishSizePrefixedSTRBuffer(b, r.Finish());
  out.insert(out.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

inline Star fromRow(const STR& r) {
  Star s;
  s.gaia = r.GAIA_DR3_SOURCE_ID(); s.hip = r.HIP_CAT_ID();
  s.epoch = r.STAR_EPOCH(); s.ra = r.RA(); s.dec = r.DEC(); s.raUnc = r.RA_UNC(); s.decUnc = r.DEC_UNC();
  s.plx = r.PARALLAX(); s.plxUnc = r.PARALLAX_UNC(); s.pmra = r.PMRA(); s.pmraUnc = r.PMRA_UNC(); s.pmdec = r.PMDEC(); s.pmdecUnc = r.PMDEC_UNC();
  s.rv = r.RADIAL_VELOCITY(); s.rvUnc = r.RADIAL_VELOCITY_UNC();
  s.g = r.GMAG(); s.gUnc = r.GMAG_UNC(); s.bp = r.BPMAG(); s.bpUnc = r.BPMAG_UNC(); s.rp = r.RPMAG(); s.rpUnc = r.RPMAG_UNC();
  s.dist = r.DISTANCE_PC(); s.distLo = r.DISTANCE_LO_PC(); s.distHi = r.DISTANCE_HI_PC(); s.method = uint8_t(r.DISTANCE_METHOD());
  s.var = r.VAR_FLAG(); s.mult = r.MULT_FLAG();
  s.gModeled = !s.gaia;
  return s;
}

// Size-prefixed records of a stream, each checked for `id`; false on a bad stream.
template <class F>
inline bool eachRecord(const uint8_t* p, size_t n, const char* id, F&& f) {
  for (size_t at = 0; at < n;) {
    if (at + 8 > n) return false;
    uint32_t len;
    std::memcpy(&len, p + at, 4);
    if (len < 8 || at + 4 + len > n || std::memcmp(p + at + 8, id, 4) != 0) return false;
    f(p + at + 4, size_t(len));
    at += 4 + size_t(len);
  }
  return true;
}

template <class T>
inline void put(std::vector<uint8_t>& out, T v) {
  const size_t at = out.size();
  out.resize(at + sizeof(T));
  std::memcpy(out.data() + at, &v, sizeof(T));
}

inline int16_t mmag(double m) { return std::isfinite(m) && std::fabs(m) < 32.7 ? int16_t(std::lround(m * 1000)) : int16_t(-32768); }
inline uint16_t colorIndex(double c) {
  return std::isfinite(c) && std::fabs(c) < 32.7 ? uint16_t(std::lround(c * 1000) + 32768) : uint16_t(0);
}

// SKTPoint at the J2016.0 catalog place.
inline void appendPoint(const Star& s, uint32_t row, std::vector<uint8_t>& out) {
  double ra = std::fmod(s.ra16, 360.0);
  if (ra < 0) ra += 360;
  const uint32_t raFixed = uint32_t(uint64_t(std::llround(ra / 360.0 * 4294967296.0)) & 0xFFFFFFFFull);
  const int64_t dec = std::llround(s.dec16 / 90.0 * 2147483648.0);
  const int32_t decFixed = int32_t(std::max<int64_t>(-2147483647ll, std::min<int64_t>(2147483647ll, dec)));
  uint16_t flags = (s.var ? 1 : 0) | (s.mult ? 2 : 0) | (s.gModeled ? 16 : 0);
  int16_t pmra = -32768, pmdec = -32768;
  if (std::isfinite(s.pmra) && std::isfinite(s.pmdec) && std::fabs(s.pmra) < 32767 && std::fabs(s.pmdec) < 32767) {
    pmra = int16_t(std::lround(s.pmra)); pmdec = int16_t(std::lround(s.pmdec));
  } else flags |= 4;
  uint16_t plx = 0;
  if (std::isfinite(s.plx) && s.plx > 0 && s.plx / 0.02 < 65535) plx = uint16_t(std::max(1l, std::lround(s.plx / 0.02)));
  else flags |= 8;
  put(out, raFixed); put(out, decFixed); put(out, pmra); put(out, pmdec); put(out, plx);
  put(out, mmag(s.g)); put(out, colorIndex(s.bp - s.rp)); put(out, flags); put(out, row);
}

inline void appendPoint3D(float x, float y, float z, double absMag, double color0, double frac, uint16_t flags, uint32_t row,
                          std::vector<uint8_t>& out) {
  const uint16_t unc = std::isfinite(frac) && frac >= 0 && frac < 6.5535 ? uint16_t(std::lround(frac * 10000)) : uint16_t(65535);
  put(out, x); put(out, y); put(out, z); put(out, mmag(absMag)); put(out, colorIndex(color0)); put(out, unc); put(out, flags); put(out, row);
}

}  // namespace gaia_octree
