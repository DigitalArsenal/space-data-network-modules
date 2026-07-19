// Independent Node wasi-threads harness: runs a wasi-threads WASI command
// (_start) with a REAL wasi.thread-spawn implemented over node:worker_threads +
// a shared WebAssembly.Memory (SharedArrayBuffer) mapped to env.memory. This is
// the browser-equivalent "wasi.thread-spawn over Workers + SharedArrayBuffer"
// host. Each spawned guest thread runs in its own Worker that instantiates the
// SAME module bytes over the SAME shared memory and calls wasi_thread_start.
//
// Usage: node wasi_threads_harness.mjs <module.wasm> [--dir <hostdir>] [-- <guest args...>]
import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { readFileSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import path from "node:path";

const PAGE = 65536;

// ---- Minimal WASI preview1 (+ preopened dir for path_open/fd_read) ----
function makeWasi({ memoryRef, args, preopenHostDir, onExit }) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const dv = () => new DataView(memoryRef().buffer);
  const u8 = () => new Uint8Array(memoryRef().buffer);
  // fd table: 0,1,2 std; 3 = preopened dir "/"; >=4 opened files
  const fds = new Map();
  let nextFd = 4;
  const ERRNO_BADF = 8, ERRNO_NOENT = 44, ERRNO_SUCCESS = 0;
  function wStr(ptr, s) { u8().set(enc.encode(s), ptr); }
  return {
    args_sizes_get: (argcP, bufP) => { const d = dv(); d.setUint32(argcP, args.length, true); d.setUint32(bufP, args.reduce((a, s) => a + enc.encode(s).length + 1, 0), true); return 0; },
    args_get: (argvP, bufP) => { const d = dv(); let p = bufP; for (let i = 0; i < args.length; i++) { d.setUint32(argvP + i * 4, p, true); const b = enc.encode(args[i] + "\0"); u8().set(b, p); p += b.length; } return 0; },
    environ_sizes_get: (cP, bP) => { const d = dv(); d.setUint32(cP, 0, true); d.setUint32(bP, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (id, prec, ptr) => { dv().setBigUint64(ptr, BigInt(Date.now()) * 1000000n, true); return 0; },
    random_get: (ptr, len) => { const b = u8(); for (let i = 0; i < len; i++) b[ptr + i] = (Math.random() * 256) | 0; return 0; },
    proc_exit: (code) => { onExit(code); throw { __wasiExit: code }; },
    sched_yield: () => 0,
    poll_oneoff: () => 0,
    fd_fdstat_get: (fd, ptr) => { const d = dv(); d.setUint8(ptr, fd === 3 ? 3 : 4); d.setUint16(ptr + 2, 0, true); d.setBigUint64(ptr + 8, 0n, true); d.setBigUint64(ptr + 16, 0n, true); return 0; },
    fd_fdstat_set_flags: () => 0,
    fd_prestat_get: (fd, ptr) => { const d = dv(); if (fd === 3) { d.setUint8(ptr, 0); d.setUint32(ptr + 4, enc.encode("/").length, true); return 0; } return ERRNO_BADF; },
    fd_prestat_dir_name: (fd, ptr, len) => { if (fd === 3) { wStr(ptr, "/"); return 0; } return ERRNO_BADF; },
    path_open: (dirfd, dflags, pathP, pathLen, oflags, rbase, rinher, fdflags, fdOut) => {
      if (!preopenHostDir) return ERRNO_NOENT;
      const name = dec.decode(u8().subarray(pathP, pathP + pathLen));
      try { const h = openSync(path.join(preopenHostDir, name), "r"); const fd = nextFd++; fds.set(fd, { h, off: 0 }); dv().setUint32(fdOut, fd, true); return 0; }
      catch { return ERRNO_NOENT; }
    },
    fd_read: (fd, iovs, iovsLen, nreadP) => {
      const e = fds.get(fd); if (!e) return ERRNO_BADF; const d = dv(); let total = 0;
      for (let i = 0; i < iovsLen; i++) { const p = iovs + i * 8; const off = d.getUint32(p, true); const len = d.getUint32(p + 4, true); const buf = Buffer.alloc(len); const n = readSync(e.h, buf, 0, len, e.off); e.off += n; u8().set(buf.subarray(0, n), off); total += n; if (n < len) break; }
      d.setUint32(nreadP, total, true); return 0;
    },
    fd_seek: (fd, off, whence, newOffP) => {
      const e = fds.get(fd); if (!e) return ERRNO_BADF;
      const size = (() => { try { return fstatSync(e.h).size; } catch { return 0; } })();
      const o = Number(off);
      if (whence === 1) e.off += o;        // SEEK_CUR
      else if (whence === 2) e.off = size + o;  // SEEK_END
      else e.off = o;                       // SEEK_SET
      dv().setBigUint64(newOffP, BigInt(e.off), true); return 0;
    },
    fd_tell: (fd, offP) => { const e = fds.get(fd); if (!e) return ERRNO_BADF; dv().setBigUint64(offP, BigInt(e.off), true); return 0; },
    fd_close: (fd) => { const e = fds.get(fd); if (e) { closeSync(e.h); fds.delete(fd); } return 0; },
    fd_filestat_get: (fd, ptr) => { const e = fds.get(fd); const d = dv(); const sz = e ? fstatSync(e.h).size : 0; d.setBigUint64(ptr + 32, BigInt(sz), true); return 0; },
    fd_write: (fd, iovs, iovsLen, nwrittenP) => {
      const d = dv(); let written = 0; const chunks = [];
      for (let i = 0; i < iovsLen; i++) { const p = iovs + i * 8; const off = d.getUint32(p, true); const len = d.getUint32(p + 4, true); chunks.push(Buffer.from(u8().subarray(off, off + len))); written += len; }
      const out = Buffer.concat(chunks); if (fd === 2) process.stderr.write(out); else process.stdout.write(out);
      d.setUint32(nwrittenP, written, true); return 0;
    },
  };
}

function instantiateWithThreads({ moduleBytes, sharedMemory, tidSab, role, tid, startArg, args, preopenHostDir }) {
  const mod = new WebAssembly.Module(moduleBytes);
  const tidArr = new Int32Array(tidSab);
  let instance;
  const memoryRef = () => sharedMemory;
  const wasi = makeWasi({ memoryRef, args: args ?? [], preopenHostDir, onExit: () => {} });
  const imports = {
    env: { memory: sharedMemory },
    wasi_snapshot_preview1: wasi,
    wasi: {
      "thread-spawn": (arg) => {
        const t = Atomics.add(tidArr, 0, 1) + 1;
        new Worker(new URL(import.meta.url), { workerData: { role: "thread", moduleBytes, sharedMemory, tidSab, tid: t, startArg: arg, preopenHostDir } });
        return t;
      },
    },
  };
  instance = new WebAssembly.Instance(mod, imports);
  return instance;
}

if (!isMainThread) {
  const wd = workerData;
  const inst = instantiateWithThreads(wd);
  if (wd.role === "root") {
    try { inst.exports._start(); } catch (e) { if (e && typeof e.__wasiExit === "number") { /* normal */ } else throw e; }
    parentPort.postMessage({ done: true });
  } else {
    inst.exports.wasi_thread_start(wd.tid, wd.startArg);
  }
} else {
  const wasmPath = process.argv[2];
  const dashDash = process.argv.indexOf("--");
  let preopenHostDir = null;
  const dirIdx = process.argv.indexOf("--dir");
  if (dirIdx > 0) preopenHostDir = process.argv[dirIdx + 1];
  const guestArgs = dashDash > 0 ? process.argv.slice(dashDash + 1) : [];
  const moduleBytes = readFileSync(wasmPath);
  // Determine required initial pages from the imported-memory min declared in the module.
  let initialPages = 512;
  try {
    const { analyzeWasmThreadFeatures } = await import("/Users/tj/software/spacedatanetwork-stack/repos/ancillary-packages/space-data-module-sdk/src/compiler/index.js");
    const a = analyzeWasmThreadFeatures(moduleBytes);
    if (a.sharedMemory && a.sharedMemory.min) initialPages = Math.max(initialPages, a.sharedMemory.min);
  } catch {}
  const sharedMemory = new WebAssembly.Memory({ initial: initialPages, maximum: 32768, shared: true });
  const tidSab = new SharedArrayBuffer(4);
  const root = new Worker(new URL(import.meta.url), { workerData: { role: "root", moduleBytes, sharedMemory, tidSab, args: [path.basename(wasmPath), ...guestArgs], preopenHostDir } });
  root.on("message", () => {});
  root.on("error", (e) => { console.error("[harness] root error:", e); process.exit(1); });
  root.on("exit", (code) => process.exit(0));
}
