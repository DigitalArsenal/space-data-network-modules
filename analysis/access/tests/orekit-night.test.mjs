import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { ACWStateSampleT } from "spacedatastandards.org/lib/js/ACW/ACWStateSample.js";
import { K, OP, MODE, constraint, set, station, requestFor, resultFrom } from "./constraints-fixture.mjs";

// Published reference: Orekit 13.1.2 GroundAtNightDetectorTest
// testMidLatitudeCivilNoRefraction, source parameters and assertions at:
// https://raw.githubusercontent.com/CS-SI/Orekit/13.1.2/src/test/java/org/orekit/propagation/events/GroundAtNightDetectorTest.java
// The independent fixture records Earth-fixed metres, TT seconds, exact UTC
// epoch, IERS/DE405 data provenance, source tolerance and test tolerance rationale.
// With the synthetic target fixed along the station's geodetic zenith,
// angle(target,Sun) = pi/2 - solar elevation. Exclusion >=96 degrees therefore
// means solar elevation <=-6 degrees, exactly the published civil-night test.
// This exercises SUN_EXCLUSION; it does not introduce a ground-night kind.
test("solar exclusion with a zenith target reproduces Orekit civil-night duration within 0.1 s", async (t) => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./data/orekit-night.json", import.meta.url)));
  const sample = (seconds, position) => new ACWStateSampleT(fixture.epochJulianDateTT + seconds / 86400, ...position);
  const label = "civil-night zenith solar exclusion";
  const request = requestFor({
    GROUND_STATIONS: [station("orekit-civil-night", { LATITUDE_RAD: 43 * Math.PI / 180 })],
    STATES: [sample(0, fixture.targetPositionM), sample(fixture.durationSeconds, fixture.targetPositionM)],
    SUN_STATES: fixture.sunSamples.map(([seconds, ...position]) => sample(seconds, position)),
    CONSTRAINTS: set(OP.ALL_OF, [constraint(K.SUN_EXCLUSION, label, { THRESHOLD_RAD: fixture.sunExclusionThresholdRad })]),
    EVALUATION_MODE: MODE.CONTINUOUS,
    ROOT_TOLERANCE_S: 0.001,
  });
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url)), surface: "direct",
  });
  try {
    const response = await harness.invoke(request);
    assert.equal(response.statusCode, 0, response.errorMessage);
    const result = resultFrom(response);
    assert.equal(result.STATUS, 0, result.ERROR_MESSAGE);
    assert.equal(result.WINDOWS.length, 1);
    const window = result.WINDOWS[0];
    const duration = (window.END_JULIAN_DATE_TT - window.START_JULIAN_DATE_TT) * 86400;
    const error = Math.abs(duration - fixture.publishedExpectedDurationSeconds);
    assert.ok(error <= fixture.acwToleranceSeconds,
      `Orekit night-duration error ${error} s exceeds ${fixture.acwToleranceSeconds} s`);
    assert.equal(window.EDGES_REFINED, true);
    assert.equal(window.START_LIMITING_CONSTRAINT_INDEX, 0);
    assert.equal(window.END_LIMITING_CONSTRAINT_INDEX, 0);
    assert.equal(window.START_LIMITING_CONSTRAINT_LABEL, label);
    assert.equal(window.END_LIMITING_CONSTRAINT_LABEL, label);
    t.diagnostic(`Orekit published civil-night duration=${fixture.publishedExpectedDurationSeconds} s; ACW duration=${duration} s; absolute error=${error} s; tolerance=${fixture.acwToleranceSeconds} s`);
  } finally {
    await harness.destroy();
  }
});
