/**
 * THE ERROR PATH — the thing 0.1.0 did not have.
 *
 * This file replaces `vectors.test.mjs`'s "bad input traps rather than erroring"
 * section, which ASSERTED the defect: every bad input aborted the guest with
 * `RuntimeError: unreachable`, and the trap poisoned the instance so hard that
 * the old suite had to construct a fresh harness per probe.
 *
 * The contract now under test is the SDK doctrine — a module fails closed with
 * a status code rather than trapping — and it is asserted in the form that
 * matters:
 *
 *   1. Every probe returns a STRUCTURED result: non-zero statusCode, a stable
 *      errorCode, and a response frame carrying {error, errorCode}.
 *   2. The SAME instance answers correctly afterwards. This is the property
 *      that makes the module usable from a long-lived host at all, and no
 *      per-probe assertion can stand in for it: the whole probe set runs
 *      against ONE harness and a known-good call closes the sequence.
 *   3. The module's own validator messages are observable. "[phasing]: Number
 *      of revolutions must be >= 1" was written by the author of that function
 *      and had never once reached a caller.
 *
 * Plus a FUZZ pass: 16 hostile values in every parameter position of every
 * wired operation, on one instance, asserting only that the module never traps
 * and never emits a body that is not JSON. The corpus mirrors the one the
 * console wrapper's own tests use.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MU = 398600441800000.0;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Invoke with RAW bytes and return the outcome, never throwing. A helper that
 * throws on a non-zero status cannot tell "returned an error" from "trapped",
 * which is the exact distinction this file exists to make.
 */
async function probe(harness, bodyText) {
  try {
    const response = await harness.invoke({
      methodId: "invoke",
      inputs: [{ portId: "request", payload: encoder.encode(bodyText) }],
    });
    const frame = response.outputs?.find((entry) => entry.portId === "response");
    let body = null;
    let bodyError = null;
    if (frame) {
      try {
        body = JSON.parse(decoder.decode(frame.payload));
      } catch (error) {
        bodyError = String(error);
      }
    }
    return {
      trapped: false,
      statusCode: response.statusCode,
      errorCode: response.errorCode,
      body,
      bodyError,
    };
  } catch (error) {
    return { trapped: true, error: String(error) };
  }
}

const REFUSALS = [
  {
    id: "unknown-operation",
    body: '{"operation":"noSuchOperation","params":{}}',
    errorCode: "unknown-operation",
    messageIncludes: "noSuchOperation",
  },
  {
    id: "missing-required-param",
    body: '{"operation":"hohmannTransfer","params":{"r1":7000000}}',
    errorCode: "invalid-parameter",
    messageIncludes: '"r2"',
  },
  {
    id: "misspelled-param",
    body: '{"operation":"hohmannTransfer","params":{"R1":7000000,"r2":40000000}}',
    errorCode: "invalid-parameter",
    messageIncludes: '"r1"',
  },
  {
    // The module's OWN validator, verbatim. Unreachable for the whole life of
    // 0.1.0.
    id: "validator-range-violation",
    body: '{"operation":"phasingManeuver","params":{"currentRadius":7000000,"phaseAngle":0.5,"numRevs":0}}',
    errorCode: "invalid-parameter",
    messageIncludes: "[phasing]: Number of revolutions must be >= 1",
  },
  {
    id: "validator-negative-radius",
    body: '{"operation":"phasingManeuver","params":{"currentRadius":-7000000,"phaseAngle":0.5,"numRevs":1}}',
    errorCode: "invalid-parameter",
    messageIncludes: "[phasing]: Orbit radius must be positive",
  },
  {
    id: "boundary-negative-radius",
    body: '{"operation":"hohmannTransfer","params":{"r1":-7000000,"r2":40000000}}',
    errorCode: "invalid-parameter",
    messageIncludes: "must be positive",
  },
  {
    id: "missing-operation-key",
    body: '{"params":{}}',
    errorCode: "malformed-request",
    messageIncludes: "operation",
  },
  {
    id: "operation-not-a-string",
    body: '{"operation":123}',
    errorCode: "malformed-request",
    messageIncludes: "must be a string",
  },
  {
    id: "malformed-json",
    body: '{"operation": "hohmannTransfer", ',
    errorCode: "malformed-request",
    messageIncludes: "not valid JSON",
  },
  {
    id: "body-is-an-array",
    body: "[]",
    errorCode: "malformed-request",
    messageIncludes: "must be a JSON object",
  },
  {
    id: "params-not-an-object",
    body: '{"operation":"hohmannTransfer","params":7}',
    errorCode: "malformed-request",
    messageIncludes: '"params"',
  },
  {
    id: "unsupported-stm-model",
    body: '{"operation":"computeRoeStateTransition","params":{"model":"nope","deltaTime":100,"chief":{"semiMajorAxis":6778000}}}',
    errorCode: "unknown-operation",
    messageIncludes: "unsupported ROE STM model",
  },
  {
    // A geometry with no zero-revolution arc. The refusal is the POINT of the
    // Lambert repair: 0.1.0 answered `converged: true` with velocities that do
    // not fly the transfer.
    id: "lambert-antipodal-has-no-unique-solution",
    body: '{"operation":"solveLambert","params":{"r1":[6778000,0,0],"r2":[-6778000,0,0],"tof":2700,"mu":398600441800000}}',
    errorCode: "no-solution",
    messageIncludes: "no solution",
  },
  {
    id: "lambert-mindv-without-endpoints-is-refused",
    body: '{"operation":"solveLambertMinDV","params":{"r1":[6778000,0,0],"r2":[0,7078000,0],"tof":2700,"mu":398600441800000}}',
    errorCode: "invalid-parameter",
    messageIncludes: "departureVelocity",
  },
  {
    // 0.3.0's branch selector. A multi-revolution Lambert problem has exactly
    // two arcs per revolution count, so a third name is an INPUT error and must
    // read as one — never a silent fall back to the default, which would hand a
    // caller who asked for something specific a different arc without saying so.
    id: "lambert-branch-must-name-one-of-the-two-arcs",
    body: '{"operation":"solveLambert","params":{"r1":[22592145.603,-1599915.239,-19783950.506],"r2":[1922067.697,4054157.051,-8925727.465],"tof":36000,"mu":398600441800000,"nRevs":1,"branch":"middle"}}',
    errorCode: "invalid-parameter",
    messageIncludes: 'branch must be "low" or "high"',
  },
  {
    id: "lambert-branch-must-be-a-string",
    body: '{"operation":"solveLambert","params":{"r1":[22592145.603,-1599915.239,-19783950.506],"r2":[1922067.697,4054157.051,-8925727.465],"tof":36000,"mu":398600441800000,"nRevs":1,"branch":1}}',
    errorCode: "invalid-parameter",
    messageIncludes: "branch",
  },
  {
    id: "lambert-mindv-branch-must-name-one-of-the-two-arcs",
    body: '{"operation":"solveLambertMinDV","params":{"r1":[6678137,0,0],"r2":[0,7078137,0],"tof":3000,"mu":398600441800000,"maxRevs":2,"departureVelocity":[0,7725.8,0],"arrivalVelocity":[-7503.4,0,0],"branch":"lowest"}}',
    errorCode: "invalid-parameter",
    messageIncludes: 'branch must be "low" or "high"',
  },
];

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`every refusal is a structured error and the instance survives on ${runtimeKind}`, async (t) => {
    // ONE harness for the whole sequence. Under 0.1.0 this test could not have
    // been written: probe 1 poisoned the instance for probe 2.
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) return;
    t.after(async () => {
      await harness.destroy();
    });

    for (const refusal of REFUSALS) {
      await t.test(refusal.id, async () => {
        const outcome = await probe(harness, refusal.body);
        assert.equal(
          outcome.trapped,
          false,
          `${refusal.id} TRAPPED: ${outcome.error}. No input may trap this module.`,
        );
        assert.notEqual(outcome.statusCode, 0, `${refusal.id} reported success`);
        assert.equal(outcome.errorCode, refusal.errorCode);
        assert.equal(outcome.bodyError, null, `${refusal.id} response body is not JSON`);
        assert.ok(outcome.body, `${refusal.id} emitted no response frame`);
        assert.equal(outcome.body.errorCode, refusal.errorCode);
        assert.ok(
          String(outcome.body.error).includes(refusal.messageIncludes),
          `${refusal.id}: message ${JSON.stringify(outcome.body.error)} does not name ` +
            JSON.stringify(refusal.messageIncludes),
        );
      });
    }

    await t.test("the same instance still computes after every refusal", async () => {
      const outcome = await probe(
        harness,
        `{"operation":"hohmannTransfer","params":{"r1":6678137,"r2":42164000,"mu":${MU}}}`,
      );
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

/**
 * Sixteen hostile values per parameter position. Every one of these is a value
 * a real caller has produced by accident: a slider at its limit, an unset form
 * field, a unit conversion that divided by zero, a JSON round trip through a
 * language whose integers are not doubles.
 */
const HOSTILE = [
  0,
  -1,
  1e308,
  -1e308,
  1e-308,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
  0.1,
  null,
  true,
  false,
  "",
  "NaN",
  [],
  {},
  [1, 2, 3, 4],
];

/** Every wired operation with a known-good parameter set to mutate. */
const OPERATIONS = [
  ["hohmannTransfer", { r1: 6678137, r2: 42164000, mu: MU }],
  ["biEllipticTransfer", { r1: 6678137, r2: 42164000, rIntermediate: 120000000, mu: MU }],
  ["planeChange", { orbitalRadius: 11480000, velocity: 5892.311, deltaInclination: 0.26 }],
  ["combinedManeuver", { r1: 6678137, r2: 42164000, deltaInclination: 0.497, mu: MU }],
  ["phasingManeuver", { currentRadius: 6778137, phaseAngle: 0.5236, numRevs: 3, mu: MU }],
  [
    // `branch` is listed so the fuzz MUTATES it: every parameter of every wired
    // operation gets the sixteen hostile values, and a parameter added in 0.3.0
    // that is not in this set is a parameter nothing hostile has ever been sent.
    "solveLambert",
    { r1: [12756272, 0, 0], r2: [12756272, 22094511.219168257, 0], tof: 4033.9, mu: MU, prograde: true, nRevs: 0, branch: "low" },
  ],
  [
    "solveLambertMinDV",
    {
      r1: [6678137, 0, 0],
      r2: [0, 7078137, 0],
      tof: 3000,
      mu: MU,
      maxRevs: 2,
      departureVelocity: [0, 7725.8, 0],
      arrivalVelocity: [-7503.4, 0, 0],
      branch: "high",
    },
  ],
  [
    "computeCAM",
    {
      initialState: { position: [50, 0, 0], velocity: [0, -0.02, 0] },
      chief: { semiMajorAxis: 6778000, eccentricity: 0, inclination: 0, mu: MU },
      config: { minMissDistance: 1000, timeToTCA: 600, maxDeltaV: 10 },
    },
  ],
  [
    "computeRoeStateTransition",
    {
      model: "j2",
      deltaTime: 1200,
      initialRoe: [1e-5, 2e-5, 1e-6, 2e-6, 3e-6, 4e-6],
      chief: { semiMajorAxis: 6778000, eccentricity: 0.001, inclination: 0.9, mu: MU },
    },
  ],
];

/** Structural payloads that do not fit the per-parameter shape. */
const STRUCTURAL = [
  "",
  " ",
  "null",
  "true",
  '"a string"',
  "0",
  "{",
  "}",
  "[[[[[[[[[[",
  '{"operation":"hohmannTransfer","params":{"r1":1e400,"r2":2}}',
  '{"operation":"hohmannTransfer","params":{"r1":0x10,"r2":2}}',
  '{"operation":"hohmannTransfer","params":{"r1":Infinity,"r2":2}}',
  '{"operation":"hohmannTransfer","params":{"r1":NaN,"r2":2}}',
  '{"operation":"","params":{}}',
  '{"operation":"\\u0000","params":{}}',
  `{"operation":"hohmannTransfer","params":{"r1":${"9".repeat(400)},"r2":2}}`,
  // 200 levels of nesting: past the parser's depth cap, which is the point.
  `{"operation":"hohmannTransfer","params":{"r1":${"[".repeat(200)}${"]".repeat(200)},"r2":2}}`,
  // 5000 levels: unbounded recursion here is stack exhaustion, and stack
  // exhaustion in a wasm guest is a trap, not an error.
  `{"operation":"hohmannTransfer","params":{"r1":${"[".repeat(5000)}${"]".repeat(5000)},"r2":2}}`,
];

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
    const badBodies = [];

    for (const [operation, baseline] of OPERATIONS) {
      for (const key of Object.keys(baseline)) {
        for (const hostile of HOSTILE) {
          const params = { ...baseline, [key]: hostile };
          const body = JSON.stringify({ operation, params });
          const outcome = await probe(harness, body);
          calls += 1;
          if (outcome.trapped) traps.push(`${operation}.${key}=${JSON.stringify(hostile)}: ${outcome.error}`);
          else if (outcome.bodyError) {
            badBodies.push(`${operation}.${key}=${JSON.stringify(hostile)}: ${outcome.bodyError}`);
          }
        }
        // Also: the key removed entirely.
        const without = { ...baseline };
        delete without[key];
        const outcome = await probe(harness, JSON.stringify({ operation, params: without }));
        calls += 1;
        if (outcome.trapped) traps.push(`${operation}: missing ${key}: ${outcome.error}`);
        else if (outcome.bodyError) badBodies.push(`${operation}: missing ${key}: ${outcome.bodyError}`);
      }
    }

    for (const body of STRUCTURAL) {
      const outcome = await probe(harness, body);
      calls += 1;
      if (outcome.trapped) traps.push(`structural ${JSON.stringify(body).slice(0, 60)}: ${outcome.error}`);
      else if (outcome.bodyError) {
        badBodies.push(`structural ${JSON.stringify(body).slice(0, 60)}: ${outcome.bodyError}`);
      }
    }

    assert.deepEqual(traps, [], `${traps.length} of ${calls} fuzz inputs TRAPPED the module`);
    assert.deepEqual(badBodies, [], "response frames that were not valid JSON");

    // The instance is still alive after all of it. This is the assertion that
    // 0.1.0 could not have survived past its FIRST fuzz input.
    const alive = await probe(
      harness,
      `{"operation":"hohmannTransfer","params":{"r1":6678137,"r2":42164000,"mu":${MU}}}`,
    );
    assert.equal(alive.trapped, false);
    assert.equal(alive.statusCode, 0);
    assert.equal(alive.body.totalDeltaV, 3892.5543868908976);
    console.error(
      `[${runtimeKind}] fuzz: ${calls} hostile inputs, 0 traps, instance alive`,
    );
  });
}
