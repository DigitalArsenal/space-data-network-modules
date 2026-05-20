#!/usr/bin/env node
/**
 * Integration test: plugin-delivery WASM module (standalone repo)
 *
 * Tests the get_public_key method which doesn't require space_data_module_host imports.
 * The deliver_plugin method requires IPFS and is tested in the full
 * integration test suite.
 *
 * Run: node test/delivery.test.mjs
 * Prereqs: npm install && npm run build
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBrowserModuleHarness,
} from "space-data-module-sdk/testing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(__dirname, "../dist/isomorphic/module.wasm");

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`${PASS}: ${name}`);
  } catch (err) {
    console.error(`${FAIL}: ${name}`);
    console.error(err);
    failures++;
  }
}

// ── Check WASM exists ───────────────────────────────────────────────────────

if (!fs.existsSync(WASM_PATH)) {
  console.error(`\nWASM not found: ${WASM_PATH}`);
  console.error("Build it first: npm run build");
  process.exit(1);
}

const wasmBytes = fs.readFileSync(WASM_PATH);
console.log(`Loaded ${path.basename(WASM_PATH)} (${wasmBytes.length} bytes)\n`);

// ── Tests ───────────────────────────────────────────────────────────────────

let harness;

await test("load plugin-delivery module.wasm via browser harness", async () => {
  harness = await createBrowserModuleHarness({
    wasmSource: wasmBytes,
    surface: "direct",
  });
  assert.ok(harness, "harness should be created");
  assert.ok(
    typeof harness.invoke === "function",
    "harness should expose invoke()",
  );
});

await test("get_public_key: returns 32-byte X25519 public key", async () => {
  const result = await harness.invoke({
    methodId: "get_public_key",
    inputs: [],
  });

  assert.ok(result.outputs?.length >= 1, "should have at least one output");
  const pubKey = result.outputs[0].payload;
  assert.ok(pubKey instanceof Uint8Array, "output should be Uint8Array");
  assert.equal(pubKey.length, 32, "X25519 public key must be 32 bytes");

  // Public key should not be all zeros
  const allZero = pubKey.every((b) => b === 0);
  assert.ok(!allZero, "public key should not be all zeros");
});

await test("get_public_key: returns consistent key across calls", async () => {
  const result1 = await harness.invoke({
    methodId: "get_public_key",
    inputs: [],
  });
  const result2 = await harness.invoke({
    methodId: "get_public_key",
    inputs: [],
  });

  assert.deepEqual(
    result1.outputs[0].payload,
    result2.outputs[0].payload,
    "public key should be deterministic (derived from baked private key)",
  );
});

await test("unknown method: returns error", async () => {
  const result = await harness.invoke({
    methodId: "nonexistent_method",
    inputs: [],
  });

  const hasError =
    result.status !== 0 ||
    result.errorMessage ||
    !result.outputs?.[0]?.payload?.length;
  assert.ok(hasError, "unknown method should produce an error");
});

await test("deliver_plugin: missing inputs returns error", async () => {
  const result = await harness.invoke({
    methodId: "deliver_plugin",
    inputs: [],
  });

  const hasError =
    result.status !== 0 ||
    result.errorMessage ||
    !result.outputs?.[0]?.payload?.length;
  assert.ok(hasError, "deliver_plugin with no inputs should error");
});

// ── Cleanup ─────────────────────────────────────────────────────────────────

if (harness?.destroy) {
  await harness.destroy();
}

console.log(`\nDone. ${failures === 0 ? "All tests passed." : `${failures} failure(s).`}`);
if (failures > 0) {
  process.exit(1);
}
