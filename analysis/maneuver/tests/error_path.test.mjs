/**
 * THE ERROR PATH, over the $MPL wire.
 *
 * The contract under test is the SDK doctrine — a module fails closed with a
 * status code rather than trapping — asserted in the form that matters:
 *
 *   1. Every refused request returns a STRUCTURED result: non-zero statusCode,
 *      a stable errorCode, and a $MPL answer on `plan` carrying STATUS,
 *      ERROR_CODE and ERROR_MESSAGE.
 *   2. The SAME instance answers correctly afterwards: the whole probe set runs
 *      against ONE harness and a known-good call closes the sequence.
 *   3. The module's own validator messages are observable on the plan.
 *
 * Plus a FUZZ pass: hostile values in every numeric field of every problem's
 * request, and hostile byte payloads, on one instance, asserting only that the
 * module never traps and every answer it emits is a readable $MPL.
 *
 * What the 0.6.x JSON suite also probed and the typed wire makes
 * unrepresentable — a string where a number belongs, an unknown key, a
 * misspelled direction or branch NAME, a malformed JSON text — is now refused
 * by type before the request is built; the closest typed forms (out-of-range
 * enum values, missing tables, non-$MPL bytes) are probed instead.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
} from "space-data-module-sdk/testing/isomorphic";
import { M, encodeRequest, packPlan, probeOperation, probePlan } from "./mpl_client.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MU = 398600441800000.0;

/** A request built from a 0.6.x command, then edited in its typed form. */
function typed(operation, params, edit = () => {}) {
  const { plan } = encodeRequest(operation, params);
  edit(plan);
  return plan;
}

const REFUSALS = [
  {
    id: "unspecified-problem",
    plan: typed("hohmannTransfer", { r1: 7000000, r2: 40000000 }, (p) => { p.PROBLEM = M.mplProblem.Unspecified; }),
    errorCode: "invalid-parameter",
    messageIncludes: "PROBLEM",
  },
  {
    id: "problem-out-of-range",
    plan: typed("hohmannTransfer", { r1: 7000000, r2: 40000000 }, (p) => { p.PROBLEM = 200; }),
    errorCode: "invalid-parameter",
    messageIncludes: "PROBLEM",
  },
  {
    id: "missing-request-table",
    plan: typed("hohmannTransfer", { r1: 7000000, r2: 40000000 }, (p) => { p.REQUEST = null; }),
    errorCode: "invalid-parameter",
    messageIncludes: "REQUEST",
  },
  {
    id: "missing-problem-sub-table",
    plan: typed("hohmannTransfer", { r1: 7000000, r2: 40000000 }, (p) => { p.REQUEST.TRANSFER = null; }),
    errorCode: "invalid-parameter",
    messageIncludes: "TRANSFER",
  },
  {
    id: "missing-required-param",
    plan: typed("hohmannTransfer", { r1: 7000000 }),
    errorCode: "invalid-parameter",
    messageIncludes: '"r2"',
  },
  {
    id: "validator-negative-radius",
    plan: typed("phasingManeuver", { currentRadius: -7000000, phaseAngle: 0.5, numRevs: 1 }),
    errorCode: "invalid-parameter",
    messageIncludes: "[phasing]: Orbit radius must be positive",
  },
  {
    id: "boundary-negative-radius",
    plan: typed("hohmannTransfer", { r1: -7000000, r2: 40000000 }),
    errorCode: "invalid-parameter",
    messageIncludes: "must be positive",
  },
  {
    id: "phasing-from-state-both-craft-forms",
    plan: typed("phasingFromTargetState", {
      chaser: { semiMajorAxis: 6778137 },
      chaserState: { position: [6778137, 0, 0], velocity: [0, 7668, 0] },
      target: { semiMajorAxis: 6778137 },
    }),
    errorCode: "invalid-parameter",
    messageIncludes: "both were given",
  },
  {
    id: "phasing-from-state-neither-craft-form",
    plan: typed("phasingFromTargetState", { target: { semiMajorAxis: 6778137 } }),
    errorCode: "invalid-parameter",
    messageIncludes: "neither was given",
  },
  {
    id: "phasing-from-state-direction-out-of-range",
    plan: typed("phasingFromTargetState", { chaser: { semiMajorAxis: 6778137 }, target: { semiMajorAxis: 6778137 } },
      (p) => { p.REQUEST.PHASING.DIRECTION = 9; }),
    errorCode: "invalid-parameter",
    messageIncludes: "DIRECTION",
  },
  {
    // The planner's co-orbital threshold is relative to the chaser's semi-major
    // axis; $MPL states an absolute one, which is refused rather than guessed.
    id: "phasing-from-state-co-orbital-basis-out-of-range",
    plan: typed("phasingFromTargetState", { chaser: { semiMajorAxis: 6778137 }, target: { semiMajorAxis: 6778137 } },
      (p) => {
        p.REQUEST.PHASING.HAS_CO_ORBITAL_TOLERANCE = true;
        p.REQUEST.PHASING.CO_ORBITAL_TOLERANCE = 5;
        p.REQUEST.PHASING.CO_ORBITAL_TOLERANCE_BASIS = 9;
      }),
    errorCode: "invalid-parameter",
    messageIncludes: "CO_ORBITAL_TOLERANCE_BASIS",
  },
  {
    id: "phasing-stated-zero-revolutions",
    plan: typed("phasingManeuver", { currentRadius: 6778137, phaseAngle: 0.5 },
      (p) => { p.REQUEST.PHASING.HAS_REVOLUTIONS = true; p.REQUEST.PHASING.REVOLUTIONS = 0; }),
    errorCode: "invalid-parameter",
    messageIncludes: "revolutions",
  },
  {
    id: "phasing-from-state-escape-trajectory",
    plan: typed("phasingFromTargetState", {
      chaserState: { position: [7000000, 0, 0], velocity: [0, 12000, 0] },
      targetState: { position: [7000000, 0, 0], velocity: [0, 7546, 0] },
    }),
    errorCode: "no-solution",
    messageIncludes: "escape trajectory",
  },
  {
    id: "phasing-from-state-rectilinear",
    plan: typed("phasingFromTargetState", {
      chaserState: { position: [7000000, 0, 0], velocity: [1000, 0, 0] },
      targetState: { position: [7000000, 0, 0], velocity: [0, 7546, 0] },
    }),
    errorCode: "singular-configuration",
    messageIncludes: "rectilinear",
  },
  {
    id: "unsupported-stm-model",
    plan: typed("computeRoeStateTransition", { model: "j2", deltaTime: 100, chief: { semiMajorAxis: 6778000 } },
      (p) => { p.REQUEST.RELATIVE.STM_DYNAMICS = 9; }),
    errorCode: "invalid-parameter",
    messageIncludes: "STM_DYNAMICS",
  },
  {
    id: "lambert-antipodal-has-no-unique-solution",
    plan: typed("solveLambert", { r1: [6778000, 0, 0], r2: [-6778000, 0, 0], tof: 2700, mu: MU }),
    errorCode: "no-solution",
    messageIncludes: "no solution",
  },
  {
    id: "lambert-mindv-without-endpoints-is-refused",
    plan: typed("solveLambertMinDV", { r1: [6778000, 0, 0], r2: [0, 7078000, 0], tof: 2700, mu: MU }),
    errorCode: "invalid-parameter",
    messageIncludes: "departureVelocity",
  },
  {
    id: "lambert-branch-out-of-range",
    plan: typed("solveLambert", {
      r1: [22592145.603, -1599915.239, -19783950.506], r2: [1922067.697, 4054157.051, -8925727.465],
      tof: 36000, mu: MU, nRevs: 1,
    }, (p) => { p.REQUEST.LAMBERT.BRANCH = 7; }),
    errorCode: "invalid-parameter",
    messageIncludes: "BRANCH",
  },
  {
    id: "delta-v-transform-unnamed-axes",
    plan: typed("transformDeltaV", { position: [7000000, 0, 0], velocity: [0, 7546, 0], deltaV: [1, 2, 3] },
      (p) => { p.REQUEST.GEOMETRY.BURN.AXES = M.mplAxes.Unspecified; }),
    errorCode: "invalid-parameter",
    messageIncludes: "RIC",
  },
  {
    id: "delta-v-transform-impossible-target-axes",
    plan: typed("transformDeltaV", { position: [7000000, 0, 0], velocity: [0, 7546, 0], deltaV: [1, 2, 3], from: "RIC" },
      (p) => { p.REQUEST.GEOMETRY.TO_AXES = M.mplAxes.VNC; }),
    errorCode: "invalid-parameter",
    messageIncludes: "TO_AXES",
  },
];

function assertRefusal(outcome, refusal) {
  assert.equal(outcome.trapped, false, `${refusal.id} TRAPPED: ${outcome.error}. No input may trap this module.`);
  assert.notEqual(outcome.statusCode, 0, `${refusal.id} reported success`);
  assert.equal(outcome.errorCode, refusal.errorCode);
  assert.equal(outcome.planError, null, `${refusal.id} answer is not a readable $MPL`);
  assert.ok(outcome.plan, `${refusal.id} emitted no plan frame`);
  assert.notEqual(outcome.plan.STATUS, M.mplStatus.Solved);
  assert.notEqual(outcome.plan.STATUS, M.mplStatus.Pending);
  assert.equal(outcome.plan.ERROR_CODE, refusal.errorCode);
  assert.ok(
    String(outcome.plan.ERROR_MESSAGE).includes(refusal.messageIncludes),
    `${refusal.id}: message ${JSON.stringify(outcome.plan.ERROR_MESSAGE)} does not name ` +
      JSON.stringify(refusal.messageIncludes),
  );
}

const HOHMANN = { operation: "hohmannTransfer", params: { r1: 6678137, r2: 42164000, mu: MU } };

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`every refusal is a structured error and the instance survives on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) return;
    t.after(async () => {
      await harness.destroy();
    });

    for (const refusal of REFUSALS) {
      await t.test(refusal.id, async () => {
        assertRefusal(await probePlan(harness, refusal.plan), refusal);
      });
    }

    await t.test("bytes that are not a $MPL are refused, not trapped", async () => {
      const good = packPlan(encodeRequest(HOHMANN.operation, HOHMANN.params).plan);
      const wrongIdentifier = good.slice();
      wrongIdentifier.set([0x24, 0x58, 0x58, 0x58], 4); // "$XXX"
      for (const bytes of [new Uint8Array(0), new Uint8Array(16), good.slice(0, good.length >> 1), wrongIdentifier,
        Uint8Array.from({ length: 512 }, (_, i) => (i * 131 + 7) & 0xff)]) {
        const outcome = await probePlan(harness, bytes);
        assert.equal(outcome.trapped, false, outcome.error);
        assert.notEqual(outcome.statusCode, 0);
      }
    });

    await t.test("the same instance still computes after every refusal", async () => {
      const outcome = await probeOperation(harness, HOHMANN);
      assert.equal(outcome.trapped, false);
      assert.equal(outcome.statusCode, 0);
      // The canonical answer, unchanged from the 0.1.0 recorded transcript.
      assert.equal(outcome.body.totalDeltaV, 3892.5543868908976);
    });
  });
}

// ---------------------------------------------------------------------------
// FUZZ
// ---------------------------------------------------------------------------

const HOSTILE = [0, -1, 1e308, -1e308, 1e-308, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0.1,
  NaN, Infinity, -Infinity];
const HOSTILE_UINT = [0, 1, 0x7fffffff, 0xffffffff];
const HOSTILE_VECTORS = [[], [1, 2, 3, 4], [NaN, NaN, NaN], [1e308, -1e308, 0]];

/** Every problem with a known-good request to mutate. */
const OPERATIONS = [
  ["hohmannTransfer", { r1: 6678137, r2: 42164000, mu: MU }],
  ["biEllipticTransfer", { r1: 6678137, r2: 42164000, rIntermediate: 120000000, mu: MU }],
  ["planeChange", { orbitalRadius: 11480000, velocity: 5892.311, deltaInclination: 0.26 }],
  ["combinedManeuver", { r1: 6678137, r2: 42164000, deltaInclination: 0.497, mu: MU }],
  ["phasingManeuver", { currentRadius: 6778137, phaseAngle: 0.5236, numRevs: 3, mu: MU }],
  ["solveLambert", { r1: [12756272, 0, 0], r2: [12756272, 22094511.219168257, 0], tof: 4033.9, mu: MU, prograde: true, nRevs: 0, branch: "low" }],
  ["solveLambertMinDV", {
    r1: [6678137, 0, 0], r2: [0, 7078137, 0], tof: 3000, mu: MU, maxRevs: 2,
    departureVelocity: [0, 7725.8, 0], arrivalVelocity: [-7503.4, 0, 0], branch: "high",
  }],
  ["computeCAM", {
    initialState: { position: [50, 0, 0], velocity: [0, -0.02, 0] },
    chief: { semiMajorAxis: 6778000, eccentricity: 0, inclination: 0, mu: MU },
    config: { minMissDistance: 1000, timeToTCA: 600, maxDeltaV: 10 },
  }],
  ["computeRoeStateTransition", {
    model: "j2", deltaTime: 1200, initialRoe: [1e-5, 2e-5, 1e-6, 2e-6, 3e-6, 4e-6],
    chief: { semiMajorAxis: 6778000, eccentricity: 0.001, inclination: 0.9, mu: MU },
  }],
  ["phasingFromTargetState", {
    chaserState: { position: [6778137, 0, 0], velocity: [0, 4765.6, 6003.9] },
    targetState: { position: [5871119.9, 3389068.5, 0], velocity: [-2382.8, 4127.2, 6003.9] },
    mu: MU, numRevs: 3, maxRevs: 100, direction: "short", deltaVBudget: 80, deltaVBudgetFraction: 0.01,
    coplanarTolerance: 0.0174533, eccentricityTolerance: 0.01,
  }],
  ["evaluateOrbitGeometry", {
    mu: MU, elements: { semiMajorAxis: 7000000, eccentricity: 0.01, inclination: 1.4, raan: 0.35, argumentOfPeriapsis: 1.4, meanAnomaly: 0.7 },
    elapsedSeconds: 600, deltaV: [0, 10, 0], deltaVFrame: "RIC",
  }],
];

/** Every numeric leaf of a typed request, as [holder, key, kind]. */
function leaves(object, out = []) {
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") out.push([object, key, Number.isInteger(value) && /REVOLUTIONS|COUNT|ITERATIONS|SAMPLES|EVERY/.test(key) ? "uint" : "number"]);
    else if (Array.isArray(value)) {
      if (key !== "WAYPOINTS" && value.every((x) => typeof x === "number")) out.push([object, key, "vector"]);
      else value.forEach((x) => typeof x === "object" && leaves(x, out));
    } else if (typeof value === "object" && typeof value !== "bigint") leaves(value, out);
  }
  return out;
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`fuzz: no input traps the module on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) return;
    t.after(async () => {
      await harness.destroy();
    });

    let calls = 0;
    const traps = [];
    const unreadable = [];
    const check = (label, outcome) => {
      calls += 1;
      if (outcome.trapped) traps.push(`${label}: ${outcome.error}`);
      else if (!outcome.plan) unreadable.push(`${label}: no $MPL answer (${outcome.planError ?? outcome.errorCode})`);
    };

    for (const [operation, baseline] of OPERATIONS) {
      const count = leaves(encodeRequest(operation, baseline).plan.REQUEST).length;
      for (let index = 0; index < count; index += 1) {
        const [, key, kind] = leaves(encodeRequest(operation, baseline).plan.REQUEST)[index];
        const values = kind === "uint" ? HOSTILE_UINT : kind === "vector" ? HOSTILE_VECTORS : HOSTILE;
        for (const hostile of values) {
          const { plan } = encodeRequest(operation, baseline);
          const [holder] = leaves(plan.REQUEST)[index];
          holder[key] = hostile;
          check(`${operation}.${key}=${JSON.stringify(hostile)}`, await probePlan(harness, plan));
        }
      }
    }

    assert.deepEqual(traps, [], `${traps.length} of ${calls} fuzz inputs TRAPPED the module`);
    assert.deepEqual(unreadable, [], "answers that were not a readable $MPL");

    // The instance is still alive after all of it.
    const alive = await probeOperation(harness, HOHMANN);
    assert.equal(alive.trapped, false);
    assert.equal(alive.statusCode, 0);
    assert.equal(alive.body.totalDeltaV, 3892.5543868908976);
    console.error(`[${runtimeKind}] fuzz: ${calls} hostile inputs, 0 traps, instance alive`);
  });
}
