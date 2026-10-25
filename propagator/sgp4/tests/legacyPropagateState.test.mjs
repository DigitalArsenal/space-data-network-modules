// A 1.1.0 host's requests are still answered: every invocation of
// legacy-propagate-state-cases.mjs (ingestion, handle-only propagate_state in
// Earth-fixed axes, an out-of-range handle and an output-cap refusal) returns
// exactly the PIV response this release gives (tests/fixtures/propagate-state-digests.json).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";
import { legacyRounds } from "./legacy-propagate-state-cases.mjs";

const REFERENCE = JSON.parse(fs.readFileSync(new URL("./fixtures/propagate-state-digests.json", import.meta.url), "utf8"));

test("1.1.0-layout requests get this release's responses byte for byte", async () => {
  const module = await loadRawSgp4Module();
  try {
    assert.deepEqual(legacyRounds(module), REFERENCE.rounds);
  } finally {
    module._plugin_destroy();
  }
});
