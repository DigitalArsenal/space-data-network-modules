#include "products.hpp"

#include <cmath>
#include <cstdio>
#include <memory>
#include <string>

#include "od/obd_fb_builder.h"
#include "od/omm_fb_builder.h"

#ifdef SING
#undef SING
#endif
#ifdef DOMAIN
#undef DOMAIN
#endif
#ifdef OVERFLOW
#undef OVERFLOW
#endif
#ifdef UNDERFLOW
#undef UNDERFLOW
#endif
#ifdef TLOSS
#undef TLOSS
#endif
#ifdef PLOSS
#undef PLOSS
#endif
#include "OBD_generated.h"
#include "OCM_generated.h"
#include "OMM_generated.h"

namespace odhpop {

namespace {

std::string num(double x, const char* fmt = "%.9g") {
  char b[64];
  std::snprintf(b, sizeof b, fmt, x);
  return b;
}

void put(std::vector<std::unique_ptr<UserDefinedParametersT>>& v, const std::string& name, const std::string& value) {
  auto p = std::make_unique<UserDefinedParametersT>();
  p->PARAM_NAME = name;
  p->PARAM_VALUE = value;
  v.push_back(std::move(p));
}

void put_stats(std::vector<std::unique_ptr<UserDefinedParametersT>>& v, const std::string& prefix, const ResidualStats& s) {
  put(v, prefix + "_N", std::to_string(s.n));
  put(v, prefix + "_START", format_iso_utc(s.start, 6));
  put(v, prefix + "_SPAN_S", num(s.span_s, "%.3f"));
  put(v, prefix + "_RMS_3D_KM", num(s.rms_3d_km));
  put(v, prefix + "_RMS_R_KM", num(s.rms_r_km));
  put(v, prefix + "_RMS_T_KM", num(s.rms_t_km));
  put(v, prefix + "_RMS_N_KM", num(s.rms_n_km));
  put(v, prefix + "_MAX_3D_KM", num(s.max_3d_km));
  put(v, prefix + "_RMS_PER_COORDINATE_KM", num(s.rms_per_coordinate_km));
}

void put_closure(std::vector<std::unique_ptr<UserDefinedParametersT>>& v, const std::string& prefix, const ClosureResult& c) {
  if (!c.done) {
    put(v, prefix + "_CLOSURE", "UNAVAILABLE " + c.error);
    return;
  }
  put(v, prefix + "_CLOSURE_SPLIT_EPOCH", format_iso_utc(c.split, 6));
  put_stats(v, prefix + "_HALF_FIT", c.first_half);
  put_stats(v, prefix + "_CLOSURE", c.second_half);
  put(v, prefix + "_CLOSURE_MAX_R_KM", num(c.max_r_km));
  put(v, prefix + "_CLOSURE_MAX_T_KM", num(c.max_t_km));
  put(v, prefix + "_CLOSURE_MAX_N_KM", num(c.max_n_km));
}

std::string stats_comment(const char* what, const ResidualStats& s) {
  char b[320];
  std::snprintf(b, sizeof b,
                "%s exact residuals over every ephemeris point (TEME, km): N=%zu SPAN_S=%.0f RMS_3D=%.6f "
                "RMS_PER_COORDINATE=%.6f R=%.6f T=%.6f N=%.6f MAX=%.6f",
                what, s.n, s.span_s, s.rms_3d_km, s.rms_per_coordinate_km, s.rms_r_km, s.rms_t_km, s.rms_n_km,
                s.max_3d_km);
  return b;
}

std::vector<uint8_t> finish_ocm(OCMT& ocm) {
  flatbuffers::FlatBufferBuilder fbb(8192);
  FinishSizePrefixedOCMBuffer(fbb, OCM::Pack(fbb, &ocm));
  return std::vector<uint8_t>(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
}

std::string force_text(const ForceModel& f) {
  return std::string("EGM2008 ") + std::to_string(f.degree) + "x" + std::to_string(f.order);
}

}  // namespace

Products build_products(const OperatorFitResult& r, const OperatorFitOptions& o, const std::string& creation_date) {
  Products p;
  if (!r.ok) return p;
  const std::string originator = "SDN-OD";
  // ---- SGP4 OMM -------------------------------------------------------------
  {
    od::SGP4Elements el = r.sgp4.elements;
    el.rms_km = r.sgp4.stats.rms_3d_km;
    p.omm = od::build_omm_flatbuffer(el, originator, creation_date);
    // COMMENT: the exact statistics (the OMM table has no RMS field).
    flatbuffers::Verifier vf(p.omm.data(), p.omm.size());
    if (VerifySizePrefixedOMMBuffer(vf)) {
      OMMT t;
      GetSizePrefixedOMM(p.omm.data())->UnPackTo(&t);
      std::string c = stats_comment("SGP4 least-squares fit;", r.sgp4.stats);
      if (r.sgp4.has_reference) c += "; " + stats_comment("REFERENCE OMM on the same points;", r.sgp4.reference);
      if (!o.data_source.empty()) c += "; DATA_SOURCE=" + o.data_source;
      c += "; SOURCE_SHA256=" + r.raw_sha256;
      t.COMMENT = c;
      flatbuffers::FlatBufferBuilder fbb(1024);
      FinishSizePrefixedOMMBuffer(fbb, OMM::Pack(fbb, &t));
      p.omm.assign(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
    }
    p.obd_sgp4 = od::build_obd_flatbuffer(el, r.sgp4.stats.span_s / 86400.0, "SDN-OD SGP4 exact-window least squares");
  }
  if (!r.hpop.ok) return p;
  const HpopResult& h = r.hpop;
  const Solution& s = h.fit.solution;
  const ForceModel& f = s.forces;
  const std::string epoch = format_iso_utc(s.epoch, 6);
  // ---- HPOP OCM ---------------------------------------------------------------
  OCMT ocm;
  ocm.HEADER = std::make_unique<HeaderT>();
  ocm.HEADER->CCSDS_OCM_VERS = "3.0";
  ocm.HEADER->ORIGINATOR = originator;
  ocm.HEADER->CREATION_DATE = creation_date;
  ocm.METADATA = std::make_unique<MetadataT>();
  auto& m = *ocm.METADATA;
  m.OBJECT_NAME = r.object_name;
  m.INTERNATIONAL_DESIGNATOR = r.object_id;
  if (r.norad_cat_id > 0) m.CATALOG_NAME = std::to_string(r.norad_cat_id);
  m.TIME_SYSTEM = "UTC";
  m.EPOCH_TZERO = epoch;
  m.START_TIME = epoch;
  m.STOP_TIME = epoch;
  m.CELESTIAL_SOURCE = "JPL DE440";
  m.EOP_SOURCE = "IERS finals2000A (caller earth_orientation rows)";
  m.COMMENT.push_back("Full-force HPOP least-squares fit to an operator ephemeris held in memory only; the ephemeris is not stored.");
  ocm.CENTER_NAME = "EARTH";
  ocm.TRAJ_TYPE = trajectoryType::CARTESIAN_PV;
  ocm.TRAJ_TYPE_DESCRIPTION = "ESTIMATED";
  ocm.STATE_VECTOR_SIZE = 6;
  for (int i = 0; i < 6; ++i) ocm.STATE_DATA.push_back(s.state[i] * 1e-3);
  ocm.STATE_EPOCHS.push_back(epoch);
  // Lower triangle of the 6x6 state covariance, km and km/s (scaled formal).
  const std::size_t n = 6 + s.params.size();
  const auto& cov = h.fit.scaled_covariance.size() == n * n ? h.fit.scaled_covariance : h.fit.covariance;
  if (cov.size() == n * n)
    for (int i = 0; i < 6; ++i)
      for (int j = 0; j <= i; ++j) ocm.COVARIANCE_DATA.push_back(cov[i * n + j] * 1e-6);
  ocm.COV_CALIBRATION = covarianceCalibration::Uncalibrated;
  ocm.PERTURBATIONS = std::make_unique<PerturbationsT>();
  auto& pt = *ocm.PERTURBATIONS;
  pt.GRAVITY_MODEL = "EGM2008";
  pt.GRAVITY_DEGREE = f.degree;
  pt.GRAVITY_ORDER = f.order;
  pt.GM = f.gm * 1e-9;
  if (f.sun) pt.N_BODY_PERTURBATIONS.push_back("SUN");
  if (f.moon) pt.N_BODY_PERTURBATIONS.push_back("MOON");
  if (f.venus) pt.N_BODY_PERTURBATIONS.push_back("VENUS");
  if (f.mars) pt.N_BODY_PERTURBATIONS.push_back("MARS");
  if (f.jupiter) pt.N_BODY_PERTURBATIONS.push_back("JUPITER");
  pt.OCEAN_TIDES_MODEL = f.ocean_tide_degree >= 2 ? "FES2004 " + std::to_string(f.ocean_tide_degree) + "x" + std::to_string(f.ocean_tide_degree) : "NONE";
  pt.SOLID_TIDES_MODEL = f.solid_tides ? "IERS2010" : "NONE";
  pt.SOLAR_RAD_PRESSURE = !f.srp ? "NONE" : std::string(f.srp_model == SrpModel::CANNONBALL ? "CANNONBALL" : "GNSS BOX-WING") + ", CONICAL SHADOW" + (f.ecom2 ? " + ECOM2" : "");
  pt.ALBEDO = f.earth_radiation && f.srp ? "KNOCKE " + num(f.earth_radiation_resolution_deg, "%.0f") + " DEG" : "NONE";
  pt.THERMAL = f.earth_radiation && f.srp ? "KNOCKE INFRARED" : "NONE";
  pt.RELATIVITY = f.relativity ? "IERS2010 (SCHWARZSCHILD, LENSE-THIRRING, DE SITTER)" : "NONE";
  pt.ATMOSPHERIC_DRAG = !f.drag ? "NONE" : f.atmosphere == Atmosphere::JB2008 ? "JB2008 (SET indices)" : "NRLMSISE-00 (CSSI daily space weather)";
  pt.COMMENT.push_back(force_text(f) + " in ITRF via IERS 2010 CIO chain; integrator RK7(8), relative tolerance 1e-13.");
  ocm.ORBIT_DETERMINATION = std::make_unique<OrbitDeterminationT>();
  auto& od = *ocm.ORBIT_DETERMINATION;
  od.OD_ID = r.raw_sha256.substr(0, 16) + "-HPOP";
  od.OD_ALGORITHM = "BATCH WEIGHTED LEAST SQUARES (estimation fit_batch v2, Levenberg-Marquardt, bounds)";
  od.OD_METHOD = "FULL-FORCE HPOP FIT TO OPERATOR EPHEMERIS POSITIONS";
  od.OD_EPOCH = epoch;
  od.OD_OBSERVATIONS_TYPE.push_back("POSITION");
  od.OD_OBSERVATIONS_USED = static_cast<int32_t>(h.fit.fit_points);
  od.OD_DATA_WEIGHTING = "EQUAL, 1 m per axis";
  od.OD_CONVERGENCE_CRITERIA = "sqrt(dx' N dx / n) < 1e-3; iterations " + std::to_string(h.fit.iterations) +
                               (h.fit.converged ? "; converged" : "; not converged");
  od.OD_COV_REDUCTION = "FORMAL (J'WJ)^-1 SCALED BY REDUCED CHI-SQUARE";
  for (const auto& q : s.params) od.OD_EST_PARAMETERS.push_back(param_name(q.id));
  od.OD_ESTIMATOR = estimatorCategory::BatchLeastSquares;
  od.OD_RESIDUAL_RMS = h.stats.rms_3d_km;
  od.WEIGHTED_RMS = h.fit.weighted_rms;
  od.OD_RESIDUALS = stats_comment("HPOP", h.stats);
  auto& u = ocm.USER_DEFINED_PARAMETERS;
  put(u, "STATE_REFERENCE_FRAME", "GCRF");
  put(u, "SOURCE_SHA256", r.raw_sha256);
  put(u, "SOURCE_BYTES", std::to_string(r.raw_bytes));
  put(u, "SOURCE_FORMAT", r.format);
  put(u, "SOURCE_FRAME", r.source_frame);
  put(u, "SOURCE_TIME_SYSTEM", r.time_system);
  if (!o.data_source.empty()) put(u, "DATA_SOURCE", o.data_source);
  for (std::size_t j = 0; j < s.params.size(); ++j) {
    const double sigma = cov.size() == n * n ? std::sqrt(std::max(0.0, cov[(6 + j) * n + 6 + j])) : NAN;
    put(u, std::string("PARAM_") + param_name(s.params[j].id), num(s.params[j].value, "%.12g"));
    put(u, std::string("PARAM_") + param_name(s.params[j].id) + "_SIGMA", num(sigma, "%.6g"));
    if (j < h.fit.bound_status.size() && h.fit.bound_status[j])
      put(u, std::string("PARAM_") + param_name(s.params[j].id) + "_AT_BOUND", h.fit.bound_status[j] == 1 ? "LOWER" : "UPPER");
  }
  put(u, "PARAM_UNITS", "B, AGOM: m2/kg (Cd*A/m, Cr*A/m); IN_TRACK, ECOM2: m/s2");
  put(u, "HPOP_ITERATIONS", std::to_string(h.fit.iterations));
  put(u, "HPOP_CONVERGED", h.fit.converged ? "TRUE" : "FALSE");
  put(u, "HPOP_FIT_POINTS", std::to_string(h.fit.fit_points));
  put_stats(u, "HPOP", h.stats);
  put_closure(u, "HPOP", h.closure);
  for (std::size_t k = 0; k < h.segment.evidence.size(); ++k) put(u, "HPOP_SEGMENT_" + std::to_string(k), h.segment.evidence[k]);
  put(u, "SGP4_EPOCH", format_iso_utc(r.sgp4.epoch, 6));
  put_stats(u, "SGP4", r.sgp4.stats);
  put_closure(u, "SGP4", r.sgp4.closure);
  if (r.sgp4.has_reference) {
    put_stats(u, "REFERENCE", r.sgp4.reference);
    put(u, "REFERENCE_GATE", r.sgp4.reference_gate_pass ? "PASS" : "FAIL");
    put(u, "REFERENCE_GATE_MAX_KM", num(o.reference_rms_max_km));
  }
  p.ocm = finish_ocm(ocm);
  // ---- HPOP OBD ---------------------------------------------------------------
  {
    OBDT b;
    b.SAT_NO = static_cast<uint32_t>(std::max(0, r.norad_cat_id));
    b.ORIG_OBJECT_ID = r.object_id;
    b.METHOD = odMethod::BATCH_LEAST_SQUARES;
    b.METHOD_SOURCE = "SDN-OD full-force HPOP (estimation fit_batch v2)";
    b.INITIAL_OD = false;
    b.START_TIME = format_iso_utc(h.stats.start, 6);
    b.END_TIME = format_iso_utc(h.stats.stop, 6);
    b.EFFECTIVE_FROM = epoch;
    b.FIT_SPAN = h.stats.span_s / 86400.0;
    b.TIME_SPAN = h.stats.span_s / 86400.0;
    b.WRMS = h.stats.rms_3d_km;
    b.BEST_PASS_WRMS = h.stats.rms_3d_km;
    b.FIRST_PASS_WRMS = h.stats.rms_3d_km;
    for (const auto& q : s.params) {
      if (q.id == Param::B) b.BALLISTIC_COEFF_EST = true;
      if (q.id == Param::AGOM) b.AGOM_EST = true;
    }
    b.BALLISTIC_COEFF_MODEL = f.drag ? pt.ATMOSPHERIC_DRAG : "NONE";
    b.AGOM_MODEL = pt.SOLAR_RAD_PRESSURE;
    b.RMS_CONVERGENCE_CRITERIA = 1e-3;
    b.NUM_ITERATIONS = static_cast<uint16_t>(std::max(0, h.fit.iterations));
    b.NUM_ACCEPTED_OBS = static_cast<uint32_t>(h.fit.fit_points);
    b.ACCEPTED_OB_TYPS.push_back("POSITION");
    flatbuffers::FlatBufferBuilder fbb(1024);
    FinishSizePrefixedOBDBuffer(fbb, OBD::Pack(fbb, &b));
    p.obd_hpop.assign(fbb.GetBufferPointer(), fbb.GetBufferPointer() + fbb.GetSize());
  }
  return p;
}

bool read_reference_omm(const uint8_t* bytes, std::size_t size, Reference* out, std::string* error) {
  const OMM* omm = nullptr;
  if (size >= 8 && OMMBufferHasIdentifier(bytes + 4)) {
    flatbuffers::Verifier v(bytes, size);
    if (VerifySizePrefixedOMMBuffer(v)) omm = GetSizePrefixedOMM(bytes);
  } else if (size >= 8 && OMMBufferHasIdentifier(bytes)) {
    flatbuffers::Verifier v(bytes, size);
    if (VerifyOMMBuffer(v)) omm = GetOMM(bytes);
  }
  if (!omm) {
    *error = "reference is not a verifiable $OMM";
    return false;
  }
  if (!omm->EPOCH() || !parse_iso_utc(omm->EPOCH()->str(), &out->epoch)) {
    *error = "reference OMM EPOCH is not ISO 8601 UTC";
    return false;
  }
  od::SGP4Elements& el = out->elements;
  el.epoch_iso = omm->EPOCH()->str();
  el.epoch_jd = jd_single(out->epoch);
  el.mean_motion = omm->MEAN_MOTION();
  el.eccentricity = omm->ECCENTRICITY();
  el.inclination = omm->INCLINATION();
  el.ra_of_asc_node = omm->RA_OF_ASC_NODE();
  el.arg_of_pericenter = omm->ARG_OF_PERICENTER();
  el.mean_anomaly = omm->MEAN_ANOMALY();
  el.bstar = omm->BSTAR();
  el.mean_motion_dot = omm->MEAN_MOTION_DOT();
  el.mean_motion_ddot = omm->MEAN_MOTION_DDOT();
  el.norad_cat_id = static_cast<int>(omm->NORAD_CAT_ID());
  if (omm->OBJECT_NAME()) el.object_name = omm->OBJECT_NAME()->str();
  if (omm->OBJECT_ID()) el.object_id = omm->OBJECT_ID()->str();
  if (!(el.mean_motion > 0)) {
    *error = "reference OMM has no mean motion";
    return false;
  }
  out->present = true;
  return true;
}

}  // namespace odhpop
