// propagator/sgp4-xp: a fitted element set as SDS records: the $OMM (MEAN_ELEMENT_THEORY SGP4XP, BTERM in BSTAR, AGOM
// in MEAN_MOTION_DDOT) and the $OBD that describes the fit.
//
// Written against whatever SDS pin the including translation unit holds: this module's own, and the signed OD node's
// of flows/supplemental-omm, whose OMM has no USER_DEFINED_PARAMETERS. The statistics are in the OMM's COMMENT in
// every pin and also parameters where the pin has them.
#pragma once

#include <memory>
#include <string>
#include <type_traits>
#include <utility>

#include "engine.hpp"

namespace sgp4xp {

// Where an element set came from: the source of the ephemeris it was fitted to.
struct Provenance {
  std::string originator;  // the OMM's ORIGINATOR: who produced the ephemeris
  std::string creation;    // the OMM's CREATION_DATE; the end of the fit when empty
  std::string name, id;
  std::string source;      // free text naming the feed, kept in the COMMENT and the $OBD (a provider's identity)
  uint32_t norad = 0;
};

inline std::string number(double v, int significant = 9) {
  char b[48];
  std::snprintf(b, sizeof b, "%.*g", significant, v);
  return b;
}

inline double semiMajorAxisKm(double meanMotionRevPerDay) {
  const double n = meanMotionRevPerDay * 2.0 * kPi / kSecondsPerDay;
  return std::cbrt(kMuKm3PerS2 / (n * n));
}

inline std::string statLine(const char* label, const Statistics& s) {
  char b[256];
  std::snprintf(b, sizeof b, "%s N=%zu RMS_KM=%s MAX_KM=%s RADIAL_RMS_KM=%s ALONG_TRACK_RMS_KM=%s CROSS_TRACK_RMS_KM=%s", label, s.count,
                number(s.rms).c_str(), number(s.max).c_str(), number(s.radial).c_str(), number(s.along).c_str(), number(s.cross).c_str());
  return b;
}

// Pins whose $OMM has USER_DEFINED_PARAMETERS record the statistics there too.
template <typename T>
auto addParameter(T* omm, const std::string& name, const std::string& value, int)
    -> decltype(omm->USER_DEFINED_PARAMETERS.push_back(std::make_unique<typename decltype(omm->USER_DEFINED_PARAMETERS)::value_type::element_type>()), void()) {
  auto p = std::make_unique<typename decltype(omm->USER_DEFINED_PARAMETERS)::value_type::element_type>();
  p->PARAM_NAME = name;
  p->PARAM_VALUE = value;
  omm->USER_DEFINED_PARAMETERS.push_back(std::move(p));
}
template <typename T>
void addParameter(T*, const std::string&, const std::string&, long) {}

inline std::unique_ptr<RFMT> temeReferenceFrame() {
  auto rfm = std::make_unique<RFMT>();
  CelestialFrameWrapperT wrapper;
  wrapper.frame = CelestialFrame::TEMEOFDATE;
  rfm->REFERENCE_FRAME.Set(std::move(wrapper));
  return rfm;
}

// `product` names the program that fitted the set, as the COMMENT and the $OBD's METHOD_SOURCE say it.
inline std::unique_ptr<OMMT> ommOf(const IntervalFit& f, const Provenance& who, const std::string& product) {
  const FitResult& fit = f.result;
  auto omm = std::make_unique<OMMT>();
  const Elements& e = fit.elements;
  omm->CCSDS_OMM_VERS = 3.0;
  omm->CREATION_DATE = who.creation.empty() ? formatInstant(f.fitStop, 3) : who.creation;
  omm->ORIGINATOR = who.originator.empty() ? "UNKNOWN" : who.originator;
  omm->OBJECT_NAME = who.name;
  omm->OBJECT_ID = who.id;
  omm->CENTER_NAME = "EARTH";
  omm->REFERENCE_FRAME = temeReferenceFrame();
  omm->TIME_SYSTEM = timingStandard::UTC;
  omm->MEAN_ELEMENT_THEORY = meanElementSource::SGP4XP;
  omm->EPOCH = formatInstant(epochOf(e));
  omm->SEMI_MAJOR_AXIS = semiMajorAxisKm(e.meanMotion);
  omm->MEAN_MOTION = e.meanMotion;
  omm->ECCENTRICITY = e.eccentricity;
  omm->INCLINATION = e.inclination;
  omm->RA_OF_ASC_NODE = e.raan;
  omm->ARG_OF_PERICENTER = e.argPerigee;
  omm->MEAN_ANOMALY = e.meanAnomaly;
  omm->GM = kMuKm3PerS2;
  omm->CLASSIFICATION_TYPE = "U";
  omm->NORAD_CAT_ID = who.norad;
  omm->ELEMENT_SET_NO = 999;
  omm->BSTAR = e.drag;              // BTERM, m^2/kg
  omm->MEAN_MOTION_DOT = 0.0;
  omm->MEAN_MOTION_DDOT = e.agom;   // AGOM, m^2/kg
  omm->USER_DEFINED_EARTH_MODEL = "WGS-72";
  std::string comment = std::string("SGP4-XP fit by ") + product + " to the ephemeris of " + (who.originator.empty() ? "an unnamed source" : who.originator) +
                        ". BTERM is BSTAR and AGOM is MEAN_MOTION_DDOT, in m**2/kg.\n";
  if (!who.source.empty()) comment += "SOURCE " + who.source + "\n";
  comment += "FIT_INTERVAL " + formatInstant(f.fitStart, 3) + " " + formatInstant(f.fitStop, 3) + "\n";
  comment += statLine("FIT", fit.fit);
  if (f.haveHeld && fit.heldOut.count > 0) comment += "\n" + statLine("HELD_OUT", fit.heldOut);
  omm->COMMENT = comment;
  addParameter(omm.get(), "FIT_START", formatInstant(f.fitStart, 3), 0);
  addParameter(omm.get(), "FIT_STOP", formatInstant(f.fitStop, 3), 0);
  addParameter(omm.get(), "FIT_STATES", std::to_string(fit.fit.count), 0);
  addParameter(omm.get(), "FIT_RMS_KM", number(fit.fit.rms), 0);
  addParameter(omm.get(), "FIT_MAX_KM", number(fit.fit.max), 0);
  addParameter(omm.get(), "FIT_RADIAL_RMS_KM", number(fit.fit.radial), 0);
  addParameter(omm.get(), "FIT_ALONG_TRACK_RMS_KM", number(fit.fit.along), 0);
  addParameter(omm.get(), "FIT_CROSS_TRACK_RMS_KM", number(fit.fit.cross), 0);
  addParameter(omm.get(), "FIT_ITERATIONS", std::to_string(fit.iterations), 0);
  addParameter(omm.get(), "FIT_CONVERGED", fit.converged ? "true" : "false", 0);
  addParameter(omm.get(), "FIT_FIRST_PASS_RMS_KM", number(fit.firstPassRms), 0);
  addParameter(omm.get(), "FIT_RMS_BEFORE_LATTICE_KM", number(fit.rmsBeforeLattice), 0);
  if (f.haveHeld && fit.heldOut.count > 0) {
    addParameter(omm.get(), "HELD_OUT_STOP", formatInstant(f.heldStop, 3), 0);
    addParameter(omm.get(), "HELD_OUT_STATES", std::to_string(fit.heldOut.count), 0);
    addParameter(omm.get(), "HELD_OUT_RMS_KM", number(fit.heldOut.rms), 0);
    addParameter(omm.get(), "HELD_OUT_MAX_KM", number(fit.heldOut.max), 0);
    for (const DayStatistics& d : fit.heldOutDays) {
      addParameter(omm.get(), "HELD_OUT_DAY" + std::to_string(d.day) + "_RMS_KM", number(d.statistics.rms), 0);
      addParameter(omm.get(), "HELD_OUT_DAY" + std::to_string(d.day) + "_STATES", std::to_string(d.statistics.count), 0);
    }
  }
  addParameter(omm.get(), "LIBRARY", "US Space Force Sgp4Prop 9.1.1.0 XP", 0);
  return omm;
}

inline std::unique_ptr<OBDT> obdOf(const IntervalFit& f, const Provenance& who, const std::string& product) {
  const FitResult& fit = f.result;
  auto obd = std::make_unique<OBDT>();
  // The object's NORAD number names it; a source with none (the OD node gives it 99999) is named by what it calls it.
  const std::string subject = (who.norad != 0 && who.norad != 99999) || who.name.empty() ? std::to_string(who.norad) : who.name;
  obd->ID = subject + "-" + formatInstant(epochOf(fit.elements), 3) + "-SGP4XP";
  obd->SAT_NO = who.norad;
  obd->ORIG_OBJECT_ID = who.id;
  obd->START_TIME = formatInstant(f.fitStart, 3);
  obd->END_TIME = formatInstant(f.fitStop, 3);
  obd->METHOD = odMethod::BATCH_LEAST_SQUARES;
  obd->METHOD_SOURCE = product + ": Levenberg-Marquardt on TEME position residuals; fitted to " +
                       (who.originator.empty() ? "an unnamed source" : who.originator) + (who.source.empty() ? "" : " (" + who.source + ")");
  obd->INITIAL_OD = false;
  obd->LAST_OB_START = obd->START_TIME;
  obd->LAST_OB_END = obd->END_TIME;
  obd->TIME_SPAN = secondsBetween(f.fitStop, f.fitStart) / kSecondsPerDay;
  obd->FIT_SPAN = obd->TIME_SPAN;
  obd->EFFECTIVE_FROM = formatInstant(epochOf(fit.elements), 3);
  obd->EFFECTIVE_UNTIL = formatInstant(f.haveHeld && fit.heldOut.count > 0 ? f.heldStop : f.fitStop, 3);
  obd->WRMS = fit.fit.rms;                // km, 3D, every state weighted alike
  obd->FIRST_PASS_WRMS = fit.firstPassRms;
  obd->BEST_PASS_WRMS = fit.fit.rms;
  if (f.haveHeld && fit.heldOut.count > 0 && !fit.heldOutDays.empty()) {
    // km/day: the held-out error at its last day, per day after the end of the fit interval.
    const DayStatistics& last = fit.heldOutDays.back();
    obd->ERROR_GROWTH_RATE = last.statistics.rms / static_cast<double>(last.day);
  }
  obd->BALLISTIC_COEFF_EST = true;
  obd->BALLISTIC_COEFF_MODEL = "SGP4-XP BTERM, m**2/kg";
  obd->AGOM_EST = true;
  obd->AGOM_MODEL = "SGP4-XP AGOM, m**2/kg";
  obd->RMS_CONVERGENCE_CRITERIA = 1.0e-9;
  obd->NUM_ITERATIONS = static_cast<uint16_t>(std::min(fit.iterations, 65535));
  obd->NUM_ACCEPTED_OBS = static_cast<uint32_t>(fit.fit.count);
  obd->NUM_REJECTED_OBS = 0;
  auto contribution = std::make_unique<odSensorContributionT>();
  contribution->SENSOR_ID = !who.source.empty() ? who.source : (who.originator.empty() ? "ephemeris" : who.originator);
  contribution->NUM_ACCEPTED = static_cast<uint32_t>(fit.fit.count);
  contribution->WRMS = fit.fit.rms;
  contribution->OB_TYPES.push_back("EPHEMERIS_POSITION");
  obd->SENSORS.push_back(std::move(contribution));
  obd->ACCEPTED_OB_TYPS.push_back("EPHEMERIS_POSITION");
  return obd;
}

}  // namespace sgp4xp
