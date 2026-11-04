// propagator/sgp4-xp: an SGP4-XP element set as one SDS $OCM (SDS 1.276.0): MEAN_ELEMENTS (MEAN_ELEMENT_THEORY
// SGP4XP, Brouwer MEAN_MOTION, BTERM and AGOM in m**2/kg), PERTURBATIONS the theory's own forces (ATMOSPHERIC_MODEL
// {JXX,1970}, WEATHER_SOURCE THEORY_FLUX_MODEL, DENSITY_CORRECTION NONE, both caps 0, GRAVITY_MODEL EGM-96: the
// library's XP uses EGM-96 whatever Earth model is selected, Release Notes 8.1), METADATA.NORAD_CAT_ID, TRAJ_REF_FRAME
// TEMEOFDATE, ORB_AVERAGING BROUWER, STATE_DATA empty; from a fit also ORBIT_DETERMINATION with FIT_STATISTICS and
// PROVENANCE (the library in PRODUCER). Every field typed; the free-form parameter list stays empty.
//
// Written with the object API of the SDS pin the including translation unit holds: this module's, and the OD node's
// of flows/supplemental-omm.
#pragma once

#include <memory>
#include <string>
#include <utility>

#include "engine.hpp"

namespace sgp4xp {

// Who an element set describes and where it came from: the source of the ephemeris it was fitted to.
struct Provenance {
  std::string originator;  // HEADER.ORIGINATOR and PROVENANCE.ORIGINATOR: who produced the ephemeris
  std::string creation;    // HEADER.CREATION_DATE; the end of the fit when empty
  std::string name, id;    // METADATA.OBJECT_NAME, INTERNATIONAL_DESIGNATOR
  std::string source;      // PROVENANCE.SOURCE_ID: the feed (the module that read it), when known
  uint32_t norad = 0;
};

// Who made a record: PROVENANCE.PROVIDER_ID and PRODUCER (the program and the library under it).
struct Producer {
  std::string provider, product;
};

inline std::unique_ptr<RFMT> temeReferenceFrame() {
  auto rfm = std::make_unique<RFMT>();
  CelestialFrameWrapperT wrapper;
  wrapper.frame = CelestialFrame::TEMEOFDATE;
  rfm->REFERENCE_FRAME.Set(std::move(wrapper));
  rfm->NAME = "TEMEOFDATE";
  return rfm;
}

// The $OCM of a stock SGP4-XP element set, without orbit determination or provenance.
inline std::unique_ptr<OCMT> elementSetOf(const Elements& e, const Provenance& who) {
  auto ocm = std::make_unique<OCMT>();
  ocm->HEADER = std::make_unique<HeaderT>();
  ocm->HEADER->CCSDS_OCM_VERS = "3.0";
  ocm->HEADER->CREATION_DATE = who.creation;
  ocm->HEADER->ORIGINATOR = who.originator.empty() ? "UNKNOWN" : who.originator;
  ocm->METADATA = std::make_unique<MetadataT>();
  ocm->METADATA->OBJECT_NAME = who.name;
  ocm->METADATA->INTERNATIONAL_DESIGNATOR = who.id;
  if (who.norad != 0) {
    ocm->METADATA->CATALOG_NAME = "NORAD";
    ocm->METADATA->OBJECT_DESIGNATOR = std::to_string(who.norad);
    ocm->METADATA->NORAD_CAT_ID = who.norad;
  }
  ocm->METADATA->TIME_SYSTEM = "UTC";
  ocm->CENTER_NAME = "EARTH";
  ocm->TRAJ_REF_FRAME = temeReferenceFrame();
  ocm->ORB_AVERAGING = "BROUWER";
  if (e.revNumber > 0) ocm->ORB_REVNUM = static_cast<uint32_t>(e.revNumber);
  auto me = std::make_unique<OCMMeanElementsT>();
  me->MEAN_ELEMENT_THEORY = meanElementSource::SGP4XP;
  me->EPOCH = formatInstant(epochOf(e));
  me->MEAN_MOTION = e.meanMotion;
  me->ECCENTRICITY = e.eccentricity;
  me->INCLINATION = e.inclination;
  me->RA_OF_ASC_NODE = e.raan;
  me->ARG_OF_PERICENTER = e.argPerigee;
  me->MEAN_ANOMALY = e.meanAnomaly;
  me->BTERM = e.drag;  // m^2/kg
  me->AGOM = e.agom;   // m^2/kg
  ocm->MEAN_ELEMENTS = std::move(me);
  auto pt = std::make_unique<PerturbationsT>();
  pt->ATMOSPHERIC_MODEL = std::make_unique<ATMT>();
  pt->ATMOSPHERIC_MODEL->MODEL = AtmosphericModelFamily::JXX;
  pt->ATMOSPHERIC_MODEL->YEAR = 1970;
  pt->GRAVITY_MODEL = "EGM-96";
  pt->MAXIMUM_TESSERAL_DEGREE = 0;
  pt->MAXIMUM_ZONAL_DEGREE = 0;
  pt->WEATHER_SOURCE = pcfWeatherSource::THEORY_FLUX_MODEL;
  pt->DENSITY_CORRECTION = pcfDensityCorrection::NONE;
  ocm->PERTURBATIONS = std::move(pt);
  return ocm;
}

inline std::unique_ptr<OCMDynamicParameterT> dynamicParameter(const char* name, double value, bool solved, prwDynamicParameter kind) {
  auto p = std::make_unique<OCMDynamicParameterT>();
  p->NAME = name;
  p->VALUE = value;
  p->UNITS = "m**2/kg";
  p->SOLVED_FOR = solved;
  p->PARAMETER = kind;
  return p;
}

// The $OCM of a fitted window: the set, the orbit determination with its FIT_STATISTICS, and PROVENANCE.
inline std::unique_ptr<OCMT> ocmOf(const IntervalFit& f, const Provenance& who, const Producer& by) {
  const FitResult& fit = f.result;
  Provenance named = who;
  if (named.creation.empty()) named.creation = formatInstant(f.fitStop, 3);
  auto ocm = elementSetOf(fit.elements, named);
  const bool held = f.haveHeld && fit.heldOut.count > 0;

  auto fs = std::make_unique<OCMFitStatisticsT>();
  fs->FIT_STATES = static_cast<uint32_t>(fit.fit.count);
  fs->FIT_RMS_KM = fit.fit.rms;
  fs->FIT_MAX_KM = fit.fit.max;
  fs->FIT_RADIAL_RMS_KM = fit.fit.radial;
  fs->FIT_IN_TRACK_RMS_KM = fit.fit.along;
  fs->FIT_CROSS_TRACK_RMS_KM = fit.fit.cross;
  fs->ITERATIONS = static_cast<uint32_t>(fit.iterations);
  fs->CONVERGED = fit.converged;
  fs->FIT_START = formatInstant(f.fitStart, 3);
  fs->FIT_STOP = formatInstant(f.fitStop, 3);
  if (held) {
    fs->HELD_OUT_STOP = formatInstant(f.heldStop, 3);
    fs->HELD_OUT_STATES = static_cast<uint32_t>(fit.heldOut.count);
    fs->HELD_OUT_RMS_KM = fit.heldOut.rms;
    fs->HELD_OUT_MAX_KM = fit.heldOut.max;
    for (const DayStatistics& d : fit.heldOutDays) {
      auto day = std::make_unique<OCMHeldOutDayT>();
      day->DAY = static_cast<uint16_t>(d.day);
      day->STATES = static_cast<uint32_t>(d.statistics.count);
      day->RMS_KM = d.statistics.rms;
      fs->HELD_OUT_DAYS.push_back(std::move(day));
    }
  }

  // BTERM and AGOM are solved for on an arc of about a day or more (fit.hpp); a shorter arc leaves them at zero.
  const bool solved = fit.dragSolved;
  auto od = std::make_unique<OrbitDeterminationT>();
  od->OD_METHOD = "BATCH LEAST SQUARES";
  od->OD_ALGORITHM = "LEVENBERG-MARQUARDT ON TEME POSITION RESIDUALS, UNIT WEIGHTS, THEN THE LATTICE OF THE TWO-LINE TEXT'S DIGITS";
  od->OD_ESTIMATOR = estimatorCategory::BatchLeastSquares;
  od->OD_EPOCH = ocm->MEAN_ELEMENTS->EPOCH;
  od->OD_OBSERVATIONS_USED = static_cast<int32_t>(fit.fit.count);
  od->OD_EST_PARAMETERS = {"MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY"};
  if (solved) {
    od->OD_EST_PARAMETERS.push_back("DRAG_AREA_OVER_MASS");
    od->OD_EST_PARAMETERS.push_back("SRP_AREA_OVER_MASS");
  }
  od->OD_DYNAMIC_PARAMETERS.push_back(dynamicParameter("DRAG_AREA_OVER_MASS", fit.elements.drag, solved, prwDynamicParameter::DRAG_AREA_OVER_MASS));
  od->OD_DYNAMIC_PARAMETERS.push_back(dynamicParameter("SRP_AREA_OVER_MASS", fit.elements.agom, solved, prwDynamicParameter::SRP_AREA_OVER_MASS));
  // CCSDS elapsed counts from the epoch back to the first and last state fitted, written when not negative.
  const double sinceFirst = secondsBetween(epochOf(fit.elements), f.fitStart) / kSecondsPerDay;
  const double sinceLast = secondsBetween(epochOf(fit.elements), f.fitStop) / kSecondsPerDay;
  if (sinceFirst >= 0) od->DAYS_SINCE_FIRST_OBS = sinceFirst;
  if (sinceLast >= 0) od->DAYS_SINCE_LAST_OBS = sinceLast;
  od->ACTUAL_OD_SPAN = secondsBetween(f.fitStop, f.fitStart) / kSecondsPerDay;
  od->FIT_STATISTICS = std::move(fs);
  ocm->ORBIT_DETERMINATION = std::move(od);

  ocm->PROVENANCE = std::make_unique<PVNT>();
  if (!who.source.empty()) ocm->PROVENANCE->SOURCE_ID = who.source;
  if (!who.originator.empty()) ocm->PROVENANCE->ORIGINATOR = who.originator;
  ocm->PROVENANCE->PROVIDER_ID = by.provider;
  ocm->PROVENANCE->PRODUCER = by.product;
  return ocm;
}

}  // namespace sgp4xp
