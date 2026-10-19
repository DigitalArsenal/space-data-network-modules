// Public conjunction contract: published SDS CQR records on the SDK invoke ABI.
// The SDK owns PIV/TAB framing, manifest embedding, memory and runtime
// entrypoints.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
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
#include "EOP_generated.h"
#include "ERM_generated.h"
#include "SCR_generated.h"
#include "conjunction/ephemeris_upload.h"
#include "conjunction/earth_orientation.h"
#include "space_data_module_invoke.h"
extern "C" int32_t plugin_set_output_stream_frame(uint32_t, uint64_t, int32_t);
#include "conjunction/conjunction_assessment.h"
#include "conjunction/cdm_builder.h"
#include "conjunction/cdm_metadata.h"
#include "conjunction/conjunction_engine.h"
#include "conjunction/encounter_geometry.h"
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
// Catalog screens use reporting/Monte Carlo floors 1e-4 / 1e-3: this pair
// gave the larger measured timing margin (docs/benchmark.md). Violations
// below 1e-4 retain Pc2D; [1e-4, 1e-3) uses Nc, with MC on Nc's own flags.
// Below 1e-7, curvature may be omitted with an explicit incomplete-usage
// disclosure; rectilinear and velocity checks still determine violations.
// Pair assessments keep Reference grade and the engine's 1e-7 / 1e-4 floors.
constexpr double kCatalogPcReportingFloor = 1e-4;
constexpr double kCatalogPcMonteCarloFloor = 1e-3;
constexpr size_t kEventsPerChunk = 128;
// refine_candidates serves the all-vs-all driver, which drains whole windows:
// larger frames (about 0.9 MB) save a call per 128 events.
constexpr size_t kRefineEventsPerChunk = 1024;
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
bool reserveScreeningHeap(size_t sources, unsigned workers) {
#if defined(__wasm__) && !defined(CONJUNCTION_SINGLE_THREAD)
  if (workers <= 1) return true;
  // V8 14.1 can retain stale bulk-memory bounds in an active instance when
  // another instance grows their shared memory. Reserve the catalog working
  // heap serially, before starting workers. Holding malloc blocks until the
  // target is reached makes the added pages usable by the allocator; raw
  // memory.grow would leave a gap outside its existing managed segments.
  // This preparation target is capped at 1 GiB, half the artifact's 2 GiB
  // limit. It is a reserve for screening, not a bound on every possible input.
  constexpr size_t pageBytes = 65536, blockBytes = 1024 * 1024;
  constexpr size_t maximumReserveBytes = 1024 * blockBytes;
  const uint64_t requestedBytes = 128 * uint64_t(blockBytes) +
      uint64_t(sources) * 24 * 1024 + uint64_t(workers) * 4 * blockBytes;
  const size_t targetPages = (std::min<uint64_t>(maximumReserveBytes, requestedBytes) +
                              pageBytes - 1) / pageBytes;
  const size_t beforePages = __builtin_wasm_memory_size(0);
  if (beforePages >= targetPages) return true;
  std::array<void*, maximumReserveBytes / blockBytes> blocks{};
  size_t count = 0;
  while (__builtin_wasm_memory_size(0) < targetPages && count < blocks.size()) {
    void* block = std::malloc(blockBytes);
    if (!block) break;
    blocks[count++] = block;
    // Keep the allocation observable even under whole-program optimization.
    *static_cast<volatile unsigned char*>(block) = 0;
  }
  const size_t afterPages = __builtin_wasm_memory_size(0);
  while (count) std::free(blocks[--count]);
  if (afterPages < targetPages)
    return error("screening-memory-reserve-failed",
                 "Unable to reserve the bounded working heap before parallel screening.");
#else
  (void)sources;
  (void)workers;
#endif
  return true;
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
// A record with or without a 4-byte size prefix (propagator modules emit
// size-prefixed records; hosts may forward either form). Frames may carry
// alignment padding past the record a prefix declares.
template <class T>
const T *decodeEither(const plugin_input_frame_t *f, const char *id) {
  if (f && f->payload && f->payload_length >= 12 && std::memcmp(f->payload + 8, id, 4) == 0) {
    const size_t declared = flatbuffers::ReadScalar<flatbuffers::uoffset_t>(f->payload) + sizeof(flatbuffers::uoffset_t);
    flatbuffers::Verifier v(f->payload, std::min<size_t>(declared, f->payload_length));
    if (declared <= f->payload_length && v.VerifySizePrefixedBuffer<T>(id))
      return flatbuffers::GetSizePrefixedRoot<T>(f->payload);
    error("invalid-request-frame", "Published SDS FlatBuffer verification failed.");
    return nullptr;
  }
  return decode<T>(f, id);
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
bool isItrfName(const std::string& name) {
  if (name == "ITRF") return true;
  return name.rfind("ITRF", 0) == 0 && (name.size() == 6 || name.size() == 8) &&
      std::all_of(name.begin()+4, name.end(), [](char c) { return c >= '0' && c <= '9'; });
}
int frame(const RFMCoordinateSystem *f, bool source_itrf = false) {
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
  case rfmAxisType::BODY_FIXED:
    if (source_itrf && isItrfName(text(f->NAME()))) return 4;
    error("unsupported-frame", "Earth body-fixed sources must name an ITRF realization.");
    return 0;
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
    return frame(w->COORDINATE_SYSTEM(), true);
  if (auto w = f->REFERENCE_FRAME_as_CelestialFrameWrapper()) {
    switch (w->frame()) {
    case CelestialFrame::ITRF2000:
    case CelestialFrame::ITRF93:
    case CelestialFrame::ITRF97:
      return 4;
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
  // Hard-body radius (m) from the source, and where it came from; 0 when the
  // source gives none (the request's default applies).
  double hard_body_radius_m = 0;
  cqrHardBodyRadiusBasis radius_basis = cqrHardBodyRadiusBasis::UNSPECIFIED;
  // The covariance the source's message supplied (OEM, OCM); empty if none.
  CovarianceSeries covariance;
  CdmObjectMetadata cdm_metadata;
  std::string ephemeris_kind;
  std::vector<int> covariance_frames; // OEM per-row: 0=RTN, otherwise sourceFrame code.
  bool uploaded_oem = false;
  std::vector<double> sample_epoch_remainders, covariance_epoch_remainders;
};
// CDM source facts belong to the bridge, alongside the engine's physics result.
struct CdmEventMetadata {
  CdmObjectMetadata cdm_metadata1, cdm_metadata2;
};
struct BridgeEvent : ConjunctionEvent2, CdmEventMetadata {};
// Prefer an externally supplied source name. Anonymous inline records receive
// a stable descriptive identifier (provider, object, source epoch), not an
// invented external filename or the conjunction's TCA.
void completeSourceCdmMetadata(Source& source) {
  if (!source.cdm_metadata.ephemeris_name.empty() || !source.provider) return;
  const auto id = source.provider->norad_id() > 0 ? std::to_string(source.provider->norad_id()) :
      source.cdm_metadata.catalog_number ? std::to_string(source.cdm_metadata.catalog_number) : source.provider->object_id();
  source.cdm_metadata.ephemeris_name = source.ephemeris_kind;
  if (!id.empty()) source.cdm_metadata.ephemeris_name += "_" + id;
  if (isFinite(source.provider->epoch_jd()) && source.provider->epoch_jd() > 0)
    source.cdm_metadata.ephemeris_name += "_" + jd_to_iso(source.provider->epoch_jd());
}
// The axes of a source's covariance: RTN (RSW), or the source's own state
// frame. Anything else would need a transform the guest does not perform.
bool covarianceAxes(const RFM *f, int state_axes, CovarianceSeries::Axes &axes) {
  axes = CovarianceSeries::Axes::Evaluation;
  if (!f)
    return true;   // CCSDS: absent COV_REF_FRAME means the state frame
  if (auto w = f->REFERENCE_FRAME_as_OrbitFrameWrapper()) {
    if (w->frame() == OrbitFrame::RSW_INERTIAL || w->frame() == OrbitFrame::RSW_ROTATING) {
      axes = CovarianceSeries::Axes::Rtn;
      return true;
    }
  }
  if (auto w = f->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper())
    if (w->COORDINATE_SYSTEM() &&
        w->COORDINATE_SYSTEM()->AXIS_TYPE() == rfmAxisType::ORBITAL_RADIAL_TRANSVERSE_NORMAL) {
      axes = CovarianceSeries::Axes::Rtn;
      return true;
    }
  if (sourceFrame(f, "EARTH") == state_axes)
    return true;
  clear_error();
  return error("covariance-frame-mismatch",
               "Source covariance must be in RTN (RSW) or in the source's own state frame.");
}
// Preserve finite supplied covariance, including non-PSD matrices for CDM output.
bool covarianceRow(double jd, const std::array<double, 21> &lower, CovarianceSeries &series) {
  for (double x : lower)
    if (!isFinite(x))
      return error("invalid-covariance", "Covariance entries must be finite.");
  if (!isFinite(jd) || (!series.jd.empty() && jd <= series.jd.back()))
    return error("invalid-covariance", "Covariance epochs must increase strictly.");
  series.jd.push_back(jd);
  series.lower.push_back(lower);
  return true;
}
// The source's hard-body radius: supplied, else half its catalog SIZE, else
// the radius of a sphere of its catalog RCS.
bool hardBodyRadius(const CQRObjectSource *r, Source &o) {
  if (r->HAS_HARD_BODY_RADIUS_M()) {
    if (!positive(r->HARD_BODY_RADIUS_M()))
      return error("invalid-source", "HARD_BODY_RADIUS_M must be positive and finite.");
    o.hard_body_radius_m = r->HARD_BODY_RADIUS_M();
    o.radius_basis = cqrHardBodyRadiusBasis::SUPPLIED;
  } else if (auto c = r->CATALOG_ENTRY()) {
    if (positive(c->SIZE())) {
      o.hard_body_radius_m = c->SIZE() / 2.;
      o.radius_basis = cqrHardBodyRadiusBasis::CATALOG_SIZE;
    } else if (positive(c->RCS())) {
      o.hard_body_radius_m = std::sqrt(c->RCS() / M_PI);
      o.radius_basis = cqrHardBodyRadiusBasis::RADAR_CROSS_SECTION;
    }
  }
  return true;
}
// The covariance both sources supplied, at the event's TCA, and what their
// messages say about its calibration.
struct SuppliedCovariance {
  bool ready = false, used = false;
  bool calibrated = false;
  std::string reference;
  cqrCovarianceBasis basis1 = cqrCovarianceBasis::SOURCE_EPHEMERIS;
  cqrCovarianceBasis basis2 = cqrCovarianceBasis::SOURCE_EPHEMERIS;
};
// A covariance method's probability from the sources' own covariance, when a
// covariance method was requested and both sources cover the TCA; the event
// keeps the Alfano maximum otherwise.
SuppliedCovariance prepareSourceCovariance(BridgeEvent &e, const Source &a, const Source &b,
                                           cqrProbabilityAlgorithm alg) {
  SuppliedCovariance out;
  e.cdm_metadata1 = a.cdm_metadata;
  e.cdm_metadata2 = b.cdm_metadata;
  e.cdm_metadata1.calibrated = a.covariance.calibrated;
  e.cdm_metadata2.calibrated = b.covariance.calibrated;
  e.cdm_metadata1.calibration_reference = a.covariance.calibration_reference;
  e.cdm_metadata2.calibration_reference = b.covariance.calibration_reference;
  auto basis = [](const CdmObjectMetadata& metadata) {
    using Origin = CdmObjectMetadata::CovarianceOrigin;
    return metadata.covariance_origin == Origin::OrbitDetermination ? cqrCovarianceBasis::ORBIT_DETERMINATION :
        metadata.covariance_origin == Origin::ConjunctionMessage ? cqrCovarianceBasis::CONJUNCTION_MESSAGE :
        cqrCovarianceBasis::SOURCE_EPHEMERIS;
  };
  out.basis1 = basis(e.cdm_metadata1); out.basis2 = basis(e.cdm_metadata2);
  if (has_error()) return out;
  e.has_covariance1 = covariance_rtn_at(a.covariance, e.tca_jd, e.state1, e.cov6_rtn1);
  e.has_covariance2 = covariance_rtn_at(b.covariance, e.tca_jd, e.state2, e.cov6_rtn2);
  if (!e.has_covariance1 || !e.has_covariance2) return out;
  const auto &c1 = e.cov6_rtn1, &c2 = e.cov6_rtn2;
  if (!covariance_is_positive_semidefinite(c1.data(), c1.size()) ||
      !covariance_is_positive_semidefinite(c2.data(), c2.size())) {
    e.probability_failure = "Collision probability calculation failed: covariance not positive semidefinite (non-PSD).";
    return out;
  }
  if (alg == cqrProbabilityAlgorithm::ALFANO_MAXIMUM) {
    e.probability_failure = "Collision probability unavailable: only the Alfano maximum was requested.";
    return out;
  }
  out.ready = true;
  out.calibrated = a.covariance.calibrated && b.covariance.calibrated;
  for (const auto *x : {&a.covariance.calibration_reference, &b.covariance.calibration_reference})
    if (!x->empty())
      out.reference += (out.reference.empty() ? "" : "; ") + *x;
  return out;
}
bool usablePc(const ConjunctionEvent2& computed) {
  return computed.has_covariance && computed.pc.converged && isFinite(computed.pc.probability) &&
      computed.pc.probability >= 0 && computed.pc.probability <= 1 &&
      !computed.pc.method.empty() && computed.pc.method != "ALFANO-SPHERICAL-SMALL-HBR-MAX";
}
void applyComputedCovariance(BridgeEvent& e, SuppliedCovariance& supplied,
                            const ConjunctionEvent2& computed) {
  // Batch computation records worker failures in each result. Do not consume
  // a thread-local error here: it may belong to an earlier event's CDM build.
  const double maximum_probability = e.pc.max_probability;
  e.pc = computed.pc;
  // Nc, Monte Carlo and unavailable results do not compute a spherical
  // maximum. Preserve the geometry's diagnostic and the computed usage text
  // independently, including when the supplied covariance cannot yield Pc.
  e.pc.max_probability = maximum_probability;
  e.usage = computed.usage;
  if (!usablePc(computed)) {
    e.has_covariance = false;
    e.probability_failure = "Collision probability calculation failed: " + computed.pc.failure_reason;
    return;
  }
  e.bplane = computed.bplane;
  e.cov1 = computed.cov1;
  e.cov2 = computed.cov2;
  e.mahalanobis_2d = computed.mahalanobis_2d;
  e.mahalanobis_3d = computed.mahalanobis_3d;
  e.has_covariance = true;
  supplied.used = true;
}
SuppliedCovariance applySourceCovariance(BridgeEvent& e, const Source& a, const Source& b,
                                        const ConjunctionEngine& engine, cqrProbabilityAlgorithm alg) {
  auto supplied = prepareSourceCovariance(e, a, b, alg);
  if (supplied.ready) {
    auto computed = engine.compute_pc(make_pc_encounter(
        e.state1, e.state2, e.cov6_rtn1, e.cov6_rtn2, e.combined_radius_km));
    // A pair call has no batch wrapper to attach its calculation status.
    if (has_error()) {
      computed.has_covariance = false;
      computed.pc.converged = false;
      computed.pc.failure_reason += (computed.pc.failure_reason.empty() ? "" : " ") + std::string(error_message());
      clear_error();
    }
    applyComputedCovariance(e, supplied, computed);
  }
  return supplied;
}
// Labels an event whose probability came from the sources' covariance.
void covarianceLabels(CQREventT &o, const SuppliedCovariance &c) {
  if (!c.used || !o.PROBABILITY ||
      o.PROBABILITY->ALGORITHM == cqrProbabilityAlgorithm::ALFANO_MAXIMUM)
    return;
  o.PRIMARY_COVARIANCE_BASIS = c.basis1;
  o.SECONDARY_COVARIANCE_BASIS = c.basis2;
  o.PROBABILITY->CALIBRATION =
      c.calibrated ? covarianceCalibration::Calibrated : covarianceCalibration::Uncalibrated;
  o.PROBABILITY->CALIBRATION_REFERENCE = c.calibrated ? c.reference : std::string();
  o.PROBABILITY->CROSS_CORRELATION = cqrCovarianceCorrelation::INDEPENDENT;
}
// A source's radius in a screen: its own, else half the request's
// COMBINED_RADIUS_M.
std::pair<double, cqrHardBodyRadiusBasis> radiusOf(const Source &s, const ScreeningConfig &c) {
  if (s.hard_body_radius_m > 0)
    return {s.hard_body_radius_m, s.radius_basis};
  return {c.combined_radius_m / 2., cqrHardBodyRadiusBasis::REQUEST_DEFAULT};
}
// Each source's radius by index, for screening.
void radii(const std::vector<Source> &sources, ScreeningConfig &c) {
  c.hard_body_radius_m.resize(sources.size());
  c.radius_basis.resize(sources.size());
  for (size_t i = 0; i < sources.size(); ++i) {
    const auto [radius, basis] = radiusOf(sources[i], c);
    c.hard_body_radius_m[i] = radius;
    c.radius_basis[i] = static_cast<uint8_t>(basis);
  }
}
// Sampled states a Hermite track can use: two or more, finite, increasing.
bool validSamples(const Source &o) {
  if (o.samples.size() < 2)
    return error("invalid-source", "A sampled track needs at least two finite samples.");
  double previous = 0;
  for (auto &p : o.samples) {
    for (double x : {p.jd, p.x, p.y, p.z, p.vx, p.vy, p.vz})
      if (!isFinite(x))
        return error("invalid-source", "Sample components must be finite.");
    if (p.jd <= previous)
      return error("invalid-source", "Sample epochs must be strictly increasing.");
    previous = p.jd;
  }
  return true;
}
double epochRemainder(const std::string& iso, double nominal_jd) {
  std::string canonical; double jd=nominal_jd, remainder=0;
  conjunction::upload::timestamp(iso,false,canonical,jd,&remainder);
  return remainder + (jd-nominal_jd)*86400.;
}
bool points(const OEM *r, Source &o) {
  o.uploaded_oem = true;
  o.ephemeris_kind = "OEM";
  if (o.cdm_metadata.ephemeris_name.empty() && r) o.cdm_metadata.ephemeris_name = text(r->MESSAGE_ID());
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
    if (b->COVARIANCE_MATRIX_LINES() && b->COVARIANCE_MATRIX_LINES()->size()) {
      CovarianceSeries::Axes axes;
      int cf = f;
      const auto* declared = b->COV_REFERENCE_FRAME();
      if (declared && (declared->REFERENCE_FRAME_as_OrbitFrameWrapper() ||
          (declared->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper() &&
           declared->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper()->COORDINATE_SYSTEM() &&
           declared->REFERENCE_FRAME_as_RFMCoordinateSystemWrapper()->COORDINATE_SYSTEM()->AXIS_TYPE() == rfmAxisType::ORBITAL_RADIAL_TRANSVERSE_NORMAL))) {
        if (!covarianceAxes(declared, f, axes)) return false;
        cf = 0;
      } else if (declared) {
        cf = sourceFrame(declared, "EARTH");
        if (!cf) return false;
      }
      // Existing inertial-only sources retain their strict common-frame contract.
      if (cf && cf != f && cf != 4 && f != 4)
        return error("covariance-frame-mismatch", "Source covariance must share its state frame or use ITRF with EOP.");
      o.covariance.axes = cf == 0 ? CovarianceSeries::Axes::Rtn : CovarianceSeries::Axes::Evaluation;
      for (auto c : *b->COVARIANCE_MATRIX_LINES()) {
        o.covariance_frames.push_back(cf);
        if (!c || text(c->EPOCH()).empty())
          return error("invalid-covariance", "OEM covariance epoch required.");
        if (!covarianceRow(iso_to_jd(text(c->EPOCH())),
                           {c->CX_X(), c->CY_X(), c->CY_Y(), c->CZ_X(), c->CZ_Y(), c->CZ_Z(),
                            c->CX_DOT_X(), c->CX_DOT_Y(), c->CX_DOT_Z(), c->CX_DOT_X_DOT(),
                            c->CY_DOT_X(), c->CY_DOT_Y(), c->CY_DOT_Z(), c->CY_DOT_X_DOT(), c->CY_DOT_Y_DOT(),
                            c->CZ_DOT_X(), c->CZ_DOT_Y(), c->CZ_DOT_Z(), c->CZ_DOT_X_DOT(), c->CZ_DOT_Y_DOT(),
                            c->CZ_DOT_Z_DOT()},
                           o.covariance))
          return false;
        o.covariance_epoch_remainders.push_back(epochRemainder(text(c->EPOCH()), o.covariance.jd.back()));
      }
    }
    if (b->STEP_SIZE() > 0) {
      auto d = b->EPHEMERIS_DATA();
      auto n = b->STATE_VECTOR_SIZE();
      if (!d || (n != 6 && n != 9) || d->size() % n ||
          text(b->START_TIME()).empty())
        return error("invalid-source", "Invalid OEM compact state grid.");
      double start = iso_to_jd(text(b->START_TIME()));
      for (size_t i = 0; i < d->size(); i += n) {
        const double seconds = (i/n)*b->STEP_SIZE();
        const double jd = start + seconds/86400.;
        o.sample_epoch_remainders.push_back(epochRemainder(text(b->START_TIME()), start) + (start-jd)*86400. + seconds);
        o.samples.push_back({start + (i / n) * b->STEP_SIZE() / 86400.,
                             d->Get(i), d->Get(i + 1), d->Get(i + 2),
                             d->Get(i + 3), d->Get(i + 4), d->Get(i + 5)});
      }
    } else if (auto lines = b->EPHEMERIS_DATA_LINES())
      for (auto p : *lines) {
        if (!p || text(p->EPOCH()).empty())
          return error("invalid-source", "OEM state epoch required.");
        o.samples.push_back({iso_to_jd(text(p->EPOCH())), p->X(), p->Y(),
                             p->Z(), p->X_DOT(), p->Y_DOT(), p->Z_DOT()});
        o.sample_epoch_remainders.push_back(epochRemainder(text(p->EPOCH()), o.samples.back().jd));
      }
  }
  return validSamples(o);
}
// A Cartesian OCM: uniformly stepped states from METADATA.START_TIME, and its
// covariance aligned with them.
bool comprehensive(const OCM *r, Source &o) {
  if (!r || !r->METADATA())
    return error("invalid-source", "OCM needs metadata.");
  o.ephemeris_kind = "OCM";
  if (o.cdm_metadata.ephemeris_name.empty() && r->HEADER())
    o.cdm_metadata.ephemeris_name = text(r->HEADER()->MESSAGE_ID());
  if (const auto* od = r->ORBIT_DETERMINATION()) {
    auto& m = o.cdm_metadata;
    m.covariance_origin = CdmObjectMetadata::CovarianceOrigin::OrbitDetermination;
    m.ephemeris_name = "NONE";
    if (isFinite(od->RECOMMENDED_OD_SPAN())) m.recommended_od_span = od->RECOMMENDED_OD_SPAN();
    if (isFinite(od->ACTUAL_OD_SPAN())) m.actual_od_span = od->ACTUAL_OD_SPAN();
    m.obs_available = od->OBS_AVAILABLE();
    if (od->OD_OBSERVATIONS_USED() > 0) m.obs_used = od->OD_OBSERVATIONS_USED();
    m.tracks_available = od->TRACKS_AVAILABLE();
    if (od->OD_TRACKS_USED() > 0) m.tracks_used = od->OD_TRACKS_USED();
    m.weighted_rms = od->WEIGHTED_RMS();
    if (!text(od->OD_EPOCH()).empty()) {
      const double epoch_jd = iso_to_jd(text(od->OD_EPOCH()));
      // CCSDS TIME_LASTOB_* bounds the last accepted observation, not the
      // whole observation arc. A known exact last-observation time has zero span.
      if (isFinite(od->DAYS_SINCE_LAST_OBS()) && od->DAYS_SINCE_LAST_OBS() != 0)
        m.time_lastob_start = m.time_lastob_end = jd_to_iso(epoch_jd - od->DAYS_SINCE_LAST_OBS());
    }
  }
  if (r->TRAJ_TYPE() != trajectoryType::CARTESIAN_PV && r->TRAJ_TYPE() != trajectoryType::CARTESIAN_PVA)
    return error("unsupported-source", "OCM sources must carry Cartesian states (CARTESIAN_PV or _PVA).");
  if (text(r->METADATA()->TIME_SYSTEM()) != "UTC")
    return error("unsupported-time-system", "OCM sources must explicitly use UTC.");
  int f = sourceFrame(r->TRAJ_REF_FRAME(), text(r->CENTER_NAME()));
  if (!f)
    return false;
  o.axes = f;
  auto d = r->STATE_DATA();
  const unsigned n = r->STATE_VECTOR_SIZE();
  const double step = r->STATE_STEP_SIZE();
  if (!d || (n != 6 && n != 9) || d->size() % n || !(step > 0) || text(r->METADATA()->START_TIME()).empty())
    return error("invalid-source", "Invalid OCM state grid.");
  const double start = iso_to_jd(text(r->METADATA()->START_TIME()));
  for (size_t i = 0; i < d->size(); i += n)
    o.samples.push_back({start + (i / n) * step / 86400., d->Get(i), d->Get(i + 1), d->Get(i + 2),
                         d->Get(i + 3), d->Get(i + 4), d->Get(i + 5)});
  if (auto c = r->COVARIANCE_DATA(); c && c->size()) {
    if (c->size() != o.samples.size() * 21)
      return error("invalid-covariance", "OCM COVARIANCE_DATA must hold 21 entries per state epoch.");
    if (!covarianceAxes(r->COV_REF_FRAME(), f, o.covariance.axes))
      return false;
    for (size_t k = 0; k < o.samples.size(); ++k) {
      std::array<double, 21> lower;
      for (size_t q = 0; q < 21; ++q)
        lower[q] = c->Get(static_cast<flatbuffers::uoffset_t>(21 * k + q));
      if (!covarianceRow(o.samples[k].jd, lower, o.covariance))
        return false;
    }
    o.covariance.calibrated = r->COV_CALIBRATION() == covarianceCalibration::Calibrated;
    o.covariance.calibration_reference = text(r->COV_CALIBRATION_REFERENCE());
  }
  return validSamples(o);
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
// A source's identity for a named error: its object ID, NORAD number and handle.
std::string sourceLabel(const CQRObjectSource *r) {
  std::string label = text(r->OBJECT_ID());
  if (r->NORAD_CATALOG_ID()) label += " (NORAD " + std::to_string(r->NORAD_CATALOG_ID()) + ")";
  return label + " [handle " + std::to_string(r->SOURCE_HANDLE()) + "]";
}
// A trajectory's positions must lie between the Earth's polar radius and
// 1e6 km of its centre: anything else is a failed propagation (an object
// integrated into the Earth and flung out), which the grid and the motion
// bounds must not take. Each record is checked where its Chebyshev series is
// cheapest to sum: both ends (tau = -1, 1) and the middle (tau = 0).
constexpr double TRAJECTORY_MIN_RADIUS_KM = 6356.752;   // WGS84 polar radius
constexpr double TRAJECTORY_MAX_RADIUS_KM = 1e6;
double chebyshevAt(const std::vector<double> &c, int tau) {
  double sum = 0;
  for (size_t k = 0; k < c.size(); ++k)
    sum += c[k] * (tau == 1 ? 1.0 : tau == -1 ? (k % 2 ? -1.0 : 1.0) : (k % 2 ? 0.0 : (k % 4 ? -1.0 : 1.0)));
  return sum;
}
bool polynomial(const PPE *p, Source &o, const std::string &object = std::string()) {
  const std::string who = object.empty() ? std::string() : "Source " + object + ": ";
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
        return error("invalid-polynomial", who + "PPE coefficient length mismatch.");
      for (auto x : *v) {
        if (!isFinite(x))
          return error("invalid-polynomial",
                       who + "PPE coefficients must be finite (record " + std::to_string(records.size()) + ").");
        rec.c[k].push_back(x);
      }
    }
    for (int tau : {-1, 0, 1}) {
      const double radius = std::sqrt(std::pow(chebyshevAt(rec.c[0], tau), 2) + std::pow(chebyshevAt(rec.c[1], tau), 2) +
                                      std::pow(chebyshevAt(rec.c[2], tau), 2));
      if (!(radius >= TRAJECTORY_MIN_RADIUS_KM && radius <= TRAJECTORY_MAX_RADIUS_KM)) {
        char km[64];
        std::snprintf(km, sizeof km, "%.6g km", radius);
        return error("invalid-trajectory", who + "PPE record " + std::to_string(records.size()) + " places the object " + km +
                     " from the Earth's centre at " + jd_to_iso(rec.mid + tau * rec.half / 86400.) +
                     " UTC; a trajectory lies between 6356.752 km (the polar radius) and 1e6 km.");
      }
    }
    records.push_back(std::move(rec));
  }
  o.polynomial = std::make_shared<PolynomialEphemerisSource>(std::move(records));
  o.polynomial->generator = text(p->EPHEMERIS_SOURCE());
  return true;
}
bool source(const CQRObjectSource *r, Source &o, const PPE *trajectory = nullptr) {
  if (!r || text(r->OBJECT_ID()).empty())
    return error("invalid-source", "CQR source requires object identity.");
  unsigned n = !!r->MEAN_ELEMENTS() + !!r->TLE_LINES() + !!r->EPHEMERIS() +
               !!r->COMPREHENSIVE_ORBIT() + !!r->POLYNOMIAL_EPHEMERIS() + !!trajectory;
  if (n != 1)
    return error("invalid-source-arm",
                 "One scientific source arm is required (a trajectories frame for "
                 "the source handle counts as one); arbitrary external handles "
                 "cannot be resolved by this instance.");
  o.handle = r->SOURCE_HANDLE();
  // Preserve the source's unsigned catalog number even if a legacy provider
  // identity narrows it to signed int. Explicit source identity wins over CAT.
  o.cdm_metadata.catalog_number = r->NORAD_CATALOG_ID();
  o.cdm_metadata.covariance_origin = CdmObjectMetadata::CovarianceOrigin::SourceEphemeris;
  if (const auto* provenance = r->PROVENANCE()) {
    o.cdm_metadata.ephemeris_name = text(provenance->SOURCE_ID());
    if (provenance->ORIGIN_CLASS() == cqrDataOrigin::CDM_RECORD)
      o.cdm_metadata.covariance_origin = CdmObjectMetadata::CovarianceOrigin::ConjunctionMessage;
  }
  if (const auto* catalog = r->CATALOG_ENTRY()) {
    if (!o.cdm_metadata.catalog_number) o.cdm_metadata.catalog_number = catalog->NORAD_CAT_ID();
    o.cdm_metadata.catalog_object_name = text(catalog->OBJECT_NAME());
    o.cdm_metadata.international_designator = text(catalog->OBJECT_ID());
    o.cdm_metadata.object_type = static_cast<uint8_t>(catalog->OBJECT_TYPE());
    // CAT's legacy boolean cannot distinguish absent from NO; only YES is evidence.
    if (catalog->MANEUVERABLE()) {
      o.cdm_metadata.maneuverable_known = true;
      o.cdm_metadata.maneuverable = true;
    }
  }
  if (r->MEAN_ELEMENTS() || r->TLE_LINES()) o.ephemeris_kind = "SGP4";
  if (trajectory || r->POLYNOMIAL_EPHEMERIS()) o.ephemeris_kind = "PPE";
  if (!hardBodyRadius(r, o))
    return false;
  if (trajectory) {
    if (!polynomial(trajectory, o, sourceLabel(r)))
      return false;
    o.polynomial->name = text(r->OBJECT_NAME());
    o.polynomial->id = text(r->OBJECT_ID());
    o.polynomial->norad = r->NORAD_CATALOG_ID();
    o.provider = o.polynomial;
    completeSourceCdmMetadata(o);
    return true;
  }
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
    if (!polynomial(r->POLYNOMIAL_EPHEMERIS(), o, sourceLabel(r)))
      return false;
    o.polynomial->name = text(r->OBJECT_NAME());
    o.polynomial->id = text(r->OBJECT_ID());
    o.polynomial->norad = r->NORAD_CATALOG_ID();
    o.provider = o.polynomial;
  } else {
    if (!comprehensive(r->COMPREHENSIVE_ORBIT(), o))
      return false;
    o.provider = std::make_shared<OEMEphemerisSource>(
        o.samples, text(r->OBJECT_NAME()), text(r->OBJECT_ID()),
        r->NORAD_CATALOG_ID());
  }
  completeSourceCdmMetadata(o);
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
#include "ephemeris_invoke.inc"
bool window(Source &s, const ScreeningConfig &c, int f) {
  if (s.uploaded_oem && !normalizeOem(s, f)) return false;
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
      set_error("SDS CQR cannot represent actual Pc method " + p.method + ": " + p.usage_reason + "; " + p.failure_reason);
    else
      a = actual;
  }
  if (!p.converged)
    set_error("Pc calculation did not converge: " + p.failure_reason + "; " + p.usage_reason);
  o->ALGORITHM = a;
  o->CONVERGED = p.converged;
  o->ITERATIONS = std::max(0, p.iterations);
  o->UNCERTAINTY_SOURCE = origin;
  bool maximum = a == cqrProbabilityAlgorithm::ALFANO_MAXIMUM ||
                 a == cqrProbabilityAlgorithm::ALFRIEND_1999_MAXIMUM;
  o->PROBABILITY = maximum ? 0 : p.probability;
  // Ordinary Pc results carry a labelled spherical diagnostic internally;
  // CQR has no field for that label, so never export it as a general bound.
  o->MAXIMUM_PROBABILITY = maximum ? p.max_probability : 0;
  o->HAS_MAXIMUM_PROBABILITY = maximum;
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
// Both CQR attachments and emit_cdm use the same metadata projection. The
// shared CDM builder retains per-object provenance. Put encounter-wide usage
// diagnostics once in relative metadata, where CQR consumers read the tier.
std::unique_ptr<CDMT> conjunctionCdm(const ConjunctionEvent& e, int axes) {
  const bool usageDiagnostics = e.probability_note.find("2D_USAGE_VIOLATION") != std::string::npos ||
      e.probability_note.find("grade=Screening") != std::string::npos;
  const char* frame = axes == 1 ? "TEME" : axes == 2 ? "GCRF" : "EME2000";
  auto message = [&]() {
    if (!usageDiagnostics) return build_conjunction_cdm(e, frame);
    auto projected = e;
    projected.probability_note.clear();
    return build_conjunction_cdm(projected, frame);
  }();
  if (!message) return message;
  auto append = [&](const std::string& text) {
    if (text.empty()) return;
    if (!message->COMMENT.empty()) message->COMMENT += "; ";
    message->COMMENT += text;
  };
  append(e.probability_failure);
  if (usageDiagnostics)
    append(e.probability_note);
  return message;
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
  if (positive(e.radius1_m) && positive(e.radius2_m)) {
    o->PRIMARY_HARD_BODY_RADIUS_M = e.radius1_m;
    o->HAS_PRIMARY_HARD_BODY_RADIUS_M = true;
    o->SECONDARY_HARD_BODY_RADIUS_M = e.radius2_m;
    o->HAS_SECONDARY_HARD_BODY_RADIUS_M = true;
    o->COMBINED_RADIUS_M = e.radius1_m + e.radius2_m;
    o->HAS_COMBINED_RADIUS_M = true;
  }
  o->PRIMARY_RADIUS_BASIS = static_cast<cqrHardBodyRadiusBasis>(e.radius_basis1);
  o->SECONDARY_RADIUS_BASIS = static_cast<cqrHardBodyRadiusBasis>(e.radius_basis2);
  if (!e.has_covariance)
    o->PRIMARY_COVARIANCE_BASIS = o->SECONDARY_COVARIANCE_BASIS = cqrCovarianceBasis::NONE;
  // Uncertainty only from covariance a source supplied; none is invented.
  if (e.has_covariance) {
    o->PRIMARY_SIGMA_RTN_M = vec(e.cov_r1, e.cov_t1, e.cov_n1);
    o->SECONDARY_SIGMA_RTN_M = vec(e.cov_r2, e.cov_t2, e.cov_n2);
  }
  o->PRIMARY_DAYS_SINCE_EPOCH = e.dse1;
  o->SECONDARY_DAYS_SINCE_EPOCH = e.dse2;
  o->HAS_PRIMARY_DAYS_SINCE_EPOCH = o->HAS_SECONDARY_DAYS_SINCE_EPOCH = true;
  o->PRIMARY_STATE =
      state(e.state1, e.tca_jd, o->PRIMARY_ID, o->PRIMARY_NORAD_ID, axes);
  o->SECONDARY_STATE =
      state(e.state2, e.tca_jd, o->SECONDARY_ID, o->SECONDARY_NORAD_ID, axes);
  if (e.has_covariance1 || e.has_covariance2)
    o->CONJUNCTION_MESSAGE = conjunctionCdm(e, axes);
  return o;
}
ConjunctionEvent legacy(const ConjunctionEvent2 &e);
ConjunctionEvent legacy(const BridgeEvent &e);
bool representablePc(const PcResult& pc) {
  return !pc.method.empty() && algorithmEnum(pc.method) != cqrProbabilityAlgorithm::UNSPECIFIED;
}
void maximumOnlyLabels(CQREventT& out) {
  out.PRIMARY_COVARIANCE_BASIS = out.SECONDARY_COVARIANCE_BASIS = cqrCovarianceBasis::NONE;
  out.PRIMARY_SIGMA_RTN_M.reset();
  out.SECONDARY_SIGMA_RTN_M.reset();
}
// Without supplied covariance the engine reports only the Alfano maximum, and
// the event says so; the requested covariance method is not applied.
std::unique_ptr<CQREventT> event(const BridgeEvent &e,
                                 cqrProbabilityAlgorithm a, int axes = 1) {
  auto o = event(legacy(e), axes);
  if (!e.has_covariance)
    return o;
  // The SDS CQR algorithm enum has no value for the 2D-Nc, 3D-Nc or Monte
  // Carlo fallbacks. A violating encounter is never exported under another
  // method's name: the CQR event keeps the labelled maximum-only result and the
  // CDM (probability method string and comment) carries the fallback value.
  if (!representablePc(e.pc)) {
    maximumOnlyLabels(*o);
    return o;
  }
  o->HAS_DILUTION_THRESHOLD_M = false;
  o->PROBABILITY =
      probability(e.pc, a, cqrUncertaintyOrigin::SUPPLIED_COVARIANCE);
  o->MAHALANOBIS_3D_SQUARED = e.mahalanobis_3d * e.mahalanobis_3d;
  o->HAS_MAHALANOBIS_3D_SQUARED = true;
  return o;
}
// ── Empirical prediction-error covariance ──
// An SGP4 object's covariance at TCA from an empirical prediction-error model
// (analysis/gp-error-model, scaled and gated by its calibration), chosen by
// the object's orbit regime and its prediction age (TCA minus the element
// set's epoch), with the gate's label. Optional frame "uncertainty_model": one
// $ERM whose MODEL arm gives the label (LABEL), the regimes (STRATA_SETTINGS
// REGIMES: mean altitude and eccentricity bounds), the age bins (AGE_BINS,
// days), and per stratum the RTN position-velocity covariance lower triangle
// (CLIPPED.COVARIANCE when the stratum's clipped statistics have one, else
// COVARIANCE; 21 values in km^2, km^2/s, km^2/s^2; strata without 21 values
// are not used), CALIBRATION (Calibrated: the gate passed) and
// CALIBRATION_REFERENCE. scripts/uncertainty-model.mjs writes it from the model
// and calibration JSON.
struct EmpiricalStratum {
  std::array<double, 21> cov{};
  bool calibrated = false;
  std::string reference;
};
struct EmpiricalModel {
  bool loaded = false;
  std::string label;
  std::vector<std::array<double, 4>> regimes;
  std::vector<std::pair<double, double>> ages;
  std::map<std::pair<uint32_t, uint32_t>, EmpiricalStratum> strata;
};
bool empiricalModel(EmpiricalModel &m) {
  const plugin_input_frame_t *f = input("uncertainty_model");
  if (!f)
    return true;
  auto bad = [] { return error("invalid-uncertainty-model", "uncertainty_model is not a well-formed $ERM MODEL."); };
  const ERM *erm = decode<ERM>(f, "$ERM");
  if (!erm)
    return false;
  const ERMModel *model = erm->MODEL();
  const ERMStrataSettings *settings = model ? model->STRATA_SETTINGS() : nullptr;
  if (!model || !settings)
    return bad();
  m.label = text(model->LABEL());
  const auto *regimes = settings->REGIMES();
  const auto *ages = settings->AGE_BINS();
  if ((regimes ? regimes->size() : 0) > 1024 || (ages ? ages->size() : 0) > 1024)
    return bad();
  m.regimes.clear();
  if (regimes)
    for (const ERMRegime *r : *regimes) {
      // Unbounded regimes (an infinite top) are capped at 1e300, as the model's
      // bounds always were.
      std::array<double, 4> x = {std::min(r->ALTITUDE_MIN_KM(), 1e300), std::min(r->ALTITUDE_MAX_KM(), 1e300),
                                 std::min(r->ECCENTRICITY_MIN(), 1e300), std::min(r->ECCENTRICITY_MAX(), 1e300)};
      for (double v : x)
        if (!isFinite(v)) return bad();
      m.regimes.push_back(x);
    }
  m.ages.clear();
  if (ages)
    for (const ERMAgeBin *a : *ages) {
      if (!(a->MIN_DAYS() >= 0 && a->MAX_DAYS() > a->MIN_DAYS())) return bad();
      m.ages.emplace_back(a->MIN_DAYS(), a->MAX_DAYS());
    }
  if (const auto *strata = model->STRATA())
    for (const ERMModelStratum *t : *strata) {
      const auto *clipped = t->CLIPPED();
      const auto *cov = clipped && clipped->COVARIANCE() && clipped->COVARIANCE()->size() ? clipped->COVARIANCE() : t->COVARIANCE();
      if (!cov || cov->size() != 21)
        continue;
      const uint32_t r = t->REGIME_INDEX(), a = t->AGE_INDEX();
      if (r >= m.regimes.size() || a >= m.ages.size())
        return bad();
      EmpiricalStratum s;
      for (size_t k = 0; k < 21; ++k)
        if (!isFinite(s.cov[k] = cov->Get(static_cast<flatbuffers::uoffset_t>(k)))) return bad();
      s.calibrated = t->CALIBRATION() == covarianceCalibration::Calibrated;
      if (s.calibrated)
        s.reference = text(t->CALIBRATION_REFERENCE());
      if (s.cov[0] > 0 && s.cov[2] > 0 && s.cov[5] > 0)  // a usable position block
        m.strata[{r, a}] = std::move(s);
    }
  m.loaded = true;
  return true;
}
// Mean altitude (km) from SGP4's un-Kozai'd mean motion (WGS-72), as the
// model's regimes are defined.
double meanAltitudeKm(const GPElement &g) {
  constexpr double re = 6378.135, mu = 398600.8, j2 = 0.001082616;
  const double xke = 60.0 / std::sqrt(re * re * re / mu);
  const double n = g.mean_motion * 2.0 * M_PI / 1440.0;  // rad/min, Kozai
  const double cosio = std::cos(g.inclination * M_PI / 180.0);
  const double omeosq = 1.0 - g.eccentricity * g.eccentricity;
  const double ak = std::pow(xke / n, 2.0 / 3.0);
  const double d1 = 0.75 * j2 * (3.0 * cosio * cosio - 1.0) / (std::sqrt(omeosq) * omeosq);
  double del = d1 / (ak * ak);
  const double adel = ak * (1.0 - del * del - del * (1.0 / 3.0 + 134.0 * del * del / 81.0));
  del = d1 / (adel * adel);
  return std::pow(xke / (n / (1.0 + del)), 2.0 / 3.0) * re - re;
}
const EmpiricalStratum *empiricalStratum(const EmpiricalModel &m, const GPElement &g, double age_days) {
  if (!(g.mean_motion > 0) || !(age_days >= 0))
    return nullptr;
  const double alt = meanAltitudeKm(g), ecc = g.eccentricity;
  uint32_t regime = 0;
  while (regime < m.regimes.size() &&
         !(ecc >= m.regimes[regime][2] && ecc < m.regimes[regime][3] && alt >= m.regimes[regime][0] &&
           alt < m.regimes[regime][1]))
    ++regime;
  for (uint32_t a = 0; regime < m.regimes.size() && a < m.ages.size(); ++a)
    if (age_days >= m.ages[a].first &&
        (age_days < m.ages[a].second || (a + 1 == m.ages.size() && age_days == m.ages[a].second))) {
      auto s = m.strata.find({regime, a});
      return s == m.strata.end() ? nullptr : &s->second;
    }
  return nullptr;
}
struct EmpiricalUse {
  bool used = false, calibrated = false;
  std::string reference;
  ConjunctionEvent2 computed;
  std::array<double, 21> cov1{}, cov2{};
  CdmObjectMetadata metadata1, metadata2;
};
// A covariance method's probability from the empirical model, when a
// covariance method was requested, both objects are element sets and both
// strata exist; nothing otherwise (the event keeps what it had).
EmpiricalUse empiricalCovariance(const EmpiricalModel &m, const GPElement *g1, const GPElement *g2,
                                 double age1, double age2, cqrProbabilityAlgorithm alg) {
  EmpiricalUse u;
  if (!m.loaded || alg == cqrProbabilityAlgorithm::ALFANO_MAXIMUM || !g1 || !g2)
    return u;
  const EmpiricalStratum *a = empiricalStratum(m, *g1, age1), *b = empiricalStratum(m, *g2, age2);
  if (!a || !b)
    return u;
  u.used = true;
  u.cov1 = a->cov;
  u.cov2 = b->cov;
  u.metadata1.covariance_origin = u.metadata2.covariance_origin = CdmObjectMetadata::CovarianceOrigin::EmpiricalModel;
  u.metadata1.calibrated = a->calibrated;
  u.metadata2.calibrated = b->calibrated;
  u.metadata1.calibration_reference = a->reference;
  u.metadata2.calibration_reference = b->reference;
  u.calibrated = a->calibrated && b->calibrated;
  if (u.calibrated)
    u.reference = a == b || a->reference == b->reference ? a->reference : a->reference + "; " + b->reference;
  return u;
}
EmpiricalUse empiricalPc(const EmpiricalModel& m, const GPElement* g1, const GPElement* g2,
                         double age1, double age2, const conjunction::StateVector& s1,
                         const conjunction::StateVector& s2, double radius1_m,
                         double radius2_m, cqrProbabilityAlgorithm alg) {
  auto use = empiricalCovariance(m, g1, g2, age1, age2, alg);
  if (use.used) {
    ConjunctionEngine engine; // Pair assessment: Reference grade and engine floors.
    engine.set_pc_method(algorithm(alg));
    use.computed = engine.compute_pc(make_pc_encounter(s1, s2, use.cov1, use.cov2,
                                  (radius1_m + radius2_m) / 1000.));
  }
  return use;
}
// Apply the exact same model covariance and provenance before either CDM
// delivery path. The encounter geometry remains in its evaluation frame.
void applyEmpiricalCovariance(ConjunctionEvent& e, const EmpiricalUse& u) {
  if (!u.used) return;
  const auto computed = legacy(u.computed);
  e.has_covariance1 = e.has_covariance2 = true;
  e.has_covariance = usablePc(u.computed);
  e.cov6_rtn1 = u.cov1; e.cov6_rtn2 = u.cov2;
  e.covariance_probability = u.computed.pc.probability;
  e.probability_method = u.computed.pc.method;
  e.probability_failure = e.has_covariance ? u.computed.probability_failure :
      "Collision probability calculation failed: " + u.computed.pc.failure_reason;
  e.probability_note = computed.probability_note;
  auto metadata = [](CdmObjectMetadata& target, const CdmObjectMetadata& model) {
    target.covariance_origin = model.covariance_origin;
    target.calibrated = model.calibrated;
    target.calibration_reference = model.calibration_reference;
    if (target.ephemeris_name.empty()) target.ephemeris_name = "SGP4";
  };
  metadata(e.cdm_metadata1, u.metadata1); metadata(e.cdm_metadata2, u.metadata2);
  e.cov_r1 = std::sqrt(u.cov1[0]) * 1000.; e.cov_t1 = std::sqrt(u.cov1[2]) * 1000.; e.cov_n1 = std::sqrt(u.cov1[5]) * 1000.;
  e.cov_r2 = std::sqrt(u.cov2[0]) * 1000.; e.cov_t2 = std::sqrt(u.cov2[2]) * 1000.; e.cov_n2 = std::sqrt(u.cov2[5]) * 1000.;
}
// Labels an event whose probability came from the empirical model.
void empiricalLabels(CQREventT &o, const EmpiricalUse &u, cqrProbabilityAlgorithm alg,
                     const ConjunctionEvent& base, int axes = 1) {
  if (!u.used)
    return;
  auto complete = base;
  applyEmpiricalCovariance(complete, u);
  o.CONJUNCTION_MESSAGE = conjunctionCdm(complete, axes);
  if (!usablePc(u.computed) || !representablePc(u.computed.pc)) {
    // Keep the original, labelled Alfano maximum in CQR. Only the CDM can
    // carry the actual fallback method and value without mislabelling them.
    maximumOnlyLabels(o);
    return;
  }
  o.PROBABILITY = probability(u.computed.pc, alg, cqrUncertaintyOrigin::SYNTHESIZED_COVARIANCE);
  o.HAS_DILUTION_THRESHOLD_M = false;
  o.MAHALANOBIS_3D_SQUARED = u.computed.mahalanobis_3d * u.computed.mahalanobis_3d;
  o.HAS_MAHALANOBIS_3D_SQUARED = true;
  auto sigma = [](const std::array<double, 21> &c) {
    return vec(std::sqrt(c[0]) * 1000., std::sqrt(c[2]) * 1000., std::sqrt(c[5]) * 1000.);
  };
  o.PRIMARY_SIGMA_RTN_M = sigma(u.cov1);
  o.SECONDARY_SIGMA_RTN_M = sigma(u.cov2);
  o.PRIMARY_COVARIANCE_BASIS = o.SECONDARY_COVARIANCE_BASIS = cqrCovarianceBasis::EMPIRICAL_MODEL;
  o.PROBABILITY->CALIBRATION = u.calibrated ? covarianceCalibration::Calibrated : covarianceCalibration::Uncalibrated;
  o.PROBABILITY->CALIBRATION_REFERENCE = u.calibrated ? u.reference : std::string();
  o.PROBABILITY->CROSS_CORRELATION = cqrCovarianceCorrelation::INDEPENDENT;
}
// Retain the whole source when materializing a screened encounter: covariance,
// provenance and source frame are as important as its element set.
using ScreenSourceLookup = std::map<std::tuple<std::string, int, double>, const Source*>;
using ScreenSourcePair = std::pair<const Source*, const Source*>;
void addScreenSources(ScreenSourceLookup& out, const std::vector<Source>& sources) {
  for (const auto& source : sources) {
    const auto key = std::make_tuple(source.provider->object_id(), source.provider->norad_id(),
                                     source.provider->epoch_jd());
    auto [it, fresh] = out.emplace(key, &source);
    // Catalog ranges may reference the same source twice. Distinct source
    // descriptions with an identical identity and epoch remain ambiguous:
    // their covariance or provenance must never be borrowed from the first.
    if (!fresh && (!it->second || it->second->provider != source.provider))
      it->second = nullptr;
  }
}
// Adapt an already solved encounter without propagating or changing its frame.
BridgeEvent screenedEncounter(const ConjunctionEvent& e) {
  BridgeEvent out;
  out.obj1_name = e.obj1.name; out.obj2_name = e.obj2.name;
  out.obj1_id = e.obj1.object_id; out.obj2_id = e.obj2.object_id;
  out.obj1_norad = e.obj1.norad_cat_id; out.obj2_norad = e.obj2.norad_cat_id;
  out.tca_jd = e.tca_jd; out.tca_iso = e.tca_iso;
  out.state1 = e.state1; out.state2 = e.state2;
  out.miss_distance_km = e.min_range_km; out.relative_speed_kms = e.rel_speed_kms;
  out.rel_r = e.rel_pos_r; out.rel_t = e.rel_pos_t; out.rel_n = e.rel_pos_n;
  out.rel_vr = e.rel_vel_r; out.rel_vt = e.rel_vel_t; out.rel_vn = e.rel_vel_n;
  out.dse1 = e.dse1; out.dse2 = e.dse2;
  out.radius1_m = e.radius1_m; out.radius2_m = e.radius2_m;
  out.combined_radius_km = (e.radius1_m + e.radius2_m) / 1000.;
  out.dilution_threshold_km = e.dilution_threshold_km;
  out.pc.max_probability = e.max_probability;
  out.pc.probability = e.has_covariance ? e.covariance_probability : e.max_probability;
  out.pc.method = e.probability_method;
  out.pc.converged = true;
  out.has_covariance = e.has_covariance;
  out.has_covariance1 = e.has_covariance1; out.has_covariance2 = e.has_covariance2;
  out.cov6_rtn1 = e.cov6_rtn1; out.cov6_rtn2 = e.cov6_rtn2;
  out.cdm_metadata1 = e.cdm_metadata1; out.cdm_metadata2 = e.cdm_metadata2;
  out.probability_failure = e.probability_failure;
  return out;
}
// Prepare covariance once, evaluate all encounters on the engine's ordered
// batch API, then construct messages sequentially. Message construction owns
// the CDM metadata and the CQR enum limitation; the engine owns all Pc maths.
std::vector<std::unique_ptr<CQREventT>> screenedEvents(
    const std::vector<ConjunctionEvent>& events, const EmpiricalModel& model,
    const ScreenSourceLookup& sources, cqrProbabilityAlgorithm alg,
    unsigned workers, int axes = 1,
    const std::vector<ScreenSourcePair>* exact_sources = nullptr) {
  struct Prepared {
    BridgeEvent assessed;
    SuppliedCovariance supplied;
    EmpiricalUse empirical;
    size_t pc_index = std::numeric_limits<size_t>::max();
  };
  std::vector<Prepared> prepared(events.size());
  std::vector<PcEncounter> encounters;
  encounters.reserve(events.size());
  auto find = [&](const ObjectIdentity& id) {
    const auto it = sources.find({id.object_id, id.norad_cat_id, id.epoch_jd});
    return it == sources.end() ? nullptr : it->second;
  };
  for (size_t i = 0; i < events.size(); ++i) {
    const auto& event = events[i];
    auto& p = prepared[i];
    p.assessed = screenedEncounter(event);
    const auto source_pair = exact_sources ? (*exact_sources)[i] : ScreenSourcePair{find(event.obj1), find(event.obj2)};
    const Source* a = source_pair.first, *b = source_pair.second;
    if (!a || !b) {
      if (alg != cqrProbabilityAlgorithm::ALFANO_MAXIMUM)
        p.assessed.probability_failure = "Collision probability calculation failed: no unique source description for the object identity and element epoch.";
      continue;
    }
    p.supplied = prepareSourceCovariance(p.assessed, *a, *b, alg);
    if (p.supplied.ready) {
      p.pc_index = encounters.size();
      encounters.push_back(make_pc_encounter(event.state1, event.state2,
          p.assessed.cov6_rtn1, p.assessed.cov6_rtn2, p.assessed.combined_radius_km));
    } else if (!has_error()) {
      p.empirical = empiricalCovariance(model, a->mean ? &a->gp : nullptr, b->mean ? &b->gp : nullptr,
                                        event.dse1, event.dse2, alg);
      if (p.empirical.used) {
        p.pc_index = encounters.size();
        encounters.push_back(make_pc_encounter(event.state1, event.state2,
            p.empirical.cov1, p.empirical.cov2, p.assessed.combined_radius_km));
      }
    }
  }
  ConjunctionEngine engine;
  engine.set_pc_method(algorithm(alg));
  engine.set_pc_grade(PcGrade::Screening);
  engine.set_pc_tier_options({kCatalogPcReportingFloor, kCatalogPcMonteCarloFloor});
  auto computed = engine.compute_pc_batch(encounters, workers);
  std::vector<std::unique_ptr<CQREventT>> output;
  output.reserve(events.size());
  for (size_t i = 0; i < events.size(); ++i) {
    auto& p = prepared[i];
    if (p.supplied.ready)
      applyComputedCovariance(p.assessed, p.supplied, computed[p.pc_index]);
    else if (p.empirical.used)
      p.empirical.computed = std::move(computed[p.pc_index]);
    auto out = event(p.assessed, alg, axes);
    if (!out->CONJUNCTION_MESSAGE && !p.assessed.probability_failure.empty())
      out->CONJUNCTION_MESSAGE = conjunctionCdm(legacy(p.assessed), axes);
    out->PRIMARY_RADIUS_BASIS = static_cast<cqrHardBodyRadiusBasis>(events[i].radius_basis1);
    out->SECONDARY_RADIUS_BASIS = static_cast<cqrHardBodyRadiusBasis>(events[i].radius_basis2);
    covarianceLabels(*out, p.supplied);
    if (p.empirical.used)
      empiricalLabels(*out, p.empirical, alg, legacy(p.assessed), axes);
    output.push_back(std::move(out));
  }
  return output;
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
  size_t events_per_chunk = kEventsPerChunk;
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
  size_t count = p.events.size(), start = p.offset, chunk = p.events_per_chunk;
  CQRT q;
  q.CATALOG_RESULT = std::make_unique<CQRCatalogResultT>();
  auto &r = *q.CATALOG_RESULT;
  r.OBJECTS_PARSED = p.stats.total_objects;
  r.CONJUNCTIONS_FOUND = count;
  r.STATISTICS = statistics(p.stats);
  r.EVENT_OFFSET = start;
  r.FINAL_CHUNK = start + chunk >= count;
  for (size_t i = start; i < std::min(start + chunk, count); ++i)
    r.EVENTS.push_back(std::make_unique<CQREventT>(*p.events[i]));
  bool final = r.FINAL_CHUNK;
  bool failed = p.stats.failed_pairs > 0;
  if (!push(q, "result", start / chunk, final))
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
        (count - p.offset + chunk - 1) / chunk));
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
bool outputStagingLimit() {
  return error("output-staging-limit",
               "Bounded output staging capacity exceeded; drain existing "
               "streams or request a smaller screening window.");
}
bool checkEventStagingCapacity(size_t eventCount) {
  size_t retainedEvents = eventCount;
  for (const auto &entry : pending)
    retainedEvents += entry.second.events.size() - entry.second.offset;
  if (retainedEvents > kMaximumPendingEvents)
    return outputStagingLimit();
  return true;
}
bool catalogOutput(std::vector<std::unique_ptr<CQREventT>> events,
                   const ScreeningStats &s, const std::string &method,
                   std::vector<std::vector<uint8_t>> excluded = {},
                   size_t eventsPerChunk = kEventsPerChunk) {
  // Do not retain an event whose required CDM attachment failed to build.
  if (has_error()) return error("evaluation-failed", error_message());
  size_t retainedRequestBytes = 0;
  for (const auto &entry : pending)
    retainedRequestBytes += entry.second.request_bytes.size();
  std::string identity = requestKey();
  if (excluded.size() > kMaximumExcludedFrames)
    return error("output-staging-limit",
                 "More excluded objects than the excluded port can carry; "
                 "screen a smaller catalog range.");
  if (!checkEventStagingCapacity(events.size()))
    return false;
  if (pending.size() >= kMaximumPendingStreams ||
      retainedRequestBytes + identity.size() > kMaximumRetainedRequestBytes)
    return outputStagingLimit();
  std::stable_sort(events.begin(), events.end(), [](auto &a, auto &b) {
    return std::tie(a->TCA->JULIAN_DATE, a->PRIMARY_ID, a->SECONDARY_ID) <
           std::tie(b->TCA->JULIAN_DATE, b->PRIMARY_ID, b->SECONDARY_ID);
  });
  PendingCatalog p;
  p.events = std::move(events);
  p.stats = s;
  p.request_bytes = std::move(identity);
  p.excluded = std::move(excluded);
  p.events_per_chunk = eventsPerChunk;
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
  const bool foster_repair = p->ALGORITHM() == cqrProbabilityAlgorithm::FOSTER;
  const bool finite_covariance = isFinite(g->VARIANCE_XI_M2()) &&
      isFinite(g->VARIANCE_ZETA_M2()) && isFinite(g->COVARIANCE_XI_ZETA_M2());
  const bool positive_covariance = positive(g->VARIANCE_XI_M2()) &&
      positive(g->VARIANCE_ZETA_M2()) &&
      std::abs(g->COVARIANCE_XI_ZETA_M2() / std::sqrt(g->VARIANCE_XI_M2()) /
               std::sqrt(g->VARIANCE_ZETA_M2())) < 1.0;
  if (!positive(g->COMBINED_RADIUS_M()) || !finite_covariance ||
      (!foster_repair && !positive_covariance))
    return error("invalid-covariance",
                 "Finite covariance and positive radius required; this method "
                 "requires positive-definite covariance unless Foster repair is selected."),
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
  if (!conjunction::cdm_has_covariance(f->payload, f->payload_length))
    return error("covariance-unavailable", error_message()), 422;
  auto p = conjunction::compute_pc_from_cdm(f->payload, f->payload_length);
  if (has_error())
    return error("invalid-cdm", error_message()), 422;
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
    BridgeEvent assessed;
    static_cast<ConjunctionEvent2&>(assessed) = e.assess(
        *a.provider, *b.provider, c.start_jd, c.duration_days,
        nullptr, nullptr, c.coarse_step_sec, c.fine_tol_sec);
    const auto supplied = applySourceCovariance(assessed, a, b, e, alg);
    out.EVENT_RESULT = event(assessed, alg, a.axes);
    covarianceLabels(*out.EVENT_RESULT, supplied);
    EmpiricalModel model;
    if (!empiricalModel(model))
      return 400;
    if (!supplied.used && !has_error())
      empiricalLabels(*out.EVENT_RESULT,
                      empiricalPc(model, a.mean ? &a.gp : nullptr, b.mean ? &b.gp : nullptr, assessed.dse1,
                                  assessed.dse2, assessed.state1, assessed.state2,
                                  q->PAIR_REQUEST()->PRIMARY_RADIUS_M(), q->PAIR_REQUEST()->SECONDARY_RADIUS_M(), alg),
                      alg, legacy(assessed), a.axes);
  }
  if (!isFinite(out.EVENT_RESULT->MISS_DISTANCE_M) ||
      !isFinite(out.EVENT_RESULT->TCA->JULIAN_DATE))
    return error("pair-evaluation-failed",
                 "Pair assessment produced nonfinite geometry."),
           422;
  // A pair request gives each object's radius itself.
  out.EVENT_RESULT->PRIMARY_RADIUS_BASIS = out.EVENT_RESULT->SECONDARY_RADIUS_BASIS =
      cqrHardBodyRadiusBasis::SUPPLIED;
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
  if (n < 0 || has_error()) {
    const std::string detail = has_error() ? error_message() : "CDM conversion failed or exceeds bounded document size.";
    const auto separator = detail.find(": ");
    const std::string code = write && detail.rfind("cdm-", 0) == 0 && separator != std::string::npos
        ? detail.substr(0, separator) : "invalid-native-document";
    return error(code.c_str(), detail);
  }
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
  l.dilution_threshold_km = e.dilution_threshold_km;
  l.probability_method = e.pc.method;
  l.has_covariance = e.has_covariance;
  l.has_covariance1 = e.has_covariance1;
  l.has_covariance2 = e.has_covariance2;
  l.probability_failure = e.probability_failure;
  l.probability_note = e.pc.usage_reason;
  if (e.pc.usage_violation)
    l.probability_note = e.pc.tier + "; 2D_USAGE_VIOLATION; method=" + e.pc.method + "; " + l.probability_note;
  if (e.pc.cross_correlation_applied) {
    char delta[96];
    std::snprintf(delta, sizeof(delta), "; CROSS_CORRELATION_APPLIED; Pc_change=%.17g", e.pc.decorrelation_probability_change);
    l.probability_note += delta;
  }
  if (e.pc.sample_count) {
    char diagnostics[256];
    std::snprintf(diagnostics, sizeof(diagnostics),
        "; MC samples=%llu hits=%llu initial=%llu entries=%llu; 95%% Wilson interval lower %.17g upper %.17g",
        static_cast<unsigned long long>(e.pc.sample_count),
        static_cast<unsigned long long>(e.pc.collision_count),
        static_cast<unsigned long long>(e.pc.initial_overlap_count),
        static_cast<unsigned long long>(e.pc.entry_collision_count),
        e.pc.lower_probability, e.pc.upper_probability);
    l.probability_note += diagnostics;
  }
  if (e.pc.covariance_remediated) l.probability_note += "; COVARIANCE_REMEDIATED";
  l.cov6_rtn1 = e.cov6_rtn1;
  l.cov6_rtn2 = e.cov6_rtn2;
  l.radius1_m = e.radius1_m;
  l.radius2_m = e.radius2_m;
  l.covariance_probability = e.pc.probability;
  l.rel_pos_r = e.rel_r;
  l.rel_pos_t = e.rel_t;
  l.rel_pos_n = e.rel_n;
  l.rel_vel_r = e.rel_vr;
  l.rel_vel_t = e.rel_vt;
  l.rel_vel_n = e.rel_vn;
  l.dse1 = e.dse1;
  l.dse2 = e.dse2;
  if (!e.has_covariance)
    return l;
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
ConjunctionEvent legacy(const BridgeEvent &e) {
  auto l = legacy(static_cast<const ConjunctionEvent2&>(e));
  l.cdm_metadata1 = e.cdm_metadata1;
  l.cdm_metadata2 = e.cdm_metadata2;
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
    BridgeEvent assessed;
    static_cast<ConjunctionEvent2&>(assessed) = engine.assess(
        *a.provider, *b.provider, c.start_jd, c.duration_days,
        nullptr, nullptr, c.coarse_step_sec, c.fine_tol_sec);
    applySourceCovariance(assessed, a, b, engine, alg);
    e = legacy(assessed);
  }
  if (has_error())
    return error("pair-evaluation-failed", error_message());
  if (e.cdm_metadata1.ephemeris_name.empty()) e.cdm_metadata1 = a.cdm_metadata;
  if (e.cdm_metadata2.ephemeris_name.empty()) e.cdm_metadata2 = b.cdm_metadata;
  if (!csm) {
    EmpiricalModel model;
    if (!empiricalModel(model)) return false;
    if (!e.has_covariance)
      applyEmpiricalCovariance(e, empiricalPc(model, a.mean ? &a.gp : nullptr, b.mean ? &b.gp : nullptr,
          e.dse1, e.dse2, e.state1, e.state2, p->PRIMARY_RADIUS_M(), p->SECONDARY_RADIUS_M(), alg));
    auto message = conjunctionCdm(e, a.axes);
    if (!message)
      return error("serialization-failed", "Unable to construct conjunction message.");
    flatbuffers::FlatBufferBuilder builder(8192);
    builder.Finish(CDM::Pack(builder, message.get()), "$CDM");
    if (builder.GetSize() > kMaximumDocumentBytes)
      return error("serialization-failed", "Conjunction message exceeds the document size limit.");
    return pushBytes("cdm", "CDM.fbs", "$CDM", "CDM", builder.GetBufferPointer(), builder.GetSize());
  }
  std::vector<uint8_t> data(8192);
  int n = -2;
  while (n == -2 && data.size() <= kMaximumDocumentBytes) {
    n = conjunction_to_csm(e, data.data(), data.size());
    if (n == -2)
      data.resize(data.size() * 2);
  }
  if (n < 0)
    return error("serialization-failed",
                 "Unable to serialize conjunction message.");
  return pushBytes("csm", "CSM.fbs", "$CSM", "CSM", data.data(), n);
}
// Providers execute physics in C++; each worker writes private results. Merge
// order and statistics are independent of worker scheduling.
bool screenSources(const std::vector<Source> &p, const std::vector<Source> &s,
                   const ScreeningConfig &c, cqrProbabilityAlgorithm alg,
                   ScreeningStats &stats,
                   std::vector<std::unique_ptr<CQREventT>> &events,
                   std::vector<std::vector<uint8_t>> &excluded,
                   const std::vector<uint32_t> *primary_handles = nullptr,
                   const EmpiricalModel &model = EmpiricalModel()) {
  stats.total_objects = p.size() + s.size();
  if (p.empty())
    return error("invalid-catalog", "At least one primary source is required.");
  if (!reserveScreeningHeap(p.size() + s.size(), c.num_threads))
    return false;
  bool means =
      std::all_of(p.begin(), p.end(), [](auto &x) { return x.mean; }) &&
      std::all_of(s.begin(), s.end(), [](auto &x) { return x.mean; });
  // Element sets screen on the fast path; with an empirical model a covariance
  // method's probability is added to each event afterwards.
  if (means && !primary_handles && (alg == cqrProbabilityAlgorithm::ALFANO_MAXIMUM || model.loaded)) {
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
    ScreenSourceLookup sources;
    addScreenSources(sources, p);
    addScreenSources(sources, s);
    events = screenedEvents(results, model, sources, alg, c.num_threads);
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
    std::vector<ConjunctionEvent> events;
    std::vector<ScreenSourcePair> sources;
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
        const auto radius1 = radiusOf(p[i], c), radius2 = radiusOf(b, c);
        e.set_combined_radius_m(radius1.first, radius2.first);
        // Every local minimum of the pair's range within the threshold is a
        // conjunction, and it belongs to the window holding its TCA, [start,
        // end): windows that share an edge refine a minimum there to the same
        // TCA, so exactly one of them reports it. A window edge is never
        // itself a minimum.
        const double end_jd = c.start_jd + c.duration_days;
        auto solutions = assess_conjunction_solutions_within_threshold(
            *p[i].provider, *b.provider, c.start_jd, c.duration_days,
            c.threshold_km, c.fine_tol_sec);
        if (has_error()) {
          ++w.failed;
          clear_error();
          continue;
        }
        for (const auto &solution : solutions) {
          if (!(solution.tca_jd >= c.start_jd && solution.tca_jd < end_jd))
            continue;
          BridgeEvent result;
          static_cast<ConjunctionEvent2&>(result) = e.assess_at(
              *p[i].provider, *b.provider, solution.tca_jd);
          if (has_error() || !isFinite(result.miss_distance_km) ||
              !isFinite(result.tca_jd)) {
            ++w.failed;
            clear_error();
            break;
          }
          auto output = legacy(result);
          output.radius_basis1 = static_cast<int>(radius1.second);
          output.radius_basis2 = static_cast<int>(radius2.second);
          w.events.push_back(std::move(output));
          w.sources.emplace_back(&p[i], &b);
        }
      }
    }
  };
  for (unsigned t = 1; t < workers; ++t)
    threads.emplace_back(run, t);
  run(0);
  for (auto &t : threads)
    t.join();
  std::vector<ConjunctionEvent> results;
  std::vector<ScreenSourcePair> exact_sources;
  for (auto &w : work) {
    stats.pairs_screened += w.pairs;
    stats.failed_pairs += w.failed;
    for (auto &event : w.events) results.push_back(std::move(event));
    exact_sources.insert(exact_sources.end(), w.sources.begin(), w.sources.end());
  }
  ScreenSourceLookup sources;
  addScreenSources(sources, p);
  addScreenSources(sources, s);
  events = screenedEvents(results, model, sources, alg, c.num_threads, p.front().axes, &exact_sources);
  stats.tca_refined = stats.pairs_screened - stats.failed_pairs;
  stats.conjunctions_found = events.size();
  return true;
}
} // namespace ca_cqr
extern "C" int parse_ephemeris() { return ca_cqr::uploadEphemeris() ? 0 : 400; }
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
    v.cdm_metadata.covariance_origin = CdmObjectMetadata::CovarianceOrigin::SourceEphemeris;
    v.ephemeris_kind = "SGP4";
    v.axes = 1;
    v.provider = std::make_shared<GPEphemerisSource>(v.gp);
    completeSourceCdmMetadata(v);
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
  EmpiricalModel model;
  if (!empiricalModel(model))
    return 400;
  if (!screenSources(p, s, c, r->CONTROLS()->ALGORITHM(), stats, events,
                     excluded, nullptr, model))
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
  // Trajectories a propagator module exported (its $PRW DESCRIBE_RESULT
  // records, forwarded as they are), matched to SOURCES by handle.
  std::map<uint32_t, const PPE *> trajectories;
  for (uint32_t i = 0; auto f = input("trajectories", i); ++i) {
    auto prw = decodeEither<PRW>(f, "$PRW");
    if (!prw || !prw->DESCRIBE_RESULT() || !prw->DESCRIBE_RESULT()->SOURCES())
      return error("invalid-trajectories", "trajectories frames must be verified $PRW DESCRIBE_RESULT records.");
    for (auto t : *prw->DESCRIBE_RESULT()->SOURCES())
      if (!t || !t->EPHEMERIS() || !trajectories.emplace(t->SOURCE_HANDLE(), t->EPHEMERIS()).second)
        return error("invalid-trajectories", "Each trajectory needs a PPE and a unique source handle.");
  }
  size_t used = 0;
  for (auto s : *r->SOURCES()) {
    if (!s)
      return error("invalid-source", "Null resident source.");
    if (!selected.empty() && std::find(selected.begin(), selected.end(),
                                       s->SOURCE_HANDLE()) == selected.end())
      continue;
    auto t = trajectories.find(s->SOURCE_HANDLE());
    Source v;
    if (!source(s, v, t == trajectories.end() ? nullptr : t->second))
      return false;
    if (v.uploaded_oem && v.axes == 4 && !normalizeOem(v, 2)) return false;
    used += t != trajectories.end();
    if (!v.handle)
      return error("invalid-source-handle",
                   "Resident source handles must be nonzero.");
    for (auto &prev : result.sources)
      if (prev.handle == v.handle)
        return error("invalid-source-handle",
                     "Resident source handles must be unique.");
    // One propagator per run: every source mean elements (SGP4), or every one
    // a trajectory from the same generator.
    const auto generator = [](const Source &x) {
      return x.mean ? std::string("sgp4") : "trajectory:" + (x.polynomial ? x.polynomial->generator : std::string());
    };
    if (!result.sources.empty() && generator(v) != generator(result.sources.front()))
      return error("mixed-propagators", "An index holds one propagator's output: mean elements (SGP4) or trajectories from one generator, never both.");
    if (result.axes && result.axes != v.axes)
      return error("frame-mismatch",
                   "Resident sources must share an explicit frame.");
    result.axes = v.axes;
    descriptions.push_back({v.handle, v.gp});
    result.sources.push_back(std::move(v));
  }
  if (result.sources.empty())
    return error("invalid-source-selection", "Source selection is empty.");
  if (used != trajectories.size())
    return error("invalid-trajectories", "A trajectory names a source handle the request does not list.");

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
  radii(i->sources, c);
  int f = frame(r->EVALUATION_FRAME());
  if (!f || f != i->axes)
    return error("frame-mismatch",
                 "Window evaluation frame differs from the resident index.");
  for (auto &s : i->sources)
    if (!window(s, c, f))
      return false;
  EmpiricalModel model;
  if (!empiricalModel(model))
    return false;
  const auto alg = r->CONTROLS()->ALGORITHM();
  if (i->native_handle) {
    if (alg != cqrProbabilityAlgorithm::ALFANO_MAXIMUM && !model.loaded)
      return error(
          "unsupported-algorithm",
          "Optimized resident GP index uses ALFANO_MAXIMUM, or a covariance method with an uncertainty_model.");
    auto native = find_resident_screening_index(i->native_handle);
    if (!native)
      return error("invalid-index-handle", "Resident native index is absent.");
    if (!reserveScreeningHeap(i->sources.size(), c.num_threads))
      return false;
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
    ScreenSourceLookup sources;
    addScreenSources(sources, i->sources);
    auto out = screenedEvents(events, model, sources, alg, c.num_threads, i->axes);
    return catalogOutput(std::move(out), stats, method, std::move(excluded));
  }
  ScreeningStats stats;
  std::vector<std::unique_ptr<CQREventT>> events;
  std::vector<std::vector<uint8_t>> excluded;
  if (!screenSources(i->sources, {}, c, alg, stats, events, excluded, &i->primaries, model))
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
  radii(t.index->sources, c);
  int f = frame(r->EVALUATION_FRAME());
  if (!f || f != t.index->axes)
    return error("frame-mismatch", "Window evaluation frame differs from the resident index.");
  // The grid and the candidate search are geometry; only refinement reports a
  // probability, and a covariance method needs supplied covariance or a model.
  if (r->CONTROLS()->ALGORITHM() != cqrProbabilityAlgorithm::ALFANO_MAXIMUM &&
      std::strcmp(method, "refine_candidates") == 0 && !input("uncertainty_model") &&
      std::none_of(t.index->sources.begin(), t.index->sources.end(), [](const Source& source) { return !source.covariance.empty(); }))
    return error("unsupported-algorithm", std::string(method) + " requires supplied covariance or an uncertainty_model for a covariance method.");
  if (!t.index->primaries.empty())
    return error("unsupported-index", std::string(method) + " screens every source against every other; the index names primaries.");
  // Sampling needs one source (the rows of one updated object); pairs need two.
  if (t.index->sources.size() < (std::strcmp(method, "coarse_grid") == 0 ? 1u : 2u))
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
  return reserveScreeningHeap(t.index->sources.size(), c.num_threads);
}

// The screening work products are $SCR records, one arm each.
// false on a refused frame; out is null when an optional port is absent.
bool scrArm(const char *port, bool required, const char *code, const char *what, const SCR *&out) {
  out = nullptr;
  const plugin_input_frame_t *f = input(port);
  if (!f)
    return required ? error(code, std::string(port) + " is required: " + what + ".") : true;
  out = decode<SCR>(f, "$SCR");
  return out ? true : error(code, std::string(port) + " must be a $SCR record: " + what + ".");
}
bool pushScr(const char *port, flatbuffers::FlatBufferBuilder &b, flatbuffers::Offset<SCR> root) {
  FinishSCRBuffer(b, root);
  return plugin_push_output_ex(port, "SCR.fbs", "$SCR", 0, "SCR", 0, 0, b.GetBufferPointer(), b.GetSize()) >= 0;
}
flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<SCRExclusion>>>
exclusions(flatbuffers::FlatBufferBuilder &b, const std::map<uint32_t, ExcludedObject> &excluded) {
  std::vector<flatbuffers::Offset<SCRExclusion>> rows;
  for (const auto &[index, x] : excluded)
    rows.push_back(CreateSCRExclusion(b, index, x.first_failure_jd, b.CreateString(x.reason)));
  return b.CreateVector(rows);
}
// candidates: $SCR CANDIDATES, by step then pair as found.
bool pushCandidates(const std::vector<TightCandidate> &found) {
  flatbuffers::FlatBufferBuilder b(64 + found.size() * 12);
  SCRCandidatePair *rows = nullptr;
  auto v = b.CreateUninitializedVectorOfStructs<SCRCandidatePair>(found.size(), &rows);
  for (size_t k = 0; k < found.size(); ++k)
    rows[k] = SCRCandidatePair(found[k].obj1, found[k].obj2, static_cast<uint32_t>(found[k].step));
  SCRBuilder r(b);
  r.add_CANDIDATES(CreateSCRCandidates(b, v));
  return pushScr("candidates", b, r.Finish());
}
// report: $SCR SEARCH_REPORT.
struct SearchCounts {
  uint32_t primaries = 0, secondaries = 0, skipped = 0, candidates = 0;
};
bool pushSearchReport(uint32_t first, uint32_t count, int32_t last, size_t objects,
                      const std::map<uint32_t, ExcludedObject> &excluded, const SearchCounts &n) {
  flatbuffers::FlatBufferBuilder b(256);
  auto x = exclusions(b, excluded);
  SCRSearchReportBuilder rb(b);
  rb.add_FIRST_STEP(first);
  rb.add_STEP_COUNT(count);
  rb.add_LAST_STEP(last);
  rb.add_OBJECTS(static_cast<uint32_t>(objects));
  rb.add_EXCLUDED(x);
  rb.add_PRIMARIES(n.primaries);
  rb.add_SECONDARIES(n.secondaries);
  rb.add_SKIPPED(n.skipped);
  rb.add_CANDIDATE_COUNT(n.candidates);
  auto report = rb.Finish();
  SCRBuilder r(b);
  r.add_SEARCH_REPORT(report);
  return pushScr("report", b, r.Finish());
}
} // namespace ca_cqr

namespace ca_cqr {
// The block ($SCR BLOCK: FIRST_STEP, STEP_COUNT) of a tight request.
bool tightBlock(const char *method, ScreeningConfig &c, TightSet &t, uint32_t max_steps,
                uint32_t &first, uint32_t &count, int32_t &last) {
  if (!tightRequest(method, c, t))
    return false;
  const SCR *b = nullptr;
  if (!scrArm("block", true, "invalid-block", "a BLOCK of the window's coarse steps", b))
    return false;
  if (!b->BLOCK())
    return error("invalid-block", "block must be a $SCR BLOCK (FIRST_STEP, STEP_COUNT).");
  first = b->BLOCK()->FIRST_STEP();
  count = b->BLOCK()->STEP_COUNT();
  last = tight_last_coarse_step(c);
  if (count == 0 || count > max_steps || static_cast<int64_t>(first) + count - 1 > last)
    return error("invalid-block", "The block must hold 1 to " + std::to_string(max_steps) +
                                      " steps of the window (steps 0.." + std::to_string(last) + ").");
  return true;
}
} // namespace ca_cqr

// One block of coarse steps in the GPU layout (screening_tight.h).
// Inputs: request ($CQR WINDOW_REQUEST on a resident index), block ($SCR
// BLOCK, 1-256 steps). Outputs: grid ($SCR GRID: STATES step-major, one
// (x, y, z, D, vx, vy, vz, 0) row per step and object, and BANDS per object)
// and report ($SCR SEARCH_REPORT with the block's exclusions).
extern "C" int coarse_grid() {
  using namespace ca_cqr;
  ScreeningConfig c;
  TightSet t;
  uint32_t first = 0, count = 0;
  int32_t last = 0;
  if (!tightBlock("coarse_grid", c, t, 256, first, count, last))
    return 400;
  auto g = tight_coarse_grid_block(t.refs, c, static_cast<int32_t>(first), static_cast<int32_t>(count), {});
  static_assert(sizeof(SCRGridState) == 8 * sizeof(float) && sizeof(SCRRadiusBand) == 2 * sizeof(float),
                "SCR grid rows are the tight grid's float rows");
  flatbuffers::FlatBufferBuilder b(256 + (g.states.size() + g.bands.size()) * sizeof(float));
  SCRGridState *states = nullptr;
  SCRRadiusBand *bands = nullptr;
  auto sv = b.CreateUninitializedVectorOfStructs<SCRGridState>(g.states.size() / 8, &states);
  if (!g.states.empty())
    std::memcpy(states, g.states.data(), g.states.size() * sizeof(float));
  auto bv = b.CreateUninitializedVectorOfStructs<SCRRadiusBand>(g.bands.size() / 2, &bands);
  if (!g.bands.empty())
    std::memcpy(bands, g.bands.data(), g.bands.size() * sizeof(float));
  SCRGridBuilder gb(b);
  gb.add_FIRST_STEP(first);
  gb.add_STEP_COUNT(count);
  gb.add_OBJECTS(g.objects);
  gb.add_STEP_S(c.coarse_step_sec);
  gb.add_STATES(sv);
  gb.add_BANDS(bv);
  auto grid = gb.Finish();
  SCRBuilder r(b);
  r.add_GRID(grid);
  if (!pushScr("grid", b, r.Finish()))
    return 500;
  return pushSearchReport(first, count, last, g.objects, g.excluded, {}) ? 0 : 500;
}

// The CPU counterpart of coarse_grid plus the GPU search: the candidates of a
// block of coarse steps, found in the module (tight_search_block). Inputs:
// request and block as coarse_grid (up to 65,535 steps). Outputs: candidates
// ($SCR CANDIDATES), the record refine_candidates takes, and report.
extern "C" int search_candidates() {
  using namespace ca_cqr;
  ScreeningConfig c;
  TightSet t;
  uint32_t first = 0, count = 0;
  int32_t last = 0;
  if (!tightBlock("search_candidates", c, t, 65535, first, count, last))
    return 400;
  auto found = tight_search_block(t.refs, c, static_cast<int32_t>(first), static_cast<int32_t>(count));
  if (conjunction::has_error())
    return error("screening-failed", conjunction::error_message()), 422;
  if (!pushCandidates(found.candidates))
    return 500;
  SearchCounts n;
  n.candidates = static_cast<uint32_t>(found.candidates.size());
  return pushSearchReport(first, count, last, t.refs.size(), found.excluded, n) ? 0 : 500;
}

// The candidates of a coarse grid the host kept from coarse_grid (the same
// window and block), found on the module's threads: the CPU counterpart of the
// GPU search for a stored grid. Inputs: request (a $CQR WINDOW_REQUEST whose
// controls give the window, coarse step, threshold and workers; its index is
// not consulted: the grid holds every state the search reads); grid ($SCR GRID
// as coarse_grid returned it); roles (optional: $SCR ROLES, one per grid
// object; a pair is searched when one member is a primary and neither is
// skipped; absent: every pair). Outputs: candidates ($SCR CANDIDATES in grid
// rows, by step then pair) and report ($SCR SEARCH_REPORT: the block, the roles
// counted and the candidates). Rows that are not finite (objects coarse_grid
// excluded) are not searched. refine_candidates takes the candidates on an
// index whose sources are the grid's rows, or the rows the candidates name, in
// the same order.
extern "C" int search_grid() {
  using namespace ca_cqr;
  auto q = request();
  if (!q || !q->WINDOW_REQUEST())
    return error("invalid-request-arm", "search_grid requires WINDOW_REQUEST."), 400;
  ScreeningConfig c;
  if (!controls(q->WINDOW_REQUEST()->CONTROLS(), c))
    return 400;
  const SCR *gr = nullptr;
  if (!scrArm("grid", true, "invalid-grid", "the GRID coarse_grid returned", gr))
    return 400;
  const SCRGrid *g = gr->GRID();
  if (!g)
    return error("invalid-grid", "grid must be a $SCR GRID as coarse_grid returned it."), 400;
  const uint32_t first = g->FIRST_STEP(), count = g->STEP_COUNT(), objects = g->OBJECTS();
  const int32_t last = tight_last_coarse_step(c);
  const size_t rows = static_cast<size_t>(count) * objects;
  if (objects == 0 || count == 0 || static_cast<int64_t>(first) + count - 1 > last || !g->STATES() ||
      !g->BANDS() || g->STATES()->size() != rows || g->BANDS()->size() != objects)
    return error("invalid-grid", "The grid must hold rows for 1 or more steps of the window (steps 0.." +
                                     std::to_string(last) + "), in coarse_grid's layout."), 400;
  std::vector<uint8_t> roles;
  const SCR *rr = nullptr;
  if (!scrArm("roles", false, "invalid-roles", "ROLES, one per grid object", rr))
    return 400;
  if (rr) {
    const auto *v = rr->ROLES() ? rr->ROLES()->ROLES() : nullptr;
    if (!rr->ROLES() || !v || v->size() != objects)
      return error("invalid-roles", "roles must be a $SCR ROLES with one role per grid object."), 400;
    roles.reserve(v->size());
    for (const scrScreeningRole x : *v)
      roles.push_back(static_cast<uint8_t>(x));
    if (std::any_of(roles.begin(), roles.end(), [](uint8_t x) { return x > kTightRoleSkip; }))
      return error("invalid-roles", "A role is Secondary, Primary or Skip."), 400;
  }
  // The rows are read in place when the frame keeps them 4-byte aligned, else copied.
  const uint8_t *stateBytes = g->STATES()->Data(), *bandBytes = g->BANDS()->Data();
  std::vector<float> stateCopy, bandCopy;
  if (reinterpret_cast<uintptr_t>(stateBytes) % alignof(float) != 0 ||
      reinterpret_cast<uintptr_t>(bandBytes) % alignof(float) != 0) {
    stateCopy.resize(rows * 8);
    bandCopy.resize(static_cast<size_t>(objects) * 2);
    std::memcpy(stateCopy.data(), stateBytes, stateCopy.size() * sizeof(float));
    std::memcpy(bandCopy.data(), bandBytes, bandCopy.size() * sizeof(float));
  }
  StoredCoarseGrid grid;
  grid.first_step = static_cast<int32_t>(first);
  grid.step_count = static_cast<int32_t>(count);
  grid.objects = objects;
  grid.states = stateCopy.empty() ? reinterpret_cast<const float *>(stateBytes) : stateCopy.data();
  grid.bands = bandCopy.empty() ? reinterpret_cast<const float *>(bandBytes) : bandCopy.data();
  auto found = tight_grid_search_block(grid, c, roles);
  if (conjunction::has_error())
    return error("screening-failed", conjunction::error_message()), 422;
  if (!pushCandidates(found.candidates))
    return 500;
  uint32_t counted[3] = {0, 0, 0};
  if (roles.empty()) counted[kTightRolePrimary] = objects;
  for (const uint8_t x : roles) ++counted[x];
  SearchCounts n;
  n.primaries = counted[kTightRolePrimary];
  n.secondaries = counted[kTightRoleSecondary];
  n.skipped = counted[kTightRoleSkip];
  n.candidates = static_cast<uint32_t>(found.candidates.size());
  return pushSearchReport(first, count, last, objects, {}, n) ? 0 : 500;
}

// Refines candidate pairs into the catalog result screen_catalog returns.
// Inputs: request as coarse_grid; candidates ($SCR CANDIDATES) - absent:
// search every coarse step in the module, as search_candidates does; excluded
// ($SCR EXCLUSIONS: INDEX, FIRST_FAILURE_JD) - the exclusions coarse_grid
// reported for the window.
extern "C" int refine_candidates() {
  using namespace ca_cqr;
  if (hasPending("refine_candidates"))
    return emitPending("refine_candidates") ? 0 : 422;
  ScreeningConfig c;
  TightSet t;
  if (!tightRequest("refine_candidates", c, t))
    return 400;
  std::map<uint32_t, ExcludedObject> excluded;
  const SCR *xr = nullptr;
  if (!scrArm("excluded", false, "invalid-excluded", "EXCLUSIONS (INDEX, FIRST_FAILURE_JD)", xr))
    return 400;
  if (xr) {
    if (!xr->EXCLUSIONS())
      return error("invalid-excluded", "excluded must be a $SCR EXCLUSIONS (INDEX, FIRST_FAILURE_JD)."), 400;
    if (const auto *rows = xr->EXCLUSIONS()->EXCLUSIONS())
      for (const SCRExclusion *row : *rows) {
        const uint32_t index = row->INDEX();
        const double jd = row->FIRST_FAILURE_JD();
        if (index >= t.refs.size() || !std::isfinite(jd))
          return error("invalid-excluded", "An excluded entry is out of range."), 400;
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
  const SCR *cr = nullptr;
  if (!scrArm("candidates", false, "invalid-candidates", "CANDIDATES (OBJECT1, OBJECT2, STEP)", cr))
    return 400;
  if (cr) {
    if (!cr->CANDIDATES())
      return error("invalid-candidates", "candidates must be a $SCR CANDIDATES (OBJECT1, OBJECT2, STEP)."), 400;
    if (const auto *pairs = cr->CANDIDATES()->PAIRS()) {
      candidates.resize(pairs->size());
      for (flatbuffers::uoffset_t k = 0; k < pairs->size(); ++k) {
        const SCRCandidatePair *p = pairs->Get(k);
        candidates[k].obj1 = p->OBJECT1();
        candidates[k].obj2 = p->OBJECT2();
        candidates[k].step = static_cast<int32_t>(p->STEP());
      }
    }
  }
  ScreeningStats stats;
  EmpiricalModel model;
  if (!empiricalModel(model))
    return 400;
  auto events = screen_tight_candidates(t.refs, c, cr ? &candidates : nullptr, std::move(excluded), stats);
  if (conjunction::has_error())
    return error("screening-failed", conjunction::error_message()), 422;
  // Reject an oversized result before evaluating Pc or constructing its CDMs.
  // The caller retries the same candidates in smaller batches.
  if (!checkEventStagingCapacity(events.size()))
    return 422;
  ScreenSourceLookup sources;
  addScreenSources(sources, t.index->sources);
  const auto alg = request()->WINDOW_REQUEST() ? request()->WINDOW_REQUEST()->CONTROLS()->ALGORITHM()
                                               : cqrProbabilityAlgorithm::ALFANO_MAXIMUM;
  auto out = screenedEvents(events, model, sources, alg, c.num_threads, t.index->axes);
  std::vector<std::vector<uint8_t>> excludedRecords;
  for (const auto &x : stats.excluded_objects)
    excludedRecords.push_back(excludedRecord(t.index->sources[x.index], x));
  return catalogOutput(std::move(out), stats, "refine_candidates", std::move(excludedRecords),
                       kRefineEventsPerChunk) ? 0 : 422;
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
