// Public conjunction contract: published SDS CQR records on the SDK invoke ABI.
// The SDK owns PIV/TAB framing, manifest embedding, memory and runtime
// entrypoints.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <flatbuffers/flatbuffers.h>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <tuple>
#include <vector>
#ifdef SING
#undef SING
#endif
#ifdef DOMAIN
#undef DOMAIN
#endif
#include "CQR_generated.h"
#include "space_data_module_invoke.h"
extern "C" int32_t plugin_set_output_stream_frame(uint32_t, uint64_t, int32_t);
#include "conjunction/conjunction_assessment.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/ephemeris_source.h"
#include "conjunction/error_status.h"
#include "conjunction/gp_json.h"
#include "conjunction/resident_screening_index.h"
#include "conjunction/screening.h"
#include "conjunction/screening_tight.h"
#include "conjunction/time_scales.h"
#include <atomic>
#include <thread>

namespace ca_cqr {
using namespace conjunction;
constexpr size_t kEventsPerChunk = 128;
constexpr size_t kMaximumPendingEvents = 16384;
constexpr size_t kMaximumPendingStreams = 8;
constexpr size_t kMaximumRetainedRequestBytes = 32 * 1024 * 1024;
constexpr size_t kMaximumDocumentBytes = 16 * 1024 * 1024;
// The manifest's `excluded` port maxStreams.
constexpr size_t kMaximumExcludedFrames = 65535;
std::string text(const flatbuffers::String *s) {
  return s ? s->str() : std::string();
}
bool error(const char *code, const std::string &detail) {
  plugin_set_error(code, detail.c_str());
  return false;
}
bool isFinite(double x) { return std::isfinite(x); }
bool positive(double x) { return isFinite(x) && x > 0; }
// Midpoint +/- duration and directly parsed endpoint may differ by up to two
// binary64 representable Julian dates (about 80 microseconds near 2026).
double epochRounding(double jd) {
  return 2 * (std::nextafter(jd, std::numeric_limits<double>::infinity()) - jd);
}
const plugin_input_frame_t *input(const char *port, uint32_t ordinal = 0) {
  auto i = plugin_find_input_index(port, ordinal);
  return i < 0 ? nullptr : plugin_get_input_frame(i);
}
template <class T>
const T *decode(const plugin_input_frame_t *f, const char *id) {
  if (!f || !f->payload || f->payload_length < 8) {
    error("invalid-request-frame",
          "Missing or empty canonical FlatBuffer input.");
    return nullptr;
  }
  flatbuffers::Verifier v(f->payload, f->payload_length);
  if (!v.VerifyBuffer<T>(id)) {
    error("invalid-request-frame",
          "Published SDS FlatBuffer verification failed.");
    return nullptr;
  }
  return flatbuffers::GetRoot<T>(f->payload);
}
const CQR *request(const char *port = "request") {
  conjunction::clear_error();
  auto q = decode<CQR>(input(port), "$CQR");
  if (!q)
    return nullptr;
  unsigned n =
      !!q->PAIR_REQUEST() + !!q->CATALOG_REQUEST() +
      !!q->PROBABILITY_REQUEST() + !!q->PROBABILITY_RESULT() +
      !!q->ALFANO_REQUEST() + !!q->ALFANO_RESULT() + !!q->EVENT_RESULT() +
      !!q->TCA_RESULT() + !!q->CATALOG_RESULT() + !!q->NATIVE_DOCUMENT() +
      !!q->INDEX_REQUEST() + !!q->INDEX_RESULT() + !!q->WINDOW_REQUEST() +
      !!q->DESTROY_REQUEST() + q->VERSION_QUERY() + !!q->VERSION_RESULT();
  if (n != 1) {
    error("invalid-request-arm",
          "CQR must contain exactly one payload arm matching METHOD_ID.");
    return nullptr;
  }
  return q;
}
bool pushBytes(const char *port, const char *schema, const char *id,
               const char *root, const uint8_t *p, size_t n) {
  return plugin_push_output_ex(port, schema, id, 0, root, 0, 0, p,
                               static_cast<uint32_t>(n)) >= 0;
}
bool push(CQRT &q, const char *port = "result", uint64_t sequence = 0,
          bool final = true) {
  if (conjunction::has_error())
    return error("evaluation-failed", conjunction::error_message());
  flatbuffers::FlatBufferBuilder b(2048);
  auto root = CQR::Pack(b, &q);
  FinishCQRBuffer(b, root);
  int i = plugin_push_output_ex(port, "CQR.fbs", "$CQR", 0, "CQR", 0, 0,
                                b.GetBufferPointer(), b.GetSize());
  if (i < 0)
    return false;
  plugin_set_output_stream_frame(i, sequence, final ? 1 : 0);
  return true;
}
std::unique_ptr<TIMInstantT> instant(double jd) {
  auto t = std::make_unique<TIMInstantT>();
  t->TIME_SYSTEM = timingStandard::UTC;
  t->EPOCH_FORMAT = timEpochRepresentation::JULIAN_DATE;
  t->JULIAN_DATE = jd;
  return t;
}
bool epoch(const TIMInstant *t, double &jd) {
  if (!t || t->TIME_SYSTEM() != timingStandard::UTC)
    return error("unsupported-time-system",
                 "Conjunction screening requires explicit UTC; resolve other "
                 "time systems through TIM first.");
  switch (t->EPOCH_FORMAT()) {
  case timEpochRepresentation::JULIAN_DATE:
    jd = t->JULIAN_DATE();
    break;
  case timEpochRepresentation::MODIFIED_JULIAN_DATE:
    jd = t->JULIAN_DATE() + 2400000.5;
    break;
  case timEpochRepresentation::UNIX_SECONDS:
    jd = 2440587.5 + t->SECONDS() / 86400.0;
    break;
  case timEpochRepresentation::ISO8601:
    if (text(t->ISO8601()).empty())
      return error("invalid-epoch", "UTC ISO8601 epoch is empty.");
    jd = iso_to_jd(text(t->ISO8601()));
    break;
  default:
    return error("unsupported-epoch-format",
                 "Unsupported UTC epoch representation.");
  }
  jd += t->SUBSECOND_NANOS() / 86400000000000.0;
  return (isFinite(jd) && jd > 0) ||
         error("invalid-epoch", "Epoch must be finite and positive.");
}
const char *algorithm(cqrProbabilityAlgorithm a) {
  switch (a) {
  case cqrProbabilityAlgorithm::FOSTER:
    return "foster";
  case cqrProbabilityAlgorithm::PATERA:
    return "patera";
  case cqrProbabilityAlgorithm::ALFANO_MAXIMUM:
    return "alfano";
  case cqrProbabilityAlgorithm::CHAN:
    return "chan";
  case cqrProbabilityAlgorithm::ALFRIEND_1999:
    return "alfriend1999";
  case cqrProbabilityAlgorithm::ALFRIEND_1999_MAXIMUM:
    return "alfriend1999max";
  case cqrProbabilityAlgorithm::ALFANO_2005:
    return "alfano2005";
  case cqrProbabilityAlgorithm::LAAS_2015:
    return "laas2015";
  case cqrProbabilityAlgorithm::ALFRIEND_2D:
    return "alfriend";
  default:
    error("unsupported-algorithm",
          "Probability algorithm is unspecified or unsupported.");
    return nullptr;
  }
}
cqrProbabilityAlgorithm algorithmEnum(const std::string &name) {
  for (int i = 1; i <= 9; ++i) {
    auto a = static_cast<cqrProbabilityAlgorithm>(i);
    auto p = create_pc_method(algorithm(a));
    if (p->name() == name)
      return a;
  }
  return cqrProbabilityAlgorithm::UNSPECIFIED;
}
bool controls(const CQRScreeningControls *c, ScreeningConfig &o) {
  if (!c || !epoch(c->START_EPOCH(), o.start_jd))
    return false;
  if (!positive(c->DURATION_SECONDS()) || !positive(c->THRESHOLD_M()) ||
      !positive(c->COARSE_STEP_SECONDS()) ||
      !positive(c->REFINEMENT_TOLERANCE_SECONDS()) ||
      !positive(c->COMBINED_RADIUS_M()) || c->REQUESTED_WORKERS() < 1 ||
      c->REQUESTED_WORKERS() > 64)
    return error("invalid-controls",
                 "Duration, threshold, resolution and radius must be positive; "
                 "requested workers must be 1..64.");
  if (!algorithm(c->ALGORITHM()))
    return false;
  if (c->HAS_PROGRESS_INTERVAL_SECONDS() &&
      (!isFinite(c->PROGRESS_INTERVAL_SECONDS()) ||
       c->PROGRESS_INTERVAL_SECONDS() != 0))
    return error(
        "invalid-controls",
        "Nonzero guest progress cadence is unsupported; use host diagnostics.");
  o.duration_days = c->DURATION_SECONDS() / 86400.;
  o.threshold_km = c->THRESHOLD_M() / 1000.;
  o.coarse_step_sec = c->COARSE_STEP_SECONDS();
  o.fine_tol_sec = c->REFINEMENT_TOLERANCE_SECONDS();
  o.combined_radius_m = c->COMBINED_RADIUS_M();
  o.num_threads = c->REQUESTED_WORKERS();
  const double end_jd = o.start_jd + o.duration_days;
  if (!isFinite(end_jd) || end_jd <= o.start_jd ||
      o.start_jd + o.coarse_step_sec / 86400. <= o.start_jd ||
      end_jd + o.coarse_step_sec / 86400. <= end_jd ||
      o.fine_tol_sec / 86400. <
          std::nextafter(end_jd, std::numeric_limits<double>::infinity()) - end_jd)
    return error("unsupported-resolution",
                 "The requested UTC interval or resolution cannot be represented "
                 "by the Julian-date evaluation clock.");
  o.use_kdtree = c->USE_KD_TREE();
  o.use_dynamic_window = c->USE_DYNAMIC_WINDOW();
  o.use_perigee_filter = c->USE_PERIGEE_FILTER();
  o.progress_interval_sec = 0;
  return true;
}
// No frame is inferred from a label. Earth common-frame evaluation needs no
// transform; unsupported transforms fail before any relative geometry is used.
int frame(const RFMCoordinateSystem *f) {
  if (!f || !f->ORIGIN() ||
      f->ORIGIN()->KIND() != rfmOriginKind::CELESTIAL_BODY ||
      f->ORIGIN()->CELESTIAL_BODY_ID() != 399) {
    error("unsupported-frame",
          "An explicit Earth-centred RFM origin (NAIF 399) is required.");
    return 0;
  }
  switch (f->AXIS_TYPE()) {
  case rfmAxisType::TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE:
    return 1;
  case rfmAxisType::ICRF:
    return 2;
  case rfmAxisType::MEAN_EQUATOR_EQUINOX_J2000:
    return 3;
  default:
    error("unsupported-frame",
          "Frame conversion requires a verified external FRM/EOP provider; "
          "supplied frame is unsupported.");
    return 0;
  }
}
int sourceFrame(const RFM *f, const std::string &center) {
  if (center != "EARTH" && center != "Earth") {
    error("unsupported-frame",
          "OEM/PPE CENTER_NAME must explicitly identify EARTH.");
    return 0;
  }
  if (!f) {
    error("unsupported-frame", "Missing source reference frame.");
    return 0;
  }
  if (auto w = f->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper())
    return frame(w->COORDINATE_SYSTEM());
  if (auto w = f->REFERENCE_FRAME_as_CelestialFrameWrapper()) {
    switch (w->frame()) {
    case CelestialFrame::TEMEOFDATE:
      return 1;
    case CelestialFrame::GCRF:
    case CelestialFrame::ICRF:
      return 2;
    case CelestialFrame::J2000:
    case CelestialFrame::EME2000:
      return 3;
    default:
      break;
    }
  }
  error("unsupported-frame",
        "Source frame requires an unsupported transform or EOP realization.");
  return 0;
}
bool gpRecord(const OMM *r, GPElement &gp, bool require_frame = true) {
  if (!r)
    return error("invalid-source", "Missing OMM record.");
  if (r->TIME_SYSTEM() != timingStandard::UTC ||
      r->MEAN_ELEMENT_THEORY() != meanElementSource::SGP4)
    return error("unsupported-source",
                 "OMM provider supports SGP4 mean elements in UTC only.");
  if (require_frame &&
      sourceFrame(r->REFERENCE_FRAME(), text(r->CENTER_NAME())) != 1)
    return error("unsupported-frame",
                 "SGP4 OMM must explicitly declare Earth TEME.");
  gp.object_name = text(r->OBJECT_NAME());
  gp.object_id = text(r->OBJECT_ID());
  gp.epoch_iso = text(r->EPOCH());
  if (gp.epoch_iso.empty())
    return error("invalid-source", "OMM epoch required.");
  gp.epoch_jd = iso_to_jd(gp.epoch_iso);
  gp.mean_motion = r->MEAN_MOTION();
  gp.eccentricity = r->ECCENTRICITY();
  gp.inclination = r->INCLINATION();
  gp.ra_of_asc_node = r->RA_OF_ASC_NODE();
  gp.arg_of_pericenter = r->ARG_OF_PERICENTER();
  gp.mean_anomaly = r->MEAN_ANOMALY();
  gp.ephemeris_type = static_cast<int>(r->EPHEMERIS_TYPE());
  auto cl = text(r->CLASSIFICATION_TYPE());
  gp.classification_type = cl.empty() ? 'U' : cl[0];
  gp.norad_cat_id = r->NORAD_CAT_ID();
  gp.element_set_no = r->ELEMENT_SET_NO();
  gp.rev_at_epoch = r->REV_AT_EPOCH();
  gp.bstar = r->BSTAR();
  gp.mean_motion_dot = r->MEAN_MOTION_DOT();
  gp.mean_motion_ddot = r->MEAN_MOTION_DDOT();
  for (double x : {gp.epoch_jd, gp.mean_motion, gp.eccentricity, gp.inclination,
                   gp.ra_of_asc_node, gp.arg_of_pericenter, gp.mean_anomaly,
                   gp.bstar, gp.mean_motion_dot, gp.mean_motion_ddot})
    if (!isFinite(x))
      return error("invalid-source", "OMM elements must be finite.");
  if (!positive(gp.epoch_jd) || !positive(gp.mean_motion) ||
      gp.eccentricity < 0 || gp.eccentricity >= 1 || gp.inclination < 0 ||
      gp.inclination > 180)
    return error("invalid-source",
                 "OMM orbital elements are outside SGP4 bounds.");
  compute_derived(gp);
  return true;
}
GPElement tleGp(const TLE &t) {
  GPElement g;
  g.object_name = t.name;
  g.object_id = t.object_id;
  g.epoch_jd = t.epoch_jd;
  g.epoch_iso = jd_to_iso(t.epoch_jd);
  g.mean_motion = t.mean_motion;
  g.eccentricity = t.eccentricity;
  g.inclination = t.inclination;
  g.ra_of_asc_node = t.raan;
  g.arg_of_pericenter = t.arg_perigee;
  g.mean_anomaly = t.mean_anomaly;
  g.norad_cat_id = t.norad_cat_id;
  g.bstar = t.bstar;
  compute_derived(g);
  return g;
}
struct Source {
  std::shared_ptr<EphemerisSource> provider;
  GPElement gp;
  TLE tle;
  // True when gp.object_id is the catalog number standing in for an absent
  // OMM OBJECT_ID (screening identity only; never written back as OBJECT_ID).
  bool object_id_from_norad = false;
  bool mean = false;
  int axes = 0;
  uint32_t handle = 0;
  std::vector<EphemerisPoint> samples;
  std::shared_ptr<PolynomialEphemerisSource> polynomial;
  // Mean elements evaluated with the parsed element set; its SGP4
  // initialization is kept for the life of the source (resident indexes).
  std::shared_ptr<SGP4EphemerisSource> sgp4;
};
bool points(const OEM *r, Source &o) {
  if (!r || !r->EPHEMERIS_DATA_BLOCK() ||
      r->EPHEMERIS_DATA_BLOCK()->size() == 0)
    return error("invalid-source", "OEM needs ephemeris blocks.");
  for (auto b : *r->EPHEMERIS_DATA_BLOCK()) {
    if (!b || b->TIME_SYSTEM() != timingStandard::UTC)
      return error("unsupported-time-system",
                   "OEM tracks must explicitly use UTC.");
    int f = sourceFrame(b->REFERENCE_FRAME(), text(b->CENTER_NAME()));
    if (!f || (o.axes && o.axes != f))
      return error("unsupported-frame",
                   "All OEM blocks must share one explicit frame.");
    o.axes = f;
    auto interpolation = text(b->INTERPOLATION());
    if ((!interpolation.empty() && interpolation != "Hermite" &&
         interpolation != "HERMITE") ||
        (b->INTERPOLATION_DEGREE() != 0 && b->INTERPOLATION_DEGREE() != 3))
      return error(
          "unsupported-interpolation",
          "The sampled OEM adapter implements cubic Hermite interpolation.");
    if (b->COVARIANCE_MATRIX_LINES() && b->COVARIANCE_MATRIX_LINES()->size())
      return error("unsupported-covariance",
                   "OEM covariance interpolation is not implemented; use "
                   "compute_pc with supplied encounter-plane covariance.");
    if (b->STEP_SIZE() > 0) {
      auto d = b->EPHEMERIS_DATA();
      auto n = b->STATE_VECTOR_SIZE();
      if (!d || (n != 6 && n != 9) || d->size() % n ||
          text(b->START_TIME()).empty())
        return error("invalid-source", "Invalid OEM compact state grid.");
      double start = iso_to_jd(text(b->START_TIME()));
      for (size_t i = 0; i < d->size(); i += n)
        o.samples.push_back({start + (i / n) * b->STEP_SIZE() / 86400.,
                             d->Get(i), d->Get(i + 1), d->Get(i + 2),
                             d->Get(i + 3), d->Get(i + 4), d->Get(i + 5)});
    } else if (auto lines = b->EPHEMERIS_DATA_LINES())
      for (auto p : *lines) {
        if (!p || text(p->EPOCH()).empty())
          return error("invalid-source", "OEM state epoch required.");
        o.samples.push_back({iso_to_jd(text(p->EPOCH())), p->X(), p->Y(),
                             p->Z(), p->X_DOT(), p->Y_DOT(), p->Z_DOT()});
      }
  }
  if (o.samples.size() < 2)
    return error("invalid-source", "OEM needs at least two finite samples.");
  double previous = 0;
  for (auto &p : o.samples) {
    for (double x : {p.jd, p.x, p.y, p.z, p.vx, p.vy, p.vz})
      if (!isFinite(x))
        return error("invalid-source", "OEM sample components must be finite.");
    if (p.jd <= previous)
      return error("invalid-source", "OEM epochs must be strictly increasing.");
    previous = p.jd;
  }
  return true;
}
// A PPE interval's UTC span. TDB and TT intervals map onto UTC linearly
// between their converted ends (TDB - UTC curves by ~1e-12 s over an hour);
// an interval holding a leap second does not map and is refused.
bool utcSpan(timingStandard scale, double mid, double half, double &utc_mid, double &utc_half) {
  if (scale == timingStandard::UTC) {
    utc_mid = mid;
    utc_half = half;
    return true;
  }
  const auto convert = scale == timingStandard::TDB ? tdb_to_utc_jd : tt_to_utc_jd;
  const double a = convert(mid - half / 86400.), b = convert(mid + half / 86400.);
  if (!isFinite(a) || !isFinite(b))
    return error("unsupported-time-system", "PPE epoch outside the leap-second table.");
  utc_mid = 0.5 * (a + b);
  utc_half = 0.5 * (b - a) * 86400.;
  if (std::abs(utc_half - half) > 0.5)
    return error("unsupported-time-system", "A PPE interval holds a leap second; split it there.");
  return true;
}
bool polynomial(const PPE *p, Source &o) {
  if (!p || (p->TIME_SYSTEM() != timingStandard::UTC && p->TIME_SYSTEM() != timingStandard::TDB &&
             p->TIME_SYSTEM() != timingStandard::TT))
    return error("unsupported-time-system",
                 "PPE coefficients must be in UTC, TT or TDB.");
  if (p->DEFAULT_BASIS_TYPE() != polynomialBasisType::CHEBYSHEV)
    return error("unsupported-polynomial",
                 "PPE default basis must be CHEBYSHEV.");
  o.axes = sourceFrame(p->REFERENCE_FRAME(), text(p->CENTER_NAME()));
  if (!o.axes)
    return false;
  if (!p->POSITION_RECORDS() || !p->POSITION_RECORDS()->size() ||
      (p->ORBITAL_ELEMENT_RECORDS() && p->ORBITAL_ELEMENT_RECORDS()->size()))
    return error("unsupported-source",
                 "PPE needs Cartesian position records only.");
  std::vector<PolynomialRecord> records;
  double last = -std::numeric_limits<double>::infinity();
  for (auto r : *p->POSITION_RECORDS()) {
    if (!r || r->BASIS_TYPE() != polynomialBasisType::CHEBYSHEV ||
        !r->HAS_VELOCITY_COEFFICIENTS() || !positive(r->EPOCH_HALF_SPAN()) ||
        !r->NUM_COEFFICIENTS())
      return error("unsupported-polynomial",
                   "PPE requires Chebyshev position and explicit velocity "
                   "coefficients.");
    PolynomialRecord rec;
    if (!utcSpan(p->TIME_SYSTEM(), iso_to_jd(text(r->EPOCH_MID())), r->EPOCH_HALF_SPAN(),
                 rec.mid, rec.half))
      return false;
    double start = rec.mid - rec.half / 86400.;
    if (!isFinite(rec.mid) || start < last - 1e-9 ||
        (!records.empty() && start > last + 1e-9))
      return error("invalid-coverage",
                   "PPE intervals must be ordered and contiguous.");
    last = rec.mid + rec.half / 86400.;
    std::array<const flatbuffers::Vector<double> *, 6> vectors = {
        r->POS_COEFF_X(), r->POS_COEFF_Y(), r->POS_COEFF_Z(),
        r->VEL_COEFF_X(), r->VEL_COEFF_Y(), r->VEL_COEFF_Z()};
    for (size_t k = 0; k < 6; ++k) {
      auto v = vectors[k];
      if (!v || v->size() != r->NUM_COEFFICIENTS())
        return error("invalid-polynomial", "PPE coefficient length mismatch.");
      for (auto x : *v) {
        if (!isFinite(x))
          return error("invalid-polynomial",
                       "PPE coefficients must be finite.");
        rec.c[k].push_back(x);
      }
    }
    records.push_back(std::move(rec));
  }
  o.polynomial = std::make_shared<PolynomialEphemerisSource>(std::move(records));
  return true;
}
bool source(const CQRObjectSource *r, Source &o) {
  if (!r || text(r->OBJECT_ID()).empty())
    return error("invalid-source", "CQR source requires object identity.");
  unsigned n = !!r->MEAN_ELEMENTS() + !!r->TLE_LINES() + !!r->EPHEMERIS() +
               !!r->COMPREHENSIVE_ORBIT() + !!r->POLYNOMIAL_EPHEMERIS();
  if (n != 1)
    return error("invalid-source-arm",
                 "One scientific source arm is required; arbitrary external "
                 "handles cannot be resolved by this instance.");
  o.handle = r->SOURCE_HANDLE();
  if (r->MEAN_ELEMENTS() || r->TLE_LINES()) {
    auto port = text(r->PROPAGATOR_PORT_ID());
    if (port != "sgp4")
      return error("unsupported-propagator",
                   "Mean elements require explicit PROPAGATOR_PORT_ID=sgp4; "
                   "host-resolved OEM/PPE supports other providers.");
    if (r->MEAN_ELEMENTS()) {
      if (!gpRecord(r->MEAN_ELEMENTS(), o.gp))
        return false;
      o.tle = gp_to_tle(o.gp);
      if (has_error())
        return error("invalid-source", error_message());
    } else {
      auto t = r->TLE_LINES();
      if (text(t->LINE1()).size() < 69 || text(t->LINE2()).size() < 69)
        return error("invalid-source",
                     "TLE requires two complete native lines.");
      o.tle = parse_tle(text(t->NAME()), text(t->LINE1()), text(t->LINE2()));
      if (has_error())
        return error("invalid-source", error_message());
      o.gp = tleGp(o.tle);
    }
    o.gp.object_id = text(r->OBJECT_ID());
    o.tle.object_id = o.gp.object_id;
    if (!text(r->OBJECT_NAME()).empty()) {
      o.gp.object_name = text(r->OBJECT_NAME());
      o.tle.name = o.gp.object_name;
    }
    o.mean = true;
    o.axes = 1;
    o.provider = std::make_shared<GPEphemerisSource>(o.gp);
    o.sgp4 = std::make_shared<SGP4EphemerisSource>(o.tle);
  } else if (r->EPHEMERIS()) {
    if (!points(r->EPHEMERIS(), o))
      return false;
    o.provider = std::make_shared<OEMEphemerisSource>(
        o.samples, text(r->OBJECT_NAME()), text(r->OBJECT_ID()),
        r->NORAD_CATALOG_ID());
  } else if (r->POLYNOMIAL_EPHEMERIS()) {
    if (!polynomial(r->POLYNOMIAL_EPHEMERIS(), o))
      return false;
    o.polynomial->name = text(r->OBJECT_NAME());
    o.polynomial->id = text(r->OBJECT_ID());
    o.polynomial->norad = r->NORAD_CATALOG_ID();
    o.provider = o.polynomial;
  } else
    return error("unsupported-source",
                 "Published OCM Cartesian state data does not declare a frame "
                 "or state units; supply a host-resolved OEM/PPE record.");
  if (r->SOURCE_EPOCH()) {
    double declared = 0;
    if (!epoch(r->SOURCE_EPOCH(), declared))
      return false;
    if (std::abs(declared - o.provider->epoch_jd()) > 1e-9)
      return error("source-epoch-mismatch",
                   "SOURCE_EPOCH disagrees with scientific source.");
  }
  return true;
}
bool window(const Source &s, const ScreeningConfig &c, int f) {
  if (s.axes != f)
    return error("frame-mismatch",
                 "Scientific sources must already use the declared evaluation "
                 "frame; use FRM/EOP before invoking.");
  double a = s.provider->valid_start_jd(), b = s.provider->valid_end_jd();
  if ((a && c.start_jd < a - epochRounding(a)) ||
      (b && c.start_jd + c.duration_days > b + epochRounding(b)))
    return error(
        "invalid-coverage",
        "Source does not cover the complete requested UTC screening window.");
  return true;
}
std::unique_ptr<CQRProbabilityResultT>
probability(const PcResult &p, cqrProbabilityAlgorithm a,
            cqrUncertaintyOrigin origin) {
  auto o = std::make_unique<CQRProbabilityResultT>();
  if (!p.method.empty()) {
    const auto actual = algorithmEnum(p.method);
    if (actual == cqrProbabilityAlgorithm::UNSPECIFIED)
      set_error("Probability evaluator returned an unregistered algorithm.");
    else
      a = actual;
  }
  o->ALGORITHM = a;
  o->CONVERGED = p.converged;
  o->ITERATIONS = std::max(0, p.iterations);
  o->UNCERTAINTY_SOURCE = origin;
  bool maximum = a == cqrProbabilityAlgorithm::ALFANO_MAXIMUM ||
                 a == cqrProbabilityAlgorithm::ALFRIEND_1999_MAXIMUM;
  o->PROBABILITY = maximum ? 0 : p.probability;
  o->MAXIMUM_PROBABILITY = p.max_probability;
  o->HAS_MAXIMUM_PROBABILITY = true;
  o->MAHALANOBIS_SQUARED = p.mahalanobis_2d * p.mahalanobis_2d;
  o->HAS_MAHALANOBIS_SQUARED = !maximum;
  if (maximum)
    o->UNCERTAINTY_SOURCE = cqrUncertaintyOrigin::MAXIMUM_PROBABILITY_ONLY;
  if (!isFinite(o->PROBABILITY) || o->PROBABILITY < 0 || o->PROBABILITY > 1 ||
      !isFinite(o->MAXIMUM_PROBABILITY) || o->MAXIMUM_PROBABILITY < 0 ||
      o->MAXIMUM_PROBABILITY > 1)
    set_error("Probability evaluator returned an invalid probability.");
  return o;
}
std::unique_ptr<FRMVector3T> vec(double x, double y, double z) {
  auto v = std::make_unique<FRMVector3T>();
  v->X = x;
  v->Y = y;
  v->Z = z;
  return v;
}
std::unique_ptr<PRWResidentStateT> state(const conjunction::StateVector &v,
                                         double jd, const std::string &id,
                                         uint32_t norad, int axes) {
  auto r = std::make_unique<PRWResidentStateT>();
  r->OBJECT_ID = id;
  r->CATALOG_NUMBER = norad;
  r->STATE = std::make_unique<FRMStateVectorT>();
  r->STATE->REPRESENTATION = frmStateRepresentation::CARTESIAN;
  r->STATE->POSITION = vec(v.x * 1000., v.y * 1000., v.z * 1000.);
  r->STATE->VELOCITY = vec(v.vx * 1000., v.vy * 1000., v.vz * 1000.);
  r->STATE->EPOCH = jd_to_iso(jd);
  r->STATE->EPOCH_TIME_SYSTEM = "UTC";
  r->STATE->COORDINATE_SYSTEM_NAME = axes == 1   ? "TEME"
                                     : axes == 2 ? "GCRF"
                                                 : "EME2000";
  r->COORDINATE_SYSTEM = std::make_unique<RFMCoordinateSystemT>();
  r->COORDINATE_SYSTEM->NAME = r->STATE->COORDINATE_SYSTEM_NAME;
  r->COORDINATE_SYSTEM->AXIS_TYPE =
      axes == 1   ? rfmAxisType::TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE
      : axes == 2 ? rfmAxisType::ICRF
                  : rfmAxisType::MEAN_EQUATOR_EQUINOX_J2000;
  r->COORDINATE_SYSTEM->ORIGIN = std::make_unique<RFMOriginT>();
  r->COORDINATE_SYSTEM->ORIGIN->KIND = rfmOriginKind::CELESTIAL_BODY;
  r->COORDINATE_SYSTEM->ORIGIN->CELESTIAL_BODY_ID = 399;
  r->COORDINATE_SYSTEM->EPOCH = r->STATE->EPOCH;
  r->COORDINATE_SYSTEM->EPOCH_TIME_SYSTEM = "UTC";
  return r;
}
std::unique_ptr<CQREventT> event(const ConjunctionEvent &e, int axes = 1) {
  auto o = std::make_unique<CQREventT>();
  o->PRIMARY_ID = e.obj1.object_id.empty() ? std::to_string(e.obj1.norad_cat_id)
                                           : e.obj1.object_id;
  o->SECONDARY_ID = e.obj2.object_id.empty()
                        ? std::to_string(e.obj2.norad_cat_id)
                        : e.obj2.object_id;
  o->PRIMARY_NAME = e.obj1.name;
  o->SECONDARY_NAME = e.obj2.name;
  o->PRIMARY_NORAD_ID = e.obj1.norad_cat_id;
  o->SECONDARY_NORAD_ID = e.obj2.norad_cat_id;
  o->TCA = instant(e.tca_jd);
  o->MISS_DISTANCE_M = e.min_range_km * 1000.;
  o->RELATIVE_SPEED_M_S = e.rel_speed_kms * 1000.;
  PcResult p;
  p.max_probability = e.max_probability;
  p.converged = true;
  o->PROBABILITY = probability(p, cqrProbabilityAlgorithm::ALFANO_MAXIMUM,
                               cqrUncertaintyOrigin::MAXIMUM_PROBABILITY_ONLY);
  o->DILUTION_THRESHOLD_M = e.dilution_threshold_km * 1000.;
  o->HAS_DILUTION_THRESHOLD_M = true;
  o->RELATIVE_POSITION_RTN =
      vec(e.rel_pos_r * 1000., e.rel_pos_t * 1000., e.rel_pos_n * 1000.);
  o->RELATIVE_VELOCITY_RTN =
      vec(e.rel_vel_r * 1000., e.rel_vel_t * 1000., e.rel_vel_n * 1000.);
  o->PRIMARY_SIGMA_RTN_M = vec(e.cov_r1, e.cov_t1, e.cov_n1);
  o->SECONDARY_SIGMA_RTN_M = vec(e.cov_r2, e.cov_t2, e.cov_n2);
  o->PRIMARY_DAYS_SINCE_EPOCH = e.dse1;
  o->SECONDARY_DAYS_SINCE_EPOCH = e.dse2;
  o->HAS_PRIMARY_DAYS_SINCE_EPOCH = o->HAS_SECONDARY_DAYS_SINCE_EPOCH = true;
  o->PRIMARY_STATE =
      state(e.state1, e.tca_jd, o->PRIMARY_ID, o->PRIMARY_NORAD_ID, axes);
  o->SECONDARY_STATE =
      state(e.state2, e.tca_jd, o->SECONDARY_ID, o->SECONDARY_NORAD_ID, axes);
  return o;
}
std::unique_ptr<CQREventT> event(const ConjunctionEvent2 &e,
                                 cqrProbabilityAlgorithm a, int axes = 1) {
  ConjunctionEvent l;
  l.obj1.name = e.obj1_name;
  l.obj1.object_id = e.obj1_id;
  l.obj1.norad_cat_id = e.obj1_norad;
  l.obj2.name = e.obj2_name;
  l.obj2.object_id = e.obj2_id;
  l.obj2.norad_cat_id = e.obj2_norad;
  l.tca_jd = e.tca_jd;
  l.state1 = e.state1;
  l.state2 = e.state2;
  l.min_range_km = e.miss_distance_km;
  l.rel_speed_kms = e.relative_speed_kms;
  l.rel_pos_r = e.rel_r;
  l.rel_pos_t = e.rel_t;
  l.rel_pos_n = e.rel_n;
  l.rel_vel_r = e.rel_vr;
  l.rel_vel_t = e.rel_vt;
  l.rel_vel_n = e.rel_vn;
  l.dse1 = e.dse1;
  l.dse2 = e.dse2;
  auto o = event(l, axes);
  o->HAS_DILUTION_THRESHOLD_M = false;
  o->PROBABILITY =
      probability(e.pc, a, cqrUncertaintyOrigin::SYNTHESIZED_COVARIANCE);
  o->PRIMARY_SIGMA_RTN_M.reset();
  o->SECONDARY_SIGMA_RTN_M.reset();
  o->MAHALANOBIS_3D_SQUARED = e.mahalanobis_3d * e.mahalanobis_3d;
  o->HAS_MAHALANOBIS_3D_SQUARED = true;
  o->COMBINED_RADIUS_M = e.combined_radius_km * 1000.;
  o->HAS_COMBINED_RADIUS_M = true;
  return o;
}
// TOTAL_OBJECTS counts the objects the screening covered: the catalog less
// the objects excluded because they cannot be propagated over the window
// (listed on the `excluded` port). OBJECTS_PARSED keeps the full count.
std::unique_ptr<CQRScreeningStatisticsT> statistics(const ScreeningStats &s) {
  auto o = std::make_unique<CQRScreeningStatisticsT>();
  o->TOTAL_OBJECTS = s.total_objects >= s.excluded_objects.size()
                         ? s.total_objects - s.excluded_objects.size()
                         : 0;
  o->PAIRS_SCREENED = s.pairs_screened;
  o->PAIRS_PREFILTERED = s.pairs_prefiltered;
  o->KD_TREE_CANDIDATES = s.kdtree_candidates;
  o->TCA_REFINED = s.tca_refined;
  o->CONJUNCTIONS_FOUND = s.conjunctions_found;
  o->PROPAGATIONS = s.propagations;
  o->FAILED_PAIRS = s.failed_pairs;
  return o;
}
struct PendingCatalog {
  std::vector<std::unique_ptr<CQREventT>> events;
  ScreeningStats stats;
  size_t offset = 0;
  std::string request_bytes;
  // Canonical $OMM records of the excluded objects, emitted with the final
  // chunk on the `excluded` port.
  std::vector<std::vector<uint8_t>> excluded;
};
// One $OMM per excluded object: the mean elements the screening was given
// (already verified as SGP4 mean elements, UTC, Earth TEME), with COMMENT
// stating that the object was excluded, the earliest coarse epoch whose
// propagation failed and the propagator's error there.
std::vector<uint8_t> excludedRecord(const Source &source, const ExcludedObject &x) {
  const GPElement &g = source.gp;
  OMMT o;
  o.OBJECT_NAME = g.object_name;
  if (!source.object_id_from_norad)
    o.OBJECT_ID = g.object_id;
  o.NORAD_CAT_ID = g.norad_cat_id > 0 ? static_cast<uint32_t>(g.norad_cat_id) : 0;
  o.CENTER_NAME = "EARTH";
  o.REFERENCE_FRAME = std::make_unique<RFMT>();
  CelestialFrameWrapperT teme;
  teme.frame = CelestialFrame::TEMEOFDATE;
  o.REFERENCE_FRAME->REFERENCE_FRAME.Set(std::move(teme));
  o.TIME_SYSTEM = timingStandard::UTC;
  o.MEAN_ELEMENT_THEORY = meanElementSource::SGP4;
  o.COMMENT = "Excluded from conjunction screening: SGP4 cannot propagate this "
              "object over the screening window. First failure at " +
              jd_to_iso(x.first_failure_jd) + ": " + x.reason;
  o.EPOCH = g.epoch_iso;
  o.MEAN_MOTION = g.mean_motion;
  o.ECCENTRICITY = g.eccentricity;
  o.INCLINATION = g.inclination;
  o.RA_OF_ASC_NODE = g.ra_of_asc_node;
  o.ARG_OF_PERICENTER = g.arg_of_pericenter;
  o.MEAN_ANOMALY = g.mean_anomaly;
  o.EPHEMERIS_TYPE = static_cast<ephemerisFormat>(g.ephemeris_type);
  o.CLASSIFICATION_TYPE = std::string(1, g.classification_type);
  o.ELEMENT_SET_NO = g.element_set_no > 0 ? static_cast<uint32_t>(g.element_set_no) : 0;
  o.REV_AT_EPOCH = g.rev_at_epoch;
  o.BSTAR = g.bstar;
  o.MEAN_MOTION_DOT = g.mean_motion_dot;
  o.MEAN_MOTION_DDOT = g.mean_motion_ddot;
  flatbuffers::FlatBufferBuilder b(512);
  FinishOMMBuffer(b, OMM::Pack(b, &o));
  return std::vector<uint8_t>(b.GetBufferPointer(),
                              b.GetBufferPointer() + b.GetSize());
}
bool pushExcluded(const std::vector<std::vector<uint8_t>> &records) {
  for (size_t k = 0; k < records.size(); ++k) {
    int i = plugin_push_output_ex("excluded", "OMM.fbs", "$OMM", 0, "OMM", 0, 0,
                                  records[k].data(),
                                  static_cast<uint32_t>(records[k].size()));
    if (i < 0)
      return false;
    plugin_set_output_stream_frame(i, k, k + 1 == records.size() ? 1 : 0);
  }
  return true;
}
std::map<std::string, PendingCatalog> pending;
std::string pendingKey(const std::string &method) {
  std::string key = method;
  auto f = input("request");
  if (f) {
    key.append(reinterpret_cast<const char *>(&f->trace_id),
               sizeof(f->trace_id));
    key.append(reinterpret_cast<const char *>(&f->stream_id),
               sizeof(f->stream_id));
  }
  return key;
}
std::string requestKey() {
  std::string key;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    auto f = plugin_get_input_frame(i);
    if (!f)
      continue;
    if (f->port_id)
      key.append(f->port_id);
    key.push_back('\0');
    uint32_t n = f->payload_length;
    key.append(reinterpret_cast<const char *>(&n), sizeof(n));
    if (n)
      key.append(reinterpret_cast<const char *>(f->payload), n);
  }
  return key;
}
bool emitPending(const std::string &method) {
  auto it = pending.find(pendingKey(method));
  if (it == pending.end())
    return false;
  auto &p = it->second;
  size_t count = p.events.size(), start = p.offset;
  CQRT q;
  q.CATALOG_RESULT = std::make_unique<CQRCatalogResultT>();
  auto &r = *q.CATALOG_RESULT;
  r.OBJECTS_PARSED = p.stats.total_objects;
  r.CONJUNCTIONS_FOUND = count;
  r.STATISTICS = statistics(p.stats);
  r.EVENT_OFFSET = start;
  r.FINAL_CHUNK = start + kEventsPerChunk >= count;
  for (size_t i = start; i < std::min(start + kEventsPerChunk, count); ++i)
    r.EVENTS.push_back(std::make_unique<CQREventT>(*p.events[i]));
  bool final = r.FINAL_CHUNK;
  bool failed = p.stats.failed_pairs > 0;
  if (!push(q, "result", start / kEventsPerChunk, final))
    return false;
  if (final && !pushExcluded(p.excluded))
    return false;
  for (size_t i = start; i < start + r.EVENTS.size(); ++i)
    p.events[i].reset();
  p.offset += r.EVENTS.size();
  if (final)
    pending.erase(it);
  else {
    plugin_set_yielded(1);
    plugin_set_backlog_remaining(static_cast<uint32_t>(
        (count - p.offset + kEventsPerChunk - 1) / kEventsPerChunk));
  }
  if (final && failed)
    return error("incomplete-screening",
                 "One or more pair evaluations failed; FAILED_PAIRS reports "
                 "the incomplete result.");
  return true;
}
bool hasPending(const std::string &method) {
  auto it = pending.find(pendingKey(method));
  if (it == pending.end())
    return false;
  if (it->second.request_bytes == requestKey())
    return true;
  set_error("A previous screening stream must be drained before reusing its "
            "trace/stream identity for another request.");
  return true;
}
bool catalogOutput(std::vector<std::unique_ptr<CQREventT>> events,
                   const ScreeningStats &s, const std::string &method,
                   std::vector<std::vector<uint8_t>> excluded = {}) {
  size_t retainedEvents = events.size();
  size_t retainedRequestBytes = 0;
  for (const auto &entry : pending) {
    retainedEvents += entry.second.events.size() - entry.second.offset;
    retainedRequestBytes += entry.second.request_bytes.size();
  }
  std::string identity = requestKey();
  if (excluded.size() > kMaximumExcludedFrames)
    return error("output-staging-limit",
                 "More excluded objects than the excluded port can carry; "
                 "screen a smaller catalog range.");
  if (pending.size() >= kMaximumPendingStreams ||
      retainedEvents > kMaximumPendingEvents ||
      retainedRequestBytes + identity.size() > kMaximumRetainedRequestBytes)
    return error("output-staging-limit",
                 "Bounded output staging capacity exceeded; drain existing "
                 "streams or request a smaller screening window.");
  std::stable_sort(events.begin(), events.end(), [](auto &a, auto &b) {
    return std::tie(a->TCA->JULIAN_DATE, a->PRIMARY_ID, a->SECONDARY_ID) <
           std::tie(b->TCA->JULIAN_DATE, b->PRIMARY_ID, b->SECONDARY_ID);
  });
  PendingCatalog p;
  p.events = std::move(events);
  p.stats = s;
  p.request_bytes = std::move(identity);
  p.excluded = std::move(excluded);
  pending[pendingKey(method)] = std::move(p);
  return emitPending(method);
}
bool catalogOutput(const std::vector<ConjunctionEvent> &e,
                   const ScreeningStats &s, const std::string &method,
                   std::vector<std::vector<uint8_t>> excluded = {}) {
  std::vector<std::unique_ptr<CQREventT>> out;
  for (auto &x : e)
    out.push_back(event(x));
  return catalogOutput(std::move(out), s, method, std::move(excluded));
}

bool pair(const CQRPairRequest *p, Source &a, Source &b, ScreeningConfig &c) {
  if (!p)
    return error("invalid-request-arm", "Method requires CQR.PAIR_REQUEST.");
  if (!controls(p->CONTROLS(), c) || !positive(p->PRIMARY_RADIUS_M()) ||
      !positive(p->SECONDARY_RADIUS_M()))
    return error("invalid-controls", "Pair radii and controls must be valid.");
  if (std::abs(p->PRIMARY_RADIUS_M() + p->SECONDARY_RADIUS_M() -
               c.combined_radius_m) > 1e-9)
    return error("inconsistent-radii",
                 "Combined radius must equal the sum of the pair radii.");
  int f = frame(p->EVALUATION_FRAME());
  return f && source(p->PRIMARY(), a) && source(p->SECONDARY(), b) &&
         window(a, c, f) && window(b, c, f);
}
} // namespace ca_cqr

extern "C" int compute_pc() {
  using namespace ca_cqr;
  auto q = request();
  if (!q || !q->PROBABILITY_REQUEST())
    return error("invalid-request-arm",
                 "compute_pc requires PROBABILITY_REQUEST."),
           400;
  auto p = q->PROBABILITY_REQUEST();
  auto g = p->GEOMETRY();
  auto name = algorithm(p->ALGORITHM());
  if (!g || !name)
    return 400;
  for (double x :
       {g->XI_M(), g->ZETA_M(), g->VARIANCE_XI_M2(), g->COVARIANCE_XI_ZETA_M2(),
        g->VARIANCE_ZETA_M2(), g->COMBINED_RADIUS_M()})
    if (!isFinite(x))
      return error("invalid-geometry",
                   "All plane geometry values must be finite."),
             400;
  if (!positive(g->COMBINED_RADIUS_M()) || !positive(g->VARIANCE_XI_M2()) ||
      !positive(g->VARIANCE_ZETA_M2()) ||
      std::abs(g->COVARIANCE_XI_ZETA_M2() / std::sqrt(g->VARIANCE_XI_M2()) /
               std::sqrt(g->VARIANCE_ZETA_M2())) >= 1.0)
    return error("invalid-covariance",
                 "Encounter-plane covariance must be positive definite and "
                 "radius positive."),
           400;
  BPlaneGeometry bp;
  bp.xi = g->XI_M() / 1000.;
  bp.zeta = g->ZETA_M() / 1000.;
  bp.sigma_xx = g->VARIANCE_XI_M2() / 1e6;
  bp.sigma_xz = g->COVARIANCE_XI_ZETA_M2() / 1e6;
  bp.sigma_zz = g->VARIANCE_ZETA_M2() / 1e6;
  bp.combined_radius = g->COMBINED_RADIUS_M() / 1000.;
  auto evaluator = create_pc_method(name);
  auto value = evaluator->compute(bp);
  if (value.method != evaluator->name())
    return error("unsupported-probability-range",
                 "Requested covariance algorithm cannot evaluate this geometry "
                 "without changing algorithms."),
           422;
  CQRT out;
  out.PROBABILITY_RESULT = probability(
      value, p->ALGORITHM(), cqrUncertaintyOrigin::SUPPLIED_COVARIANCE);
  return push(out) ? 0 : 500;
}
extern "C" int alfano_max_probability() {
  using namespace ca_cqr;
  auto q = request();
  if (!q || !q->ALFANO_REQUEST())
    return error("invalid-request-arm",
                 "alfano_max_probability requires ALFANO_REQUEST."),
           400;
  auto p = q->ALFANO_REQUEST();
  if (!isFinite(p->MISS_DISTANCE_M()) || p->MISS_DISTANCE_M() < 0 ||
      !positive(p->COMBINED_RADIUS_M()))
    return error("invalid-geometry",
                 "Miss distance must be nonnegative and radius positive."),
           400;
  auto v = conjunction::alfano_max_probability(p->MISS_DISTANCE_M() / 1000.,
                                               p->COMBINED_RADIUS_M() / 1000.);
  CQRT out;
  out.ALFANO_RESULT = std::make_unique<CQRAlfanoResultT>();
  out.ALFANO_RESULT->MAXIMUM_PROBABILITY = v.max_probability;
  out.ALFANO_RESULT->DILUTION_THRESHOLD_M = v.dilution_threshold_km * 1000.;
  out.ALFANO_RESULT->SIGMA_STAR_M = v.sigma_star_km * 1000.;
  return push(out) ? 0 : 500;
}
extern "C" int compute_pc_from_cdm() {
  using namespace ca_cqr;
  conjunction::clear_error();
  auto f = input("cdm");
  if (!decode<CDM>(f, "$CDM"))
    return 400;
  auto p = conjunction::compute_pc_from_cdm(f->payload, f->payload_length);
  auto a = algorithmEnum(p.method);
  if (a == cqrProbabilityAlgorithm::UNSPECIFIED)
    return error("unsupported-algorithm",
                 "CDM names an unsupported probability algorithm."),
           400;
  CQRT q;
  q.PROBABILITY_RESULT =
      probability(p, a, cqrUncertaintyOrigin::SUPPLIED_COVARIANCE);
  return push(q) ? 0 : 500;
}

extern "C" int find_tca() {
  using namespace ca_cqr;
  auto q = request();
  Source a, b;
  ScreeningConfig c;
  if (!q || !pair(q->PAIR_REQUEST(), a, b, c))
    return 400;
  double t = 0;
  if (a.mean && b.mean)
    t = conjunction::find_tca(a.tle, b.tle, c.start_jd, c.duration_days,
                              c.coarse_step_sec, c.fine_tol_sec);
  else {
    ConjunctionEngine e;
    t = e.find_tca(*a.provider, *b.provider, c.start_jd, c.duration_days,
                   c.coarse_step_sec, c.fine_tol_sec);
  }
  if (!isFinite(t))
    return error("pair-evaluation-failed",
                 "TCA solver did not produce a finite result."),
           422;
  CQRT out;
  out.TCA_RESULT = instant(t);
  return push(out) ? 0 : 500;
}
extern "C" int assess_conjunction() {
  using namespace ca_cqr;
  auto q = request();
  Source a, b;
  ScreeningConfig c;
  if (!q || !pair(q->PAIR_REQUEST(), a, b, c))
    return 400;
  CQRT out;
  auto alg = q->PAIR_REQUEST()->CONTROLS()->ALGORITHM();
  if (a.mean && b.mean && alg == cqrProbabilityAlgorithm::ALFANO_MAXIMUM) {
    double t = conjunction::find_tca(a.tle, b.tle, c.start_jd, c.duration_days,
                                     c.coarse_step_sec, c.fine_tol_sec);
    out.EVENT_RESULT = event(assess_conjunction_at_tca(
        a.tle, b.tle, t, q->PAIR_REQUEST()->PRIMARY_RADIUS_M(),
        q->PAIR_REQUEST()->SECONDARY_RADIUS_M()));
  } else {
    ConjunctionEngine e;
    e.set_pc_method(algorithm(alg));
    e.set_combined_radius_m(q->PAIR_REQUEST()->PRIMARY_RADIUS_M(),
                            q->PAIR_REQUEST()->SECONDARY_RADIUS_M());
    out.EVENT_RESULT =
        event(e.assess(*a.provider, *b.provider, c.start_jd, c.duration_days,
                       nullptr, nullptr, c.coarse_step_sec, c.fine_tol_sec),
              alg, a.axes);
  }
  if (!isFinite(out.EVENT_RESULT->MISS_DISTANCE_M) ||
      !isFinite(out.EVENT_RESULT->TCA->JULIAN_DATE))
    return error("pair-evaluation-failed",
                 "Pair assessment produced nonfinite geometry."),
           422;
  return push(out) ? 0 : 500;
}

namespace ca_cqr {
bool document(bool xml, bool write) {
  conjunction::clear_error();
  const char *port = xml ? "xml" : "kvn";
  const plugin_input_frame_t *f = nullptr;
  const CQRNativeDocument *d = nullptr;
  if (write) {
    f = input("cdm");
    if (!decode<CDM>(f, "$CDM"))
      return false;
  } else {
    auto q = request(port);
    if (!q || !(d = q->NATIVE_DOCUMENT()))
      return error("invalid-request-arm",
                   "Native CDM parser requires CQR.NATIVE_DOCUMENT.");
    auto expected = xml ? cqrDocumentSyntax::CCSDS_CDM_XML
                        : cqrDocumentSyntax::CCSDS_CDM_KVN;
    if (d->SERIALIZATION() != expected || !d->CONTENT() ||
        !d->CONTENT()->size() || d->CONTENT()->size() > kMaximumDocumentBytes)
      return error(
          "invalid-native-document",
          "CDM document syntax/content is missing, wrong or oversized.");
    auto bytes = d->CONTENT();
    if (bytes->size() >= 3 && bytes->Get(0) == 0xef && bytes->Get(1) == 0xbb &&
        bytes->Get(2) == 0xbf)
      return error("invalid-native-document", "UTF-8 BOM is not allowed.");
    std::string content(reinterpret_cast<const char *>(bytes->Data()),
                        bytes->size());
    if (content.find('\0') != std::string::npos)
      return error("invalid-native-document",
                   "CDM text cannot contain embedded NUL.");
    // Require a CDM document discriminator before invoking the CCSDS parser.
    if ((xml && content.find("<cdm") == std::string::npos) ||
        (!xml && content.find("CCSDS_CDM_VERS") == std::string::npos))
      return error(
          "invalid-native-document",
          "Content is not a CCSDS CDM document of the declared syntax.");
  }
  std::vector<uint8_t> data(8192);
  int n = -2;
  while (n == -2 && data.size() <= kMaximumDocumentBytes) {
    if (write)
      n = xml ? cdm_sds_to_xml(f->payload, f->payload_length,
                               reinterpret_cast<char *>(data.data()),
                               data.size())
              : cdm_sds_to_kvn(f->payload, f->payload_length,
                               reinterpret_cast<char *>(data.data()),
                               data.size());
    else
      n = xml ? cdm_xml_to_sds(
                    reinterpret_cast<const char *>(d->CONTENT()->Data()),
                    d->CONTENT()->size(), data.data(), data.size())
              : cdm_kvn_to_sds(
                    reinterpret_cast<const char *>(d->CONTENT()->Data()),
                    d->CONTENT()->size(), data.data(), data.size());
    if (n == -2)
      data.resize(data.size() * 2);
  }
  if (n < 0 || has_error())
    return error(
        "invalid-native-document",
        has_error()
            ? error_message()
            : "CDM conversion failed or exceeds bounded document size.");
  data.resize(n);
  if (!write)
    return pushBytes("cdm", "CDM.fbs", "$CDM", "CDM", data.data(), data.size());
  CQRT q;
  q.NATIVE_DOCUMENT = std::make_unique<CQRNativeDocumentT>();
  q.NATIVE_DOCUMENT->SERIALIZATION =
      xml ? cqrDocumentSyntax::CCSDS_CDM_XML : cqrDocumentSyntax::CCSDS_CDM_KVN;
  q.NATIVE_DOCUMENT->CONTENT = std::move(data);
  return push(q, port);
}
ConjunctionEvent legacy(const ConjunctionEvent2 &e) {
  ConjunctionEvent l;
  l.obj1.name = e.obj1_name;
  l.obj1.object_id = e.obj1_id;
  l.obj1.norad_cat_id = e.obj1_norad;
  l.obj2.name = e.obj2_name;
  l.obj2.object_id = e.obj2_id;
  l.obj2.norad_cat_id = e.obj2_norad;
  l.tca_jd = e.tca_jd;
  l.tca_iso = e.tca_iso;
  l.state1 = e.state1;
  l.state2 = e.state2;
  l.min_range_km = e.miss_distance_km;
  l.rel_speed_kms = e.relative_speed_kms;
  l.max_probability = e.pc.max_probability;
  l.probability_method = e.pc.method;
  l.rel_pos_r = e.rel_r;
  l.rel_pos_t = e.rel_t;
  l.rel_pos_n = e.rel_n;
  l.rel_vel_r = e.rel_vr;
  l.rel_vel_t = e.rel_vt;
  l.rel_vel_n = e.rel_vn;
  l.dse1 = e.dse1;
  l.dse2 = e.dse2;
  auto c1 = covariance_inertial_to_rtn(e.cov1, e.state1),
       c2 = covariance_inertial_to_rtn(e.cov2, e.state2);
  l.cov_r1 = std::sqrt(std::max(0., c1.data[0])) * 1000.;
  l.cov_t1 = std::sqrt(std::max(0., c1.data[4])) * 1000.;
  l.cov_n1 = std::sqrt(std::max(0., c1.data[8])) * 1000.;
  l.cov_r2 = std::sqrt(std::max(0., c2.data[0])) * 1000.;
  l.cov_t2 = std::sqrt(std::max(0., c2.data[4])) * 1000.;
  l.cov_n2 = std::sqrt(std::max(0., c2.data[8])) * 1000.;
  return l;
}
bool emit(bool csm) {
  auto q = request();
  Source a, b;
  ScreeningConfig c;
  if (!q || !pair(q->PAIR_REQUEST(), a, b, c))
    return false;
  auto p = q->PAIR_REQUEST();
  auto alg = p->CONTROLS()->ALGORITHM();
  ConjunctionEvent e;
  if (a.mean && b.mean && alg == cqrProbabilityAlgorithm::ALFANO_MAXIMUM) {
    double t = conjunction::find_tca(a.tle, b.tle, c.start_jd, c.duration_days,
                                     c.coarse_step_sec, c.fine_tol_sec);
    e = assess_conjunction_at_tca(a.tle, b.tle, t, p->PRIMARY_RADIUS_M(),
                                  p->SECONDARY_RADIUS_M());
  } else {
    ConjunctionEngine engine;
    engine.set_pc_method(algorithm(alg));
    engine.set_combined_radius_m(p->PRIMARY_RADIUS_M(),
                                 p->SECONDARY_RADIUS_M());
    e = legacy(engine.assess(*a.provider, *b.provider, c.start_jd,
                             c.duration_days, nullptr, nullptr,
                             c.coarse_step_sec, c.fine_tol_sec));
  }
  if (has_error())
    return error("pair-evaluation-failed", error_message());
  std::vector<uint8_t> data(8192);
  int n = -2;
  while (n == -2 && data.size() <= kMaximumDocumentBytes) {
    n = csm ? conjunction_to_csm(e, data.data(), data.size())
            : conjunction_to_cdm(e, data.data(), data.size(),
                                 a.axes == 1   ? "TEME"
                                 : a.axes == 2 ? "GCRF"
                                               : "EME2000");
    if (n == -2)
      data.resize(data.size() * 2);
  }
  if (n < 0)
    return error("serialization-failed",
                 "Unable to serialize conjunction message.");
  return pushBytes(csm ? "csm" : "cdm", csm ? "CSM.fbs" : "CDM.fbs",
                   csm ? "$CSM" : "$CDM", csm ? "CSM" : "CDM", data.data(), n);
}
// Providers execute physics in C++; each worker writes private results. Merge
// order and statistics are independent of worker scheduling.
bool screenSources(const std::vector<Source> &p, const std::vector<Source> &s,
                   const ScreeningConfig &c, cqrProbabilityAlgorithm alg,
                   ScreeningStats &stats,
                   std::vector<std::unique_ptr<CQREventT>> &events,
                   std::vector<std::vector<uint8_t>> &excluded,
                   const std::vector<uint32_t> *primary_handles = nullptr) {
  stats.total_objects = p.size() + s.size();
  if (p.empty())
    return error("invalid-catalog", "At least one primary source is required.");
  bool means =
      std::all_of(p.begin(), p.end(), [](auto &x) { return x.mean; }) &&
      std::all_of(s.begin(), s.end(), [](auto &x) { return x.mean; });
  if (means && !primary_handles && alg == cqrProbabilityAlgorithm::ALFANO_MAXIMUM) {
    std::vector<GPElement> a, b;
    for (auto &x : p)
      a.push_back(x.gp);
    for (auto &x : s)
      b.push_back(x.gp);
    ConjunctionScreener screener(c);
    auto results = b.empty() ? screener.screen(a) : screener.screen(a, b);
    stats = screener.stats();
    if (has_error())
      return error("screening-failed", error_message());
    for (auto &e : results)
      events.push_back(event(e));
    for (const auto &x : stats.excluded_objects) {
      const auto &list = x.input_list == 1 ? s : p;
      if (x.input_list < 0 || x.input_index >= list.size())
        return error("screening-failed",
                     "Excluded object has no source in the request.");
      excluded.push_back(excludedRecord(list[x.input_index], x));
    }
    return true;
  }
  struct Worker {
    std::vector<std::unique_ptr<CQREventT>> events;
    uint64_t pairs = 0, failed = 0;
  };
  unsigned workers = std::min<size_t>(c.num_threads, p.size());
  std::vector<bool> primary(p.size(), true);
  if (primary_handles && !primary_handles->empty())
    for (size_t i = 0; i < p.size(); ++i)
      primary[i] = std::find(primary_handles->begin(), primary_handles->end(),
                            p[i].handle) != primary_handles->end();
  std::vector<Worker> work(workers);
  std::vector<std::thread> threads;
  auto run = [&](unsigned worker) {
    clear_error();
    ConjunctionEngine e;
    e.set_pc_method(algorithm(alg));
    e.set_combined_radius_m(c.combined_radius_m / 2., c.combined_radius_m / 2.);
    auto &w = work[worker];
    for (size_t i = worker; i < p.size(); i += workers) {
      size_t end = s.empty() ? p.size() : s.size();
      for (size_t j = s.empty() ? i + 1 : 0; j < end; ++j) {
        // Resident selection means every unordered pair with at least one
        // primary, including pairs where both objects are selected primaries.
        if (primary_handles && s.empty() && !primary[i] && !primary[j])
          continue;
        auto &b = s.empty() ? p[j] : s[j];
        if (p[i].provider->object_id() == b.provider->object_id())
          continue;
        ++w.pairs;
        clear_error();
        auto result =
            e.assess(*p[i].provider, *b.provider, c.start_jd, c.duration_days,
                     nullptr, nullptr, c.coarse_step_sec, c.fine_tol_sec);
        if (has_error() || !isFinite(result.miss_distance_km) ||
            !isFinite(result.tca_jd)) {
          ++w.failed;
          clear_error();
          continue;
        }
        if (result.miss_distance_km <= c.threshold_km) {
          auto output = event(result, alg, p[i].axes);
          // Serialization also validates probability metadata. A worker-local
          // failure must not disappear when the next pair clears its status.
          if (has_error()) {
            ++w.failed;
            clear_error();
            continue;
          }
          w.events.push_back(std::move(output));
        }
      }
    }
  };
  for (unsigned t = 1; t < workers; ++t)
    threads.emplace_back(run, t);
  run(0);
  for (auto &t : threads)
    t.join();
  for (auto &w : work) {
    stats.pairs_screened += w.pairs;
    stats.failed_pairs += w.failed;
    for (auto &e : w.events)
      events.push_back(std::move(e));
  }
  stats.tca_refined = stats.pairs_screened - stats.failed_pairs;
  stats.conjunctions_found = events.size();
  return true;
}
} // namespace ca_cqr
extern "C" int parse_cdm_kvn() {
  return ca_cqr::document(false, false) ? 0 : 400;
}
extern "C" int parse_cdm_xml() {
  return ca_cqr::document(true, false) ? 0 : 400;
}
extern "C" int write_cdm_kvn() {
  return ca_cqr::document(false, true) ? 0 : 400;
}
extern "C" int write_cdm_xml() {
  return ca_cqr::document(true, true) ? 0 : 400;
}
extern "C" int emit_cdm() { return ca_cqr::emit(false) ? 0 : 400; }
extern "C" int emit_csm() { return ca_cqr::emit(true) ? 0 : 400; }
extern "C" int version() {
  using namespace ca_cqr;
  auto q = request();
  if (!q || !q->VERSION_QUERY())
    return error("invalid-request-arm", "version requires VERSION_QUERY."), 400;
  CQRT out;
  out.VERSION_RESULT = std::make_unique<CQRVersionResultT>();
  out.VERSION_RESULT->VERSION = "0.2.0";
  return push(out) ? 0 : 500;
}

namespace ca_cqr {
// One $OMM catalog frame per object, as every catalog method reads them.
bool catalogFrames(const ScreeningConfig &c, int f, std::vector<Source> &catalog) {
  for (uint32_t i = 0; auto in = input("catalog", i); ++i) {
    auto omm = decode<OMM>(in, "$OMM");
    Source v;
    if (!gpRecord(omm, v.gp))
      return false;
    // OMM's international designator is optional. Preserve a distinct object
    // identity for generic provider screening when only a catalog ID is known.
    if (v.gp.object_id.empty()) {
      if (v.gp.norad_cat_id <= 0)
        return error("invalid-source", "Catalog OMM needs OBJECT_ID or a positive NORAD_CAT_ID.");
      v.gp.object_id = std::to_string(v.gp.norad_cat_id);
      v.object_id_from_norad = true;
    }
    v.tle = gp_to_tle(v.gp);
    v.mean = true;
    v.axes = 1;
    v.provider = std::make_shared<GPEphemerisSource>(v.gp);
    if (!window(v, c, f))
      return false;
    catalog.push_back(std::move(v));
  }
  return true;
}
} // namespace ca_cqr

extern "C" int screen_catalog() {
  using namespace ca_cqr;
  auto q = request();
  if (!q || !q->CATALOG_REQUEST())
    return error("invalid-request-arm",
                 "screen_catalog requires CATALOG_REQUEST."),
           400;
  if (hasPending("screen_catalog"))
    return emitPending("screen_catalog") ? 0 : 422;
  auto r = q->CATALOG_REQUEST();
  ScreeningConfig c;
  if (!controls(r->CONTROLS(), c))
    return 400;
  int f = frame(r->EVALUATION_FRAME());
  if (!f)
    return 400;
  std::vector<Source> p, s;
  auto append = [&](const auto *values, std::vector<Source> &target) {
    if (values)
      for (auto x : *values) {
        Source v;
        if (!source(x, v) || !window(v, c, f))
          return false;
        target.push_back(std::move(v));
      }
    return true;
  };
  std::vector<Source> catalog;
  if (!catalogFrames(c, f, catalog))
    return 400;
  if (!catalog.empty()) {
    if ((r->PRIMARIES() && r->PRIMARIES()->size()) ||
        (r->SECONDARIES() && r->SECONDARIES()->size()))
      return error("ambiguous-catalog",
                   "Supply inline sources or catalog port frames, not both."),
             400;
    std::vector<uint32_t> order;
    if (r->ORDERED_CATALOG_INDICES())
      for (auto i : *r->ORDERED_CATALOG_INDICES()) {
        if (i >= catalog.size())
          return error("invalid-catalog-index",
                       "Ordered catalog index is out of range."),
                 400;
        order.push_back(i);
      }
    else
      for (uint32_t i = 0; i < catalog.size(); ++i)
        order.push_back(i);
    size_t a = r->HAS_START_ORDER_INDEX() ? r->START_ORDER_INDEX() : 0,
           b = r->HAS_END_ORDER_INDEX() ? r->END_ORDER_INDEX() : order.size();
    if (a > b || b > order.size())
      return error("invalid-catalog-range", "Primary order range is invalid."),
             400;
    for (size_t i = a; i < b; ++i)
      p.push_back(catalog[order[i]]);
    if (r->HAS_SECONDARY_START_ORDER_INDEX() ||
        r->HAS_SECONDARY_END_ORDER_INDEX()) {
      size_t x = r->HAS_SECONDARY_START_ORDER_INDEX()
                     ? r->SECONDARY_START_ORDER_INDEX()
                     : 0,
             y = r->HAS_SECONDARY_END_ORDER_INDEX()
                     ? r->SECONDARY_END_ORDER_INDEX()
                     : order.size();
      if (x > y || y > order.size())
        return error("invalid-catalog-range",
                     "Secondary order range is invalid."),
               400;
      for (size_t i = x; i < y; ++i)
        s.push_back(catalog[order[i]]);
    }
  } else {
    if (r->ORDERED_CATALOG_INDICES() || r->HAS_START_ORDER_INDEX() ||
        r->HAS_END_ORDER_INDEX() || r->HAS_SECONDARY_START_ORDER_INDEX() ||
        r->HAS_SECONDARY_END_ORDER_INDEX())
      return error("invalid-catalog-order",
                   "Catalog ranges require catalog port frames."),
             400;
    if (!append(r->PRIMARIES(), p) || !append(r->SECONDARIES(), s))
      return 400;
  }
  ScreeningStats stats;
  std::vector<std::unique_ptr<CQREventT>> events;
  std::vector<std::vector<uint8_t>> excluded;
  if (!screenSources(p, s, c, r->CONTROLS()->ALGORITHM(), stats, events,
                     excluded))
    return 422;
  return catalogOutput(std::move(events), stats, "screen_catalog",
                       std::move(excluded))
             ? 0
             : 422;
}

namespace ca_cqr {
struct Index {
  std::unique_ptr<PRWInstanceT> instance;
  std::vector<Source> sources;
  std::vector<uint32_t> primaries;
  uint32_t native_handle = 0;
  int axes = 0;
};
std::map<uint32_t, Index> indexes;
uint32_t next_index = 1;
bool identity(const PRWInstance *i) {
  return (i && !text(i->MODULE_ID()).empty() &&
          !text(i->INSTANCE_ID()).empty()) ||
         error("invalid-instance", "Resident operation requires a named module "
                                   "and instance identity.");
}
bool matches(const PRWInstance *a, const PRWInstanceT &b) {
  return a && text(a->MODULE_ID()) == b.MODULE_ID &&
         text(a->INSTANCE_ID()) == b.INSTANCE_ID &&
         a->GENERATION() == b.GENERATION;
}
Index *index(uint32_t h, const PRWInstance *i) {
  auto it = indexes.find(h);
  if (it == indexes.end() || !matches(i, *it->second.instance)) {
    error("invalid-index-handle",
          "Unknown index or stale instance generation.");
    return nullptr;
  }
  return &it->second;
}
bool prepare(cqrIndexRepresentation expected) {
  auto q = request();
  if (!q || !q->INDEX_REQUEST())
    return error("invalid-request-arm",
                 "Resident preparation requires INDEX_REQUEST.");
  auto r = q->INDEX_REQUEST();
  if (!identity(r->INSTANCE()) || r->INDEX_CONTENT() != expected)
    return error("invalid-index-representation",
                 "INDEX_CONTENT must match the resident method.");
  if (r->REFINEMENT_MODE() < cqrRefinementStrategy::EXACT_ONLY ||
      r->REFINEMENT_MODE() >
          cqrRefinementStrategy::POLYNOMIAL_WITH_EXACT_POLISH)
    return error("unsupported-refinement",
                 "An explicit refinement strategy is required.");
  if (!r->SOURCES() || !r->SOURCES()->size())
    return error("invalid-source", "Resident preparation needs typed SOURCES.");
  Index result;
  result.instance.reset(r->INSTANCE()->UnPack());
  std::vector<ResidentSourceDescription> descriptions;
  std::vector<uint32_t> selected;
  if (r->SOURCE_HANDLES())
    selected.assign(r->SOURCE_HANDLES()->begin(), r->SOURCE_HANDLES()->end());
  for (auto s : *r->SOURCES()) {
    if (!s)
      return error("invalid-source", "Null resident source.");
    if (!selected.empty() && std::find(selected.begin(), selected.end(),
                                       s->SOURCE_HANDLE()) == selected.end())
      continue;
    Source v;
    if (!source(s, v))
      return false;
    if (!v.handle)
      return error("invalid-source-handle",
                   "Resident source handles must be nonzero.");
    for (auto &prev : result.sources)
      if (prev.handle == v.handle)
        return error("invalid-source-handle",
                     "Resident source handles must be unique.");
    if (result.axes && result.axes != v.axes)
      return error("frame-mismatch",
                   "Resident sources must share an explicit frame.");
    result.axes = v.axes;
    descriptions.push_back({v.handle, v.gp});
    result.sources.push_back(std::move(v));
  }
  if (result.sources.empty())
    return error("invalid-source-selection", "Source selection is empty.");
  for (auto h : selected) {
    bool found = false;
    for (auto &s : result.sources)
      found |= s.handle == h;
    if (!found)
      return error("invalid-source-selection",
                   "Requested source handle is absent.");
  }
  if (r->PRIMARY_SOURCE_HANDLES())
    result.primaries.assign(r->PRIMARY_SOURCE_HANDLES()->begin(),
                            r->PRIMARY_SOURCE_HANDLES()->end());
  for (auto h : result.primaries) {
    bool found = false;
    for (auto &s : result.sources)
      found |= s.handle == h;
    if (!found)
      return error("invalid-source-selection",
                   "Primary source handle is absent.");
  }
  bool all_mean = std::all_of(result.sources.begin(), result.sources.end(),
                              [](auto &s) { return s.mean; });
  if (expected == cqrIndexRepresentation::SOURCE_DESCRIPTIONS) {
    if (r->REFINEMENT_MODE() != cqrRefinementStrategy::EXACT_ONLY)
      return error("unsupported-refinement",
                   "Source-description indexes require EXACT_ONLY.");
    if (all_mean) {
      auto built = prepare_resident_screening_index(
          r->CATALOG_HANDLE(), result.primaries, descriptions);
      if (has_error())
        return error("index-preparation-failed", error_message());
      result.native_handle = built.screening_index_handle;
    }
  } else if (expected == cqrIndexRepresentation::SAMPLED_STATES) {
    for (auto &s : result.sources)
      if (s.samples.empty())
        return error(
            "invalid-source",
            "SAMPLED_STATES requires OEM sampled ephemeris for every source.");
    if (r->REFINEMENT_MODE() != cqrRefinementStrategy::EXACT_ONLY)
      return error("unsupported-refinement",
                   "Sampled OEM indexes currently evaluate Hermite tracks with "
                   "EXACT_ONLY; no polynomial quality bound is inferred.");
  } else {
    std::vector<ResidentTrajectorySegment> segments;
    if (auto segment_result = r->SEGMENTS()) {
      if (!matches(segment_result->INSTANCE(), *result.instance) ||
          segment_result->SEGMENT_SET_HANDLE() != r->SEGMENT_SET_HANDLE() ||
          segment_result->SOURCE_OFFSET() != 0 ||
          !segment_result->FINAL_CHUNK())
        return error("invalid-segment-set",
                     "SEGMENTS must be a complete matching instance and "
                     "segment-set record.");
      if (!segment_result->SOURCES())
        return error("invalid-segment-set", "SEGMENTS contains no sources.");
      for (auto entry : *segment_result->SOURCES()) {
        if (!entry)
          return error("invalid-segment-set", "Null trajectory source.");
        auto found = std::find_if(
            result.sources.begin(), result.sources.end(),
            [&](auto &s) { return s.handle == entry->SOURCE_HANDLE(); });
        if (found == result.sources.end())
          return error("invalid-segment-set",
                       "PPE source handle is absent from typed sources.");
        Source p;
        if (!polynomial(entry->EPHEMERIS(), p))
          return false;
        if (p.axes != found->axes)
          return error("frame-mismatch",
                       "PPE and exact source frames disagree.");
        p.polynomial->id = found->provider->object_id();
        p.polynomial->name = found->provider->object_name();
        p.polynomial->norad = found->provider->norad_id();
        found->polynomial = p.polynomial;
      }
    }
    for (auto &s : result.sources) {
      if (!s.polynomial)
        return error("invalid-segment-set",
                     "Every resident source requires PPE segments.");
      for (auto &p : s.polynomial->records()) {
        if (all_mean) {
          if (p.c[0].size() > RESIDENT_CHEBYSHEV_COEFFICIENT_COUNT)
            return error(
                "unsupported-polynomial",
                "Exact-polish resident kernel supports degree at most 12.");
          ResidentTrajectorySegment out;
          out.source_handle = s.handle;
          out.start_jd = p.mid - p.half / 86400.;
          out.end_jd = p.mid + p.half / 86400.;
          out.degree = p.c[0].size() - 1;
          out.reference_frame = 2;
          std::array<std::array<double, 13> *, 6> dst = {
              &out.x_coefficients,  &out.y_coefficients,  &out.z_coefficients,
              &out.vx_coefficients, &out.vy_coefficients, &out.vz_coefficients};
          for (size_t k = 0; k < 6; ++k)
            std::copy(p.c[k].begin(), p.c[k].end(), dst[k]->begin());
          segments.push_back(out);
        }
      }
    }
    if (all_mean) {
      ScreeningMode mode =
          r->REFINEMENT_MODE() == cqrRefinementStrategy::EXACT_ONLY
              ? ScreeningMode::exact_only
          : r->REFINEMENT_MODE() == cqrRefinementStrategy::POLYNOMIAL_ONLY
              ? ScreeningMode::polynomial_only
              : ScreeningMode::polynomial_plus_exact_polish;
      auto built = prepare_resident_segment_screening_index(
          r->CATALOG_HANDLE(), r->SEGMENT_SET_HANDLE(), result.primaries, mode,
          descriptions, segments);
      if (has_error())
        return error("index-preparation-failed", error_message());
      result.native_handle = built.screening_index_handle;
    } else {
      if (r->REFINEMENT_MODE() != cqrRefinementStrategy::POLYNOMIAL_ONLY)
        return error("unsupported-refinement",
                     "Non-mean PPE sources require POLYNOMIAL_ONLY; exact "
                     "polish requires an independently supplied provider.");
      for (auto &s : result.sources) {
        s.provider = s.polynomial;
        s.mean = false;
      }
    }
  }
  // A new generation invalidates prior handles in the same named instance.
  for (auto it = indexes.begin(); it != indexes.end();) {
    auto &old = *it->second.instance;
    if (old.MODULE_ID == result.instance->MODULE_ID &&
        old.INSTANCE_ID == result.instance->INSTANCE_ID &&
        old.GENERATION != result.instance->GENERATION) {
      if (it->second.native_handle)
        destroy_resident_screening_index(it->second.native_handle);
      it = indexes.erase(it);
    } else
      ++it;
  }
  uint32_t h = next_index++;
  if (!h)
    return error("index-capacity", "Resident index handle space exhausted.");
  uint64_t n = result.sources.size(), pairs = n * (n - 1) / 2;
  if (!result.primaries.empty()) {
    uint64_t secondary_count = 0;
    for (const auto &s : result.sources)
      if (std::find(result.primaries.begin(), result.primaries.end(), s.handle) ==
          result.primaries.end())
        ++secondary_count;
    if (secondary_count > 1)
      pairs -= secondary_count * (secondary_count - 1) / 2;
  }
  if (result.native_handle) {
    auto i = find_resident_screening_index(result.native_handle);
    if (i)
      pairs = i->candidate_pair_count;
  }
  CQRT out;
  out.INDEX_RESULT = std::make_unique<CQRIndexResultT>();
  out.INDEX_RESULT->INSTANCE = std::make_unique<PRWInstanceT>(*result.instance);
  out.INDEX_RESULT->SCREENING_INDEX_HANDLE = h;
  out.INDEX_RESULT->SOURCE_COUNT = n;
  out.INDEX_RESULT->CANDIDATE_PAIR_COUNT = pairs;
  indexes.emplace(h, std::move(result));
  return push(out);
}
bool screenWindow(const char *method) {
  auto q = request();
  if (!q || !q->WINDOW_REQUEST())
    return error("invalid-request-arm",
                 "Resident screening requires WINDOW_REQUEST.");
  if (hasPending(method))
    return emitPending(method);
  auto r = q->WINDOW_REQUEST();
  auto i = index(r->SCREENING_INDEX_HANDLE(), r->INSTANCE());
  if (!i)
    return false;
  ScreeningConfig c;
  if (!controls(r->CONTROLS(), c))
    return false;
  int f = frame(r->EVALUATION_FRAME());
  if (!f || f != i->axes)
    return error("frame-mismatch",
                 "Window evaluation frame differs from the resident index.");
  for (auto &s : i->sources)
    if (!window(s, c, f))
      return false;
  if (i->native_handle) {
    if (r->CONTROLS()->ALGORITHM() != cqrProbabilityAlgorithm::ALFANO_MAXIMUM)
      return error(
          "unsupported-algorithm",
          "Optimized resident GP index currently uses ALFANO_MAXIMUM.");
    auto native = find_resident_screening_index(i->native_handle);
    if (!native)
      return error("invalid-index-handle", "Resident native index is absent.");
    ScreeningStats stats;
    auto events = screen_resident_index_window(*native, c, stats);
    if (has_error())
      return error("screening-failed", error_message());
    std::vector<std::vector<uint8_t>> excluded;
    for (const auto &x : stats.excluded_objects) {
      auto found = std::find_if(i->sources.begin(), i->sources.end(),
                                [&](auto &s) { return s.handle == x.source_handle; });
      if (!x.source_handle || found == i->sources.end())
        return error("screening-failed",
                     "Excluded object has no resident source.");
      excluded.push_back(excludedRecord(*found, x));
    }
    return catalogOutput(events, stats, method, std::move(excluded));
  }
  ScreeningStats stats;
  std::vector<std::unique_ptr<CQREventT>> events;
  std::vector<std::vector<uint8_t>> excluded;
  if (!screenSources(i->sources, {}, c, r->CONTROLS()->ALGORITHM(), stats, events,
                     excluded, &i->primaries))
    return false;
  return catalogOutput(std::move(events), stats, method, std::move(excluded));
}
} // namespace ca_cqr
namespace ca_cqr {
// The tight path screens a resident index (prepare_screening_index and its
// siblings) all-vs-all: ALFANO_MAXIMUM, no primaries, every source able to
// bound its motion between coarse steps. Mean elements are evaluated with
// SGP4; every other source is the trajectory its propagator supplied.
struct TightSet {
  Index *index = nullptr;
  SourceRefs refs;
};
bool tightRequest(const char *method, ScreeningConfig &c, TightSet &t) {
  auto q = request();
  if (!q || !q->WINDOW_REQUEST())
    return error("invalid-request-arm", std::string(method) + " requires WINDOW_REQUEST.");
  auto r = q->WINDOW_REQUEST();
  t.index = index(r->SCREENING_INDEX_HANDLE(), r->INSTANCE());
  if (!t.index)
    return false;
  if (!controls(r->CONTROLS(), c))
    return false;
  int f = frame(r->EVALUATION_FRAME());
  if (!f || f != t.index->axes)
    return error("frame-mismatch", "Window evaluation frame differs from the resident index.");
  if (r->CONTROLS()->ALGORITHM() != cqrProbabilityAlgorithm::ALFANO_MAXIMUM)
    return error("unsupported-algorithm", std::string(method) + " screens with ALFANO_MAXIMUM, as screen_catalog's all-vs-all path.");
  if (!t.index->primaries.empty())
    return error("unsupported-index", std::string(method) + " screens every source against every other; the index names primaries.");
  if (t.index->sources.size() < 2)
    return error("invalid-catalog", "At least two sources are required.");
  for (auto &s : t.index->sources) {
    if (!window(s, c, f))
      return false;
    const EphemerisSource *e = s.sgp4 ? s.sgp4.get() : s.polynomial ? s.polynomial.get() : s.provider.get();
    if (!e->bounds_path_deviation())
      return error("unsupported-source", "Source " + e->object_id() +
                   " cannot bound its motion between coarse steps; supply its trajectory as PPE.");
    t.refs.push_back(e);
  }
  return true;
}

// Little-endian binary control frames: a 4-byte tag, then u32 / f64 fields.
struct Reader {
  const uint8_t *p = nullptr;
  size_t n = 0, at = 0;
  bool tag(const char *t) {
    if (n < 4 || std::memcmp(p, t, 4) != 0) return false;
    at = 4;
    return true;
  }
  template <class T> bool get(T &v) {
    if (at + sizeof(T) > n) return false;
    std::memcpy(&v, p + at, sizeof(T));
    at += sizeof(T);
    return true;
  }
};
Reader reader(const plugin_input_frame_t *f) {
  Reader r;
  if (f && f->payload) { r.p = f->payload; r.n = f->payload_length; }
  return r;
}
std::string jsonString(const std::string &s) {
  std::string o = "\"";
  for (char ch : s) {
    if (ch == '"' || ch == '\\') { o.push_back('\\'); o.push_back(ch); }
    else if (static_cast<unsigned char>(ch) < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", ch); o += b; }
    else o.push_back(ch);
  }
  return o + "\"";
}
} // namespace ca_cqr

// One block of coarse steps in the GPU layout (screening_tight.h).
// Inputs: request ($CQR WINDOW_REQUEST on a resident index), block
// ("CAB1", u32 first_step, u32 step_count). Outputs: grid ("CAG1", u32
// first_step, u32 step_count, u32 objects, then f32 states [step][object][8]
// and f32 bands [object][2]) and report (JSON: the block and its exclusions).
extern "C" int coarse_grid() {
  using namespace ca_cqr;
  ScreeningConfig c;
  TightSet t;
  if (!tightRequest("coarse_grid", c, t))
    return 400;
  auto b = reader(input("block"));
  uint32_t first = 0, count = 0;
  if (!b.tag("CAB1") || !b.get(first) || !b.get(count))
    return error("invalid-block", "block must be CAB1, u32 first_step, u32 step_count."), 400;
  const int32_t last = tight_last_coarse_step(c);
  if (count == 0 || count > 256 || static_cast<int64_t>(first) + count - 1 > last)
    return error("invalid-block", "The block must hold 1 to 256 steps of the window (steps 0.." + std::to_string(last) + ")."), 400;
  auto g = tight_coarse_grid_block(t.refs, c, static_cast<int32_t>(first), static_cast<int32_t>(count), {});
  std::vector<uint8_t> out(16 + (g.states.size() + g.bands.size()) * sizeof(float));
  const uint32_t header[4] = {0x31474143u /* "CAG1" */, first, count, g.objects};
  std::memcpy(out.data(), header, 16);
  std::memcpy(out.data() + 16, g.states.data(), g.states.size() * sizeof(float));
  std::memcpy(out.data() + 16 + g.states.size() * sizeof(float), g.bands.data(), g.bands.size() * sizeof(float));
  std::string report = "{\"first_step\":" + std::to_string(first) + ",\"step_count\":" + std::to_string(count) +
                       ",\"last_step\":" + std::to_string(last) + ",\"objects\":" + std::to_string(g.objects) + ",\"excluded\":[";
  bool comma = false;
  for (const auto &[index, x] : g.excluded) {
    char jd[40];
    std::snprintf(jd, sizeof jd, "%.17g", x.first_failure_jd);
    report += std::string(comma ? "," : "") + "{\"index\":" + std::to_string(index) + ",\"first_failure_jd\":" + jd +
              ",\"reason\":" + jsonString(x.reason) + "}";
    comma = true;
  }
  report += "]}";
  if (plugin_push_output_ex("grid", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 16,
                            out.data(), static_cast<uint32_t>(out.size())) < 0)
    return 500;
  return plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t *>(report.data()),
                               static_cast<uint32_t>(report.size())) < 0 ? 500 : 0;
}

// Refines candidate pairs into the catalog result screen_catalog returns.
// Inputs: request as coarse_grid; candidates ("CAC1", u32 count,
// then count x (u32 obj1, u32 obj2, u32 step)) - absent: scan every pair on
// the CPU; excluded ("CAX1", u32 count, then count x (u32 index, f64
// first_failure_jd)) - the exclusions coarse_grid reported for the window.
extern "C" int refine_candidates() {
  using namespace ca_cqr;
  if (hasPending("refine_candidates"))
    return emitPending("refine_candidates") ? 0 : 422;
  ScreeningConfig c;
  TightSet t;
  if (!tightRequest("refine_candidates", c, t))
    return 400;
  std::map<uint32_t, ExcludedObject> excluded;
  if (auto xf = input("excluded")) {
    auto x = reader(xf);
    uint32_t count = 0;
    if (!x.tag("CAX1") || !x.get(count))
      return error("invalid-excluded", "excluded must be CAX1, u32 count, then u32 index + f64 first_failure_jd."), 400;
    for (uint32_t k = 0; k < count; ++k) {
      uint32_t index = 0;
      double jd = 0;
      if (!x.get(index) || !x.get(jd) || index >= t.refs.size() || !std::isfinite(jd))
        return error("invalid-excluded", "An excluded entry is truncated or out of range."), 400;
      ExcludedObject e;
      e.index = index;
      e.first_failure_jd = jd;
      conjunction::StateVector state;
      double deviation = 0;
      e.reason = "excluded by coarse_grid";      // the source's own reason at that epoch
      tight_sample(*t.refs[index], jd, 0.5 * c.coarse_step_sec, state, deviation, e.reason);
      excluded[index] = e;
    }
  }
  std::vector<TightCandidate> candidates;
  const auto cf = input("candidates");
  if (cf) {
    auto r = reader(cf);
    uint32_t count = 0;
    if (!r.tag("CAC1") || !r.get(count) || r.n != 8 + static_cast<size_t>(count) * 12)
      return error("invalid-candidates", "candidates must be CAC1, u32 count, then count x (u32 obj1, u32 obj2, u32 step)."), 400;
    candidates.resize(count);
    for (auto &k : candidates) {
      uint32_t step = 0;
      r.get(k.obj1); r.get(k.obj2); r.get(step);
      k.step = static_cast<int32_t>(step);
    }
  }
  ScreeningStats stats;
  auto events = screen_tight_candidates(t.refs, c, cf ? &candidates : nullptr, std::move(excluded), stats);
  if (conjunction::has_error())
    return error("screening-failed", conjunction::error_message()), 422;
  std::vector<std::unique_ptr<CQREventT>> out;
  for (auto &e : events)
    out.push_back(event(e));
  std::vector<std::vector<uint8_t>> excludedRecords;
  for (const auto &x : stats.excluded_objects)
    excludedRecords.push_back(excludedRecord(t.index->sources[x.index], x));
  return catalogOutput(std::move(out), stats, "refine_candidates", std::move(excludedRecords)) ? 0 : 422;
}

extern "C" int prepare_screening_index() {
  return ca_cqr::prepare(cqrIndexRepresentation::SOURCE_DESCRIPTIONS) ? 0 : 400;
}
extern "C" int prepare_segment_screening_index() {
  return ca_cqr::prepare(cqrIndexRepresentation::POLYNOMIAL_SEGMENTS) ? 0 : 400;
}
extern "C" int prepare_sample_screening_index() {
  return ca_cqr::prepare(cqrIndexRepresentation::SAMPLED_STATES) ? 0 : 400;
}
extern "C" int screen_window() { return ca_cqr::screenWindow("screen_window") ? 0 : 422; }
extern "C" int screen_segment_window() {
  return ca_cqr::screenWindow("screen_segment_window") ? 0 : 422;
}
extern "C" int destroy_screening_index() {
  using namespace ca_cqr;
  auto q = request();
  if (!q || !q->DESTROY_REQUEST())
    return error("invalid-request-arm",
                 "destroy_screening_index requires DESTROY_REQUEST."),
           400;
  auto r = q->DESTROY_REQUEST();
  auto i = index(r->SCREENING_INDEX_HANDLE(), r->INSTANCE());
  if (!i)
    return 400;
  if (i->native_handle && !destroy_resident_screening_index(i->native_handle))
    return error("invalid-index-handle", "Native index destruction failed."),
           400;
  indexes.erase(r->SCREENING_INDEX_HANDLE());
  return 0;
}
