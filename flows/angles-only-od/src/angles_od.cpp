// flows/angles-only-od: the angles-only orbit determination's planning node. No element set enters on any port: the
// first guess is analysis/optical-astrometry initial_orbit's Gooding state; every fit is flows/observation-od `step`
// (analysis/estimation fit_batch with propagator/ffm), run by the host to its end per candidate.
//
//   plan    observations ($TDM RA/Dec tracks), initial (the initial-orbit $OCM), execution ($PRW EXECUTION_REQUEST: the
//           dynamics; INITIAL carries the object and its coordinate system), stage (the $OCM selected for the last
//           completed stage; absent for the first), config
//           -> execution (one $PRW per candidate: the seed in INITIAL, the estimate's epoch, the initial orbit's, in
//           TARGET_EPOCH), observations (the stage's tracks), report (FlowNotice: the stage, its candidates)
//   select  observations, initial, stage (as for plan), candidates (the step $OCMs of the stage's candidates, any
//           number; a refused candidate sends none), config
//           -> selected (the stage's $OCM), report (FlowNotice: REASON stage-selected or complete)
//
// Nights are the tracks between gaps over 6 h; stage s fits nights 1..s. Stage 1 starts from the initial orbit.
// Across the first nightly gap (stage 2) the candidates are the revolution offsets k in [revolutionOffsetMin,
// revolutionOffsetMax] (default -1..1): the seed is stage 1's state with its velocity scaled so the two-body mean
// motion changes by 2 pi k / dt (dt from the epoch to the night's first track); later stages take k = 0. A candidate
// counts when its fit converged, its WEIGHTED_RMS is at most weightedRmsLimit (default 2) and its mean motion against
// stage 1's gives a revolution offset round((n - n1) dt / 2 pi) inside the stage's set. The lowest WEIGHTED_RMS wins;
// none: no-converged-revolution-count. An arc under minimumArcHours (24): arc-too-short:<hours>.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <ModuleConfig_generated.h>  // staged by the SDK compiler

namespace R = sdn::runtime;

namespace {

constexpr double kMu = 3.986004415e5;  // km^3/s^2, the two-body seed's mean motion only
constexpr double kNightGapHours = 6.0;

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
std::string text(const flatbuffers::String* s) { return s ? s->str() : std::string(); }

// ---- UTC as seconds from 1970 (days of 86400 s; the arc is far from a leap second's day) ----------------------------
int64_t days_from_civil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return static_cast<int64_t>(era) * 146097 + static_cast<int>(doe) - 719468;
}
bool parse_utc(const std::string& t, double* out) {
  int y = 0, mo = 0, d = 0, h = 0, mi = 0;
  if (std::sscanf(t.c_str(), "%d-%d-%dT%d:%d:", &y, &mo, &d, &h, &mi) != 5) return false;
  const size_t colon = t.find(':', t.find('T') + 4);
  if (colon == std::string::npos) return false;
  const double s = std::strtod(t.c_str() + colon + 1, nullptr);
  *out = static_cast<double>(days_from_civil(y, static_cast<unsigned>(mo), static_cast<unsigned>(d))) * 86400.0 + h * 3600.0 + mi * 60.0 + s;
  return true;
}

// ---- inputs ---------------------------------------------------------------------------------------------------------
struct Track { const plugin_input_frame_t* frame; double first = INFINITY, last = -INFINITY; };
bool read_tracks(std::vector<Track>* out, std::string* error) {
  for (const auto* f : frames("observations")) {
    flatbuffers::Verifier v(f->payload, f->payload_length);
    if (!TDMBufferHasIdentifier(f->payload) || !VerifyTDMBuffer(v)) return *error = "observations must be $TDM records", false;
    const TDM* tdm = GetTDM(f->payload);
    Track t{f};
    for (uint32_t i = 0; tdm->SEGMENTS() && i < tdm->SEGMENTS()->size(); ++i) {
      const TDMSegment* seg = tdm->SEGMENTS()->Get(i);
      for (uint32_t k = 0; seg && seg->OBSERVATIONS() && k < seg->OBSERVATIONS()->size(); ++k) {
        const TDMObservation* row = seg->OBSERVATIONS()->Get(k);
        if (text(row->KEYWORD()) != "ANGLE_1") continue;
        double e = 0;
        if (!parse_utc(text(row->EPOCH()), &e)) return *error = "an observation epoch does not read", false;
        t.first = std::min(t.first, e), t.last = std::max(t.last, e);
      }
    }
    if (std::isfinite(t.first)) out->push_back(t);
  }
  std::stable_sort(out->begin(), out->end(), [](const Track& a, const Track& b) { return a.first < b.first; });
  return true;
}
// Night index of each track (0-based) and each night's first epoch.
std::vector<int> nights_of(const std::vector<Track>& tracks, std::vector<double>* starts) {
  std::vector<int> night;
  double last = -INFINITY;
  for (const auto& t : tracks) {
    if (t.first - last > kNightGapHours * 3600.0) starts->push_back(t.first);
    night.push_back(static_cast<int>(starts->size()) - 1);
    last = std::max(last, t.last);
  }
  return night;
}

struct Orbit { double t = 0; double x[6] = {0}; bool converged = false; double wrms = NAN, stop = NAN; };
bool read_ocm(const plugin_input_frame_t* f, Orbit* o, std::string* error) {
  flatbuffers::Verifier v(f->payload, f->payload_length);
  if (!OCMBufferHasIdentifier(f->payload) || !VerifyOCMBuffer(v)) return *error = "an orbit is not a $OCM", false;
  const OCM* ocm = GetOCM(f->payload);
  if (!ocm->STATE_DATA() || ocm->STATE_DATA()->size() < 6 || !ocm->STATE_EPOCHS() || ocm->STATE_EPOCHS()->size() < 1 ||
      !parse_utc(ocm->STATE_EPOCHS()->Get(0)->str(), &o->t))
    return *error = "an orbit $OCM without a Cartesian state and its epoch", false;
  for (int i = 0; i < 6; ++i) o->x[i] = ocm->STATE_DATA()->Get(i);
  if (const auto* od = ocm->ORBIT_DETERMINATION()) {
    o->wrms = od->WEIGHTED_RMS();
    if (const auto* fs = od->FIT_STATISTICS()) {
      o->converged = fs->CONVERGED();
      if (!parse_utc(text(fs->FIT_STOP()), &o->stop)) o->stop = NAN;
    }
  }
  return true;
}
// Two-body mean motion of a GCRF state, rad/s.
double mean_motion(const double* x) {
  const double r = std::sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]), v2 = x[3] * x[3] + x[4] * x[4] + x[5] * x[5];
  const double inv_a = 2.0 / r - v2 / kMu;
  return inv_a > 0 ? std::sqrt(kMu * inv_a * inv_a * inv_a) : NAN;
}

struct Config {
  double offset_min = -1, offset_max = 1, wrms_limit = 2, minimum_arc_hours = 24;
};
bool read_config(Config* c, std::string* error) {
  const auto all = frames("config");
  if (all.empty()) return true;
  flatbuffers::Verifier v(all[0]->payload, all[0]->payload_length);
  if (!R::VerifyModuleConfigBuffer(v)) return *error = "config is not a ModuleConfig (MCFG)", false;
  const auto* entries = R::GetModuleConfig(all[0]->payload)->ENTRIES();
  for (uint32_t k = 0; entries && k < entries->size(); ++k) {
    const auto* e = entries->Get(k);
    const std::string key = text(e->KEY());
    double* target = key == "revolutionOffsetMin" ? &c->offset_min : key == "revolutionOffsetMax" ? &c->offset_max
                   : key == "weightedRmsLimit" ? &c->wrms_limit : key == "minimumArcHours" ? &c->minimum_arc_hours : nullptr;
    if (!target || e->KIND() != R::configValueKind_Number || !std::isfinite(e->NUMBER_VALUE()))
      return *error = "config key '" + key + "' is not one of revolutionOffsetMin, revolutionOffsetMax, weightedRmsLimit, minimumArcHours as a number", false;
    *target = e->NUMBER_VALUE();
  }
  if (c->offset_min > c->offset_max || c->offset_min != std::floor(c->offset_min) || c->offset_max != std::floor(c->offset_max))
    return *error = "revolutionOffsetMin and revolutionOffsetMax must be integers, min <= max", false;
  return true;
}

// The common reading of plan and select: the tracks, the nights, the initial orbit, the last stage.
struct State {
  Config config;
  std::vector<Track> tracks;
  std::vector<int> night;
  std::vector<double> night_start;
  Orbit initial, stage;
  bool have_stage = false;
  int completed = 0;  // nights the last stage covers
};
int read_state(State* s) {
  std::string error;
  if (!read_config(&s->config, &error)) return fail("bad-input", error);
  if (!read_tracks(&s->tracks, &error)) return fail("bad-input", error);
  if (s->tracks.empty()) return fail("bad-input", "observations hold no RA/Dec angles");
  s->night = nights_of(s->tracks, &s->night_start);
  double last = -INFINITY;
  for (const auto& t : s->tracks) last = std::max(last, t.last);
  const double arc = (last - s->tracks.front().first) / 3600.0;
  if (arc < s->config.minimum_arc_hours) {
    char code[48];
    std::snprintf(code, sizeof code, "arc-too-short:%.2f", arc);
    return fail(code, "the tracks span less than " + std::to_string(s->config.minimum_arc_hours) + " h");
  }
  const auto initial = frames("initial");
  if (initial.size() != 1) return fail("bad-input", "initial must be the one initial-orbit $OCM");
  if (!read_ocm(initial[0], &s->initial, &error)) return fail("bad-input", error);
  const auto stage = frames("stage");
  if (stage.size() > 1) return fail("bad-input", "stage holds at most one $OCM");
  if (!stage.empty()) {
    if (!read_ocm(stage[0], &s->stage, &error) || !std::isfinite(s->stage.stop)) return fail("bad-input", error.empty() ? "stage $OCM without FIT_STOP" : error);
    s->have_stage = true;
    for (double start : s->night_start) s->completed += start <= s->stage.stop ? 1 : 0;
  }
  return 0;
}
// Revolution offsets of stage `night` (1-based night count of the stage).
void offsets_of(const State& s, int nights, int* lo, int* hi) {
  if (nights == 2) *lo = static_cast<int>(s.config.offset_min), *hi = static_cast<int>(s.config.offset_max);
  else *lo = *hi = 0;
}

int push(const char* port, const char* schema, const char* id, const char* root, const uint8_t* data, size_t size) {
  return plugin_push_output_ex(port, schema, id, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0, data, static_cast<uint32_t>(size)) < 0 ? 1 : 0;
}
int report(const std::string& reason, uint64_t count, std::vector<std::string> items) {
  R::FlowNoticeT n;
  n.KIND = R::flowNoticeKind_Info;
  n.SCHEMA = "$OCM";
  n.SOURCE_NAME = "angles-only-od";
  n.COUNT = count;
  n.REASON = reason;
  n.ITEMS = std::move(items);
  flatbuffers::FlatBufferBuilder b(1024);
  R::FinishFlowNoticeBuffer(b, R::FlowNotice::Pack(b, &n));
  return push("report", "FlowNotice.fbs", R::FlowNoticeIdentifier(), "FlowNotice", b.GetBufferPointer(), b.GetSize());
}
std::string iso(double t) {
  const int64_t day = static_cast<int64_t>(std::floor(t / 86400.0));
  double sod = t - static_cast<double>(day) * 86400.0;
  int64_t z = day + 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  const unsigned d = doy - (153 * mp + 2) / 5 + 1, m = mp < 10 ? mp + 3 : mp - 9;
  const int y = static_cast<int>(yoe) + static_cast<int>(era) * 400 + (m <= 2);
  const int64_t ns = static_cast<int64_t>(std::llround(sod * 1e9));
  char out[48];
  std::snprintf(out, sizeof out, "%04d-%02u-%02uT%02lld:%02lld:%02lld.%09lldZ", y, m, d, static_cast<long long>(ns / 3600000000000LL),
                static_cast<long long>(ns / 60000000000LL % 60), static_cast<long long>(ns / 1000000000LL % 60), static_cast<long long>(ns % 1000000000LL));
  return out;
}

}  // namespace

extern "C" int plan(void) {
  State s;
  if (int rc = read_state(&s)) return rc;
  const int nights = static_cast<int>(s.night_start.size());
  const int target = s.have_stage ? s.completed + 1 : 1;
  if (target > nights) return report("complete", 0, {"every night fitted"});
  const auto exec_frames = frames("execution");
  if (exec_frames.size() != 1) return fail("bad-input", "execution must be one $PRW EXECUTION_REQUEST");
  const auto* f = exec_frames[0];
  const bool prefixed = f->payload_length >= 12 && flatbuffers::BufferHasIdentifier(f->payload, PRWIdentifier(), true);
  flatbuffers::Verifier v(f->payload, f->payload_length);
  if (!(prefixed ? VerifySizePrefixedPRWBuffer(v) : (PRWBufferHasIdentifier(f->payload) && VerifyPRWBuffer(v))))
    return fail("bad-input", "execution must be a $PRW");
  const PRW* prw = prefixed ? GetSizePrefixedPRW(f->payload) : GetPRW(f->payload);
  if (!prw->EXECUTION_REQUEST() || !prw->EXECUTION_REQUEST()->INITIAL() || !prw->EXECUTION_REQUEST()->INITIAL()->STATE())
    return fail("bad-input", "execution must be a $PRW EXECUTION_REQUEST with INITIAL (the object and its coordinate system)");

  const Orbit& base = s.have_stage ? s.stage : s.initial;
  int lo = 0, hi = 0;
  offsets_of(s, target, &lo, &hi);
  const double dt = s.night_start[target - 1] - base.t;
  std::vector<std::string> items{"stage " + std::to_string(target) + " of " + std::to_string(nights) + " nights", "epoch " + iso(s.initial.t)};
  for (int k = lo; k <= hi; ++k) {
    double x[6];
    std::copy(base.x, base.x + 6, x);
    if (k != 0) {
      const double n = mean_motion(base.x), n2 = n + 2.0 * M_PI * k / dt;
      if (!(n2 > 0)) return fail("bad-input", "a revolution offset gives no bound orbit");
      const double a2 = std::cbrt(kMu / (n2 * n2)), r = std::sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
      const double v = std::sqrt(x[3] * x[3] + x[4] * x[4] + x[5] * x[5]), v2 = std::sqrt(kMu * (2.0 / r - 1.0 / a2));
      for (int i = 3; i < 6; ++i) x[i] *= v2 / v;
    }
    std::unique_ptr<PRWT> root(prw->UnPack());
    auto& exec = *root->EXECUTION_REQUEST;
    auto& st = *exec.INITIAL->STATE;
    st.POSITION = std::make_unique<FRMVector3T>();
    st.VELOCITY = std::make_unique<FRMVector3T>();
    st.POSITION->X = x[0] * 1000, st.POSITION->Y = x[1] * 1000, st.POSITION->Z = x[2] * 1000;
    st.VELOCITY->X = x[3] * 1000, st.VELOCITY->Y = x[4] * 1000, st.VELOCITY->Z = x[5] * 1000;
    st.EPOCH = iso(base.t);
    st.EPOCH_TIME_SYSTEM = "UTC";
    exec.TARGET_EPOCH = std::make_unique<TIMInstantT>();
    exec.TARGET_EPOCH->TIME_SYSTEM = timingStandard::UTC;
    exec.TARGET_EPOCH->EPOCH_FORMAT = timEpochRepresentation::ISO8601;
    exec.TARGET_EPOCH->ISO8601 = iso(s.initial.t);
    flatbuffers::FlatBufferBuilder b(1 << 14);
    FinishSizePrefixedPRWBuffer(b, PRW::Pack(b, root.get()));
    if (push("execution", "PRW.fbs", "$PRW", "PRW", b.GetBufferPointer(), b.GetSize())) return 1;
    items.push_back("candidate revolution offset " + std::to_string(k));
  }
  for (size_t i = 0; i < s.tracks.size(); ++i)
    if (s.night[i] < target && push("observations", "TDM.fbs", "$TDM", "TDM", s.tracks[i].frame->payload, s.tracks[i].frame->payload_length)) return 1;
  return report("stage-planned", static_cast<uint64_t>(hi - lo + 1), items);
}

extern "C" int select(void) {
  State s;
  if (int rc = read_state(&s)) return rc;
  const int nights = static_cast<int>(s.night_start.size());
  const int target = s.have_stage ? s.completed + 1 : 1;
  if (target > nights) return fail("bad-input", "every night is already fitted");
  int lo = 0, hi = 0;
  offsets_of(s, target, &lo, &hi);
  const Orbit& base = s.have_stage ? s.stage : s.initial;
  const double dt = s.night_start[target - 1] - base.t, n1 = mean_motion(base.x);
  const plugin_input_frame_t* best = nullptr;
  double best_wrms = INFINITY;
  int best_k = 0;
  std::vector<std::string> items{"stage " + std::to_string(target) + " of " + std::to_string(nights) + " nights"};
  for (const auto* f : frames("candidates")) {
    Orbit o;
    std::string error;
    if (!read_ocm(f, &o, &error)) return fail("bad-input", error);
    const int k = target == 1 ? 0 : static_cast<int>(std::lround((mean_motion(o.x) - n1) * dt / (2.0 * M_PI)));
    char line[160];
    std::snprintf(line, sizeof line, "candidate: converged %d, WEIGHTED_RMS %.4f, revolution offset %d", o.converged ? 1 : 0, o.wrms, k);
    items.push_back(line);
    if (!o.converged || !(o.wrms <= s.config.wrms_limit) || k < lo || k > hi) continue;
    if (o.wrms < best_wrms) best = f, best_wrms = o.wrms, best_k = k;
  }
  if (!best) {
    char message[200];
    std::snprintf(message, sizeof message, "stage %d: no candidate with revolution offset in [%d, %d] converged with WEIGHTED_RMS at most %g",
                  target, lo, hi, s.config.wrms_limit);
    return fail("no-converged-revolution-count", message);
  }
  if (push("selected", "OCM.fbs", "$OCM", "OCM", best->payload, best->payload_length)) return 1;
  items.push_back("selected revolution offset " + std::to_string(best_k));
  return report(target == nights ? "complete" : "stage-selected", static_cast<uint64_t>(target), items);
}
