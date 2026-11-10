// teme.test.mjs: TEME through the BUILT module (dist/isomorphic/module.wasm, $FRM STATE_TRANSFORM over the SDK host).
//
// TEME is the frame SGP4 writes, as AIAA 2006-6753 defines it (Vallado, Crawford, Hujsak and Kelso, "Revisiting
// Spacetrack Report #3", sec. II.D eq. 1, Appendix C eq. C-2): r_PEF = R3(GMST82(UT1)) r_TEME.
//
// 1. The paper's example (Rev 2, Appendix C; 2004-04-06 07:51:28.386009 UTC, dUT1 -0.439961 s, xp -0.140682",
//    yp 0.333309"; LOD 0.0015563 s from Rev 3's listing of the same example): its TEME state and its ITRF state, each
//    turned into the other by the module. dX = dY = 0, as the paper's TEME -> ITRF has no nutation in it. Bound 1 cm:
//    the printed pair itself is 8.1 mm apart under GMST82 (pyerfa gmst82 and pom00, independent of this module; the
//    paper carries the Julian date in one double, 40 us of time, 2.3 cm at this radius). Velocity 0.1 mm/s: the paper
//    turns the velocity with the Earth rotation rate 7.292115146706979e-5 rad/s, the derivative of R3(GMST82) is
//    7.09e-12 rad/s faster (0.056 mm/s here). Then TEME -> GCRF and back against the GCRF of the same state in
//    Vallado's Fundamentals, Example 3-15 (5102.508958, 6123.011401, 6378.136928 km; -4.743220156, 0.790536497,
//    5.533755728 km/s, as tests/reference_frame_cases.cpp and analysis/reference-states carry it), which applied the
//    CIP offsets this TEME leaves out: 3.4 mm, bound 1 cm. The 0.2.1 module (TEME x axis by GMST06) missed both by
//    0.10 and 0.11 m.
// 2. The module against propagator/sdn-ap's own rotation (src/gcrf.inc, R3(GAST06 - GMST82) NPB06; its BUILT
//    dist/isomorphic/module.wasm, export sdnap_frame_probe) at the geosynchronous radius, both directions, at four
//    instants every fourth year from 1980 to 2028: within 1 mm (sdn-ap's fit path rounds GMST82 to 3.6e-11 rad,
//    gcrf.inc; the worst measured here is 0.61 mm; the 0.2.1 module was 2.7 to 14.2 m off). Velocities within 1 mm/s:
//    this module adds the frame rate (R' r, 0.39 mm/s at worst here), sdn-ap turns the velocity with the matrix alone.
//    After 2028 the module refuses the date (ERFA's leap-second table: release year 2023 plus 5).
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as flatbuffers from "flatbuffers";
import {
  FRM,
  FRMFrameTransformRequestT,
  FRMStateVectorT,
  FRMT,
  FRMVector3T,
  frmOperationCode,
  frmResultStatus,
  frmStateRepresentation,
  RFMCoordinateSystemT,
  RFMOriginT,
  rfmAxisType,
  rfmOriginKind,
} from "spacedatastandards.org/lib/js/FRM/main.js";
import { EOP, EOPT } from "spacedatastandards.org/lib/js/EOP/main.js";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";

const WASM = fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const SDNAP_WASM = fileURLToPath(new URL("../../../propagator/sdn-ap/dist/isomorphic/module.wasm", import.meta.url));
const AS = Math.PI / 648000;
const EARTH = 399;
const EPOCH = "2004-04-06T07:51:28.386009";

const PAPER_TEME = { r: [5094.18016210, 6127.64465950, 6380.34453270], v: [-4.746131487, 0.785818041, 5.531931288] };
const PAPER_ITRF = { r: [-1033.47938300, 7901.29527540, 6380.35659580], v: [-3.225636520, -2.872451450, 5.531924446] };
const EXAMPLE_3_15_GCRF = { r: [5102.508958, 6123.011401, 6378.136928], v: [-4.743220156, 0.790536497, 5.533755728] };

const system = (name, axisType, epoch) =>
  new RFMCoordinateSystemT(name, axisType, new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, EARTH), EARTH, epoch, "UTC", null);
const AXES = {
  TEME: rfmAxisType.TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE,
  GCRF: rfmAxisType.ICRF,
  ITRF: rfmAxisType.BODY_FIXED,
};

function paperEop() {
  const builder = new flatbuffers.Builder(1024);
  const row = new EOPT("2004-04-06T00:00:00Z", 53101, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    -0.140682 * AS, 0.333309 * AS, 0.0, 0.0, -0.439961, 0.0015563, "2004-04-06T00:00:00Z", "aiaa-2006-6753-appendix-c");
  EOP.finishEOPBuffer(builder, row.pack(builder));
  return builder.asUint8Array();
}

/** A state (km, km/s) from one axis set to another at `epoch`, by the module. */
async function transform(harness, epoch, from, to, state, eop = null) {
  const m = [...state.r, ...state.v].map((value) => value * 1000);
  const source = new FRMStateVectorT(frmStateRepresentation.CARTESIAN, m, new FRMVector3T(...m.slice(0, 3)),
    new FRMVector3T(...m.slice(3)), from, epoch, "UTC", 3.986004418e14);
  const builder = new flatbuffers.Builder(4096);
  const request = new FRMFrameTransformRequestT(frmOperationCode.STATE_TRANSFORM, null, null, 0, 0, null,
    system(from, AXES[from], epoch), system(to, AXES[to], epoch), source, frmStateRepresentation.CARTESIAN, epoch, "UTC", null);
  FRM.finishFRMBuffer(builder, new FRMT(request, null).pack(builder));
  const inputs = [{ portId: "request", typeRef: { schemaName: "FRM.fbs", fileIdentifier: "$FRM", rootTypeName: "FRM" }, payload: builder.asUint8Array() }];
  if (eop) inputs.push({ portId: "earth_orientation", typeRef: { schemaName: "EOP.fbs", fileIdentifier: "$EOP", rootTypeName: "EOP" }, payload: eop });
  const response = await harness.invoke({ methodId: "transform_frame_position", inputs });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const result = FRM.getRootAsFRM(new flatbuffers.ByteBuffer(response.outputs[0].payload)).FRAME_TRANSFORM_RESULT();
  assert.equal(result.STATUS(), frmResultStatus.OK, `${from} -> ${to} at ${epoch}: ${result.ERROR_MESSAGE()}`);
  const out = result.TARGET_STATE();
  return {
    r: [out.POSITION().X(), out.POSITION().Y(), out.POSITION().Z()].map((value) => value / 1000),
    v: [out.VELOCITY().X(), out.VELOCITY().Y(), out.VELOCITY().Z()].map((value) => value / 1000),
  };
}

/** Distance in metres and speed difference in metres/second. */
const apart = (a, b) => ({
  m: Math.hypot(...a.r.map((value, i) => value - b.r[i])) * 1e3,
  mps: Math.hypot(...a.v.map((value, i) => value - b.v[i])) * 1e3,
});

test("TEME is AIAA 2006-6753's: its example both ways through the built module", async () => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), surface: "direct" });
  const eop = paperEop();
  const cases = [
    ["TEME", "ITRF", PAPER_TEME, PAPER_ITRF],
    ["ITRF", "TEME", PAPER_ITRF, PAPER_TEME],
    ["TEME", "GCRF", PAPER_TEME, EXAMPLE_3_15_GCRF],
    ["GCRF", "TEME", EXAMPLE_3_15_GCRF, PAPER_TEME],
  ];
  for (const [from, to, input, expected] of cases) {
    const d = apart(await transform(harness, EPOCH, from, to, input, eop), expected);
    console.log(`  ${from} -> ${to}: ${(d.m * 1e3).toFixed(2)} mm, ${(d.mps * 1e3).toFixed(4)} mm/s`);
    assert.ok(d.m <= 0.01, `${from} -> ${to} misses the published state by ${d.m} m`);
    assert.ok(d.mps <= 1e-4, `${from} -> ${to} misses the published velocity by ${d.mps} m/s`);
  }
});

test("TEME agrees with propagator/sdn-ap's rotation at the geosynchronous radius, 1980 to 2028", async () => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), surface: "direct" });
  const sdnap = await createStandaloneHarness("browser", SDNAP_WASM, { surface: "direct", maxThreads: 1, enableBrowserWasiThreads: false });
  const x = sdnap.instance.exports;
  /** sdnap_frame_probe: mode 0 GCRF -> TEME, 1 TEME -> GCRF (km, km/s) at a UTC instant. */
  const probe = (epoch, state, mode) => {
    const [, y, mo, d, h, mi, s] = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):([\d.]+)/.exec(epoch);
    const whole = Date.UTC(+y, +mo - 1, +d) / 86400000 + 2440587.5;
    const frac = (+h * 3600 + +mi * 60 + +s) / 86400;
    const pin = x.sdnap_alloc(48), pout = x.sdnap_alloc(48);
    new Float64Array(sdnap.memory.buffer, pin, 6).set([...state.r, ...state.v]);
    const status = x.sdnap_frame_probe(whole, frac, pin, pout, mode);
    const out = Array.from(new Float64Array(sdnap.memory.buffer, pout, 6));
    x.sdnap_free(pin);
    x.sdnap_free(pout);
    assert.equal(status, 0, `sdn-ap refused ${epoch}`);
    return { r: out.slice(0, 3), v: out.slice(3) };
  };
  const GEO = 42164.0, SPEED = 3.0747;
  let worst = 0, worstSpeed = 0;
  for (let year = 1980; year <= 2028; year += 4) {
    for (const [k, time] of [[0, "00:00:00"], [1, "06:17:43.5"], [2, "13:31:07.25"], [3, "19:59:59.875"]]) {
      const epoch = `${year}-${String(1 + 3 * k).padStart(2, "0")}-${String(1 + 7 * k).padStart(2, "0")}T${time}`;
      const a = ((97 * k + year) * Math.PI) / 180;
      const state = { r: [GEO * Math.cos(a), GEO * Math.sin(a), 0.01 * GEO], v: [-SPEED * Math.sin(a), SPEED * Math.cos(a), 0] };
      for (const [from, to, mode] of [["TEME", "GCRF", 1], ["GCRF", "TEME", 0]]) {
        const d = apart(await transform(harness, epoch, from, to, state), probe(epoch, state, mode));
        worst = Math.max(worst, d.m);
        worstSpeed = Math.max(worstSpeed, d.mps);
        assert.ok(d.m <= 1e-3, `${from} -> ${to} at ${epoch}: ${d.m} m from sdn-ap's rotation`);
        assert.ok(d.mps <= 1e-3, `${from} -> ${to} at ${epoch}: ${d.mps} m/s from sdn-ap's rotation`);
      }
    }
  }
  console.log(`  worst ${(worst * 1e3).toFixed(3)} mm, ${(worstSpeed * 1e3).toFixed(3)} mm/s at ${GEO} km`);
});
