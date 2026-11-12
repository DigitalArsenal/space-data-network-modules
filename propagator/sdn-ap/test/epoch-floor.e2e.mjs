#!/usr/bin/env node
// E2E (SPEC 12.4, stack #551): an AP record's epoch floor is put on by the writer and taken off by the reader at the two-body
// state of the record's own mean elements, so no change to a theory's epoch state moves what a reader takes off; an AP record
// written before that has its covariance refused by name and its states fly.
// Per case, an AP set (NRLMSISE-00 on the fixture rows; caps 31 and 20, or both 0) is flown 24 h at 600 s in GCRF by BASE, and
// that arc fitted by BASE and by this build. BASE is a build before the cure whose theory is this build's: from the low
// table's fast side (stack #477, SPEC 16.1) its first build with the band guard (git 258d824d, version string 0.6.36, its
// SHA-256 checked), since the fast side moves a low-table set's states from 0.6.38's (git f8fd3240, the base until then).
// - The cure (a reader whose theory's epoch state differs from the writer's): this build's record read again with its
//   gravity caps moved from 31 and 20 to 12 and 6, so its flown epoch state moves and the two-body state of its mean
//   elements does not (at i 52.9 by 31 m; near the equator the caps leave the epoch state as it was, and one case must
//   move by more than MOVED_KM). The epoch covariance less the floor the reader takes off (sdnap_test_epoch_floor) is the
//   same bit for bit; and on both, at minute 0, P(0) less the floor at the flown state equals that remainder within
//   IDENTITY of P(0)'s largest entry.
// - A set's own flight is as it was: this build's record flown by this build against BASE's record flown by BASE,
//   sdnap_covariance_at hourly to 48 h, within SELF.
// - Caps 0 (an AP set without gravity terms): this build's record flies its covariance with the floor at the two-body
//   state (one rule for every AP record), and BASE's has it refused.
// - BASE's record on this build: sdnap_covariance_at -7; propagate status 0, its three states within STATES_M of BASE's
//   flight of it (a flight without covariance takes the state path, one with it the covariance's nominal: they part by
//   about 0.3 mm on any build), no covariance lines, the block's COMMENT naming cov-floor-at-theory-state.
// - The gate reads PROVENANCE.PRODUCER exactly: this module at 0.6.39 or later as X.Y.Z accepted, anything else refused
//   (0.6.38, a release on main, writes its floor at the theory state).
// - The remainder is the hook's (sdnap_test_epoch_floor computes it from the record alone, at the state the reader's own
//   choice gives: cov::epoch_floor_at); the reader's P(0) is tied to it by the identity at minute 0.
// - The two-body state (twobody::state_of through epoch_floor_state) of three element sets bit for bit (TWO_BODY): every
//   record written from 0.6.39 on carries its floor at it, so it must never move; a change to it refuses no record and
//   moves every later reader's floor.
// - The stored fixture record, this build's own fit (ap-fit-0.6.39.ocm), has 0.6.36's fit's mean elements bit for bit.
// Cases: 300 km at i 5 and 1,200 km at i 0.5 (where 0.6.36's records read by a later theory came out narrowest, or with a
// negative along-track variance: stack #551), 550 km at i 52.9 (the fixture's orbit, where they came out wider), and 300 km
// at i 5 with caps 0.
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
import {T, seedOcm, flight, rowsThrough, repackOcm, ocmOf} from './lib/ocm.mjs';
import {scratchTemp} from './lib/scratch.mjs';

ensureBuilt();
const BASE = {version: '0.6.36', commit: '258d824d2c83da8aa0f9ad2325273cfe478ae5d8', sha256: '01f8fd18eb97107b4cd1e0d7694f31787bcddf7cbb61f44255d83e3f45f3f56f'};
const SELF = {ofLargest: 1e-11, along: 1e-10}, STATES_M = 0.001, MOVED_KM = 1e-4, IDENTITY = 1e-12;
// the two-body state of TWO_BODY_SETS' mean elements, recorded on 0.6.38, the same on 0.6.39 (IEEE 754 hex, km and km/s)
const TWO_BODY = [
  ['4093b9d48c182380', '40b49e65f890b127', '40afdb86f9e97c32', 'c019ddfa467d95f6', 'bff6ea35419b85d0', '400ee1ede45a0864'],
  ['c0da7a2feffb8a9e', 'c0df8bb18ea6e5e0', 'c0514ae8e3edf45d', '4002d6761bf6ee1e', 'bfff9e2ee457b2ea', '3f5e0f26a7a71755'],
  ['40ae8ecae16aac92', 'c0c1b781e4709029', 'c0a1e98f8a44d4c6', '40140fb17d6844b8', 'c00d9c36d7701362', '4013e9662b6b1fdb']];
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
const minutes = Array.from({length: 49}, (_, k) => k * 60);
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const hex = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigUint64(0).toString(16).padStart(16, '0'); };
// a module call on a record: `fn` writes `n` doubles at `out`; its status and the doubles
const call = (h, fn, rec, n, extra = null) => {
  const x = h.instance.exports, mem = () => h.memory.buffer;
  const po = x.sdnap_alloc(rec.length), pout = x.sdnap_alloc(8 * n), pm = extra ? x.sdnap_alloc(8 * extra.length) : 0;
  new Uint8Array(mem(), po, rec.length).set(rec);
  if (extra) new Float64Array(mem(), pm, extra.length).set(extra);
  const status = extra ? x[fn](po, rec.length, pm, extra.length, pout) : x[fn](po, rec.length, pout);
  const out = Array.from(new Float64Array(mem(), pout, n));
  x.sdnap_free(po); x.sdnap_free(pout); if (extra) x.sdnap_free(pm);
  return {status, out};
};
const covAt = (h, rec) => call(h, 'sdnap_covariance_at', rec, 42 * minutes.length, minutes);
const parts = (rec) => call(cur, 'sdnap_test_epoch_floor', rec, 150);
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
// at minute 0: P(0) less the floor at the flown state against the remainder, over P(0)'s largest entry
const identity = (rec) => {
  const pp = parts(rec), c0 = call(cur, 'sdnap_covariance_at', rec, 42, [0]);
  if (pp.status !== 0 || c0.status !== 0) return {status: [pp.status, c0.status]};
  const P0 = c0.out.slice(6), F0 = pp.out.slice(48, 84), R = pp.out.slice(84, 120), big = Math.max(...P0.map(Math.abs));
  return {gap: Math.max(...P0.map((p, q) => Math.abs(p - F0[q] - R[q]))) / big, parts: pp.out};
};
const statesOf = (r) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0];

const CASES = [
  {name: '300 km, i 5', hp: 300, i: 5, caps: [31, 20]}, {name: '1,200 km, i 0.5', hp: 1200, i: 0.5, caps: [31, 20]},
  {name: '550 km, i 52.9', hp: 550, i: 52.9, caps: [31, 20]}, {name: '300 km, i 5, caps 0', hp: 300, i: 5, caps: [0, 0]},
];
let producerRecord = null, standInMovedKm = 0;
for (const c of CASES) {
  const a = RE + c.hp, n = Math.sqrt(MU / a ** 3) * 86400 / (2 * Math.PI);
  const forces = {...MSIS_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: c.caps[0], HAS_MAXIMUM_DEGREE: true,
    MAXIMUM_DEGREE: c.caps[1], WEATHER_SOURCE: pcfWeatherSource.RECORDS};
  const seed = seedOcm({epoch: iso(t0), n, e: 0.001, i: c.i, raan: 40, argp: 30, ma: 20, bterm: 0.01, agom: 0.01, norad: 99551, name: 'FLOOR',
    msis: true, records: true, tesseral: c.caps[0], zonal: c.caps[1], rows: rowList});
  const arcFlight = await base.invoke({methodId: 'propagate', inputs: flight([seed], {output: {EPOCHS: Array.from({length: 145}, (_, k) => iso(t0 + k * 600000)), FRAME: pcfOutputFrame.GCRF}})});
  assert.equal(arcFlight.statusCode, 0, `${c.name}: the arc's flight ${arcFlight.errorCode}`);
  const arc = new Uint8Array(arcFlight.outputs[0].payload);
  const fitBy = async (h) => {
    const f = await h.invoke({methodId: 'fit', inputs: [{portId: 'ephemeris', typeRef: T('OEM'), payload: arc}, configuration({theory: 'AP', forces}),
      {portId: 'space_weather', typeRef: T('SPW'), payload: rows.bytes}]});
    assert.equal(f.statusCode, 0, `${c.name}: fit ${f.errorCode} ${f.errorMessage}`);
    return new Uint8Array(f.outputs.find((o) => o.portId === 'elements').payload);
  };
  const old = await fitBy(base), mine = await fitBy(cur);
  if (!producerRecord) producerRecord = mine;
  const row = {name: c.name};
  // the identity at minute 0, and (caps 31 and 20) the reader whose epoch state differs
  const id = identity(mine);
  row.identity = id.gap;
  check(id.gap <= IDENTITY, `${c.name}: P(0) less the floor at the flown state against the remainder: ${JSON.stringify(id.gap ?? id.status)} (within ${IDENTITY})`);
  if (id.parts) {
    const moved = Math.hypot(...[0, 1, 2].map((k) => id.parts[k] - id.parts[6 + k]));
    row.twoBodyFromFlownKm = moved;
    check(moved > MOVED_KM, `${c.name}: the two-body state ${moved} km from the flown epoch state (the floor taken there, not at the theory's)`);
  }
  if (c.caps[0] > 0) {
    const moved = repackOcm(mine, (u) => { u.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE = 12; u.PERTURBATIONS.MAXIMUM_ZONAL_DEGREE = 6; });
    const idm = identity(moved);
    const same = id.parts && idm.parts && id.parts.slice(84, 120).every((v, q) => Object.is(v, idm.parts[84 + q]));
    const flownMovedKm = id.parts && idm.parts ? Math.hypot(...[6, 7, 8].map((k) => id.parts[k] - idm.parts[k])) : NaN;
    row.standIn = {remainderSame: same, flownMovedKm, identity: idm.gap};
    standInMovedKm = Math.max(standInMovedKm, flownMovedKm);
    check(same && idm.gap <= IDENTITY,
      `${c.name}: read with the gravity caps at 12 and 6: remainder ${same ? 'the same' : 'moved'}, flown epoch state moved ${flownMovedKm} km, identity ${idm.gap}`);
  }
  // a set's own flight is as it was
  const [ob, mc] = [covAt(base, old), covAt(cur, mine)];
  const self = ob.status === 0 && mc.status === 0 ? apart(ob.out, mc.out) : null;
  row.self = self;
  check(self && self.ofLargest <= SELF.ofLargest && self.along <= SELF.along,
    `${c.name}: this build's record on this build against ${BASE.version}'s on ${BASE.version}: ${JSON.stringify(self ?? [ob.status, mc.status])} (within ${JSON.stringify(SELF)})`);
  // the record written before: its covariance refused by name, its states flown as the base flies them
  const oc = covAt(cur, old);
  const out = {output: {EPOCHS: [iso(t0), iso(t0 + 86400000), iso(t0 + 2 * 86400000)], FRAME: pcfOutputFrame.GCRF}};
  const [pb, pc] = [await base.invoke({methodId: 'propagate', inputs: flight([old], out)}), await cur.invoke({methodId: 'propagate', inputs: flight([old], out)})];
  const bb = pb.statusCode === 0 ? statesOf(pb) : null, cb = pc.statusCode === 0 ? statesOf(pc) : null;
  const lines = cb ? cb.EPHEMERIS_DATA_LINES.length : 0;
  const statesM = bb && cb && lines === 3 && bb.EPHEMERIS_DATA_LINES.length === 3
    ? Math.max(...cb.EPHEMERIS_DATA_LINES.map((l, k) => 1000 * Math.hypot(l.X - bb.EPHEMERIS_DATA_LINES[k].X, l.Y - bb.EPHEMERIS_DATA_LINES[k].Y, l.Z - bb.EPHEMERIS_DATA_LINES[k].Z))) : NaN;
  Object.assign(row, {preFloorStatus: oc.status, preFloorStates: lines, preFloorStatesM: statesM, preFloorCovLines: cb?.COVARIANCE_MATRIX_LINES.length});
  check(oc.status === -7, `${c.name}: sdnap_covariance_at of ${BASE.version}'s record: ${oc.status}, expected -7`);
  check(statesM <= STATES_M && cb.COVARIANCE_MATRIX_LINES.length === 0 && String(cb.COMMENT ?? '').startsWith('cov-floor-at-theory-state:'),
    `${c.name}: propagate of ${BASE.version}'s record: ${pc.statusCode === 0 ? `${lines} states ${statesM} m from ${BASE.version}'s, ${cb.COVARIANCE_MATRIX_LINES.length} covariance lines, COMMENT ${cb.COMMENT}` : pc.errorCode}`);
  console.log(JSON.stringify(row));
}

// the stand-in moved some case's flown epoch state (at i 52.9; near the equator the caps leave the epoch state as it was)
check(standInMovedKm > MOVED_KM, `the stand-in moved no case's flown epoch state by more than ${MOVED_KM} km (${standInMovedKm})`);

// the gate reads PROVENANCE.PRODUCER exactly
const PRODUCERS = [['com.spacedatanetwork.sdn-ap-propagator 0.6.39', 0], ['com.spacedatanetwork.sdn-ap-propagator 0.6.99', 0],
  ['com.spacedatanetwork.sdn-ap-propagator 1.0.0', 0], ['com.spacedatanetwork.sdn-ap-propagator 0.6.38', -7],
  ['com.spacedatanetwork.sdn-ap-propagator 0.6.37', -7],
  ['com.spacedatanetwork.sdn-ap-propagator 0.6.39-rc1', -7], ['com.spacedatanetwork.sdn-ap-propagator 0.6.39.1', -7],
  ['com.spacedatanetwork.sdn-ap-propagator 0.6.39+x', -7], ['com.spacedatanetwork.sdn-ap-propagator 0.6', -7],
  ['org.example.other-propagator 1.0.0', -7], [null, -7]];
for (const [producer, want] of PRODUCERS) {
  const rec = repackOcm(producerRecord, (u) => { u.PROVENANCE.PRODUCER = producer; });
  const got = call(cur, 'sdnap_covariance_at', rec, 42, [0]).status;
  console.log(JSON.stringify({producer, status: got}));
  check(got === want, `PRODUCER ${JSON.stringify(producer)}: sdnap_covariance_at ${got}, expected ${want}`);
}

// the two-body state, bit for bit
const TWO_BODY_SETS = [{n: 15.5, e: 0.001, i: 51.6, raan: 40, argp: 30, ma: 20}, {n: 1.0027, e: 0.0002, i: 0.1, raan: 300, argp: 90, ma: 200},
  {n: 2.0, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10}];
const got = TWO_BODY_SETS.map((s) => {
  const r = call(cur, 'sdnap_test_two_body_state', seedOcm({epoch: iso(t0), ...s, bterm: 0.01, agom: 0.01, tesseral: 31, zonal: 20}), 6);
  return r.status === 0 ? r.out.map(hex) : [`status ${r.status}`];
});
console.log(JSON.stringify({twoBody: got}));
check(TWO_BODY !== null && JSON.stringify(got) === JSON.stringify(TWO_BODY), `the two-body state of the three sets: ${JSON.stringify(got)} against ${JSON.stringify(TWO_BODY)}`);

// the stored fixture record's mean elements are 0.6.36's fit's bit for bit
const fixture = (f) => new Uint8Array(fs.readFileSync(new URL(`fixtures/${f}`, import.meta.url)));
const [meNew, meOld] = [ocmOf(fixture('ap-fit-0.6.39.ocm')).MEAN_ELEMENTS, ocmOf(fixture('ap-fit-0.6.36.ocm')).MEAN_ELEMENTS];
const meFields = Object.keys(meOld).filter((k) => typeof meOld[k] === 'number' || typeof meOld[k] === 'string' || typeof meOld[k] === 'bigint');
const meDiffer = meFields.filter((k) => !Object.is(meNew[k], meOld[k]));
check(meFields.length >= 8 && meDiffer.length === 0, `ap-fit-0.6.39.ocm's MEAN_ELEMENTS against ap-fit-0.6.36.ocm's: ${meDiffer.join(', ')} differ (of ${meFields.length})`);
console.log(JSON.stringify({fixtureMeanElements: {fields: meFields.length, differ: meDiffer}}));

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('epoch floor E2E: PASS');
process.exit(0);
