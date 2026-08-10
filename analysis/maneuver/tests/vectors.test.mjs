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
  INVARIANTS,
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
    // WasmEdge MUST be given the threads proposal for this artifact, and that is
// not a threading claim. On `wasm32-wasip1-threads` — the triple the SDK's
// wasi-sequential lane compiles for — wasm-ld DECLARES a shared memory (limits
// flags 0x03) even with no atomics and no thread-spawn contract, because the
// target features say so. The SDK's own artifact guard documents this as the
// expected driver output and checks the property that actually matters: the
// guest OWNS its memory rather than importing one. The published reference
// propagator has the identical memory section.
//
// A bare `wasmedge` without --enable-threads refuses to LOAD such a module
// ("integer too large / At AST node: limit"), which reads like a defect in the
// artifact and is not one. The shared repo harness defaults `enableThreads` to
// false, so every module off this lane must ask for it explicitly — filed as
// `modules-isomorphic-harness-wasmedge-threads-default`.
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
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
 * THE LEO SWEEP — the invariant that found the Lambert defect, run as a suite.
 *
 * The four Tudat rows above are a foreign reference. This is the other half of
 * the adjudication and needs no reference at all: for a grid of routine
 * prograde LEO-to-LEO geometries, every solution the module CLAIMS must
 * actually fly. The claim is checked by propagating the returned departure
 * velocity forward by the stated time of flight with the independent
 * universal-variable Kepler propagator in vectors/index.mjs.
 *
 * On the 0.1.0 artifact this sweep failed 50 of 52 sampled cases, every one of
 * them reporting `converged: true`, with misses from 5.4e-3 to 41x the target
 * radius.
 *
 * The assertion is deliberately two-sided, and the second side is the one that
 * matters: a solver may legitimately answer "there is no zero-revolution arc
 * that flies this" — a reflex transfer angle has a bounded maximum time of
 * flight — but it may NEVER claim convergence for an arc that does not arrive.
 * "Refuses more than it should" is a capability gap; "answers a burn that
 * misses" is the defect this task exists to close.
 */
for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`every Lambert solution that claims convergence actually arrives on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) return;
    t.after(async () => {
      await harness.destroy();
    });

    const mu = 3.986004418e14;
    const r1Magnitude = 6678137;
    const r2Magnitude = 7378137;
    const period = 2 * Math.PI * Math.sqrt(r1Magnitude ** 3 / mu);

    let claimed = 0;
    let refused = 0;
    let worstRelativeMiss = 0;
    const misses = [];

    for (let degrees = 10; degrees <= 350; degrees += 20) {
      for (const orbits of [0.25, 0.5, 1.0, 2.0]) {
        const theta = (degrees * Math.PI) / 180;
        const params = {
          r1: [r1Magnitude, 0, 0],
          r2: [r2Magnitude * Math.cos(theta), r2Magnitude * Math.sin(theta), 0],
          tof: orbits * period,
          mu,
          prograde: true,
          nRevs: 0,
        };
        const raw = await harness.invoke({
          methodId: "invoke",
          inputs: [
            {
              portId: "request",
              payload: Buffer.from(
                JSON.stringify({ operation: "solveLambert", params }),
                "utf8",
              ),
            },
          ],
        });
        if (raw.statusCode !== 0) {
          // A structured refusal. Under 0.1.0 this would have been a TRAP that
          // killed the harness for every remaining case in the grid.
          refused += 1;
          continue;
        }
        const frame = raw.outputs.find((entry) => entry.portId === "response");
        const response = JSON.parse(new TextDecoder().decode(frame.payload));
        assert.equal(
          response.converged,
          true,
          `${degrees}deg/${orbits}P returned a success status with converged=false`,
        );
        claimed += 1;

        const closure = INVARIANTS.lambertClosure({
          operation: "solveLambert",
          params,
          response,
        });
        misses.push({ id: `${degrees}deg/${orbits}P`, closure });
        worstRelativeMiss = Math.max(worstRelativeMiss, closure.relativeMiss);
      }
    }

    const failures = misses.filter((entry) => !entry.closure.ok);
    assert.deepEqual(
      failures.map((entry) => `${entry.id}: ${entry.closure.detail}`),
      [],
      `${failures.length} of ${claimed} claimed solutions do not arrive`,
    );
    assert.ok(claimed >= 60, `only ${claimed} of 72 geometries produced a solution`);
    console.error(
      `[${runtimeKind}] Lambert LEO sweep: ${claimed} claimed + ${refused} refused = ` +
        `${claimed + refused} geometries; worst arrival miss ` +
        `${worstRelativeMiss.toExponential(3)} of |r2|`,
    );
  });
}
