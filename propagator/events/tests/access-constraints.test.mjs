import assert from 'node:assert/strict';
import test from 'node:test';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { accessCases, encodeAccessRequest, decodeAccessResponse, secondsOf } from './access-fixture.mjs';
const wasmPath = new URL('../dist/isomorphic/module.wasm', import.meta.url);
for (const runtime of ['browser', 'wasmedge']) {
  test(`ACW event locators: closed-form constraint geometry (${runtime})`, async () => {
    const harness = await createStandaloneHarness(runtime, wasmPath, { enableThreads: true });
    try {
      for (const fixture of accessCases()) {
        const response = await harness.invoke(encodeAccessRequest(fixture.request));
        assert.equal(response.statusCode, 0, `${fixture.id}: ${response.errorMessage}`);
        const result = decodeAccessResponse(response);
        assert.ok(result, fixture.id);
        assert.equal(result.STATUS, fixture.invalid ? 1 : 0, `${fixture.id}: ${result.ERROR_MESSAGE}`);
        if (fixture.invalid) continue;
        assert.equal(result.WINDOWS.length, fixture.expected.length, fixture.id);
        const errors = [];
        for (let i = 0; i < fixture.expected.length; i++) {
          const window = result.WINDOWS[i];
          const actual = [secondsOf(window.START_JULIAN_DATE_TT), secondsOf(window.END_JULIAN_DATE_TT)];
          for (let j = 0; j < 2; j++) {
            const error = Math.abs(actual[j] - fixture.expected[i][j]); errors.push(error);
            assert.ok(error < 0.1, `${fixture.id} edge ${i}/${j}: ${error} s`);
          }
          assert.equal(window.OBSERVER_ID, 'observer');
          if (fixture.labels) {
            assert.equal(window.START_LIMITING_CONSTRAINT_LABEL, fixture.labels[i][0]);
            assert.equal(window.END_LIMITING_CONSTRAINT_LABEL, fixture.labels[i][1]);
            assert.equal(window.START_LIMITING_CONSTRAINT_INDEX, 0);
            assert.equal(window.END_LIMITING_CONSTRAINT_INDEX, 1);
          }
          if (fixture.ranges) {
            assert.ok(Math.abs(window.MIN_RANGE_M - fixture.ranges[i][0]) < 2, `${fixture.id} min range`);
            assert.ok(Math.abs(window.MAX_RANGE_M - fixture.ranges[i][1]) < 2, `${fixture.id} max range`);
          }
        }
        console.log(`${runtime} ${fixture.id}: max edge error ${Math.max(...errors).toExponential(6)} s (bar 0.1 s)`);
      }
    } finally { await harness.close?.(); }
  });
}
