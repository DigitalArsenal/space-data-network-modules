// TEME and GCRF answers of propagate_state (1.2.0, output_frame).
//
// Authority: analysis/epoch-state/tests/vallado-verification.json. Vallado's
// SGP4-VER.TLE sets (near-Earth, Molniya, GEO; 1980-2006) with their t = 0
// TEME rows from tcppver.out as shipped in python-sgp4 2.27, and the GCRF
// state pyerfa 2.0.1.5 computes from each row: GCRF -> TEME = Rz(ee06a)
// pnm06a at TT from UTC, velocity with the frame rate by a +/-600 s central
// difference. Fixture units km and km/s, module units m and m/s, UTC epochs.
//
// Checks, per set, at the set's epoch:
// - the GCRF answer against pyerfa's GCRF: within 2e-5 m and 2e-6 m/s, the
//   fixture's printing (TEME rows to 1e-8 km and 1e-9 km/s per component,
//   carried through the rotation). Measured 2026-10-10: at most 6.9e-6 m and
//   6.4e-7 m/s, the same as the TEME answer against the TEME row (the module
//   rebuilds the set's epoch from a Julian-date double, and the request epoch
//   lands within a microsecond of it).
// - the rotation alone: the module's GCRF and TEME answers at one epoch differ
//   by its own TEME -> GCRF rotation; that difference against pyerfa's
//   (gcrf - teme) is within 1e-6 m and 1e-7 m/s (measured at most 2.4e-8 m and
//   2.4e-9 m/s: the same ERFA series, to rounding).
// A wrong frame is far larger: the frame bias alone (23 mas) moves a LEO
// position 0.8 m, and leaving out the frame rate moves a LEO velocity 7e-5 m/s.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { invokePiv, loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";
import {
  ReferenceFrame,
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "./lib/payloadEncoders.mjs";

const FIXTURE = JSON.parse(fs.readFileSync(new URL("../../../analysis/epoch-state/tests/vallado-verification.json", import.meta.url), "utf8"));
const OMM_TYPE = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const PROP_TYPE = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };
// PropagatorState.referenceFrame codes.
const STATE_FRAME = { ECEF: 1, TEME: 2, ICRF: 3 };

const sub = (a, b) => a.map((x, i) => x - b[i]);
const norm = (a) => Math.hypot(...a);
const km = (a) => a.map((x) => x * 1000);

function answer(module, epoch, catalogNumber, outputFrame) {
  const result = invokePiv(module, {
    methodId: "propagate_state",
    inputs: [{ portId: "request", payload: encodePropagatorBatchRequest({ epoch, catalogNumbers: [catalogNumber], outputFrame }), typeRef: PROP_TYPE }],
    outputStreamCap: 1,
  });
  return result;
}

test("GCRF answers match pyerfa's for Vallado's verification sets", async () => {
  const module = await loadRawSgp4Module();
  try {
    for (const c of FIXTURE.cases) {
      const ingest = invokePiv(module, { methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: OMM_TYPE, payload: encodeOmmPayload({
        noradId: c.satnum, objectId: c.entityId, objectName: `SGP4-VER ${c.satnum}`, epoch: c.epochIso,
        meanMotion: c.MEAN_MOTION, eccentricity: c.ECCENTRICITY, inclination: c.INCLINATION, raan: c.RA_OF_ASC_NODE,
        argPericenter: c.ARG_OF_PERICENTER, meanAnomaly: c.MEAN_ANOMALY, bstar: c.BSTAR, meanMotionDot: 0, meanMotionDdot: 0,
      }) }] });
      assert.equal(ingest.response.STATUS_CODE, 0, ingest.response.ERROR_MESSAGE);
    }
    for (const c of FIXTURE.cases) {
      const epoch = 2440587.5 + c.epochUnix / 86400;
      const teme = answer(module, epoch, c.satnum, ReferenceFrame.TEME);
      const gcrf = answer(module, epoch, c.satnum, ReferenceFrame.ICRF);
      for (const result of [teme, gcrf]) assert.equal(result.response.STATUS_CODE, 0, result.response.ERROR_MESSAGE);
      const t = decodePropagatorState(teme.outputPayloads[0].bytes);
      const g = decodePropagatorState(gcrf.outputPayloads[0].bytes);
      assert.equal(t.referenceFrame, STATE_FRAME.TEME);
      assert.equal(g.referenceFrame, STATE_FRAME.ICRF);
      assert.equal(g.catalogNumber, c.satnum);
      assert.ok(t.valid && g.valid);

      const errorR = norm(sub(g.position, km(c.gcrfR)));
      const errorV = norm(sub(g.velocity, km(c.gcrfV)));
      assert.ok(errorR <= 2e-5 && errorV <= 2e-6, `${c.satnum}: GCRF differs from pyerfa by ${errorR} m, ${errorV} m/s`);
      const rotationR = norm(sub(sub(g.position, t.position), sub(km(c.gcrfR), km(c.temeR))));
      const rotationV = norm(sub(sub(g.velocity, t.velocity), sub(km(c.gcrfV), km(c.temeV))));
      assert.ok(rotationR <= 1e-6 && rotationV <= 1e-7, `${c.satnum}: TEME->GCRF rotation differs from pyerfa's by ${rotationR} m, ${rotationV} m/s`);
      // The rotation preserves |r| exactly up to rounding.
      assert.ok(Math.abs(norm(g.position) - norm(t.position)) < 1e-6);
    }
  } finally {
    module._plugin_destroy();
  }
});

test("output_frame defaults to the Earth-fixed answer and refuses frames it does not produce", async () => {
  const module = await loadRawSgp4Module();
  try {
    assert.equal(invokePiv(module, { methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: OMM_TYPE, payload: encodeOmmPayload() }] }).response.STATUS_CODE, 0);
    const earthFixed = answer(module, 2460310.5, 25544, ReferenceFrame.ECEF);
    assert.equal(decodePropagatorState(earthFixed.outputPayloads[0].bytes).referenceFrame, STATE_FRAME.ECEF);
    for (const frame of [ReferenceFrame.J2000, ReferenceFrame.MCI, ReferenceFrame.MCMF]) {
      const refused = answer(module, 2460310.5, 25544, frame);
      assert.equal(refused.response.STATUS_CODE, 400);
      assert.equal(refused.response.ERROR_CODE, "unsupported-frame");
    }
  } finally {
    module._plugin_destroy();
  }
});
