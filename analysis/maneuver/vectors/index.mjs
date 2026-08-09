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
 * Universal-variable Kepler propagation of an inertial state.
 *
 * THE ADJUDICATOR. It is deliberately INDEPENDENT of everything else in this
 * repo: it does not call the module, it does not share a line with the tier-B
 * generator, and it takes no reference vector as input. Given a departure
 * velocity it answers one question — does this arc actually arrive? — and that
 * makes it the only instrument here capable of settling a disagreement between
 * a published reference and the module, rather than merely reporting one.
 */
export function propagateKepler(position, velocity, dt, mu = MU) {
  const r0 = norm(position);
  const v0 = norm(velocity);
  const vr0 = dot(position, velocity) / r0;
  const alpha = 2 / r0 - (v0 * v0) / mu;
  const sqrtMu = Math.sqrt(mu);

  let x = sqrtMu * Math.abs(alpha) * dt;
  for (let i = 0; i < 500; i += 1) {
    const z = alpha * x * x;
    const [C, S] = stumpff(z);
    const F =
      ((r0 * vr0) / sqrtMu) * x * x * C +
      (1 - alpha * r0) * x * x * x * S +
      r0 * x -
      sqrtMu * dt;
    const dF =
      ((r0 * vr0) / sqrtMu) * x * (1 - alpha * x * x * S) +
      (1 - alpha * r0) * x * x * C +
      r0;
    if (!Number.isFinite(dF) || dF === 0) break;
    const step = F / dF;
    x -= step;
    if (Math.abs(step) < 1e-12 * Math.max(1, Math.abs(x))) break;
  }

  const z = alpha * x * x;
  const [C, S] = stumpff(z);
  const f = 1 - ((x * x) / r0) * C;
  const g = dt - ((x * x * x) / sqrtMu) * S;
  const arrival = [0, 1, 2].map((axis) => f * position[axis] + g * velocity[axis]);
  const rArrival = norm(arrival);
  const fDot = ((sqrtMu / (r0 * rArrival)) * (alpha * x * x * x * S - x));
  const gDot = 1 - ((x * x) / rArrival) * C;
  const arrivalVelocity = [0, 1, 2].map(
    (axis) => fDot * position[axis] + gDot * velocity[axis],
  );
  return { position: arrival, velocity: arrivalVelocity };
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
        `from r2 (${(missDistance / scaleR).toExponential(3)} of |r2|)`,
      missDistance,
      relativeMiss: missDistance / scaleR,
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
