#!/usr/bin/env node
// E2E (the module in a browser, on shared memory with a warm pool of Workers): the module's own wasm, hosted by the SDK's browser host in a
// Worker of a real browser page, answers what the same calls answer in Node, byte for byte, at 0, 4 and 8 pool threads.
// - the page: served from 127.0.0.1 with Cross-Origin-Opener-Policy same-origin and Cross-Origin-Embedder-Policy require-corp; the Worker is
//   cross-origin isolated and its memory is a SharedArrayBuffer; sdnap_threads(N) returns N, and the host's spawn count and its distinct
//   operating-system threads are N;
// - 20,000 seeded SGP4 element rows through sdnap_propagate_soa (the pool's entry) at three instants: one SHA-256 of every output double and
//   status, equal at 0, 4 and 8 threads and equal to the Node run's; every status 0; threaded batches ran with no refused growth, no deferred
//   row, no dead pool and no batch after which the calling thread saw a larger memory; where the build counts them, rows completed on pool threads;
// - 2,000 seeded AP records with a covariance (the stored record test/fixtures/ap-fit-0.6.42.ocm at other angles), loaded in parts of 1,000 through
//   one staging buffer: sdnap_epochs_at over all of them at five instants and once with the covariance planes: the same digests, every status 0;
//   when the build hands that call to the pool (its statistics count the batches), the same bounds as above and the module's memory growing during
//   the batches (the first pass makes every set: about a hundred growths);
// - the frame path (SPEC 19), when the build has its exports: open by the host's rule, a complete fill (8 rows a call in the browser, 500 in
//   Node), three instants in TEME and in the Earth-fixed frame: planes and statuses equal, bit for bit; every object served. A build without
//   its exports says so and nothing is asserted about it.
// The browser: the Playwright chromium headless shell found by the SDK's own resolver, with a temporary profile; never an installed browser
// application. SDNAP_BROWSER=firefox or webkit runs the page in the Firefox or WebKit build of the same Playwright cache instead. The module
// under test is the one SDNAP_WASM names (the committed dist by default). Absent browser or bundler: the test prints "SKIP browser-pool: ..." and
// exits 0, and fails instead when SDNAP_REQUIRE_BROWSER=1.
// SDNAP_CHROMIUM_NO_SANDBOX=1 explicitly disables Chromium sandboxing for restricted Linux containers; default is sandboxed.
//   node test/browser-pool.e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { wasmPath, elementRows, THEORY } from "./lib/module.mjs";
import { ocmOf, repackOcm } from "./lib/ocm.mjs";
import { jdOf } from "./lib/browser-pool/core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const T0 = Date.now();
const skip = (why) => {
  if (process.env.SDNAP_REQUIRE_BROWSER === "1") { console.error(`FAIL browser-pool: ${why} (SDNAP_REQUIRE_BROWSER=1)`); process.exit(1); }
  console.log(`SKIP browser-pool: ${why}`);
  process.exit(0);
};
const THREADS = (process.env.SDNAP_BROWSER_THREADS ?? "0,4,8").split(",").map(Number), ROWS = 20000, AP = 2000;  // the thread counts: 0, 4 and 8 unless narrowed here
if (THREADS[0] !== 0) throw new Error("SDNAP_BROWSER_THREADS starts with 0: the first run is the reference");

// ---------------------------------------------------------------------------------------------------------------- the browser and the bundler
const which = process.env.SDNAP_BROWSER ?? "chromium";
const cacheRoots = () => (process.env.PLAYWRIGHT_BROWSERS_PATH ? [process.env.PLAYWRIGHT_BROWSERS_PATH]
  : [path.join(os.homedir(), "Library", "Caches", "ms-playwright"), path.join(os.homedir(), ".cache", "ms-playwright")]);
const newest = (prefix) => {
  const found = [];
  for (const root of cacheRoots()) if (fs.existsSync(root)) for (const d of fs.readdirSync(root)) if (new RegExp(`^${prefix}-\\d+$`).test(d)) found.push(path.join(root, d));
  return found.sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
};
let launch;  // (url, profile) => { command, args }
if (which === "chromium") {
  let shell;
  try {
    const sdk = path.dirname(require.resolve("space-data-module-sdk/host/wasi-threads"));
    ({ resolveHeadlessShell: shell } = await import(pathToFileURL(path.join(sdk, "..", "testing", "headlessShell.js")).href));
    shell = await shell();
  } catch (e) {
    if (e.message?.startsWith("browser lane: no Chromium headless shell found under the Playwright cache ")) skip("no Chromium headless shell in the Playwright cache");
    throw e;
  }
  const realShell = fs.realpathSync(shell);
  assert.ok(cacheRoots().some((root) => {
    const relative = path.relative(path.resolve(root), realShell);
    return !relative.startsWith("..") && !path.isAbsolute(relative) && /^chromium_headless_shell-\d+[/\\]/.test(relative);
  }), "Chromium must be a headless shell inside the Playwright cache");
  launch = (url, profile) => ({ command: shell, args: [...(process.env.SDNAP_CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync", `--user-data-dir=${profile}`, url] });
} else if (which === "firefox") {
  const bin = newest("firefox").flatMap((d) => [path.join(d, "firefox", "Nightly.app", "Contents", "MacOS", "firefox"), path.join(d, "firefox", "firefox")]).find((p) => fs.existsSync(p));
  if (!bin) skip("no Firefox build in the Playwright cache");
  launch = (url, profile) => {
    fs.writeFileSync(path.join(profile, "user.js"), ["app.update.enabled", "app.update.auto", "datareporting.policy.dataSubmissionEnabled", "toolkit.telemetry.enabled", "network.captive-portal-service.enabled",
      "extensions.update.enabled", "app.normandy.enabled"].map((k) => `user_pref("${k}", false);`).join("\n") + "\n");
    return { command: bin, args: ["-headless", "-no-remote", "-profile", profile, url] };
  };
} else if (which === "webkit") {
  const dir = newest("webkit").find((d) => fs.existsSync(path.join(d, "Playwright.app", "Contents", "MacOS", "Playwright")));
  if (!dir) skip("no WebKit build in the Playwright cache");
  // the build's own binary, started directly (its wrapper script would leave the binary running when it is stopped)
  launch = (url, profile) => ({ command: path.join(dir, "Playwright.app", "Contents", "MacOS", "Playwright"), args: ["--headless", `--user-data-dir=${profile}`, url],
    env: { DYLD_FRAMEWORK_PATH: dir, DYLD_LIBRARY_PATH: dir } });
} else throw new Error(`SDNAP_BROWSER=${which} is not one of chromium, firefox, webkit`);
let esbuild;
try { esbuild = await import("esbuild"); } catch (e) {
  if (e.code === "ERR_MODULE_NOT_FOUND" && e.message.startsWith("Cannot find package 'esbuild'")) skip("esbuild is not installed (npm install in propagator/sdn-ap)");
  throw e;
}

// The watchdog runs outside the WASM hosting thread, including during a synchronous guest call.
let currentCase = "input preparation", activeNode;
let cleanupRun = async () => { await activeNode?.terminate(); };
const stop = (code) => { void cleanupRun().then(() => process.exit(code)); };
const onInt = () => stop(130), onTerm = () => stop(143);
process.once("SIGINT", onInt);
process.once("SIGTERM", onTerm);
const wholeTimer = setTimeout(() => {
  console.error(`${currentCase}: whole run exceeded 15 minutes`);
  stop(1);
}, Math.max(1, 15 * 60 * 1000 - (Date.now() - T0)));
wholeTimer.unref();

// ---------------------------------------------------------------------------------------------------------------- the seeded inputs
const fixture = new Uint8Array(fs.readFileSync(path.join(here, "fixtures", "ap-fit-0.6.42.ocm")));
assert.equal(ocmOf(fixture).MEAN_ELEMENTS.MEAN_ELEMENT_THEORY, 5, "the input record declares AP");
const epochText = ocmOf(fixture).MEAN_ELEMENTS.EPOCH;
const epochMs = Date.parse(epochText.endsWith("Z") ? epochText : `${epochText}Z`);
let seed = 20261113;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const MU = 398600.4418, RE = 6378.137;
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const [whole, frac] = jdOf(epochMs);
const rows = elementRows(Array.from({ length: ROWS }, (_, k) => {
  const a = RE + 300 + 1200 * rnd() ** 1.5, bterm = 0.005 + 0.05 * rnd();
  return { epochWhole: whole, epochFrac: frac, meanMotion: revPerDay(a), ecc: 0.02 * rnd() ** 2, inc: 100 * rnd(), raan: 360 * rnd(), argp: 360 * rnd(), ma: 360 * rnd(),
    bstar: bterm / 12.741621, bterm, agom: 0.01, norad: 100000 + k, theory: THEORY.SGP4 };
}));
const records = [];
for (let k = 0; k < AP; k++) {
  const raan = 360 * rnd(), argp = 360 * rnd(), ma = 360 * rnd();
  records.push(repackOcm(fixture, (t) => {
    Object.assign(t.MEAN_ELEMENTS, { RA_OF_ASC_NODE: raan, ARG_OF_PERICENTER: argp, MEAN_ANOMALY: ma });
    t.METADATA.NORAD_CAT_ID = 100000 + k;
    t.METADATA.OBJECT_NAME = `P${k}`;
  }));
}
const apBytes = Buffer.concat(records.map((r) => { const b = Buffer.alloc(4 + r.length); b.writeUInt32LE(r.length, 0); Buffer.from(r).copy(b, 4); return b; }));
const meta = { epochMs, rows: ROWS, ap: AP };

// ---------------------------------------------------------------------------------------------------------------- the Node side: the same jobs, the same code
async function nodeRun(threads) {
  const host = new Worker(new URL("./lib/browser-pool/node-host.mjs", import.meta.url), {
    workerData: { threads, wasmPath, rows, apBytes, meta, ROWS, AP },
  });
  activeNode = host;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const arm = (name) => {
        currentCase = `Node ${threads} threads: ${name}`;
        clearTimeout(timer);
        timer = setTimeout(() => reject(new Error(`${currentCase}: exceeded 5 minutes`)), 5 * 60 * 1000);
      };
      arm("host startup");
      host.on("message", (message) => {
        if (message.case) arm(message.case);
        else resolve(message.result);
      });
      host.once("error", reject);
      host.once("exit", (code) => reject(new Error(`${currentCase}: host exited (${code}) before reporting`)));
    });
  } finally { clearTimeout(timer); await host.terminate(); activeNode = undefined; }
}
const nodeSide = {};
for (const t of THREADS) nodeSide[t] = await nodeRun(t);
const tNode = Date.now();

// ---------------------------------------------------------------------------------------------------------------- the page, its server, the browser
const bundle = async (entry) => (await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser", target: ["es2022"],
  external: ["node:*", "hd-wallet-wasm"], logLevel: "silent" })).outputFiles[0].text;
const sdkHost = path.dirname(require.resolve("space-data-module-sdk/host/wasi-threads"));
const hostWorkerJs = await bundle(path.join(here, "lib", "browser-pool", "host-worker.js"));
const threadWorkerJs = await bundle(path.join(sdkHost, "wasiThreadBrowserWorker.mjs"));
const pageJs = fs.readFileSync(path.join(here, "lib", "browser-pool", "page.js"));
const pageHtml = fs.readFileSync(path.join(here, "lib", "browser-pool", "page.html"));
const wasmBytes = fs.readFileSync(wasmPath);
const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "no-store" };
const token = randomBytes(32).toString("hex");
let donePayload;
const done = new Promise((resolve) => { donePayload = resolve; });
const routes = {
  "/": ["text/html; charset=utf-8", pageHtml], "/page.js": ["text/javascript; charset=utf-8", pageJs], "/host-worker.js": ["text/javascript; charset=utf-8", hostWorkerJs],
  "/wasi-thread-worker.js": ["text/javascript; charset=utf-8", threadWorkerJs], "/module.wasm": ["application/wasm", wasmBytes],
  "/data/meta.json": ["application/json", JSON.stringify(meta)], "/data/rows.bin": ["application/octet-stream", rows], "/data/ap.bin": ["application/octet-stream", apBytes],
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/progress" && url.searchParams.get("token") === token) {
    currentCase = `browser ${url.searchParams.get("case")}`;
    res.writeHead(200, headers); res.end("ok"); return;
  }
  if (req.method === "POST" && url.pathname === "/done") {
    if (url.searchParams.get("token") !== token) { res.writeHead(403, headers); res.end("forbidden"); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, headers); res.end("ok"); donePayload(payload);
      } catch { res.writeHead(400, headers); res.end("invalid JSON"); }
    });
    return;
  }
  const route = routes[url.pathname];
  if (!route) { res.writeHead(404, headers); res.end("not found"); return; }
  res.writeHead(200, { ...headers, "Content-Type": route[0], "Content-Length": Buffer.byteLength(route[1]) });
  res.end(route[1]);
});
let profile, child;
let cleanupPromise;
const cleanup = () => cleanupPromise ??= (async () => {
  clearTimeout(wholeTimer);
  if (child?.pid) {
    // detached creates this test's process group; a negative PID addresses only that group.
    try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") console.warn(`browser cleanup: ${e.message}`); }
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("close", resolve));
  }
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  if (profile) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (e) { console.warn(`WARNING: browser profile cleanup: ${e.message}`); }
  }
})();
cleanupRun = cleanup;
currentCase = "browser host startup";
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-ap-browser-"));
  const { command, args, env } = launch(`http://127.0.0.1:${server.address().port}/?threads=${JSON.stringify(THREADS)}&token=${token}`, profile);
  child = spawn(command, args, { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
  const exited = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`the browser exited before reporting (code ${code}, signal ${signal})`)));
  });
  browser = await Promise.race([done, exited]);
} finally {
  await cleanup();
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGTERM", onTerm);
}

// ---------------------------------------------------------------------------------------------------------------- the assertions
assert.equal(browser.fatal, undefined, `the page failed: ${browser.fatal}`);
assert.equal(browser.crossOriginIsolated, true, "the page is cross-origin isolated");
const ref = nodeSide[0];
let pooledEpochs = null, framesPresent = null;
for (const t of THREADS) {
  const run = browser.runs[t];
  assert.ok(run?.ok, `the page's run at ${t} threads: ${run?.error}\n${run?.stack ?? ""}`);
  const b = run.result, n = nodeSide[t];
  assert.equal(b.crossOriginIsolated, true, `the Worker at ${t} threads is cross-origin isolated`);
  assert.equal(b.sharedMemory, true, `the module's memory is a SharedArrayBuffer at ${t} threads`);
  assert.equal(b.running, t, `sdnap_threads(${t}) in the browser`);
  // the same bits: Node at the same thread count, and the Node run at 0 threads (a count never changes a byte)
  assert.equal(n.rows.digest, ref.rows.digest, `Node: the rows' digest at ${t} threads equals the one at 0`);
  assert.equal(n.ap.digest, ref.ap.digest, `Node: the AP catalog's digest at ${t} threads equals the one at 0`);
  assert.equal(b.rows.digest, n.rows.digest, `the rows' digest in the browser at ${t} threads equals Node's`);
  assert.deepEqual(b.ap.digests, n.ap.digests, `the AP catalog's digests (five instants and the covariance pass) in the browser at ${t} threads equal Node's`);
  assert.equal(b.ap.digest, n.ap.digest, `the AP catalog's digest in the browser at ${t} threads equals Node's`);
  assert.equal(b.rows.nonzeroStatus + b.ap.nonzeroStatus, 0, `every status is 0 in the browser at ${t} threads`);
  if (t > 0) {
    assert.equal(b.rows.spawn.spawned, t, `the host's spawn count at ${t} threads`);
    assert.equal(b.rows.spawn.distinct, t, `distinct operating-system threads at ${t} threads`);
    const p = b.rows.pool;
    assert.equal(p.threads, t, "the pool's running threads");
    assert.ok(p.batches >= 3, `${p.batches} threaded batches of rows at ${t} threads`);
    assert.deepEqual([p.refused, p.deferred, p.afterGrowth, p.dead], [0, 0, 0, 0], `rows: refused, deferred, after-growth and dead counts at ${t} threads`);
    if (p.rowsOnPool >= 0) assert.ok(p.rowsOnPool > 0 && p.poolThreadsWithRows > 1, `rows completed on pool threads at ${t} threads: ${p.rowsOnPool} on ${p.poolThreadsWithRows}`);
    const batches = b.ap.pool.batches - b.ap.poolBefore.batches;
    if (batches > 0) {
      pooledEpochs = true;
      const q = b.ap.pool;
      assert.deepEqual([q.refused, q.deferred, q.afterGrowth, q.dead], [0, 0, 0, 0], `sdnap_epochs_at: refused, deferred, after-growth and dead counts at ${t} threads`);
      assert.ok(b.ap.growthsDuringPasses > 0, `the module's memory grew during the batches (${b.ap.growthsDuringPasses} growths) at ${t} threads`);
      if (q.rowsOnPool >= 0) assert.ok(q.rowsOnPool > b.rows.pool.rowsOnPool, `sdnap_epochs_at rows completed on pool threads at ${t} threads`);
    } else if (pooledEpochs === null) pooledEpochs = false;
  }
  // the frame path
  const f = b.frames, fn = n.frames;
  assert.equal(f.present, fn.present, "the frame exports are present in the browser's instance exactly when they are in Node's");
  if (f.present) {
    framesPresent = true;
    assert.equal(f.nonzeroStatus, 0, `frames: every status 0 at ${t} threads`);
    assert.equal(f.served, fn.served, "frames: browser and Node served counts agree");
    assert.equal(f.served, AP, "frames: every object is served by the frame path");
    assert.deepEqual(f.digests, fn.digests, `frames: planes and statuses at three instants, TEME and Earth-fixed, equal to Node's at ${t} threads`);
    assert.equal(f.digest, ref.frames.digest, `frames: the digest at ${t} threads equals the one at 0 (slices of 8 rows against slices of 500)`);
  } else framesPresent ??= false;
}
const tEnd = Date.now();
console.log(`browser-pool (${which}, ${(browser.userAgent.match(/(HeadlessChrome|Firefox)\/[\d.]+/) ?? browser.userAgent.match(/AppleWebKit\/[\d.]+/) ?? [""])[0]}): digests equal to Node at ${THREADS.join(", ")} threads for ${ROWS} SGP4 rows and ${AP} AP records with covariance`);
console.log(pooledEpochs === null ? "  sdnap_epochs_at: not asked on pool threads" : pooledEpochs ? "  sdnap_epochs_at ran on pool threads; the memory grew during the batches; no refusal, deferral or dead thread"
  : "  sdnap_epochs_at is not handed to the pool by this build: its digests are asserted, no batch bound");
console.log(framesPresent ? "  frame path: planes and statuses equal to Node's, bit for bit, whatever the slice" : "  frame path: this build has no frame exports; nothing asserted");
if (!framesPresent && process.env.SDNAP_REQUIRE_FRAMES === "1") throw new Error("frame path required (SDNAP_REQUIRE_FRAMES=1), but this build has no frame exports");
console.log(`  ${((tNode - T0) / 1000).toFixed(0)} s for the Node side, ${((tEnd - tNode) / 1000).toFixed(0)} s for the browser, ${((tEnd - T0) / 1000).toFixed(0)} s in all`);
process.exit(0);
