/**
 * The delta-v FRAME and the delta-v SIGN, asserted through the invoke surface.
 *
 * Two defects are gated here (graph: gmat-01-defect-burn-down, and the D1
 * defect recorded in graph/findings/official-harness-shapes.md):
 *
 *   FRAME. The module named no frame on the wire and applied none — r/t/n
 *   components were written onto x/y/z raw, while three distinct RTN triads
 *   were live across the stack. 0.5.0 declares `frame` on every response that
 *   carries a delta-v and exposes `transformDeltaV`, which rotates a delta-v
 *   between that triad and the inertial frame. The canonical triad is
 *
 *       R = unit(r)   C = unit(r x v)   I = C x R
 *
 *   built from the INERTIAL state, components ordered [radial, in-track,
 *   cross-track].
 *
 *   SIGN. Through 0.4.0 every single-axis delta-v scalar was std::abs()'d, so
 *   a retrograde burn was indistinguishable from a prograde one of the same
 *   size. 0.5.0 returns signed scalars; only the propellant BUDGET
 *   (`totalDeltaV`) stays a magnitude.
 *
 * The physics is the module's. These assertions are pure invariants —
 * orthonormality, a round trip, and a sign — computed from the module's own
 * output, never from a JavaScript reimplementation of the maneuver.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MU_EARTH = 398600441800000.0;

// One inclined, eccentric LEO state. Nothing about it is special except that
// it is NOT equatorial and NOT circular: an equatorial circular state makes
// two of the three triad axes trivially recoverable and would hide a wrong
// cross-track sign.
const STATE = {
  position: [6_524_834.0, 6_862_875.0, 6_448_296.0],
  velocity: [4_901.327, 5_533.756, -1_976.341],
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`the RIC triad is orthonormal and right-handed on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) return;
    t.after(async () => harness.destroy());

    const res = await invokeJsonRequest(harness, {
      operation: "transformDeltaV",
      params: { ...STATE, deltaV: [1, 0, 0], from: "RIC" },
    });
    const { R, I, C } = res.basis;

    for (const [name, v] of [["R", R], ["I", I], ["C", C]]) {
      assert.ok(Math.abs(norm(v) - 1) <= 1e-15, `${name} is not a unit vector: |${name}| = ${norm(v)}`);
    }
    for (const [name, a, b] of [["R.I", R, I], ["R.C", R, C], ["I.C", I, C]]) {
      assert.ok(Math.abs(dot(a, b)) <= 1e-15, `${name} = ${dot(a, b)} — the triad is not orthogonal`);
    }
    // Right-handed in the declared order: R x I = C.
    const cross = [
      R[1] * I[2] - R[2] * I[1],
      R[2] * I[0] - R[0] * I[2],
      R[0] * I[1] - R[1] * I[0],
    ];
    for (let k = 0; k < 3; ++k) {
      assert.ok(Math.abs(cross[k] - C[k]) <= 1e-15,
        `R x I != C on component ${k}: ${cross[k]} vs ${C[k]}`);
    }
    // R is along the position vector, so the triad is built from the INERTIAL
    // state and not from anything Earth-fixed.
    const rHat = STATE.position.map((x) => x / norm(STATE.position));
    for (let k = 0; k < 3; ++k) {
      assert.ok(Math.abs(R[k] - rHat[k]) <= 1e-15, `R is not unit(r) on component ${k}`);
    }
  });

  test(`RIC -> ECI -> RIC closes to 1e-12 relative on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) return;
    t.after(async () => harness.destroy());

    // Three independent probes so a rotation that happens to be right on one
    // axis cannot pass. The third is a general direction.
    const probes = [
      [12.5, 0, 0],
      [0, -33.75, 0],
      [-4.125, 18.5, 7.875],
    ];

    let worst = 0;
    for (const deltaV of probes) {
      const eci = await invokeJsonRequest(harness, {
        operation: "transformDeltaV",
        params: { ...STATE, deltaV, from: "RIC" },
      });
      assert.equal(eci.frame, "ECI");
      const back = await invokeJsonRequest(harness, {
        operation: "transformDeltaV",
        params: { ...STATE, deltaV: eci.deltaV, from: "ECI" },
      });
      assert.equal(back.frame, "RIC");

      // A rotation preserves length; the round trip must return the vector.
      assert.ok(Math.abs(eci.magnitude - norm(deltaV)) <= 1e-12 * norm(deltaV),
        `rotation changed the magnitude: ${eci.magnitude} vs ${norm(deltaV)}`);
      const err = norm(back.deltaV.map((x, k) => x - deltaV[k])) / norm(deltaV);
      worst = Math.max(worst, err);
      assert.ok(err <= 1e-12,
        `RIC -> ECI -> RIC did not close for [${deltaV}]: rel ${err}`);
    }
    console.log(`[${runtimeKind}] RIC->ECI->RIC worst relative closure: ${worst.toExponential(3)}`);
  });

  test(`a retrograde along-track burn comes back NEGATIVE on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) return;
    t.after(async () => harness.destroy());

    // GEO -> LEO. Both burns brake.
    const down = await invokeJsonRequest(harness, {
      operation: "hohmannTransfer",
      params: { r1: 42_164_000, r2: 6_678_137, mu: MU_EARTH },
    });
    // ...and the mirror image, which must come back positive. Without the
    // control, "always negative" would pass this test too.
    const up = await invokeJsonRequest(harness, {
      operation: "hohmannTransfer",
      params: { r1: 6_678_137, r2: 42_164_000, mu: MU_EARTH },
    });

    assert.equal(down.frame, "RIC", "the response must declare its delta-v frame");
    assert.equal(up.frame, "RIC");

    assert.ok(down.dv1 < 0, `descent dv1 must be negative, got ${down.dv1}`);
    assert.ok(down.dv2 < 0, `descent dv2 must be negative, got ${down.dv2}`);
    assert.ok(down.dv1_ric[1] < 0, `descent in-track component must be negative, got ${down.dv1_ric[1]}`);
    assert.ok(up.dv1 > 0, `ascent dv1 must be positive, got ${up.dv1}`);
    assert.ok(up.dv2 > 0, `ascent dv2 must be positive, got ${up.dv2}`);

    // The scalar IS the in-track component — one number, not two that can drift.
    assert.equal(down.dv1, down.dv1_ric[1]);
    assert.equal(down.dv2, down.dv2_ric[1]);

    // The budget is a magnitude and stays positive in both directions.
    assert.ok(down.totalDeltaV > 0 && up.totalDeltaV > 0);
    assert.ok(Math.abs(down.totalDeltaV - (Math.abs(down.dv1) + Math.abs(down.dv2))) <= 1e-9);

    // Descent and ascent between the same two radii cost the same and differ
    // only in sign — which is exactly what std::abs() hid.
    assert.ok(Math.abs(down.totalDeltaV - up.totalDeltaV) <= 1e-6 * up.totalDeltaV);
    console.log(`[${runtimeKind}] GEO->LEO dv1 ${down.dv1.toFixed(3)} m/s, ` +
      `LEO->GEO dv1 ${up.dv1.toFixed(3)} m/s, budget ${up.totalDeltaV.toFixed(3)} m/s`);
  });

  test(`an unnamed or impossible frame is a TYPED REFUSAL on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, {
      enableThreads: true,
    });
    if (!harness) return;
    t.after(async () => harness.destroy());

    // Raw invoke: a helper that throws on a non-zero status cannot tell
    // "returned a structured refusal" from "trapped", which is the whole
    // distinction here.
    const probe = async (params) => {
      const response = await harness.invoke({
        methodId: "invoke",
        inputs: [{
          portId: "request",
          payload: new TextEncoder().encode(
            JSON.stringify({ operation: "transformDeltaV", params }),
          ),
        }],
      });
      const frame = response.outputs?.find((e) => e.portId === "response");
      return {
        statusCode: response.statusCode,
        body: frame ? JSON.parse(new TextDecoder().decode(frame.payload)) : null,
      };
    };

    // The D1 defect is that a frame was ASSUMED. An unknown frame name is a
    // refusal, never a silent fallback to RIC.
    const bad = await probe({ ...STATE, deltaV: [1, 2, 3], from: "VNB" });
    assert.notEqual(bad.statusCode, 0, "an unknown frame must not succeed");
    assert.equal(bad.body.errorCode, "invalid-parameter");
    assert.match(bad.body.error, /RIC/);
    assert.match(bad.body.error, /ECI/);

    // A purely radial state has no orbit normal, so no RIC frame exists at
    // all. That is SINGULAR, not INVALID_PARAMETER, and not a silent answer.
    const collinear = await probe({
      position: [7_000_000, 0, 0], velocity: [1_000, 0, 0], deltaV: [1, 0, 0],
    });
    assert.notEqual(collinear.statusCode, 0);
    assert.equal(collinear.body.errorCode, "singular-configuration");
  });
}
