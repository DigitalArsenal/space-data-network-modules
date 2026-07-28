/*
 * CCSDS 124.0-B-1 reference vector suite, executed IN-WASM in every available
 * runtime lane.
 *
 * Authoritative source: the reference vectors published with
 * github.com/tanagraspace/ccsds124 — `venus-express` is real ESA Venus Express
 * housekeeping telemetry, the rest are the upstream synthetic/edge suites. The
 * expected outputs are the ESA reference encoder's own bytes, so "pass" means
 * byte-for-byte agreement with the reference, not agreement with ourselves.
 * Tolerance is exact equality: this is a lossless codec, so any tolerance other
 * than zero would be meaningless.
 *
 * Point CCSDS124_VECTORS at a checkout of that repository. The vector data is
 * large (20 MB) and is deliberately not committed here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";

import { buildProbe } from "./harness/build-probe.mjs";
import {
  instantiateProbe,
  loadVectorSuite,
  PROBE_WASM,
} from "./harness/vectorRunner.mjs";

const VECTOR_ROOT = process.env.CCSDS124_VECTORS;
const SKIP = !VECTOR_ROOT && "set CCSDS124_VECTORS to a tanagraspace/ccsds124 checkout";

test("reference vectors: compress is byte-identical to the ESA reference in-wasm", { skip: SKIP }, async (t) => {
  if (!existsSync(PROBE_WASM)) await buildProbe();
  const suite = await loadVectorSuite(VECTOR_ROOT);
  const probe = await instantiateProbe();

  assert.equal(suite.length, 5, "the reference suite is five vectors");

  for (const vector of suite) {
    await t.test(`${vector.name} (${vector.inputBytes.length / (vector.fBits / 8)} packets)`, () => {
      const result = probe.compress(vector.inputBytes, vector);
      assert.equal(result.rc, 0, `compress returned ${result.rc}`);
      assert.deepEqual(
        result.bytes,
        vector.expectedBytes,
        `${vector.name} compressed output diverges from the ESA reference`,
      );
    });
  }
});

test("reference vectors: decompress round-trips bit-exactly", { skip: SKIP }, async (t) => {
  if (!existsSync(PROBE_WASM)) await buildProbe();
  const suite = await loadVectorSuite(VECTOR_ROOT);
  const probe = await instantiateProbe();

  for (const vector of suite) {
    await t.test(vector.name, () => {
      const result = probe.decompress(vector.expectedBytes, {
        ...vector,
        // The count is supplied, not inferred: a POCKET+ stream does not encode
        // how many packets it holds. See SYNCHRONIZATION.md (d).
        outCapacity: vector.inputBytes.length,
      });
      assert.equal(result.rc, 0, `decompress returned ${result.rc}`);
      assert.deepEqual(
        result.bytes,
        vector.inputBytes,
        `${vector.name} did not round-trip bit-exactly`,
      );
    });
  }
});

test("packet length is discoverable only from reference packets", { skip: SKIP }, async () => {
  if (!existsSync(PROBE_WASM)) await buildProbe();
  const suite = await loadVectorSuite(VECTOR_ROOT);
  const probe = await instantiateProbe();

  for (const vector of suite) {
    const { rc, fBits } = probe.discover(vector.expectedBytes);
    assert.equal(fBits, vector.fBits, `${vector.name}: discovered F should match the encode`);
    // 0 = exact, 2 = CCSDS124_STATUS_TRUNCATED_LENGTH (weak discovery).
    // Both are legitimate; a $CPS writer must not treat 2 as a guarantee.
    assert.ok(rc === 0 || rc === 2, `${vector.name}: unexpected discover status ${rc}`);
  }
});
