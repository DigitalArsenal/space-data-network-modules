// flows/angles-only-od: the angles-only orbit determination's planning node. No element set enters on any port: the
// first guess is analysis/optical-astrometry initial_orbit's Gooding state on the arc's tracks; every fit is
// flows/observation-od `step` (analysis/estimation fit_batch with propagator/ffm), run by the host to its end per candidate.
//
//   plan    observations ($TDM RA/Dec tracks), initial (the initial-orbit $OCM), execution ($PRW EXECUTION_REQUEST: the
//           dynamics; INITIAL carries the object and its coordinate system), stage (the $OCM selected for the last
//           completed stage; absent for the first), config
//           -> execution (one $PRW per candidate: the seed in INITIAL, the estimate's epoch, the initial orbit's, in
//           TARGET_EPOCH), observations (the stage's tracks), report (FlowNotice: the stage, its candidates)
//   select  observations, initial, stage (as for plan), candidates (the step $OCMs of the stage's candidates, any
//           number; a refused candidate sends none), executions (each candidate's $PRW from plan, the same order), config
//           -> selected (the stage's $OCM), report (FlowNotice: REASON stage-selected or complete)
//
// Nights are the tracks between gaps over 6 h. Stage 1 fits the nights the initial orbit's sights span (its START_TIME
// to STOP_TIME); each later stage adds the unfitted night nearest the fitted ones (FIT_START to FIT_STOP). The first
// stage that spans a nightly gap before any fit has spanned one sets the revolution count over it from a candidate set:
// its base state (the initial orbit, or the last stage's state) moved by k revolutions, its two-body mean motion
// n_k = n + 2 pi k / dt (dt from the base epoch to the stage's farthest observation; the speed set by vis-viva, the
// position and the velocity's direction kept), k in [revolutionOffsetMin, revolutionOffsetMax] (default -1..1). Other
// stages carry the last stage's state (one candidate). A candidate counts when its fit converged, its WEIGHTED_RMS is at
// most weightedRmsLimit (default 2) and it kept its revolution count (|n - n_seed| dt / 2 pi < 0.5). The lowest
// WEIGHTED_RMS wins; none: no-converged-revolution-count. An arc under minimumArcHours (24): arc-too-short:<hours>.
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
// Night index of each track (0-based) and each night's span.
struct Night { double first = INFINITY, last = -INFINITY; };
std::vector<int> nights_of(const std::vector<Track>& tracks, std::vector<Night>* nights) {
  std::vector<int> night;
  double last = -INFINITY;
  for (const auto& t : tracks) {
    if (t.first - last > kNightGapHours * 3600.0) nights->push_back({});
    night.push_back(static_cast<int>(nights->size()) - 1);
    nights->back().first = std::min(nights->back().first, t.first);
    nights->back().last = std::max(nights->back().last, t.last);
    last = std::max(last, t.last);
  }
  return night;
}

struct Orbit { double t = 0; double x[6] = {0}; bool converged = false; double wrms = NAN, start = NAN, stop = NAN; };
bool read_ocm(const plugin_input_frame_t* f, Orbit* o, std::string* error) {
  flatbuffers::Verifier v(f->payload, f->payload_length);
  if (!OCMBufferHasIdentifier(f->payload) || !VerifyOCMBuffer(v)) return *error = "an orbit is not a $OCM", false;
  const OCM* ocm = GetOCM(f->payload);
  if (!ocm->STATE_DATA() || ocm->STATE_DATA()->size() < 6 || !ocm->STATE_EPOCHS() || ocm->STATE_EPOCHS()->size() < 1 ||
      !parse_utc(ocm->STATE_EPOCHS()->Get(0)->str(), &o->t))
    return *error = "an orbit $OCM without a Cartesian state and its epoch", false;
  for (int i = 0; i < 6; ++i) o->x[i] = ocm->STATE_DATA()->Get(i);
  // The span of the observations behind it: a fit's FIT_START to FIT_STOP, an initial orbit's START_TIME to STOP_TIME.
  if (const auto* m = ocm->METADATA()) {
    if (!parse_utc(text(m->START_TIME()), &o->start)) o->start = NAN;
    if (!parse_utc(text(m->STOP_TIME()), &o->stop)) o->stop = NAN;
  }
  if (const auto* od = ocm->ORBIT_DETERMINATION()) {
    o->wrms = od->WEIGHTED_RMS();
    if (const auto* fs = od->FIT_STATISTICS()) {
      o->converged = fs->CONVERGED();
      if (!parse_utc(text(fs->FIT_START()), &o->start)) o->start = NAN;
      if (!parse_utc(text(fs->FIT_STOP()), &o->stop)) o->stop = NAN;
    }
  }
  return true;
}
// A seed state from a $PRW EXECUTION_REQUEST's INITIAL (m, m/s -> km, km/s).
bool read_seed(const plugin_input_frame_t* f, Orbit* o, std::string* error) {
  const bool prefixed = f->payload_length >= 12 && flatbuffers::BufferHasIdentifier(f->payload, PRWIdentifier(), true);
  flatbuffers::Verifier v(f->payload, f->payload_length);
  if (!(prefixed ? VerifySizePrefixedPRWBuffer(v) : (PRWBufferHasIdentifier(f->payload) && VerifyPRWBuffer(v)))) return *error = "an execution is not a $PRW", false;
  const PRW* prw = prefixed ? GetSizePrefixedPRW(f->payload) : GetPRW(f->payload);
  const auto* ex = prw->EXECUTION_REQUEST();
  const auto* st = ex && ex->INITIAL() ? ex->INITIAL()->STATE() : nullptr;
  if (!st || !st->POSITION() || !st->VELOCITY() || !parse_utc(text(st->EPOCH()), &o->t)) return *error = "an execution without its INITIAL state and epoch", false;
  const double x[6] = {st->POSITION()->X(), st->POSITION()->Y(), st->POSITION()->Z(), st->VELOCITY()->X(), st->VELOCITY()->Y(), st->VELOCITY()->Z()};
  for (int i = 0; i < 6; ++i) o->x[i] = x[i] / 1000.0;
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

// The common reading of plan and select: the tracks, the nights, the initial orbit, the last stage, and the stage to
// fit next (its nights, its base state, whether it sets a revolution count).
struct State {
  Config config;
  std::vector<Track> tracks;
  std::vector<int> night;
  std::vector<Night> nights;
  Orbit initial, stage;
  bool have_stage = false;
  std::vector<char> covered, target;  // per night: fitted by the last stage; fitted by the next
  int fitted = 0, planned = 0;        // nights in covered and in target
  bool counting = false;              // the next stage sets the revolution count over a nightly gap
  double dt = 0;                      // base epoch to the next stage's farthest observation, s
};
std::vector<char> nights_over(const State& s, double from, double to) {
  std::vector<char> in(s.nights.size(), 0);
  for (size_t k = 0; k < s.nights.size(); ++k) in[k] = s.nights[k].last >= from && s.nights[k].first <= to;
  return in;
}
int read_state(State* s) {
  std::string error;
  if (!read_config(&s->config, &error)) return fail("bad-input", error);
  if (!read_tracks(&s->tracks, &error)) return fail("bad-input", error);
  if (s->tracks.empty()) return fail("bad-input", "observations hold no RA/Dec angles");
  s->night = nights_of(s->tracks, &s->nights);
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
  if (!std::isfinite(s->initial.start) || !std::isfinite(s->initial.stop)) return fail("bad-input", "the initial orbit $OCM without START_TIME and STOP_TIME");
  const auto stage = frames("stage");
  if (stage.size() > 1) return fail("bad-input", "stage holds at most one $OCM");
  if (!stage.empty()) {
    if (!read_ocm(stage[0], &s->stage, &error)) return fail("bad-input", error);
    if (!std::isfinite(s->stage.start) || !std::isfinite(s->stage.stop)) return fail("bad-input", "stage $OCM without FIT_START and FIT_STOP");
    s->have_stage = true;
  }
  // The next stage: the initial orbit's nights; after a stage, its nights and the unfitted night nearest them.
  const Orbit& base = s->have_stage ? s->stage : s->initial;
  s->covered = s->have_stage ? nights_over(*s, base.start, base.stop) : std::vector<char>(s->nights.size(), 0);
  s->target = s->have_stage ? s->covered : nights_over(*s, base.start, base.stop);
  for (char c : s->covered) s->fitted += c;
  if (s->have_stage) {
    int nearest = -1;
    double gap = INFINITY;
    for (size_t k = 0; k < s->nights.size(); ++k) {
      if (s->covered[k]) continue;
      const double g = std::max({0.0, s->nights[k].first - base.stop, base.start - s->nights[k].last});
      if (g < gap) gap = g, nearest = static_cast<int>(k);
    }
    if (nearest >= 0) s->target[nearest] = 1;
  }
  for (char c : s->target) s->planned += c;
  s->counting = s->planned >= 2 && s->fitted < 2;
  for (size_t i = 0; i < s->tracks.size(); ++i)
    if (s->target[s->night[i]])
      for (double t : {s->tracks[i].first, s->tracks[i].last}) if (std::fabs(t - base.t) > std::fabs(s->dt)) s->dt = t - base.t;
  return 0;
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

// The night numbers (1-based) of a set, for the report.
std::string night_list(const std::vector<char>& in) {
  std::string out;
  for (size_t k = 0; k < in.size(); ++k) if (in[k]) out += (out.empty() ? "" : ",") + std::to_string(k + 1);
  return out;
}

extern "C" int plan(void) {
  State s;
  if (int rc = read_state(&s)) return rc;
  const int nights = static_cast<int>(s.nights.size());
  if (s.have_stage && s.fitted == nights) return report("complete", 0, {"every night fitted"});
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
  std::vector<std::string> items{"stage nights " + night_list(s.target) + " of " + std::to_string(nights), "epoch " + iso(s.initial.t)};
  std::vector<Orbit> seeds;
  const double n = mean_motion(base.x);
  if (s.counting && std::isfinite(n)) {
    char line[160];
    std::snprintf(line, sizeof line, "revolutions over %.1f h from the base: %.3f", s.dt / 3600.0, n * s.dt / (2.0 * M_PI));
    items.push_back(line);
    const double r = std::sqrt(base.x[0] * base.x[0] + base.x[1] * base.x[1] + base.x[2] * base.x[2]);
    const double v = std::sqrt(base.x[3] * base.x[3] + base.x[4] * base.x[4] + base.x[5] * base.x[5]);
    for (int k = static_cast<int>(s.config.offset_min); k <= static_cast<int>(s.config.offset_max); ++k) {
      const double nk = n + 2.0 * M_PI * k / s.dt, ak = std::cbrt(kMu / (nk * nk)), vis = 2.0 / r - 1.0 / ak;
      if (!(nk > 0) || !(vis > 0)) continue;
      Orbit o = base;
      for (int i = 3; i < 6; ++i) o.x[i] = base.x[i] * std::sqrt(kMu * vis) / v;
      seeds.push_back(o);
      items.push_back("candidate revolution offset " + std::to_string(k));
    }
  } else {
    seeds.push_back(base);
  }
  for (const Orbit& seed : seeds) {
    std::unique_ptr<PRWT> root(prw->UnPack());
    auto& exec = *root->EXECUTION_REQUEST;
    auto& st = *exec.INITIAL->STATE;
    st.POSITION = std::make_unique<FRMVector3T>();
    st.VELOCITY = std::make_unique<FRMVector3T>();
    st.POSITION->X = seed.x[0] * 1000, st.POSITION->Y = seed.x[1] * 1000, st.POSITION->Z = seed.x[2] * 1000;
    st.VELOCITY->X = seed.x[3] * 1000, st.VELOCITY->Y = seed.x[4] * 1000, st.VELOCITY->Z = seed.x[5] * 1000;
    st.EPOCH = iso(seed.t);
    st.EPOCH_TIME_SYSTEM = "UTC";
    exec.TARGET_EPOCH = std::make_unique<TIMInstantT>();
    exec.TARGET_EPOCH->TIME_SYSTEM = timingStandard::UTC;
    exec.TARGET_EPOCH->EPOCH_FORMAT = timEpochRepresentation::ISO8601;
    exec.TARGET_EPOCH->ISO8601 = iso(s.initial.t);
    flatbuffers::FlatBufferBuilder b(1 << 14);
    FinishSizePrefixedPRWBuffer(b, PRW::Pack(b, root.get()));
    if (push("execution", "PRW.fbs", "$PRW", "PRW", b.GetBufferPointer(), b.GetSize())) return 1;
  }
  for (size_t i = 0; i < s.tracks.size(); ++i)
    if (s.target[s.night[i]] && push("observations", "TDM.fbs", "$TDM", "TDM", s.tracks[i].frame->payload, s.tracks[i].frame->payload_length)) return 1;
  return report("stage-planned", static_cast<uint64_t>(seeds.size()), items);
}

extern "C" int select(void) {
  State s;
  if (int rc = read_state(&s)) return rc;
  const int nights = static_cast<int>(s.nights.size());
  if (s.have_stage && s.fitted == nights) return fail("bad-input", "every night is already fitted");
  const auto candidates = frames("candidates"), executions = frames("executions");
  if (executions.size() != candidates.size()) return fail("bad-input", "each candidate needs its $PRW execution on executions, in the same order");
  const plugin_input_frame_t* best = nullptr;
  double best_wrms = INFINITY;
  std::vector<std::string> items{"stage nights " + night_list(s.target) + " of " + std::to_string(nights)};
  for (size_t c = 0; c < candidates.size(); ++c) {
    Orbit o, seed;
    std::string error;
    if (!read_ocm(candidates[c], &o, &error) || !read_seed(executions[c], &seed, &error)) return fail("bad-input", error);
    const double drift = (mean_motion(o.x) - mean_motion(seed.x)) * s.dt / (2.0 * M_PI);  // revolutions the fit moved from its seed's count
    char line[160];
    std::snprintf(line, sizeof line, "candidate %zu: converged %d, WEIGHTED_RMS %.4f, revolution drift %.3f", c + 1, o.converged ? 1 : 0, o.wrms, drift);
    items.push_back(line);
    if (!o.converged || !(o.wrms <= s.config.wrms_limit) || !(std::fabs(drift) < 0.5)) continue;
    if (o.wrms < best_wrms) best = candidates[c], best_wrms = o.wrms;
  }
  if (!best) {
    char message[200];
    std::snprintf(message, sizeof message, "stage nights %s: no candidate kept its revolution count and converged with WEIGHTED_RMS at most %g (%zu candidates)",
                  night_list(s.target).c_str(), s.config.wrms_limit, candidates.size());
    return fail("no-converged-revolution-count", message);
  }
  if (push("selected", "OCM.fbs", "$OCM", "OCM", best->payload, best->payload_length)) return 1;
  return report(s.planned == nights ? "complete" : "stage-selected", static_cast<uint64_t>(s.planned), items);
}
