#!/usr/bin/env node
// E2E (stack #564, SPEC 16.25): an AP flight ends at its decay crossing, refused by name, and no state before it changes.
// The rule, on the theory's own grid nodes: (a) more perigee radius lost over one revolution or over the grid's next step,
// whichever is longer, than one density scale height at the mean perigee; (b) a mean perigee height under 100 km.
// - Two decaying seeds (#564's: AP records 31/20 with the slow set and the solid tide, Jacchia 1970 on the fixture's constant
//   rows, epoch 2026-10-29; perigee 200 km, e 0.001, BTERM 0.01, and perigee 220 km, e 0.01, BTERM 0.1), `propagate` every
//   60 s for 4 days: the block stops before the crossing, its COMMENT "decayed:<time>; <n> epochs after it refused" and its
//   USEABLE_STOP_TIME the crossing; every state answered is 0.6.45's (modules b1a08e44) bit for bit; the jump detector (half
//   the fourth difference of the states at 60 s, less two-body) reads at most BOUND_M over them. A call asking only for
//   times past the crossing is refused `decayed:<time>`, the same time.
// - The same seeds in the epoch store (load_epochs, sdnap_epochs_set_at) every 10 min, in time order, reversed and shuffled,
//   each from a fresh load: every time before the crossing the same state to the bit in all three orders, every time past
//   it status 4. The crossing is the record's, not the call's.
// - Two sets that never reach the rule in 7 days (perigee 500 km near-circular; perigee 300 km at e 0.3, where drag takes the
//   apogee down and the perigee barely moves): `propagate` every 60 s for 7 days is 0.6.45's bit for bit, with no COMMENT.
// - sdnap_covariance_at of an AP record moved onto a decaying orbit (test/fixtures/ap-fit-0.6.42.ocm, its elements set to
//   perigee 200 km, e 0.001, BTERM 0.01, its s_d restated): status 4, NaN at every time past the record's crossing, every
//   time a day before it filled.
// JS only moves bytes and compares numbers the module produced.
//   node test/decay.e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fb from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { pcfOutputFrame } from 'spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js';
import { ensureBuilt, packageRoot, wasmPath } from './lib/module.mjs';
import { seedOcm, flight, rowsThrough, repackOcm, T } from './lib/ocm.mjs';
import { spwFixtureRows } from './lib/spw-constant.mjs';
import { scratchTemp } from './lib/scratch.mjs';

const BASE = { commit: 'b1a08e44', sha256: 'edc9b14b' };  // 0.6.45, the build before the rule
const MU = 398600.4418, RE = 6378.137, H = 60, BOUND_M = 4.5;
const epoch = '2026-10-29T00:00:00.000', t0 = Date.parse(epoch + 'Z');
const iso = (s) => new Date(t0 + s * 1000).toISOString().replace('Z', '');
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const fixture = spwFixtureRows();
const rows = rowsThrough(Array.isArray(fixture) ? fixture : fixture.rows);
const nOf = (hp, e) => { const a = (RE + hp) / (1 - e); return (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI); };
const seedOf = (c) => seedOcm({ epoch, n: nOf(c.hp, c.e), e: c.e, i: 55, raan: 40, argp: 90, ma: 0, bterm: c.bterm, norad: 99564, records: true, rows,
  tesseral: 31, zonal: 20, slow: true, solidTides: true });

ensureBuilt();
const modulesRoot = path.resolve(packageRoot, '../..');
const baseBytes = execFileSync('git', ['-C', modulesRoot, 'show', `${BASE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
check(crypto.createHash('sha256').update(baseBytes).digest('hex').startsWith(BASE.sha256), `0.6.45 at ${BASE.commit} is not ${BASE.sha256}`);
const scratch = scratchTemp('sdnap-decay-');
const basePath = path.join(scratch, 'module-0.6.45.wasm');
fs.writeFileSync(basePath, baseBytes);
const now = await createStandaloneHarness('browser', wasmPath, { surface: 'direct' });
const base = await createStandaloneHarness('browser', basePath, { surface: 'direct' });

const fly = async (h, seed, secs) => {
  const r = await h.invoke({ methodId: 'propagate', inputs: flight([seed], { output: { EPOCHS: secs.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  if (r.statusCode !== 0) return { error: r.errorCode };
  const b = OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
  return { comment: b.COMMENT, stop: b.USEABLE_STOP_TIME, lines: b.EPHEMERIS_DATA_LINES.map((l) => ({ epoch: l.EPOCH, s: [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] })) };
};
const msOf = (text) => Date.parse(text.endsWith('Z') ? text : `${text}Z`);
const sameBits = (a, b) => a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
const detector = (st) => {
  const d = [];
  for (let q = 1; q < st.length - 1; ++q) { const r = st[q], r3 = Math.hypot(...r) ** 3; d.push([0, 1, 2].map((z) => (st[q + 1][z] - 2 * r[z] + st[q - 1][z] + (H * H * MU * r[z]) / r3) * 1000)); }
  let worst = 0;
  for (let q = 1; q + 1 < d.length; ++q) worst = Math.max(worst, Math.hypot(...[0, 1, 2].map((z) => d[q][z] - 0.5 * (d[q - 1][z] + d[q + 1][z]))));
  return worst;
};
// the epoch store: a fresh load, then sdnap_epochs_set_at at the given seconds in the given order (rc, state)
const storeFly = async (h, seed, secs) => {
  const x = h.instance.exports;
  const r = await h.invoke({ methodId: 'load_epochs', inputs: [{ portId: 'ocm', typeRef: T('OCM'), payload: seed }] });
  if (r.statusCode !== 0) return { error: `${r.errorCode}: ${r.errorMessage}` };
  const out = x.sdnap_alloc(48), got = new Map();
  for (const s of secs) {
    const d = (t0 + s * 1000) / 86400000, w = Math.floor(d) + 2440587.5;
    const rc = x.sdnap_epochs_set_at(0, 0, w, d - Math.floor(d), out);
    got.set(s, { rc, s: rc === 0 ? Array.from(new Float64Array(h.memory.buffer, out, 6)) : null });
  }
  x.sdnap_free(out);
  return { got };
};

const SEEDS = [{ name: 'perigee 200 km, e 0.001, BTERM 0.01', hp: 200, e: 0.001, bterm: 0.01 }, { name: 'perigee 220 km, e 0.01, BTERM 0.1', hp: 220, e: 0.01, bterm: 0.1 }];
for (const c of SEEDS) {
  const seed = seedOf(c);
  const secs = Array.from({ length: (4 * 86400) / H + 1 }, (_, j) => j * H);
  const f = await fly(now, seed, secs);
  const m = /^decayed:(\S+); (\d+) epochs after it refused$/.exec(f.comment ?? '');
  check(!!m, `${c.name}: the block's COMMENT is ${JSON.stringify(f.comment ?? f.error)}, not decayed:<time>; <n> epochs after it refused`);
  if (!m) continue;
  const cross = m[1], crossMs = msOf(cross);
  check(f.stop === cross, `${c.name}: USEABLE_STOP_TIME ${f.stop}, the crossing ${cross}`);
  check(f.lines.length + Number(m[2]) === secs.length, `${c.name}: ${f.lines.length} answered and ${m[2]} refused of ${secs.length}`);
  check(f.lines.every((l) => msOf(l.epoch) < crossMs), `${c.name}: an answered epoch at or past the crossing`);
  const b = await fly(base, seed, secs.slice(0, f.lines.length));
  check(!!b.lines && b.lines.every((l, k) => sameBits(l.s, f.lines[k].s)), `${c.name}: a state before the crossing differs from 0.6.45's (${b.error ?? ''})`);
  const worst = detector(f.lines.map((l) => l.s.slice(0, 3)));
  check(worst <= BOUND_M, `${c.name}: the jump detector reads ${worst.toFixed(3)} m before the crossing (at most ${BOUND_M} m)`);
  const after = await fly(now, seed, secs.filter((s) => t0 + s * 1000 > crossMs + 3600e3));
  check(after.error === `decayed:${cross}`, `${c.name}: a call past the crossing gives ${after.error ?? 'states'}, not decayed:${cross}`);
  // the epoch store, three orders, each from a fresh load
  const grid = Array.from({ length: (4 * 86400) / 600 + 1 }, (_, j) => j * 600);
  let seedRand = 12345;
  const rand = () => (seedRand = (seedRand * 1103515245 + 12345) % 2147483648) / 2147483648;
  const shuffled = [...grid];
  for (let k = shuffled.length - 1; k > 0; --k) { const j = Math.floor(rand() * (k + 1)); [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]]; }
  const orders = { time: await storeFly(now, seed, grid), reverse: await storeFly(now, seed, [...grid].reverse()), shuffled: await storeFly(now, seed, shuffled) };
  for (const [o, r] of Object.entries(orders)) {
    check(!r.error, `${c.name}: load_epochs (${o}) ${r.error}`);
    if (r.error) continue;
    for (const s of grid) {
      const q = r.got.get(s), past = t0 + s * 1000 > crossMs, ref = orders.time.got.get(s);
      if (past) check(q.rc === 4, `${c.name} (${o}): ${iso(s)} past the crossing gives status ${q.rc}, not 4`);
      else check(q.rc === 0 && sameBits(q.s, ref.s), `${c.name} (${o}): ${iso(s)} before the crossing gives status ${q.rc}${q.rc === 0 ? ', another state than in time order' : ''}`);
    }
  }
  // propagate_epochs (the epoch store's block): a crossing after the epoch with nothing answered after it is the block's usable stop,
  // never its usable start, and its COMMENT names the refused run; the states before it are the call's own
  {
    const pe = await now.invoke({ methodId: 'propagate_epochs', inputs: flight([seed], { output: { EPOCHS: grid.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
    check(pe.statusCode === 0, `${c.name}: propagate_epochs ${pe.errorCode}`);
    if (pe.statusCode === 0) {
      const b = OEM.getRootAsOEM(new fb.ByteBuffer(pe.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
      check(b.USEABLE_STOP_TIME === cross, `${c.name}: propagate_epochs USEABLE_STOP_TIME ${b.USEABLE_STOP_TIME}, the crossing ${cross}`);
      check(!b.USEABLE_START_TIME, `${c.name}: propagate_epochs USEABLE_START_TIME ${b.USEABLE_START_TIME}, none expected`);
      check(String(b.COMMENT ?? '').includes(`decayed:${cross}`), `${c.name}: propagate_epochs COMMENT ${b.COMMENT}`);
    }
  }
  console.log(`${c.name}: decayed at ${cross} (${((crossMs - t0) / 3600e3).toFixed(3)} h), ${f.lines.length} states answered and ${m[2]} refused; jump detector ${worst.toFixed(3)} m; lowest ${(Math.min(...f.lines.map((l) => Math.hypot(...l.s.slice(0, 3)))) - RE).toFixed(1)} km`);
}

// sets that never reach the rule in 7 days: bit for bit, no COMMENT
for (const c of [{ name: 'perigee 500 km, e 0.001, BTERM 0.01', hp: 500, e: 0.001, bterm: 0.01 }, { name: 'perigee 300 km, e 0.3, BTERM 0.01', hp: 300, e: 0.3, bterm: 0.01 }]) {
  const seed = seedOf(c), secs = Array.from({ length: (7 * 86400) / H + 1 }, (_, j) => j * H);
  const f = await fly(now, seed, secs), b = await fly(base, seed, secs);
  check(!!f.lines && !!b.lines && f.lines.length === secs.length && !f.comment && f.lines.every((l, k) => sameBits(l.s, b.lines[k].s)),
    `${c.name}: 7 days at 60 s are not 0.6.45's bit for bit (${f.error ?? f.comment ?? ''} | ${b.error ?? ''})`);
  console.log(`${c.name}: ${f.lines?.length ?? 0} states over 7 days, 0.6.45's bit for bit`);
}

// sdnap_covariance_at past a record's crossing
{
  const bytes = new Uint8Array(fs.readFileSync(fileURLToPath(new URL('fixtures/ap-fit-0.6.42.ocm', import.meta.url))));
  const moved = repackOcm(bytes, (o) => {
    o.MEAN_ELEMENTS.MEAN_MOTION = nOf(200, 0.001);
    o.MEAN_ELEMENTS.ECCENTRICITY = 0.001;
    o.MEAN_ELEMENTS.BTERM = 0.01;
    const cp = o.COV_PROPAGATION;
    cp.NOISE_NON_GRAVITATIONAL_RAD_DAY2 = cp.NON_GRAVITATIONAL_SHARE * Math.abs(cp.NON_GRAVITATIONAL_RATE_PER_DAY) * o.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI;
  });
  const r = await now.invoke({ methodId: 'propagate', inputs: flight([moved], { output: { EPOCHS: Array.from({ length: 4 * 24 * 6 + 1 }, (_, j) => new Date(Date.parse('2026-10-01T00:00:00Z') + j * 600e3).toISOString().replace('Z', '')), FRAME: pcfOutputFrame.GCRF } }) });
  const blk = r.statusCode === 0 ? OEM.getRootAsOEM(new fb.ByteBuffer(r.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0] : null;
  const cm = /^decayed:(\S+);/.exec(blk?.COMMENT ?? '');
  check(!!cm, `the moved record: no crossing in 4 days (${r.errorCode ?? blk?.COMMENT})`);
  if (cm) {
    const crossMin = (msOf(cm[1]) - Date.parse('2026-10-01T00:00:00Z')) / 60000;
    const x = now.instance.exports;
    const minutes = [60, crossMin - 1440, crossMin - 720, crossMin + 60, crossMin + 1440];
    const qo = x.sdnap_alloc(moved.length), qm = x.sdnap_alloc(8 * minutes.length), qout = x.sdnap_alloc(8 * 42 * minutes.length);
    new Uint8Array(now.memory.buffer, qo, moved.length).set(moved);
    new Float64Array(now.memory.buffer, qm, minutes.length).set(minutes);
    const status = x.sdnap_covariance_at(qo, moved.length, qm, minutes.length, qout);
    const got = Array.from(new Float64Array(now.memory.buffer, qout, 42 * minutes.length));
    x.sdnap_free(qo); x.sdnap_free(qm); x.sdnap_free(qout);
    check(status === 4, `sdnap_covariance_at across the crossing returns ${status}, not 4`);
    minutes.forEach((t, k) => {
      const row = got.slice(42 * k, 42 * k + 42);
      if (t > crossMin) check(row.every(Number.isNaN), `sdnap_covariance_at at ${t.toFixed(1)} min, past the crossing at ${crossMin.toFixed(1)}: not NaN`);
      else check(row.every(Number.isFinite), `sdnap_covariance_at at ${t.toFixed(1)} min, before the crossing at ${crossMin.toFixed(1)}: not filled`);
    });
    // sdnap_covariance_full_at gives the same codes: 4 across the crossing, every value of a time past it NaN
    {
      const fo = x.sdnap_alloc(moved.length), fm = x.sdnap_alloc(8 * minutes.length), fout = x.sdnap_alloc(8 * 200 * minutes.length);
      new Uint8Array(now.memory.buffer, fo, moved.length).set(moved);
      new Float64Array(now.memory.buffer, fm, minutes.length).set(minutes);
      const fstatus = x.sdnap_covariance_full_at(fo, moved.length, fm, minutes.length, fout);
      const fgot = Array.from(new Float64Array(now.memory.buffer, fout, 200 * minutes.length));
      x.sdnap_free(fo); x.sdnap_free(fm); x.sdnap_free(fout);
      check(fstatus === 4, `sdnap_covariance_full_at across the crossing returns ${fstatus}, not 4`);
      check(fgot.slice(0, 6).every(Number.isFinite), 'sdnap_covariance_full_at: the state before the crossing is not filled');
    }
    // the crossing a call with covariance names is the record's: another epoch list names the same one (SPEC 16.25)
    {
      const base0 = Date.parse('2026-10-01T00:00:00Z');
      const times = [30, crossMin - 2000, crossMin - 100, crossMin + 7, crossMin + 30000].map((m) => new Date(base0 + m * 60000).toISOString().replace('Z', ''));
      const r2 = await now.invoke({ methodId: 'propagate', inputs: flight([moved], { output: { EPOCHS: times, FRAME: pcfOutputFrame.GCRF } }) });
      const blk2 = r2.statusCode === 0 ? OEM.getRootAsOEM(new fb.ByteBuffer(r2.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0] : null;
      const cm2 = /^decayed:(\S+);/.exec(blk2?.COMMENT ?? '');
      check(!!cm2 && cm2[1] === cm[1], `a call with other epochs names the crossing ${cm2?.[1]}, the first call ${cm[1]}`);
      // this record's crossing with its covariance (a moved set's) is EARLIER than its own set's: the same record without its
      // COVARIANCE_DATA names the nominal's crossing, later; a call that names the earlier one has found the moved set's
      const bare = repackOcm(moved, (o) => { o.COVARIANCE_DATA = []; o.COV_PARAMETER_KINDS = []; o.COV_PARAMETERS = []; o.COV_UNITS = []; o.COV_PROPAGATION = null; });
      const rb = await now.invoke({ methodId: 'propagate', inputs: flight([bare], { output: { EPOCHS: [new Date(base0 + (crossMin + 7) * 60000).toISOString().replace('Z', '')], FRAME: pcfOutputFrame.GCRF } }) });
      const nb = /decayed:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)/.exec(`${rb.errorCode ?? ''}`);
      check(!!nb && msOf(nb[1]) > msOf(cm[1]), `the record without covariance names ${nb?.[1]}, not later than its crossing with covariance ${cm[1]}`);
      // a one-epoch list (past the crossing: the call is refused by name) names the same crossing, in propagate and in propagate_epochs
      const one = [new Date(base0 + (crossMin + 7) * 60000).toISOString().replace('Z', '')];
      const r1 = await now.invoke({ methodId: 'propagate', inputs: flight([moved], { output: { EPOCHS: one, FRAME: pcfOutputFrame.GCRF } }) });
      check(r1.statusCode !== 0 && `${r1.errorCode}`.includes(`decayed:${cm[1]}`), `a one-epoch list names ${r1.errorCode}, the crossing ${cm[1]}`);
      const r4 = await now.invoke({ methodId: 'propagate_epochs', inputs: flight([moved], { output: { EPOCHS: one, FRAME: pcfOutputFrame.GCRF } }) });
      check(r4.statusCode !== 0 && `${r4.errorCode}`.includes(`decayed:${cm[1]}`), `propagate_epochs on a one-epoch list names ${r4.errorCode ?? 'a block'}, the crossing ${cm[1]}`);
      const r3 = await now.invoke({ methodId: 'propagate_epochs', inputs: flight([moved], { output: { EPOCHS: times, FRAME: pcfOutputFrame.GCRF } }) });
      const blk3 = r3.statusCode === 0 ? OEM.getRootAsOEM(new fb.ByteBuffer(r3.outputs.find((o) => o.portId === 'ephemeris').payload)).unpack().EPHEMERIS_DATA_BLOCK[0] : null;
      check(String(blk3?.COMMENT ?? '').includes(`decayed:${cm[1]}`), `propagate_epochs on the same list names ${blk3?.COMMENT ?? r3.errorCode}, the crossing ${cm[1]}`);
    }
    console.log(`the moved record decays at ${cm[1]}; sdnap_covariance_at status ${status}`);
  }
  // a wide record (e 0.4 to 0.7) with covariance whose crossing falls in the last fifth of a 48 h interval (searched over perigee, e and
  // BTERM): sdnap_covariance_at at three times in that last fifth before the crossing returns 0 with every value filled. The moved
  // sets of such a record take the shared output branch and do not reach the wide-node code, so this asserts the answer, not that
  // branch: the owner's-crossing line for a copy anchored to another set's grid is reached only by the covariance's fallback evaluation
  {
    const base0 = Date.parse('2026-10-01T00:00:00Z');
    let found = null;
    const grid = [];
    for (const wide of [{ hp: 110, e: 0.7 }, { hp: 110, e: 0.5 }, { hp: 120, e: 0.6 }, { hp: 105, e: 0.4 }])
      for (let kb = 0; kb < 60; ++kb) grid.push({ ...wide, bt: Math.round((0.04 + 0.025 * kb) * 1000) / 1000 });
    for (const gp of grid) {
      if (found) break;
      const bt = gp.bt;
      const w = repackOcm(bytes, (o) => {
        o.MEAN_ELEMENTS.MEAN_MOTION = nOf(gp.hp, gp.e);
        o.MEAN_ELEMENTS.ECCENTRICITY = gp.e;
        o.MEAN_ELEMENTS.BTERM = bt;
        const cp = o.COV_PROPAGATION;
        cp.NOISE_NON_GRAVITATIONAL_RAD_DAY2 = cp.NON_GRAVITATIONAL_SHARE * Math.abs(cp.NON_GRAVITATIONAL_RATE_PER_DAY) * o.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI;
      });
      const rw = await now.invoke({ methodId: 'propagate', inputs: flight([w], { output: { EPOCHS: ['2026-10-12T00:00:00.000'], FRAME: pcfOutputFrame.GCRF } }) });
      const mw = /decayed:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)/.exec(`${rw.errorCode ?? ''}`);
      if (!mw) continue;
      const crossMinW = (msOf(mw[1]) - base0) / 60000;
      const phase = (crossMinW / (48 * 60)) % 1;
      if (phase > 0.82) { found = { w, crossMinW, bt }; break; }
    }
    check(!!found, 'a wide record with covariance whose crossing falls in the last fifth of its interval');
    if (found) {
      const x = now.instance.exports;
      const minutes = [found.crossMinW - 120, found.crossMinW - 30, found.crossMinW - 2];
      const qo = x.sdnap_alloc(found.w.length), qm = x.sdnap_alloc(8 * minutes.length), qout = x.sdnap_alloc(8 * 42 * minutes.length);
      new Uint8Array(now.memory.buffer, qo, found.w.length).set(found.w);
      new Float64Array(now.memory.buffer, qm, minutes.length).set(minutes);
      const st = x.sdnap_covariance_at(qo, found.w.length, qm, minutes.length, qout);
      const got = Array.from(new Float64Array(now.memory.buffer, qout, 42 * minutes.length));
      x.sdnap_free(qo); x.sdnap_free(qm); x.sdnap_free(qout);
      check(st === 0 && got.every(Number.isFinite), `a wide record with covariance (BTERM ${found.bt}, crossing at ${found.crossMinW.toFixed(1)} min): sdnap_covariance_at before the crossing returns ${st}, not 0 with every value filled`);
      console.log(`the wide record with covariance (BTERM ${found.bt}) crosses at ${(found.crossMinW / 60).toFixed(2)} h; its covariance at three times in the last fifth before it: status ${st}`);
    }
  }
  // a record with covariance whose epoch already meets the rule is decayed at every time, named so
  {
    const dead = repackOcm(bytes, (o) => {
      o.MEAN_ELEMENTS.MEAN_MOTION = nOf(40, 0.001);
      o.MEAN_ELEMENTS.ECCENTRICITY = 0.001;
      o.MEAN_ELEMENTS.BTERM = 0.01;
      const cp = o.COV_PROPAGATION;
      cp.NOISE_NON_GRAVITATIONAL_RAD_DAY2 = cp.NON_GRAVITATIONAL_SHARE * Math.abs(cp.NON_GRAVITATIONAL_RATE_PER_DAY) * o.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI;
    });
    const rd = await now.invoke({ methodId: 'propagate', inputs: flight([dead], { output: { EPOCHS: ['2026-10-01T06:00:00.000', '2026-10-02T00:00:00.000'], FRAME: pcfOutputFrame.GCRF } }) });
    check(rd.statusCode !== 0 && /^decayed:/.test(rd.errorCode ?? ''), `an epoch-decayed record with covariance: ${rd.statusCode === 0 ? 'answered' : rd.errorCode}, not decayed:<epoch>`);
    const x = now.instance.exports;
    const qo = x.sdnap_alloc(dead.length), qm = x.sdnap_alloc(16), qout = x.sdnap_alloc(8 * 42 * 2);
    new Uint8Array(now.memory.buffer, qo, dead.length).set(dead);
    new Float64Array(now.memory.buffer, qm, 2).set([60, 1440]);
    const st = x.sdnap_covariance_at(qo, dead.length, qm, 2, qout);
    const vals = Array.from(new Float64Array(now.memory.buffer, qout, 84));
    x.sdnap_free(qo); x.sdnap_free(qm); x.sdnap_free(qout);
    check(st === 4 && vals.every(Number.isNaN), `sdnap_covariance_at of an epoch-decayed record returns ${st} (4 expected) with NaN`);
  }
}

await now.close?.();
await base.close?.();
fs.rmSync(scratch, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('decay E2E: PASS');
process.exit(0);
