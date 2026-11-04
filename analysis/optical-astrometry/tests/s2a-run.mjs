// The s2a video run of tests/s2a-video-od.e2e.mjs and tests/typed-od.e2e.mjs: s2a systems' time-lapse of
// ICEYE-X36 (NORAD 59103, the calibrator) and COSMOS 2612 (NORAD 68762, the target), its GP history from the
// SDN archive, IERS finals2000A, analysis/gp-error-model's model and Gaia DR3 cones, reduced by this module's
// dist with analysis/epoch-state answering its propagation requests.
//
// Space-Track data are read from the archive at run time and never written into the repository; the video,
// Gaia cones and IERS file are cached outside it. `offline` reads the cache only (a missing input throws).
//
//   S2A_VIDEO            the video file (else the cache, else downloaded)
//   SDN_OPTICAL_CACHE    cache directory (~/.cache/sdn-optical-astrometry)
//   SDN_GP_ARCHIVE       gp_history by-creation root (/opt/data/sdn-archive/spacetrack/gp_history/by-creation)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { decodeFlowNotice } from 'space-data-module-sdk/runtime-contracts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '..');
export const MODULES = path.resolve(MODULE, '../..');
const CACHE = process.env.SDN_OPTICAL_CACHE ?? path.join(os.homedir(), '.cache/sdn-optical-astrometry');
const ARCHIVE = process.env.SDN_GP_ARCHIVE ?? '/opt/data/sdn-archive/spacetrack/gp_history/by-creation';

const VIDEO_URL = 'https://video.twimg.com/amplify_video/2111744665149964288/vid/avc1/1076x720/apvttdh_0Xwgtbnk.mp4';
export const VIDEO_SHA256 = 'c44e23fd93e71c3058538839e9673c2e17fbc7375c377db46d9187080d2c8d15';
const IERS_URL = 'https://datacenter.iers.org/products/eop/rapid/daily/finals2000A.daily';
const GAIA_TAP = 'https://gea.esac.esa.int/tap-server/tap/sync';
export const CALIBRATOR = 59103;   // ICEYE-X36, 2024-043F
export const TARGET = 68762;       // COSMOS 2612, 2026-083H
export const FIRST_FRAME = '2026-10-18T07:27:22Z';
// The video run's node config.
export const CONFIG = {
  calibrator: CALIBRATOR, targets: [TARGET], search_latitude_deg: [-60, 15], search_longitude_deg: [-85, -30],
  prior_created_before: FIRST_FRAME, sensor_id: 's2a-video', originator: 'SDN optical-astrometry E2E', image_set_id: 's2a:2026-10-18T07:27',
};

const standards = path.dirname(createRequire(path.join(MODULE, 'package.json')).resolve('spacedatastandards.org/package.json'));
process.env.SPACE_DATA_STANDARDS_ROOT ??= standards;
export const flatbuffers = createRequire(path.join(standards, 'package.json'))('flatbuffers');
export const sds = async (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)).href);
const [OMM, EOP, FIL, STR, SKQ] = await Promise.all(['OMM', 'EOP', 'FIL', 'STR', 'SKQ'].map(sds));

export const T = (iso) => Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`) / 1000;
export const iso = (s) => new Date(Math.round(s * 1000)).toISOString();
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── typed records ──────────────────────────────────────────────────────────
export const TYPE = Object.fromEntries(['OMM', 'OEM', 'EOP', 'ERM', 'FIL', 'PRW', 'STR', 'SKQ'].map((c) =>
  [c, { schemaName: `${c}.fbs`, fileIdentifier: `$${c}`, rootTypeName: c, wireFormat: 'flatbuffer' }]));
export const stream = (records) => Buffer.concat(records.map((r) => Buffer.from(r)));
export function* sizePrefixed(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 4 <= bytes.length;) {
    const len = view.getUint32(at, true);
    if (len === 0) { at += 4; continue; }
    yield bytes.subarray(at, at + 4 + len);
    at += 4 + len;
  }
}
export const bb = (bytes) => new flatbuffers.ByteBuffer(Uint8Array.from(bytes));
export const each = (bytes, get) => [...sizePrefixed(bytes)].map((r) => get(bb(r)).unpack());
// One record, plain or size-prefixed (the identifier at byte 4 or 8).
export const one = (bytes, cls, name) => {
  const prefixed = String.fromCharCode(...bytes.subarray(8, 12)) === `$${name}`;
  return (prefixed ? cls[`getSizePrefixedRootAs${name}`](bb(bytes)) : cls[`getRootAs${name}`](bb(bytes))).unpack();
};

export function ommRecord(row) {
  const t = new OMM.OMMT();
  const num = (k) => (row[k] === undefined || row[k] === null || row[k] === '' ? 0 : Number(row[k]));
  Object.assign(t, {
    OBJECT_NAME: row.OBJECT_NAME ?? '', OBJECT_ID: row.OBJECT_ID ?? '', NORAD_CAT_ID: num('NORAD_CAT_ID'),
    EPOCH: String(row.EPOCH), CREATION_DATE: String(row.CREATION_DATE ?? ''), MEAN_ELEMENT_THEORY: OMM.meanElementSource.SGP4,
    MEAN_MOTION: num('MEAN_MOTION'), ECCENTRICITY: num('ECCENTRICITY'), INCLINATION: num('INCLINATION'), RA_OF_ASC_NODE: num('RA_OF_ASC_NODE'),
    ARG_OF_PERICENTER: num('ARG_OF_PERICENTER'), MEAN_ANOMALY: num('MEAN_ANOMALY'), BSTAR: num('BSTAR'),
    MEAN_MOTION_DOT: num('MEAN_MOTION_DOT'), MEAN_MOTION_DDOT: num('MEAN_MOTION_DDOT'), REV_AT_EPOCH: num('REV_AT_EPOCH'),
    ELEMENT_SET_NO: num('ELEMENT_SET_NO'), COMMENT: row.GP_ID ? `GP_ID ${row.GP_ID}` : '',
  });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}
export function filRecord(name, mediaType, content) {
  const b = new flatbuffers.Builder(content.length + 256);
  const c = b.createByteVector(content), n = b.createString(name), m = b.createString(mediaType);
  FIL.FIL.startFIL(b);
  FIL.FIL.addName(b, n);
  FIL.FIL.addMediaType(b, m);
  FIL.FIL.addSize(b, BigInt(content.length));
  FIL.FIL.addContent(b, c);
  FIL.FIL.finishFILBuffer(b, FIL.FIL.endFIL(b));
  return b.asUint8Array().slice();
}
// Gaia DR3 rows (source_id, ra, dec, pmra, pmdec, parallax, G) as $STR, catalog places at J2016.0.
function strRecords(csv) {
  const out = [];
  for (const line of csv.split('\n').slice(1)) {
    const f = line.trim().split(',');
    if (f.length < 7 || !f[1]) continue;
    const v = f.map((x) => (x === '' ? NaN : Number(x)));
    const b = new flatbuffers.Builder(192);
    const cat = b.createString('Gaia DR3');
    STR.STR.startSTR(b);
    STR.STR.addGaiaDr3SourceId(b, BigInt(f[0]));
    STR.STR.addCatVersion(b, cat);
    STR.STR.addStarEpoch(b, 2016.0);
    STR.STR.addRa(b, v[1]);
    STR.STR.addDec(b, v[2]);
    if (Number.isFinite(v[3])) STR.STR.addPmra(b, v[3]);
    if (Number.isFinite(v[4])) STR.STR.addPmdec(b, v[4]);
    if (Number.isFinite(v[5])) STR.STR.addParallax(b, v[5]);
    if (Number.isFinite(v[6])) STR.STR.addGmag(b, v[6]);
    STR.STR.finishSizePrefixedSTRBuffer(b, STR.STR.endSTR(b));
    out.push(b.asUint8Array().slice());
  }
  return stream(out);
}

// ── modules ────────────────────────────────────────────────────────────────
export async function loadModule(relative, config = {}) {
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
export const outputsOf = (r, port) => r.outputs.filter((f) => f.portId === port).map((f) => new Uint8Array(f.payload));
export async function answered(epochState, requests, elements) {
  const r = await epochState.invoke('answer_propagation_requests', [
    { portId: 'requests', payload: requests, typeRef: TYPE.PRW },
    { portId: 'element_sets', payload: elements, typeRef: TYPE.OMM },
  ]);
  return outputsOf(r, 'propagation').map((a) => ({ portId: 'propagation', payload: a, typeRef: TYPE.OEM }));
}

// ── inputs ─────────────────────────────────────────────────────────────────
async function download(url, file, offline) {
  if (offline) throw new Error(`offline: ${file} is not cached`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
// The video's frames as PGM files (ffmpeg, cached) and the video's SHA-256.
export async function videoFrames({ offline = false } = {}) {
  for (const d of [CACHE, path.join(CACHE, 'gaia')]) fs.mkdirSync(d, { recursive: true });
  let video = process.env.S2A_VIDEO;
  if (!video) {
    video = path.join(CACHE, 's2a-iceye-x36-cosmos-2612-1076x720.mp4');
    if (!fs.existsSync(video)) await download(VIDEO_URL, video, offline);
  }
  const digest = sha256(fs.readFileSync(video));
  const dir = path.join(CACHE, `frames-${digest.slice(0, 12)}`);
  if (!fs.existsSync(path.join(dir, 'f239.pgm'))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-pix_fmt', 'gray', '-f', 'image2', path.join(dir, 'f%03d.pgm')]);
  }
  const files = fs.readdirSync(dir).filter((f) => /^f\d{3}\.pgm$/.test(f)).sort();
  return { digest, frames: files.map((f) => ({ name: f, bytes: fs.readFileSync(path.join(dir, f)) })) };
}
// The calibrator's and the target's GP sets with EPOCH from 2026-10-15, from the archive files created from
// 2026-10-15 through `through` (a file name; every file when absent).
export function gpRows(through) {
  const files = fs.readdirSync(path.join(ARCHIVE, '2026'))
    .filter((f) => f.slice(0, 10) >= '2026-10-15' && f.endsWith('.json.gz') && (!through || f <= through)).sort();
  const want = new Set([String(CALIBRATOR), String(TARGET)]);
  const byId = new Map();
  for (const f of files)
    for (const row of JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ARCHIVE, '2026', f))).toString('utf8')))
      if (want.has(String(row.NORAD_CAT_ID)) && row.EPOCH >= '2026-10-15') byId.set(row.GP_ID, row);
  return { rows: [...byId.values()].sort((a, b) => a.EPOCH.localeCompare(b.EPOCH)), files: files.length, newest: files.at(-1) };
}
// IERS finals2000A rows within 4 days of the first frame, through data-source/eop-parser. Online, a cached
// file older than 7 days is fetched again.
export async function earthOrientation({ offline = false } = {}) {
  const file = path.join(CACHE, 'finals2000A.daily');
  if (!fs.existsSync(file) || (!offline && Date.now() - fs.statSync(file).mtimeMs > 7 * 86400e3)) await download(IERS_URL, file, offline);
  const parser = await loadModule('data-source/eop-parser');
  const r = await parser.invoke('parse_finals2000a', [{ portId: 'body', typeRef: TYPE.FIL, payload: filRecord('finals2000A.daily', 'text/plain', fs.readFileSync(file)) }]);
  await parser.destroy();
  const mjd0 = T(FIRST_FRAME) / 86400 + 40587;
  const kept = [...sizePrefixed(outputsOf(r, 'records')[0])].filter((rec) => {
    const row = EOP.EOP.getSizePrefixedRootAsEOP(bb(rec)).unpack();
    return Math.abs(row.MJD - mjd0) <= 4;
  });
  return { payload: stream(kept), rows: kept.length, sha256: sha256(fs.readFileSync(file)) };
}
export async function errorModel() {
  const { encode } = await import(pathToFileURL(path.join(MODULES, 'analysis/gp-error-model/scripts/erm-codec.mjs')).href);
  const model = JSON.parse(fs.readFileSync(path.join(MODULES, 'analysis/gp-error-model/docs/model-2026-08.json'), 'utf8'));
  model.id ??= 'analysis/gp-error-model docs/model-2026-08.json';
  const bytes = encode('model', model);
  return { bytes, id: model.id, sha256: sha256(bytes) };
}
// One catalog cone from ESA's Gaia archive (TAP, synchronous), cached. A cone
// in a dense field outruns the archive's synchronous time limit (HTTP 408):
// it is then asked as seven cones of 0.52 its radius covering it (one at the
// center, six at sqrt(3)/2 of the radius), and the rows are joined.
async function tapCsv(ra, dec, radius, mag) {
  const query = `SELECT source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT(ra,dec),CIRCLE(${ra.toFixed(5)},${dec.toFixed(5)},${radius.toFixed(4)})) AND phot_g_mean_mag<${mag.toFixed(1)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(GAIA_TAP, { method: 'POST', body: new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query }) });
    const text = await res.text().catch(() => '');
    if (res.ok && text.startsWith('source_id')) return text;
    if (res.status === 408 || text.includes('value="408"') || /timeout/i.test(text)) return null;
    if (attempt >= 5) throw new Error(`Gaia TAP refused the cone at ${ra.toFixed(3)} ${dec.toFixed(3)} r ${radius.toFixed(2)}`);
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
}
async function coneCsv(ra, dec, radius, mag, offline, depth = 0) {
  const file = path.join(CACHE, 'gaia', `cone_${ra.toFixed(3)}_${dec.toFixed(3)}_${radius.toFixed(2)}.csv`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  if (offline) throw new Error(`offline: Gaia cone ${file} is not cached`);
  let text = await tapCsv(ra, dec, radius, mag);
  if (text === null) {
    if (depth >= 2) throw new Error('Gaia TAP timed out on a sub-cone');
    const d2r = Math.PI / 180, d = (Math.sqrt(3) / 2) * radius * d2r, lines = [];
    const centers = [[ra, dec]];
    for (let k = 0; k < 6; k++) {
      const th = k * Math.PI / 3, s0 = Math.sin(dec * d2r), c0 = Math.cos(dec * d2r);
      const dec2 = Math.asin(s0 * Math.cos(d) + c0 * Math.sin(d) * Math.cos(th));
      const ra2 = ra * d2r + Math.atan2(Math.sin(th) * Math.sin(d) * c0, Math.cos(d) - s0 * Math.sin(dec2));
      centers.push([((ra2 / d2r) % 360 + 360) % 360, dec2 / d2r]);
    }
    for (const [a, b] of centers) {
      const part = (await coneCsv(a, b, 0.52 * radius, mag, offline, depth + 1)).split('\n');
      if (!lines.length) lines.push(part[0]);
      lines.push(...part.slice(1).filter((l) => l.trim()));
    }
    text = `${lines.join('\n')}\n`;
  }
  fs.writeFileSync(file, text);
  return text;
}
const gaiaCone = async (q, offline) => strRecords(await coneCsv(q.RA_DEG, q.DEC_DEG, q.RADIUS_DEG, Number.isFinite(q.MAG_LIMIT) ? q.MAG_LIMIT : 13.5, offline));

// ── one reduction to the end ───────────────────────────────────────────────
export async function reduceAll(epochState, frames, config, base, catalog = new Map(), { offline = false } = {}) {
  const optical = await loadModule('analysis/optical-astrometry', { optical: config });
  let answers = [];
  const passes = [];
  for (let pass = 0; pass < 8; pass++) {
    const started = Date.now();
    const cat = [...catalog.values()].map((payload) => ({ portId: 'catalog', payload, typeRef: TYPE.STR }));
    const r = await optical.invoke('reduce', [...frames, ...base, ...answers, ...cat]);
    const n = decodeFlowNotice(outputsOf(r, 'report')[0]);
    const report = { REASON: n.reason, COUNT: n.count, ITEMS: n.items };
    passes.push({ reason: report.REASON, count: Number(report.COUNT), seconds: (Date.now() - started) / 1000 });
    console.log(`      pass ${pass}: ${report.REASON} (${Number(report.COUNT)}) in ${passes.at(-1).seconds.toFixed(1)} s`);
    if (report.REASON === 'need-propagation') {
      answers = await answered(epochState, outputsOf(r, 'propagation_requests')[0], base.find((f) => f.portId === 'element_sets').payload);
    } else if (report.REASON === 'need-catalog') {
      for (const q of each(outputsOf(r, 'catalog_requests')[0], (x) => SKQ.SKQ.getSizePrefixedRootAsSKQ(x))) {
        const key = `${q.RA_DEG.toFixed(3)},${q.DEC_DEG.toFixed(3)},${q.RADIUS_DEG.toFixed(2)}`;
        if (!catalog.has(key)) catalog.set(key, await gaiaCone(q, offline));
      }
    } else {
      await optical.destroy();
      return { r, report, passes, catalog };
    }
  }
  throw new Error('the reduction did not finish in eight passes');
}

// The video reduction on the archive through `through`: the inputs as $FIL frames, $OMM, $EOP and $ERM.
export async function videoRun({ through, offline = false } = {}) {
  const { digest, frames } = await videoFrames({ offline });
  const gp = gpRows(through);
  const eop = await earthOrientation({ offline });
  const erm = await errorModel();
  const base = [
    { portId: 'element_sets', payload: stream(gp.rows.map(ommRecord)), typeRef: TYPE.OMM },
    { portId: 'earth_orientation', payload: eop.payload, typeRef: TYPE.EOP },
    { portId: 'error_model', payload: erm.bytes, typeRef: TYPE.ERM },
  ];
  const frameInputs = frames.map((f) => ({ portId: 'frames', payload: filRecord(f.name, 'image/x-portable-graymap', f.bytes), typeRef: TYPE.FIL }));
  const epochState = await loadModule('analysis/epoch-state');
  const video = await reduceAll(epochState, frameInputs, CONFIG, base, new Map(), { offline });
  return { digest, frames, gp, eop, erm, base, epochState, video };
}
