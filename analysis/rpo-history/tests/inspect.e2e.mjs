#!/usr/bin/env node
// E2E (rpo-inspection-geometry-20261018): analysis/rpo-history `inspect` on
// synthetic trajectories whose answers are known in closed form.
//
//   1. phase angle and the Sun's angle from the line of sight: chaser, target
//      and Sun at chosen geometry (0, 90 and 180 deg cases);
//   2. Earth shadow: sunlit, umbra and a pass through the penumbra, against this
//      file's own conical-shadow oracle (Montenbruck & Gill 2000, 3.4.2) at
//      every sample, and the umbra/penumbra boundaries against the cone
//      geometry;
//   3. line of sight: blocked through the Earth, clear above the limb;
//   4. the radar field of regard: a target on an equatorial circular orbit
//      (along-track +y, nadir -x, right -z), chasers placed at given off-nadir
//      and clock angles inside and just outside the look band and the
//      azimuth beam; the derived wavelength, beamwidths and look angles
//      against their definitions (ICEYE's public figures as the inputs:
//      9.65 GHz, 3.2 x 0.4 m, Strip incidence 15-35 deg);
//   5. arcs: two chaser blocks overlapping in time: every sample takes the
//      block that starts latest, never a blend;
//   6. the record: $OCM RPO_INSPECTION, the COLUMNS it names, the grid.
// The oracles here are test code only (conformance tooling).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '..');
const standards = path.dirname(createRequire(path.join(MODULE, 'package.json')).resolve('spacedatastandards.org/package.json'));
const flatbuffers = createRequire(path.join(standards, 'package.json'))('flatbuffers');
const sds = async (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)).href);
const [OEM, OCM] = await Promise.all(['OEM', 'OCM'].map(sds));
const TYPE_OEM = { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' };

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
const T = (iso) => Date.parse(iso) / 1000;
const iso = (s) => new Date(Math.round(s * 1000)).toISOString();
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const angle = (a, b) => deg(Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (norm(a) * norm(b))))));
const RE = 6378.137, RS = 695700, AU = 149597870.7;

// One $OEM with one block per trajectory: lines of (epoch, state) at the given times.
function oem(blocks) {
  const m = new OEM.OEMT();
  m.CREATION_DATE = '2026-10-18T00:00:00.000Z';
  m.EPHEMERIS_DATA_BLOCK = blocks.map(({ norad = 0, objectId = '', states }) => {
    const b = new OEM.ephemerisDataBlockT();
    b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: norad, OBJECT_ID: objectId });
    b.CENTER_NAME = 'EARTH';
    b.TIME_SYSTEM = OEM.timingStandard.UTC;
    b.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: 'GCRF' });
    b.EPHEMERIS_DATA_LINES = states.map(({ t, s }) => {
      const l = new OEM.ephemerisDataLineT();
      l.EPOCH = iso(t);
      [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = s;
      return l;
    });
    return b;
  });
  const fb = new flatbuffers.Builder(1 << 16);
  OEM.OEM.finishOEMBuffer(fb, m.pack(fb));
  return fb.asUint8Array();
}
// A state held fixed (velocity given) at each time: geometry tests need positions only at the grid instants.
const fixed = (times, p, v = [0, 0, 0]) => times.map((t) => ({ t, s: [...p, ...v] }));

async function inspect(options, chaser, target, sun) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(MODULE, 'dist/isomorphic/module.wasm')),
    manifest: JSON.parse(fs.readFileSync(path.join(MODULE, 'plugin-manifest.json'), 'utf8')),
    surface: 'direct', hostOptions: { config: { inspect: options } },
  });
  try {
    const r = await harness.invoke({ methodId: 'inspect', inputs: [
      { portId: 'chaser', payload: oem(chaser), typeRef: TYPE_OEM },
      { portId: 'target', payload: oem(target), typeRef: TYPE_OEM },
      { portId: 'sun', payload: oem(sun), typeRef: TYPE_OEM },
    ] });
    if (r.statusCode !== 0) throw new Error(`inspect: ${r.errorCode}: ${r.errorMessage}`);
    const bytes = new Uint8Array(r.outputs.find((f) => f.portId === 'inspection').payload);
    const records = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at < bytes.length;) {
      const n = view.getUint32(at, true);
      records.push(OCM.OCM.getSizePrefixedRootAsOCM(new flatbuffers.ByteBuffer(bytes.slice(at, at + 4 + n))).unpack());
      at += 4 + n;
    }
    return records;
  } finally {
    await harness.destroy();
  }
}
const params = (rec) => Object.fromEntries(rec.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
function rowsOf(records) {
  const out = [];
  for (const rec of records) {
    const cols = params(rec).COLUMNS.split(','), w = rec.STATE_VECTOR_SIZE, t0 = T(rec.METADATA.START_TIME);
    for (let i = 0; i * w < rec.STATE_DATA.length; i++) {
      const row = { t: t0 + i * rec.STATE_STEP_SIZE };
      cols.forEach((c, k) => { row[c] = rec.STATE_DATA[i * w + k]; });
      out.push(row);
    }
  }
  return out;
}

// Oracle: the conical shadow function (Montenbruck & Gill 2000, eq. 3.79-3.82).
function shadowOracle(r, s) {
  const toSun = sub(s, r), dS = norm(toSun), dE = norm(r);
  const a = Math.asin(Math.min(1, RS / dS)), b = Math.asin(Math.min(1, RE / dE));
  const c = Math.acos(Math.max(-1, Math.min(1, -dot(r, toSun) / (dE * dS))));
  if (c >= a + b) return 1;
  if (c <= b - a) return 0;
  if (c <= a - b) return 1 - (b * b) / (a * a);
  const x = (c * c + a * a - b * b) / (2 * c), y = Math.sqrt(Math.max(0, a * a - x * x));
  const A = a * a * Math.acos(x / a) + b * b * Math.acos((c - x) / b) - c * y;
  return 1 - A / (Math.PI * a * a);
}

const t0 = T('2026-10-15T00:00:00Z');
const grid = (n, step = 60) => Array.from({ length: n }, (_, i) => t0 + i * step);
const SUN = [AU, 0, 0];
const base = { chaser: 'CHASER', target: 'TARGET', step_seconds: 60 };

// ── 1 + 3: phase angle, Sun angle, line of sight ───────────────────────────
{
  const times = grid(3);
  const target = [0, 7000, 0];
  const cases = [
    { name: 'chaser toward the Sun (phase 0)', chaser: add(target, [50, 0, 0]), phase: 0 },
    { name: 'chaser at right angles (phase 90)', chaser: add(target, [0, 0, 50]), phase: 90 },
    { name: 'chaser away from the Sun (phase 180)', chaser: add(target, [-50, 0, 0]), phase: 180 },
  ];
  for (const c of cases) {
    const rows = rowsOf(await inspect({ ...base, start: iso(times[0]), stop: iso(times.at(-1)) },
      [{ states: fixed(times, c.chaser) }], [{ states: fixed(times, target) }], [{ states: fixed(times, SUN) }]));
    const r = rows[0];
    const sunAngle = angle(sub(target, c.chaser), sub(SUN, c.chaser));
    check(`phase angle: ${c.name}`, Math.abs(r.PHASE_ANGLE_DEG - angle(sub(SUN, target), sub(c.chaser, target))) < 1e-9 &&
      Math.abs(r.PHASE_ANGLE_DEG - c.phase) < 0.01, { got: r.PHASE_ANGLE_DEG });
    check(`Sun from the line of sight: ${c.name}`, Math.abs(r.SUN_FROM_LINE_OF_SIGHT_DEG - sunAngle) < 1e-9, { got: r.SUN_FROM_LINE_OF_SIGHT_DEG, want: sunAngle });
    check(`range: ${c.name}`, Math.abs(r.RANGE_KM - 50) < 1e-9 && r.LINE_OF_SIGHT === 1 && r.TARGET_SUNLIT === 1, { range: r.RANGE_KM });
  }
  const blocked = rowsOf(await inspect({ ...base, start: iso(times[0]), stop: iso(times.at(-1)) },
    [{ states: fixed(times, [0, -7000, 0]) }], [{ states: fixed(times, target) }], [{ states: fixed(times, SUN) }]))[0];
  check('line of sight: through the Earth is blocked, and the lit-from-chaser column is 0', blocked.LINE_OF_SIGHT === 0 && blocked.TARGET_LIT_FROM_CHASER === 0, blocked);
  const limb = rowsOf(await inspect({ ...base, start: iso(times[0]), stop: iso(times.at(-1)) },
    [{ states: fixed(times, [6400, 7000, 0]) }], [{ states: fixed(times, [6400, -7000, 0]) }], [{ states: fixed(times, SUN) }]))[0];
  check('line of sight: a segment 6400 km from the center (above the 6378.137 km limb) is clear', limb.LINE_OF_SIGHT === 1, limb);
}

// ── 2: shadow across sunlit, penumbra and umbra ────────────────────────────
{
  // The target moves on a circle of 7000 km in the x-y plane through the anti-Sun side; one sample per 0.05 deg.
  const n = 1200, times = grid(n), r0 = 7000;
  const states = times.map((t, i) => {
    const u = rad(100 + i * 0.05);
    return { t, s: [r0 * Math.cos(u), r0 * Math.sin(u), 0, 0, 0, 0] };
  });
  const rows = rowsOf(await inspect({ ...base, start: iso(times[0]), stop: iso(times.at(-1)) },
    [{ states: states.map(({ t, s }) => ({ t, s: [s[0], s[1], 30, 0, 0, 0] })) }], [{ states }], [{ states: fixed(times, SUN) }]));
  let maxErr = 0, sawUmbra = false, sawPenumbra = false, sawLit = false;
  rows.forEach((row, i) => {
    const want = shadowOracle(states[i].s.slice(0, 3), SUN);
    maxErr = Math.max(maxErr, Math.abs(row.TARGET_SUNLIT - want));
    sawUmbra ||= row.TARGET_SUNLIT === 0;
    sawLit ||= row.TARGET_SUNLIT === 1;
    sawPenumbra ||= row.TARGET_SUNLIT > 0 && row.TARGET_SUNLIT < 1;
  });
  check("shadow: the target's shadow function equals the conical oracle at every sample (1e-12)", maxErr < 1e-12 && rows.length === n, { maxErr, samples: rows.length });
  check('shadow: the pass crosses sunlit, penumbra and umbra', sawLit && sawPenumbra && sawUmbra, { sawLit, sawPenumbra, sawUmbra });
  // Umbra entry: where the apparent separation of the Sun from the Earth's center reaches b - a.
  const pos = (uDeg) => [r0 * Math.cos(rad(uDeg)), r0 * Math.sin(rad(uDeg)), 0];
  const edge = (uDeg) => {
    const p = pos(uDeg), a = Math.asin(RS / norm(sub(SUN, p))), b = Math.asin(RE / norm(p));
    return angle(mul(p, -1), sub(SUN, p)) - deg(b - a);
  };
  const firstUmbra = rows.findIndex((row) => row.TARGET_SUNLIT === 0);
  const u = 100 + firstUmbra * 0.05;
  check('shadow: umbra begins where the apparent separation reaches b - a', firstUmbra > 0 && edge(u) <= 1e-9 && edge(u - 0.05) > 0, { entryDeg: u, edge: edge(u), before: edge(u - 0.05) });
}

// ── 4: the radar field of regard ───────────────────────────────────────────
{
  const times = grid(2), r = 6928.137, v = 7.585;
  const target = [r, 0, 0], vel = [0, v, 0];   // along-track +y, nadir -x, right -z
  const radarOptions = { sar_frequency_ghz: 9.65, sar_antenna_length_m: 3.2, sar_antenna_height_m: 0.4, sar_incidence_min_deg: 15,
    sar_incidence_max_deg: 35, sar_source: 'ICEYE product specification 6.0.8 (synthetic test inputs)' };
  const lambda = 299792458 / 9.65e9;
  const azHalf = deg(0.886 * lambda / 3.2) / 2;
  const lookLo = deg(Math.asin((RE / r) * Math.sin(rad(15)))), lookHi = deg(Math.asin((RE / r) * Math.sin(rad(35))));
  // A chaser 100 km from the target at off-nadir `off` and clock `clock` (from +y toward -z).
  const at = (off, clock) => {
    const nadir = [-1, 0, 0], along = [0, 1, 0], right = [0, 0, -1];
    const d = add(mul(nadir, Math.cos(rad(off))), add(mul(along, Math.sin(rad(off)) * Math.cos(rad(clock))), mul(right, Math.sin(rad(off)) * Math.sin(rad(clock)))));
    return add(target, mul(d, 100));
  };
  const cases = [
    { name: 'inside the right band', off: 25, clock: 90, right: 1, left: 0 },
    { name: 'inside the left band', off: 25, clock: 270, right: 0, left: 1 },
    { name: 'below the look band', off: lookLo - 0.01, clock: 90, right: 0, left: 0 },
    { name: 'above the look band', off: lookHi + 0.01, clock: 90, right: 0, left: 0 },
    { name: 'inside the azimuth beam edge', off: 25, clock: 90 + azHalf * 0.98, right: 1, left: 0 },
    { name: 'outside the azimuth beam', off: 25, clock: 90 + azHalf * 1.02, right: 0, left: 0 },
    { name: 'along track (an inspector ahead)', off: 89, clock: 0, right: 0, left: 0 },
  ];
  let parameters = null;
  for (const c of cases) {
    const records = await inspect({ ...base, ...radarOptions, start: iso(times[0]), stop: iso(times.at(-1)) },
      [{ states: fixed(times, at(c.off, c.clock)) }], [{ states: fixed(times, target, vel) }], [{ states: fixed(times, SUN) }]);
    parameters ??= params(records[0]);
    const row = rowsOf(records)[0];
    const clockWant = ((c.clock % 360) + 360) % 360;
    check(`radar: ${c.name}`, Math.abs(row.CHASER_OFF_NADIR_DEG - c.off) < 1e-6 && Math.abs(row.CHASER_CLOCK_DEG - clockWant) < 1e-6 &&
      row.IN_SAR_RIGHT === c.right && row.IN_SAR_LEFT === c.left,
      { off: row.CHASER_OFF_NADIR_DEG, clock: row.CHASER_CLOCK_DEG, right: row.IN_SAR_RIGHT, left: row.IN_SAR_LEFT });
  }
  const look = parameters.SAR_LOOK_ANGLE_DEG.split(' to ').map(Number);
  check('radar: the wavelength is c / f', Math.abs(Number(parameters.SAR_WAVELENGTH_M) / lambda - 1) < 1e-10, parameters.SAR_WAVELENGTH_M);
  check('radar: beamwidths are 0.886 lambda / D (azimuth 3.2 m, elevation 0.4 m)', Math.abs(Number(parameters.SAR_AZIMUTH_BEAMWIDTH_DEG) / (2 * azHalf) - 1) < 1e-10 &&
    Math.abs(Number(parameters.SAR_ELEVATION_BEAMWIDTH_DEG) / deg(0.886 * lambda / 0.4) - 1) < 1e-10,
    { azimuth: parameters.SAR_AZIMUTH_BEAMWIDTH_DEG, elevation: parameters.SAR_ELEVATION_BEAMWIDTH_DEG });
  check('radar: look angles from the 15-35 deg incidence band on a spherical Earth', Math.abs(look[0] - lookLo) < 1e-6 && Math.abs(look[1] - lookHi) < 1e-6,
    { look, want: [lookLo, lookHi] });
  check('radar: the inputs and their source are recorded', parameters.SAR_FREQUENCY_GHZ === '9.65' && parameters.SAR_ANTENNA_M === '3.2 x 0.4' &&
    parameters.SAR_INCIDENCE_DEG === '15 to 35' && /ICEYE/.test(parameters.SAR_SOURCE), parameters);
}

// ── 5 + 6: arcs and the record ─────────────────────────────────────────────
{
  const times = grid(11);
  const target = [0, 7000, 0];
  const early = fixed(times, add(target, [0, 0, 10]));            // the first arc: 10 km above the plane, the whole span
  const late = fixed(times.slice(5), add(target, [0, 0, 20]));    // a newer arc from sample 5: 20 km
  const records = await inspect({ ...base, start: iso(times[0]), stop: iso(times.at(-1)) },
    [{ states: early }, { states: late }], [{ states: fixed(times, target) }], [{ states: fixed(times, SUN) }]);
  const rows = rowsOf(records);
  check('arcs: samples before the newer arc use the first, from it on the newer one, never a blend',
    rows.slice(0, 5).every((r) => Math.abs(r.RANGE_KM - 10) < 1e-9) && rows.slice(5).every((r) => Math.abs(r.RANGE_KM - 20) < 1e-9),
    rows.map((r) => +r.RANGE_KM.toFixed(6)));
  const rec = records[0], p = params(rec);
  check('record: one $OCM RPO_INSPECTION on the grid, its COLUMNS the row width', records.length === 1 && rec.TRAJ_TYPE_DESCRIPTION === 'RPO_INSPECTION' &&
    rec.STATE_STEP_SIZE === 60 && p.COLUMNS.split(',').length === rec.STATE_VECTOR_SIZE && rec.STATE_DATA.length === 11 * rec.STATE_VECTOR_SIZE &&
    rec.METADATA.START_TIME === iso(times[0]).replace('.000Z', '.000Z'), { columns: p.COLUMNS, width: rec.STATE_VECTOR_SIZE, start: rec.METADATA.START_TIME });
  const gap = await inspect({ ...base, start: iso(times[0]), stop: iso(times.at(-1)) },
    [{ states: early.slice(0, 4) }, { states: early.slice(6) }], [{ states: fixed(times, target) }], [{ states: fixed(times, SUN) }]);
  check('record: a gap in a trajectory splits the records', gap.length === 2 && rowsOf(gap).length === 9, { records: gap.length, rows: rowsOf(gap).length });
}

console.log(failures ? `INSPECT E2E FAIL (${failures})` : 'INSPECT E2E PASS');
process.exit(failures ? 1 : 0);
