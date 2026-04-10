import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const OBSERVATION_ENVELOPE = JSON.stringify({
  observations: [
    {
      date: "2025-01-02",
      value: "4.33",
      realtime_start: "2025-01-02",
      realtime_end: "2025-01-02",
    },
    {
      date: "2025-01-03",
      value: "4.11",
      realtime_start: "2025-01-03",
      realtime_end: "2025-01-03",
    },
    {
      date: "2025-01-04",
      value: "4.09",
      realtime_start: "2025-01-04",
      realtime_end: "2025-01-04",
    },
    {
      date: "2025-01-05",
      value: "4.05",
      realtime_start: "2025-01-05",
      realtime_end: "2025-01-05",
    },
  ],
});

const BARE_ARRAY = JSON.stringify([
  {
    date: "2025-01-02",
    value: "4.33",
    realtime_start: "2025-01-02",
    realtime_end: "2025-01-02",
  },
]);

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`version request returns the package version on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "version",
      params: {},
    });
    assert.equal(result.version, "0.1.0");
  });

  test(`validate rejects empty payloads on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "validate",
      params: { input: "" },
    });
    assert.equal(result.valid, false);
  });

  test(`parseJson preserves recordCount while limiting emitted records on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "parseJson",
      params: { input: OBSERVATION_ENVELOPE },
    });

    assert.equal(result.version, 1);
    assert.equal(result.recordCount, 4);
    assert.equal(result.records.length, 3);
    assert.equal(result.records[0].value, 4.33);
    assert.equal(result.records[0].sourceId, "2025-01-02");
    assert.equal(result.records[0].category, "2025-01-02");
    assert.equal(result.records[0].description, "2025-01-02");
    assert.equal(result.records[1].timestamp - result.records[0].timestamp, 86_400);
    assert.equal(result.records[2].timestamp - result.records[1].timestamp, 86_400);
  });

  test(`parseJson accepts bare observation arrays on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    const result = await invokeJsonRequest(harness, {
      operation: "parseJson",
      params: { input: BARE_ARRAY },
    });

    assert.equal(result.recordCount, 1);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].value, 4.33);
    assert.equal(result.records[0].latitude, 0);
    assert.equal(result.records[0].longitude, 0);
  });
}
