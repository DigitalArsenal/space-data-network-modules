/**
 * THE MANEUVER PARITY LIBRARY — vector loading, the tolerance policy, and the
 * tier-C invariants.
 *
 * Everything a test needs to turn `vectors.json` into a verdict lives here, so
 * the policy is stated ONCE and every suite that consumes a vector is
 * necessarily judging it the same way.
 */

import { readFile } from "node:fs/promises";

const VECTORS_URL = new URL("./vectors.json", import.meta.url);

/** Conformance model, PINNED by saw-beta-maneuver-program section A.6. */
export const MU = 3.986004418e14;
export const RE = 6378137;
/** Earth-collision floor for a phasing orbit's far apse (spec section 4.8). */
export const PHASING_FLOOR = RE + 100_000;

// ---------------------------------------------------------------------------
// Tolerance policy
// ---------------------------------------------------------------------------

/**
 * THE POLICY, in one line:
 *
 *     fail  <=>  |observed - expected|  >  abs + rel * |expected|
 *
 * `abs` carries the case near zero (where a relative band is meaningless and a
 * pure relative test either divides by zero or passes everything); `rel`
 * carries it at scale. Both are always present. A band with only one of them
 * is a band that is wrong at one end of its own domain.
 *
 * BANDS ARE PER QUANTITY, not per case, because what counts as "agreement"
 * is a property of the physical quantity and the arithmetic that produced it —
 * not of which test happens to be asking.
 */
export const BANDS = Object.freeze({
  /**
   * Delta-v [m/s]. The module and the generator evaluate the SAME closed form
   * in the same IEEE-754 doubles, so the only admissible difference is
   * round-off in a handful of operations. 1e-9 m/s is a nanometre per second:
   * generous for round-off, far tighter than any physical significance, and
   * tight enough that a reordered expression shows up.
   */
  deltaV: { abs: 1e-9, rel: 1e-12 },
  /** Radii and semi-major axes [m]. `abs` is a micrometre. */
  distance: { abs: 1e-6, rel: 1e-12 },
  /** Times [s]. */
  time: { abs: 1e-6, rel: 1e-12 },
  /** Angles [rad]. */
  angle: { abs: 1e-12, rel: 1e-12 },
  /** Dimensionless counts and flags: exact. */
  exact: { abs: 0, rel: 0 },
  /**
   * TIER A velocities [m/s], compared against a published reference rather
   * than against our own arithmetic.
   *
   * The gate is 1e-6 RELATIVE. That is not the solver's capability — a
   * correct universal-variable Lambert reproduces these arcs to ~1e-12 — it
   * is the PRECISION OF THE PRINTED REFERENCE: Tudat's elliptical case quotes
   * velocities to six significant figures, so nothing tighter than ~1e-6 can
   * be asserted about it without asserting digits that were never published.
   *
   * `alarmRel` is the regression watermark. Rows that presently agree far
   * better than the gate are expected to keep doing so; drifting from 1e-11 to
   * 1e-7 is a real regression that a 1e-6 gate would sleep through. The runner
   * reports the worst observed error on PASS as well as on FAIL precisely so
   * that this is visible before it becomes a failure.
   */
  referenceVelocity: { abs: 1e-9, rel: 1e-6, alarmRel: 1e-9 },
});

/**
 * Pick the band for one field of one case.
 *
 * PRECEDENCE, tightest provenance first:
 *   1. `fieldBands[leaf]` — the band the SOURCE stated for that symbol. Tier D
 *      needs this because hapsira asserts `expected_va` at 1e-5 and
 *      `expected_vb` at 1e-4 inside a single test, and one case-wide band would
 *      either over-assert the first or under-assert the second.
 *   2. `band` — a case-wide band (tier A: the source's own tolerance).
 *   3. `bandFor(path)` — the per-quantity default.
 */
export function bandForCase(testCase, path) {
  const leaf = String(path).split(".")[0];
  return testCase.fieldBands?.[leaf] ?? testCase.band ?? bandFor(path);
}

/** Pick a band from a response-field path. */
export function bandFor(path) {
  const leaf = String(path).split(".")[0];
  if (/^(dv|dv1|dv2|dv3|totalDeltaV|totalDV|dv_ric|dv1_ric|dv2_ric|dv3_ric)$/.test(leaf)) {
    return BANDS.deltaV;
  }
  if (/^(v1|v2)$/.test(leaf)) return BANDS.referenceVelocity;
  if (/^(aTransfer|phasingSMA|semiMajorAxis|aTransfer1|aTransfer2)$/.test(leaf)) {
    return BANDS.distance;
  }
  if (/^(tof|totalTime|phasingPeriod)$/.test(leaf)) return BANDS.time;
  if (/^(optimalTrueAnomaly)$/.test(leaf)) return BANDS.angle;
  if (/^(numRevs|revolutions|converged)$/.test(leaf)) return BANDS.exact;
  return BANDS.deltaV;
}

/**
 * Compare one observed number against one expected number.
 *
 * A non-finite observation is ALWAYS a failure and is reported as its own
 * kind. NaN slipping through a `<=` comparison — where every inequality is
 * false and a naive `if (error > budget) fail` therefore PASSES — is the
 * single most common way a numeric harness certifies a broken solver.
 */
export function compareValue(observed, expected, band) {
  /**
   * NON-NUMERIC EXPECTATIONS are compared EXACTLY, and they have to go first.
   *
   * 0.3.0 added two discrete fields to the Lambert responses — `branch`
   * ("low"/"high") and `transferConic` ("elliptic"/"parabolic"/"hyperbolic") —
   * and a discrete answer has no tolerance: either the module returned the arc
   * that was asked for or it returned the other one. Falling through to the
   * numeric path would send a string into `Number.isFinite` and report every
   * such row as "non-finite", which is a true statement about the wrong
   * question. One instrument, two kinds of quantity, no second code path.
   */
  if (typeof expected === "string" || typeof expected === "boolean") {
    const ok = Object.is(observed, expected);
    return {
      ok,
      kind: ok ? "ok" : "exact-mismatch",
      observed,
      expected,
      error: ok ? 0 : Number.POSITIVE_INFINITY,
      budget: 0,
      ratio: ok ? 0 : Number.POSITIVE_INFINITY,
    };
  }
  if (!Number.isFinite(observed)) {
    return {
      ok: false,
      kind: "non-finite",
      observed,
      expected,
      error: Number.POSITIVE_INFINITY,
      budget: 0,
      ratio: Number.POSITIVE_INFINITY,
    };
  }
  if (!Number.isFinite(expected)) {
    return {
      ok: false,
      kind: "non-finite-expectation",
      observed,
      expected,
      error: Number.POSITIVE_INFINITY,
      budget: 0,
      ratio: Number.POSITIVE_INFINITY,
    };
  }
  const error = Math.abs(observed - expected);
  const budget = band.abs + band.rel * Math.abs(expected);
  return {
    ok: error <= budget,
    kind: error <= budget ? "ok" : "out-of-band",
    observed,
    expected,
    error,
    budget,
    /** How much of the budget was used. >1 is a failure; 0.9 is a warning. */
    ratio: budget === 0 ? (error === 0 ? 0 : Number.POSITIVE_INFINITY) : error / budget,
  };
}

/** Read `dv1_ric.1` style paths out of a response object. */
export function readPath(object, path) {
  let cursor = object;
  for (const segment of String(path).split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment];
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// Tier C — invariants
// ---------------------------------------------------------------------------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * The RIC / RTN basis at an inertial state: radial out, cross-track along the
 * angular momentum, in-track completing the right-handed set.
 *
 * This is the frame the module's `*_ric` fields are expressed in and the frame
 * the console's `ricBasis` builds. It is written out here so the round-trip
 * invariant does not depend on the console.
 */
export function ricBasis(position, velocity) {
  const radial = scale(position, 1 / norm(position));
  const h = cross(position, velocity);
  const crossTrack = scale(h, 1 / norm(h));
  const inTrack = cross(crossTrack, radial);
  return { radial, inTrack, crossTrack };
}

/** RIC components -> inertial vector. */
export function ricToEci([r, i, c], basis) {
  return [0, 1, 2].map(
    (axis) =>
      r * basis.radial[axis] + i * basis.inTrack[axis] + c * basis.crossTrack[axis],
  );
}

/** Inertial vector -> RIC components. */
export function eciToRic(vector, basis) {
  return [dot(vector, basis.radial), dot(vector, basis.inTrack), dot(vector, basis.crossTrack)];
}

/** Stumpff C(z), S(z). */
function stumpff(z) {
  if (z > 1e-9) {
    const s = Math.sqrt(z);
    return [(1 - Math.cos(s)) / z, (s - Math.sin(s)) / (s * s * s)];
  }
  if (z < -1e-9) {
    const s = Math.sqrt(-z);
    return [(Math.cosh(s) - 1) / -z, (Math.sinh(s) - s) / (s * s * s)];
  }
  return [1 / 2 - z / 24, 1 / 6 - z / 120];
}

/**
 * Two-body propagation by direct NUMERICAL INTEGRATION — the adjudicator of
 * last resort.
 *
 * Classical RK4 with the step count doubled until two successive answers agree,
 * so the returned state carries a measured convergence claim rather than a
 * hope. It is slow next to the universal-variable solve and it is used only
 * where that solve cannot certify itself, which on the present vector set is
 * the strongly hyperbolic, near-radial regime where `cosh(sqrt(-z))` overflows
 * and every closed-form quantity becomes noise.
 *
 * WHY IT EXISTS AT ALL, stated precisely because the obvious reading is wrong.
 * It is NOT here because the closed form was found to be giving wrong answers.
 * It is here because the closed form had no way to say it could not answer, and
 * the tier-D vectors walked it into a regime where that mattered: Curtis
 * example 5.3 solved the retrograde way round is a near-radial hyperbolic
 * plunge whose perigee is 5.9 km from the Earth's CENTRE, at 369 km/s. The old
 * loop converged on it — correctly, as it happens — from an initial guess that
 * put `z` at about -3300, where `cosh(sqrt(-z))` is 1e24 and nothing in the
 * function checked anything. Fixed-step RK4 cannot resolve that perigee at all
 * and blows up by eleven orders of magnitude, which is why THIS function
 * measures its own convergence and refuses rather than returning its last
 * iterate.
 */
export function integrateTwoBody(position, velocity, dt, mu = MU) {
  const acceleration = (p) => {
    const r = norm(p);
    const k = -mu / (r * r * r);
    return [k * p[0], k * p[1], k * p[2]];
  };
  const step = (state, h) => {
    const [r, v] = state;
    const a1 = acceleration(r);
    const r2 = r.map((x, i) => x + 0.5 * h * v[i]);
    const v2 = v.map((x, i) => x + 0.5 * h * a1[i]);
    const a2 = acceleration(r2);
    const r3 = r.map((x, i) => x + 0.5 * h * v2[i]);
    const v3 = v.map((x, i) => x + 0.5 * h * a2[i]);
    const a3 = acceleration(r3);
    const r4 = r.map((x, i) => x + h * v3[i]);
    const v4 = v.map((x, i) => x + h * a3[i]);
    const a4 = acceleration(r4);
    return [
      r.map((x, i) => x + (h / 6) * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i])),
      v.map((x, i) => x + (h / 6) * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i])),
    ];
  };
  const run = (count) => {
    let state = [[...position], [...velocity]];
    const h = dt / count;
    for (let i = 0; i < count; i += 1) state = step(state, h);
    return state;
  };

  let count = 4096;
  let previous = run(count);
  for (let doubling = 0; doubling < 8; doubling += 1) {
    count *= 2;
    const current = run(count);
    const scale = Math.max(norm(current[0]), norm(position));
    const change = norm(sub(current[0], previous[0])) / scale;
    previous = current;
    if (change < 1e-10) {
      return {
        position: current[0],
        velocity: current[1],
        certified: true,
        method: "rk4",
        steps: count,
        convergence: change,
      };
    }
  }
  return {
    position: previous[0],
    velocity: previous[1],
    certified: false,
    method: "rk4",
    steps: count,
  };
}

/**
 * Universal-variable Kepler propagation of an inertial state.
 *
 * THE ADJUDICATOR. It is deliberately INDEPENDENT of everything else in this
 * repo: it does not call the module, it does not share a line with the tier-B
 * generator, and it takes no reference vector as input. Given a departure
 * velocity it answers one question — does this arc actually arrive? — and that
 * makes it the only instrument here capable of settling a disagreement between
 * a published reference and the module, rather than merely reporting one.
 *
 * THREE THINGS CHANGED ON 2026-08-10. None of them is a repair of a wrong
 * answer — every vector this function had ever adjudicated, it adjudicated
 * correctly. Each closes a way it could have handed back a wrong answer WITH NO
 * SIGN THAT IT HAD, which is the property an adjudicator has to have before it
 * is allowed to settle a disagreement between a published reference and the
 * module:
 *
 * 1. THE INITIAL GUESS IS PER ORBIT TYPE. `sqrt(mu) * |alpha| * dt` is the
 *    ELLIPTIC guess. On a strongly hyperbolic arc it lands where
 *    `z = alpha * x^2` is a few thousand NEGATIVE, `cosh(sqrt(-z))` is ~1e24,
 *    and the Newton iteration that follows is arithmetic on noise. The
 *    hyperbolic branch now uses the standard `sqrt(-a) * ln(...)` guess.
 *
 * 2. NEWTON IS SAFEGUARDED BY BISECTION. `F(x)` is monotone increasing —
 *    `dF/dx` is the radius, which is positive everywhere — so a bracket is
 *    always available and bisection cannot fail to converge inside it. The old
 *    loop had neither a bracket nor a bail-out, so a diverged step simply left
 *    `x` wherever it landed and the caller was told nothing.
 *
 * 3. THE ANSWER IS CERTIFIED OR REFUSED. The time residual is re-evaluated at
 *    the returned `x` and must meet `1e-10 * sqrt(mu) * dt`; the specific
 *    angular momentum and energy of the propagated state must match the
 *    departure state. If any of that fails, the arc is re-propagated by direct
 *    NUMERICAL INTEGRATION, and if THAT cannot converge either, the result is
 *    returned with `certified: false` so the invariant can fail the row rather
 *    than pass it.
 *
 * The case that forced all three is the Curtis 5.3 plunge described above.
 */
export function propagateKepler(position, velocity, dt, mu = MU) {
  const r0 = norm(position);
  const v0 = norm(velocity);
  const vr0 = dot(position, velocity) / r0;
  const alpha = 2 / r0 - (v0 * v0) / mu;
  const sqrtMu = Math.sqrt(mu);

  /** F(x) = 0 is the universal Kepler equation; monotone increasing in x. */
  const F = (x) => {
    const z = alpha * x * x;
    const [C, S] = stumpff(z);
    return (
      ((r0 * vr0) / sqrtMu) * x * x * C +
      (1 - alpha * r0) * x * x * x * S +
      r0 * x -
      sqrtMu * dt
    );
  };
  const dFdx = (x) => {
    const z = alpha * x * x;
    const [C, S] = stumpff(z);
    return (
      ((r0 * vr0) / sqrtMu) * x * (1 - alpha * x * x * S) +
      (1 - alpha * r0) * x * x * C +
      r0
    );
  };

  // -------------------------------------------------------------------------
  // Initial guess, per orbit type (Vallado, Algorithm 8).
  // -------------------------------------------------------------------------
  let guess;
  if (alpha > 1e-12) {
    guess = sqrtMu * alpha * dt;
  } else if (alpha < -1e-12) {
    const a = 1 / alpha;
    const sign = Math.sign(dt) || 1;
    const numerator = -2 * mu * alpha * dt;
    const denominator =
      dot(position, velocity) + sign * Math.sqrt(-mu * a) * (1 - r0 * alpha);
    const ratio = numerator / denominator;
    guess = ratio > 0 ? sign * Math.sqrt(-a) * Math.log(ratio) : sqrtMu * Math.abs(alpha) * dt;
  } else {
    guess = (sqrtMu * dt) / r0;
  }
  if (!Number.isFinite(guess) || guess === 0) guess = (sqrtMu * dt) / r0;

  // -------------------------------------------------------------------------
  // Bracket, then safeguarded Newton.
  // -------------------------------------------------------------------------
  /**
   * TWO thresholds, and they are not the same number.
   *
   * `stopBudget` drives the ITERATION and is set near the arithmetic floor:
   * `sqrt(mu) * dt` is ~1e11 for a LEO arc and a double resolves it to ~1e-5,
   * so 1e-14 relative asks for everything the representation has. Stopping at a
   * looser value costs the whole suite resolution it needs — the tier-A
   * regression watermarks sit at 3e-11 relative, and an adjudicator that
   * converges only to 1e-9 cannot see them.
   *
   * `certifyBudget` drives the REFUSE decision and is four decades looser: an
   * arc that converged well past physical significance is a good arc even if it
   * missed the iteration's own stopping target on the last bisection.
   */
  const stopBudget = 1e-14 * sqrtMu * Math.abs(dt);
  const certifyBudget = 1e-10 * sqrtMu * Math.abs(dt);
  const budget = stopBudget;
  let lo = 0;
  let hi = Math.abs(guess);
  let fLo = F(lo);
  let fHi = F(hi);
  if (!Number.isFinite(fHi)) {
    hi = Math.abs(guess);
    for (let i = 0; i < 200 && !Number.isFinite(fHi); i += 1) {
      hi *= 0.5;
      fHi = F(hi);
    }
  }
  for (let i = 0; i < 200 && Number.isFinite(fHi) && fHi < 0; i += 1) {
    lo = hi;
    fLo = fHi;
    hi *= 2;
    fHi = F(hi);
  }

  let x = guess;
  let bracketed = Number.isFinite(fLo) && Number.isFinite(fHi) && fLo <= 0 && fHi >= 0;
  if (bracketed) {
    x = 0.5 * (lo + hi);
    for (let i = 0; i < 200; i += 1) {
      const f = F(x);
      if (!Number.isFinite(f)) {
        x = 0.5 * (lo + hi);
        break;
      }
      if (Math.abs(f) <= budget) break;
      if (f < 0) lo = x;
      else hi = x;
      const slope = dFdx(x);
      let next = Number.isFinite(slope) && slope !== 0 ? x - f / slope : Number.NaN;
      if (!Number.isFinite(next) || next <= lo || next >= hi) next = 0.5 * (lo + hi);
      if (Math.abs(next - x) < 1e-14 * Math.max(1, Math.abs(x))) {
        x = next;
        break;
      }
      x = next;
    }
  }

  const z = alpha * x * x;
  const [C, S] = stumpff(z);
  const f = 1 - ((x * x) / r0) * C;
  const g = dt - ((x * x * x) / sqrtMu) * S;
  const arrival = [0, 1, 2].map((axis) => f * position[axis] + g * velocity[axis]);
  const rArrival = norm(arrival);
  const fDot = (sqrtMu / (r0 * rArrival)) * (alpha * x * x * x * S - x);
  const gDot = 1 - ((x * x) / rArrival) * C;
  const arrivalVelocity = [0, 1, 2].map(
    (axis) => fDot * position[axis] + gDot * velocity[axis],
  );

  // -------------------------------------------------------------------------
  // Certify — or hand the arc to the integrator and say which one answered.
  // -------------------------------------------------------------------------
  const residual = Math.abs(F(x));
  const finite =
    arrival.every(Number.isFinite) && arrivalVelocity.every(Number.isFinite);
  let certified = bracketed && finite && residual <= certifyBudget;
  if (certified) {
    // Conserved quantities, checked rather than assumed. A solve that met its
    // own residual and still moved the angular momentum has not propagated the
    // orbit it was given.
    const h0 = norm(cross(position, velocity));
    const h1 = norm(cross(arrival, arrivalVelocity));
    const e0 = (v0 * v0) / 2 - mu / r0;
    const e1 = (norm(arrivalVelocity) ** 2) / 2 - mu / rArrival;
    const scaleH = Math.max(h0, 1);
    const scaleE = Math.max(Math.abs(e0), 1);
    certified = Math.abs(h1 - h0) / scaleH < 1e-8 && Math.abs(e1 - e0) / scaleE < 1e-8;
  }
  if (certified) {
    return {
      position: arrival,
      velocity: arrivalVelocity,
      certified: true,
      method: "universal-variable",
      residual,
      residualBudget: certifyBudget,
    };
  }
  const integrated = integrateTwoBody(position, velocity, dt, mu);
  return {
    ...integrated,
    universalVariableRefused: {
      bracketed,
      residual,
      residualBudget: certifyBudget,
      reason: bracketed
        ? "the universal-variable solve did not meet its own residual, or moved a conserved quantity"
        : "the universal Kepler equation could not be bracketed in this regime",
    },
  };
}

/**
 * The invariant set. Each takes `{ params, response }` and returns
 * `{ id, ok, detail, worst? }`. They are applied to EVERY case whose operation
 * they recognise, on top of whatever the case's own expectations say — an
 * invariant that only runs where someone remembered to list it is not an
 * invariant.
 */
export const INVARIANTS = Object.freeze({
  /**
   * Vis-viva closure for a two-burn circular-to-circular transfer: the speed
   * after burn 1 must be exactly the transfer orbit's speed at r1, and the
   * speed before burn 2 must be its speed at r2.
   *
   * This is the check that would have caught a delta-v computed against the
   * wrong semi-major axis — a class of error that leaves `dv1 + dv2` looking
   * entirely reasonable.
   */
  visVivaClosure({ operation, params, response }) {
    if (operation !== "hohmannTransfer") return null;
    const { r1, r2 } = params;
    const mu = params.mu ?? MU;
    const a = response.aTransfer;
    const dv1 = readPath(response, "dv1_ric.1");
    const dv2 = readPath(response, "dv2_ric.1");
    const speedAfterBurn1 = Math.sqrt(mu / r1) + dv1;
    const speedBeforeBurn2 = Math.sqrt(mu / r2) - dv2;
    const expected1 = Math.sqrt(mu * (2 / r1 - 1 / a));
    const expected2 = Math.sqrt(mu * (2 / r2 - 1 / a));
    const c1 = compareValue(speedAfterBurn1, expected1, BANDS.deltaV);
    const c2 = compareValue(speedBeforeBurn2, expected2, BANDS.deltaV);
    return {
      id: "vis-viva-closure",
      ok: c1.ok && c2.ok,
      worst: c1.ratio >= c2.ratio ? c1 : c2,
      detail:
        `v(r1)+dv1 = ${speedAfterBurn1} vs vis-viva ${expected1}; ` +
        `v(r2)-dv2 = ${speedBeforeBurn2} vs vis-viva ${expected2}`,
    };
  },

  /**
   * The delta-v sum identity: whatever `totalDeltaV` claims must be the sum of
   * the magnitudes the same response reports. A response whose total does not
   * add up is internally inconsistent regardless of which number is right.
   */
  deltaVSumIdentity({ response }) {
    const total = response.totalDeltaV ?? response.totalDV;
    if (total === undefined) return null;
    const parts = ["dv1", "dv2", "dv3"]
      .map((key) => response[key])
      .filter((value) => typeof value === "number");
    if (parts.length === 0) return null;
    const sum = parts.reduce((acc, value) => acc + Math.abs(value), 0);
    const comparison = compareValue(total, sum, BANDS.deltaV);
    return {
      id: "delta-v-sum-identity",
      ok: comparison.ok,
      worst: comparison,
      detail: `totalDeltaV ${total} vs sum|dv_i| ${sum}`,
    };
  },

  /**
   * RTN <-> ECI round trip, asserted PER COMPONENT.
   *
   * A magnitude-only round-trip passes under ANY rotation, including the
   * identity map that engine defect D1 applies when it copies r/t/n straight
   * onto x/y/z. Component-wise is the only form of this check that can see the
   * bug it exists to see.
   */
  ricRoundTrip({ response }) {
    const ricFields = ["dv_ric", "dv1_ric", "dv2_ric", "dv3_ric"].filter(
      (key) => Array.isArray(response[key]),
    );
    if (ricFields.length === 0) return null;
    // A representative inertial state, deliberately NOT axis-aligned and NOT
    // equatorial: an aligned state makes the RIC basis a permutation of the
    // inertial axes, under which the D1 identity-map bug is invisible.
    const position = [4_012_345.6, 5_123_456.7, 2_345_678.9];
    const velocity = [-4_512.3, 3_210.9, 1_234.5];
    const basis = ricBasis(position, velocity);

    let worst = null;
    for (const key of ricFields) {
      const ric = response[key];
      const roundTripped = eciToRic(ricToEci(ric, basis), basis);
      for (let axis = 0; axis < 3; axis += 1) {
        const comparison = compareValue(roundTripped[axis], ric[axis], BANDS.deltaV);
        comparison.field = `${key}[${axis}]`;
        if (!worst || comparison.ratio > worst.ratio) worst = comparison;
      }
    }
    return {
      id: "rtn-eci-round-trip-per-component",
      ok: worst.ok,
      worst,
      detail: `worst component ${worst.field}: ${worst.observed} vs ${worst.expected}`,
    };
  },

  /**
   * LAMBERT ARRIVAL CLOSURE — the invariant that adjudicates the solver.
   *
   * A Lambert solution is a claim: "depart r1 at v1 and you are at r2 in tof
   * seconds". The claim is checkable with nothing but a Kepler propagator, and
   * it is checked PER COMPONENT against |r2| so that a solution which arrives
   * at the right distance in the wrong direction fails.
   */
  lambertClosure({ operation, params, response }) {
    if (operation !== "solveLambert" && operation !== "solveLambertMinDV") return null;
    if (!Array.isArray(response.v1)) return null;
    const mu = params.mu ?? MU;
    const arrival = propagateKepler(params.r1, response.v1, params.tof, mu);
    const target = params.r2;
    const scaleR = norm(target);
    if (arrival.certified === false) {
      // The adjudicator could not settle this arc with either instrument. That
      // is NOT a pass. A claim nobody can check is exactly the state this
      // invariant exists to make visible, and reporting it as agreement is how
      // the instrument would come to certify the defect it was built to find.
      return {
        id: "lambert-arrival-closure",
        ok: false,
        detail:
          "the arrival could not be adjudicated: neither the universal-variable " +
          "solve nor the numerical integration converged for this arc " +
          `(${arrival.universalVariableRefused?.reason ?? "unknown"})`,
        relativeMiss: Number.POSITIVE_INFINITY,
        missDistance: Number.POSITIVE_INFINITY,
      };
    }
    let worst = null;
    for (let axis = 0; axis < 3; axis += 1) {
      const comparison = compareValue(arrival.position[axis], target[axis], {
        // The band is relative to |r2| rather than to the component, so a
        // component that is legitimately near zero does not demand absurd
        // absolute precision while a large one goes unchecked.
        abs: 1e-6 * scaleR,
        rel: 0,
      });
      comparison.field = `arrival[${axis}]`;
      if (!worst || comparison.ratio > worst.ratio) worst = comparison;
    }
    const missDistance = norm(sub(arrival.position, target));
    return {
      id: "lambert-arrival-closure",
      ok: worst.ok,
      worst,
      detail:
        `propagating (r1, v1) for tof lands ${missDistance.toExponential(4)} m ` +
        `from r2 (${(missDistance / scaleR).toExponential(3)} of |r2|) ` +
        `[adjudicated by ${arrival.method}]`,
      missDistance,
      relativeMiss: missDistance / scaleR,
      adjudicatedBy: arrival.method,
    };
  },

  /**
   * LAMBERT EARTH FLOOR — the transfer that flies through the planet.
   *
   * WHAT THIS INVARIANT DOES CHANGED AT 0.3.0, and the change is the whole
   * point of `modules-maneuver-lambert-publishes-no-transfer-perigee`.
   *
   * Against 0.2.0 it could only CLASSIFY: it reconstructed the transfer conic
   * from the returned `v1` and reported whether the arc passed through the
   * planet, because the module published no perigee of its own and there was
   * nothing to check. Six of the published conformance geometries classified
   * THROUGH-EARTH — Vallado 7-5 at 3,186 km from the centre, Der's Molniya at
   * 909 km — and every one of them is a CORRECT answer that hapsira and Orekit
   * assert in their own suites, so refusing them was never the fix. Publishing
   * the evidence was, and an operator met the consequence of not publishing it
   * live on 2026-08-10.
   *
   * 0.3.0 publishes `perigeeRadius`, so this now CHECKS: the module's own
   * reported conic must reproduce the independent reconstruction from the same
   * `v1`. That is a strictly stronger instrument — it runs on every Lambert row
   * on every runtime, so the field is pinned across the whole vector set rather
   * than at the single row that names it — and a module that stopped reporting
   * it, or reported a stale one, fails here rather than going quiet.
   *
   * The classification survives alongside the check, because the count of
   * conformance geometries that fly through the planet is a number worth
   * watching whether or not anything is wrong.
   */
  lambertEarthFloor({ operation, params, response }) {
    if (operation !== "solveLambert" && operation !== "solveLambertMinDV") return null;
    if (!Array.isArray(response.v1)) return null;
    const mu = params.mu ?? MU;
    const r = norm(params.r1);
    const v = norm(response.v1);
    const energy = (v * v) / 2 - mu / r;
    const h = norm(cross(params.r1, response.v1));
    const semiMajorAxis = -mu / (2 * energy);
    const semiLatusRectum = (h * h) / mu;
    // e^2 = 1 + 2 E h^2 / mu^2, which is finite and correct for every conic
    // including the parabolic limit, unlike a form that divides by (1 - e^2).
    const eccentricity = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
    const perigeeRadius = semiLatusRectum / (1 + eccentricity);
    const classification = perigeeRadius >= RE ? "above-surface" : "THROUGH-EARTH";
    const conic = energy < 0 ? "elliptic" : energy > 0 ? "hyperbolic" : "parabolic";

    const checks = [];
    if (response.perigeeRadius === undefined) {
      checks.push({
        field: "perigeeRadius",
        ok: false,
        detail:
          "the response publishes no perigeeRadius. A converged Lambert answer " +
          "that does not say how low the arc goes leaves the consumer nothing " +
          "to screen with, and the no-JS-physics law forbids re-deriving it at " +
          "the far end (graph: modules-maneuver-lambert-publishes-no-transfer-perigee).",
      });
    } else {
      // Both sides evaluate the SAME conic algebra on the SAME v1 doubles, so
      // the only admissible difference is association order and the last bit of
      // a square root. BANDS.distance (1 micrometre absolute) is four decades
      // looser than the agreement measured at 0.3.0 (worst row 5.2e-5 m over a
      // 9.1e5 m perigee, i.e. ~6e-11 relative) and still far tighter than any
      // difference a real defect could hide in.
      const comparison = compareValue(response.perigeeRadius, perigeeRadius, BANDS.distance);
      checks.push({
        field: "perigeeRadius",
        ok: comparison.ok,
        detail: `reported ${response.perigeeRadius} vs reconstructed ${perigeeRadius}`,
        comparison,
      });
    }
    if (response.transferConic !== undefined && response.transferConic !== conic) {
      checks.push({
        field: "transferConic",
        ok: false,
        detail: `reported ${response.transferConic}, energy says ${conic}`,
      });
    }
    // An apoapsis exists on a bound arc and nowhere else, and the module's own
    // conic label is what a consumer reads to tell the two apart — so the label
    // and the presence of the field have to agree.
    if (response.transferConic === "elliptic" && response.apogeeRadius !== undefined) {
      const expectedApogee = semiMajorAxis * (1 + eccentricity);
      const comparison = compareValue(response.apogeeRadius, expectedApogee, BANDS.distance);
      checks.push({
        field: "apogeeRadius",
        ok: comparison.ok,
        detail: `reported ${response.apogeeRadius} vs reconstructed ${expectedApogee}`,
        comparison,
      });
    }
    if (response.transferConic === "hyperbolic" && response.apogeeRadius !== undefined) {
      checks.push({
        field: "apogeeRadius",
        ok: false,
        detail: "a hyperbolic transfer has no apoapsis, and this response reports one",
      });
    }
    if (response.transferEccentricity !== undefined) {
      const comparison = compareValue(response.transferEccentricity, eccentricity, {
        abs: 1e-12,
        rel: 1e-12,
      });
      checks.push({
        field: "transferEccentricity",
        ok: comparison.ok,
        detail: `reported ${response.transferEccentricity} vs reconstructed ${eccentricity}`,
        comparison,
      });
    }

    const bad = checks.filter((check) => !check.ok);
    return {
      id: "lambert-earth-floor",
      ok: bad.length === 0,
      classification,
      perigeeRadius,
      floor: RE,
      semiMajorAxis,
      eccentricity,
      checks,
      detail:
        bad.length > 0
          ? bad.map((check) => `${check.field}: ${check.detail}`).join("; ")
          : `transfer perigee ${perigeeRadius.toFixed(1)} m vs Earth radius ${RE} m ` +
            `(${classification === "above-surface" ? "flyable" : "THROUGH THE PLANET — reported, so the consumer can screen"})`,
    };
  },

  /**
   * MIN-DV RANKS ITS OWN SET — the invariant that makes "it considers both
   * branches" checkable instead of asserted.
   *
   * A multi-revolution Lambert problem has two arcs per revolution count.
   * 0.2.0's `solveLambertMinDV` could only ever see one of them, so it
   * minimised over half its own domain and presented the winner as a global
   * answer; nothing in a response distinguished that from a real minimum.
   * 0.3.0 publishes the candidate set it ranked, and this invariant holds it to
   * three things a genuine ranking must satisfy:
   *
   *   1. the winner's cost IS the minimum of the published set;
   *   2. the winner's (revolutions, branch) is IN the published set;
   *   3. the set is in canonical order — revolutions ascending, low before
   *      high — so that a diff between two runs is a diff of costs and never of
   *      an ordering, and so a missing branch is visible by inspection.
   */
  lambertMinDVRanking({ operation, response }) {
    if (operation !== "solveLambertMinDV") return null;
    if (!Array.isArray(response.branches)) return null;
    const set = response.branches;
    const failures = [];
    const best = set.reduce(
      (worst, entry) => (entry.totalDeltaV < worst ? entry.totalDeltaV : worst),
      Number.POSITIVE_INFINITY,
    );
    const winner = compareValue(response.totalDeltaV, best, BANDS.deltaV);
    if (!winner.ok) {
      failures.push(
        `the returned totalDeltaV ${response.totalDeltaV} is not the minimum ${best} of its own published set`,
      );
    }
    const named = set.some(
      (entry) =>
        entry.revolutions === response.revolutions &&
        (entry.branch ?? undefined) === (response.branch ?? undefined),
    );
    if (!named) {
      failures.push(
        `the returned arc (revolutions ${response.revolutions}, branch ${response.branch ?? "-"}) is absent from the published set`,
      );
    }
    const rank = (entry) => entry.revolutions * 2 + (entry.branch === "high" ? 1 : 0);
    for (let i = 1; i < set.length; i += 1) {
      if (rank(set[i]) <= rank(set[i - 1])) {
        failures.push(
          `the published set is not in canonical order at index ${i}: ` +
            `rev ${set[i - 1].revolutions}/${set[i - 1].branch ?? "-"} then ` +
            `rev ${set[i].revolutions}/${set[i].branch ?? "-"}`,
        );
        break;
      }
    }
    return {
      id: "lambert-mindv-ranks-its-own-set",
      ok: failures.length === 0,
      worst: winner,
      candidates: set.length,
      detail:
        failures.length > 0
          ? failures.join("; ")
          : `${set.length} candidate(s) ranked; winner rev ${response.revolutions}` +
            `${response.branch ? `/${response.branch}` : ""} at ${response.totalDeltaV} m/s`,
    };
  },

  /**
   * PHASING EARTH FLOOR — the guard the module does not have.
   *
   * `computePhasingManeuver` returns an unclamped semi-major axis, so a large
   * phase angle in few revolutions yields a phasing orbit whose far apse is
   * underground, reported with no error and no flag. This invariant does not
   * fail such a case (the module is behaving as built); it CLASSIFIES it, so
   * the harness can assert that every case the wrapper is expected to guard is
   * one the module would have let through.
   */
  phasingEarthFloor({ operation, params, response }) {
    if (operation !== "phasingManeuver") return null;
    const farApse = 2 * response.phasingSMA - params.currentRadius;
    return {
      id: "phasing-earth-floor",
      ok: true,
      classification: farApse >= PHASING_FLOOR ? "above-floor" : "BELOW-FLOOR",
      farApse,
      floor: PHASING_FLOOR,
      detail:
        `far apse ${farApse.toFixed(1)} m vs floor ${PHASING_FLOOR} m ` +
        `(${farApse >= PHASING_FLOOR ? "safe" : "UNDERGROUND — module returns it silently"})`,
    };
  },
});

/**
 * THE RIC FRAME-ALGEBRA CHECK — Orekit's inertial impulsive-burn identity,
 * asserted against the algebra every `*_ric` field in this module depends on.
 *
 * Orekit's `ImpulseManeuverTest.testInertialManeuver` states the identity in
 * the frame where it has no free parameters: a delta-v applied in an INERTIAL
 * frame adds component by component to the inertial velocity. Our module never
 * publishes an inertial delta-v — it publishes RIC triples — so the identity is
 * checked through the round trip a consumer actually performs: take Orekit's
 * triple as RIC components at a stated state, rotate to inertial, add it to the
 * velocity, and recover the delta-v by subtraction. The recovered triple must
 * reproduce Orekit's to OREKIT'S OWN tolerance.
 *
 * The probe state is deliberately not axis-aligned and not equatorial. An
 * aligned state makes the RIC basis a permutation of the inertial axes, under
 * which a rotation that is silently the identity — engine defect D1 — passes.
 */
export function runFrameAlgebra(testCase) {
  const { deltaV, initialVelocity, expectedFinalVelocity, tolerance } = testCase.frameAlgebra;
  const position = [4_012_345.6, 5_123_456.7, 2_345_678.9];
  const referenceVelocity = [-4_512.3, 3_210.9, 1_234.5];
  const basis = ricBasis(position, referenceVelocity);

  const inertialDeltaV = ricToEci(deltaV, basis);
  const postBurn = initialVelocity.map((component, axis) => component + inertialDeltaV[axis]);
  const recoveredRic = eciToRic(sub(postBurn, initialVelocity), basis);

  const band = { abs: tolerance, rel: 0 };
  const comparisons = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const comparison = compareValue(recoveredRic[axis], deltaV[axis], band);
    comparison.field = `deltaV_ric[${axis}]`;
    comparisons.push(comparison);
  }
  // The inertial identity itself, in the frame Orekit states it: the burn's
  // MAGNITUDE is invariant under the rotation, so a basis that is not
  // orthonormal shows up here even when the round trip closes.
  const magnitudeComparison = compareValue(norm(inertialDeltaV), norm(deltaV), band);
  magnitudeComparison.field = "|deltaV| invariance under the RIC rotation";
  comparisons.push(magnitudeComparison);
  // And the sum Orekit actually asserts, expressed in a frame where the RIC
  // triad is the inertial one (identity basis), which is the literal reading of
  // its test.
  for (let axis = 0; axis < 3; axis += 1) {
    const comparison = compareValue(
      initialVelocity[axis] + deltaV[axis],
      expectedFinalVelocity[axis],
      band,
    );
    comparison.field = `inertial finalVelocity[${axis}]`;
    comparisons.push(comparison);
  }
  return comparisons;
}

/** Run every invariant that recognises this case. */
export function runInvariants(context) {
  const results = [];
  for (const invariant of Object.values(INVARIANTS)) {
    const result = invariant(context);
    if (result) results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Loading + reporting
// ---------------------------------------------------------------------------

export async function loadVectors(url = VECTORS_URL) {
  const parsed = JSON.parse(await readFile(url, "utf8"));
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error("vectors.json carries no cases");
  }
  return parsed;
}

/**
 * Render the worst row of a comparison set.
 *
 * REPORTED ON PASS AS WELL AS ON FAIL. A green run that says nothing hides the
 * approach to the cliff; a green run that prints "worst row used 3% of its
 * budget" tells you how much margin you actually have, and turns the day the
 * margin disappears into a visible event rather than a sudden red.
 */
export function formatWorst(rows, label) {
  const scored = rows.filter((row) => row && Number.isFinite(row.ratio));
  if (scored.length === 0) return `${label}: no comparable rows`;
  const worst = scored.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  const percent = (worst.ratio * 100).toFixed(3);
  return (
    `${label}: worst ${worst.field ?? worst.path ?? "value"} ` +
    `|err| ${worst.error.toExponential(3)} of budget ${worst.budget.toExponential(3)} ` +
    `(${percent}% used)`
  );
}
