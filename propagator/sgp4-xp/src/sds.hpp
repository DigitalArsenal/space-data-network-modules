// propagator/sgp4-xp: the SDS records it reads and writes: $OCM element sets (and the $OMM of the ingest_omm
// boundary), $OEM ephemerides and $EOP Earth orientation. The generated object API of the pinned spacedatastandards.org (build.mjs
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
// $OCM element sets (flight) and the $OMM boundary (ingest_omm).
// ---------------------------------------------------------------------------------------------------------------
// A refusal: its name and why.
struct Refusal {
  std::string code, why;
  bool fail(const std::string& c, const std::string& w) { code = c; why = w; return false; }
};

// The record type of a payload, plain or size-prefixed: its file identifier, or "" when it names none.
inline std::string recordType(const uint8_t* p, size_t n) {
  if (p == nullptr || n < 8) return std::string();
  const uint8_t* id = (n >= 12 && p[8] == '$') ? p + 8 : p + 4;
  if (id[0] != '$') return std::string();
  return std::string(reinterpret_cast<const char*>(id), 4);
}

// A stock SGP4 or SGP4-XP element set of an $OCM: MEAN_ELEMENTS under its theory's own forces in PERTURBATIONS,
// TEMEOFDATE, centered on the Earth. Anything else is refused by name; the mean motion is the record's, never derived.
inline bool ocmToElements(const OCMT& o, Elements* e, Refusal* no) {
  if (!o.CENTER_NAME.empty() && upper(o.CENTER_NAME) != "EARTH") return no->fail("unsupported-center", "The $OCM's CENTER_NAME must be EARTH.");
  if (!o.MEAN_ELEMENTS) return no->fail("mean-elements-missing", "The $OCM carries no MEAN_ELEMENTS: flight takes an element set.");
  const OCMMeanElementsT& me = *o.MEAN_ELEMENTS;
  if (me.MEAN_ELEMENT_THEORY == meanElementSource::UNSPECIFIED)
    return no->fail("mean-element-theory-unspecified", "MEAN_ELEMENT_THEORY is UNSPECIFIED: a set states its theory.");
  if (me.MEAN_ELEMENT_THEORY != meanElementSource::SGP4XP && me.MEAN_ELEMENT_THEORY != meanElementSource::SGP4) {
    const char* name = EnumNamemeanElementSource(me.MEAN_ELEMENT_THEORY);
    return no->fail(std::string("theory-not-flown:") + (name != nullptr && *name ? name : "UNKNOWN"), "This module flies SGP4XP and SGP4 sets.");
  }
  const bool xp = me.MEAN_ELEMENT_THEORY == meanElementSource::SGP4XP;
  if (xp ? (me.BSTAR != 0.0 || me.MEAN_MOTION_DOT != 0.0 || me.MEAN_MOTION_DDOT != 0.0) : (me.BTERM != 0.0 || me.AGOM != 0.0))
    return no->fail("elements-other-theory", xp ? "An SGP4XP set carries BSTAR, MEAN_MOTION_DOT or MEAN_MOTION_DDOT (SGP4's terms)."
                                                : "An SGP4 set carries BTERM or AGOM (SGP4XP's terms).");
  if (upper(o.ORB_AVERAGING) != (xp ? "BROUWER" : "KOZAI"))
    return no->fail("orb-averaging-mismatch", xp ? "An SGP4XP set's ORB_AVERAGING is BROUWER." : "An SGP4 set's ORB_AVERAGING is KOZAI.");
  // the forces: the theory's own, stated
  const PerturbationsT* pt = o.PERTURBATIONS.get();
  const pcfWeatherSource weather = pt ? pt->WEATHER_SOURCE : pcfWeatherSource::UNSPECIFIED;
  if (weather != (xp ? pcfWeatherSource::THEORY_FLUX_MODEL : pcfWeatherSource::NONE))
    return no->fail("weather-source-not-stock", xp ? "An SGP4XP set flies on its theory's own flux model: WEATHER_SOURCE THEORY_FLUX_MODEL."
                                                   : "An SGP4 set's drag is its BSTAR: WEATHER_SOURCE NONE.");
  if (!pt->SPACE_WEATHER.empty() || !pt->DENSITY_CORRECTION_NODE_TIMES_MS.empty() || !pt->DENSITY_CORRECTION_LOG_DENSITY_SCALE_DIMENSIONLESS.empty())
    return no->fail("weather-source-not-stock", "The record carries space-weather rows or density-correction nodes: this module flies the theory's own forces only.");
  const bool stockAtmosphere = xp ? (pt->ATMOSPHERIC_MODEL && pt->ATMOSPHERIC_MODEL->MODEL == AtmosphericModelFamily::JXX && pt->ATMOSPHERIC_MODEL->YEAR == 1970)
                                  : !pt->ATMOSPHERIC_MODEL;
  if (!stockAtmosphere || pt->DENSITY_CORRECTION != pcfDensityCorrection::NONE)
    return no->fail("atmosphere-not-stock", xp ? "An SGP4XP set states ATMOSPHERIC_MODEL {JXX,1970} and DENSITY_CORRECTION NONE."
                                               : "An SGP4 set states no ATMOSPHERIC_MODEL and DENSITY_CORRECTION NONE.");
  if (pt->MAXIMUM_TESSERAL_DEGREE != 0 || pt->MAXIMUM_ZONAL_DEGREE != 0)
    return no->fail("gravity-terms-not-stock", "MAXIMUM_TESSERAL_DEGREE and MAXIMUM_ZONAL_DEGREE are 0: this module flies the theory's own gravity terms.");
  Frame frame;
  if (!o.TRAJ_REF_FRAME || !frameOf(o.TRAJ_REF_FRAME.get(), &frame) || frame != Frame::Teme || !o.TRAJ_FRAME_EPOCH.empty())
    return no->fail("frame-pairing-invalid", "An SGP4 or SGP4XP set is TEMEOFDATE.");
  *e = Elements{};
  e->xp = xp;
  Instant epoch;
  if (!parseInstant(me.EPOCH, &epoch)) return no->fail("invalid-ocm", "MEAN_ELEMENTS.EPOCH is not an ISO 8601 UTC time: " + me.EPOCH);
  setEpoch(e, epoch);
  e->meanMotion = me.MEAN_MOTION;
  e->eccentricity = me.ECCENTRICITY;
  e->inclination = me.INCLINATION;
  e->raan = me.RA_OF_ASC_NODE;
  e->argPerigee = me.ARG_OF_PERICENTER;
  e->meanAnomaly = me.MEAN_ANOMALY;
  if (xp) {
    e->drag = me.BTERM;
    e->agom = me.AGOM;
  } else {
    e->drag = me.BSTAR;
    e->meanMotionDot = me.MEAN_MOTION_DOT;
    e->meanMotionDdot = me.MEAN_MOTION_DDOT;
  }
  e->norad = o.METADATA ? o.METADATA->NORAD_CAT_ID : 0;
  e->revNumber = static_cast<int>(o.ORB_REVNUM);
  if (!(e->meanMotion > 0) || !std::isfinite(e->meanMotion) || !(e->eccentricity >= 0) || !(e->eccentricity < 1))
    return no->fail("invalid-ocm", "MEAN_ELEMENTS.MEAN_MOTION must be positive and the eccentricity in [0, 1).");
  return true;
}

// The boundary: a foreign SGP4-XP $OMM (BTERM in BSTAR, AGOM in MEAN_MOTION_DDOT, m**2/kg). An $OMM with a free-form
// parameter list is refused by its count, never read by name; an AP set is never an $OMM; the propagator
// ABI this boundary feeds is SGP4-XP, so an SGP4 set is refused too.
inline bool ommToElements(const OMMT& o, Elements* e, Refusal* no) {
  if (const size_t listed = o.USER_DEFINED_PARAMETERS.size())
    return no->fail("user-defined-parameters:" + std::to_string(listed), "An $OMM with a free-form parameter list: every field this module reads is typed.");
  if (o.MEAN_ELEMENT_THEORY == meanElementSource::AP) return no->fail("theory-not-ingestable:AP", "An AP set is an $OCM, never an $OMM.");
  if (o.MEAN_ELEMENT_THEORY != meanElementSource::SGP4XP)
    return no->fail("unsupported-theory", "ingest_omm takes SGP4XP element sets: the propagator ABI is this module's SGP4-XP.");
  if (!o.CENTER_NAME.empty() && upper(o.CENTER_NAME) != "EARTH") return no->fail("unsupported-center", "The $OMM's CENTER_NAME must be EARTH.");
  *e = Elements{};
  e->xp = true;
  Instant epoch;
  if (!parseInstant(o.EPOCH, &epoch)) return no->fail("invalid-omm", "EPOCH is not an ISO 8601 UTC time: " + o.EPOCH);
  setEpoch(e, epoch);
  e->meanMotion = o.MEAN_MOTION;
  e->eccentricity = o.ECCENTRICITY;
  e->inclination = o.INCLINATION;
  e->raan = o.RA_OF_ASC_NODE;
  e->argPerigee = o.ARG_OF_PERICENTER;
  e->meanAnomaly = o.MEAN_ANOMALY;
  e->drag = o.BSTAR;             // BTERM, m^2/kg
  e->agom = o.MEAN_MOTION_DDOT;  // AGOM, m^2/kg
  e->norad = o.NORAD_CAT_ID;
  e->revNumber = static_cast<int>(o.REV_AT_EPOCH);
  if (!(e->meanMotion > 0) || !std::isfinite(e->meanMotion) || !(e->eccentricity >= 0) || !(e->eccentricity < 1))
    return no->fail("invalid-omm", "MEAN_MOTION must be positive and the eccentricity in [0, 1).");
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

}  // namespace sgp4xp
