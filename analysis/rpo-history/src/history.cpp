// analysis/rpo-history: the relative-motion history, its maneuver brackets,
// the conditional coast projection and its hindcast.
//
// Per sample time t (the grid): each object's state comes from ITS element
// set in force at t (the latest epoch <= t), never interpolated or smoothed
// across an element update. A segment is a run of grid samples with the same
// pair of sets; a new set of either object starts a new segment. Inside a
// maneuver bracket of either object the pre-maneuver set would be propagated
// across the burn, so those samples are left out (the bracket is shown, not
// propagated through).
//
// Geometry (the RIC box's definitions, foundation/frames/include/
// rtn_curvilinear.hpp): the target is the reference. Rectilinear RIC is the
// chaser's state in the target's RTN axes from the inertial states;
// curvilinear RIC is (radius difference, r0 x in-plane angle wrapped to
// +-pi, r0 x out-of-plane angle), r0 = |r_target|; in-track is also given
// unwrapped within each segment. Separation and range rate are |dr| and
// dr.dv/|dr| (inertial), the orbital-plane angle is the angle between the two
// orbit normals, and the relative orbital elements are D'Amico's
// (src/elements.cpp), all from osculating two-body quantities of the states.
namespace {

using sdn_frames::curvilinearFromRectilinear;
using sdn_frames::curvilinearJacobian;
using sdn_frames::relativeStateRic;
using sdn_frames::ricBasis;

struct Sample {
  double t = 0;
  int ic = -1, it = -1;  // the chaser's and the target's sets
  State rel{};           // chaser in the target's rotating RIC frame, km and km/s
  double r0 = 0;         // |r_target|, km
  double R = 0, I = 0, C = 0, Iunwrapped = 0;  // curvilinear, km
  double separation = 0, rangeRate = 0, planeDeg = 0;
  Roe roe;
  // Projection only: 1-sigma of R, I, C and separation and the 3-sigma band
  // half-widths of R, I, C (km), and the 1-sigma relative position
  // covariance in the target's RTN (km^2).
  double sR = kNaN, sI = kNaN, sC = kNaN, sSep = kNaN, b3R = kNaN, b3I = kNaN, b3C = kNaN;
  Mat3 covRel{};
  bool hasCov = false;
};

struct Segment {
  bool projection = false;
  int ic = -1, it = -1;
  std::vector<Sample> samples;
};

// Basis rows (R, I, C) of an inertial state as a row-major 3x3: x_ric = B x.
bool basisOf(const State& s, Mat3& b) {
  double r[3] = {s[0], s[1], s[2]}, v[3] = {s[3], s[4], s[5]}, basis[9];
  if (!ricBasis(r, v, basis)) return false;
  for (int i = 0; i < 9; ++i) b[size_t(i)] = basis[i];
  return true;
}

bool geometry(double t, const State& chaser, const State& target, Sample& out) {
  double rel[6];
  const double rt[3] = {target[0], target[1], target[2]}, vt[3] = {target[3], target[4], target[5]};
  const double rc[3] = {chaser[0], chaser[1], chaser[2]}, vc[3] = {chaser[3], chaser[4], chaser[5]};
  if (!relativeStateRic(rt, vt, rc, vc, rel)) return false;
  out.t = t;
  for (int k = 0; k < 6; ++k) out.rel[size_t(k)] = rel[k];
  out.r0 = norm(posOf(target));
  double curv[3];
  if (!curvilinearFromRectilinear(out.r0, rel, curv)) return false;
  out.R = curv[0];
  out.I = curv[1];
  out.C = curv[2];
  out.Iunwrapped = curv[1];
  const Vec3 dr = sub(posOf(chaser), posOf(target)), dv = sub(velOf(chaser), velOf(target));
  out.separation = norm(dr);
  out.rangeRate = out.separation > 0 ? dot(dr, dv) / out.separation : 0.0;
  const Osculating oc = osculating(posOf(chaser), velOf(chaser)), ot = osculating(posOf(target), velOf(target));
  out.planeDeg = oc.ok && ot.ok ? planeAngle(oc.h, ot.h) * kDeg : kNaN;
  out.roe = relativeElements(ot, oc);
  return true;
}

// ── maneuver brackets ─────────────────────────────────────────────────────
// A detected maneuver lies between two element sets of its object. Its
// bracket runs from the epoch of the set before to the epoch of the set
// after: the $MNV's SOURCED_DATA names them ("EPOCH <iso> ...", as
// analysis/maneuver-detection writes them), else they are the object's sets
// around EVENT_START_TIME .. EVENT_END_TIME. Canceled, planned and predicted
// maneuvers do not bracket anything.
bool loadBrackets(const std::vector<const MNV*>& maneuvers, Object& chaser, Object& target, size_t& used, size_t& ignored) {
  used = ignored = 0;
  for (const MNV* m : maneuvers) {
    const maneuverStatus st = m->STATUS();
    if (st == maneuverStatus::CANCELLED || st == maneuverStatus::PLANNED || st == maneuverStatus::PREDICTED) {  // us-spelling-ok: SDS enum
      ++ignored;
      continue;
    }
    const uint32_t norad = m->SAT_NO();
    const std::string id = textOf(m->ORIG_OBJECT_ID());
    Object* o = nullptr;
    for (Object* x : {&chaser, &target})
      if ((norad && norad == x->norad) || (!norad && !id.empty() && id == x->objectId)) o = x;
    if (!o) { ++ignored; continue; }
    double te, te2;
    if (!parseIso(m->EVENT_START_TIME(), te)) return failWith("A $MNV has no valid EVENT_START_TIME.");
    if (!parseIso(m->EVENT_END_TIME(), te2) || te2 < te) te2 = te;
    std::vector<double> named;
    if (m->SOURCED_DATA())
      for (const auto* s : *m->SOURCED_DATA()) {
        double e;
        if (s && s->str().rfind("EPOCH ", 0) == 0 && parseIso(s->str().substr(6, 24).c_str(), e)) named.push_back(e);
      }
    double from = te, to = te2;
    if (named.size() >= 2) {
      from = std::min(from, *std::min_element(named.begin(), named.end()));
      to = std::max(to, *std::max_element(named.begin(), named.end()));
    } else {
      for (const ElementSet& s : o->sets) if (s.epoch < te) from = s.epoch;
      for (auto it = o->sets.rbegin(); it != o->sets.rend(); ++it) if (it->epoch >= te2) to = it->epoch;
    }
    o->brackets.push_back({from, to});
    o->bracketIds.push_back(textOf(m->ID()));
    ++used;
  }
  return true;
}

// ── the history ─────────────────────────────────────────────────────────────
struct Counts {
  size_t gridSamples = 0, inBracket = 0, noSet = 0, unsupported = 0;
};

bool stateOf(const Object& o, int k, double t, State& s) {
  return k >= 0 && sampleAt(o.sets[size_t(k)].traj, t, s);
}

void unwrapInTrack(Segment& seg) {
  double turns = 0, previous = kNaN;
  for (Sample& s : seg.samples) {
    const double theta = s.I / s.r0;
    if (std::isfinite(previous)) {
      if (theta - previous > kPi) turns -= 1;
      else if (theta - previous < -kPi) turns += 1;
    }
    previous = theta;
    s.Iunwrapped = s.r0 * (theta + kTwoPi * turns);
  }
}

std::vector<Segment> history(const Object& chaser, const Object& target, const Window& w, Counts& counts) {
  std::vector<Segment> out;
  double lastT = kNaN;
  for (double t = w.gridCeil(w.start); t <= w.stop + 1e-6; t += w.step) {
    ++counts.gridSamples;
    const int ic = chaser.active(t), it = target.active(t);
    if (ic < 0 || it < 0) { ++counts.noSet; continue; }
    if (chaser.inBracket(t) || target.inBracket(t)) { ++counts.inBracket; continue; }
    State sc, st;
    Sample s;
    if (!stateOf(chaser, ic, t, sc) || !stateOf(target, it, t, st) || !geometry(t, sc, st, s)) { ++counts.unsupported; continue; }
    s.ic = ic;
    s.it = it;
    const bool contiguous = !out.empty() && out.back().ic == ic && out.back().it == it && std::fabs(t - lastT - w.step) < 1e-6;
    if (!contiguous) {
      Segment seg;
      seg.ic = ic;
      seg.it = it;
      out.push_back(seg);
    }
    out.back().samples.push_back(s);
    lastT = t;
    if (counts.gridSamples > kMaxSamples) break;
  }
  for (Segment& seg : out) unwrapInTrack(seg);
  return out;
}
}  // namespace
