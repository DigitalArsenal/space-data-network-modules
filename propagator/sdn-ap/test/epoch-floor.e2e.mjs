#!/usr/bin/env node
// E2E (SPEC 12.4, stack #551): an AP set's epoch floor is put on by the writer and taken off by the reader at the two-body
// state of the set's own mean elements, so no change to a theory's epoch state moves what a reader takes off; an AP record
// written before that has its covariance refused by name and its states fly.
// Per case, an AP set (caps 31 and 20, NRLMSISE-00 on the fixture rows) is flown 24 h at 600 s in GCRF by 0.6.36 (git
// c8b0972b, its SHA-256 checked), and that arc fitted by 0.6.36 and by this build:
// - this build's record flown by this build against 0.6.36's record flown by 0.6.36, sdnap_covariance_at hourly to 48 h: the
//   covariance within SELF.ofLargest of a time's largest entry and the along-track variance within SELF.along relative
//   (the same mean elements, so a set's own flight is as it was);
// - 0.6.36's record on this build: sdnap_covariance_at -7; propagate status 0, no
//   covariance lines, the block's COMMENT naming cov-floor-at-theory-state, its states within STATES_M of 0.6.36's flight of it
//   (a flight without covariance takes the state path, one with it the covariance's nominal: they part by about 0.3 mm).
// Cases: 300 km at i 5 and 1,200 km at i 0.5 (where 0.6.36's records read by a later theory came out narrowest, or with a
// negative along-track variance: stack #551), 550 km at i 52.9 (the fixture's orbit, where they came out wider).
//   node test/epoch-floor.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as flatbuffers from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {pcfOutputFrame} from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import {pcfWeatherSource} from 'spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';
import {ensureBuilt, wasmPath} from './lib/module.mjs';
import {configuration, MSIS_FORCES} from './lib/pcf.mjs';
import {spwRows} from './lib/fixture-inputs.mjs';
import {T, seedOcm, flight, rowsThrough} from './lib/ocm.mjs';
import {scratchTemp} from './lib/scratch.mjs';

ensureBuilt();
const BASE = {version: '0.6.36', commit: 'c8b0972b0674ce041995048b78f39263b751596a', sha256: 'bf1b58989b128d7b9e3a3c6b05e8228fe9224cbb565a55a72124011bf70b5315'};
const SELF = {ofLargest: 1e-9, along: 1e-8}, STATES_M = 0.001;
const modules = fileURLToPath(new URL('../../../', import.meta.url));
const baseBytes = execFileSync('git', ['-C', modules, 'show', `${BASE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26});
assert.equal(createHash('sha256').update(baseBytes).digest('hex'), BASE.sha256, `${BASE.version} baseline sha256`);
const basePath = path.join(scratchTemp('sdn-ap-epoch-floor-'), `sdn-ap-${BASE.version}.wasm`);
fs.writeFileSync(basePath, baseBytes);
const base = await createStandaloneHarness('browser', basePath, {surface: 'direct'});
const cur = await createStandaloneHarness('browser', wasmPath, {surface: 'direct'});

const RE = 6378.1363, MU = 398600.4418, t0 = Date.parse('2026-10-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const rows = spwRows(), rowList = rowsThrough(rows.values);
const AP_FORCES = {...MSIS_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  WEATHER_SOURCE: pcfWeatherSource.RECORDS};
const minutes = Array.from({length: 49}, (_, k) => k * 60);
const covAt = (h, rec) => {
  const x = h.instance.exports, mem = () => h.memory.buffer;
  const po = x.sdnap_alloc(rec.length), pm = x.sdnap_alloc(8 * minutes.length), pout = x.sdnap_alloc(8 * 42 * minutes.length);
  new Uint8Array(mem(), po, rec.length).set(rec);
  new Float64Array(mem(), pm, minutes.length).set(minutes);
  const status = x.sdnap_covariance_at(po, rec.length, pm, minutes.length, pout);
  const out = Array.from(new Float64Array(mem(), pout, 42 * minutes.length));
  x.sdnap_free(po); x.sdnap_free(pm); x.sdnap_free(pout);
  return {status, out};
};
// the covariance's largest difference over a time's largest entry, and the along-track variance's relative difference
// (the along-track axis from the module's own state: r x v), 1 to 48 h
const apart = (a, b) => {
  let ofLargest = 0, along = 0;
  for (let k = 1; k < minutes.length; k++) {
    const o = 42 * k, ca = a.slice(o + 6, o + 42), cb = b.slice(o + 6, o + 42), r = a.slice(o, o + 3), v = a.slice(o + 3, o + 6);
    const big = Math.max(...ca.map(Math.abs));
    for (let j = 0; j < 36; j++) ofLargest = Math.max(ofLargest, Math.abs(cb[j] - ca[j]) / big);
    const rn = Math.hypot(...r), u = r.map((q) => q / rn), h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
    const hn = Math.hypot(...h), w = h.map((q) => q / hn), t = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
    const q = (c) => { let s = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += t[i] * c[i * 6 + j] * t[j]; return s; };
    along = Math.max(along, Math.abs(q(cb) - q(ca)) / Math.abs(q(ca)));
  }
  return {ofLargest, along};
};
const statesOf = (r) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0];

const CASES = [{name: '300 km, i 5', hp: 300, i: 5}, {name: '1,200 km, i 0.5', hp: 1200, i: 0.5}, {name: '550 km, i 52.9', hp: 550, i: 52.9}];
const failures = [];
for (const c of CASES) {
  const a = RE + c.hp, n = Math.sqrt(MU / a ** 3) * 86400 / (2 * Math.PI);
  const seed = seedOcm({epoch: iso(t0), n, e: 0.001, i: c.i, raan: 40, argp: 30, ma: 20, bterm: 0.01, agom: 0.01, norad: 99551, name: 'FLOOR',
    msis: true, records: true, tesseral: 31, zonal: 20, rows: rowList});
  const arcFlight = await base.invoke({methodId: 'propagate', inputs: flight([seed], {output: {EPOCHS: Array.from({length: 145}, (_, k) => iso(t0 + k * 600000)), FRAME: pcfOutputFrame.GCRF}})});
  assert.equal(arcFlight.statusCode, 0, `${c.name}: the arc's flight ${arcFlight.errorCode}`);
  const arc = new Uint8Array(arcFlight.outputs[0].payload);
  const fitBy = async (h) => {
    const f = await h.invoke({methodId: 'fit', inputs: [{portId: 'ephemeris', typeRef: T('OEM'), payload: arc}, configuration({theory: 'AP', forces: AP_FORCES}),
      {portId: 'space_weather', typeRef: T('SPW'), payload: rows.bytes}]});
    assert.equal(f.statusCode, 0, `${c.name}: fit ${f.errorCode} ${f.errorMessage}`);
    return new Uint8Array(f.outputs.find((o) => o.portId === 'elements').payload);
  };
  const old = await fitBy(base), mine = await fitBy(cur);
  // a set's own flight is as it was
  const [ob, mc] = [covAt(base, old), covAt(cur, mine)];
  const self = ob.status === 0 && mc.status === 0 ? apart(ob.out, mc.out) : null;
  // the record written before: its covariance refused by name, its states flown as the base flies them
  const oc = covAt(cur, old);
  const out = {output: {EPOCHS: [iso(t0), iso(t0 + 86400000), iso(t0 + 2 * 86400000)], FRAME: pcfOutputFrame.GCRF}};
  const [pb, pc] = [await base.invoke({methodId: 'propagate', inputs: flight([old], out)}), await cur.invoke({methodId: 'propagate', inputs: flight([old], out)})];
  const bb = pb.statusCode === 0 ? statesOf(pb) : null, cb = pc.statusCode === 0 ? statesOf(pc) : null;
  // its states as the base flies the record: within STATES_M (a flight without covariance takes the state path, one with it
  // the covariance's nominal; the two part by about 0.3 mm on any build)
  const statesM = bb && cb && cb.EPHEMERIS_DATA_LINES.length === bb.EPHEMERIS_DATA_LINES.length
    ? Math.max(...cb.EPHEMERIS_DATA_LINES.map((l, k) => 1000 * Math.hypot(l.X - bb.EPHEMERIS_DATA_LINES[k].X, l.Y - bb.EPHEMERIS_DATA_LINES[k].Y, l.Z - bb.EPHEMERIS_DATA_LINES[k].Z))) : NaN;
  const sameStates = statesM <= STATES_M;
  const row = {name: c.name, self, preFloorStatus: oc.status, preFloorStatesM: statesM, preFloorCovLines: cb?.COVARIANCE_MATRIX_LINES.length, comment: String(cb?.COMMENT ?? '').slice(0, 26)};
  console.log(JSON.stringify(row));
  if (!(self && self.ofLargest <= SELF.ofLargest && self.along <= SELF.along)) failures.push(`${c.name}: this build's record on this build against ${BASE.version}'s on ${BASE.version}: ${JSON.stringify(self ?? [ob.status, mc.status])} (within ${JSON.stringify(SELF)})`);
  if (oc.status !== -7) failures.push(`${c.name}: sdnap_covariance_at of ${BASE.version}'s record: ${oc.status}, expected -7`);
  if (!(sameStates && cb.COVARIANCE_MATRIX_LINES.length === 0 && String(cb.COMMENT ?? '').startsWith('cov-floor-at-theory-state:')))
    failures.push(`${c.name}: propagate of ${BASE.version}'s record: ${pc.statusCode === 0 ? `states ${statesM} m from ${BASE.version}'s, ${cb.COVARIANCE_MATRIX_LINES.length} covariance lines, COMMENT ${cb.COMMENT}` : pc.errorCode}`);
}
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('epoch floor E2E: PASS');
process.exit(0);
