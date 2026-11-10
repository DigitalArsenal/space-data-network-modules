#!/usr/bin/env node
// Timing benchmark (a prototype, not a test): the display segments' catalog step in a real browser. A one-file server
// on 127.0.0.1 sends the two cross-origin isolation headers (the pool's threads need SharedArrayBuffer) and a bare page
// that loads this package's module through the SDK's browser harness, loads N made-up SGP4XP sets (the mix of
// test/segments-bench.mjs), builds their segments and times STEPS catalog steps with performance.now(), on the main
// thread alone (--threads 0) or with the pool. The browser is Chromium's headless shell from the Playwright cache, the
// SDK's choice (space-data-module-sdk testing/headlessShell.js). Prints the page's report. Timing only.
//   node test/segments-browser.mjs [--n 100000] [--threads 15] [--steps 1000]
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { packageRoot, wasmPath } from "./lib/module.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 100000), THREADS = arg("threads", 15), STEPS = arg("steps", 1000), AP = process.argv.includes("--ap"), BATCH = Math.min(N, arg("batch", N));
const nm = path.join(packageRoot, "node_modules");
const sdkRoot = path.join(nm, "space-data-module-sdk");
const sdkExports = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")).exports;
const { resolveHeadlessShell } = await import(path.join(sdkRoot, "src/testing/headlessShell.js"));

const importMap = { imports: {
  "flatbuffers": "/nm/flatbuffers/mjs/flatbuffers.js",
  "flatbuffers/": "/nm/flatbuffers/",
  "spacedatastandards.org/": "/nm/spacedatastandards.org/",
  "space-data-module-sdk/host/worker-bundles": `/nm/space-data-module-sdk/${sdkExports["./host/worker-bundles"].replace(/^\.\//, "")}`,
} };
const page = `<!doctype html><meta charset="utf-8"><script type="importmap">${JSON.stringify(importMap)}</script>
<script>addEventListener("unhandledrejection", (e) => fetch("/result", { method: "POST", body: JSON.stringify({ ok: false, error: "unhandled: " + String(e.reason && e.reason.stack || e.reason) }) }));</script>
<script type="module">
const report = (body) => fetch("/result", { method: "POST", body: JSON.stringify(body) });
try {
  const { createBrowserModuleHarness } = await import("/nm/space-data-module-sdk/src/host/browserModuleHarness.js");
  const N = ${N}, THREADS = ${THREADS}, STEPS = ${STEPS}, AP = ${AP}, BATCH = ${BATCH};
  // the pool's workers from the SDK's prebuilt worker bundle (space-data-module-sdk/host/worker-bundles)
  const { hostWorkerBundleUrl } = await import("/nm/space-data-module-sdk/src/host/hostWorkerBundles.js");
  const h = await createBrowserModuleHarness({ wasmSource: "/module.wasm", surface: "direct", maxThreads: Math.max(1, THREADS), enableBrowserWasiThreads: THREADS > 0,
    wasiThreadWorkerUrl: THREADS > 0 ? hostWorkerBundleUrl("wasi-thread-pool") : undefined });
  const x = h.instance.exports, mem = () => h.memory.buffer;
  const threads = THREADS > 0 ? x.sdnap_threads(THREADS) : 0;
  // the mix of test/segments-bench.mjs, the same seed
  const MU = 398600.4418, RE = 6378.137;
  let seed = 20261110;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const rev = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
  const rows = new DataView(new ArrayBuffer(112 * N));
  for (let k = 0; k < N; k++) {
    const u = rnd();
    let a, e, i;
    if (u < 0.70) { a = RE + 300 + 1200 * rnd() ** 1.5; e = 0.02 * rnd() ** 2; i = 100 * rnd(); }
    else if (u < 0.80) { a = 26560 + 200 * (rnd() - 0.5); e = 0.02 * rnd(); i = 50 + 10 * rnd(); }
    else if (u < 0.88) { a = 42164 + 50 * (rnd() - 0.5); e = 0.001 * rnd(); i = 15 * rnd(); }
    else if (u < 0.95) { const rp = RE + 250 + 350 * rnd(); e = 0.5 + 0.25 * rnd(); a = rp / (1 - e); i = 7 + 50 * rnd(); }
    else { a = 26560; e = 0.70 + 0.04 * rnd(); i = 63.4; }
    const raan = 360 * rnd(), argp = 360 * rnd(), ma = 360 * rnd(), bterm = a < RE + 2000 ? 0.005 + 0.05 * rnd() : 0.01;
    [2461328.5, 0, rev(a), e, i, raan, argp, ma, 0, 0, 0, bterm, 0.01].forEach((v, q) => rows.setFloat64(112 * k + 8 * q, v, true));
    rows.setUint32(112 * k + 104, 100000 + k, true);
    rows.setInt32(112 * k + 108, 4, true);
  }
  // the sets in batches of BATCH (AP: the gravity terms selected before each load), each batch's segments built into
  // the one segment store before the next batch replaces it
  const status = x.sdnap_alloc(4 * N), out = x.sdnap_alloc(48 * N), info = x.sdnap_alloc(64);
  const p = x.sdnap_alloc(112 * BATCH);
  let held = 0, rc = 0, loadMs = 0, buildMs = 0;
  for (let off = 0; off < N; off += BATCH) {
    const n = Math.min(BATCH, N - off);
    new Uint8Array(mem(), p, 112 * n).set(new Uint8Array(rows.buffer, 112 * off, 112 * n));
    if (AP) x.sdnap_segments_select(31, 20);
    const l0 = performance.now();
    held += x.sdnap_init_elements(p, n);
    const b0 = performance.now();
    rc = rc || x.sdnap_segments_build(2461328.5, 0, N, off, 4, 8, 1, 1, status + 4 * off);
    loadMs += b0 - l0;
    buildMs += performance.now() - b0;
  }
  x.sdnap_free(p);
  let minCover = Infinity;
  for (let k = 0; k < N; k++) { x.sdnap_segments_row(k, info); const f = new Float64Array(mem(), info, 3); if (f[2] > 0) minCover = Math.min(minCover, f[1] * f[2]); }
  const step = (frame) => {
    const ms = [];
    for (let k = 0; k < STEPS; k++) {
      const s = (minCover * (k + 0.5)) / STEPS, a = performance.now();
      x.sdnap_segments_at(2461328.5, s / 86400, 0, N, frame, out, status);
      ms.push(performance.now() - a);
    }
    ms.sort((u, v) => u - v);
    return { medianMs: ms[Math.floor(STEPS / 2)], p99Ms: ms[Math.min(STEPS - 1, Math.floor(0.99 * STEPS))], minMs: ms[0], maxMs: ms[STEPS - 1], meanMs: ms.reduce((u, v) => u + v, 0) / STEPS };
  };
  await report({ ok: true, userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, N, ap: AP, batch: BATCH, held, threads, rc, loadMs, buildMs, minCoverS: minCover, statusCounts: (() => { const c = {}; new Int32Array(mem(), status, N).forEach((s) => { c[s] = (c[s] ?? 0) + 1; }); return c; })(),
    teme: step(0), ecef: step(3), memoryMB: mem().byteLength / 1048576 });
} catch (e) {
  const cause = e && (e.cause || e.error);
  await report({ ok: false, error: String(e && e.stack || e).slice(0, 300), cause: cause ? String(cause.stack || cause.message || cause) : null });
}
</script>`;

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
let resolveDone;
const done = new Promise((r) => { resolveDone = r; });
const server = http.createServer((req, res) => {
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "no-store" };
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/result") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { res.writeHead(204, headers); res.end(); resolveDone(JSON.parse(Buffer.concat(chunks).toString("utf8"))); });
    return;
  }
  let file = null;
  if (url.pathname === "/") { res.writeHead(200, { ...headers, "Content-Type": "text/html" }); res.end(page); return; }
  if (url.pathname === "/module.wasm") file = wasmPath;
  else if (url.pathname.startsWith("/nm/")) file = path.join(nm, decodeURIComponent(url.pathname.slice(4)));
  if (!file || !path.resolve(file).startsWith(path.resolve(file === wasmPath ? wasmPath : nm)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    console.error(`404 ${url.pathname}`);
    res.writeHead(404, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
  if (/\.m?js$/.test(file)) {
    // bare package names to served paths (a module worker has no import map)
    const text = fs.readFileSync(file, "utf8").replace(/((?:from|import)\s*\(?\s*)"([^".\/][^"]*)"/g, (all, head, spec) => {
      for (const [k, v] of Object.entries(importMap.imports)) if (k.endsWith("/") ? spec.startsWith(k) : spec === k) return `${head}"${k.endsWith("/") ? v + spec.slice(k.length) : v}"`;
      return all;
    });
    res.end(text);
    return;
  }
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const shell = await resolveHeadlessShell({});
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-ap-segments-browser-"));
const chrome = spawn(shell, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
  "--disable-sync", ...(process.argv.includes("--log") ? ["--enable-logging=stderr", "--v=0"] : []), `--user-data-dir=${userDataDir}`, `http://127.0.0.1:${port}/`],
  { stdio: ["ignore", "ignore", process.argv.includes("--log") ? "inherit" : "ignore"] });
const TIMEOUT_S = arg("timeout-s", 1200);
const timer = setTimeout(() => resolveDone({ ok: false, error: `timed out after ${TIMEOUT_S} s` }), TIMEOUT_S * 1000);
const result = await done;
clearTimeout(timer);
chrome.kill("SIGKILL");
server.close();
await new Promise((r) => (chrome.exitCode !== null || chrome.signalCode !== null ? r() : chrome.once("exit", r)));
try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the shell's last writes; the temporary folder is the system's */ }
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
