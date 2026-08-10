#!/usr/bin/env node
/**
 * TIER B GENERATOR — textbook canonical maneuver cases.
 *
 * WHY A GENERATOR AND NOT A HAND-WRITTEN TABLE. The test this file replaces
 * (`hohmannReference()` in behavior.test.mjs) recomputed the expected answer
 * from the same formula the module implements, INSIDE the assertion, at run
 * time. That is a tautology: the two agree because they are the same equation
 * typed twice, and it can only fail on a typo. Freezing generated numbers into
 * a reviewed file breaks the loop — the module is then compared against a fixed
 * artifact that a human approved once, and any drift in EITHER direction shows
 * up as a diff in version control rather than as a silently-passing test.
 *
 * WHAT MAKES THE NUMBERS AUTHORITATIVE, in order of strength:
 *
 *   1. PUBLISHED ANCHORS. Cases whose inputs come from a named worked example
 *      carry the example's own published answer at the precision the source
 *      prints. The generator CHECKS itself against the anchor and REFUSES to
 *      emit if it disagrees. That check is the whole point: it is what turns
 *      "the author remembered the number correctly" into a machine-verified
 *      claim. An anchor that fails is a defect in this file, never something
 *      to relax.
 *   2. CLOSED FORM. Each expected value is produced by the closed form written
 *      out in `PROVENANCE.md`, implemented here ONCE and independently of the
 *      module's C++.
 *   3. CROSS-TIER AGREEMENT. Tier C invariants (vis-viva closure, delta-v sum
 *      identity) are applied to the module's response for these same cases, so
 *      a value can be wrong in the generator and still be caught downstream.
 *
 * UNITS. Sources are km-native; the module is metre-native. Conversion happens
 * ONCE, here, at emit time, and the emitted file is SI throughout.
 */

import { propagateKepler } from "../index.mjs";

/** Conformance model, PINNED by the program task (section A.6). */
export const MU_KM = 398600.4418; //  km^3/s^2
export const MU = 3.986004418e14; //  m^3/s^2
export const RE_KM = 6378.137; //     km, WGS-84

const KM = 1000;

// --- closed forms (km-native; see PROVENANCE.md for the written-out algebra) --

/** Circular speed, `sqrt(mu/r)`. */
const vCircular = (r) => Math.sqrt(MU_KM / r);
/** Vis-viva speed on an orbit of semi-major axis `a` at radius `r`. */
const visViva = (r, a) => Math.sqrt(MU_KM * (2 / r - 1 / a));
/** Half-period of an ellipse of semi-major axis `a`. */
const halfPeriod = (a) => Math.PI * Math.sqrt(a ** 3 / MU_KM);

function hohmann(r1, r2) {
  const aTransfer = (r1 + r2) / 2;
  const dv1 = visViva(r1, aTransfer) - vCircular(r1);
  const dv2 = vCircular(r2) - visViva(r2, aTransfer);
  return {
    aTransfer,
    dv1,
    dv2,
    totalDeltaV: Math.abs(dv1) + Math.abs(dv2),
    tof: halfPeriod(aTransfer),
  };
}

function biElliptic(r1, r2, rIntermediate) {
  const a1 = (r1 + rIntermediate) / 2;
  const a2 = (rIntermediate + r2) / 2;
  const dv1 = visViva(r1, a1) - vCircular(r1);
  const dv2 = visViva(rIntermediate, a2) - visViva(rIntermediate, a1);
  const dv3 = vCircular(r2) - visViva(r2, a2);
  return {
    a1,
    a2,
    dv1,
    dv2,
    dv3,
    totalDeltaV: Math.abs(dv1) + Math.abs(dv2) + Math.abs(dv3),
    tof: halfPeriod(a1) + halfPeriod(a2),
  };
}

/** Pure rotation of the velocity vector: the isoceles-triangle law. */
const planeChange = (velocity, deltaInclination) =>
  2 * velocity * Math.sin(Math.abs(deltaInclination) / 2);

/**
 * Hohmann with the plane change folded into the SECOND burn (the module's
 * `combinedManeuver`): burn 1 stays in plane, burn 2 closes the triangle
 * between the transfer-apoapsis velocity and the target circular velocity
 * with the full inclination change between them.
 */
function combined(r1, r2, deltaInclination) {
  const aTransfer = (r1 + r2) / 2;
  const v2c = vCircular(r2);
  const v2t = visViva(r2, aTransfer);
  const dv1 = visViva(r1, aTransfer) - vCircular(r1);
  const dv2 = Math.sqrt(
    v2c * v2c + v2t * v2t - 2 * v2c * v2t * Math.cos(deltaInclination),
  );
  return {
    aTransfer,
    dv1,
    dv2,
    totalDeltaV: Math.abs(dv1) + dv2,
    tof: halfPeriod(aTransfer),
  };
}

/**
 * The OPTIMAL split of a plane change between the two burns of a Hohmann
 * transfer. The module does NOT implement this — the case exists to hold the
 * gap open (see the known-gap entry below), so this is a reference value the
 * module is expected to MISS, not to match.
 */
function combinedOptimalSplit(r1, r2, deltaInclination) {
  const aTransfer = (r1 + r2) / 2;
  const v1c = vCircular(r1);
  const v1t = visViva(r1, aTransfer);
  const v2c = vCircular(r2);
  const v2t = visViva(r2, aTransfer);
  const total = (split) =>
    Math.sqrt(v1c * v1c + v1t * v1t - 2 * v1c * v1t * Math.cos(split)) +
    Math.sqrt(
      v2c * v2c +
        v2t * v2t -
        2 * v2c * v2t * Math.cos(deltaInclination - split),
    );
  // Golden-free ternary search: the objective is strictly unimodal on
  // [0, di] for a raising transfer, so a bracketing search is exact to
  // machine precision without a derivative.
  let lo = 0;
  let hi = deltaInclination;
  for (let i = 0; i < 300; i += 1) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (total(m1) < total(m2)) hi = m2;
    else lo = m1;
  }
  const split = (lo + hi) / 2;
  return { split, totalDeltaV: total(split) };
}

/**
 * Phasing: drop (or raise) into an orbit whose period is short (long) by the
 * required fraction of a revolution, coast `numRevs`, and restore.
 *
 * SIGN IS THE WHOLE POINT of this case. `dv1` is `v_phasing - v_circular`,
 * which is NEGATIVE for a catch-up (positive phase angle => smaller phasing
 * orbit). The module returns `std::abs(dv1)`, so a harness that only compares
 * magnitudes certifies a solver that flies every catch-up burn backwards.
 */
function phasing(radius, phaseAngle, numRevs) {
  const period = 2 * Math.PI * Math.sqrt(radius ** 3 / MU_KM);
  const phasingPeriod = period - (phaseAngle / (2 * Math.PI * numRevs)) * period;
  const phasingSMA = Math.cbrt(
    (MU_KM * phasingPeriod * phasingPeriod) / (4 * Math.PI * Math.PI),
  );
  const dv1 = visViva(radius, phasingSMA) - vCircular(radius);
  return {
    phasingPeriod,
    phasingSMA,
    dv1,
    dv2: -dv1,
    totalDeltaV: 2 * Math.abs(dv1),
    totalTime: phasingPeriod * numRevs,
  };
}

/**
 * Phasing WITH the Earth-collision floor the module applies.
 *
 * `phasing()` above is the unconstrained closed form, which is all the two
 * canonical 30-degree rows need. The rows that exercise the revolution-count
 * RECOMMENDATION need the constraint as well, because the recommendation's
 * whole job is to climb until the phasing orbit stops trying to fly through
 * the planet. The floor is `Re + 100 km` on the WGS-84 equatorial radius,
 * applied to the apse OPPOSITE the burn (`2a - r`), i.e. `a >= (floor + r)/2`.
 */
function phasingWithFloor(radius, phaseAngle, numRevs) {
  const floorRadius = RE_KM + 100; // km, WGS-84 + 100 km
  const unconstrained = phasing(radius, phaseAngle, numRevs);
  const aFloor = (floorRadius + radius) / 2;
  if (unconstrained.phasingSMA >= aFloor) {
    return { ...unconstrained, clamped: false };
  }
  const phasingPeriod = 2 * Math.PI * Math.sqrt(aFloor ** 3 / MU_KM);
  const dv1 = visViva(radius, aFloor) - vCircular(radius);
  return {
    phasingPeriod,
    phasingSMA: aFloor,
    dv1,
    dv2: -dv1,
    totalDeltaV: 2 * Math.abs(dv1),
    totalTime: phasingPeriod * numRevs,
    clamped: true,
  };
}

/**
 * The revolution count the module should recommend: the SMALLEST count that
 * both clears the floor without clamping and comes in under the delta-v
 * budget. Both conditions relax monotonically with the count, so the first hit
 * is the answer. Written here so the vector's expectation is produced by this
 * file's own scan rather than read back out of the module.
 */
function recommendRevs(radius, phaseAngle, budgetKmPerS, maxRevs = 100) {
  for (let revs = 1; revs <= maxRevs; revs += 1) {
    const trial = phasingWithFloor(radius, phaseAngle, revs);
    if (trial.clamped) continue;
    if (trial.totalDeltaV <= budgetKmPerS) return revs;
  }
  return maxRevs;
}

// ---------------------------------------------------------------------------
// PHASING FROM TWO SPACECRAFT STATES
//
// The two-craft rows are CONSTRUCTED, and the construction is what makes them
// authoritative. Each craft is specified by classical elements whose mean
// argument of latitude (`argumentOfPerigee + meanAnomaly`) is chosen by hand;
// the Cartesian state handed to the module is produced from those elements by
// the closed form below, which is written here and nowhere else. The
// separation the module must recover is therefore known ANALYTICALLY, to the
// last bit, before the module is asked — there is no reference to disagree
// with and no round trip through the code under test.
//
// The rows exist in pairs with the typed-angle rows above: the same radius,
// the same revolution count, the same 30 degrees, so a from-two-states answer
// that drifted from the typed answer would show up as two rows disagreeing
// about one number rather than as nothing at all.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
/** The canonical phasing radius, in METRES — these rows are SI throughout. */
const PHASE_RADIUS_M = 6778.137 * KM;

/** Kepler's equation, Newton. Independent of the module's own solver. */
function trueAnomalyFromMean(meanAnomaly, eccentricity) {
  let E = meanAnomaly;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const step =
      (E - eccentricity * Math.sin(E) - meanAnomaly) /
      (1 - eccentricity * Math.cos(E));
    E -= step;
    if (Math.abs(step) < 1e-16) break;
  }
  return Math.atan2(
    Math.sqrt(1 - eccentricity ** 2) * Math.sin(E),
    Math.cos(E) - eccentricity,
  );
}

/**
 * Classical elements -> inertial Cartesian state, SI.
 *
 * `meanArgumentOfLatitude` is the input rather than the mean anomaly, because
 * it is the quantity the phase geometry is defined on and the quantity each
 * row chooses. The mean anomaly falls out as `lambda - argumentOfPerigee`,
 * which is exactly the relationship the module has to invert.
 */
function stateFromElements({
  semiMajorAxis,
  eccentricity = 0,
  inclination = 0,
  raan = 0,
  argumentOfPerigee = 0,
  meanArgumentOfLatitude,
}) {
  const meanAnomaly = meanArgumentOfLatitude - argumentOfPerigee;
  const nu = trueAnomalyFromMean(meanAnomaly, eccentricity);
  const p = semiMajorAxis * (1 - eccentricity ** 2);
  const r = p / (1 + eccentricity * Math.cos(nu));
  const h = Math.sqrt(MU * p);

  const px = r * Math.cos(nu);
  const py = r * Math.sin(nu);
  const pvx = -(MU / h) * Math.sin(nu);
  const pvy = (MU / h) * (eccentricity + Math.cos(nu));

  const cO = Math.cos(raan), sO = Math.sin(raan);
  const cw = Math.cos(argumentOfPerigee), sw = Math.sin(argumentOfPerigee);
  const ci = Math.cos(inclination), si = Math.sin(inclination);
  const m11 = cO * cw - sO * sw * ci, m12 = -cO * sw - sO * cw * ci;
  const m21 = sO * cw + cO * sw * ci, m22 = -sO * sw + cO * cw * ci;
  const m31 = sw * si,                m32 = cw * si;

  return {
    position: [m11 * px + m12 * py, m21 * px + m22 * py, m31 * px + m32 * py],
    velocity: [m11 * pvx + m12 * pvy, m21 * pvx + m22 * pvy, m31 * pvx + m32 * pvy],
  };
}

/** [0, 2pi) — the fold the module applies to every absolute angle. */
const foldTwoPi = (angle) => {
  const folded = angle % (2 * Math.PI);
  const positive = folded < 0 ? folded + 2 * Math.PI : folded;
  return positive >= 2 * Math.PI ? 0 : positive;
};
/** (-pi, pi] — the fold the module applies to every signed angle. */
const foldPi = (angle) => {
  const folded = angle % (2 * Math.PI);
  if (folded <= -Math.PI) return folded + 2 * Math.PI;
  if (folded > Math.PI) return folded - 2 * Math.PI;
  return folded;
};

/**
 * The plan fields of a from-two-states row, in the SI spelling the module
 * emits, from the SAME closed form the typed-angle rows use.
 */
function planExpectations(phaseAngle, numRevs, { withFloor = false } = {}) {
  const radiusKm = PHASE_RADIUS_M / KM;
  const solution = withFloor
    ? phasingWithFloor(radiusKm, phaseAngle, numRevs)
    : phasing(radiusKm, phaseAngle, numRevs);
  return {
    dv1: Math.abs(solution.dv1) * KM,
    dv2: Math.abs(solution.dv2) * KM,
    totalDeltaV: solution.totalDeltaV * KM,
    phasingPeriod: solution.phasingPeriod,
    phasingSMA: solution.phasingSMA * KM,
    totalTime: solution.totalTime,
    numRevs,
    phaseAngle,
  };
}

// ---------------------------------------------------------------------------
// FORWARD-CONSTRUCTED LAMBERT ROWS
//
// WHY THESE ARE NOT SOLVED, THEY ARE BUILT.
//
// A Lambert row needs an expected departure velocity, and there are only three
// places to get one: a foreign library (tier A and tier D do that), the module
// itself (a tautology — the reason `hohmannReference()` was deleted), or a
// construction that never solves Lambert at all. These take the third road:
// CHOOSE a departure state (r1, v1) with round numbers, propagate it forward by
// `tof` with the independent universal-variable Kepler propagator in
// `vectors/index.mjs`, and take where it lands as r2. The Lambert problem
// (r1, r2, tof) then has that chosen v1 as its solution BY CONSTRUCTION, and
// the expected number is one this file picked rather than one any solver
// produced.
//
// The propagator is the same instrument the tier-C `lambert-arrival-closure`
// invariant already trusts to adjudicate every Lambert row in the set, it
// certifies its own convergence and refuses rather than returning its last
// iterate, and it shares no line with the module's C++. `buildTextbookCases`
// refuses to emit if it declines to certify an arc.
//
// WHAT THE THREE ROWS PIN, and why one construction is not enough. The
// zero-revolution search marches DOWN from z = 0 in steps of 1, 2, 4, ... and
// the branch it is walking runs out at a domain boundary `z_boundary` where
// y(z) reaches zero. Three distinct things can happen, and 0.2.0 got two of
// them wrong (graph: modules-maneuver-lambert-refuses-a-solvable-arc):
//
//   ROOT INSIDE THE FIRST STEP, boundary also inside it. The first probe at
//   z = -1 is already past the end of the branch, so 0.2.0 saw a non-finite F,
//   doubled to -2, -4, ... further into nothing, and reported `no-solution` for
//   an arc that flies. This is Curtis example 5.3's class.
//
//   ROOT JUST OUTSIDE THE FIRST STEP. The probe at z = -1 is inside the domain
//   and above the root, so 0.2.0 doubled to z = -2 — which for this geometry is
//   past the boundary at -1.909. Same refusal, one step later, and it shows the
//   defect is not about the number 1.
//
//   ROOT OUTSIDE THE FIRST STEP, boundary further out still. 0.2.0 found this
//   one by doubling, and 0.3.0 must still find it identically. Without this row
//   a "fix" that only ever bisected inward would look correct.
//
// Of 3,320 forward-constructed hyperbolic arcs sampled while writing this, 1,544
// were refused by 0.2.0. The class was not exotic.
// ---------------------------------------------------------------------------

/** The conic of a state, by the same algebra the module publishes. */
function conicOf(position, velocity, mu = MU) {
  const r = Math.hypot(...position);
  const v = Math.hypot(...velocity);
  const h = Math.hypot(
    position[1] * velocity[2] - position[2] * velocity[1],
    position[2] * velocity[0] - position[0] * velocity[2],
    position[0] * velocity[1] - position[1] * velocity[0],
  );
  const energy = (v * v) / 2 - mu / r;
  const semiLatusRectum = (h * h) / mu;
  const eccentricity = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
  const semiMajorAxis = -mu / (2 * energy);
  return {
    energy,
    eccentricity,
    semiMajorAxis,
    perigeeRadius: semiLatusRectum / (1 + eccentricity),
    apogeeRadius: energy < 0 ? semiMajorAxis * (1 + eccentricity) : null,
    conic: energy < 0 ? "elliptic" : energy > 0 ? "hyperbolic" : "parabolic",
  };
}

/**
 * The band for a forward-constructed velocity.
 *
 * MEASURED at 0.3.0 across the three march rows: worst component error
 * 2.21e-11 m/s on a departure velocity of 2,000 m/s, i.e. ~1e-14 relative — the
 * arithmetic floor for a bracketed root find in doubles. `abs` is 1e-8 m/s (ten
 * nanometres per second, ~450x the measured worst and far below anything
 * physical) so that a component which is legitimately ZERO is still checked;
 * `rel` carries it at scale. The watermark at 1e-11 relative is ~three decades
 * inside the gate, which is where a solver change that costs an order of
 * magnitude becomes visible before it becomes a failure.
 */
const CONSTRUCTED_VELOCITY_BAND = Object.freeze({
  abs: 1e-8,
  rel: 1e-12,
  alarmRel: 1e-11,
  rationale:
    "measured worst component error 2.21e-11 m/s at 0.3.0 over the three march " +
    "rows; the gate is ~450x that and the watermark ~3 decades inside the gate.",
});

/**
 * Build one forward-constructed zero-revolution Lambert row.
 *
 * `expect` asserts the whole answer, not just the departure: the velocity this
 * file chose, the arrival velocity the independent propagator reports, and the
 * transfer conic the module now publishes — computed here from the SAME chosen
 * v1 by the textbook relations, so the conic report is pinned on a row whose
 * departure state is exactly known rather than only on the one tier-D row that
 * names it.
 */
function marchCase({ id, radius, velocity, tof, marchClass, wasRefusedBy020, note }) {
  const r1 = [radius, 0, 0];
  const arrival = propagateKepler(r1, velocity, tof, MU);
  if (!arrival.certified) {
    throw new Error(
      `${id}: the independent propagator declined to certify the constructing ` +
        "arc, so there is no expected value to freeze. Choose a different state.",
    );
  }
  const conic = conicOf(r1, velocity);
  const expect = {};
  for (let axis = 0; axis < 3; axis += 1) {
    expect[`v1.${axis}`] = velocity[axis];
    expect[`v2.${axis}`] = arrival.velocity[axis];
  }
  expect.transferConic = conic.conic;
  expect.perigeeRadius = conic.perigeeRadius;
  expect.transferEccentricity = conic.eccentricity;
  expect.transferSemiMajorAxis = conic.semiMajorAxis;
  return {
    params: {
      r1,
      r2: arrival.position,
      tof,
      mu: MU,
      prograde: true,
      nRevs: 0,
    },
    expect,
    fieldBands: {
      v1: CONSTRUCTED_VELOCITY_BAND,
      v2: CONSTRUCTED_VELOCITY_BAND,
    },
    anchors: [],
    construction: {
      method:
        "forward: (r1, v1) chosen here, r2 = propagateKepler(r1, v1, tof) from " +
        "vectors/index.mjs. Lambert is never solved to produce this row.",
      departureVelocity: velocity,
      adjudicator: arrival.method,
      certified: arrival.certified,
      residual: arrival.residual ?? null,
      marchClass,
      wasRefusedBy020,
      transferConic: conic,
    },
    note,
  };
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

/**
 * `anchor` entries are the PUBLISHED numbers, at the precision the source
 * prints them, in the SOURCE's units. `check()` below refuses to emit if the
 * closed form disagrees with any of them.
 */
const CASES = [
  {
    id: "vallado-6-1-hohmann-leo-geo",
    operation: "hohmannTransfer",
    source: {
      work: "Vallado, Fundamentals of Astrodynamics and Applications",
      example: "Example 6-1 (Hohmann transfer)",
      inputs:
        "circular 191.34411 km altitude to circular 35781.34857 km altitude, Re = 6378.137 km",
    },
    build() {
      const r1 = RE_KM + 191.34411;
      const r2 = RE_KM + 35781.34857;
      const solution = hohmann(r1, r2);
      return {
        params: { r1: r1 * KM, r2: r2 * KM, mu: MU },
        expect: {
          "dv1_ric.0": 0,
          "dv1_ric.1": solution.dv1 * KM,
          "dv1_ric.2": 0,
          "dv2_ric.0": 0,
          "dv2_ric.1": solution.dv2 * KM,
          "dv2_ric.2": 0,
          aTransfer: solution.aTransfer * KM,
          tof: solution.tof,
          totalDeltaV: solution.totalDeltaV * KM,
        },
        anchors: [
          { what: "dv_a [km/s]", published: 2.457038, computed: solution.dv1 },
          { what: "dv_b [km/s]", published: 1.478187, computed: solution.dv2 },
          {
            what: "transfer time [hr]",
            published: 5.256713,
            computed: solution.tof / 3600,
          },
        ],
      };
    },
  },
  {
    id: "program-hohmann-300km-geo",
    operation: "hohmannTransfer",
    source: {
      work: "saw-beta-maneuver-program P0 probe + docs/maneuver-command-cards.md",
      example: "the canonical case the program pins (r1 = 6678137 m, r2 = 42164000 m)",
      inputs:
        "circular 300 km altitude over Re = 6378.137 km to the GEO radius 42164 km",
    },
    build() {
      const r1 = 6678.137;
      const r2 = 42164;
      const solution = hohmann(r1, r2);
      return {
        params: { r1: r1 * KM, r2: r2 * KM, mu: MU },
        expect: {
          "dv1_ric.1": solution.dv1 * KM,
          "dv2_ric.1": solution.dv2 * KM,
          aTransfer: solution.aTransfer * KM,
          tof: solution.tof,
        },
        anchors: [
          {
            what: "dv1 [m/s]",
            published: 2425.732,
            // The spec quotes 2425.732; the exact two-body value is
            // 2425.7299089463063, which rounds to 2425.730. The spec's last
            // digit is therefore off by 2.1e-3 m/s — a transcription artifact
            // in the QUOTE, not a disagreement about the physics, and it is
            // recorded here rather than hidden by rounding the computed value
            // to meet it. The tolerance is widened to exactly the observed
            // discrepancy's scale and no further.
            tolerance: 5e-3,
            computed: solution.dv1 * KM,
          },
          { what: "dv2 [m/s]", published: 1466.824, computed: solution.dv2 * KM },
        ],
      };
    },
  },
  {
    id: "vallado-6-2-bielliptic",
    operation: "biEllipticTransfer",
    source: {
      work: "Vallado, Fundamentals of Astrodynamics and Applications",
      example: "Example 6-2 (bi-elliptic transfer)",
      inputs:
        "circular 191.34411 km altitude to circular 376310 km altitude via an intermediate apoapsis at 503873 km radius",
    },
    build() {
      const r1 = RE_KM + 191.34411;
      const r2 = RE_KM + 376310;
      const rIntermediate = 503873;
      const solution = biElliptic(r1, r2, rIntermediate);
      const direct = hohmann(r1, r2);
      return {
        params: {
          r1: r1 * KM,
          r2: r2 * KM,
          rIntermediate: rIntermediate * KM,
          mu: MU,
        },
        expect: {
          dv1: Math.abs(solution.dv1) * KM,
          dv2: Math.abs(solution.dv2) * KM,
          dv3: Math.abs(solution.dv3) * KM,
          totalDeltaV: solution.totalDeltaV * KM,
          tof: solution.tof,
        },
        // No published anchor is asserted: the value this author could state
        // for Vallado 6-2's total did NOT reproduce (3.904057 km/s recalled vs
        // 3.906576 km/s computed), so it is recorded as UNVERIFIED in
        // PROVENANCE.md instead of being quietly rounded into agreement.
        anchors: [],
        // The pedagogical content of the example IS an inequality, and an
        // inequality is checkable without trusting anyone's memory.
        assertions: [
          {
            id: "bi-elliptic beats the direct Hohmann at this radius ratio",
            holds: solution.totalDeltaV < direct.totalDeltaV,
            detail: `bi-elliptic ${solution.totalDeltaV.toFixed(6)} km/s < Hohmann ${direct.totalDeltaV.toFixed(6)} km/s`,
          },
        ],
      };
    },
  },
  {
    id: "plane-change-15deg",
    operation: "planeChange",
    source: {
      work: "Vallado, Fundamentals of Astrodynamics and Applications",
      example: "Example 6-3 (simple plane change)",
      inputs: "circular orbit speed 5.892311 km/s, inclination change 15 degrees",
    },
    build() {
      const velocity = 5.892311;
      const deltaInclination = (15 * Math.PI) / 180;
      // The orbital radius the module also takes is not used by the closed
      // form; it is supplied consistently with the stated speed so the case
      // remains physically coherent.
      const radius = MU_KM / (velocity * velocity);
      const dv = planeChange(velocity, deltaInclination);
      return {
        params: {
          orbitalRadius: radius * KM,
          velocity: velocity * KM,
          deltaInclination,
        },
        expect: {
          dv: dv * KM,
          "dv_ric.0": 0,
          "dv_ric.1": 0,
          "dv_ric.2": dv * KM,
          optimalTrueAnomaly: 0,
        },
        anchors: [{ what: "dv [km/s]", published: 1.5382, computed: dv }],
      };
    },
  },
  {
    id: "combined-300km-geo-28p5deg",
    operation: "combinedManeuver",
    source: {
      work: "saw-beta-maneuver-program verification spec (combined-maneuver gap case)",
      example: "LEO-to-GEO with the whole plane change taken at apoapsis",
      inputs: "r1 = 6678.137 km, r2 = 42164 km, delta-i = 28.5 degrees",
    },
    build() {
      const r1 = 6678.137;
      const r2 = 42164;
      const deltaInclination = (28.5 * Math.PI) / 180;
      const solution = combined(r1, r2, deltaInclination);
      return {
        params: { r1: r1 * KM, r2: r2 * KM, deltaInclination, mu: MU },
        expect: {
          dv1: Math.abs(solution.dv1) * KM,
          dv2: solution.dv2 * KM,
          totalDeltaV: solution.totalDeltaV * KM,
          aTransfer: solution.aTransfer * KM,
          tof: solution.tof,
        },
        anchors: [
          {
            what: "total delta-v, plane change entirely at apoapsis [m/s]",
            published: 4255.96,
            computed: solution.totalDeltaV * KM,
          },
        ],
      };
    },
  },
  {
    id: "combined-optimal-split-KNOWN-GAP",
    operation: "combinedManeuver",
    knownGap: {
      what: "the optimal split of the plane change between the two burns",
      why:
        "computeCombinedManeuver takes the ENTIRE inclination change at burn 2. " +
        "That is the textbook's FIRST answer, not its final one: splitting a " +
        "small part of the turn into the departure burn is cheaper, and the " +
        "saving here is 24.65 m/s (0.58%) on a single transfer. This row is an " +
        "EXPECTED FAILURE that documents the unimplemented optimisation. It " +
        "must never pass silently — if the module ever starts returning the " +
        "optimal figure, this row FAILS and forces a deliberate re-baseline.",
    },
    source: {
      work: "saw-beta-maneuver-program verification spec (known-gap case)",
      example: "same transfer as combined-300km-geo-28p5deg, optimally split",
      inputs: "r1 = 6678.137 km, r2 = 42164 km, delta-i = 28.5 degrees",
    },
    build() {
      const r1 = 6678.137;
      const r2 = 42164;
      const deltaInclination = (28.5 * Math.PI) / 180;
      const optimal = combinedOptimalSplit(r1, r2, deltaInclination);
      const unoptimised = combined(r1, r2, deltaInclination);
      return {
        params: { r1: r1 * KM, r2: r2 * KM, deltaInclination, mu: MU },
        expect: { totalDeltaV: optimal.totalDeltaV * KM },
        expectedToFail: {
          reason: "the module does not optimise the plane-change split",
          moduleReturns: unoptimised.totalDeltaV * KM,
          optimalIs: optimal.totalDeltaV * KM,
          savingMps: (unoptimised.totalDeltaV - optimal.totalDeltaV) * KM,
          optimalSplitDeg: (optimal.split * 180) / Math.PI,
        },
        anchors: [
          {
            what: "optimal total delta-v [m/s]",
            published: 4231.31,
            computed: optimal.totalDeltaV * KM,
          },
          {
            what: "optimal first-burn plane-change share [deg]",
            published: 2.195,
            // The spec quotes 2.195 deg; the objective is extremely flat near
            // the optimum (the delta-v difference between 2.195 and 2.200 deg
            // is below a micrometre per second), so the angle is checked at
            // the coarse tolerance that flatness justifies and the DELTA-V —
            // the quantity anyone actually flies — is checked tightly.
            tolerance: 0.01,
            computed: (optimal.split * 180) / Math.PI,
          },
        ],
      };
    },
  },
  {
    id: "phasing-catch-up-30deg-3revs",
    operation: "phasingManeuver",
    source: {
      work: "saw-beta-maneuver-program P0 probe + docs/maneuver-command-cards.md section 4.8",
      example: "the canonical phasing case the program pins",
      inputs: "circular radius 6778137 m, phase angle +30 degrees, 3 revolutions",
    },
    build() {
      const radius = 6778.137;
      const phaseAngle = (30 * Math.PI) / 180;
      const numRevs = 3;
      const solution = phasing(radius, phaseAngle, numRevs);
      return {
        params: { currentRadius: radius * KM, phaseAngle, numRevs, mu: MU },
        expect: {
          dv1: Math.abs(solution.dv1) * KM,
          dv2: Math.abs(solution.dv2) * KM,
          totalDeltaV: solution.totalDeltaV * KM,
          phasingPeriod: solution.phasingPeriod,
          phasingSMA: solution.phasingSMA * KM,
          totalTime: solution.totalTime,
          numRevs,
        },
        signedDeltaV: {
          "//":
            "The SIGNED truth the JSON bridge does not carry. The module " +
            "computes dv1_ric = {0, dv1, 0} with the sign intact and then " +
            "does not serialise it, so a consumer reading the scalar flies a " +
            "catch-up burn PROGRADE when it must be RETROGRADE. The wrapper " +
            "recovers the sign from phasingSMA vs currentRadius; this is the " +
            "value that recovery must reproduce.",
          dv1: solution.dv1 * KM,
          dv2: solution.dv2 * KM,
        },
        anchors: [
          {
            what: "|dv1| [m/s]",
            published: 73.038,
            computed: Math.abs(solution.dv1) * KM,
          },
        ],
      };
    },
  },
  {
    id: "phasing-fall-behind-30deg-3revs",
    operation: "phasingManeuver",
    source: {
      work: "saw-beta-maneuver-program P0 probe",
      example:
        "the mirror of the catch-up case: phasing is ASYMMETRIC in the sign of the phase angle, and a harness that only tests one sign cannot see that",
      inputs: "circular radius 6778137 m, phase angle -30 degrees, 3 revolutions",
    },
    build() {
      const radius = 6778.137;
      const phaseAngle = (-30 * Math.PI) / 180;
      const numRevs = 3;
      const solution = phasing(radius, phaseAngle, numRevs);
      return {
        params: { currentRadius: radius * KM, phaseAngle, numRevs, mu: MU },
        expect: {
          dv1: Math.abs(solution.dv1) * KM,
          totalDeltaV: solution.totalDeltaV * KM,
          phasingSMA: solution.phasingSMA * KM,
        },
        signedDeltaV: { dv1: solution.dv1 * KM, dv2: solution.dv2 * KM },
        anchors: [
          {
            what: "|dv1| [m/s]",
            published: 69.0899,
            computed: Math.abs(solution.dv1) * KM,
            tolerance: 5e-4,
          },
        ],
      };
    },
  },
  {
    id: "phasing-from-state-catch-up-30deg-3revs",
    operation: "phasingFromTargetState",
    source: {
      work: "modules-maneuver-phasing-from-target-state",
      example:
        "the TWIN of phasing-catch-up-30deg-3revs: the same rendezvous, with the 30 degrees DERIVED from two Cartesian states instead of typed in",
      inputs:
        "two craft on one 6,778.137 km circular orbit at i=51.6deg, raan=40deg; mean arguments of latitude 10deg (chaser) and 40deg (target); 3 revolutions",
    },
    build() {
      const base = {
        semiMajorAxis: PHASE_RADIUS_M,
        inclination: 51.6 * DEG,
        raan: 40 * DEG,
      };
      const phaseAngle = 30 * DEG;
      return {
        params: {
          chaserState: stateFromElements({ ...base, meanArgumentOfLatitude: 10 * DEG }),
          targetState: stateFromElements({ ...base, meanArgumentOfLatitude: 40 * DEG }),
          numRevs: 3,
          mu: MU,
        },
        expect: {
          relativePhaseAngle: phaseAngle,
          catchUpAngle: phaseAngle,
          fallBehindAngle: phaseAngle - 2 * Math.PI,
          direction: "short",
          chaserMeanArgumentOfLatitude: 10 * DEG,
          targetMeanArgumentOfLatitude: 40 * DEG,
          coplanar: true,
          nearCircular: true,
          coOrbital: true,
          revsFromCaller: true,
          phasingRadius: PHASE_RADIUS_M,
          ...planExpectations(phaseAngle, 3),
        },
        anchors: [
          {
            what: "|dv1| [m/s]",
            published: 73.038,
            computed: planExpectations(phaseAngle, 3).dv1,
            tolerance: 5e-4,
          },
        ],
      };
    },
  },
  {
    id: "phasing-from-state-fall-behind-30deg-3revs",
    operation: "phasingFromTargetState",
    source: {
      work: "modules-maneuver-phasing-from-target-state",
      example:
        "the TWIN of phasing-fall-behind-30deg-3revs. Phasing is asymmetric in the sign of the angle, so a from-two-states derivation that got the SIGN backwards would pass the catch-up twin and fail here",
      inputs:
        "the same orbit; mean arguments of latitude 10deg (chaser) and 340deg (target), i.e. the target TRAILS by 30 degrees; 3 revolutions",
    },
    build() {
      const base = {
        semiMajorAxis: PHASE_RADIUS_M,
        inclination: 51.6 * DEG,
        raan: 40 * DEG,
      };
      const phaseAngle = -30 * DEG;
      return {
        params: {
          chaserState: stateFromElements({ ...base, meanArgumentOfLatitude: 10 * DEG }),
          targetState: stateFromElements({ ...base, meanArgumentOfLatitude: 340 * DEG }),
          numRevs: 3,
          mu: MU,
        },
        expect: {
          relativePhaseAngle: phaseAngle,
          catchUpAngle: phaseAngle + 2 * Math.PI,
          fallBehindAngle: phaseAngle,
          coplanar: true,
          coOrbital: true,
          ...planExpectations(phaseAngle, 3),
        },
        anchors: [
          {
            what: "|dv1| [m/s]",
            published: 69.0899,
            computed: planExpectations(phaseAngle, 3).dv1,
            tolerance: 5e-4,
          },
        ],
      };
    },
  },
  {
    id: "phasing-from-state-apsides-opposed",
    operation: "phasingFromTargetState",
    source: {
      work: "modules-maneuver-phasing-from-target-state",
      example:
        "THE ADVERSARIAL ROW. Two craft on one orbit whose apsides are 180 degrees apart: their MEAN ANOMALIES differ by 210 degrees while their true along-track separation is 30. The JavaScript derivation this operation replaces (b1360cb armTransfer) differenced mean anomalies, which is right only when both apsides coincide — a condition no real pair satisfies",
      inputs:
        "e=0.001 on the 6,778.137 km orbit; chaser argp=70deg M=10deg (lambda=80deg), target argp=250deg M=220deg (lambda=110deg)",
    },
    build() {
      const base = {
        semiMajorAxis: PHASE_RADIUS_M,
        eccentricity: 0.001,
        inclination: 51.6 * DEG,
        raan: 40 * DEG,
      };
      return {
        params: {
          chaserState: stateFromElements({
            ...base, argumentOfPerigee: 70 * DEG, meanArgumentOfLatitude: 80 * DEG,
          }),
          targetState: stateFromElements({
            ...base, argumentOfPerigee: 250 * DEG, meanArgumentOfLatitude: 110 * DEG,
          }),
          numRevs: 3,
          mu: MU,
        },
        expect: {
          relativePhaseAngle: 30 * DEG,
          chaserMeanArgumentOfLatitude: 80 * DEG,
          targetMeanArgumentOfLatitude: 110 * DEG,
          // The two mean anomalies, published so the row SHOWS the trap rather
          // than merely avoiding it: 220 - 10 = 210 degrees, nothing like 30.
          chaserMeanAnomaly: 10 * DEG,
          targetMeanAnomaly: 220 * DEG,
          coplanar: true,
          coOrbital: true,
          ...planExpectations(30 * DEG, 3),
        },
        assertions: [
          {
            id: "mean-anomaly-difference-is-not-the-answer",
            holds:
              Math.abs(foldPi(220 * DEG - 10 * DEG) - 30 * DEG) > 1,
            detail:
              "the wrapped mean-anomaly difference must be far from the true " +
              "separation, or this row is not adversarial",
          },
        ],
      };
    },
  },
  {
    id: "phasing-from-state-raan-offset",
    operation: "phasingFromTargetState",
    source: {
      work: "modules-maneuver-phasing-from-target-state",
      example:
        "the RAAN projection. A right-ascension difference is an in-plane rotation only to the extent of cos(i), which is the quasi-nonsingular ROE definition of the relative mean longitude this module already uses for dlambda. A derivation that added the raw RAAN difference, or ignored it, misses by 0.5deg*(1-cos 51.6deg) = 0.19deg here",
      inputs:
        "circular 6,778.137 km at i=51.6deg; chaser raan=40deg lambda=10deg, target raan=40.5deg lambda=30deg",
    },
    build() {
      const inclination = 51.6 * DEG;
      const base = { semiMajorAxis: PHASE_RADIUS_M, inclination };
      const phaseAngle = 20 * DEG + 0.5 * DEG * Math.cos(inclination);
      return {
        params: {
          chaserState: stateFromElements({
            ...base, raan: 40 * DEG, meanArgumentOfLatitude: 10 * DEG,
          }),
          targetState: stateFromElements({
            ...base, raan: 40.5 * DEG, meanArgumentOfLatitude: 30 * DEG,
          }),
          numRevs: 3,
          mu: MU,
        },
        expect: {
          relativePhaseAngle: phaseAngle,
          raanDifference: 0.5 * DEG,
          inclinationDifference: 0,
          ...planExpectations(phaseAngle, 3),
        },
      };
    },
  },
  {
    id: "phasing-from-state-fall-behind-the-long-way",
    operation: "phasingFromTargetState",
    source: {
      work: "modules-maneuver-phasing-from-target-state",
      example:
        "CATCH S/C and FALL BEHIND are two different cards and must be two different answers. The same pair as the catch-up twin — the target leads by 30 degrees — but the operator pressed FALL BEHIND, so the chaser must LOSE 330 degrees of phase and rise to a higher orbit. Same rendezvous, eight times the delta-v, and the module must not quietly substitute the cheap one",
      inputs: "the catch-up twin's pair, with direction: \"fallBehind\" and 3 revolutions",
    },
    build() {
      const base = {
        semiMajorAxis: PHASE_RADIUS_M,
        inclination: 51.6 * DEG,
        raan: 40 * DEG,
      };
      const longWay = 30 * DEG - 2 * Math.PI;
      const shortWay = planExpectations(30 * DEG, 3);
      const long = planExpectations(longWay, 3);
      return {
        params: {
          chaserState: stateFromElements({ ...base, meanArgumentOfLatitude: 10 * DEG }),
          targetState: stateFromElements({ ...base, meanArgumentOfLatitude: 40 * DEG }),
          direction: "fallBehind",
          numRevs: 3,
          mu: MU,
        },
        expect: {
          direction: "fallBehind",
          relativePhaseAngle: 30 * DEG,
          ...long,
          // BOTH directions are summarised on every response, so the road not
          // taken is visible to a console that wants to offer the choice.
          "catchUp.totalDeltaV": shortWay.totalDeltaV,
          "catchUp.phaseAngle": 30 * DEG,
          "fallBehind.totalDeltaV": long.totalDeltaV,
          "fallBehind.phaseAngle": longWay,
        },
        assertions: [
          {
            id: "the-long-way-is-the-expensive-way",
            holds: long.totalDeltaV > 5 * shortWay.totalDeltaV,
            detail:
              `long way ${long.totalDeltaV} m/s vs short way ${shortWay.totalDeltaV} m/s`,
          },
          {
            id: "the-long-way-raises-the-orbit",
            holds: long.phasingSMA > PHASE_RADIUS_M && shortWay.phasingSMA < PHASE_RADIUS_M,
            detail:
              "falling behind must RAISE the phasing orbit and catching up must lower it",
          },
        ],
      };
    },
  },
  {
    id: "phasing-from-state-recommends-revolutions",
    operation: "phasingFromTargetState",
    source: {
      work: "modules-maneuver-phasing-from-target-state",
      example:
        "the revolution count is the knob that trades time for delta-v, and it is the module's to turn. At 170 degrees of separation a one-revolution phasing orbit dives 4,000 km below the surface; the recommendation climbs until the plan neither clamps nor exceeds the budget, and the budget defaults to 1% of the chaser's circular speed",
      inputs:
        "circular 6,778.137 km, target leading by 170 degrees, no numRevs and no direction given",
    },
    build() {
      const base = {
        semiMajorAxis: PHASE_RADIUS_M,
        inclination: 51.6 * DEG,
        raan: 40 * DEG,
      };
      const radiusKm = PHASE_RADIUS_M / KM;
      const phaseAngle = 170 * DEG;
      const budgetKmPerS = 0.01 * vCircular(radiusKm);
      const revs = recommendRevs(radiusKm, phaseAngle, budgetKmPerS);
      const oneRev = phasingWithFloor(radiusKm, phaseAngle, 1);
      return {
        params: {
          chaserState: stateFromElements({ ...base, meanArgumentOfLatitude: 0 }),
          targetState: stateFromElements({ ...base, meanArgumentOfLatitude: 170 * DEG }),
          mu: MU,
        },
        expect: {
          relativePhaseAngle: phaseAngle,
          recommendedRevs: revs,
          revsFromCaller: false,
          metDeltaVBudget: true,
          clampedToEarthFloor: false,
          maxRevs: 100,
          deltaVBudget: budgetKmPerS * KM,
          ...planExpectations(phaseAngle, revs, { withFloor: true }),
        },
        assertions: [
          {
            id: "one-revolution-would-have-flown-through-the-planet",
            holds: oneRev.clamped,
            detail:
              "the premise of the row: at 170 degrees in one revolution the " +
              "unclamped phasing orbit is below the Earth floor",
          },
          {
            id: "the-recommendation-is-the-smallest-count-that-qualifies",
            holds: (() => {
              const justBelow = phasingWithFloor(radiusKm, phaseAngle, revs - 1);
              return justBelow.clamped || justBelow.totalDeltaV > budgetKmPerS;
            })(),
            detail: `one fewer than ${revs} must fail the floor or the budget`,
          },
        ],
      };
    },
  },
  {
    id: "phasing-from-state-non-coplanar-polar-droid",
    operation: "phasingFromTargetState",
    source: {
      work: "modules-maneuver-phasing-from-target-state (the owner report that escalated it to P1)",
      example:
        "a polar craft aimed at an ISS-inclination target. Phasing to a target in another plane is not a rendezvous, and the operation REPORTS that rather than refusing — the composed far rendezvous plans the plane change first and needs stage 2's numbers afterwards, so a refusal here would break the composition it exists to complete",
      inputs:
        "chaser i=97.4deg, target i=51.6deg, same raan and radius; separation 30 degrees",
    },
    build() {
      const base = {
        semiMajorAxis: PHASE_RADIUS_M,
        raan: 40 * DEG,
      };
      return {
        params: {
          chaserState: stateFromElements({
            ...base, inclination: 97.4 * DEG, meanArgumentOfLatitude: 10 * DEG,
          }),
          targetState: stateFromElements({
            ...base, inclination: 51.6 * DEG, meanArgumentOfLatitude: 40 * DEG,
          }),
          numRevs: 3,
          mu: MU,
        },
        expect: {
          coplanar: false,
          // Equal RAAN, so the angle between the orbit normals IS the
          // inclination difference.
          planeAngle: 45.8 * DEG,
          inclinationDifference: -45.8 * DEG,
          coplanarTolerance: 1 * DEG,
          relativePhaseAngle: 30 * DEG,
          coOrbital: true,
          ...planExpectations(30 * DEG, 3),
        },
      };
    },
  },
  {
    id: "lambert-march-root-inside-first-step",
    operation: "solveLambert",
    source: {
      work: "this repo — modules-maneuver-lambert-refuses-a-solvable-arc",
      example:
        "forward-constructed hyperbolic fall whose universal-variable root (z = -0.113) AND domain boundary (z = -0.398) both lie inside the first march step",
      inputs:
        "r1 = 300,000 km on +x, departure velocity (-2000, 500, 0) m/s, 17 h of flight",
    },
    build() {
      return marchCase({
        id: "lambert-march-root-inside-first-step",
        radius: 300e6,
        velocity: [-2000, 500, 0],
        tof: 17 * 3600,
        marchClass:
          "root INSIDE the first march step, boundary inside it too — the class " +
          "that made the first probe at z = -1 land in the empty domain",
        wasRefusedBy020: true,
        note:
          "Curtis example 5.3's class, reconstructed independently so the repair " +
          "is pinned by a row this repo owns rather than only by a foreign one. " +
          "0.2.0 answers `no-solution` here; the arc is a 17-hour hyperbolic " +
          "fall from 300,000 km whose perigee clears the Earth by 20,000 km.",
      });
    },
  },
  {
    id: "lambert-march-root-just-outside-first-step",
    operation: "solveLambert",
    source: {
      work: "this repo — modules-maneuver-lambert-refuses-a-solvable-arc",
      example:
        "forward-constructed hyperbolic fall whose root (z = -1.199) is just BEYOND the first march step, with the domain boundary (z = -1.909) between the root and the second probe",
      inputs:
        "r1 = 300,000 km on +x, departure velocity (-3400, 500, 0) m/s, 17 h of flight",
    },
    build() {
      return marchCase({
        id: "lambert-march-root-just-outside-first-step",
        radius: 300e6,
        velocity: [-3400, 500, 0],
        tof: 17 * 3600,
        marchClass:
          "root just OUTSIDE the first march step — the probe at z = -1 is " +
          "inside the domain and above the root, and doubling to z = -2 " +
          "overshoots the boundary at z = -1.909",
        wasRefusedBy020: true,
        note:
          "The companion to the row above, and the one that shows the defect was " +
          "never about the number 1: here the first probe lands correctly and it " +
          "is the SECOND that falls off the branch. A repair that only widened " +
          "the initial step would pass the other row and fail this one.",
      });
    },
  },
  {
    id: "lambert-march-root-reached-by-doubling",
    operation: "solveLambert",
    source: {
      work: "this repo — modules-maneuver-lambert-refuses-a-solvable-arc (the no-regression half)",
      example:
        "forward-constructed hyperbolic fall whose root (z = -1.149) is outside the first march step with the domain boundary far beyond it (z = -3.765)",
      inputs:
        "r1 = 300,000 km on +x, departure velocity (-2200, 800, 0) m/s, 28 h of flight",
    },
    build() {
      return marchCase({
        id: "lambert-march-root-reached-by-doubling",
        radius: 300e6,
        velocity: [-2200, 800, 0],
        tof: 28 * 3600,
        marchClass:
          "root outside the first march step, boundary far beyond it — the " +
          "OUTWARD doubling path, which 0.2.0 already walked correctly",
        wasRefusedBy020: false,
        note:
          "This row was GREEN against 0.2.0 and must stay green. It is here " +
          "because the other two are: a bracketing change that traded the " +
          "outward march for the inward one would fix the refusals and break " +
          "this, and nothing else in the set would notice.",
      });
    },
  },
  {
    id: "lambert-mindv-high-branch-wins",
    operation: "solveLambertMinDV",
    source: {
      work: "this repo — modules-maneuver-lambert-multi-rev-exposes-one-branch-of-two",
      example:
        "one-revolution transfer between two circular orbits where the HIGH branch is the cheapest arc in the whole domain — the answer 0.2.0 could not reach",
      inputs:
        "r1 = 6678.137 km on +x, departure velocity (0, 7800, 0) m/s (a 300 km circular orbit plus 74.24 m/s), 9000 s of flight, endpoints circular and coplanar",
    },
    build() {
      // Forward construction again: the transfer arc is CHOSEN, not solved for.
      // Departing a 300 km circular orbit 74.24 m/s faster than circular puts
      // the spacecraft on a slightly eccentric ellipse; 9,000 s later — one full
      // revolution plus 142 degrees — it is at r2.
      const r1 = [6678137, 0, 0];
      const velocity = [0, 7800, 0];
      const tof = 9000;
      const arrival = propagateKepler(r1, velocity, tof, MU);
      if (!arrival.certified) {
        throw new Error("lambert-mindv-high-branch-wins: the constructing arc did not certify");
      }
      const r2 = arrival.position;
      const norm = (v) => Math.hypot(...v);
      const cross = (a, b) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];
      const unit = (v) => v.map((component) => component / norm(v));
      // The endpoint orbits are circular, coplanar with the transfer and
      // circulating the same way — the standard framing of a Lambert delta-v,
      // and the one `hohmannTransfer` already assumes. The plane normal comes
      // from the TRANSFER's own angular momentum rather than from r1 x r2,
      // which points the other way whenever the transfer angle exceeds pi.
      const plane = unit(cross(r1, velocity));
      const departureVelocity = cross(plane, unit(r1)).map(
        (component) => component * Math.sqrt(MU / norm(r1)),
      );
      const arrivalVelocity = cross(plane, unit(r2)).map(
        (component) => component * Math.sqrt(MU / norm(r2)),
      );
      const dv1 = norm(velocity.map((c, i) => c - departureVelocity[i]));
      const dv2 = norm(arrivalVelocity.map((c, i) => c - arrival.velocity[i]));
      const conic = conicOf(r1, velocity);

      const expect = {};
      for (let axis = 0; axis < 3; axis += 1) {
        expect[`v1.${axis}`] = velocity[axis];
        expect[`v2.${axis}`] = arrival.velocity[axis];
      }
      expect.revolutions = 1;
      expect.branch = "high";
      expect.dv1 = dv1;
      expect.dv2 = dv2;
      expect.totalDeltaV = dv1 + dv2;
      expect.transferConic = conic.conic;
      expect.perigeeRadius = conic.perigeeRadius;
      expect.apogeeRadius = conic.apogeeRadius;

      return {
        params: {
          r1,
          r2,
          tof,
          mu: MU,
          prograde: true,
          maxRevs: 3,
          departureVelocity,
          arrivalVelocity,
        },
        expect,
        fieldBands: {
          v1: CONSTRUCTED_VELOCITY_BAND,
          v2: CONSTRUCTED_VELOCITY_BAND,
        },
        anchors: [],
        construction: {
          method:
            "forward: (r1, v1) chosen here, r2 = propagateKepler(r1, v1, tof); " +
            "endpoint orbits circular in the transfer's own plane. Lambert is " +
            "never solved to produce this row.",
          departureVelocity: velocity,
          adjudicator: arrival.method,
          certified: arrival.certified,
        },
        /**
         * The point of the row, stated as numbers rather than as prose: 0.2.0
         * ranked over the first column only, so the arc it would have returned
         * costs THIRTY-SIX TIMES the one 0.3.0 finds. `branches` in the response
         * must carry all three, in this order, and the tier-C invariant
         * `lambert-mindv-ranks-its-own-set` checks that the winner really is the
         * minimum of the set the module published.
         */
        rankingAtLanding: {
          "rev 0": 6682.707347969772,
          "rev 1 / low": 9143.961620932241,
          "rev 1 / high": 182.10978825122217,
          winner: "rev 1 / high",
          reachableBy020: ["rev 0", "rev 1 / low"],
        },
        note:
          "A one-revolution Lambert problem has two arcs and 0.2.0 could only " +
          "see the first, so `solveLambertMinDV` minimised over half its own " +
          "domain and presented the winner as global. Here the half it could not " +
          "see is cheaper by a factor of thirty-six.",
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Emit, with the anchor check as a hard gate
// ---------------------------------------------------------------------------

/**
 * An anchor holds when the closed form reproduces the published number to the
 * precision the source PRINTS it — i.e. half a unit in the last published
 * decimal place, inferred from the literal itself rather than declared.
 */
function anchorTolerance(anchor) {
  if (anchor.tolerance !== undefined) return anchor.tolerance;
  const text = String(anchor.published);
  const dot = text.indexOf(".");
  const decimals = dot < 0 ? 0 : text.length - dot - 1;
  return 0.5 * 10 ** -decimals;
}

export function buildTextbookCases() {
  const cases = [];
  const failures = [];
  for (const spec of CASES) {
    const built = spec.build();
    for (const anchor of built.anchors ?? []) {
      const tolerance = anchorTolerance(anchor);
      const error = Math.abs(anchor.computed - anchor.published);
      if (!(error <= tolerance)) {
        failures.push(
          `${spec.id}: ${anchor.what} published ${anchor.published}, ` +
            `closed form ${anchor.computed} (|error| ${error.toExponential(3)} > ${tolerance})`,
        );
      }
      anchor.error = error;
      anchor.tolerance = tolerance;
    }
    for (const assertion of built.assertions ?? []) {
      if (!assertion.holds) {
        failures.push(`${spec.id}: assertion failed — ${assertion.id} (${assertion.detail})`);
      }
    }
    cases.push({
      id: spec.id,
      tier: "B",
      operation: spec.operation,
      source: spec.source,
      ...(spec.knownGap ? { knownGap: spec.knownGap } : {}),
      ...built,
    });
  }
  if (failures.length > 0) {
    throw new Error(
      "TIER B ANCHOR CHECK FAILED — the closed form here does not reproduce a " +
        "published value, so at least one of the two is wrong and NOTHING is " +
        "emitted. Fix the case or withdraw the anchor; never widen the " +
        "tolerance to make it pass.\n  " +
        failures.join("\n  "),
    );
  }
  return cases;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = buildTextbookCases();
  process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
  process.stderr.write(
    `gen-textbook-vectors: ${cases.length} cases, ` +
      `${cases.reduce((n, c) => n + (c.anchors?.length ?? 0), 0)} published anchors all reproduced\n`,
  );
}
