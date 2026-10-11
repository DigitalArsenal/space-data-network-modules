// propagator/sgp4-xp: the SDS records it reads and writes: $OMM element sets, $OEM ephemerides, $OBD fit
// diagnostics and $EOP Earth orientation. The generated object API of the pinned spacedatastandards.org (build.mjs
// generates it from the published package) is the only reader and writer; nothing here parses bytes by hand.
#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "engine.hpp"
#include "frames.hpp"

namespace sgp4xp {

// ---------------------------------------------------------------------------------------------------------------
// Frames of records.
// ---------------------------------------------------------------------------------------------------------------
inline std::string upper(std::string s) {
  for (char& c : s)
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  return s;
}

// The axes an $RFM names, or false: TEME, the inertial and the Earth-fixed members this module can rotate. The union
// member is read first; a frame given by name only (RFM.NAME, as some producers write it) is read by the name.
inline bool frameByName(const std::string& name, Frame* out) {
  const std::string n = upper(name);
  if (n == "TEME" || n == "TEMEOFDATE") { *out = Frame::Teme; return true; }
  if (n == "GCRF" || n == "ICRF" || n == "J2000A") { *out = Frame::Gcrf; return true; }
  if (n == "J2000" || n == "EME2000") { *out = Frame::Eme2000; return true; }
  if (n == "ITRF" || n == "ITRF2000" || n == "ITRF93" || n == "ITRF97" || n == "ECEF" || n == "EFG" || n == "FIXED_EARTH" ||
      n == "WGS84" || n == "GTOD")
    { *out = Frame::Itrf; return true; }
  return false;
}
inline bool frameOf(const RFMT* rfm, Frame* out) {
  if (rfm == nullptr) return false;
  switch (rfm->REFERENCE_FRAME.type) {
    case RFMUnion::CelestialFrameWrapper: {
      const auto* w = reinterpret_cast<const CelestialFrameWrapperT*>(rfm->REFERENCE_FRAME.value);
      switch (w->frame) {
        case CelestialFrame::TEMEOFDATE: *out = Frame::Teme; return true;
        case CelestialFrame::GCRF: case CelestialFrame::ICRF: case CelestialFrame::J2000A:
          *out = Frame::Gcrf; return true;
        case CelestialFrame::J2000: case CelestialFrame::EME2000:
          *out = Frame::Eme2000; return true;
        case CelestialFrame::ITRF2000: case CelestialFrame::ITRF93: case CelestialFrame::ITRF97:
        case CelestialFrame::EFG: case CelestialFrame::FIXED_EARTH: case CelestialFrame::WGS84:
        case CelestialFrame::GTOD:
          *out = Frame::Itrf; return true;
        default: return false;
      }
    }
    case RFMUnion::CustomFrameWrapper: {
      const auto* w = reinterpret_cast<const CustomFrameWrapperT*>(rfm->REFERENCE_FRAME.value);
      if (w->frame == CustomFrame::ECEF) { *out = Frame::Itrf; return true; }
      if (w->frame == CustomFrame::TEME) { *out = Frame::Teme; return true; }
      return false;
    }
    case RFMUnion::NONE: return !rfm->NAME.empty() && frameByName(rfm->NAME, out);
    default: return false;
  }
}

inline std::unique_ptr<RFMT> rfmOf(Frame frame) {
  auto rfm = std::make_unique<RFMT>();
  CelestialFrameWrapperT wrapper;
  wrapper.frame = frame == Frame::Gcrf ? CelestialFrame::GCRF : frame == Frame::Eme2000 ? CelestialFrame::EME2000 : CelestialFrame::TEMEOFDATE;
  rfm->REFERENCE_FRAME.Set(std::move(wrapper));
  return rfm;
}

// The time scale of an $OEM block's TIME_SYSTEM, for the scales this module converts to UTC (GMST is the unset default
// of the enum and is read as UTC). false for any other.
inline bool timeScaleOf(timingStandard system, TimeScale* out) {
  switch (system) {
    case timingStandard::UTC: case timingStandard::GMST: *out = TimeScale::Utc; return true;
    case timingStandard::GPS: *out = TimeScale::Gps; return true;
    case timingStandard::TAI: *out = TimeScale::Tai; return true;
    case timingStandard::TT: *out = TimeScale::Tt; return true;
    default: return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// $OMM
// ---------------------------------------------------------------------------------------------------------------
inline bool ommToElements(const OMMT& o, Elements* e, std::string* why) {
  if (o.MEAN_ELEMENT_THEORY != meanElementSource::SGP4XP && o.MEAN_ELEMENT_THEORY != meanElementSource::SGP4) {
    *why = "MEAN_ELEMENT_THEORY must be SGP4XP or SGP4.";
    return false;
  }
  *e = Elements{};
  e->xp = o.MEAN_ELEMENT_THEORY == meanElementSource::SGP4XP;
  Instant epoch;
  if (!parseInstant(o.EPOCH, &epoch)) {
    *why = "EPOCH is not an ISO 8601 UTC time: " + o.EPOCH;
    return false;
  }
  setEpoch(e, epoch);
  double n = o.MEAN_MOTION;
  if (!(n > 0) && o.SEMI_MAJOR_AXIS > 0) n = std::sqrt(kMuKm3PerS2 / (o.SEMI_MAJOR_AXIS * o.SEMI_MAJOR_AXIS * o.SEMI_MAJOR_AXIS)) * kSecondsPerDay / (2.0 * kPi);
  e->meanMotion = n;
  e->eccentricity = o.ECCENTRICITY;
  e->inclination = o.INCLINATION;
  e->raan = o.RA_OF_ASC_NODE;
  e->argPerigee = o.ARG_OF_PERICENTER;
  e->meanAnomaly = o.MEAN_ANOMALY;
  e->drag = o.BSTAR;
  if (e->xp) {
    e->agom = o.MEAN_MOTION_DDOT;
  } else {
    e->meanMotionDot = o.MEAN_MOTION_DOT;
    e->meanMotionDdot = o.MEAN_MOTION_DDOT;
  }
  e->norad = o.NORAD_CAT_ID;
  e->revNumber = static_cast<int>(o.REV_AT_EPOCH);
  e->elementSetNo = static_cast<int>(o.ELEMENT_SET_NO);
  if (!(e->meanMotion > 0) || !std::isfinite(e->meanMotion) || !(e->eccentricity >= 0) || !(e->eccentricity < 1)) {
    *why = "The mean motion must be positive and the eccentricity in [0, 1).";
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Records in a payload: one buffer, or size-prefixed buffers one after another (the stream form).
// ---------------------------------------------------------------------------------------------------------------
inline bool hasIdentifier(const uint8_t* data, size_t length, size_t offset, const char* id) {
  return length >= offset + 8 && std::memcmp(data + offset + 4, id, 4) == 0;
}
// Calls fn(buffer, length, sizePrefixed) for each record; false when the payload is neither form.
inline bool forEachRecord(const uint8_t* data, size_t length, const char* id,
                          const std::function<bool(const uint8_t*, size_t, bool)>& fn) {
  if (hasIdentifier(data, length, 0, id)) return fn(data, length, false);
  size_t at = 0;
  bool any = false;
  while (at + 12 <= length) {
    uint32_t size = 0;
    std::memcpy(&size, data + at, 4);
    if (size < 8 || at + 4 + size > length || !hasIdentifier(data + 4, size, 0, id)) return false;
    if (!fn(data + at, 4 + size, true)) return false;
    any = true;
    at += 4 + static_cast<size_t>(size);
  }
  return any && at == length;
}

// ---------------------------------------------------------------------------------------------------------------
// $OBD and the $OMM written by the fit.
// ---------------------------------------------------------------------------------------------------------------
inline std::vector<uint8_t> finish(flatbuffers::FlatBufferBuilder& fbb) {
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

}  // namespace sgp4xp
