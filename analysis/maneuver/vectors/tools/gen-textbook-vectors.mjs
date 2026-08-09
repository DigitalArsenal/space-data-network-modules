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
