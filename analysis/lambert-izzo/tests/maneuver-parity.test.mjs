/**
 * Conformance tooling only. Every trajectory is computed by one of the two
 * WASM modules; JavaScript builds the 72 requests and compares returned
 * vectors. This file is not importable from a shipped bundle.
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as flatbuffers from "flatbuffers";
import { LMS, lambertTransferPath } from "spacedatastandards.org/lib/js/LMS/main.js";
import { LMO, lambertSolveState } from "spacedatastandards.org/lib/js/LMO/main.js";
import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
} from "space-data-module-sdk/testing/isomorphic";

const IZZO_WASM = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MANEUVER_WASM = new URL("../../maneuver/dist/isomorphic/module.wasm", import.meta.url);
const MU_SI = 3.986004418e14;
const MU_KM = MU_SI / 1e9;
const R1_SI = 6_678_137;
const R2_SI = 7_378_137;
const PERIOD = 2 * Math.PI * Math.sqrt(R1_SI ** 3 / MU_SI);
const RELATIVE_TOLERANCE = 1e-9;

function norm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function geometries() {
  const result = [];
  for (let degrees = 10; degrees <= 350; degrees += 20) {
    for (const orbits of [0.25, 0.5, 1.0, 2.0]) {
      const angle = degrees * Math.PI / 180;
      result.push({
        id: `${degrees}deg/${orbits}P`,
        degrees,
        r1: [R1_SI, 0, 0],
        r2: [R2_SI * Math.cos(angle), R2_SI * Math.sin(angle), 0],
        tof: orbits * PERIOD,
      });
    }
  }
  return result;
}

async function solveManeuver(harness, geometry) {
  const response = await harness.invoke({
    methodId: "invoke",
    inputs: [{
      portId: "request",
      payload: Buffer.from(JSON.stringify({
        operation: "solveLambert",
        params: {
          r1: geometry.r1,
          r2: geometry.r2,
          tof: geometry.tof,
          mu: MU_SI,
          prograde: true,
          nRevs: 0,
        },
      })),
    }],
  });
  const frame = response.outputs.find((entry) => entry.portId === "response");
  if (!frame) return null;
  const body = JSON.parse(new TextDecoder().decode(frame.payload));
  return response.statusCode === 0 && body.converged ? body : null;
}

async function solveIzzo(harness, geometry) {
  const builder = new flatbuffers.Builder(256);
  const requestId = builder.createString(geometry.id);
  const frame = builder.createString("GCRF");
  const request = LMS.createLMS(
    builder,
    requestId,
    geometry.r1[0] / 1000,
    geometry.r1[1] / 1000,
    geometry.r1[2] / 1000,
    geometry.r2[0] / 1000,
    geometry.r2[1] / 1000,
    geometry.r2[2] / 1000,
    geometry.tof,
    MU_KM,
    geometry.degrees < 180 ? lambertTransferPath.SHORT : lambertTransferPath.LONG,
    0,
    frame,
    0,
    0,
  );
  LMS.finishLMSBuffer(builder, request);
  const response = await harness.invoke({
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
  const output = response.outputs.find((entry) => entry.portId === "solutions");
  if (!output) return null;
  const result = LMO.getRootAsLMO(new flatbuffers.ByteBuffer(output.payload));
  if (result.STATUS() !== lambertSolveState.OK || !result.SINGLE()) return null;
  const branch = result.SINGLE();
  return {
    v1: [branch.V1().X(), branch.V1().Y(), branch.V1().Z()].map((value) => value * 1000),
    v2: [branch.V2().X(), branch.V2().Y(), branch.V2().Z()].map((value) => value * 1000),
  };
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`72-geometry Izzo versus maneuver sweep on ${runtimeKind}`, async (t) => {
    const maneuver = await createStandaloneHarnessOrSkip(runtimeKind, MANEUVER_WASM, t, {
      enableThreads: true,
    });
    if (!maneuver) return;
    const izzo = await createStandaloneHarnessOrSkip(runtimeKind, IZZO_WASM, t, {
      enableThreads: false,
    });
    if (!izzo) {
      await maneuver.destroy();
      return;
    }
    t.after(async () => {
      await izzo.destroy();
      await maneuver.destroy();
    });

    let compared = 0;
    let worst = 0;
    let worstId = "";
    for (const geometry of geometries()) {
      const [reference, candidate] = await Promise.all([
        solveManeuver(maneuver, geometry),
        solveIzzo(izzo, geometry),
      ]);
      if (!reference || !candidate) continue;
      for (const key of ["v1", "v2"]) {
        const difference = norm(
          reference[key].map((value, index) => value - candidate[key][index]),
        );
        const relative = difference / norm(candidate[key]);
        if (relative > worst) {
          worst = relative;
          worstId = `${geometry.id}/${key}`;
        }
      }
      compared += 1;
    }
    t.diagnostic(
      `attempted=72 compared=${compared} worst_relative=${worst.toExponential(6)} at=${worstId}`,
    );
    assert.ok(compared >= 40, `only ${compared} geometries produced solutions in both modules`);
    assert.ok(worst <= RELATIVE_TOLERANCE, `${worstId} relative disagreement ${worst}`);
  });
}
