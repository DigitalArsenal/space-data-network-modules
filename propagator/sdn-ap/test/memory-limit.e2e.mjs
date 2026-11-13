#!/usr/bin/env node
// E2E (stack #600; SPEC 1.6): at its memory limit the module refuses, never aborts, and what it answers is what it answers
// with memory to spare. Every instance below is held to a host maximum (initial 64 MiB); every answer is compared, bit for
// bit, with the same call in an instance at the host's default maximum. No call may trap; each answers a state or a refusal.
// 1. AP sets one by one (sdnap_epochs_set_at). 547 sets at 500 km (zonal 20, tesseral 31, NRLMSISE-00 on 46 made-up quiet
//    rows; node and mean anomaly spread), one load_epochs, 128 MiB, one thread. Flown a day after their epoch, then two days
//    after, where each set's tesseral cache is baked again from its table. Through 0.6.52 the second pass aborted the module
//    (wasm unreachable) at its first set: the thread's 192 KiB coefficient block was first asked for there. Codes 0 or 1 (the
//    theory's refusal, the resident exports' refusal); 541 of the 547 answer in each pass on this build (FIRST_PASS, within
//    MARGIN); the first set's first-pass state, asked again after the second pass, is the first.
// 2. The covariance entry (sdnap_epochs_at with its covariance). 400 copies of a fitted 300 km record that carries a
//    covariance (test/fixtures/synthetic-grid-hp300-e0-i70.ocm, each its own catalog number), 128 MiB, flown a day after
//    their epoch: a state answered or refused (1), a covariance answered or left NaN (a bank that cannot be built, SPEC 1.6),
//    and the limit reached (a covariance not answered).
// 3. A pool batch (sdnap_propagate_soa on two pool threads). 2,000 AP rows at 500 km in the row store (a test build that
//    selects AP's terms: tesseral 31, zonal 20), 128 MiB, at two instants half a day apart: no trap, the limit reached. A
//    threaded batch of the same size runs first, while the memory is free, so that the batch's list of deferred rows (a
//    std::vector, which SPEC 1.6 names among what still traps) has its room.
// 4. SGP4XP sets without AP's terms (6,000 stock records at 500 km, 80 MiB, sdnap_epochs_set_at): every set the build this
//    change was made on answered (0.6.55, modules 3c14c974: 2,480 of them) is answered, each state its state (an SGP4XP flight
//    makes only the caches it reads, as that build did). 0.6.54 answered 2,329 there and 0.6.52 2,335, before 0.6.55's load.
// JS moves bytes and compares numbers the module produced.
//   node test/memory-limit.e2e.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { ensureBuilt, wasmPath, packageRoot, elementRows, THEORY } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, seedOcm, rowsThrough, repackOcm, ocmOf } from "./lib/ocm.mjs";
import { scratchTemp } from "./lib/scratch.mjs";

ensureBuilt();
const N = 547, MIB = 1 << 20, DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
// part 1's first pass on this build: 541 of 547 answer; a later build within 5 of it. Main 0.6.55 alone answers 543 (its
// second pass traps), two more: this build makes the 192 KiB coefficient block before the first state (on 0.6.54, 541 and
// 539; on 0.6.52, 547 and 545)
const FIRST_PASS = 541, MARGIN = 5;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const rows = rowsThrough(Array.from({ length: 46 }, (_, k) => ({ DATE: iso(EPOCH + (k - 5) * DAY).slice(0, 10), F107_OBS: 70, F107_OBS_CENTER81: 72, AP_AVG: 4, F107_DATA_TYPE: F107DataType.OBS })));
const record = (k) => seedOcm({ epoch: iso(EPOCH), n: revPerDay(RE + 500), e: 0.001, i: 97.4, raan: (120 + 3.3 * k) % 360, argp: 90, ma: (10 + 7.1 * k) % 360,
  bterm: 3.8e-3, agom: 0.01, norad: 80000 + k, name: `P${k}`, msis: true, records: true, rows, tesseral: 31, zonal: 20 });
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const jd = (ms) => { const d = ms / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; };
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));

async function open(file, { max = 0, threads = 0 } = {}) {
  const options = { surface: "direct", maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0, initialMemoryBytes: 64 * MIB };
  if (max > 0) options.maximumMemoryBytes = max * MIB;
  const h = await createStandaloneHarness("browser", file, options);
  const x = h.instance.exports;
  if (threads) assert.equal(x.sdnap_threads(threads), threads, `${threads} pool threads`);
  const mem = () => (h.memory ?? x.memory).buffer;
  const trapless = (what, f) => { try { return f(); } catch (e) { assert.fail(`${what}: the module trapped (${e?.message ?? e})`); } };
  return { h, x, mem, trapless, load: (payload) => h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload }] }) };
}

// 1. AP sets one by one
{
  const snapshot = Buffer.concat(Array.from({ length: N }, (_, k) => prefixed(record(k))));
  const ref = await open(wasmPath), lim = await open(wasmPath, { max: 128 });
  for (const m of [ref, lim]) assert.equal((await m.load(snapshot)).statusCode, 0, "load_epochs");
  const outs = [ref, lim].map((m) => m.x.sdnap_alloc(48));
  const at = (m, o, k, [w, f], what) => {
    const rc = m.trapless(`${what}, set ${k}`, () => m.x.sdnap_epochs_set_at(k, 0, w, f, o));
    return { rc, s: rc === 0 ? Array.from(new Float64Array(m.mem(), o, 6)) : null };
  };
  const PASSES = [EPOCH + DAY, EPOCH + 2 * DAY].map(jd);
  const answered = [0, 0];
  let first = null;
  for (const [p, t] of PASSES.entries()) {
    const what = `part 1, pass ${p + 1}`;
    for (let k = 0; k < N; k++) {
      const a = at(lim, outs[1], k, t, what), b = at(ref, outs[0], k, t, `${what} at the default maximum`);
      assert.equal(b.rc, 0, `${what} at the default maximum, set ${k}: code ${b.rc}`);
      assert.ok(a.rc === 0 || a.rc === 1, `${what}, set ${k}: code ${a.rc}, neither a state nor the refusal`);
      if (a.rc !== 0) continue;
      answered[p] += 1;
      assert.ok(same(a.s, b.s), `${what}, set ${k}: ${a.s.join(", ")} at 128 MiB against ${b.s.join(", ")}`);
      if (p === 0 && k === 0) first = a.s;
    }
    console.log(`${what}: ${answered[p]} of ${N} answered at 128 MiB, each the default maximum's state bit for bit; memory ${lim.mem().byteLength / MIB} MiB`);
  }
  assert.ok(Math.abs(answered[0] - FIRST_PASS) <= MARGIN && answered[0] < N, `part 1's first pass answered ${answered[0]} of ${N} (this build: ${FIRST_PASS}, margin ${MARGIN})`);
  assert.ok(answered[1] > 0 && first !== null, "part 1: answers in both passes");
  const again = at(lim, outs[1], 0, PASSES[0], "part 1, the first set again");
  assert.ok(again.rc === 0 && same(again.s, first), "part 1: the first set's first state asked again after the second pass");
}

// 2. the covariance entry
{
  const base = new Uint8Array(fs.readFileSync(new URL("fixtures/synthetic-grid-hp300-e0-i70.ocm", import.meta.url)));
  const COPIES = 400;
  const snapshot = Buffer.concat(Array.from({ length: COPIES }, (_, k) => prefixed(repackOcm(base, (o) => { o.METADATA.NORAD_CAT_ID = 90000 + k; }))));
  const ref = await open(wasmPath), lim = await open(wasmPath, { max: 128 });
  for (const m of [ref, lim]) assert.equal((await m.load(snapshot)).statusCode, 0, "part 2: load_epochs");
  const bufs = [ref, lim].map((m) => ({ pos: m.x.sdnap_alloc(48), st: m.x.sdnap_alloc(4), cov: m.x.sdnap_alloc(288) }));
  const e = ocmOf(base).MEAN_ELEMENTS.EPOCH, t0 = Date.parse(e.endsWith("Z") ? e : `${e}Z`);
  const [w, f] = jd(t0 + DAY);
  let states = 0, covs = 0, without = 0;
  for (let k = 0; k < COPIES; k++) {
    const flown = [ref, lim].map((m, q) => {
      const b = bufs[q];
      m.trapless(`part 2, copy ${k}`, () => m.x.sdnap_epochs_at(w, f, k, 1, 0, b.pos, b.st, b.cov));
      return { rc: new Int32Array(m.mem(), b.st, 1)[0], s: Array.from(new Float64Array(m.mem(), b.pos, 6)), c: Array.from(new Float64Array(m.mem(), b.cov, 36)) };
    });
    const [b, a] = flown;
    assert.ok(b.rc === 0 && b.c.every(Number.isFinite), `part 2 at the default maximum, copy ${k}: ${b.rc}`);
    assert.ok(a.rc === 0 || a.rc === 1, `part 2, copy ${k}: code ${a.rc}`);
    if (a.rc !== 0) continue;
    states += 1;
    assert.ok(same(a.s, b.s), `part 2, copy ${k}: the state against the default maximum's`);
    if (a.c.every(Number.isFinite)) { covs += 1; assert.ok(same(a.c, b.c), `part 2, copy ${k}: the covariance against the default maximum's`); }
    else { without += 1; assert.ok(a.c.every(Number.isNaN), `part 2, copy ${k}: a covariance part answered`); }
  }
  assert.ok(covs > 0 && covs < COPIES, `part 2: ${covs} of ${COPIES} covariances answered: the limit not reached, or none`);
  console.log(`part 2 (the covariance entry): ${states} of ${COPIES} states and ${covs} covariances answered at 128 MiB (${without} states without), each the default maximum's bit for bit`);
}

// 3. a pool batch
{
  const testBuild = buildDiagnostic("memory-limit-rows",
    'SDNAP_EXPORT("sdnap_test_select_ap") void sdnap_test_select_ap(int32_t t, int32_t z) { sdnap::xpt::tess::active() = sdnap::xpt::tess::Terms{t, z}; }\n');
  const ROWS = 2000;
  const rowsBytes = elementRows(Array.from({ length: ROWS }, (_, k) => ({ epochWhole: 2461206.5, epochFrac: 0, meanMotion: revPerDay(RE + 500), ecc: 0.001,
    inc: 40 + (k % 60), raan: (7.3 * k) % 360, argp: 90, ma: (11.1 * k) % 360, bterm: 0.004, agom: 0.01, norad: 50000 + k, theory: THEORY.SGP4XP })));
  const sgp4Bytes = elementRows(Array.from({ length: ROWS }, (_, k) => ({ epochWhole: 2461206.5, epochFrac: 0, meanMotion: revPerDay(RE + 500), ecc: 0.001,
    inc: 50, raan: k % 360, argp: 90, ma: 0, bstar: 1e-5, norad: 40000 + k, theory: THEORY.SGP4 })));
  const flyRows = async (max, threads) => {
    const m = await open(testBuild, { max, threads });
    m.x.sdnap_test_select_ap(31, 20);
    // the output planes before the store fills the memory
    const p = m.x.sdnap_alloc(rowsBytes.length), out = m.x.sdnap_alloc(48 * ROWS), status = m.x.sdnap_alloc(4 * ROWS), all = [];
    assert.ok(p && out && status, "part 3: the call's buffers");
    // one threaded batch over 2,000 SGP4 rows first: the batch's list of deferred rows (a std::vector, SPEC 1.6's list of what
    // still traps) takes its room while the memory is free, as any earlier batch of that size gives it
    if (threads > 0) {
      new Uint8Array(m.mem(), p, sgp4Bytes.length).set(sgp4Bytes);
      assert.equal(m.x.sdnap_init_elements(p, ROWS), ROWS, "part 3: the SGP4 rows");
      assert.equal(m.x.sdnap_propagate_soa(2461206.5, 0.5, 0, ROWS, 0, out, status), 0, "part 3: the SGP4 batch");
    }
    new Uint8Array(m.mem(), p, rowsBytes.length).set(rowsBytes);
    const held = m.trapless("part 3: sdnap_init_elements", () => m.x.sdnap_init_elements(p, ROWS));
    for (const frac of [0.5, 1.0]) {
      const rc = m.trapless(`part 3, ${threads} pool threads`, () => m.x.sdnap_propagate_soa(2461206.5, frac, 0, ROWS, 0, out, status));
      assert.equal(rc, 0, `part 3, ${threads} pool threads, ${max || "the default"} MiB: sdnap_propagate_soa returned ${rc}`);
      all.push({ rc, s: Array.from(new Float64Array(m.mem(), out, 6 * ROWS)), st: Array.from(new Int32Array(m.mem(), status, ROWS)) });
    }
    return { held, all };
  };
  const ref = await flyRows(0, 0), lim = await flyRows(128, 2);
  // a row the theory refuses at the default maximum (a few of these inclinations) is refused at the limit too
  let answered = 0, notAnswered = 0;
  for (const [q, b] of ref.all.entries()) {
    const a = lim.all[q];
    for (let k = 0; k < ROWS; k++) {
      if (b.st[k] !== 0) { assert.notEqual(a.st[k], 0, `part 3, instant ${q}, row ${k}: answered at the limit, refused (${b.st[k]}) at the default maximum`); continue; }
      if (a.st[k] !== 0) { notAnswered += 1; continue; }
      answered += 1;
      for (let c = 0; c < 6; c++) assert.ok(Object.is(a.s[c * ROWS + k], b.s[c * ROWS + k]), `part 3, instant ${q}, row ${k}: the state against the default maximum's`);
    }
  }
  assert.ok(answered > 0 && notAnswered > 0, `part 3: ${answered} rows answered and ${notAnswered} not: the limit not reached, or nothing answered`);
  console.log(`part 3 (two pool threads, the row store): ${lim.held} rows held, ${answered} answers and ${notAnswered} refusals over two instants at 128 MiB, each answer the default maximum's bit for bit`);
}

// 4. SGP4XP sets without AP's terms, against 0.6.55
{
  const modulesRoot = path.resolve(packageRoot, "../..");
  const bytes = execFileSync("git", ["-C", modulesRoot, "show", "3c14c974:propagator/sdn-ap/dist/isomorphic/module.wasm"], { maxBuffer: 1 << 26 });
  assert.ok(crypto.createHash("sha256").update(bytes).digest("hex").startsWith("e96afd51"), "0.6.55 at 3c14c974");
  const oldPath = path.join(scratchTemp("sdnap-memory-limit-"), "module-0.6.55.wasm");
  fs.writeFileSync(oldPath, bytes);
  const COUNT = 6000;
  const snapshot = Buffer.concat(Array.from({ length: COUNT }, (_, k) => prefixed(seedOcm({ epoch: iso(EPOCH), n: revPerDay(RE + 500), e: 0.001, i: 97.4,
    raan: (3.3 * k) % 360, argp: 90, ma: (7.1 * k) % 360, bterm: 0.004, norad: 60000 + k }))));
  const flown = [];
  for (const file of [oldPath, wasmPath]) {
    const m = await open(file, { max: 80 });
    assert.equal((await m.load(snapshot)).statusCode, 0, "part 4: load_epochs");
    const o = m.x.sdnap_alloc(48), r = [];
    for (let k = 0; k < COUNT; k++) {
      const rc = m.trapless(`part 4, set ${k}`, () => m.x.sdnap_epochs_set_at(k, 0, 2461207.5, 0, o));
      r.push(rc === 0 ? Array.from(new Float64Array(m.mem(), o, 6)) : rc);
    }
    flown.push(r);
  }
  const [old, now] = flown;
  const oldAnswered = old.filter(Array.isArray).length, nowAnswered = now.filter(Array.isArray).length;
  for (let k = 0; k < COUNT; k++)
    if (Array.isArray(old[k])) assert.ok(Array.isArray(now[k]) && same(now[k], old[k]), `part 4, set ${k}: 0.6.55 answered it; this build ${Array.isArray(now[k]) ? "differs" : `refused it (${now[k]})`}`);
  assert.ok(oldAnswered < COUNT, "part 4: the limit not reached");
  console.log(`part 4 (SGP4XP without AP's terms, 80 MiB): 0.6.55 answered ${oldAnswered} of ${COUNT}, this build ${nowAnswered}; every one 0.6.55 answered is answered, bit for bit`);
}
process.exit(0);
