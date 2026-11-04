// flows/observation-od: the laser orbit-determination node. It routes typed messages between the normal points, the
// station coordinates, analysis/estimation `fit_batch` and propagator/ffm `invoke`; the estimator solves and the FFM
// propagates.
//
//   step   observations ($TDM per pass, data-source/ilrs-crd-source), stations ($GST per pad,
//          data-source/ilrs-station-coordinates), earth_orientation ($PRW EARTH_ORIENTATION, the record propagator/ffm
//          takes), execution ($PRW EXECUTION_REQUEST: the first guess in INITIAL, the estimate's epoch in TARGET_EPOCH,
//          the dynamics, the solve-for parameters in DYNAMIC_PARAMETERS), config (ModuleConfig, optional), and on later
//          calls estimation (the $EST envelope this node last emitted), result (fit_batch's $EST answer to it) and
//          samples ($PRW EXECUTION_RESULT, propagator/ffm's answer to this node's last propagation)
//          -> one of: propagation ($PRW EXECUTION_REQUEST for propagator/ffm invoke), estimation ($EST for
//          analysis/estimation fit_batch), ocm (the Cartesian $OCM of the converged fit)
//
// The node keeps no state: every call recomputes the observations from its inputs and either asks for what is missing
// or finishes. The rounds:
//   1. no estimation, no samples: the first guess to every receive epoch and to TARGET_EPOCH (propagation);
//   2. no estimation, samples: the fit_batch request (estimation) at TARGET_EPOCH, seeded with the guess carried there,
//      each normal point's elevation taken from the guess (the troposphere model reads it);
//   3. estimation and result NEEDS_PROPAGATION: the queries' seed and parameters to every query epoch with the state
//      transition matrix and the parameter columns (propagation); with samples, the answers appended (estimation);
//   4. estimation and result OK: the $OCM; NOT_CONVERGED is refused.
//
// A normal point is a two-way laser range at its receive instant: a TRANSMIT-tagged epoch moves forward by the round
// trip, 2 x range / c, as analysis/estimation's $TDM reading does. Each is one estimator observation with the station's
// GCRF position and velocity at that instant: the pad's ITRF reference point (the $GST position plus its eccentricity)
// rotated by the IAU 2006/2000A CIO chain of foundation/frames with the supplied EOP. The estimator's two-way light-time
// model and Marini-Murray troposphere (the pass's meteorology, wavelength c / TRANSMIT_FREQ_1) apply.
//
// Refused by name: no-stations (a pad without coordinates, or none at all), arc-too-short:<hours>,
// no-convergence:<iterations>; bad-input for an input that does not read.
//
// Config keys (ModuleConfig, numbers): rangeSigmaM (default 0.05), minimumArcHours (24), maximumIterations (20),
// editThreshold (5, fit_batch sigma_edit_threshold), correctionTolerance (0.01).

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <ModuleConfig_generated.h>  // staged by the SDK compiler

namespace R = sdn::runtime;
namespace wire = ::orbpro::estimation;
namespace fr = ::sdn::frames;

namespace {

constexpr const char* kPluginId = "org.sdn.flows.observation-od.laser-od";
constexpr const char* kVersion = "0.1.0";
constexpr double kC = 299792458.0;

int fail(const std::string& code, const std::string& message) {
  plugin_set_error(code.c_str(), message.c_str());
  return 1;
}

std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> out;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && !std::strcmp(f->port_id, port) && f->payload && f->payload_length) out.push_back(f);
  }
  return out;
}
const plugin_input_frame_t* frame(const char* port) {
  const auto all = frames(port);
  return all.empty() ? nullptr : all.front();
}

// A PRW record, size-prefixed (as propagator/ffm writes them) or not.
const PRW* prw(const plugin_input_frame_t* f) {
  if (!f) return nullptr;
  if (f->payload_length >= 12 && flatbuffers::BufferHasIdentifier(f->payload, PRWIdentifier(), true)) {
    flatbuffers::Verifier v(f->payload, f->payload_length);
    return VerifySizePrefixedPRWBuffer(v) ? GetSizePrefixedPRW(f->payload) : nullptr;
  }
  flatbuffers::Verifier v(f->payload, f->payload_length);
  return PRWBufferHasIdentifier(f->payload) && VerifyPRWBuffer(v) ? GetPRW(f->payload) : nullptr;
}

const wire::EstimationEnvelope* envelope(const plugin_input_frame_t* f) {
  if (!f || !wire::EstimationEnvelopeBufferHasIdentifier(f->payload)) return nullptr;
  flatbuffers::Verifier v(f->payload, f->payload_length);
  return wire::VerifyEstimationEnvelopeBuffer(v) ? wire::GetEstimationEnvelope(f->payload) : nullptr;
}

// ---- time: UTC instants as whole civil days from 1970-01-01 and seconds of the day -------------------------------
struct Utc {
  int64_t day = 0;
  double seconds = 0.0;
};
int64_t days_from_civil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return static_cast<int64_t>(era) * 146097 + static_cast<int>(doe) - 719468;
}
void civil_from_days(int64_t z, int* y, unsigned* m, unsigned* d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  *d = doy - (153 * mp + 2) / 5 + 1;
  *m = mp < 10 ? mp + 3 : mp - 9;
  *y = static_cast<int>(yoe) + static_cast<int>(era) * 400 + (*m <= 2);
}
// "YYYY-MM-DDThh:mm:ss[.f]" with an optional Z.
bool parse_utc(const std::string& text, Utc* out) {
  int y = 0, mo = 0, d = 0, h = 0, mi = 0;
  if (std::sscanf(text.c_str(), "%d-%d-%dT%d:%d:", &y, &mo, &d, &h, &mi) != 5) return false;
  const size_t colon = text.find(':', text.find('T') + 4);
  if (colon == std::string::npos) return false;
  char* end = nullptr;
  const double s = std::strtod(text.c_str() + colon + 1, &end);
  if (end == text.c_str() + colon + 1 || !(s >= 0 && s < 60) || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return false;
  out->day = days_from_civil(y, static_cast<unsigned>(mo), static_cast<unsigned>(d));
  out->seconds = h * 3600.0 + mi * 60.0 + s;
  return true;
}
Utc normalized(Utc t) {
  while (t.seconds >= 86400.0) t.seconds -= 86400.0, ++t.day;
  while (t.seconds < 0.0) t.seconds += 86400.0, --t.day;
  return t;
}
std::string iso(Utc t) {
  t = normalized(t);
  int y = 0;
  unsigned m = 0, d = 0;
  civil_from_days(t.day, &y, &m, &d);
  // Nanoseconds of the day, rounded once.
  const int64_t ns = static_cast<int64_t>(std::llround(t.seconds * 1e9));
  const int64_t whole = ns / 1000000000, frac = ns % 1000000000;
  char text[48];
  std::snprintf(text, sizeof text, "%04d-%02u-%02uT%02lld:%02lld:%02lld.%09lldZ", y, m, d, static_cast<long long>(whole / 3600),
                static_cast<long long>(whole / 60 % 60), static_cast<long long>(whole % 60), static_cast<long long>(frac));
  return text;
}
// The estimator's epoch label: the UTC day's midnight as a Julian date and the UTC seconds of the day.
wire::EstimationEpoch label(Utc t) {
  t = normalized(t);
  return wire::EstimationEpoch(static_cast<double>(t.day) + 2440587.5, t.seconds);
}
Utc from_label(const wire::EstimationEpoch& e) { return normalized({static_cast<int64_t>(std::llround(e.jd_day() - 2440587.5)), e.seconds()}); }
double hours_between(Utc a, Utc b) { return ((b.day - a.day) * 86400.0 + (b.seconds - a.seconds)) / 3600.0; }

// ---- configuration ----------------------------------------------------------------------------------------------
struct Config {
  double range_sigma_m = 0.05;
  double minimum_arc_hours = 24.0;
  double maximum_iterations = 20;
  double edit_threshold = 5.0;
  double correction_tolerance = 0.01;
};
bool read_config(Config* c, std::string* error) {
  const auto* f = frame("config");
  if (!f) return true;
  flatbuffers::Verifier v(f->payload, f->payload_length);
  if (!R::VerifyModuleConfigBuffer(v)) return *error = "config is not a ModuleConfig (MCFG)", false;
  const auto* entries = R::GetModuleConfig(f->payload)->ENTRIES();
  for (uint32_t k = 0; entries && k < entries->size(); ++k) {
    const auto* e = entries->Get(k);
    const std::string key = e->KEY() ? e->KEY()->str() : std::string();
    double* target = key == "rangeSigmaM" ? &c->range_sigma_m : key == "minimumArcHours" ? &c->minimum_arc_hours
                   : key == "maximumIterations" ? &c->maximum_iterations : key == "editThreshold" ? &c->edit_threshold
                   : key == "correctionTolerance" ? &c->correction_tolerance : nullptr;
    if (!target || e->KIND() != R::configValueKind_Number || !std::isfinite(e->NUMBER_VALUE()) || e->NUMBER_VALUE() < 0)
      return *error = "config key '" + key + "' is not one of rangeSigmaM, minimumArcHours, maximumIterations, editThreshold, correctionTolerance as a non-negative number", false;
    *target = e->NUMBER_VALUE();
  }
  if (!(c->range_sigma_m > 0) || c->maximum_iterations < 1) return *error = "rangeSigmaM must be positive and maximumIterations at least 1", false;
  return true;
}

// ---- Earth orientation and the station's GCRF state -------------------------------------------------------------
struct Earth {
  std::vector<fr::eop::Row> rows;
  bool at(Utc t, fr::Epoch* epoch, fr::EarthOrientation* eo, std::string* error) const {
    t = normalized(t);
    const double utc1 = static_cast<double>(t.day) + 2440587.5, utc2 = t.seconds / 86400.0;
    const std::string e = fr::eop::atValidated(rows, utc1, utc2, eo);
    if (!e.empty()) return *error = e, false;
    double tai1 = 0, tai2 = 0;
    if (eraUtctai(utc1, utc2, &tai1, &tai2) != 0 || eraTaitt(tai1, tai2, &epoch->tt1, &epoch->tt2) != 0 ||
        eraUtcut1(utc1, utc2, eo->dut1, &epoch->ut11, &epoch->ut12) != 0)
      return *error = "a UTC epoch outside the leap-second table", false;
    return true;
  }
};

struct Pad {
  fr::Vec3 itrf;          // reference point, m
  double latitude = 0, longitude = 0, height = 0;  // geodetic (WGS84), rad and m
};

bool pad_of(const GST* g, Pad* pad, std::string* error) {
  fr::Vec3 marker{g->POSITION_X(), g->POSITION_Y(), g->POSITION_Z()};
  if (!std::isfinite(marker.x) || !std::isfinite(marker.y) || !std::isfinite(marker.z) || fr::norm(marker) < 6.0e6)
    return *error = "station position does not read", false;
  double xyz[3] = {marker.x, marker.y, marker.z}, lon = 0, lat = 0, h = 0;
  if (eraGc2gd(1, xyz, &lon, &lat, &h) != 0) return *error = "station geodetic position", false;
  const std::string frame_name = g->ECCENTRICITY_FRAME() ? g->ECCENTRICITY_FRAME()->str() : std::string();
  const double ex = std::isfinite(g->ECCENTRICITY_X()) ? g->ECCENTRICITY_X() : 0.0;
  const double ey = std::isfinite(g->ECCENTRICITY_Y()) ? g->ECCENTRICITY_Y() : 0.0;
  const double ez = std::isfinite(g->ECCENTRICITY_Z()) ? g->ECCENTRICITY_Z() : 0.0;
  fr::Vec3 offset{0, 0, 0};
  if (frame_name == "XYZ") {
    offset = {ex, ey, ez};
  } else if (frame_name == "NEU") {
    const double sl = std::sin(lat), cl = std::cos(lat), so = std::sin(lon), co = std::cos(lon);
    const fr::Vec3 north{-sl * co, -sl * so, cl}, east{-so, co, 0}, up{cl * co, cl * so, sl};
    offset = fr::add(fr::add(fr::scale(north, ex), fr::scale(east, ey)), fr::scale(up, ez));
  } else if (!frame_name.empty() || ex != 0 || ey != 0 || ez != 0) {
    return *error = "station eccentricity frame '" + frame_name + "' is not XYZ or NEU", false;
  }
  pad->itrf = fr::add(marker, offset);
  double r[3] = {pad->itrf.x, pad->itrf.y, pad->itrf.z};
  eraGc2gd(1, r, &pad->longitude, &pad->latitude, &pad->height);
  return true;
}

// ---- normal points ----------------------------------------------------------------------------------------------
struct Point {
  Utc receive;
  double range = 0;
  std::string pad;
  double pressure = 0, temperature = 0, humidity = 0, wavelength = 0;
  fr::Vec3 station, station_velocity, up;
};

std::string text(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

bool read_points(std::vector<Point>* out, std::string* error) {
  for (const auto* f : frames("observations")) {
    flatbuffers::Verifier v(f->payload, f->payload_length);
    if (!TDMBufferHasIdentifier(f->payload) || !VerifyTDMBuffer(v)) return *error = "observations must be $TDM records", false;
    const TDM* tdm = GetTDM(f->payload);
    const std::string observer = text(tdm->OBSERVER_ID());
    if (observer.size() < 4) return *error = "a $TDM without OBSERVER_ID (the station occupancy designator)", false;
    const std::string pad = observer.substr(0, 4);
    struct Sample { Utc t; double v; };
    std::vector<Sample> pressure, temperature, humidity;
    if (!tdm->SEGMENTS()) continue;
    for (const TDMSegment* seg : *tdm->SEGMENTS()) {
      if (!seg || !seg->OBSERVATIONS()) continue;
      for (const TDMObservation* row : *seg->OBSERVATIONS()) {
        const std::string key = text(row->KEYWORD());
        std::vector<Sample>* target = key == "PRESSURE" ? &pressure : key == "TEMPERATURE" ? &temperature : key == "RHUMIDITY" ? &humidity : nullptr;
        if (!target) continue;
        Utc t;
        if (!parse_utc(text(row->EPOCH()), &t)) return *error = "a weather epoch does not read", false;
        target->push_back({t, row->VALUE()});
      }
    }
    const auto nearest = [](const std::vector<Sample>& s, Utc t) {
      double best = NAN, gap = INFINITY;
      for (const auto& x : s) {
        const double g = std::fabs(hours_between(x.t, t));
        if (g < gap) gap = g, best = x.v;
      }
      return best;
    };
    for (const TDMSegment* seg : *tdm->SEGMENTS()) {
      if (!seg || !seg->OBSERVATIONS()) continue;
      const std::string system = !text(seg->TIME_SYSTEM()).empty() ? text(seg->TIME_SYSTEM()) : text(tdm->TIME_SYSTEM());
      const std::string tag = !text(seg->TIMETAG_REF()).empty() ? text(seg->TIMETAG_REF()) : text(tdm->TIMETAG_REF());
      const double carrier = seg->TRANSMIT_FREQ_1() > 0 ? seg->TRANSMIT_FREQ_1() : tdm->TRANSMIT_FREQ_1();
      for (const TDMObservation* row : *seg->OBSERVATIONS()) {
        if (text(row->KEYWORD()) != "LASER_RANGE") continue;
        if (system != "UTC") return *error = "TIME_SYSTEM '" + system + "' is not UTC", false;
        if (tag != "TRANSMIT" && tag != "RECEIVE") return *error = "LASER_RANGE needs TIMETAG_REF TRANSMIT or RECEIVE", false;
        Point p;
        if (!parse_utc(text(row->EPOCH()), &p.receive) || !(row->VALUE() > 0)) return *error = "a normal point does not read", false;
        p.range = row->VALUE();
        if (tag == "TRANSMIT") p.receive.seconds += 2.0 * p.range / kC;
        p.receive = normalized(p.receive);
        p.pad = pad;
        p.wavelength = carrier > 0 ? kC / carrier : 0.0;
        p.pressure = nearest(pressure, p.receive);
        p.temperature = nearest(temperature, p.receive);
        p.humidity = nearest(humidity, p.receive);
        out->push_back(p);
      }
    }
  }
  std::stable_sort(out->begin(), out->end(), [](const Point& a, const Point& b) { return hours_between(b.receive, a.receive) < 0; });
  return true;
}

// ---- records ----------------------------------------------------------------------------------------------------
int push(const char* port, const char* schema, const char* id, const char* root, const flatbuffers::FlatBufferBuilder& b) {
  return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, b.GetBufferPointer(), b.GetSize()) < 0 ? 1 : 0;
}
std::unique_ptr<TIMInstantT> instant(Utc t) {
  auto i = std::make_unique<TIMInstantT>();
  i->TIME_SYSTEM = timingStandard::UTC;
  i->EPOCH_FORMAT = timEpochRepresentation::ISO8601;
  i->ISO8601 = iso(t);
  return i;
}
int push_execution(std::unique_ptr<PRWExecutionRequestT> exec) {
  PRWT root;
  root.EXECUTION_REQUEST = std::move(exec);
  flatbuffers::FlatBufferBuilder b(1 << 16);
  FinishSizePrefixedPRWBuffer(b, PRW::Pack(b, &root));
  return push("propagation", "PRW.fbs", "$PRW", "PRW", b);
}
int push_envelope(const wire::EstimationEnvelopeT& env) {
  flatbuffers::FlatBufferBuilder b(1 << 16);
  wire::FinishEstimationEnvelopeBuffer(b, wire::EstimationEnvelope::Pack(b, &env));
  return push("estimation", "Estimation.fbs", "$EST", "EstimationEnvelope", b);
}

// The solve-for parameters: their PRW kinds, values in the dynamics and domains (propagator/ffm README, "Fit parameter
// domains").
struct Parameter { prwDynamicParameter kind; double value, lower, upper; };
bool parameters_of(const PRWExecutionRequestT& exec, std::vector<Parameter>* out, std::string* error) {
  for (const auto kind : exec.DYNAMIC_PARAMETERS) {
    const auto& f = *exec.FORCES;
    if (kind == prwDynamicParameter::DRAG_AREA_OVER_MASS) out->push_back({kind, f.DRAG_COEFFICIENT * f.AREA_M2 / f.INITIAL_MASS_KG, 0.0, INFINITY});
    else if (kind == prwDynamicParameter::SRP_AREA_OVER_MASS) out->push_back({kind, f.REFLECTIVITY_COEFFICIENT * f.AREA_M2 / f.INITIAL_MASS_KG, 0.0, INFINITY});
    else if (kind == prwDynamicParameter::IN_TRACK_ACCELERATION) out->push_back({kind, f.HAS_IN_TRACK_ACCELERATION_M_S2 ? f.IN_TRACK_ACCELERATION_M_S2 : 0.0, NAN, NAN});
    else return *error = std::string("solve-for parameter ") + EnumNameprwDynamicParameter(kind) + " is not DRAG_AREA_OVER_MASS, SRP_AREA_OVER_MASS or IN_TRACK_ACCELERATION", false;
  }
  return true;
}
void set_parameters(PRWExecutionRequestT* exec, const std::vector<Parameter>& kinds, const flatbuffers::Vector<double>* values) {
  auto& f = *exec->FORCES;
  for (size_t i = 0; i < kinds.size() && values && i < values->size(); ++i) {
    const double v = values->Get(static_cast<flatbuffers::uoffset_t>(i));
    if (kinds[i].kind == prwDynamicParameter::DRAG_AREA_OVER_MASS) f.DRAG_COEFFICIENT = v * f.INITIAL_MASS_KG / f.AREA_M2;
    else if (kinds[i].kind == prwDynamicParameter::SRP_AREA_OVER_MASS) f.REFLECTIVITY_COEFFICIENT = v * f.INITIAL_MASS_KG / f.AREA_M2;
    else f.HAS_IN_TRACK_ACCELERATION_M_S2 = true, f.IN_TRACK_ACCELERATION_M_S2 = v;
  }
}
void set_state(PRWExecutionRequestT* exec, Utc epoch, const double* s) {
  auto& st = *exec->INITIAL->STATE;
  st.POSITION = std::make_unique<FRMVector3T>();
  st.VELOCITY = std::make_unique<FRMVector3T>();
  st.POSITION->X = s[0], st.POSITION->Y = s[1], st.POSITION->Z = s[2];
  st.VELOCITY->X = s[3], st.VELOCITY->Y = s[4], st.VELOCITY->Z = s[5];
  st.EPOCH = iso(epoch);
  st.EPOCH_TIME_SYSTEM = "UTC";
}
std::vector<Utc> unique_epochs(const std::vector<Point>& points) {
  std::vector<Utc> out;
  for (const auto& p : points) {
    if (out.empty() || iso(out.back()) != iso(p.receive)) out.push_back(p.receive);
  }
  return out;
}

// The $OCM of the converged fit: the estimate at the configuration epoch (GCRF, km and km/s), its formal covariance
// (lower triangle of the 6x6 state block, km^2), the orbit determination with its fit statistics, and the source's
// provenance.
int push_ocm(const wire::EstimationRequest* request, const wire::BatchFitResult* fit, const PRWExecutionRequestT& exec,
             const std::vector<Point>& points, const std::vector<Parameter>& kinds, double sigma) {
  const Utc epoch = from_label(request->config()->initial_epoch());
  OCMT ocm;
  ocm.HEADER = std::make_unique<HeaderT>();
  ocm.HEADER->CCSDS_OCM_VERS = "3.0";
  ocm.HEADER->ORIGINATOR = "SDN";
  ocm.METADATA = std::make_unique<MetadataT>();
  ocm.METADATA->OBJECT_NAME = exec.INITIAL->OBJECT_ID;
  ocm.METADATA->INTERNATIONAL_DESIGNATOR = exec.INITIAL->OBJECT_ID;
  ocm.METADATA->NORAD_CAT_ID = exec.INITIAL->CATALOG_NUMBER;
  ocm.METADATA->TIME_SYSTEM = "UTC";
  ocm.METADATA->EPOCH_TZERO = iso(epoch);
  ocm.METADATA->START_TIME = iso(points.front().receive);
  ocm.METADATA->STOP_TIME = iso(points.back().receive);
  ocm.METADATA->EOP_SOURCE = "earth_orientation input";
  ocm.CENTER_NAME = "EARTH";
  ocm.TRAJ_REF_FRAME = std::make_unique<RFMT>();
  ocm.TRAJ_REF_FRAME->NAME = "GCRF";
  ocm.COV_REF_FRAME = std::make_unique<RFMT>();
  ocm.COV_REF_FRAME->NAME = "GCRF";
  ocm.TRAJ_TYPE = trajectoryType::CARTESIAN_PV;
  ocm.TRAJ_TYPE_DESCRIPTION = "BATCH_ESTIMATE";
  ocm.STATE_VECTOR_SIZE = 6;
  const auto* x = fit->estimate();
  for (int i = 0; i < 6; ++i) ocm.STATE_DATA.push_back(x->Get(i) / 1000.0);
  ocm.STATE_EPOCHS = {iso(epoch)};
  const unsigned n = fit->state_dimension();
  for (unsigned i = 0; i < 6; ++i)
    for (unsigned j = 0; j <= i; ++j) ocm.COVARIANCE_DATA.push_back(fit->covariance()->Get(i * n + j) / 1.0e6);
  ocm.COV_ORDERING = covarianceOrdering::LTM;
  ocm.COV_SIZE = 6;
  ocm.COV_CALIBRATION = covarianceCalibration::Uncalibrated;

  // Range residuals: whitened by the one sigma every normal point carries.
  double sum = 0;
  size_t used = 0;
  std::vector<bool> rejected(points.size(), false);
  if (fit->rejected_observation_indices())
    for (uint32_t i : *fit->rejected_observation_indices()) if (i < rejected.size()) rejected[i] = true;
  std::vector<double> residuals;
  for (size_t i = 0; fit->whitened_residuals() && i < fit->whitened_residuals()->size() && i < points.size(); ++i) {
    const double r = fit->whitened_residuals()->Get(static_cast<flatbuffers::uoffset_t>(i)) * sigma;
    residuals.push_back(r);
    if (!rejected[i]) sum += r * r, ++used;
  }
  const double rms = used ? std::sqrt(sum / static_cast<double>(used)) : NAN;
  std::map<std::string, int> pads;
  for (const auto& p : points) ++pads[p.pad];

  auto od = std::make_unique<OrbitDeterminationT>();
  od->OD_ID = std::string("laser-od ") + iso(epoch);
  od->OD_ALGORITHM = "BATCH_WEIGHTED_LEAST_SQUARES";
  od->OD_METHOD = "MEASUREMENT_BASED";
  od->OD_ESTIMATOR = estimatorCategory::BatchLeastSquares;
  od->OD_EPOCH = iso(epoch);
  od->OD_OBSERVATIONS_TYPE = {"LASER_RANGE"};
  od->OD_OBSERVATIONS_USED = static_cast<int>(used);
  od->OBS_AVAILABLE = static_cast<uint32_t>(points.size());
  od->SENSORS_N = static_cast<uint32_t>(pads.size());
  for (const auto& [pad, count] : pads) od->SENSORS += (od->SENSORS.empty() ? "" : " ") + pad;
  od->OD_NOISE_MODELS = "Zero-mean Gaussian range noise, independent between normal points; 1-sigma " + std::to_string(sigma) + " m";
  od->OD_DATA_WEIGHTING = "INVERSE_VARIANCE";
  od->OD_PROCESS_NOISE = "NONE";
  od->OD_APRIORI_DATA = "NONE";
  od->OD_EST_PARAMETERS = {"CARTESIAN_X", "CARTESIAN_Y", "CARTESIAN_Z", "CARTESIAN_VX", "CARTESIAN_VY", "CARTESIAN_VZ"};
  for (const auto& k : kinds) od->OD_EST_PARAMETERS.push_back(EnumNameprwDynamicParameter(k.kind));
  od->OD_RESIDUAL_RMS = rms;
  od->WEIGHTED_RMS = fit->weighted_rms();
  od->OD_RESIDUALS_SERIES = residuals;
  od->ACTUAL_OD_SPAN = hours_between(points.front().receive, points.back().receive) / 24.0;
  od->SOLVE_N = n;
  od->OD_CONVERGENCE_CRITERIA = "analysis/estimation fit_batch: scaled Gauss-Newton correction below " +
                                std::to_string(request->batch_options()->correction_tolerance()) + ", edit set a fixed point";
  od->FIT_STATISTICS = std::make_unique<OCMFitStatisticsT>();
  od->FIT_STATISTICS->FIT_STATES = static_cast<uint32_t>(used);
  od->FIT_STATISTICS->FIT_RMS_KM = rms / 1000.0;
  od->FIT_STATISTICS->ITERATIONS = fit->iterations();
  od->FIT_STATISTICS->CONVERGED = fit->converged();
  od->FIT_STATISTICS->FIT_START = iso(points.front().receive);
  od->FIT_STATISTICS->FIT_STOP = iso(points.back().receive);
  ocm.ORBIT_DETERMINATION = std::move(od);

  ocm.PROVENANCE = std::make_unique<PVNT>();
  ocm.PROVENANCE->SOURCE_ID = "ilrs-crd";
  ocm.PROVENANCE->SOURCE_KIND = pvnSourceKind::Observation;
  ocm.PROVENANCE->ORIGINATOR = "ILRS";
  ocm.PROVENANCE->PRODUCER = std::string(kPluginId) + " " + kVersion;
  ocm.PROVENANCE->LICENSE_CLASS = pvnLicenseClass::Reproducible;
  ocm.PROVENANCE->LICENSE_ID = "ilrs";
  ocm.PROVENANCE->LINEAGE = "ilrs";
  flatbuffers::FlatBufferBuilder b(1 << 14);
  FinishOCMBuffer(b, OCM::Pack(b, &ocm));
  return push("ocm", "OCM.fbs", "$OCM", "OCM", b);
}

}  // namespace

extern "C" int step(void) {
  std::string error;
  Config config;
  if (!read_config(&config, &error)) return fail("bad-input", error);

  const PRW* execution = prw(frame("execution"));
  if (!execution || !execution->EXECUTION_REQUEST()) return fail("bad-input", "execution must be a $PRW EXECUTION_REQUEST");
  const PRW* orientation = prw(frame("earth_orientation"));
  if (!orientation || !orientation->EARTH_ORIENTATION()) return fail("bad-input", "earth_orientation must be a $PRW EARTH_ORIENTATION");
  Earth earth;
  if (const std::string e = fr::eop::addRows(orientation->EARTH_ORIENTATION()->ROWS(), earth.rows); !e.empty()) return fail("bad-input", e);
  std::unique_ptr<PRWExecutionRequestT> templ(execution->EXECUTION_REQUEST()->UnPack());
  Utc target;
  if (!templ->TARGET_EPOCH || !parse_utc(templ->TARGET_EPOCH->ISO8601, &target) || templ->TARGET_EPOCH->TIME_SYSTEM != timingStandard::UTC)
    return fail("bad-input", "execution TARGET_EPOCH (the estimate's epoch) must be an ISO 8601 UTC instant");
  std::vector<Parameter> kinds;
  if (!parameters_of(*templ, &kinds, &error)) return fail("bad-input", error);

  // Stations by CDP pad.
  std::map<std::string, Pad> pads;
  for (const auto* f : frames("stations")) {
    flatbuffers::Verifier v(f->payload, f->payload_length);
    if (!GSTBufferHasIdentifier(f->payload) || !VerifyGSTBuffer(v)) return fail("bad-input", "stations must be $GST records");
    const GST* g = GetGST(f->payload);
    Pad pad;
    if (!pad_of(g, &pad, &error)) return fail("bad-input", text(g->CDP_NUMBER()) + ": " + error);
    pads[text(g->CDP_NUMBER())] = pad;
  }
  std::vector<Point> points;
  if (!read_points(&points, &error)) return fail("bad-input", error);
  if (points.empty()) return fail("bad-input", "observations hold no LASER_RANGE");
  {
    std::string missing;
    for (const auto& p : points)
      if (!pads.count(p.pad) && missing.find(p.pad) == std::string::npos) missing += (missing.empty() ? "" : " ") + p.pad;
    if (pads.empty() || !missing.empty()) return fail("no-stations", "no station coordinates for pad " + (missing.empty() ? std::string("any") : missing));
  }
  const double arc = hours_between(points.front().receive, points.back().receive);
  if (arc < config.minimum_arc_hours) {
    char code[48];
    std::snprintf(code, sizeof code, "arc-too-short:%.2f", arc);
    char message[96];
    std::snprintf(message, sizeof message, "the normal points span %.2f h, less than %g h", arc, config.minimum_arc_hours);
    return fail(code, message);
  }
  for (auto& p : points) {
    fr::Epoch epoch;
    fr::EarthOrientation eo;
    if (!earth.at(p.receive, &epoch, &eo, &error)) return fail("bad-input", error);
    const fr::RotationWithRate w = fr::rotationWithRate([&](const fr::Epoch& e) { return fr::gcrfToItrf(e, eo); }, epoch);
    const Pad& pad = pads[p.pad];
    const fr::Mat3 inverse = fr::transpose(w.rotation);
    p.station = fr::apply(inverse, pad.itrf);
    p.station_velocity = fr::apply(fr::transpose(w.rate), pad.itrf);
    const double cl = std::cos(pad.latitude);
    p.up = fr::apply(inverse, fr::Vec3{cl * std::cos(pad.longitude), cl * std::sin(pad.longitude), std::sin(pad.latitude)});
  }
  const std::vector<Utc> epochs = unique_epochs(points);

  const auto* sent = envelope(frame("estimation"));
  const auto* answer = envelope(frame("result"));
  const PRW* samples = prw(frame("samples"));
  if (samples && !samples->EXECUTION_RESULT()) return fail("bad-input", "samples must be a $PRW EXECUTION_RESULT");
  const auto* result = samples ? samples->EXECUTION_RESULT() : nullptr;

  // 1. The first guess to every receive epoch and to the estimate's epoch.
  if (!sent && !result) {
    auto exec = std::make_unique<PRWExecutionRequestT>(*templ);
    exec->INCLUDE_STM = false;
    exec->DYNAMIC_PARAMETERS.clear();
    exec->SAMPLE_EPOCHS.clear();
    for (const Utc& t : epochs) exec->SAMPLE_EPOCHS.push_back(instant(t));
    return push_execution(std::move(exec));
  }

  // 2. The fit_batch request, seeded with the guess at the estimate's epoch.
  if (!sent) {
    if (!result->SAMPLES() || result->SAMPLES()->size() != epochs.size()) return fail("bad-input", "samples must hold one state per receive epoch");
    std::map<std::string, size_t> at;
    for (size_t i = 0; i < epochs.size(); ++i) at[iso(epochs[i])] = i;
    wire::EstimationEnvelopeT env;
    env.request = std::make_unique<wire::EstimationRequestT>();
    auto& rq = *env.request;
    const auto* final_state = result->FINAL_SAMPLE()->STATE()->STATE();
    const double seed[6] = {final_state->POSITION()->X(), final_state->POSITION()->Y(), final_state->POSITION()->Z(),
                            final_state->VELOCITY()->X(), final_state->VELOCITY()->Y(), final_state->VELOCITY()->Z()};
    const double zero36[36] = {}, zero6[6] = {};
    rq.config = std::make_unique<wire::EstimationConfig>(label(target), flatbuffers::span<const double, 6>(seed, 6),
        flatbuffers::span<const double, 36>(zero36, 36), flatbuffers::span<const double, 6>(zero6, 6), 0.0, 0.0, 0.0, 0.0, 0u,
        ::orbpro::propagator::ReferenceFrame::ICRF, wire::EstimatorKind::BATCH_WEIGHTED_LEAST_SQUARES, wire::ProcessNoiseKind::NONE, 0);
    for (const auto& p : points) {
      const auto* s = result->SAMPLES()->Get(static_cast<flatbuffers::uoffset_t>(at[iso(p.receive)]))->STATE()->STATE();
      const fr::Vec3 los = fr::sub(fr::Vec3{s->POSITION()->X(), s->POSITION()->Y(), s->POSITION()->Z()}, p.station);
      const double elevation = std::asin(std::max(-1.0, std::min(1.0, fr::dot(fr::unit(los), p.up))));
      const Pad& pad = pads[p.pad];
      const double value[4] = {p.range, 0, 0, 0}, sigma[4] = {config.range_sigma_m, 0, 0, 0};
      const double sp[3] = {p.station.x, p.station.y, p.station.z}, sv[3] = {p.station_velocity.x, p.station_velocity.y, p.station_velocity.z};
      const double z3[3] = {0, 0, 0};
      rq.observations.emplace_back(label(p.receive), flatbuffers::span<const double, 4>(value, 4), flatbuffers::span<const double, 4>(sigma, 4),
          flatbuffers::span<const double, 3>(sp, 3), flatbuffers::span<const double, 3>(sv, 3), flatbuffers::span<const double, 3>(z3, 3),
          flatbuffers::span<const double, 3>(z3, 3), flatbuffers::span<const double, 3>(z3, 3), flatbuffers::span<const double, 3>(z3, 3),
          flatbuffers::span<const double, 3>(z3, 3), 0.0, 0.0, 0.0, 0.0, elevation, pad.latitude, pad.height,
          std::isfinite(p.pressure) ? p.pressure : 0.0, std::isfinite(p.temperature) ? p.temperature : 0.0,
          std::isfinite(p.humidity) ? p.humidity / 100.0 : 0.0, p.wavelength, 0.0, 0.0, 1u, 1u, wire::MeasurementKind::LASER_RANGE,
          static_cast<uint8_t>(1), static_cast<uint8_t>(0x04), 0u, 0u);
    }
    rq.error_models.emplace_back(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0ull, wire::MeasurementKind::LASER_RANGE, wire::TroposphereKind::MARINI,
                                 wire::IonosphereKind::NONE, static_cast<uint8_t>(0x04));
    rq.propagator_port_id = "propagator/ffm";
    rq.propagator_capability = "plugin_propagate plugin_compute_stm";
    rq.trace_id = std::string(kPluginId) + " " + iso(target);
    rq.batch_options = std::make_unique<wire::BatchFitOptionsT>();
    auto& bo = *rq.batch_options;
    for (const auto& k : kinds) {
      bo.parameter_kinds.push_back(static_cast<uint8_t>(k.kind));
      bo.parameter_values.push_back(k.value);
      bo.parameter_lower_bounds.push_back(k.lower);
      bo.parameter_upper_bounds.push_back(k.upper);
    }
    bo.maximum_iterations = static_cast<uint32_t>(config.maximum_iterations);
    bo.correction_tolerance = config.correction_tolerance;
    bo.sigma_edit_threshold = config.edit_threshold;
    return push_envelope(env);
  }

  if (!answer || !answer->result()) return fail("bad-input", "result must be the fit_batch $EST answer to estimation");
  const auto* request = sent->request();
  if (!request || !request->observations() || request->observations()->size() != points.size())
    return fail("bad-input", "estimation is not this node's request for these observations");
  const auto status = answer->result()->status();

  // 4. The fit ended.
  if (status != wire::EstimationStatus::NEEDS_PROPAGATION) {
    const auto* fit = answer->result()->batch_fit();
    if (status == wire::EstimationStatus::OK && fit && fit->converged() && fit->estimate() && fit->estimate()->size() >= 6)
      return push_ocm(request, fit, *templ, points, kinds, config.range_sigma_m);
    const unsigned iterations = fit ? fit->iterations() : 0;
    char code[48];
    std::snprintf(code, sizeof code, "no-convergence:%u", iterations);
    return fail(code, std::string("fit_batch ended ") + (fit ? wire::EnumNameBatchFitTermination(fit->termination()) : wire::EnumNameEstimationStatus(status)) +
                          " after " + std::to_string(iterations) + " propagation rounds");
  }

  // 3. A propagation round.
  const auto* queries = answer->result()->propagation_requests();
  if (!queries || queries->size() == 0) return fail("bad-input", "NEEDS_PROPAGATION without queries");
  const auto* q0 = queries->Get(0);
  std::vector<Utc> query_epochs;
  for (const auto* q : *queries) {
    const Utc t = from_label(*q->target_epoch());
    if (query_epochs.empty() || iso(query_epochs.back()) != iso(t)) query_epochs.push_back(t);
  }
  if (!result) {
    auto exec = std::make_unique<PRWExecutionRequestT>(*templ);
    const Utc seed_epoch = from_label(q0->seed()->epoch());
    double s[6];
    for (int i = 0; i < 6; ++i) s[i] = q0->seed()->state()->Get(i);
    set_state(exec.get(), seed_epoch, s);
    set_parameters(exec.get(), kinds, q0->parameter_values());
    exec->INCLUDE_STM = true;
    exec->SAMPLE_EPOCHS.clear();
    for (const Utc& t : query_epochs) exec->SAMPLE_EPOCHS.push_back(instant(t));
    exec->TARGET_EPOCH = instant(query_epochs.front());
    return push_execution(std::move(exec));
  }
  if (!result->SAMPLES() || result->SAMPLES()->size() != query_epochs.size()) return fail("bad-input", "samples must hold one state per query epoch");
  std::map<std::string, size_t> at;
  for (size_t i = 0; i < query_epochs.size(); ++i) at[iso(query_epochs[i])] = i;
  std::unique_ptr<wire::EstimationEnvelopeT> env(sent->UnPack());
  const size_t p = kinds.size(), n = 6 + p;
  for (const auto* q : *queries) {
    const auto* sample = result->SAMPLES()->Get(static_cast<flatbuffers::uoffset_t>(at[iso(from_label(*q->target_epoch()))]));
    const auto* s = sample->STATE()->STATE();
    if (!sample->STM() || sample->STM()->DIMENSION() != n || sample->STM()->VALUES()->size() != n * n)
      return fail("bad-input", "a sample without the state transition matrix over the state and the solve-for parameters");
    const auto* m = sample->STM()->VALUES();
    double state[6] = {s->POSITION()->X(), s->POSITION()->Y(), s->POSITION()->Z(), s->VELOCITY()->X(), s->VELOCITY()->Y(), s->VELOCITY()->Z()};
    double stm[36];
    auto a = std::make_unique<wire::PropagationAnswerT>();
    for (size_t i = 0; i < 6; ++i) {
      for (size_t j = 0; j < 6; ++j) stm[i * 6 + j] = m->Get(static_cast<flatbuffers::uoffset_t>(i * n + j));
      for (size_t j = 6; j < n; ++j) a->sensitivity.push_back(m->Get(static_cast<flatbuffers::uoffset_t>(i * n + j)));
    }
    a->query.reset(q->UnPack());
    a->sample = std::make_unique<wire::EstimationPropagatorSample>(*q->target_epoch(), flatbuffers::span<const double, 6>(state, 6),
                                                                   flatbuffers::span<const double, 36>(stm, 36));
    env->propagation_answers.push_back(std::move(a));
  }
  env->result.reset();
  return push_envelope(*env);
}
