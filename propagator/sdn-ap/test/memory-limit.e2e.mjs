#!/usr/bin/env node
// E2E (stack #600; SPEC 1.6): at its memory limit the module refuses, never aborts. 547 AP sets at 500 km (the headline
// forces: zonal 20, tesseral 31, NRLMSISE-00 on 46 made-up quiet rows; node and mean anomaly spread) are loaded by one
// load_epochs into an instance whose host memory is held to 128 MiB (initial 64 MiB, one thread). They are flown set by set
// (sdnap_epochs_set_at) a day after their epoch, then again two days after it, where each set's tesseral cache is baked
// again from its table. Through 0.6.52 the second pass aborted the module (wasm unreachable) at its first set: the thread's
// 192 KiB coefficient storage was first asked for there, and could not be had.
// - no call traps, and each answers 0 or the theory's refusal code (1), the resident exports' refusal (SPEC 1.6); the memory
//   reaches its limit (a set refused in the first pass);
// - every state answered equals, bit for bit, the same set's state at the same time in an instance at the host's default
//   maximum, where every set answers;
// - the first set's state of the first pass, asked again after the second (the memory full, allocations failed in between):
//   bit for bit the first.
// JS moves bytes and compares numbers the module produced.
//   node test/memory-limit.e2e.mjs
import assert from "node:assert/strict";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { F107DataType } from "spacedatastandards.org/lib/js/OCM/F107DataType.js";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { T, seedOcm, rowsThrough } from "./lib/ocm.mjs";

ensureBuilt();
const N = 547, MIB = 1 << 20, DAY = 86400000, EPOCH = Date.parse("2026-06-15T00:00:00Z"), MU = 398600.4418, RE = 6378.137;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const revPerDay = (a) => (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI);
const rows = rowsThrough(Array.from({ length: 46 }, (_, k) => ({ DATE: iso(EPOCH + (k - 5) * DAY).slice(0, 10), F107_OBS: 70, F107_OBS_CENTER81: 72, AP_AVG: 4, F107_DATA_TYPE: F107DataType.OBS })));
const record = (k) => seedOcm({ epoch: iso(EPOCH), n: revPerDay(RE + 500), e: 0.001, i: 97.4, raan: (120 + 3.3 * k) % 360, argp: 90, ma: (10 + 7.1 * k) % 360,
  bterm: 3.8e-3, agom: 0.01, norad: 80000 + k, name: `P${k}`, msis: true, records: true, rows, tesseral: 31, zonal: 20 });
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const snapshot = Buffer.concat(Array.from({ length: N }, (_, k) => prefixed(record(k))));
const jd = (ms) => { const d = ms / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; };
const PASSES = [EPOCH + DAY, EPOCH + 2 * DAY].map(jd);
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));

async function open(maximumMemoryBytes = 0) {
  const options = { surface: "direct", maxThreads: 1, enableBrowserWasiThreads: false, initialMemoryBytes: 64 * MIB };
  if (maximumMemoryBytes > 0) options.maximumMemoryBytes = maximumMemoryBytes;
  const h = await createStandaloneHarness("browser", wasmPath, options);
  const x = h.instance.exports;
  const mem = () => (h.memory ?? x.memory).buffer;
  const out = x.sdnap_alloc(48);
  const r = await h.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: snapshot }] });
  assert.equal(r.statusCode, 0, `load_epochs of ${N} sets: ${r.errorCode} ${r.errorMessage}`);
  const at = (k, [w, f], what) => {
    let rc;
    try { rc = x.sdnap_epochs_set_at(k, 0, w, f, out); }
    catch (e) { assert.fail(`${what}, set ${k}: the module trapped (${e?.message ?? e})`); }
    return { rc, s: rc === 0 ? Array.from(new Float64Array(mem(), out, 6)) : null };
  };
  return { at, mib: () => mem().byteLength / MIB };
}

const ref = await open();
const lim = await open(128 * MIB);
const answered = [0, 0], refused = [0, 0];
let first = null;
for (const [p, t] of PASSES.entries()) {
  const what = `pass ${p + 1} (${p + 1} day${p ? "s" : ""} after the epoch)`;
  for (let k = 0; k < N; k++) {
    const a = lim.at(k, t, `${what} at 128 MiB`), b = ref.at(k, t, `${what} at the default maximum`);
    assert.equal(b.rc, 0, `${what} at the default maximum, set ${k}: code ${b.rc}`);
    assert.ok(a.rc === 0 || a.rc === 1, `${what} at 128 MiB, set ${k}: code ${a.rc}, neither a state nor the refusal`);
    if (a.rc === 1) { refused[p] += 1; continue; }
    answered[p] += 1;
    assert.ok(same(a.s, b.s), `${what}, set ${k}: ${a.s.join(", ")} at 128 MiB against ${b.s.join(", ")}`);
    if (p === 0 && k === 0) first = a.s;
  }
  console.log(`${what} at 128 MiB: ${answered[p]} answered (each the default maximum's state, bit for bit), ${refused[p]} refused; memory ${lim.mib()} MiB`);
}
assert.ok(refused[0] > 0, `the first pass refused no set: the memory did not reach its limit (raise the count)`);
assert.ok(answered[1] > 0, "the second pass answered no set");
assert.ok(first !== null, "the first set did not answer in the first pass");
const again = lim.at(0, PASSES[0], "the first set asked again");
assert.equal(again.rc, 0, `the first set's first state asked again after the second pass: code ${again.rc}`);
assert.ok(same(again.s, first), `the first set's first state asked again: ${again.s.join(", ")} against ${first.join(", ")}`);
console.log("the first set's state of the first pass, asked again after the second: bit for bit");
process.exit(0);
