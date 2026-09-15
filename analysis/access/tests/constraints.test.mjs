import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { cases, invalidCases, legacyCase, metadata, requestFor, resultFrom, EPOCH_TT, EDGE_TOLERANCE_S, MODE } from "./constraints-fixture.mjs";

test("SDS ACW constraints match independent analytical geometry", async (t) => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url)), surface: "direct" });
  let maximumEdgeError = 0;
  let maximumRangeError = 0;
  try {
    for (const fixture of cases) {
      await t.test(fixture.id, async (t) => {
        const response = await harness.invoke(requestFor(fixture.fields));
        assert.equal(response.statusCode, 0, response.errorMessage);
        const result = resultFrom(response);
        assert.equal(result.STATUS, 0, result.ERROR_MESSAGE);
        assert.equal(result.TRACE_ID, "lane06-constraints");
        assert.deepEqual(result.CONSTRAINT_LABELS, fixture.labels);
        const mode = fixture.fields.EVALUATION_MODE ?? MODE.CONTINUOUS;
        assert.equal(result.EVALUATION_MODE, mode);
        assert.equal(result.WINDOWS.length, fixture.windows.length, fixture.formula);
        const actualWindows = [...result.WINDOWS].sort((a, b) => (a.START_JULIAN_DATE_TT - b.START_JULIAN_DATE_TT) || (a.OBSERVER_ID ?? "").localeCompare(b.OBSERVER_ID ?? ""));
        let caseEdgeError = 0;
        for (let i = 0; i < fixture.windows.length; ++i) {
          const expected = fixture.windows[i];
          const actual = actualWindows[i];
          assert.equal(actual.EDGES_REFINED, mode === MODE.CONTINUOUS);
          assert.equal(actual.OBSERVER_ID || "", expected.observerId ?? "");
          if (!expected.observerId) assert.equal(actual.STATION_ID, expected.stationId ?? "ground");
          for (const [field, seconds] of [["START_JULIAN_DATE_TT", expected.start], ["END_JULIAN_DATE_TT", expected.end]]) {
            const error = Math.abs((actual[field] - EPOCH_TT) * 86400 - seconds);
            caseEdgeError = Math.max(caseEdgeError, error);
            maximumEdgeError = Math.max(maximumEdgeError, error);
            assert.ok(error <= (fixture.edgeTolerance ?? EDGE_TOLERANCE_S), `${field}: ${error}s; ${fixture.formula}`);
          }
          for (const [prefix, index] of [["START", expected.startIndex], ["END", expected.endIndex]]) {
            if (index === undefined) continue;
            assert.equal(actual[`${prefix}_LIMITING_CONSTRAINT_INDEX`], index, `${prefix} attribution`);
            assert.equal(actual[`${prefix}_LIMITING_CONSTRAINT_LABEL`] || "", index < 0 ? "" : fixture.labels[index]);
          }
          if (expected.sampleCount !== undefined) assert.equal(actual.SAMPLE_COUNT, expected.sampleCount);
          for (const [field, value] of [["MIN_RANGE_M", expected.minRange], ["MAX_RANGE_M", expected.maxRange]]) {
            if (value === undefined) continue;
            const error = Math.abs(actual[field] - value);
            maximumRangeError = Math.max(maximumRangeError, error);
            assert.ok(error <= (expected.rangeTolerance ?? 1), `${field}: ${actual[field]} vs ${value}; error=${error}m`);
          }
        }
        t.diagnostic(`${fixture.formula}; maximum edge error=${caseEdgeError}s`);
      });
    }
    for (const fixture of invalidCases) {
      await t.test(`invalid: ${fixture.id}`, async () => {
        const response = await harness.invoke(requestFor(fixture.fields));
        const result = resultFrom(response);
        assert.equal(result.STATUS, 1, `Must fail closed: ${fixture.id}`);
        assert.ok(result.ERROR_MESSAGE?.length > 0);
        assert.equal(result.WINDOWS.length, 0);
      });
    }
    await t.test("absent constraint composition preserves legacy elevation interpolation", async () => {
      const response = await harness.invoke(requestFor(legacyCase.fields));
      assert.equal(response.statusCode, 0, response.errorMessage);
      const result = resultFrom(response);
      assert.equal(result.STATUS, 0, result.ERROR_MESSAGE);
      assert.equal(result.WINDOWS.length, 1);
      const window = result.WINDOWS[0];
      assert.ok(Math.abs((window.START_JULIAN_DATE_TT - EPOCH_TT) * 86400 - 30) < 0.001);
      assert.ok(Math.abs((window.END_JULIAN_DATE_TT - EPOCH_TT) * 86400 - 90) < 0.001);
      assert.ok(Math.abs(window.MAX_ELEVATION_RAD - Math.PI / 4) < 1e-12);
    });
    t.diagnostic(`${JSON.stringify(metadata)}; maximum measured edge error=${maximumEdgeError}s; maximum measured range error=${maximumRangeError}m`);
  } finally { await harness.destroy(); }
});
