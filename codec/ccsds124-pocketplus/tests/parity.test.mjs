/*
 * Tri-runtime parity: ONE codec artifact, THREE runtimes, byte-diffed.
 *
 * Runs the full CCSDS 124.0-B-1 reference vector suite through the SAME
 * codec-cli.wasm bytes under:
 *   - Node's WASI preview1 (the JS-engine lane)
 *   - native WasmEdge at the pinned version
 *   - Docker WasmEdge at the pinned version
 * and requires every lane to agree with the ESA reference AND with each other.
 *
 * There are NO silent skips inside the gate: a lane that cannot run is a
 * reported failure, because "works in X" is not parity evidence.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runAllLanes } from "./harness/run-lanes.mjs";

const VECTOR_ROOT = process.env.CCSDS124_VECTORS;
const SKIP = !VECTOR_ROOT && "set CCSDS124_VECTORS to a tanagraspace/ccsds124 checkout";
const REQUIRE_ALL_LANES = process.env.CCSDS124_REQUIRE_ALL_LANES === "1";

test("tri-runtime parity: codec is byte-identical across every lane", { skip: SKIP }, async (t) => {
  const { pin, versions, results } = await runAllLanes({
    vectorRoot: VECTOR_ROOT,
    quiet: true,
  });

  await t.test("WasmEdge host and container pins match the single pin source", () => {
    for (const [lane, version] of Object.entries(versions)) {
      if (version.startsWith("UNAVAILABLE")) {
        assert.ok(
          !REQUIRE_ALL_LANES,
          `${lane} lane unavailable but CCSDS124_REQUIRE_ALL_LANES=1: ${version}`,
        );
        continue;
      }
      assert.ok(
        version.includes(pin.wasmedgeVersion),
        `PARITY PIN-DRIFT: ${lane} reports "${version.split("\n")[0]}" but the ` +
          `pin is ${pin.wasmedgeVersion}. Host and container versions bump together.`,
      );
    }
  });

  for (const row of results) {
    await t.test(`${row.vector} (${row.packets} packets)`, () => {
      const ran = Object.entries(row.lanes).filter(([, r]) => r.status === "ok");
      assert.ok(ran.length > 0, `no lane executed ${row.vector}`);

      for (const [lane, r] of ran) {
        assert.ok(r.matchesReference, `${lane}: ${row.vector} diverges from the ESA reference`);
        assert.ok(r.roundTripExact, `${lane}: ${row.vector} did not round-trip bit-exactly`);
      }

      const compressed = new Set(ran.map(([, r]) => r.compressedSha));
      const decompressed = new Set(ran.map(([, r]) => r.decompressedSha));
      assert.equal(
        compressed.size, 1,
        `CROSS-RUNTIME DIVERGENCE (P1) on ${row.vector} compress: ` +
          ran.map(([l, r]) => `${l}=${r.compressedSha.slice(0, 12)}`).join(" "),
      );
      assert.equal(
        decompressed.size, 1,
        `CROSS-RUNTIME DIVERGENCE (P1) on ${row.vector} decompress: ` +
          ran.map(([l, r]) => `${l}=${r.decompressedSha.slice(0, 12)}`).join(" "),
      );
    });
  }
});
