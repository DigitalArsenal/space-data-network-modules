// The fixture runs of tests/typed-records.e2e.mjs and tests/record-free-form.mjs: the module's dist on
//   cosmos      Cosmos 2612 (NORAD 68762) about ICEYE-X36 (NORAD 59103), 2026-09-28 .. 10-17 12:00 UTC, 24 h
//               projection, 14 d calibration, maneuver brackets from analysis/maneuver-detection and the
//               analysis/gp-error-model model, every trajectory from analysis/epoch-state (the
//               cosmos2612-iceye-x36 E2E's run), on the SDN GP archive files through ARCHIVE_THROUGH;
//   inspection  `inspect` on the radar case of tests/inspect.e2e.mjs (a target on an equatorial circular
//               orbit, a chaser 100 km away inside the right look band, ICEYE's public radar inputs) and on
//               its penumbra pass (no radar).
// Each run returns the raw size-prefixed records per output port. Space-Track element sets are read at run
// time and never written to the repository.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '..');
const MODULES = path.resolve(MODULE, '../..');
const ARCHIVE = process.env.SDN_GP_ARCHIVE ?? '/opt/data/sdn-archive/spacetrack/gp_history/by-creation';
// The newest archive file the fixture reads: the archive as of the window's stop. Later sets bracket a maneuver
// open at stop (no projection is made) and would change the element-set inputs.
export const ARCHIVE_THROUGH = '2026-10-17T114700Z--2026-10-17T130201Z.json.gz';

const standards = path.dirname(createRequire(path.join(MODULE, 'package.json')).resolve('spacedatastandards.org/package.json'));
process.env.SPACE_DATA_STANDARDS_ROOT ??= standards;
export const flatbuffers = createRequire(path.join(standards, 'package.json'))('flatbuffers');
const sds = async (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)).href);
export const [OMM, OEM, MNV, OCM, CVR] = await Promise.all(['OMM', 'OEM', 'MNV', 'OCM', 'CVR'].map(sds));

const TYPE = {
  OMM: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' },
  OEM: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' },
  MNV: { schemaName: 'MNV.fbs', fileIdentifier: '$MNV', rootTypeName: 'MNV', wireFormat: 'flatbuffer' },
  PRW: { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' },
  ERM: { schemaName: 'ERM.fbs', fileIdentifier: '$ERM', rootTypeName: 'ERM', wireFormat: 'flatbuffer' },
};
export const COSMOS = { chaser: 68762, target: 59103, start: '2026-09-28T00:00:00Z', stop: '2026-10-17T12:00:00Z', step: 60, horizonH: 24, calibrationDays: 14 };

function ommRecord(row) {
  const t = new OMM.OMMT();
  const num = (k) => (row[k] === undefined || row[k] === null || row[k] === '' ? 0 : Number(row[k]));
  Object.assign(t, {
    OBJECT_NAME: row.OBJECT_NAME ?? '', OBJECT_ID: row.OBJECT_ID ?? '', NORAD_CAT_ID: num('NORAD_CAT_ID'),
    EPOCH: String(row.EPOCH), MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4,
    MEAN_MOTION: num('MEAN_MOTION'), ECCENTRICITY: num('ECCENTRICITY'), INCLINATION: num('INCLINATION'), RA_OF_ASC_NODE: num('RA_OF_ASC_NODE'),
    ARG_OF_PERICENTER: num('ARG_OF_PERICENTER'), MEAN_ANOMALY: num('MEAN_ANOMALY'), BSTAR: num('BSTAR'),
    MEAN_MOTION_DOT: num('MEAN_MOTION_DOT'), MEAN_MOTION_DDOT: num('MEAN_MOTION_DDOT'), REV_AT_EPOCH: num('REV_AT_EPOCH'),
    ELEMENT_SET_NO: num('ELEMENT_SET_NO'), COMMENT: row.GP_ID ? `GP_ID ${row.GP_ID}` : '',
  });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return b.asUint8Array();
}
const stream = (records) => Buffer.concat(records.map((r) => Buffer.from(r)));
export function* sizePrefixed(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 4 <= bytes.length;) {
    const len = view.getUint32(at, true);
    yield bytes.slice(at, at + 4 + len);
    at += 4 + len;
  }
}

async function loadModule(relative, config = {}) {
  const dir = path.join(MODULES, relative);
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(dir, 'dist/isomorphic/module.wasm')),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8')),
    surface: 'direct', hostOptions: { config },
  });
  return {
    async invoke(methodId, inputs) {
      const r = await harness.invoke({ methodId, inputs });
      if (r.statusCode !== 0) throw new Error(`${relative} ${methodId}: ${r.errorCode ?? r.statusCode}: ${r.errorMessage}`);
      return r;
    },
    destroy: () => harness.destroy(),
  };
}
const outputsOf = (r, port) => r.outputs.filter((f) => f.portId === port).map((f) => new Uint8Array(f.payload));
const recordsOf = (r, port) => outputsOf(r, port).flatMap((bytes) => [...sizePrefixed(bytes)]);

async function answered(epochState, requests, elementStream) {
  const r = await epochState.invoke('answer_propagation_requests', [
    { portId: 'requests', payload: requests, typeRef: TYPE.PRW },
    { portId: 'element_sets', payload: elementStream, typeRef: TYPE.OMM },
  ]);
  return outputsOf(r, 'propagation');
}

function gpHistory(norads, fromDay) {
  const files = fs.readdirSync(path.join(ARCHIVE, '2026')).filter((f) => f.slice(0, 10) >= fromDay && f <= ARCHIVE_THROUGH && f.endsWith('.json.gz')).sort();
  if (files.at(-1) !== ARCHIVE_THROUGH) throw new Error(`the archive lacks ${ARCHIVE_THROUGH}`);
  const want = new Set(norads.map(String));
  const byId = new Map();
  for (const f of files) {
    for (const row of JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ARCHIVE, '2026', f))).toString('utf8'))) {
      if (want.has(String(row.NORAD_CAT_ID))) byId.set(row.GP_ID, row);
    }
  }
  return [...byId.values()].sort((a, b) => Number(a.NORAD_CAT_ID) - Number(b.NORAD_CAT_ID) || a.EPOCH.localeCompare(b.EPOCH));
}

async function detectManeuvers(epochState, rows) {
  const detector = await loadModule('analysis/maneuver-detection');
  const elements = stream(rows.map(ommRecord));
  const base = [{ portId: 'element_sets', payload: elements, typeRef: TYPE.OMM }];
  const first = await detector.invoke('detect_maneuvers', base);
  const answers = await answered(epochState, outputsOf(first, 'propagation_requests')[0], elements);
  const second = await detector.invoke('detect_maneuvers', [...base, ...answers.map((a) => ({ portId: 'propagation', payload: a, typeRef: TYPE.OEM }))]);
  await detector.destroy();
  return outputsOf(second, 'maneuvers');
}

export async function cosmosRun() {
  const c = COSMOS;
  const rows = gpHistory([c.chaser, c.target], '2026-09-10');
  const epochState = await loadModule('analysis/epoch-state');
  const mnv = [...await detectManeuvers(epochState, rows.filter((r) => Number(r.NORAD_CAT_ID) === c.chaser)),
    ...await detectManeuvers(epochState, rows.filter((r) => Number(r.NORAD_CAT_ID) === c.target))];
  const unpackMnv = (b) => MNV.MNV.getRootAsMNV(new flatbuffers.ByteBuffer(b)).unpack();
  const mnvStream = stream(mnv.map((f) => { const b = new flatbuffers.Builder(1024); MNV.MNV.finishSizePrefixedMNVBuffer(b, unpackMnv(f).pack(b)); return b.asUint8Array(); }));
  const { encode } = await import(pathToFileURL(path.join(MODULES, 'analysis/gp-error-model/scripts/erm-codec.mjs')).href);
  const file = 'docs/model-2026-08.json';
  const model = JSON.parse(fs.readFileSync(path.join(MODULES, 'analysis/gp-error-model', file), 'utf8'));
  model.id ??= `analysis/gp-error-model ${file}`;
  const rpo = await loadModule('analysis/rpo-history', { rpo: { chaser: String(c.chaser), target: String(c.target), start: c.start, stop: c.stop,
    step_seconds: c.step, projection_hours: c.horizonH, calibration_days: c.calibrationDays, settle_days: 1 } });
  const elements = stream(rows.map(ommRecord));
  const base = [{ portId: 'element_sets', payload: elements, typeRef: TYPE.OMM },
    { portId: 'maneuvers', payload: mnvStream, typeRef: TYPE.MNV }, { portId: 'error_model', payload: encode('model', model), typeRef: TYPE.ERM }];
  const first = await rpo.invoke('characterize', base);
  const answers = await answered(epochState, outputsOf(first, 'propagation_requests')[0], elements);
  const second = await rpo.invoke('characterize', [...base, ...answers.map((a) => ({ portId: 'propagation', payload: a, typeRef: TYPE.OEM }))]);
  await rpo.destroy();
  await epochState.destroy();
  return { elementSets: rows.length, relative: recordsOf(second, 'relative'), geometry: recordsOf(second, 'geometry'), realism: recordsOf(second, 'realism') };
}

// ── inspect ────────────────────────────────────────────────────────────────
const T = (iso) => Date.parse(iso) / 1000;
const iso = (s) => new Date(Math.round(s * 1000)).toISOString();
const rad = (d) => (d * Math.PI) / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
function oem(blocks) {
  const m = new OEM.OEMT();
  m.CREATION_DATE = '2026-10-18T00:00:00.000Z';
  m.EPHEMERIS_DATA_BLOCK = blocks.map(({ states }) => {
    const b = new OEM.ephemerisDataBlockT();
    b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: 0, OBJECT_ID: '' });
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
const fixed = (times, p, v = [0, 0, 0]) => times.map((t) => ({ t, s: [...p, ...v] }));
async function inspect(options, chaser, target, sun) {
  const rpo = await loadModule('analysis/rpo-history', { inspect: options });
  const r = await rpo.invoke('inspect', [
    { portId: 'chaser', payload: oem(chaser), typeRef: TYPE.OEM },
    { portId: 'target', payload: oem(target), typeRef: TYPE.OEM },
    { portId: 'sun', payload: oem(sun), typeRef: TYPE.OEM },
  ]);
  await rpo.destroy();
  return recordsOf(r, 'inspection');
}
export async function inspectionRun() {
  const t0 = T('2026-10-15T00:00:00Z');
  const grid = (n, step = 60) => Array.from({ length: n }, (_, i) => t0 + i * step);
  const SUN = [149597870.7, 0, 0];
  const base = { chaser: 'CHASER', target: 'TARGET', step_seconds: 60 };
  // Radar: along-track +y, nadir -x, right -z; the chaser at off-nadir 25 deg, clock 90 (right), 100 km away.
  const times = grid(2), r = 6928.137, v = 7.585, target = [r, 0, 0];
  const off = rad(25);
  const chaser = add(target, mul(add(mul([-1, 0, 0], Math.cos(off)), mul([0, 0, -1], Math.sin(off))), 100));
  const radar = await inspect({ ...base, sar_frequency_ghz: 9.65, sar_antenna_length_m: 3.2, sar_antenna_height_m: 0.4, sar_incidence_min_deg: 15,
    sar_incidence_max_deg: 35, sar_source: 'ICEYE product specification 6.0.8 (synthetic test inputs)', start: iso(times[0]), stop: iso(times.at(-1)) },
  [{ states: fixed(times, chaser) }], [{ states: fixed(times, target, [0, v, 0]) }], [{ states: fixed(times, SUN) }]);
  // Penumbra pass: a target on a 7000 km circle through the anti-Sun side, the chaser 30 km above its plane.
  const n = 1200, pass = grid(n);
  const states = pass.map((t, i) => { const u = rad(100 + i * 0.05); return { t, s: [7000 * Math.cos(u), 7000 * Math.sin(u), 0, 0, 0, 0] }; });
  const shadow = await inspect({ ...base, start: iso(pass[0]), stop: iso(pass.at(-1)) },
    [{ states: states.map(({ t, s }) => ({ t, s: [s[0], s[1], 30, 0, 0, 0] })) }], [{ states }], [{ states: fixed(pass, SUN) }]);
  return { radar, shadow };
}
