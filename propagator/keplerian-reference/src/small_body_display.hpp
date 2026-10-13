// propagator/keplerian-reference — the small-body layer's display decisions.
//
// OrbPro's SmallBodyLayer draws every row of a small-body catalog from two
// snapshots mixed on the GPU. When the next snapshot is asked for, for which
// epoch, how far the GPU mixes between the two, how the layer fades in with
// the camera's distance, and the size a promoted asteroid is drawn at are
// computed here (owner 2026-10-13: every computation in WASM; JS only moves
// values). Appended to keplerian_reference_module.cpp by build.js.
//
// INTERNAL LAYOUT, NOT A STANDARD: the engine writes the doubles of `in` and
// reads those of `out` (index constants mirrored in OrbPro's
// Scene/SmallBodySnapshots.js). No SDS schema describes engine-module buffers.

namespace small_display {

enum FadeIn : int {
  FI_ET = 0, FI_WALL = 1, FI_LAST_WALL = 2, FI_LAST_ET = 3, FI_RATE = 4, FI_CAMERA = 5, /* 3 */
  FI_FADE_NEAR = 8, FI_FADE_FAR = 9,
};
enum FadeOut : int { FO_RATE = 0, FO_FADE = 1 };

enum ScheduleIn : int {
  SI_ET = 0, SI_RATE = 1, SI_T_OLDER = 2, SI_T_NEWER = 3, SI_SAME_SLOT = 4, SI_HAS_SNAPSHOT = 5,
  SI_MAX_SPAN = 6, SI_MIN_SPAN = 7, SI_INTERVAL = 8, SI_BUSY = 9, SI_ROWS_CHANGED = 10,
  SI_OBSERVER_VALID = 11, SI_OBSERVER = 12, /* 3 */ SI_SNAPSHOT_OBSERVER_VALID = 15,
  SI_SNAPSHOT_OBSERVER = 16, /* 3 */ SI_VALIDITY_VALID = 19, SI_VALIDITY_START = 20, SI_VALIDITY_STOP = 21,
};
enum ScheduleOut : int { SO_MIX = 0, SO_REQUEST = 1, SO_TARGET = 2, SO_JUMP = 3 };

/* The observer moving this far (m) since the last snapshot asks for a new one
 * at once: the light-time and aberration shifts are the observer's. */
constexpr double kObserverMovedFar = 1.0e9;

inline double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

inline double smoothstep(double e0, double e1, double x) {
  const double t = clampd((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/* The clock rate seen by the layer (a running mean, simulated seconds per
 * wall second) and its fade with the camera's distance from the central body. */
inline void fadeAndRate(const double* in, double* out) {
  const double* c = in + FI_CAMERA;
  const double distance = std::sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
  out[FO_FADE] = smoothstep(std::log10(in[FI_FADE_NEAR]), std::log10(in[FI_FADE_FAR]),
                            std::log10(std::max(distance, 1.0)));
  double rate = in[FI_RATE];
  const double wall = in[FI_WALL], lastWall = in[FI_LAST_WALL];
  if (std::isfinite(lastWall) && wall > lastWall) {
    const double r = (in[FI_ET] - in[FI_LAST_ET]) / (wall - lastWall);
    rate = std::isfinite(r) ? 0.8 * rate + 0.2 * r : 1.0;
  }
  out[FO_RATE] = rate;
}

/* The GPU mix between the older and newer snapshots, and whether (and for
 * which epoch) the next snapshot is asked for. */
inline void schedule(const double* in, double* out) {
  const double et = in[SI_ET];
  const double tOlder = in[SI_T_OLDER], tNewer = in[SI_T_NEWER];
  const bool hasSnapshot = in[SI_HAS_SNAPSHOT] != 0.0, same = in[SI_SAME_SLOT] != 0.0;
  double mix = 1.0;
  if (hasSnapshot && !same && tOlder != tNewer && std::fabs(tNewer - tOlder) <= in[SI_MAX_SPAN]) {
    mix = clampd((et - tOlder) / (tNewer - tOlder), 0.0, 1.0);
  }
  out[SO_MIX] = mix;
  out[SO_REQUEST] = 0.0;
  out[SO_JUMP] = 0.0;
  if (in[SI_BUSY] != 0.0) return;
  /* a couple of wall seconds of animation, never so long that the straight
   * mix leaves the orbit, never shorter than ten minutes */
  const double rate = in[SI_RATE];
  const double span = clampd(std::fabs(rate) * in[SI_INTERVAL], in[SI_MIN_SPAN], in[SI_MAX_SPAN]);
  const double direction = rate < 0.0 ? -1.0 : 1.0;
  bool observerMoved = false;
  if (in[SI_OBSERVER_VALID] != 0.0 && in[SI_SNAPSHOT_OBSERVER_VALID] != 0.0) {
    const double* a = in + SI_OBSERVER;
    const double* b = in + SI_SNAPSHOT_OBSERVER;
    const double d[3] = {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
    observerMoved = std::sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) > kObserverMovedFar;
  }
  double target;
  bool jump = false;
  if (!hasSnapshot || in[SI_ROWS_CHANGED] != 0.0 || observerMoved || !std::isfinite(tOlder) ||
      !std::isfinite(tNewer)) {
    target = et;
    jump = true;
  } else {
    const double lo = std::min(tOlder, tNewer), hi = std::max(tOlder, tNewer);
    if (et < lo - 0.5 * span || et > hi + 0.5 * span) {
      target = et; /* the clock jumped (or ran faster than snapshots arrive) */
      jump = true;
    } else if (same || direction * (et - tNewer) > -0.5 * span) {
      target = tNewer + direction * span; /* the next one is one spacing ahead */
    } else {
      return;
    }
  }
  /* never past the rows' validity span: a snapshot there is all NaN */
  const double v0 = in[SI_VALIDITY_START], v1 = in[SI_VALIDITY_STOP];
  if (in[SI_VALIDITY_VALID] != 0.0 && v0 <= v1 && et >= v0 && et <= v1) {
    target = clampd(target, v0, v1);
    if (!jump && target == tNewer) return;
  }
  if (!std::isfinite(target)) return;
  out[SO_REQUEST] = 1.0;
  out[SO_TARGET] = target;
  out[SO_JUMP] = jump ? 1.0 : 0.0;
}

}  // namespace small_display

ORBPRO_ABI_EXPORT("kepler_small_fade_rate")
void kepler_small_fade_rate(const double* in, double* out) { small_display::fadeAndRate(in, out); }

ORBPRO_ABI_EXPORT("kepler_small_schedule")
void kepler_small_schedule(const double* in, double* out) { small_display::schedule(in, out); }

/// The radius (m) a promoted asteroid is drawn with: half its catalog
/// diameter (km), else half the diameter from H at the albedo, else 1 km
/// across; never under 10 m.
ORBPRO_ABI_EXPORT("kepler_small_display_radius")
double kepler_small_display_radius(double diameter_km, double h, double albedo) {
  const bool fromCatalog = std::isfinite(diameter_km) && diameter_km > 0.0;
  const double diameter = fromCatalog ? diameter_km * 1000.0 : kepler_small_diameter_from_h(h, albedo);
  return std::max(0.5 * (std::isfinite(diameter) ? diameter : 1000.0), 10.0);
}
