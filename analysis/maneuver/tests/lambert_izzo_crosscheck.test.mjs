/**
 * LAMBERT HONESTY, cross-checked against a second solver.
 *
 * `vectors.test.mjs` already proves that every arc this module claims to have
 * solved actually ARRIVES: it re-propagates the returned departure velocity
 * and measures the miss at r2. That is a self-consistency check — a strong
 * one, but the propagator and the solver share this module.
 *
 * This file closes the other half of the acceptance for
 * gmat-01-defect-burn-down: where `converged` is true, the terminal
 * velocities must agree with `analysis/lambert-izzo`, the SDN module home for
 * Izzo's revisited algorithm with Householder iteration (upstream
 * `sakobu/izzos-lambert` v2.0.0). The planner now delegates to that package's
 * shared kernel, so this is also a build-and-wire check that the two public
 * surfaces still expose the same trajectory.
 *
 * The second assertion is the one the defect record demands: a geometry with
 * no arc must come back as `converged: false` with a typed refusal, not as a
 * silent success. Through 0.1.0 `converged` was the literal `true` on every
 * path, including MAX_ITER exhaustion.
 *
 * Both solvers own their physics. Nothing here recomputes a transfer in
 * JavaScript; the only arithmetic is the difference between two modules'
 * answers.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { LMS, lambertTransferPath } from "spacedatastandards.org/lib/js/LMS/main.js";
import { LMO, lambertSolveState } from "spacedatastandards.org/lib/js/LMO/main.js";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const IZZO_PATH = new URL("../../lambert-izzo/dist/isomorphic/module.wasm", import.meta.url);

const MU_SI = 3.986004418e14;      // m^3/s^2
const MU_KM = MU_SI / 1e9;         // km^3/s^2
const R1_SI = 6_678_137;
const R2_SI = 7_378_137;
const PERIOD = 2 * Math.PI * Math.sqrt(R1_SI ** 3 / MU_SI);

/** The agreement band the task pins. */
const REL_TOL = 1e-9;

const norm = (v) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);

/** One `solveLambert` call, returning the structured body whatever the status. */
async function solveOurs(harness, params) {
  const raw = await harness.invoke({
    methodId: "invoke",
    inputs: [{
      portId: "request",
      payload: Buffer.from(JSON.stringify({ operation: "solveLambert", params }), "utf8"),
    }],
  });
  const frame = raw.outputs?.find((entry) => entry.portId === "response");
  return {
    statusCode: raw.statusCode,
    body: frame ? JSON.parse(new TextDecoder().decode(frame.payload)) : null,
  };
}

/** One `solve_lambert` call on the Izzo module, over the canonical $LMS/$LMO records. */
async function solveIzzo(harness, { r1Km, r2Km, tof, way }) {
  const builder = new flatbuffers.Builder(256);
  const frameOffset = builder.createString("GCRF");
  const idOffset = builder.createString("gmat-01-crosscheck");
  LMS.startLMS(builder);
  LMS.addRequestId(builder, idOffset);
  LMS.addR1X(builder, r1Km[0]);
  LMS.addR1Y(builder, r1Km[1]);
  LMS.addR1Z(builder, r1Km[2]);
  LMS.addR2X(builder, r2Km[0]);
  LMS.addR2Y(builder, r2Km[1]);
  LMS.addR2Z(builder, r2Km[2]);
  LMS.addTofSec(builder, tof);
  LMS.addMuKm3S2(builder, MU_KM);
  LMS.addTransferWay(builder, way);
  LMS.addMaxRevs(builder, 0);
  LMS.addRefFrame(builder, frameOffset);
  builder.finish(LMS.endLMS(builder), "$LMS");

  const raw = await harness.invoke({
    methodId: "solve_lambert",
    inputs: [{
      portId: "request",
      typeRef: {
        schemaName: "LMS.fbs",
        fileIdentifier: "$LMS",
        rootTypeName: "LMS",
      },
      payload: builder.asUint8Array(),
    }],
  });
  const frame = raw.outputs?.find((entry) => entry.portId === "solutions");
  if (!frame) return { statusCode: raw.statusCode, ok: false, single: null };
  const out = LMO.getRootAsLMO(new flatbuffers.ByteBuffer(frame.payload));
  if (out.STATUS() !== lambertSolveState.OK) {
    return { statusCode: raw.statusCode, ok: false, single: null,
             errorCode: out.ERROR_CODE(), errorMessage: out.ERROR_MESSAGE() };
  }
  const branch = out.SINGLE();
  if (!branch) return { statusCode: raw.statusCode, ok: false, single: null };
  const v1 = branch.V1();
  const v2 = branch.V2();
  return {
    statusCode: raw.statusCode,
    ok: true,
    single: {
      v1: [v1.X(), v1.Y(), v1.Z()],
      v2: [v2.X(), v2.Y(), v2.Z()],
      iterations: branch.ITERATIONS(),
    },
  };
}

/** The transfer-angle sweep, in the same geometry family the arrival sweep uses. */
function geometries() {
  const out = [];
  for (let degrees = 10; degrees <= 350; degrees += 20) {
    for (const orbits of [0.25, 0.5, 1.0, 2.0]) {
      const theta = (degrees * Math.PI) / 180;
      out.push({
        id: `${degrees}deg/${orbits}P`,
        degrees,
        r1: [R1_SI, 0, 0],
        r2: [R2_SI * Math.cos(theta), R2_SI * Math.sin(theta), 0],
        tof: orbits * PERIOD,
      });
    }
  }
  return out;
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`claimed Lambert solutions agree with lambert-izzo on ${runtimeKind}`, async (t) => {
    if (!existsSync(fileURLToPath(IZZO_PATH))) {
      // The reference module is not built in this tree. That means the check
      // cannot RUN — it is not evidence about our solver either way.
      return t.skip("analysis/lambert-izzo/dist/isomorphic/module.wasm is not built");
    }
    const ours = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, { enableThreads: true });
    if (!ours) return;
    t.after(async () => ours.destroy());
    const izzo = await createStandaloneHarnessOrSkip(runtimeKind, IZZO_PATH, t, { enableThreads: false });
    if (!izzo) return;
    t.after(async () => izzo.destroy());

    // Probe the reference module ONCE before measuring anything against it.
    //
    // A reference that cannot run is not evidence about our solver in either
    // direction, so this is a SKIP with the exact diagnosis printed — never a
    // pass, and never a failure attributed to the code under test.
    //
    // A typed quarter-orbit probe prevents a missing or stale standalone
    // artifact from being mistaken for agreement.
    let probe;
    try {
      probe = await solveIzzo(izzo, {
        r1Km: [R1_SI / 1000, 0, 0],
        r2Km: [0, R2_SI / 1000, 0],
        tof: 0.25 * PERIOD,
        way: lambertTransferPath.SHORT,
      });
    } catch (error) {
      return t.skip(
        "analysis/lambert-izzo cannot be invoked: " + String(error).split("\n")[0] +
        " — the reference solver is unavailable, so no agreement can be measured",
      );
    }
    if (!probe.ok) {
      return t.skip(
        `analysis/lambert-izzo refused a well-posed quarter-orbit LEO transfer ` +
        `(${probe.errorCode ?? "no error code"}: ${probe.errorMessage ?? "no message"}) ` +
        `— the reference solver is unavailable, so no agreement can be measured`,
      );
    }

    let compared = 0;
    let oursRefused = 0;
    let izzoRefused = 0;
    let worst = 0;
    let worstId = "";
    const disagreements = [];

    for (const g of geometries()) {
      const mine = await solveOurs(ours, {
        r1: g.r1, r2: g.r2, tof: g.tof, mu: MU_SI, prograde: true, nRevs: 0,
      });
      if (mine.statusCode !== 0 || mine.body?.converged !== true) {
        oursRefused += 1;
        continue;
      }
      // A prograde transfer through less than half a revolution is the SHORT
      // way; a reflex transfer angle is the LONG way. That is the only mapping
      // between the two request vocabularies.
      const way = g.degrees < 180 ? lambertTransferPath.SHORT : lambertTransferPath.LONG;
      const theirs = await solveIzzo(izzo, {
        r1Km: g.r1.map((x) => x / 1000),
        r2Km: g.r2.map((x) => x / 1000),
        tof: g.tof,
        way,
      });
      if (!theirs.ok) {
        izzoRefused += 1;
        continue;
      }

      // Ours is SI (m/s); Izzo's records are km/s.
      for (const [name, mineVec, theirsVec] of [
        ["v1", mine.body.v1, theirs.single.v1.map((x) => x * 1000)],
        ["v2", mine.body.v2, theirs.single.v2.map((x) => x * 1000)],
      ]) {
        const diff = norm(mineVec.map((x, k) => x - theirsVec[k]));
        const rel = diff / norm(theirsVec);
        if (rel > worst) { worst = rel; worstId = `${g.id}/${name}`; }
        if (rel > REL_TOL) {
          disagreements.push(`${g.id} ${name}: rel ${rel.toExponential(3)} ` +
            `(ours [${mineVec}] vs izzo [${theirsVec}])`);
        }
      }
      compared += 1;
    }

    console.error(
      `[${runtimeKind}] lambert-izzo cross-check: ${compared} geometries compared, ` +
      `${oursRefused} not claimed by us, ${izzoRefused} not solved by izzo; ` +
      `worst relative velocity disagreement ${worst.toExponential(3)} at ${worstId || "n/a"}`,
    );
    assert.deepEqual(disagreements, [],
      `${disagreements.length} geometries disagree with lambert-izzo beyond ${REL_TOL}`);
    assert.ok(compared >= 40,
      `only ${compared} geometries were comparable — the cross-check has no teeth below 40`);
  });

  test(`a geometry with no arc is a typed refusal, not a silent success on ${runtimeKind}`, async (t) => {
    const ours = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t, { enableThreads: true });
    if (!ours) return;
    t.after(async () => ours.destroy());

    // Two known non-solutions.
    //
    //   1. COLLINEAR endpoints: r2 exactly opposite r1 through the centre. The
    //      transfer plane is undefined, so no arc exists at all.
    //   2. A three-revolution arc asked of a time of flight that cannot hold
    //      three revolutions. The multi-revolution branch is not monotone, so
    //      this is the case an unguarded Newton returns its starting guess for
    //      and calls converged.
    const cases = [
      {
        id: "collinear-endpoints",
        params: { r1: [R1_SI, 0, 0], r2: [-R2_SI, 0, 0], tof: 0.5 * PERIOD,
                  mu: MU_SI, prograde: true, nRevs: 0 },
      },
      {
        id: "three-revolutions-in-a-quarter-period",
        params: { r1: [R1_SI, 0, 0], r2: [0, R2_SI, 0], tof: 0.25 * PERIOD,
                  mu: MU_SI, prograde: true, nRevs: 3 },
      },
    ];

    for (const c of cases) {
      const res = await solveOurs(ours, c.params);
      // Either shape is honest; a success body with converged=true is not.
      if (res.statusCode !== 0) {
        assert.ok(res.body?.errorCode, `${c.id}: a refusal must carry an errorCode`);
        assert.ok(res.body?.error, `${c.id}: a refusal must carry a message`);
        console.error(`[${runtimeKind}] ${c.id}: refused with ${res.body.errorCode}`);
      } else {
        assert.equal(res.body.converged, false,
          `${c.id}: reported converged=true for a geometry with no arc`);
        assert.ok(typeof res.body.status === "string" && res.body.status.length > 0,
          `${c.id}: converged=false must name why`);
        console.error(`[${runtimeKind}] ${c.id}: converged=false, status "${res.body.status}"`);
      }
    }
  });
}
