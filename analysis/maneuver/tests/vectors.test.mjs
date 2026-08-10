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
  bandForCase,
  compareValue,
  formatWorst,
  loadVectors,
  readPath,
  runFrameAlgebra,
  runInvariants,
} from "../vectors/index.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const vectors = await loadVectors();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Invoke and return the OUTCOME, never throwing.
 *
 * `invokeJsonRequest` asserts a zero status, which is right for a row that
 * expects an answer and useless for a row that expects a REFUSAL: a helper that
 * throws on non-zero cannot tell "returned an error" from "trapped", and those
 * two are the whole distinction the tier-D screening rows exist to draw.
 */
async function probe(harness, request) {
  try {
    const response = await harness.invoke({
      methodId: "invoke",
      inputs: [{ portId: "request", payload: encoder.encode(JSON.stringify(request)) }],
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
    return { trapped: false, statusCode: response.statusCode, errorCode: response.errorCode, body, bodyError };
  } catch (error) {
    return { trapped: true, error: String(error) };
  }
}

/**
 * Evaluate one case against one live harness.
 *
 * Returns the full comparison set rather than asserting, because a row that is
 * EXPECTED to fail has to be judged by the same instrument as one that is
 * expected to pass. Two code paths, one for "should pass" and one for "should
 * fail", is how an expected-failure marker quietly becomes a skip.
 */
async function evaluateCase(harness, testCase) {
  const outcome = await probe(harness, {
    operation: testCase.operation,
    params: testCase.params,
  });
  if (outcome.trapped || outcome.statusCode !== 0) {
    // A REFUSAL where an answer was expected is a verdict, not an exception.
    // Routing it through the same return shape is what lets a known-red row be
    // judged by the same instrument as a healthy one: `solveLambert` answering
    // "no solution" to a geometry a contributing library solves is exactly the
    // kind of failure a marker has to be able to hold open, and a thrown error
    // would turn it into an unhandled crash instead.
    return {
      response: outcome.body,
      refused: true,
      comparisons: Object.entries(testCase.expect ?? {}).map(([path, expected]) => ({
        path,
        field: path,
        ok: false,
        kind: "refused",
        error: Number.POSITIVE_INFINITY,
        budget: 0,
        ratio: Number.POSITIVE_INFINITY,
        observed: undefined,
        expected,
      })),
      invariants: [],
      ok: false,
      refusal: outcome.trapped
        ? `the module TRAPPED: ${outcome.error}`
        : `${outcome.errorCode ?? "error"}: ${outcome.body?.error ?? "(no message)"}`,
    };
  }
  const response = outcome.body;

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
    const band = bandForCase(testCase, path);
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
  if (evaluation.refused) {
    lines.push(
      `  REFUSED — ${evaluation.refusal}. ` +
        `${testCase.source?.library ?? "the source"} solves this geometry.`,
    );
    return lines.join("\n");
  }
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
    /**
     * The RECORDING invariants — `lambert-earth-floor` and
     * `phasing-earth-floor` — classify rather than fail, because the module is
     * behaving as built and a harness that turns a known capability gap into a
     * red run teaches people to ignore red runs. Recording them is not the same
     * as ignoring them: the count is printed on every run, so "how many of our
     * conformance geometries produce an arc through the planet" is a number
     * somebody can watch go to zero.
     */
    const classifications = new Map();

    for (const testCase of vectors.cases) {
      await t.test(`${testCase.tier}/${testCase.id}`, async () => {
        // ------------------------------------------------------------------
        // REFUSAL ROWS — a geometry the SOURCE library refuses.
        //
        // The assertion is three-part and every part earns its place: the call
        // must fail STRUCTURALLY (0.1.0 trapped, which kills the instance for
        // every caller sharing it), it must not smuggle a velocity out in the
        // body (a refusal a consumer can read a burn out of is not a refusal),
        // and it must not succeed (the 0.1.0 defect was `converged: true` on an
        // arc that does not fly).
        // ------------------------------------------------------------------
        if (testCase.expectRefusal) {
          const outcome = await probe(harness, {
            operation: testCase.operation,
            params: testCase.params,
          });
          // A TRAP is never acceptable, known-red or not: a trapped guest is
          // dead for every caller sharing it, and no defect ledger excuses it.
          assert.equal(
            outcome.trapped,
            false,
            `${testCase.id}: the module TRAPPED. A geometry with no solution is a ` +
              "refusal, not an abort.",
          );
          const failures = [];
          if (outcome.statusCode === 0) {
            failures.push(
              `the module ANSWERED a geometry that must be refused ` +
                `("${testCase.expectRefusal.upstreamMessage}"); body ${JSON.stringify(outcome.body)}`,
            );
          } else {
            for (const field of testCase.expectRefusal.forbidFields) {
              if (outcome.body?.[field] !== undefined) {
                failures.push(`the refusal body carries ${field}`);
              }
            }
            if (!(typeof outcome.body?.error === "string" && outcome.body.error.length > 0)) {
              failures.push("the refusal carries no message a caller can show");
            }
          }
          if (testCase.expectedToFail) {
            assert.ok(
              failures.length > 0,
              `${testCase.id} is marked expected-to-fail but the module now REFUSES ` +
                `correctly.\nThe defect it documents appears to be fixed:\n  ` +
                `${testCase.expectedToFail.defect}\n` +
                "Re-baseline this row deliberately and record the fix in the graph task.",
            );
            return;
          }
          assert.deepEqual(failures, [], `${testCase.id}: ${failures.join("; ")}`);
          return;
        }

        // ------------------------------------------------------------------
        // FRAME-ALGEBRA ROWS — a foreign identity about the RIC <-> inertial
        // conversion every `*_ric` field depends on. Not a module call, and the
        // row says so: see `unmappedModuleSurface` in vectors.json.
        // ------------------------------------------------------------------
        if (testCase.frameAlgebra) {
          const comparisons = runFrameAlgebra(testCase);
          allComparisons.push(...comparisons);
          const bad = comparisons.filter((comparison) => !comparison.ok);
          assert.deepEqual(
            bad.map(
              (comparison) =>
                `${comparison.field}: ${comparison.observed} vs ${comparison.expected}`,
            ),
            [],
            `${testCase.id}: the RIC frame algebra does not reproduce ` +
              `${testCase.source.library}'s impulsive-burn identity`,
          );
          return;
        }

        const evaluation = await evaluateCase(harness, testCase);
        // Only rows that are SUPPOSED to agree feed the margin report. Letting
        // a known-defect row in makes the worst-row line read "471200559821%
        // of budget used" forever, which drowns the one number the report
        // exists to surface: how close the healthy rows are to their gate.
        if (!testCase.expectedToFail) allComparisons.push(...evaluation.comparisons);
        for (const invariant of evaluation.invariants) {
          if (!invariant.classification) continue;
          const key = `${invariant.id}/${invariant.classification}`;
          classifications.set(key, [...(classifications.get(key) ?? []), testCase.id]);
        }

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
        for (const comparison of evaluation.comparisons) {
          const band = bandForCase(testCase, comparison.path);
          if (band?.alarmBudgetFraction) {
            // MARGIN watermark (tier D): how much of the source's own stated
            // gate this row is consuming. See gen-library-vectors.mjs for why
            // tier A's construction cannot be reused on references printed to
            // five significant figures.
            if (comparison.ratio > band.alarmBudgetFraction) {
              alarms.push(
                `${testCase.id}/${comparison.path}: ${(comparison.ratio * 100).toFixed(1)}% of ` +
                  `the ${band.sourceTolerance} gate ${testCase.source.library} states ` +
                  `(watermark ${band.alarmBudgetFraction * 100}%)`,
              );
            }
            continue;
          }
          const alarmRel = band?.alarmRel;
          if (!alarmRel) continue;
          // PRECISION watermark (tier A): a fixed relative floor, calibrated
          // against the measured agreement and recorded in the vector file.
          const alarmBudget =
            BANDS.referenceVelocity.abs + alarmRel * Math.abs(comparison.expected);
          if (comparison.error > alarmBudget) {
            alarms.push(
              `${testCase.id}/${comparison.path}: |err| ${comparison.error.toExponential(3)} ` +
                `exceeds the ${alarmRel} regression watermark (gate is ${band.rel})`,
            );
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
    for (const [key, ids] of [...classifications].sort()) {
      if (!/THROUGH-EARTH|BELOW-FLOOR/.test(key)) continue;
      console.error(`[${runtimeKind}] ${key}: ${ids.length} row(s) — ${ids.join(", ")}`);
    }
  });
}

test("every vector file row carries provenance", () => {
  for (const testCase of vectors.cases) {
    assert.ok(testCase.source, `${testCase.id}: no source recorded`);
    const asserts =
      Object.keys(testCase.expect ?? {}).length > 0 ||
      Boolean(testCase.expectRefusal) ||
      Boolean(testCase.frameAlgebra);
    assert.ok(
      asserts,
      `${testCase.id}: no expectations — a case that asserts nothing is not a case`,
    );
  }
  assert.ok(vectors.invariants.length >= 5, "tier C invariant set is incomplete");
});

/**
 * TIER D CARRIES A LICENCE NOTE PER ROW, and the note is checked.
 *
 * Lifting a number out of somebody else's test suite is a licensing act. The
 * suite therefore refuses to run a foreign row that does not say, in the file,
 * which library it came from, at which commit, out of which test, and under
 * which licence — and refuses outright any licence not on the permissive list,
 * so that a future dumper pointed at a copyleft source fails loudly here rather
 * than quietly shipping its values inside our artifact's test data.
 */
const LICENCES_THAT_PERMIT_LIFTING = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"]);

test("every foreign vector names its library, commit, test and licence", () => {
  const foreign = vectors.cases.filter((entry) => entry.tier === "D");
  assert.ok(foreign.length > 0, "tier D is empty");
  for (const testCase of foreign) {
    const { library, head, file, testCase: upstreamTest, license } = testCase.source;
    assert.ok(library, `${testCase.id}: no library`);
    assert.ok(head, `${testCase.id}: no upstream commit`);
    assert.ok(file, `${testCase.id}: no upstream file`);
    assert.ok(upstreamTest, `${testCase.id}: no upstream test name`);
    assert.ok(
      LICENCES_THAT_PERMIT_LIFTING.has(license),
      `${testCase.id}: licence ${license} is not on the list that permits lifting values. ` +
        "Re-express the case's INPUTS and expected numbers with citation, or drop the row.",
    );
  }
  for (const [name, record] of Object.entries(vectors.libraries ?? {})) {
    assert.ok(record.head, `${name}: no commit recorded in vectors.json`);
    assert.ok(
      LICENCES_THAT_PERMIT_LIFTING.has(record.license),
      `${name}: licence ${record.license} does not permit lifting`,
    );
    assert.ok(record.licenseNote, `${name}: no licence note`);
  }
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
