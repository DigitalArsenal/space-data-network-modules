// A 1.1.0 host sees the same bytes: every invocation of
// legacy-propagate-state-cases.mjs (ingestion, handle-only propagate_state in
// Earth-fixed axes, an out-of-range handle and an output-cap refusal) returns
// exactly the PIV response the 1.1.0 artifact returned
// (tests/fixtures/propagate-state-1.1.0-digests.json).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";
import { legacyRounds } from "./legacy-propagate-state-cases.mjs";

const REFERENCE = JSON.parse(fs.readFileSync(new URL("./fixtures/propagate-state-1.1.0-digests.json", import.meta.url), "utf8"));

test("1.1.0 requests get the 1.1.0 responses byte for byte", async () => {
  const module = await loadRawSgp4Module();
  try {
    assert.deepEqual(legacyRounds(module), REFERENCE.rounds);
  } finally {
    module._plugin_destroy();
  }
});
