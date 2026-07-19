import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  createBrowserModuleHarness,
  decodePluginManifest,
  inspectModule,
} from "space-data-module-sdk";
import { analyzeWasmThreadFeatures } from "space-data-module-sdk/compiler";

// C6 isomorphic-pthreads (wasi-threads) contract pin.
//
// sensor-coverage compiles with threadModel "emscripten-pthreads", which the SDK
// routes through the WASI-threads toolchain (clang --target=wasm32-wasip1-threads
// -pthread ... -mexec-model=reactor). The emitted artifact genuinely spawns
// std::thread/pthread workers to parallelize the per-cell coverage kernel, so it
// MUST carry the wasi-threads contract: a SHARED imported memory + atomics, an
// imported `wasi.thread-spawn`, an exported `wasi_thread_start`, and ZERO
// Emscripten browser thread hooks. It is a reactor (`_initialize`, no `_start`).
//
// These pins REPLACE the prior single-thread pins (which forbade any thread
// primitive) with equally strict threaded pins: any drift back toward a
// single-thread build, an emscripten browser-worker build, or a command (non-
// reactor) build fails here. Import-allowlist + signature coverage is retained.

const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);

// The exact WASI preview1 surface the reactor wasi-threads build imports. Every
// wasi_snapshot_preview1 import MUST be in this closed set (a superset of the
// observed reactor set — args_* appear in the command variant — but nothing
// outside WASI). sched_yield is REQUIRED (pthread backoff) and its presence is
// asserted separately.
const WASI_PREVIEW1_ALLOWLIST = new Set([
  "args_get",
  "args_sizes_get",
  "environ_get",
  "environ_sizes_get",
  "clock_time_get",
  "fd_close",
  "fd_read",
  "fd_seek",
  "fd_write",
  "fd_fdstat_get",
  "proc_exit",
  "random_get",
  "sched_yield",
]);

// Emscripten browser-worker thread hooks that a wasi-threads artifact must NEVER
// import (their presence means the wrong -pthread toolchain was used).
const FORBIDDEN_EMSCRIPTEN_THREAD_HOOKS = [
  "__pthread_create_js",
  "_emscripten_init_main_thread_js",
  "_emscripten_thread_mailbox_await",
  "_emscripten_notify_mailbox_postmessage",
  "_emscripten_receive_on_main_thread_js",
  "_emscripten_thread_set_strongref",
  "_emscripten_thread_cleanup",
  "emscripten_check_blocking_allowed",
  "emscripten_exit_with_live_runtime",
];

const WASM_PAGE_BYTES = 65536;
const EXPECTED_MEMORY_MIN_PAGES = 2; // wasi-libc reactor initial (host supplies the real size)
const EXPECTED_MEMORY_MAX_PAGES = 32768; // 2 GiB — the enforced -Wl,--max-memory

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
        off++;
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
        off += 2;
      }
    }
    off = end;
  }
  return null;
}

test("artifact is a validated isomorphic-pthreads wasi-threads wasm", () => {
  const bytes = fs.readFileSync(WASM_PATH);
  const features = analyzeWasmThreadFeatures(bytes);
  assert.equal(
    features.isIsomorphicPthreads,
    true,
    "sensor-coverage must be a wasi-threads artifact (shared memory + atomics + " +
      "wasi.thread-spawn import + wasi_thread_start export + no emscripten hooks)",
  );
  assert.equal(features.hasSharedMemory, true, "requires shared memory");
  assert.equal(features.usesAtomics, true, "requires real atomics");
  assert.ok(
    features.atomicInstructionCount > 0,
    "must use genuine atomic instructions (not a byte-scan false positive)",
  );
  assert.equal(
    features.hasWasiThreadSpawnImport,
    true,
    "must import wasi.thread-spawn (WasmEdge/browser guest thread spawn)",
  );
  assert.equal(
    features.hasWasiThreadStartExport,
    true,
    "must export wasi_thread_start (the wasi-threads entry a host runs)",
  );
  assert.deepEqual(
    features.emscriptenThreadHooks,
    [],
    "must NOT carry Emscripten browser-worker thread hooks",
  );
});

test("artifact is a standalone reactor (WASI-threads), not command or emscripten", async () => {
  const bytes = fs.readFileSync(WASM_PATH);
  const inspection = await inspectModule(bytes);
  assert.equal(inspection.profile, "standalone");
  // Reactor: _initialize present, _start absent (direct-invoke without _start).
  assert.equal(
    inspection.exports.includes("_initialize"),
    true,
    "wasi-threads reactor must export _initialize (runs global ctors)",
  );
  assert.equal(
    inspection.exports.includes("_start"),
    false,
    "reactor must NOT export _start (a command _start would trap on missing main)",
  );
  assert.equal(
    inspection.exports.includes("wasi_thread_start"),
    true,
    "must export the wasi_thread_start thread entry",
  );
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
});

test("imports: wasi.thread-spawn + shared env.memory + WASI only; no emscripten hooks", async () => {
  const bytes = fs.readFileSync(WASM_PATH);
  const inspection = await inspectModule(bytes);

  // Import namespaces are exactly env + wasi + wasi_snapshot_preview1.
  const namespaces = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();
  assert.deepEqual(namespaces, ["env", "wasi", "wasi_snapshot_preview1"]);

  // env holds ONLY the shared memory (no emscripten thread scaffolding).
  const envImports = inspection.imports.filter((e) => e.module === "env");
  assert.deepEqual(
    envImports,
    [{ module: "env", name: "memory", kind: "memory" }],
    "env must import only the shared memory — any emscripten thread hook here " +
      "means the wrong -pthread toolchain was used",
  );

  // wasi namespace holds exactly thread-spawn.
  const wasiImports = inspection.imports.filter((e) => e.module === "wasi");
  assert.deepEqual(wasiImports, [
    { module: "wasi", name: "thread-spawn", kind: "function" },
  ]);

  // Every wasi_snapshot_preview1 import is within the WASI allowlist, and
  // sched_yield (pthread backoff) is present.
  const wasiPreview = inspection.imports.filter(
    (e) => e.module === "wasi_snapshot_preview1",
  );
  const outside = wasiPreview
    .map((e) => e.name)
    .filter((name) => !WASI_PREVIEW1_ALLOWLIST.has(name));
  assert.deepEqual(outside, [], "no non-WASI preview1 imports allowed");
  assert.ok(
    wasiPreview.some((e) => e.name === "sched_yield"),
    "wasi-threads pthread build must import sched_yield",
  );

  // No thread-spawn primitive from the wrong toolchains anywhere.
  const importNames = inspection.imports.map((e) => `${e.module}.${e.name}`);
  for (const hook of FORBIDDEN_EMSCRIPTEN_THREAD_HOOKS) {
    assert.ok(
      !importNames.some((n) => n.endsWith(`.${hook}`)),
      `forbidden emscripten thread hook imported: ${hook}`,
    );
  }
  for (const banned of ["pthread_create", "__pthread_create_js"]) {
    assert.ok(
      !importNames.some((n) => n.includes(banned)),
      `artifact must not import ${banned}`,
    );
  }
});

test("env.memory import is SHARED with the enforced 2 GiB maximum", async () => {
  const bytes = fs.readFileSync(WASM_PATH);
  const inspection = await inspectModule(bytes);
  assert.deepEqual(
    inspection.imports.filter((entry) => entry.kind === "memory"),
    [{ module: "env", name: "memory", kind: "memory" }],
  );

  const { toLoadableWasmBytes } = await import(
    "space-data-module-sdk/testing/browser"
  );
  const clean = toLoadableWasmBytes(new Uint8Array(bytes));
  const mem = parseImportedMemory(clean);
  assert.ok(mem, "artifact must declare an imported memory");
  assert.equal(mem.module, "env");
  assert.equal(mem.name, "memory");
  assert.equal(mem.shared, true, "wasi-threads requires a SHARED imported memory");
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
    `declared memory maximum drifted from the enforced --max-memory=2GiB ` +
      `(pages; ${(mem.max * WASM_PAGE_BYTES) / (1024 * 1024 * 1024)} GiB)`,
  );
});

test("on-disk manifest declares browser/direct targets", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.deepEqual(manifest.runtimeTargets, ["browser"]);
  assert.deepEqual(manifest.invokeSurfaces, ["direct"]);
});

test("threaded artifact loads through the signed browser harness with a matching runtime manifest", async (t) => {
  if (typeof SharedArrayBuffer !== "function") {
    t.skip("SharedArrayBuffer is not available in this runtime.");
    return;
  }

  // Loading proves: valid SDS signature, wasi-threads instantiation (the SDK
  // harness satisfies wasi.thread-spawn + shared memory + reactor _initialize).
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

  assert.equal(harness.memory.buffer instanceof SharedArrayBuffer, true);
  assert.ok(harness.threadHost, "wasi-threads harness must expose a thread host");

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
