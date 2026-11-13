#!/usr/bin/env node
// The own-fit identity reference is the fixed added-zonal-term artifact at 3a5fb74c: the added terms move the five
// reference fits by up to 10.906312 m / 12.294643 mm/s when both fits fly on this build at daily epochs over seven
// days; historical floor-cure controls and every bound are retained.
// E2E (SPEC 12.4, stack #551): an AP record's epoch floor is put on by the writer and taken off by the reader at the two-body
// state of the record's own mean elements, so no change to a theory's epoch state moves what a reader takes off; an AP record
// written before that has its covariance refused by name and its states fly.
// Per case, an AP set (NRLMSISE-00 on the fixture rows; caps 31 and 20, or both 0) is flown 24 h at 600 s in GCRF by BASE, and
// that arc fitted by BASE and by this build. BASE is a build before the cure whose theory is this build's: from the low
// table's fast side (stack #477, SPEC 16.1) its first build with the band guard (git 258d824d, version string 0.6.36, its
// SHA-256 checked). It must be: a pre-cure record's states are held against the base's flight of them to 1 mm (a set's own
// flight is held against SELF_BASE, below), and the fast side moves a low-table set's states from 0.6.38's (git f8fd3240, wasm
// 1933b5da, the base until then): each case's arc fitted by 0.6.38 and that record flown at 0, 24 and 48 h by 0.6.38 and by
// 0.6.42 (git b7a7191e, wasm f771420f; 258d824d and the final 0.6.42, git 61048ba9, wasm 3c389abf, read the same) is at most 37.95 m apart at 300 km, i 5, 20.76 m at
// 1,200 km, i 0.5 and 8.89 m at 550 km, i 52.9 (main 0.6.39, git 94351f34, wasm 7a857d63: within 0.1 mm of 0.6.38's).
// The refusal is also read on a record main wrote: each case's arc
// fitted by 0.6.38 (MAIN, SHA-256 checked) and flown here has its covariance refused by name and its states flown.
// From 0.6.43 (the zonal theory's constant radial term, SPEC 16.23, which moves a set with gravity terms by meters) a
// pre-cure record's states are held against this build's flight of the same record with PRODUCER 0.6.39, which flies its
// covariance, and each arc is fitted also by 0.6.39 (CURE, git 94351f34, the rule's release, SHA-256 checked) for the
// check across a theory change.
// - The cure (a reader whose theory's epoch state differs from the writer's): this build's record read again with its
//   gravity caps moved from 31 and 20 to 12 and 6, so its flown epoch state moves and the two-body state of its mean
//   elements does not (at i 52.9 by 31 m; near the equator the caps leave the epoch state as it was, and one case must
//   move by more than MOVED_KM). The epoch covariance less the floor the reader takes off (sdnap_test_epoch_floor) is the
//   same bit for bit; and on both, at minute 0, P(0) less the floor at the flown state equals that remainder within
//   IDENTITY of P(0)'s largest entry.
// - A set's own flight is as it was: this build's record flown by this build against another build's record of the same
//   arc flown by that build, sdnap_covariance_at hourly to 48 h, within SELF; from 0.6.45 the other build's record carries
//   this build's drag share and s_d (restated: 0.6.45 multiplies a strong-drag record's share, SPEC 12.5, stack #568).
//   - The cure's property (a pre-cure build's own flight equals the cured build's) is held where this change moves neither
//     the theory nor the floor: the case at caps 0 (no gravity terms, so no radial term) against BASE. Through 0.6.42 the
//     case at caps 12 and 12 (no fast side, no radial floor factor) was held against MAIN, main's own pre-cure release
//     (measured on 0.6.42: 2.7e-14 and 5.4e-13 of a time's largest entry, the along-track variance 2.8e-14 and 1.3e-12
//     relative); from 0.6.43 the radial term moves it, so it is held against SELF_BASE with the caps-31/20 cases.
//   - The cases with gravity terms hold only the build-to-build identity, against SELF_BASE: from 0.6.43 the radial term's
//     first build on 0.6.42 (git a5293c54, wasm f33e071f, SHA-256 checked); through 0.6.42, 0.6.42's first build with
//     its radial floor factor exp(0.095) (git b7a7191e, wasm f771420f). They must: the low table's records
//     take that factor in the DRAG regime (SPEC 12.5), BASE carries exp(0.10), which moves them by 2.83e-3 to 4.31e-3 of a
//     time's largest entry (printed), and no build before the cure carries exp(0.095). Across the cure itself they were held
//     to 1e-11 between the fast side's builds before and after it (258d824d and 9855dadd, both at exp(0.10)).
// - Across a theory change (from 0.6.43, the case that found stack #551): 0.6.39's record flown by this build against
//   0.6.39's flight of it, sdnap_covariance_at hourly to 48 h, within ACROSS, 1e-3 (measured on this test's cases: up
//   to 2.1e-4 of a time's largest entry and in along-track variance, at 1,200 km and i 0.5, an arc this fit does not
//   reach exactly; 0 at caps 0, which carry no term; over seven cases fitted to zero residual, under 1.5e-4 on 0.6.42
//   and with the term on it). The fault it guards was 0.1 and up (0.6.36's records under the term came out negative or
//   85 times too narrow), so the bound is about five times the largest measured and a hundred times under the fault.
// - Caps 0 (an AP set without gravity terms): this build's record flies its covariance with the floor at the two-body
//   state (one rule for every AP record), and BASE's has it refused.
// - BASE's record on this build: sdnap_covariance_at -7; propagate status 0, its three states within STATES_M of this
//   build's flight of the same record with PRODUCER 0.6.39, which flies its covariance (a flight without covariance takes
//   the state path, one with it the covariance's nominal: they part by about 0.3 mm on any build; through 0.6.42 against
//   BASE's own flight of it), no covariance lines, the block's COMMENT naming cov-floor-at-theory-state.
// - The gate reads PROVENANCE.PRODUCER exactly: this module at 0.6.39 or later as X.Y.Z accepted, anything else refused
//   (0.6.38, a release on main, writes its floor at the theory state).
// - The remainder is the hook's (sdnap_test_epoch_floor computes it from the record alone, at the state the reader's own
//   choice gives: cov::epoch_floor_at); the reader's P(0) is tied to it by the identity at minute 0.
// - The two-body state (twobody::state_of through epoch_floor_state) of three element sets bit for bit (TWO_BODY): every
//   record written from 0.6.39 on carries its floor at it, so it must never move; a change to it refuses no record and
//   moves every later reader's floor.
// - 0.6.39's fit of the 0.4.0 inputs (ap-fit-0.6.39.ocm, the stored record of 0.6.39 to 0.6.41, written by the epoch
//   floor's build at 0.6.39) has 0.6.36's fit's mean elements bit for bit.
// Cases: 300 km at i 5 and 1,200 km at i 0.5 (where 0.6.36's records read by a later theory came out narrowest, or with a
// negative along-track variance: stack #551), 550 km at i 52.9 (the fixture's orbit, where they came out wider), 300 km
// at i 5 with caps 0, and 550 km at i 52.9 with caps 12 and 12.
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
const MAIN = {version: '0.6.38', commit: 'f8fd3240fe360f7b7649e9daf9e4d7b09ba21bd0', sha256: '1933b5da4d2c3c4bca644a9f88e43584d85b8f6f455762879294a8cf1a66c75b'};
const SELF_BASE = { version: '0.6.48', commit: '3a5fb74c8e12f825160eea58624dbc85a2cbacc5', sha256: 'b2de5af7e03753e57aebf781c49c824552706a16c563ca60b1dbb71d1a2358c6' };
const CURE = {version: '0.6.39', commit: '94351f345a32c659e0beec0d87dfb14100e2ea23', sha256: '7a857d632d044cd3830456cdcb8fbac5cb95a201087a417c530773f2e0bc295a'};
const SELF = {ofLargest: 1e-11, along: 1e-10}, ACROSS = {ofLargest: 1e-3, along: 1e-3}, STATES_M = 0.001, MOVED_KM = 1e-4, IDENTITY = 1e-12;
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
const mainBytes = execFileSync('git', ['-C', modules, 'show', `${MAIN.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26});
assert.equal(createHash('sha256').update(mainBytes).digest('hex'), MAIN.sha256, `${MAIN.version} sha256`);
const mainPath = path.join(scratchTemp('sdn-ap-epoch-floor-main-'), `sdn-ap-${MAIN.version}.wasm`);
fs.writeFileSync(mainPath, mainBytes);
const mainH = await createStandaloneHarness('browser', mainPath, {surface: 'direct'});
const selfBytes = execFileSync('git', ['-C', modules, 'show', `${SELF_BASE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26});
assert.equal(createHash('sha256').update(selfBytes).digest('hex'), SELF_BASE.sha256, `${SELF_BASE.version} (${SELF_BASE.commit.slice(0, 8)}) sha256`);
const selfPath = path.join(scratchTemp('sdn-ap-epoch-floor-self-'), `sdn-ap-${SELF_BASE.version}.wasm`);
fs.writeFileSync(selfPath, selfBytes);
const selfH = await createStandaloneHarness('browser', selfPath, {surface: 'direct'});
const cureBytes = execFileSync('git', ['-C', modules, 'show', `${CURE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], {maxBuffer: 1 << 26});
assert.equal(createHash('sha256').update(cureBytes).digest('hex'), CURE.sha256, `${CURE.version} (${CURE.commit.slice(0, 8)}) sha256`);
const curePath = path.join(scratchTemp('sdn-ap-epoch-floor-cure-'), `sdn-ap-${CURE.version}.wasm`);
fs.writeFileSync(curePath, cureBytes);
const cureH = await createStandaloneHarness('browser', curePath, {surface: 'direct'});

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

// `own`: whose own record and flight a case's own flight is held against (SELF), within SELF: 'self' SELF_BASE (the
// build-to-build identity), 'base' BASE and 'main' MAIN (pre-cure builds: the cure's property)
const CASES = [
  {name: '300 km, i 5', hp: 300, i: 5, caps: [31, 20], own: 'self'}, {name: '1,200 km, i 0.5', hp: 1200, i: 0.5, caps: [31, 20], own: 'self'},
  {name: '550 km, i 52.9', hp: 550, i: 52.9, caps: [31, 20], own: 'self'}, {name: '300 km, i 5, caps 0', hp: 300, i: 5, caps: [0, 0], own: 'base'},
  {name: '550 km, i 52.9, caps 12 and 12', hp: 550, i: 52.9, caps: [12, 12], own: 'self'},
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
  // a set's own flight is as it was, against the case's `own` build (and against BASE, printed)
  const ownH = c.own === 'main' ? mainH : c.own === 'base' ? base : selfH;
  const ownName = c.own === 'main' ? `${MAIN.version} (${MAIN.commit.slice(0, 8)})` : c.own === 'base' ? `${BASE.version} (${BASE.commit.slice(0, 8)})` : `${SELF_BASE.version} (${SELF_BASE.commit.slice(0, 8)})`;
  // 0.6.45 (SPEC 12.5, stack #568) states another drag share on a strong-drag record of the fast side, the same fit: the own
  // build's record with its share and s_d restated as this build's record states them, so the identity is of the fit, the
  // floor and the flight
  const restated = (bytes) => repackOcm(bytes, (u) => {
    const f = ocmOf(mine).COV_PROPAGATION;
    u.COV_PROPAGATION.NON_GRAVITATIONAL_SHARE = f.NON_GRAVITATIONAL_SHARE;
    u.COV_PROPAGATION.NOISE_NON_GRAVITATIONAL_RAD_DAY2 = f.NOISE_NON_GRAVITATIONAL_RAD_DAY2;
  });
  const [ob, os, mc] = [covAt(base, old), covAt(ownH, c.own === 'base' ? old : restated(await fitBy(ownH))), covAt(cur, mine)];
  const self = os.status === 0 && mc.status === 0 ? apart(os.out, mc.out) : null;
  row.self = {against: ownName, ...self};
  row.selfAgainstBase = ob.status === 0 && mc.status === 0 ? apart(ob.out, mc.out) : null;
  check(self && self.ofLargest <= SELF.ofLargest && self.along <= SELF.along,
    `${c.name}: this build's record on this build against ${ownName}'s on it: ${JSON.stringify(self ?? [os.status, mc.status])} (within ${JSON.stringify(SELF)})`);
  // across a theory change: the rule's release's record on this build against that release's flight of it
  const cured = await fitBy(cureH), [cc, ccm] = [covAt(cureH, cured), covAt(cur, cured)];
  const across = cc.status === 0 && ccm.status === 0 ? apart(cc.out, ccm.out) : null;
  row.across = across;
  check(across && across.ofLargest <= ACROSS.ofLargest && across.along <= ACROSS.along,
    `${c.name}: ${CURE.version}'s record on this build against ${CURE.version}'s flight of it: ${JSON.stringify(across ?? [cc.status, ccm.status])} (within ${JSON.stringify(ACROSS)})`);
  // the record written before: its covariance refused by name, its states flown as the same record relabeled 0.6.39 flies
  // them
  const oc = covAt(cur, old);
  const out = {output: {EPOCHS: [iso(t0), iso(t0 + 86400000), iso(t0 + 2 * 86400000)], FRAME: pcfOutputFrame.GCRF}};
  const relabeled = repackOcm(old, (u) => { u.PROVENANCE.PRODUCER = `com.spacedatanetwork.sdn-ap-propagator ${CURE.version}`; });
  const [pb, pc] = [await cur.invoke({methodId: 'propagate', inputs: flight([relabeled], out)}), await cur.invoke({methodId: 'propagate', inputs: flight([old], out)})];
  const bb = pb.statusCode === 0 ? statesOf(pb) : null, cb = pc.statusCode === 0 ? statesOf(pc) : null;
  const lines = cb ? cb.EPHEMERIS_DATA_LINES.length : 0;
  const statesM = bb && cb && lines === 3 && bb.EPHEMERIS_DATA_LINES.length === 3
    ? Math.max(...cb.EPHEMERIS_DATA_LINES.map((l, k) => 1000 * Math.hypot(l.X - bb.EPHEMERIS_DATA_LINES[k].X, l.Y - bb.EPHEMERIS_DATA_LINES[k].Y, l.Z - bb.EPHEMERIS_DATA_LINES[k].Z))) : NaN;
  Object.assign(row, {preFloorStatus: oc.status, preFloorStates: lines, preFloorStatesM: statesM, preFloorCovLines: cb?.COVARIANCE_MATRIX_LINES.length});
  check(oc.status === -7, `${c.name}: sdnap_covariance_at of ${BASE.version}'s record: ${oc.status}, expected -7`);
  check(statesM <= STATES_M && cb.COVARIANCE_MATRIX_LINES.length === 0 && String(cb.COMMENT ?? '').startsWith('cov-floor-at-theory-state:'),
    `${c.name}: propagate of ${BASE.version}'s record: ${pc.statusCode === 0 ? `${lines} states ${statesM} m from the relabeled record's, ${cb.COVARIANCE_MATRIX_LINES.length} covariance lines, COMMENT ${cb.COMMENT}` : pc.errorCode}`);
  // the record main wrote (0.6.38): refused by name here, its states flown
  const m38 = await fitBy(mainH), mo = covAt(cur, m38);
  const pm = await cur.invoke({methodId: 'propagate', inputs: flight([m38], out)}), cm = pm.statusCode === 0 ? statesOf(pm) : null;
  row.mainRecord = {covarianceAt: mo.status, propagate: pm.statusCode, states: cm?.EPHEMERIS_DATA_LINES.length, covLines: cm?.COVARIANCE_MATRIX_LINES.length};
  check(mo.status === -7 && cm && cm.EPHEMERIS_DATA_LINES.length === 3 && cm.COVARIANCE_MATRIX_LINES.length === 0 && String(cm.COMMENT ?? '').startsWith('cov-floor-at-theory-state:'),
    `${c.name}: ${MAIN.version}'s record on this build: ${JSON.stringify(row.mainRecord)}, COMMENT ${cm?.COMMENT} (refused by name, its states flown)`);
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
