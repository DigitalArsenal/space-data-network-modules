import fs from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { normalizeParityFixture, runParityHarness, formatParityReport } from "space-data-module-sdk/testing";
import { ACWStateSampleT } from "spacedatastandards.org/lib/js/ACW/ACWStateSample.js";
import { cases, invalidCases, legacyCase, requestFor, station, constraint, set, K, OP } from "./constraints-fixture.mjs";

const orekit = JSON.parse(fs.readFileSync(new URL("./data/orekit-elevation.json", import.meta.url)));
const orekitCase = {
  id: "orekit-published-elevation-edges",
  fields: {
    GROUND_STATIONS: [station("GSTATION", { LATITUDE_RAD: orekit.station.latitudeDeg * Math.PI / 180, LONGITUDE_RAD: orekit.station.longitudeDeg * Math.PI / 180 })],
    STATES: orekit.samples.map(([seconds, x, y, z]) => new ACWStateSampleT(orekit.epochJulianDateTT + seconds / 86400, x, y, z)),
    CONSTRAINTS: set(OP.ALL_OF, [constraint(K.MIN_ELEVATION, "Orekit five-degree elevation", { THRESHOLD_RAD: 5 * Math.PI / 180 })]),
    ROOT_TOLERANCE_S: 0.001,
  },
};
const night = JSON.parse(fs.readFileSync(new URL("./data/orekit-night.json", import.meta.url)));
const nightSample = (seconds, position) => new ACWStateSampleT(night.epochJulianDateTT + seconds / 86400, ...position);
const nightCase = {
  id: "orekit-published-civil-night-duration",
  fields: {
    GROUND_STATIONS: [station("orekit-civil-night", { LATITUDE_RAD: 43 * Math.PI / 180 })],
    STATES: [nightSample(0, night.targetPositionM), nightSample(night.durationSeconds, night.targetPositionM)],
    SUN_STATES: night.sunSamples.map(([seconds, ...position]) => nightSample(seconds, position)),
    CONSTRAINTS: set(OP.ALL_OF, [constraint(K.SUN_EXCLUSION, "civil-night zenith solar exclusion", { THRESHOLD_RAD: night.sunExclusionThresholdRad })]),
    ROOT_TOLERANCE_S: 0.001,
  },
};
const inputs = [...cases, ...invalidCases, legacyCase, orekitCase, nightCase].map((fixture) => {
  const request = requestFor(fixture.fields);
  return { id: fixture.id, request: { ...request, inputs: request.inputs.map(({ payload, ...frame }) => ({ ...frame, payloadHex: Buffer.from(payload).toString("hex") })) } };
});
const plan = await normalizeParityFixture({ name: "lane06 ACW constraint geometry, attribution, invalid inputs and legacy", threadCounts: [1, 2, 4, 8], cases: inputs });
const report = await runParityHarness({ wasmPath: fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)), plan, timeoutMs: 60000, log: console.log });
console.log(formatParityReport(report));
if (process.env.LANE06_ACCESS_PARITY_REPORT) fs.writeFileSync(process.env.LANE06_ACCESS_PARITY_REPORT, JSON.stringify(report, null, 2));
assert.equal(report.ok, true, JSON.stringify(report.failures));
