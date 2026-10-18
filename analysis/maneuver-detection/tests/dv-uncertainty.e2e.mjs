// E2E: the impulse estimate of detect_maneuvers with the GP error model
// (analysis/gp-error-model data/e14-s3-kc.erm on error_model), through the
// built module, SGP4 (propagator/sgp4) answering the propagator query port.
//
// 1. Synthetic truth (tests/dv-mc-truth.json, written by study/dv-mc-truth.mjs):
//    500 known impulses inserted in FFM full-force trajectories, SGP4 element
//    sets fitted to them. Each RTN component of the truth must lie within
//    1 sigma of the estimate in at least 68 % of the trials and within 3 sigma
//    in at least 99 %, sigma from COV; an impulse not detected counts as outside.
// 2. The real Cosmos 2612 (NORAD 68762) and ICEYE-X36 (59103) window,
//    2026-09-28 to 2026-10-17, from the SDN GP archive (Space-Track GP history
//    on this machine, SDN_GP_ARCHIVE, default /opt/data/sdn-archive; element
//    sets are read here and never written). Cosmos 2612's events near Sep 30,
//    Oct 6-7, Oct 12 and Oct 15-16 must be detected with delta-V and sigma.
//
//   npm ci && npm run build && node tests/dv-uncertainty.e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadModule, sgp4Provider, ommStream, TYPES, outputsOf, queriesFrom, unpackMnv, seconds } from '../study/lib/host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ERM_TYPE = { schemaName: 'ERM.fbs', fileIdentifier: '$ERM', rootTypeName: 'ERM', wireFormat: 'flatbuffer' };
const model = { portId: 'error_model', payload: new Uint8Array(fs.readFileSync(path.join(here, '../../gp-error-model/data/e14-s3-kc.erm'))), typeRef: ERM_TYPE };
const detector = await loadModule('analysis/maneuver-detection');
const provider = await sgp4Provider();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// The detector over element-set rows (Space-Track field names) with the error model: the $MNV records, unpacked.
async function detect(rows) {
  const sets = { portId: 'element_sets', payload: ommStream(rows), typeRef: TYPES.OMM };
  const first = await detector.invoke('detect_maneuvers', [sets, { config: {} }]);
  const answers = await provider.answer(await queriesFrom(first), rows);
  const r = await detector.invoke('detect_maneuvers', [sets, model, { config: {} },
    ...answers.map((a) => ({ portId: 'propagation', payload: a, typeRef: TYPES.OEM }))]);
  return outputsOf(r, 'maneuvers').map(unpackMnv);
}
// UVW delta-V (m/s) and its 1-sigma from COV (the velocity block of the 6x6 upper triangle).
const UPPER = (r, c) => r * 6 - (r * (r - 1)) / 2 + (c - r);
const dvOf = (m) => ({ dv: [m.DELTA_VEL_U, m.DELTA_VEL_V, m.DELTA_VEL_W].map((x) => x * 1000),
  sigma: [3, 4, 5].map((k) => (m.COV?.length === 21 ? Math.sqrt(m.COV[UPPER(k, k)]) * 1000 : NaN)) });
const window = (m) => /burn window \(99\.73 %\): (\S+) to (\S+)\./.exec(m.DESCRIPTION ?? '')?.slice(1) ?? [];
const bound = (m) => /two-impulse delta-V in the bracket: ([0-9.]+) \+- ([0-9.]+) m\/s/.exec(m.DESCRIPTION ?? '')?.slice(1).map(Number) ?? [];
const chi2 = (m) => Number(/mismatch chi-square ([0-9.]+)/.exec(m.DESCRIPTION ?? '')?.[1]);
const speed = (m) => /magnitude: ([0-9.]+) \+- ([0-9.]+) m\/s/.exec(m.DESCRIPTION ?? '')?.slice(1).map(Number) ?? [];

// ── 1. synthetic truth ────────────────────────────────────────────────────────
const mc = JSON.parse(fs.readFileSync(path.join(here, 'dv-mc-truth.json'), 'utf8'));
const rowOf = (norad, set) => Object.fromEntries([['NORAD_CAT_ID', norad], ['OBJECT_ID', `SYN-${norad}`], ['OBJECT_NAME', `SYNTHETIC ${norad}`],
  ...mc.set_fields.map((f, i) => [f, set[i]])]);
const within = [[0, 0, 0], [0, 0, 0]];
let detected = 0, inWindow = 0, belowBound = 0, speedOne = 0, speedThree = 0;
const started = Date.now();
for (const [n, trial] of mc.trials.entries()) {
  const base = mc.bases[trial.base];
  const rows = [...base.sets.slice(0, trial.gap + 1), ...trial.post].map((s) => rowOf(base.norad, s));
  const lo = seconds(rows[trial.gap].EPOCH), hi = seconds(rows[trial.gap + 1].EPOCH), tb = seconds(trial.burn);
  const events = (await detect(rows)).filter((m) => { const t = seconds(m.EVENT_START_TIME); return t >= lo && t <= hi; });
  const m = events.sort((a, b) => Math.abs(seconds(a.EVENT_START_TIME) - tb) - Math.abs(seconds(b.EVENT_START_TIME) - tb))[0];
  if (!m || m.COV?.length !== 21) continue;
  ++detected;
  const { dv, sigma } = dvOf(m);
  for (let k = 0; k < 3; ++k) {
    const z = Math.abs(dv[k] - trial.dv_rtn_mps[k]) / sigma[k];
    if (z <= 1) ++within[0][k];
    if (z <= 3) ++within[1][k];
  }
  const [w0, w1] = window(m).map(seconds);
  if (tb >= w0 && tb <= w1) ++inWindow;
  const [b, bs] = bound(m);
  if (b <= Math.hypot(...trial.dv_rtn_mps) + 3 * bs) ++belowBound;
  const [s, ss] = speed(m), zs = Math.abs(s - Math.hypot(...trial.dv_rtn_mps)) / ss;
  if (zs <= 1) ++speedOne;
  if (zs <= 3) ++speedThree;
  if ((n + 1) % 100 === 0) process.stderr.write(`${n + 1}/${mc.trials.length} trials ${Math.round((Date.now() - started) / 1000)} s\n`);
}
const trials = mc.trials.length;
console.log(`synthetic truth: ${trials} impulses (FFM full force, SGP4 sets fitted to it), ${detected} detected with an impulse estimate`);
for (const [k, axis] of ['U radial', 'V in-track', 'W cross-track'].entries()) {
  const one = within[0][k] / trials, three = within[1][k] / trials;
  console.log(`  ${axis.padEnd(14)} within 1 sigma ${fmt(100 * one, 1)} % (>= 68), within 3 sigma ${fmt(100 * three, 1)} % (>= 99)`);
  check(one >= 0.68, `${axis}: ${fmt(100 * one, 1)} % within 1 sigma`);
  check(three >= 0.99, `${axis}: ${fmt(100 * three, 1)} % within 3 sigma`);
}
console.log(`  |dV| within 1 sigma ${fmt(100 * speedOne / trials, 1)} %, within 3 sigma ${fmt(100 * speedThree / trials, 1)} %; burn time inside the 99.73 % window ${fmt(100 * inWindow / trials, 1)} %;` +
  ` minimum two-impulse bound at or below |truth| + 3 sigma ${fmt(100 * belowBound / trials, 1)} %`);

// ── 2. the real window ────────────────────────────────────────────────────────
// One object's GP history from the archive's gp_history files (Space-Track field names), one set per EPOCH (the
// latest CREATION_DATE), as study/gp_history.py reads it.
function history(archive, norads, from) {
  const dir = path.join(archive, 'spacetrack/gp_history/by-creation', from.slice(0, 4));
  const latest = new Map(norads.map((n) => [n, new Map()]));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json.gz') && f.slice(0, 10) >= from).sort()) {
    for (const r of JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))))) {
      const sets = latest.get(Number(r.NORAD_CAT_ID));
      if (!sets || r.MEAN_ELEMENT_THEORY !== 'SGP4') continue;
      const held = sets.get(r.EPOCH);
      if (!held || (r.CREATION_DATE ?? '') >= (held.CREATION_DATE ?? '')) sets.set(r.EPOCH, r);
    }
  }
  return new Map([...latest].map(([n, sets]) => [n, [...sets.values()].sort((a, b) => (a.EPOCH < b.EPOCH ? -1 : 1))]));
}
const archive = process.env.SDN_GP_ARCHIVE ?? '/opt/data/sdn-archive';
check(fs.existsSync(path.join(archive, 'spacetrack/gp_history/by-creation/2026')), `no GP archive at ${archive} (set SDN_GP_ARCHIVE)`);
if (fs.existsSync(path.join(archive, 'spacetrack/gp_history/by-creation/2026'))) {
  const objects = history(archive, [68762, 59103], '2026-09-14');
  const windows = [['Sep 30', '2026-09-29T12:00Z', '2026-10-01T12:00Z'], ['Oct 6-7', '2026-10-06T00:00Z', '2026-10-08T00:00Z'],
    ['Oct 12', '2026-10-11T12:00Z', '2026-10-13T00:00Z'], ['Oct 15-16', '2026-10-15T00:00Z', '2026-10-17T00:00Z']];
  for (const [norad, name] of [[68762, 'COSMOS 2612'], [59103, 'ICEYE-X36']]) {
    const rows = objects.get(norad);
    const events = (await detect(rows)).filter((m) => m.EVENT_START_TIME >= '2026-09-28');
    console.log(`${name} (${norad}): ${rows.length} element sets from 2026-09-14, ${events.length} events from 2026-09-28`);
    for (const m of events) {
      const { dv, sigma } = dvOf(m);
      const [w0, w1] = window(m);
      const [s, ss] = speed(m), [b, bs] = bound(m);
      console.log(`  ${m.EVENT_START_TIME}  dV U ${fmt(dv[0])} ± ${fmt(sigma[0])}  V ${fmt(dv[1])} ± ${fmt(sigma[1])}  W ${fmt(dv[2])} ± ${fmt(sigma[2])}` +
        `  |dV| ${fmt(s)} ± ${fmt(ss)}  min two-impulse ${fmt(b)} ± ${fmt(bs)} m/s  window ${w0 ?? '-'} .. ${w1 ?? '-'}` +
        `  chi2 ${fmt(chi2(m), 1)}${/no burn time fits one impulse/.test(m.DESCRIPTION) ? ' (no single impulse fits: covariance scaled)' : ''}`);
    }
    if (norad !== 68762) continue;
    for (const [label, from, to] of windows) {
      const hit = events.find((m) => { const t = Date.parse(m.EVENT_START_TIME); return t >= Date.parse(from) && t <= Date.parse(to); });
      check(hit && dvOf(hit).sigma.every(Number.isFinite), `COSMOS 2612: no event with delta-V and sigma near ${label}`);
    }
  }
}

await detector.destroy();
if (failures.length) {
  console.log(`DV-UNCERTAINTY E2E FAIL\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('DV-UNCERTAINTY E2E PASS');
