// wasi_threads_flow_harness.mjs — the ISOMORPHIC SECOND ENVIRONMENT proof.
//
// Runs the BAKED COMPOSED runtime.wasm (5 provider fetch nodes -> threaded OD
// fit -> in-wasm FlatSQL store) in a Node SharedArrayBuffer + Worker environment
// that implements `wasi.thread-spawn` over node:worker_threads (the exact
// browser-equivalent host: each guest thread is a Worker instantiating the SAME
// module bytes over the SAME shared WebAssembly.Memory and calling
// wasi_thread_start). This is the SAME artifact the node runs under WasmEdge —
// nothing module-specific is stubbed away.
//
// Host stubs (all synchronous — fixtures, not real network):
//   * space_data_module_host.{call,response_len,read_response} — the module SDK
//     hostcall ABI. http.request is served from an in-memory fixture map keyed by
//     URL (base64 body), matching the Go node bridge's response envelope shape
//     the guest's provider_source.hpp decodes ([u32 metaLen][meta json][u32 0]
//     with flat status/body_encoding/body). Unknown URLs -> 404 (graceful
//     degrade — other providers proceed).
//   * flatsql.{exec_envelope,ingest_record} — byte-mover into an in-memory store.
//     exec_envelope is the read/dedup pre-check (returns 0 = not-a-dup so every
//     record ingests). ingest_record copies the store node's wrapper FlatBuffer
//     and files it by its 4-byte identifier (SOMM/SOCM/SOBD) — the store
//     round-trip.
//   * wasi.thread-spawn -> a real node Worker per guest thread over the shared SAB.
//
// PROVES, in this environment: (1) >1 guest worker OS-thread spawns and runs the
// threaded OD fit, and (2) a store round-trip completes (>=1 wrapper record lands
// in the in-memory store via ingest_record).
//
// Usage: node wasi_threads_flow_harness.mjs <composed-runtime.wasm> <fixtures.json>
//   fixtures.json: { "<url>": "<abs path to fixture file>", ... }

import { Worker, isMainThread, workerData, parentPort, threadId } from "node:worker_threads";
import { readFileSync } from "node:fs";

const PAGE = 65536;
const INVALID_INDEX = 0xffffffff;
const FRAME_DESC_SIZE = 48;
const textEnc = new TextEncoder();
const textDec = new TextDecoder();

// ----------------------------------------------------------------------------
// WASI preview1 subset the composed reactor imports (clock/fd/proc_exit/yield).
// No files are opened by the flow (providers fetch via hostcall http), so
// fd_read/seek/prestat are minimal; fd_write goes to stdout/stderr.
// ----------------------------------------------------------------------------
function makeWasi(memoryRef, onExit) {
  const dv = () => new DataView(memoryRef().buffer);
  const u8 = () => new Uint8Array(memoryRef().buffer);
  const BADF = 8;
  return {
    clock_time_get: (id, prec, ptr) => { dv().setBigUint64(ptr, BigInt(Date.now()) * 1000000n, true); return 0; },
    sched_yield: () => 0,
    proc_exit: (code) => { onExit(code); throw { __wasiExit: code }; },
    fd_close: () => 0,
    fd_fdstat_get: (fd, ptr) => { const d = dv(); d.setUint8(ptr, 4); d.setUint16(ptr + 2, 0, true); d.setBigUint64(ptr + 8, 0n, true); d.setBigUint64(ptr + 16, 0n, true); return 0; },
    fd_prestat_get: () => BADF,
    fd_prestat_dir_name: () => BADF,
    fd_read: (fd, iovs, iovsLen, nreadP) => { dv().setUint32(nreadP, 0, true); return 0; },
    fd_seek: (fd, off, whence, newOffP) => { dv().setBigUint64(newOffP, 0n, true); return 0; },
    fd_write: (fd, iovs, iovsLen, nwrittenP) => {
      const d = dv(); let written = 0; const chunks = [];
      for (let i = 0; i < iovsLen; i++) { const p = iovs + i * 8; const off = d.getUint32(p, true); const len = d.getUint32(p + 4, true); chunks.push(Buffer.from(u8().subarray(off, off + len))); written += len; }
      const out = Buffer.concat(chunks); if (fd === 2) process.stderr.write(out); else process.stdout.write(out);
      d.setUint32(nwrittenP, written, true); return 0;
    },
  };
}

// ----------------------------------------------------------------------------
// space_data_module_host hostcall bridge (synchronous fixtures).
// Request framing (guest provider_source.hpp): [u32le metaLen][meta json][u32le segCount].
// Response framing the guest decodes: [u32le metaLen][meta json][u32le 0].
// ----------------------------------------------------------------------------
function makeHostcall(memoryRef, fixtures, stats) {
  let responseBuf = new Uint8Array(0);
  const u8 = () => new Uint8Array(memoryRef().buffer);
  function setResponseMeta(metaObj) {
    const meta = textEnc.encode(JSON.stringify(metaObj));
    const buf = new Uint8Array(4 + meta.length + 4);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, meta.length, true);
    buf.set(meta, 4);
    dv.setUint32(4 + meta.length, 0, true); // segment_count 0
    responseBuf = buf;
  }
  function readReqMeta(payloadPtr, payloadLen) {
    if (payloadLen < 4) return null;
    const mem = u8();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const metaLen = dv.getUint32(payloadPtr, true);
    if (payloadLen < 4 + metaLen) return null;
    return textDec.decode(mem.subarray(payloadPtr + 4, payloadPtr + 4 + metaLen));
  }
  return {
    call: (opPtr, opLen, payloadPtr, payloadLen) => {
      const op = textDec.decode(u8().subarray(opPtr, opPtr + opLen));
      const metaStr = readReqMeta(payloadPtr, payloadLen) ?? "{}";
      let req = {};
      try { req = JSON.parse(metaStr); } catch {}
      if (op === "http.request") {
        stats.httpCalls.push(req.url ?? "");
        const path = fixtures[req.url];
        if (path) {
          const bytes = readFileSync(path);
          stats.httpServed.push(req.url);
          setResponseMeta({ ok: true, status: 200, body_encoding: "base64", body: Buffer.from(bytes).toString("base64") });
        } else {
          stats.http404.push(req.url ?? "");
          setResponseMeta({ ok: true, status: 404, body_encoding: "utf8", body: "" });
        }
        return 0;
      }
      // plugin.getConfig / anything else: benign empty ok.
      setResponseMeta({ ok: true, result: null });
      return 0;
    },
    response_len: () => responseBuf.length,
    read_response: (dstPtr, dstLen) => {
      const n = Math.min(responseBuf.length, dstLen >>> 0);
      if (n > 0) u8().set(responseBuf.subarray(0, n), dstPtr);
      return n;
    },
  };
}

// ----------------------------------------------------------------------------
// flatsql store trampolines (in-memory byte-mover).
// exec_envelope: [u32 sqlLen][sql][u32 paramCount]{[u8 tag][u32 sz][bytes]}* ;
//   dedup SELECT COUNT -> return 0 (not a dup) so every record ingests.
// ingest_record: copy the wrapper FB, file by its 4-byte file identifier at [4:8].
// ----------------------------------------------------------------------------
function makeFlatsql(memoryRef, store) {
  const u8 = () => new Uint8Array(memoryRef().buffer);
  return {
    exec_envelope: (envPtr, envLen) => {
      store.execCalls++;
      return 0n; // read/dedup path: 0 rows -> "not stored yet"
    },
    ingest_record: (bufPtr, bufLen) => {
      const bytes = u8().slice(bufPtr, bufPtr + (bufLen >>> 0));
      // FlatBuffer file identifier lives at bytes[4:8].
      let fid = "";
      if (bytes.length >= 8) fid = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
      const seq = store.records.length;
      store.records.push({ fid, len: bytes.length });
      store.byId[fid] = (store.byId[fid] || 0) + 1;
      return BigInt(seq);
    },
  };
}

// ----------------------------------------------------------------------------
// Instantiate the composed reactor with a wasi.thread-spawn host over Workers.
// ----------------------------------------------------------------------------
function instantiate({ moduleBytes, sharedMemory, tidSab, osTidSab, spawnLog, fixtures, store, stats }) {
  const mod = new WebAssembly.Module(moduleBytes);
  const tidArr = new Int32Array(tidSab);
  const memoryRef = () => sharedMemory;
  const imports = {
    env: { memory: sharedMemory },
    wasi_snapshot_preview1: makeWasi(memoryRef, () => {}),
    wasi: {
      "thread-spawn": (startArg) => {
        const t = Atomics.add(tidArr, 0, 1) + 1;
        new Worker(new URL(import.meta.url), {
          workerData: { role: "thread", moduleBytes, sharedMemory, tidSab, osTidSab, tid: t, startArg },
        });
        return t;
      },
    },
    space_data_module_host: makeHostcall(memoryRef, fixtures, stats),
    flatsql: makeFlatsql(memoryRef, store),
  };
  return new WebAssembly.Instance(mod, imports);
}

// ----------------------------------------------------------------------------
// Root worker: _initialize -> enqueue one timer tick -> drain the whole graph.
// ----------------------------------------------------------------------------
function driveFlow(inst, sharedMemory) {
  const ex = inst.exports;
  const u8 = () => new Uint8Array(sharedMemory.buffer);
  const dv = () => new DataView(sharedMemory.buffer);

  if (typeof ex._initialize === "function") ex._initialize();

  // Build + enqueue one tick frame at the trigger's bound port ("config").
  const portId = "config\0";
  const tick = textEnc.encode(JSON.stringify({ trigger: "t0", firedAt: new Date().toISOString() }));
  const portBytes = textEnc.encode(portId);
  const total = FRAME_DESC_SIZE + portBytes.length + tick.length;
  const framePtr = ex.malloc(total) >>> 0;
  // descriptor
  const d = dv();
  for (let i = 0; i < FRAME_DESC_SIZE; i++) u8()[framePtr + i] = 0;
  d.setUint32(framePtr + 8, framePtr + FRAME_DESC_SIZE, true);                    // PortIDPointer
  d.setUint32(framePtr + 16, framePtr + FRAME_DESC_SIZE + portBytes.length, true); // Offset
  d.setUint32(framePtr + 20, tick.length, true);                                  // Size
  u8()[framePtr + 41] = 1;                                                        // Occupied
  u8().set(portBytes, framePtr + FRAME_DESC_SIZE);
  u8().set(tick, framePtr + FRAME_DESC_SIZE + portBytes.length);
  ex.space_data_module_runtime_enqueue_trigger_frame(0, framePtr);

  // Drain: run every ready linked-direct node inside the guest scheduler, with a
  // host-model fallback (none expected — every node is a co-linked guest-link).
  let idle = 0, totalDispatched = 0;
  for (let iter = 0; iter < 100000 && idle < 3; iter++) {
    const dispatched = ex.space_data_module_runtime_drain_linked(1000) | 0;
    totalDispatched += Math.max(0, dispatched);
    let hostProgress = 0, ni;
    while ((ni = ex.space_data_module_runtime_get_ready_node_index() >>> 0) !== INVALID_INDEX) {
      ex.space_data_module_runtime_begin_node_invocation(ni, 64);
      ex.space_data_module_runtime_dispatch_current_invocation_direct(64);
      ex.space_data_module_runtime_complete_node_invocation(ni);
      if (++hostProgress > 100000) break;
    }
    if (dispatched <= 0 && hostProgress === 0) idle++; else idle = 0;
  }
  return totalDispatched;
}

// ============================================================================
if (!isMainThread) {
  const wd = workerData;
  if (wd.role === "thread") {
    // Spawned guest pthread: instantiate over the SAME shared memory, run its
    // entry. Inert host stubs (never called from a worker thread).
    const store = { records: [], byId: {}, execCalls: 0 };
    const stats = { httpCalls: [], httpServed: [], http404: [] };
    if (wd.osTidSab) { try { new Int32Array(wd.osTidSab)[wd.tid & 1023] = threadId; } catch {} }
    const inst = instantiate({ ...wd, spawnLog: null, fixtures: {}, store, stats });
    try {
      inst.exports.wasi_thread_start(wd.tid, wd.startArg);
    } catch (e) { if (!(e && typeof e.__wasiExit === "number")) throw e; }
    parentPort.postMessage({ threadDone: true, osThreadId: threadId });
  } else {
    // Root worker.
    const store = { records: [], byId: {}, execCalls: 0 };
    const stats = { httpCalls: [], httpServed: [], http404: [] };
    let dispatched = 0, err = null;
    try {
      const inst = instantiate({ ...wd, store, stats });
      dispatched = driveFlow(inst, wd.sharedMemory);
    } catch (e) {
      if (!(e && typeof e.__wasiExit === "number")) err = String(e && e.stack || e);
    }
    const tids = new Int32Array(wd.tidSab)[0];
    let osTids = [];
    if (wd.osTidSab) { osTids = [...new Set([...new Int32Array(wd.osTidSab)].filter((x) => x !== 0))]; }
    parentPort.postMessage({
      rootDone: true, err, dispatched, spawnCount: tids, osTids,
      store: { total: store.records.length, byId: store.byId, execCalls: store.execCalls },
      stats: { httpServed: stats.httpServed, http404: stats.http404.length },
    });
  }
} else {
  const wasmPath = process.argv[2];
  const fixturesPath = process.argv[3];
  if (!wasmPath || !fixturesPath) { console.error("usage: node wasi_threads_flow_harness.mjs <runtime.wasm> <fixtures.json>"); process.exit(2); }
  const moduleBytes = readFileSync(wasmPath);
  const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

  // Shared memory sized from the module's imported-memory min, generous initial
  // to avoid frequent growth during the multi-object Eigen fit.
  let initialPages = 4096; // 256 MiB
  try {
    const { analyzeWasmThreadFeatures } = await import("space-data-module-sdk/compiler");
    const a = analyzeWasmThreadFeatures(moduleBytes);
    if (a.sharedMemory && a.sharedMemory.min) initialPages = Math.max(initialPages, a.sharedMemory.min);
  } catch {}
  const sharedMemory = new WebAssembly.Memory({ initial: initialPages, maximum: 32768, shared: true });
  const tidSab = new SharedArrayBuffer(4);
  const osTidSab = new SharedArrayBuffer(4 * 1024); // per-guest-thread Node threadId slots

  const root = new Worker(new URL(import.meta.url), {
    workerData: { role: "root", moduleBytes, sharedMemory, tidSab, osTidSab, fixtures },
  });
  let done = false;
  root.on("message", (m) => {
    if (m.threadDone) { if (typeof m.osThreadId === "number") osThreadIds.add(m.osThreadId); return; }
    if (m.rootDone) {
      done = true;
      const report = {
        ok: !m.err,
        error: m.err || null,
        threads: { spawnCount: m.spawnCount, distinctOsThreadIds: (m.osTids || []).length, ids: m.osTids || [] },
        drain: { nodesDispatched: m.dispatched },
        http: { served: m.stats.httpServed, notFound: m.stats.http404 },
        store: m.store,
      };
      const spawned = m.spawnCount > 1 || (m.osTids || []).length > 1;
      const stored = m.store.total > 0;
      report.PROOF = {
        moreThanOneWorkerSpawned: spawned,
        storeRoundTripCompleted: stored,
        PASS: spawned && stored && !m.err,
      };
      console.log(JSON.stringify(report, null, 2));
      // Give any late thread-done messages a tick, then exit.
      setTimeout(() => process.exit(report.PROOF.PASS ? 0 : 1), 250);
    }
  });
  root.on("error", (e) => { console.error("[harness] root error:", e); process.exit(1); });
  root.on("exit", () => { if (!done) process.exit(1); });
}
