/**
 * THE PARITY RUNNER — every vector, every runtime, one tolerance policy.
 *
 * This suite replaces the `hohmannReference()` pattern that used to live in
 * behavior.test.mjs, where the expected value was recomputed from the module's
 * own formula inside the assertion. That test could only ever fail on a typo:
 * it compared an equation to itself. Here the expectations are FROZEN in
 * `vectors/vectors.json` with recorded provenance, and the three tiers are
 * independent of each other — a foreign reference (Tudat), a closed form
 * (textbook canonicals), and properties checkable with neither (invariants).
 *
 * WHAT THIS SUITE PROVED ON FIRST RUN, and why the shape matters: three of the
 * four tier-A Lambert rows FAIL, and they fail against a foreign reference AND
 * against an invariant that needs no reference at all. Had the suite carried
 * only tier B, the module would have agreed with itself and passed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";
import {
  BANDS,
  bandFor,
  compareValue,
  formatWorst,
  loadVectors,
  readPath,
  runInvariants,
} from "../vectors/index.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const vectors = await loadVectors();

/**
 * Evaluate one case against one live harness.
 *
 * Returns the full comparison set rather than asserting, because a row that is
 * EXPECTED to fail has to be judged by the same instrument as one that is
 * expected to pass. Two code paths, one for "should pass" and one for "should
 * fail", is how an expected-failure marker quietly becomes a skip.
 */
async function evaluateCase(harness, testCase) {
  const response = await invokeJsonRequest(harness, {
    operation: testCase.operation,
    params: testCase.params,
  });

  const comparisons = [];
  for (const [path, expected] of Object.entries(testCase.expect ?? {})) {
    const observed = readPath(response, path);
    if (observed === undefined) {
      comparisons.push({
        path,
        ok: false,
        kind: "field-absent",
        error: Number.POSITIVE_INFINITY,
        budget: 0,
        ratio: Number.POSITIVE_INFINITY,
        observed,
        expected,
      });
      continue;
    }
    const band = testCase.band ?? bandFor(path);
    const comparison = compareValue(observed, expected, band);
    comparison.path = path;
    comparison.field = path;
    comparisons.push(comparison);
  }

  const invariants = runInvariants({
    operation: testCase.operation,
    params: testCase.params,
    response,
  });

  return {
    response,
    comparisons,
    invariants,
    ok:
      comparisons.every((comparison) => comparison.ok) &&
      invariants.every((invariant) => invariant.ok),
  };
}

/** Human-readable failure detail — every out-of-band row, not just the first. */
function describe(testCase, evaluation) {
  const lines = [`${testCase.id} [${testCase.tier}] ${testCase.operation}`];
  for (const comparison of evaluation.comparisons) {
    if (comparison.ok) continue;
    lines.push(
      `  ${comparison.path}: observed ${comparison.observed} expected ${comparison.expected} ` +
        `|err| ${Number(comparison.error).toExponential(4)} > budget ${Number(comparison.budget).toExponential(4)} ` +
        `[${comparison.kind}]`,
    );
  }
  for (const invariant of evaluation.invariants) {
    if (invariant.ok) continue;
    lines.push(`  INVARIANT ${invariant.id}: ${invariant.detail}`);
  }
  return lines.join("\n");
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`maneuver vectors on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) return;
    t.after(async () => {
      await harness.destroy();
    });

    const allComparisons = [];
    const alarms = [];

    for (const testCase of vectors.cases) {
      await t.test(`${testCase.tier}/${testCase.id}`, async () => {
        const evaluation = await evaluateCase(harness, testCase);
        // Only rows that are SUPPOSED to agree feed the margin report. Letting
        // a known-defect row in makes the worst-row line read "471200559821%
        // of budget used" forever, which drowns the one number the report
        // exists to surface: how close the healthy rows are to their gate.
        if (!testCase.expectedToFail) allComparisons.push(...evaluation.comparisons);

        if (testCase.expectedToFail) {
          // A known-defect row must actually still be broken. If it starts
          // passing, THAT is the event worth interrupting a human for: the
          // defect was fixed and the ledger is now lying.
          assert.equal(
            evaluation.ok,
            false,
            `${testCase.id} is marked expected-to-fail but PASSED.\n` +
              `The defect it documents appears to be fixed:\n  ${testCase.expectedToFail.defect}\n` +
              "Re-baseline this row deliberately: remove the marker, and record " +
              "the fix in the graph task the marker names.",
          );
          return;
        }

        assert.ok(evaluation.ok, describe(testCase, evaluation));

        // REGRESSION ALARM. Passing is not the whole verdict: a row that used
        // to agree at 1e-11 and now agrees at 1e-7 is still inside a 1e-6 gate
        // and is still a regression. The alarm band is tighter than the gate
        // precisely so the approach is visible before the arrival.
        const alarmRel = testCase.band?.alarmRel;
        if (alarmRel) {
          for (const comparison of evaluation.comparisons) {
            const alarmBudget = BANDS.referenceVelocity.abs + alarmRel * Math.abs(comparison.expected);
            if (comparison.error > alarmBudget) {
              alarms.push(
                `${testCase.id}/${comparison.path}: |err| ${comparison.error.toExponential(3)} ` +
                  `exceeds the ${alarmRel} regression watermark (gate is ${testCase.band.rel})`,
              );
            }
          }
        }
      });
    }

    // Reported on PASS as well as on FAIL — see vectors/index.mjs formatWorst.
    const knownFail = vectors.cases.filter((entry) => entry.expectedToFail).length;
    console.error(
      formatWorst(
        allComparisons,
        `[${runtimeKind}] ${vectors.cases.length - knownFail} healthy rows`,
      ) + ` | ${knownFail} rows held open as known defects`,
    );
    if (alarms.length > 0) {
      console.error(
        `[${runtimeKind}] REGRESSION ALARM (inside the gate, outside the watermark):\n  ` +
          alarms.join("\n  "),
      );
    }
  });
}

test("every vector file row carries provenance", () => {
  for (const testCase of vectors.cases) {
    assert.ok(testCase.source, `${testCase.id}: no source recorded`);
    assert.ok(
      Object.keys(testCase.expect ?? {}).length > 0,
      `${testCase.id}: no expectations — a case that asserts nothing is not a case`,
    );
  }
  assert.ok(vectors.invariants.length >= 5, "tier C invariant set is incomplete");
});

/**
 * THE MODULE'S ERROR PATH IS COMPILED AWAY — pinned as a test so the day it is
 * repaired is a visible event.
 *
 * `invoke_json_request` wraps its dispatch in try/catch, but the emcc link line
 * carries no exception flags, so every `throw` lowers to `abort()`. The trap
 * POISONS THE INSTANCE: subsequent calls on the same harness fail too, which is
 * why each case below gets a fresh one. This is the load-bearing justification
 * for the console-side wrapper validating every parameter BEFORE the call.
 */
for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`bad input traps rather than erroring on ${runtimeKind}`, async (t) => {
    const probes = [
      { id: "unknown-operation", request: { operation: "noSuchOperation", params: {} } },
      { id: "missing-required-param", request: { operation: "hohmannTransfer", params: { r1: 7e6 } } },
      { id: "misspelled-param", request: { operation: "hohmannTransfer", params: { R1: 7e6, r2: 4e7 } } },
      {
        id: "validator-range-violation",
        request: { operation: "phasingManeuver", params: { currentRadius: 7e6, phaseAngle: 0.5, numRevs: 0 } },
      },
      {
        id: "validator-negative-radius",
        request: { operation: "hohmannTransfer", params: { r1: -7e6, r2: 4e7 } },
      },
      { id: "missing-operation-key", request: { params: {} } },
    ];

    for (const probe of probes) {
      await t.test(probe.id, async (subtest) => {
        const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, subtest);
        if (!harness) return;
        try {
          let outcome = "returned";
          try {
            await invokeJsonRequest(harness, probe.request);
          } catch {
            outcome = "threw";
          }
          assert.equal(
            outcome,
            "threw",
            `${probe.id} returned a value. If the module now produces a clean ` +
              "JSON error result, the exceptions-disabled link line has been " +
              "repaired — update modules-maneuver-planner-rebuild-batch and " +
              "relax the console wrapper's defensive validation accordingly.",
          );
        } finally {
          await harness.destroy();
        }
      });
    }
  });
}
