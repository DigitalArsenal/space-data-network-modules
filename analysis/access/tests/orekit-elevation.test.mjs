import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as flatbuffers from "flatbuffers";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { ACW, ACWT } from "spacedatastandards.org/lib/js/ACW/ACW.js";
import { ACWRequestT } from "spacedatastandards.org/lib/js/ACW/ACWRequest.js";
import { ACWGroundStationT } from "spacedatastandards.org/lib/js/ACW/ACWGroundStation.js";
import { ACWStateSampleT } from "spacedatastandards.org/lib/js/ACW/ACWStateSample.js";
import { ACWConstraintT } from "spacedatastandards.org/lib/js/ACW/ACWConstraint.js";
import { ACWConstraintSetT } from "spacedatastandards.org/lib/js/ACW/ACWConstraintSet.js";
import { acwConstraintKind } from "spacedatastandards.org/lib/js/ACW/acwConstraintKind.js";
import { acwEvaluationMode } from "spacedatastandards.org/lib/js/ACW/acwEvaluationMode.js";

// Published Orekit 13.1.2 ElevationDetectorTest.testIssue110, lines 264-300:
// https://raw.githubusercontent.com/CS-SI/Orekit/13.1.2/src/test/java/org/orekit/propagation/events/ElevationDetectorTest.java
// Independent Orekit ECEF samples, TT seconds and metres. The fixture includes
// the complete frame, WGS84 station, orbit, data hashes and generator provenance.
// 0.1 s tolerance is the requested accuracy and conservatively covers upstream
// 1 ms expected-value rounding, 1 s sample interpolation, 1 ms root refinement,
// and single-double Julian-Date quantization. ACW never generated these inputs
// or the expected edge times.
test("continuous elevation edges reproduce the published Orekit detector case within 0.1 s", async (t) => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./data/orekit-elevation.json", import.meta.url)));
  const radians = Math.PI / 180;
  const station = new ACWGroundStationT("GSTATION", "GSTATION", fixture.station.latitudeDeg * radians,
    fixture.station.longitudeDeg * radians, 0, 5 * radians, 1, []);
  const elevation = Object.assign(new ACWConstraintT(), {
    KIND: acwConstraintKind.MIN_ELEVATION,
    THRESHOLD_RAD: 5 * radians,
    LABEL: "Orekit five-degree elevation",
  });
  const request = Object.assign(new ACWRequestT(), {
    OPERATION: 1,
    GROUND_STATIONS: [station],
    STATES: fixture.samples.map(([seconds, x, y, z]) =>
      new ACWStateSampleT(fixture.epochJulianDateTT + seconds / 86400, x, y, z)),
    CONSTRAINTS: new ACWConstraintSetT(0, [elevation], [], "Orekit elevation"),
    EVALUATION_MODE: acwEvaluationMode.CONTINUOUS,
    ROOT_TOLERANCE_S: 0.001,
    TRACE_ID: "orekit-13.1.2-testIssue110",
  });
  const builder = new flatbuffers.Builder(32768);
  ACW.finishACWBuffer(builder, new ACWT(request, null).pack(builder));
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url)), surface: "direct",
  });
  try {
    const response = await harness.invoke({ methodId: "compute_access_windows", inputs: [{
      portId: "request", typeRef: { schemaName: "ACW.fbs", fileIdentifier: "$ACW", rootTypeName: "ACW", wireFormat: "flatbuffer" },
      payload: builder.asUint8Array(),
    }] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const result = ACW.getRootAsACW(new flatbuffers.ByteBuffer(response.outputs[0].payload)).RESULT().unpack();
    assert.equal(result.STATUS, 0, result.ERROR_MESSAGE);
    assert.equal(result.WINDOWS.length, 1);
    const window = result.WINDOWS[0];
    const actual = [window.START_JULIAN_DATE_TT, window.END_JULIAN_DATE_TT]
      .map((jd) => (jd - fixture.epochJulianDateTT) * 86400);
    const errors = actual.map((seconds, i) => Math.abs(seconds - fixture.publishedExpectedEdgesSeconds[i]));
    for (const error of errors) assert.ok(error <= fixture.acwToleranceSeconds,
      `Orekit edge error ${error} s exceeds ${fixture.acwToleranceSeconds} s`);
    assert.equal(window.EDGES_REFINED, true);
    assert.equal(window.START_LIMITING_CONSTRAINT_INDEX, 0);
    assert.equal(window.END_LIMITING_CONSTRAINT_INDEX, 0);
    assert.equal(window.START_LIMITING_CONSTRAINT_LABEL, elevation.LABEL);
    assert.equal(window.END_LIMITING_CONSTRAINT_LABEL, elevation.LABEL);
    t.diagnostic(`Orekit published edges=[${fixture.publishedExpectedEdgesSeconds}] s; ACW edges=[${actual}] s; absolute errors=[${errors}] s; tolerance=${fixture.acwToleranceSeconds} s`);
  } finally {
    await harness.destroy();
  }
});
