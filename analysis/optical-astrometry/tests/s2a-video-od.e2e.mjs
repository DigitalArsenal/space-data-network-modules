#!/usr/bin/env node
// E2E (optical-video-to-obs-od-20261018): s2a systems' time-lapse of
// ICEYE-X36 (NORAD 59103) and COSMOS 2612 (NORAD 68762) over South America,
// 2026-10-18 07:27:22-07:29:22 UTC (x.com/s2a_systems/status/2111745395747361049),
// through the modules as a node would run them:
//
//   the video (H.264, 1076x720, 239 frames) -> ffmpeg -> PGM frames -> $FIL
//   GP history (the SDN archive, Space-Track gp_history) -> $OMM
//   IERS finals2000A.daily -> data-source/eop-parser -> $EOP
//   analysis/gp-error-model's model (docs/model-2026-08.json, the RPO lane's) -> $ERM
//   analysis/optical-astrometry reduce, its propagator query port answered by
//     analysis/epoch-state (SGP4) and its catalog cones by Gaia DR3 (ESA TAP)
//     -> $TDM, $EOO, $SKI, $OCM, $OEM
//   analysis/od fit on the orbit's $OEM -> $OMM (the OD as mean elements)
//   analysis/rpo-history characterize: COSMOS 2612 from the OD, from its prior
//     set and from the next published set (truth), relative to ICEYE-X36
//   the FITS path: every frame written as FITS (burnt-in overlays removed)
//     with DATE-OBS (the solved exposure start), EXPTIME and the solved
//     site, reduced again with the site known: the time bias must come back zero
//
// and checks the result against independent evidence: the frame cadence,
// the plate residuals, the calibrator's observed-minus-computed, and the
// COSMOS 2612 orbit against the NEXT Space-Track element set (published after
// the video; pending when not yet in the archive).
//
// Space-Track data are read from the archive at run time and never written
// into the repository; the video, Gaia cones and IERS file are cached outside
// it; the evidence goes to tests/out (ignored by git).
//
//   S2A_VIDEO            the video file (else the cache, else downloaded)
//   SDN_OPTICAL_CACHE    cache directory (~/.cache/sdn-optical-astrometry)
//   SDN_GP_ARCHIVE       gp_history by-creation root (/opt/data/sdn-archive/spacetrack/gp_history/by-creation)
//   OPTICAL_E2E_OUT      evidence directory (tests/out)
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
const MODULES = path.resolve(MODULE, '../..');
const CACHE = process.env.SDN_OPTICAL_CACHE ?? path.join(os.homedir(), '.cache/sdn-optical-astrometry');
const ARCHIVE = process.env.SDN_GP_ARCHIVE ?? '/opt/data/sdn-archive/spacetrack/gp_history/by-creation';
const OUT = process.env.OPTICAL_E2E_OUT ?? path.join(HERE, 'out');
for (const d of [CACHE, path.join(CACHE, 'gaia'), OUT]) fs.mkdirSync(d, { recursive: true });

const VIDEO_URL = 'https://video.twimg.com/amplify_video/2111744665149964288/vid/avc1/1076x720/apvttdh_0Xwgtbnk.mp4';
const VIDEO_SHA256 = 'c44e23fd93e71c3058538839e9673c2e17fbc7375c377db46d9187080d2c8d15';
const IERS_URL = 'https://datacenter.iers.org/products/eop/rapid/daily/finals2000A.daily';
const GAIA_TAP = 'https://gea.esac.esa.int/tap-server/tap/sync';
const CALIBRATOR = 59103;   // ICEYE-X36, 2024-043F
const TARGET = 68762;       // COSMOS 2612, 2026-083H
const FIRST_FRAME = '2026-10-18T07:27:22Z';

const standards = path.dirname(createRequire(path.join(MODULE, 'package.json')).resolve('spacedatastandards.org/package.json'));
process.env.SPACE_DATA_STANDARDS_ROOT ??= standards;
const flatbuffers = createRequire(path.join(standards, 'package.json'))('flatbuffers');
const sds = async (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)).href);
const [OMM, OEM, EOP, FIL, STR, SKQ, TDM, EOO, SKI, OCM] = await Promise.all(['OMM', 'OEM', 'EOP', 'FIL', 'STR', 'SKQ', 'TDM', 'EOO', 'SKI', 'OCM'].map(sds));

const T = (iso) => Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`) / 1000;
const iso = (s) => new Date(Math.round(s * 1000)).toISOString();
const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const note = (line) => { results.push({ note: line }); console.log(`      ${line}`); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── typed records ──────────────────────────────────────────────────────────
const TYPE = Object.fromEntries(['OMM', 'OEM', 'EOP', 'ERM', 'FIL', 'PRW', 'STR', 'SKQ'].map((c) =>
  [c, { schemaName: `${c}.fbs`, fileIdentifier: `$${c}`, rootTypeName: c, wireFormat: 'flatbuffer' }]));
const stream = (records) => Buffer.concat(records.map((r) => Buffer.from(r)));
function* sizePrefixed(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 4 <= bytes.length;) {
    const len = view.getUint32(at, true);
    if (len === 0) { at += 4; continue; }
    yield bytes.subarray(at, at + 4 + len);
    at += 4 + len;
  }
}
const bb = (bytes) => new flatbuffers.ByteBuffer(Uint8Array.from(bytes));
const each = (bytes, get) => [...sizePrefixed(bytes)].map((r) => get(bb(r)).unpack());
// One record, plain or size-prefixed (the identifier at byte 4 or 8).
const one = (bytes, cls, name) => {
  const prefixed = String.fromCharCode(...bytes.subarray(8, 12)) === `$${name}`;
  return (prefixed ? cls[`getSizePrefixedRootAs${name}`](bb(bytes)) : cls[`getRootAs${name}`](bb(bytes))).unpack();
};

function ommRecord(row) {
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
function filRecord(name, mediaType, content) {
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
    STR.STR.addGaiadr3CatId(b, BigInt(f[0]));
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
async function answered(epochState, requests, elements) {
  const r = await epochState.invoke('answer_propagation_requests', [
    { portId: 'requests', payload: requests, typeRef: TYPE.PRW },
    { portId: 'element_sets', payload: elements, typeRef: TYPE.OMM },
  ]);
  return outputsOf(r, 'propagation').map((a) => ({ portId: 'propagation', payload: a, typeRef: TYPE.OEM }));
}

// ── inputs ─────────────────────────────────────────────────────────────────
async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
async function videoFrames() {
  let video = process.env.S2A_VIDEO;
  if (!video) {
    video = path.join(CACHE, 's2a-iceye-x36-cosmos-2612-1076x720.mp4');
    if (!fs.existsSync(video)) await download(VIDEO_URL, video);
  }
  const digest = sha256(fs.readFileSync(video));
  check('video: the published 1076x720 variant', digest === VIDEO_SHA256, `sha256 ${digest}`);
  const dir = path.join(CACHE, `frames-${digest.slice(0, 12)}`);
  if (!fs.existsSync(path.join(dir, 'f239.pgm'))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-pix_fmt', 'gray', '-f', 'image2', path.join(dir, 'f%03d.pgm')]);
  }
  const files = fs.readdirSync(dir).filter((f) => /^f\d{3}\.pgm$/.test(f)).sort();
  return files.map((f) => ({ name: f, bytes: fs.readFileSync(path.join(dir, f)) }));
}
function gpRows() {
  const files = fs.readdirSync(path.join(ARCHIVE, '2026')).filter((f) => f.slice(0, 10) >= '2026-10-15' && f.endsWith('.json.gz')).sort();
  const want = new Set([String(CALIBRATOR), String(TARGET)]);
  const byId = new Map();
  for (const f of files)
    for (const row of JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ARCHIVE, '2026', f))).toString('utf8')))
      if (want.has(String(row.NORAD_CAT_ID)) && row.EPOCH >= '2026-10-15') byId.set(row.GP_ID, row);
  return { rows: [...byId.values()].sort((a, b) => a.EPOCH.localeCompare(b.EPOCH)), files: files.length, newest: files.at(-1) };
}
async function earthOrientation() {
  const file = path.join(CACHE, 'finals2000A.daily');
  if (!fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > 7 * 86400e3) await download(IERS_URL, file);
  const parser = await loadModule('data-source/eop-parser');
  const r = await parser.invoke('parse_finals2000a', [{ portId: 'body', typeRef: TYPE.FIL, payload: filRecord('finals2000A.daily', 'text/plain', fs.readFileSync(file)) }]);
  await parser.destroy();
  const mjd0 = T(FIRST_FRAME) / 86400 + 40587;
  const kept = [...sizePrefixed(outputsOf(r, 'records')[0])].filter((rec) => {
    const row = EOP.EOP.getSizePrefixedRootAsEOP(bb(rec)).unpack();
    return Math.abs(row.MJD - mjd0) <= 4;
  });
  return { payload: stream(kept), rows: kept.length };
}
async function errorModel() {
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
async function coneCsv(ra, dec, radius, mag, depth = 0) {
  const file = path.join(CACHE, 'gaia', `cone_${ra.toFixed(3)}_${dec.toFixed(3)}_${radius.toFixed(2)}.csv`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
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
      const part = (await coneCsv(a, b, 0.52 * radius, mag, depth + 1)).split('\n');
      if (!lines.length) lines.push(part[0]);
      lines.push(...part.slice(1).filter((l) => l.trim()));
    }
    text = `${lines.join('\n')}\n`;
  }
  fs.writeFileSync(file, text);
  return text;
}
const gaiaCone = async (q) => strRecords(await coneCsv(q.RA_DEG, q.DEC_DEG, q.RADIUS_DEG, Number.isFinite(q.MAG_LIMIT) ? q.MAG_LIMIT : 13.5));

// ── one reduction to the end ───────────────────────────────────────────────
async function reduceAll(epochState, frames, config, base, catalog = new Map()) {
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
        if (!catalog.has(key)) catalog.set(key, await gaiaCone(q));
      }
    } else {
      await optical.destroy();
      return { r, report, passes, catalog };
    }
  }
  throw new Error('the reduction did not finish in eight passes');
}

const item = (report, prefix) => report.ITEMS.find((s) => s.startsWith(prefix)) ?? '';
const field = (text, key) => { const m = new RegExp(`${key}=([^ ]+)`).exec(text); return m ? m[1] : undefined; };
const nums = (text) => (text ?? '').split(',').map(Number);
const targetItem = (report, key) => { const s = item(report, `target ${TARGET} ${key}=`); return s.slice(s.indexOf('=') + 1); };

// ── the run ────────────────────────────────────────────────────────────────
const t0 = Date.now();
const frames = await videoFrames();
check('video: 239 frames decoded by ffmpeg', frames.length === 239, `${frames.length} frames`);
const gp = gpRows();
note(`GP sets: ${gp.rows.length} of NORAD ${CALIBRATOR} and ${TARGET} with EPOCH from 2026-10-15, ${gp.files} archive files through ${gp.newest}`);
const elements = stream(gp.rows.map(ommRecord));
const eop = await earthOrientation();
const erm = await errorModel();
note(`EOP: ${eop.rows} IERS finals2000A rows within 4 d; error model ${erm.id} (sha256 ${erm.sha256.slice(0, 16)})`);
const base = [
  { portId: 'element_sets', payload: elements, typeRef: TYPE.OMM },
  { portId: 'earth_orientation', payload: eop.payload, typeRef: TYPE.EOP },
  { portId: 'error_model', payload: erm.bytes, typeRef: TYPE.ERM },
];
const frameInputs = frames.map((f) => ({ portId: 'frames', payload: filRecord(f.name, 'image/x-portable-graymap', f.bytes), typeRef: TYPE.FIL }));
const config = {
  calibrator: CALIBRATOR, targets: [TARGET], search_latitude_deg: [-60, 15], search_longitude_deg: [-85, -30],
  prior_created_before: FIRST_FRAME, sensor_id: 's2a-video', originator: 'SDN optical-astrometry E2E', image_set_id: 's2a:2026-10-18T07:27',
};
const epochState = await loadModule('analysis/epoch-state');
const video = await reduceAll(epochState, frameInputs, config, base);
note(`passes: ${video.passes.map((p) => `${p.reason}(${p.count}, ${p.seconds.toFixed(1)} s)`).join(' -> ')}`);
const rep = video.report;
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rep.ITEMS, null, 1));

// 1. Timing.
const timing = item(rep, 'timing=');
const cadence = Number(field(timing, 'cadence_s').split('+-')[0]);
check('timing: every frame time read from the overlay, on the cadence line', field(timing, 'decoded') === '239/239' && field(timing, 'outliers') === '0' &&
  Math.abs(cadence - 0.5002) < 0.001 && Number(field(timing, 'jitter_rms_ms')) < 2, timing);

// 2. Plates.
const plates = item(rep, 'plates ');
const solved = Number(field(plates, 'solved').split('/')[0]);
const plateMedian = Number(field(plates, 'median_residual_arcsec'));
check('plates: median star residual <= 5 arcsec, >= 150 of 239 frames solved', plateMedian <= 5 && solved >= 150, plates);
note(item(rep, 'unsolved_frames='));

// 3. Site and timing from the calibrator.
const site = item(rep, 'site ');
note(site);
note(item(rep, 'time_bias_s='));
const calib = item(rep, 'calibrator ');
const calChi2 = Number(field(calib, 'chi2_per_dof'));
check('calibrator ICEYE-X36: observed-minus-computed consistent with the stated uncertainty (chi2/dof <= 2)', calChi2 > 0 && calChi2 <= 2 &&
  Number(field(calib, 'fit_rms_arcsec')) <= 5, calib);

// 4. The COSMOS 2612 orbit.
const odRms = Number(targetItem(rep, 'OD_RMS_ARCSEC')), odChi2 = Number(targetItem(rep, 'OD_CHI2_PER_DOF'));
check('COSMOS 2612 OD: residual rms <= 5 arcsec, chi2/dof <= 2', odRms <= 5 && odChi2 <= 2, `rms ${odRms} arcsec, chi2/dof ${odChi2}; ${targetItem(rep, 'TRACK')}`);
for (const k of ['PRIOR', 'PRIOR_O_MINUS_C_MEDIAN_ARCSEC', 'OD_MINUS_PRIOR_RTN_KM', 'SIGMA_TOTAL_RTN_KM', 'IOD', 'SEPARATION_FROM_CALIBRATOR_KM']) note(`${k}: ${targetItem(rep, k)}`);
const tLast = T(FIRST_FRAME) + 120;
const checks = rep.ITEMS.filter((s) => s.startsWith(`target ${TARGET} CHECK `)).map((s) => {
  const epoch = T(/EPOCH (\S+)/.exec(s)[1]);
  return { text: s, epoch, d2od: Number(/d2 \(3 dof\) OD ([\d.eE+-]+|nan)/.exec(s)?.[1]), d2prior: Number(/prior ([\d.eE+-]+|nan)$/.exec(s)?.[1]),
    od: nums(/OD-set RTN km ([^ ]+)/.exec(s)?.[1]), prior: nums(/prior-set RTN km ([^ ]+)/.exec(s)?.[1]) };
});
const truth = checks.filter((c) => c.epoch > tLast).sort((a, b) => a.epoch - b.epoch)[0];
let truthSummary = 'pending: no COSMOS 2612 element set after the video in the archive yet';
if (truth) {
  const mag = (v) => Math.hypot(...v);
  truthSummary = truth.text;
  check('COSMOS 2612 OD against the NEXT Space-Track set (truth): consistent (d2 <= 11.34, 99% for 3 dof) and closer than the prior',
    truth.d2od <= 11.34 && mag(truth.od) < mag(truth.prior), `OD-truth RTN km ${truth.od.join(',')} (d2 ${truth.d2od}); prior-truth ${truth.prior.join(',')} (d2 ${truth.d2prior})`);
} else note(truthSummary);

// 5. The products decode as SDS.
const tdm = TDM.TDM.getRootAsTDM(bb(outputsOf(video.r, 'observations')[0])).unpack();
const eoos = each(outputsOf(video.r, 'optical_observations')[0], (x) => EOO.EOO.getSizePrefixedRootAsEOO(x));
const skis = each(outputsOf(video.r, 'plates')[0], (x) => SKI.SKI.getSizePrefixedRootAsSKI(x));
const ocms = each(outputsOf(video.r, 'orbit')[0], (x) => OCM.OCM.getSizePrefixedRootAsOCM(x));
const tdmRows = tdm.SEGMENTS.reduce((n, s) => n + s.OBSERVATIONS.length, 0);
check('products: TDM RADEC segments, one EOO per angle pair, one SKI per solved frame, one OCM', tdm.SEGMENTS.length === 2 &&
  tdm.SEGMENTS.every((s) => s.ANGLE_TYPE === 'RADEC' && s.REFERENCE_FRAME === 'GCRF' && s.TIMETAG_REF === 'RECEIVE') &&
  tdmRows === 2 * eoos.length && eoos.length === Number(rep.COUNT) && skis.length === solved && ocms.length === 1 &&
  ocms[0].COVARIANCE_DATA.length === 21 && eoos.every((e) => e.RA_UNC > 0 && e.DECLINATION_UNC > 0),
  `TDM segments ${tdm.SEGMENTS.map((s) => `${s.PARTICIPANT_2}:${s.OBSERVATIONS.length / 2}`).join(' ')}, EOO ${eoos.length}, SKI ${skis.length}, OCM ${ocms.length}`);
const raUnc = eoos.filter((e) => e.NORAD_CAT_ID === TARGET).map((e) => e.DECLINATION_UNC * 3600).sort((a, b) => a - b);
note(`COSMOS 2612 per-point declination 1-sigma median ${raUnc[raUnc.length >> 1].toFixed(2)} arcsec`);

// 6. analysis/od: the orbit's trajectory as mean elements.
const trajectory = outputsOf(video.r, 'orbit_trajectory')[0];
const od = await loadModule('analysis/od', { dataSource: 's2a-video-optical', noradCatId: TARGET });
const fit = await od.invoke('fit', [{ portId: 'oem', payload: trajectory, typeRef: TYPE.OEM }]);
await od.destroy();
const odOmm = outputsOf(fit, 'omm')[0];
const odSet = one(odOmm, OMM.OMM, 'OMM');
const obd = outputsOf(fit, 'obd')[0];
const { OBD } = await sds('OBD');
const obdRec = obd ? one(obd, OBD, 'OBD') : null;
check('analysis/od: mean elements fitted to the orbit trajectory (fit rms < 0.1 km)', odOmm && obdRec && obdRec.WRMS < 0.1,
  `EPOCH ${odSet.EPOCH} n ${odSet.MEAN_MOTION} e ${odSet.ECCENTRICITY}; WRMS ${obdRec?.WRMS} km`);

// 7. analysis/rpo-history: COSMOS 2612 relative to ICEYE-X36 after the pass, from the OD, the prior and the truth.
const calSet = gp.rows.filter((r) => Number(r.NORAD_CAT_ID) === CALIBRATOR).sort((a, b) => Math.abs(T(a.EPOCH) - T(FIRST_FRAME)) - Math.abs(T(b.EPOCH) - T(FIRST_FRAME)))[0];
const priorRow = gp.rows.filter((r) => Number(r.NORAD_CAT_ID) === TARGET && T(r.EPOCH) <= T(FIRST_FRAME) && T(r.CREATION_DATE) <= T(FIRST_FRAME)).at(-1);
const truthRow = truth ? gp.rows.filter((r) => Number(r.NORAD_CAT_ID) === TARGET && Math.abs(T(r.EPOCH) - truth.epoch) < 1).at(-1) : null;
const startS = Math.ceil(Math.max(T(calSet.EPOCH), T(odSet.EPOCH), truthRow ? T(truthRow.EPOCH) : 0) / 10) * 10;
async function rpoRange(chaserRecord) {
  const rpo = await loadModule('analysis/rpo-history', { rpo: {
    chaser: String(TARGET), target: String(CALIBRATOR), start: iso(startS), stop: iso(startS + 1800), step_seconds: 10, projection_hours: 0, hindcast: false, calibration_days: 0 } });
  const el = stream([chaserRecord, ommRecord(calSet)]);
  const inputs = [{ portId: 'element_sets', payload: el, typeRef: TYPE.OMM }];
  const first = await rpo.invoke('characterize', inputs);
  const second = await rpo.invoke('characterize', [...inputs, ...(await answered(epochState, outputsOf(first, 'propagation_requests')[0], el))]);
  await rpo.destroy();
  const rows = [];
  for (const rec of each(outputsOf(second, 'geometry')[0], (x) => OCM.OCM.getSizePrefixedRootAsOCM(x))) {
    const udp = Object.fromEntries(rec.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
    const cols = udp.COLUMNS.split(','), w = rec.STATE_VECTOR_SIZE, start = T(rec.METADATA.START_TIME), k = cols.indexOf('SEPARATION_KM');
    for (let i = 0; i * w < rec.STATE_DATA.length; i++) rows.push({ t: start + i * rec.STATE_STEP_SIZE, sep: rec.STATE_DATA[i * w + k], r: rec.STATE_DATA[i * w], it: rec.STATE_DATA[i * w + 1], c: rec.STATE_DATA[i * w + 2] });
  }
  return rows;
}
const fromOd = await rpoRange(odOmm), fromPrior = await rpoRange(ommRecord(priorRow));
const fromTruth = truthRow ? await rpoRange(ommRecord(truthRow)) : null;
const at0 = (rows) => rows[0];
note(`RPO ${iso(startS)}: separation from ICEYE-X36 ${at0(fromOd).sep.toFixed(3)} km (OD; R,I,C ${at0(fromOd).r.toFixed(3)},${at0(fromOd).it.toFixed(3)},${at0(fromOd).c.toFixed(3)}), ` +
  `${at0(fromPrior).sep.toFixed(3)} km (prior)${fromTruth ? `, ${at0(fromTruth).sep.toFixed(3)} km (truth)` : ''}`);
if (fromTruth) {
  const rms = (a) => Math.sqrt(a.reduce((s, row, i) => s + (row.sep - fromTruth[i].sep) ** 2, 0) / a.length);
  check('rpo-history: separation series from the OD closer to the truth set than the prior set over 30 min', rms(fromOd) < rms(fromPrior),
    `rms vs truth: OD ${rms(fromOd).toFixed(3)} km, prior ${rms(fromPrior).toFixed(3)} km over ${fromOd.length} samples`);
}

// 8. The FITS path: every frame with DATE-OBS (the solved exposure start), EXPTIME and the solved site.
const lat = Number(field(site, 'lat_deg')), lon = Number(field(site, 'lon_deg')), h = Number(field(site, 'height_m'));
const exposure = Number(item(rep, 'exposure_s=').split('=')[1]);
const card = (k, v) => `${k.padEnd(8)}= ${typeof v === 'string' ? `'${v}'`.padEnd(20) : (v === true ? 'T' : String(v)).padStart(20)}`.padEnd(80);
// An instrument frame carries no burnt-in overlays: the time's box (from the
// video run, 4 px margin) and the s2a logo (bottom right of this video) are
// filled with the frame's median level.
const box = nums(field(timing, 'overlay_box_px'));
const LOGO = [880, 662, 1075, 712];
function fits(pgm, cards) {
  const text = pgm.subarray(0, 32).toString('latin1');
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(text);
  const w = Number(m[1]), hgt = Number(m[2]), data = Buffer.from(pgm.subarray(m[0].length, m[0].length + w * hgt));
  const level = [...data.subarray(0, data.length).filter((_, i) => i % 97 === 0)].sort((a, b) => a - b)[0 | (data.length / 97 / 2)];
  for (const [x0, y0, x1, y1] of [[box[0] - 4, box[1] - 4, box[2] + 4, box[3] + 4], LOGO])
    for (let y = Math.max(0, y0); y <= Math.min(hgt - 1, y1); y++) data.fill(level, y * w + Math.max(0, x0), y * w + Math.min(w, x1 + 1));
  let head = [card('SIMPLE', true), card('BITPIX', 8), card('NAXIS', 2), card('NAXIS1', w), card('NAXIS2', hgt), ...cards, 'END'.padEnd(80)].join('');
  head = head.padEnd(Math.ceil(head.length / 2880) * 2880, ' ');
  const body = Buffer.alloc(Math.ceil(data.length / 2880) * 2880);
  data.copy(body);
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}
// Exposure starts: frame 0's solved start plus the overlay's cadence (jitter 0.3 ms).
const start0 = T(skis.find((s) => s.SEQUENCE_ID === 0).EXP_START_TIME);
const fitsInputs = frames.map((f, i) => {
  const bytes = fits(f.bytes, [card('DATE-OBS', iso(start0 + i * cadence).replace('Z', '')), card('EXPTIME', exposure), card('SITELAT', lat), card('SITELONG', lon), card('SITEELEV', h)]);
  return { portId: 'frames', payload: filRecord(f.name.replace('.pgm', '.fits'), 'image/fits', bytes), typeRef: TYPE.FIL };
});
const { search_latitude_deg: _a, search_longitude_deg: _o, ...known } = config;
const fitsRun = await reduceAll(epochState, fitsInputs, { ...known, time_reference: 'start' }, base, video.catalog);
const fr = fitsRun.report;
const fPlates = item(fr, 'plates '), fBias = item(fr, 'time_bias_s='), fCal = item(fr, 'calibrator ');
const bias = nums(fBias.split('=')[1].split(' ')[0].replace('+-', ','));
const fOd = Number((item(fr, `target ${TARGET} OD_RMS_ARCSEC=`).split('=')[1]));
check('FITS path: DATE-OBS frames reduce with the site from the headers; the time bias comes back zero', item(fr, 'timing=').includes('FITS DATE-OBS') &&
  item(fr, 'site ').includes('given') && Number(field(fPlates, 'median_residual_arcsec')) <= 5 && Math.abs(bias[0]) <= 3 * bias[1] + 0.01 &&
  Number(field(fCal, 'chi2_per_dof')) <= 2 && fOd <= 5, `${fitsInputs.length} FITS frames; ${fPlates.split(' scale')[0]}; ${fBias}; calibrator chi2/dof ${field(fCal, 'chi2_per_dof')}; COSMOS 2612 OD rms ${fOd} arcsec`);
await epochState.destroy();

fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ results, passes: video.passes, fitsPasses: fitsRun.passes, truth: truthSummary,
  rpo: { start: iso(startS), od: at0(fromOd), prior: at0(fromPrior), truth: fromTruth ? at0(fromTruth) : null } }, null, 1));
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.ok).length} checks passed, ${failures} failed (${((Date.now() - t0) / 1000).toFixed(0)} s); evidence in ${path.relative(process.cwd(), OUT)}`);
process.exit(failures === 0 ? 0 : 1);
