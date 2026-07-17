import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  createBrowserModuleHarness,
  decodePluginManifest,
  inspectModule,
} from "space-data-module-sdk";

// Phase 4 pthread-architecture contract pin (see PHASE4_PTHREAD_AUDIT.md).
//
// sensor-coverage compiles with `-pthread` + `SHARED_MEMORY=1` ONLY because it
// opts into shared memory for zero-copy output — it is a SINGLE-THREAD build
// (manifest runtimeTargets:["browser"] -> ModuleThreadModel.SINGLE_THREAD). It
// contains no thread-spawn primitive; the emscripten pthread-runtime imports
// are inert housekeeping that the SDK/browser loader safely stubs.
//
// This suite fails loudly if the artifact ever drifts toward a real- or
// fake-threaded build. When the separate C6 task converts the module to actual
// pthreads (ORBPRO_SENSOR_COVERAGE_LOOP.md:846-864), these assertions are
// EXPECTED to fail and be replaced by C6's threaded contract tests.

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);

// Mirrors STANDALONE_SHARED_MEMORY_ENV_STUBS in
// space-data-module-sdk/src/testing/browserModuleHarness.js:68-84. Every
// `env` function import the artifact carries MUST be in this closed set, or
// detectArtifactProfile reclassifies the artifact "emscripten" and
// createBrowserModuleHarness refuses to load it (fail-closed).
const SDK_THREAD_HOUSEKEEPING_STUB_ALLOWLIST = new Set([
  "_emscripten_init_main_thread_js",
  "_emscripten_notify_mailbox_postmessage",
  "_emscripten_receive_on_main_thread_js",
  "_emscripten_thread_cleanup",
  "_emscripten_thread_mailbox_await",
  "_emscripten_thread_set_strongref",
  "emscripten_check_blocking_allowed",
  "emscripten_exit_with_live_runtime",
  "pthread_mutex_lock",
  "pthread_mutex_unlock",
  "pthread_cond_broadcast",
  "pthread_cond_wait",
  "emscripten_thread_sleep",
  "__do_set_thread_state",
  "__get_tp",
]);

// Names that would indicate the module actually spawns OS/worker threads.
const THREAD_SPAWN_NAMES = ["pthread_create", "__pthread_create_js", "spawn"];

const WASM_PAGE_BYTES = 65536;
const EXPECTED_MEMORY_MIN_PAGES = 256; // 16 MiB (emscripten SHARED_MEMORY default)
const EXPECTED_MEMORY_MAX_PAGES = 32768; // 2 GiB (maximumMemoryBytes)

// ---- minimal wasm import-section parser: recover memory limits + shared flag,
// which WebAssembly.Module.imports() does not expose. ----
function readVarU32(buf, off) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[off++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result >>> 0, off };
}

function readName(buf, off) {
  const len = readVarU32(buf, off);
  const value = Buffer.from(buf.subarray(len.off, len.off + len.value)).toString(
    "utf8",
  );
  return { value, off: len.off + len.value };
}

function parseImportedMemory(buf) {
  // buf must be the loadable wasm (no appended publication trailer).
  assert.equal(buf[0], 0x00);
  assert.equal(buf[1], 0x61);
  assert.equal(buf[2], 0x73);
  assert.equal(buf[3], 0x6d);
  let off = 8;
  while (off < buf.length) {
    const id = buf[off++];
    const size = readVarU32(buf, off);
    off = size.off;
    const end = off + size.value;
    if (id !== 2) {
      off = end;
      continue;
    }
    const count = readVarU32(buf, off);
    off = count.off;
    for (let i = 0; i < count.value; i++) {
      const mod = readName(buf, off);
      off = mod.off;
      const nm = readName(buf, off);
      off = nm.off;
      const kind = buf[off++];
      if (kind === 0x00) {
        off = readVarU32(buf, off).off;
      } else if (kind === 0x01) {
        off++; // reftype
        const fl = buf[off++];
        off = readVarU32(buf, off).off;
        if (fl & 0x01) off = readVarU32(buf, off).off;
      } else if (kind === 0x02) {
        const flags = buf[off++];
        const min = readVarU32(buf, off);
        off = min.off;
        let max = null;
        if (flags & 0x01) {
          const m = readVarU32(buf, off);
          off = m.off;
          max = m.value;
        }
        return {
          module: mod.value,
          name: nm.value,
          shared: !!(flags & 0x02),
          min: min.value,
          max,
        };
      } else if (kind === 0x03) {
        off += 2; // valtype + mut
      }
    }
    off = end;
  }
  return null;
}

test("artifact is a standalone single-thread profile", async () => {
  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  assert.equal(
    inspection.profile,
    "standalone",
    "sensor-coverage must stay a standalone (single-thread) artifact; an " +
      "'emscripten' profile means real thread imports leaked in — see C6",
  );
});

test("artifact carries no thread-spawn import or export", async () => {
  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));

  const spawnImports = inspection.imports.filter((entry) =>
    THREAD_SPAWN_NAMES.some((needle) => entry.name.includes(needle)),
  );
  assert.deepEqual(
    spawnImports,
    [],
    "single-thread contract: artifact must import no thread-spawn primitive",
  );

  const spawnExports = inspection.exports.filter((name) =>
    THREAD_SPAWN_NAMES.some((needle) => name.includes(needle)),
  );
  assert.deepEqual(
    spawnExports,
    [],
    "single-thread contract: artifact must export no thread-spawn entry point",
  );

  // Positive: the expected application + ABI exports are present.
  for (const expected of [
    "compute_sensor_coverage",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(
      inspection.exports.includes(expected),
      `missing expected export ${expected}`,
    );
  }
  assert.equal(inspection.exports.includes("_start"), false, "reactor: no _start");
});

test("env.memory import is shared with the expected min/max pages", async () => {
  const bytes = fs.readFileSync(WASM_PATH);

  // SDK view: exactly one memory import, env::memory.
  const inspection = await inspectModule(bytes);
  assert.deepEqual(
    inspection.imports.filter((entry) => entry.kind === "memory"),
    [{ module: "env", name: "memory", kind: "memory" }],
  );

  // Binary view: shared flag + limits (parsed from loadable wasm bytes).
  const { toLoadableWasmBytes } = await import(
    "space-data-module-sdk/testing/browser"
  );
  const clean = toLoadableWasmBytes(new Uint8Array(bytes));
  const mem = parseImportedMemory(clean);
  assert.ok(mem, "artifact must declare an imported memory");
  assert.equal(mem.module, "env");
  assert.equal(mem.name, "memory");
  assert.equal(mem.shared, true, "zero-copy output requires shared memory");
  assert.equal(
    mem.min,
    EXPECTED_MEMORY_MIN_PAGES,
    `declared memory minimum drifted (pages; ${
      (mem.min * WASM_PAGE_BYTES) / (1024 * 1024)
    } MiB)`,
  );
  assert.equal(
    mem.max,
    EXPECTED_MEMORY_MAX_PAGES,
    `declared memory maximum drifted (pages; ${
      (mem.max * WASM_PAGE_BYTES) / (1024 * 1024 * 1024)
    } GiB)`,
  );
});

test("every env import is within the SDK thread-housekeeping stub allowlist", async () => {
  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  const envFunctionImports = inspection.imports.filter(
    (entry) => entry.module === "env" && entry.kind === "function",
  );
  assert.ok(
    envFunctionImports.length > 0,
    "expected the shared-memory pthread-runtime housekeeping imports",
  );
  const outsideAllowlist = envFunctionImports
    .map((entry) => entry.name)
    .filter((name) => !SDK_THREAD_HOUSEKEEPING_STUB_ALLOWLIST.has(name));
  assert.deepEqual(
    outsideAllowlist,
    [],
    "an env import outside the SDK stub allowlist would make " +
      "createBrowserModuleHarness refuse to load this artifact",
  );

  // Only the inert housekeeping functions are imported — no lock/cond/tp
  // stubs are actually needed by this artifact.
  const importModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();
  assert.deepEqual(importModuleNames, ["env", "wasi_snapshot_preview1"]);
});

test("on-disk manifest declares browser/direct single-thread targets", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.deepEqual(
    manifest.runtimeTargets,
    ["browser"],
    "runtimeTargets:['browser'] is what maps to ModuleThreadModel.SINGLE_THREAD",
  );
  assert.deepEqual(manifest.invokeSurfaces, ["direct"]);
});

test("runtime-embedded manifest matches the single-thread browser/direct contract", async (t) => {
  if (typeof SharedArrayBuffer !== "function") {
    t.skip("SharedArrayBuffer is not available in this runtime.");
    return;
  }

  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(WASM_PATH),
    surface: "direct",
    sharedMemory: true,
    allowRawInvoke: false,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 2 * 1024 * 1024 * 1024,
  });
  t.after(() => {
    harness.destroy();
  });

  // Loading at all proves the artifact passes the SDK allowlist gate and
  // instantiates with only stubbed housekeeping + shared memory.
  assert.equal(harness.memory.buffer instanceof SharedArrayBuffer, true);

  const exports = harness.instance.exports;
  const size = exports.plugin_get_manifest_flatbuffer_size();
  const ptr = exports.plugin_get_manifest_flatbuffer();
  assert.ok(size > 0 && ptr > 0, "runtime manifest must be retrievable");
  const manifestBytes = new Uint8Array(
    new Uint8Array(harness.memory.buffer).subarray(ptr, ptr + size),
  );
  const decoded = decodePluginManifest(manifestBytes);
  assert.equal(decoded.pluginId, "sensor-coverage-analysis");
  assert.deepEqual(decoded.runtimeTargets, ["browser"]);
  assert.deepEqual(decoded.invokeSurfaces, ["direct"]);
  assert.deepEqual(decoded.capabilities, []);
  assert.deepEqual(
    decoded.methods.map((method) => method.methodId),
    ["compute_sensor_coverage"],
  );
});
