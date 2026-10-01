#!/usr/bin/env node
// Fetches independent precise orbits and turns them into reference states:
// product -> files/orbit-products read_container -> reference_states, with
// IERS EOP 20 C04 rows (data-source/eop-parser) for the Earth rotation.
//
//   node scripts/fetch-reference-products.mjs --from 2026-09-01 --to 2026-09-07 \
//     [--products gps,slr,sentinel1] [--out DIR]
//
// Products (all public):
//   gps        IGS final orbits (IGS0OPSFIN, 15 min, IGS20), satellite
//              identity from the IGS satellite metadata SINEX (PRN -> SVN ->
//              COSPAR and catalog number, valid at the file's midpoint).
//   slr        ILRS combined orbits (ilrsa, weekly arcs) of LAGEOS-1/2 and
//              ETALON-1/2; the stated sigma is the RMS of the analysis
//              centres' orbits about the combination over the arc.
//   sentinel1  Copernicus Sentinel-1 precise orbits (AUX_POEORB, 10 s),
//              transcribed to SP3-c; the stated sigma is the mission's 5 cm
//              3D RMS precise-orbit requirement.
// Output (outside the repository): DIR/products/ holds the downloads,
// DIR/reference/<product>/<norad>.oem the size-prefixed $OEM per object, and
// DIR/reference/<product>/index.json what each came from.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const { values } = parseArgs({ options: {
  from: { type: 'string' }, to: { type: 'string' },
  products: { type: 'string', default: 'gps,slr,sentinel1' },
  out: { type: 'string', default: process.env.SDN_REFERENCE_CACHE ?? path.join(os.homedir(), '.cache', 'sdn-reference-states') },
} });
if (!values.from || !values.to) throw new Error('--from and --to (YYYY-MM-DD) are required.');
const DAY = 86400000;
const from = Date.parse(`${values.from}T00:00:00Z`), to = Date.parse(`${values.to}T00:00:00Z`);
if (!(to >= from)) throw new Error('--to must not precede --from.');
const out = path.resolve(values.out);
const products = new Set(values.products.split(','));

const sdsRoot = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const flatbuffers = createRequire(path.join(sdsRoot, 'package.json'))('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(sdsRoot, `lib/js/${code}/main.js`)));
const [OEM, NCD, EOP] = await Promise.all(['OEM', 'NCD', 'EOP'].map(load));
const modules = new URL('../../../', import.meta.url);
async function harness(dir) {
  const wasmSource = fs.readFileSync(new URL(`${dir}/dist/isomorphic/module.wasm`, modules));
  const manifest = JSON.parse(fs.readFileSync(new URL(`${dir}/plugin-manifest.json`, modules)));
  return createBrowserModuleHarness({ wasmSource, manifest, surface: 'direct' });
}
const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ── downloads, cached by URL basename ──
async function fetchCached(url, dir = 'products') {
  const file = path.join(out, dir, path.basename(new URL(url).pathname));
  if (fs.existsSync(file)) return fs.readFileSync(file);
  for (let attempt = 1; ; ++attempt) {
    const response = await fetch(url).catch((error) => ({ ok: false, status: error.message }));
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return bytes;
    }
    if (response.status === 404 || attempt === 3) return null;
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}
async function listing(url, pattern) {
  const response = await fetch(url).catch(() => null);
  if (!response?.ok) return [];
  return [...new Set((await response.text()).match(pattern) ?? [])];
}
function unzipFirst(zip) {  // one stored or deflated entry
  const name = zip.readUInt16LE(26), extra = zip.readUInt16LE(28), size = zip.readUInt32LE(18);
  const data = zip.subarray(30 + name + extra, 30 + name + extra + size);
  return zip.readUInt16LE(8) === 8 ? inflateRawSync(data) : Buffer.from(data);
}

// ── Earth orientation: IERS EOP 20 C04, rows bracketing each file ──
const C04_URL = 'https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now';
let eopRows = null;
async function earthOrientation(startMs, stopMs) {
  if (!eopRows) {
    const body = await fetchCached(C04_URL);
    if (!body) throw new Error(`EOP source unavailable: ${C04_URL}`);
    const h = await harness('data-source/eop-parser');
    const r = await h.invoke({ methodId: 'parse_c04', inputs: [{ portId: 'body', payload: body, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: body.length } }] });
    await h.destroy();
    if (r.statusCode !== 0) throw new Error(`parse_c04: ${r.errorMessage}`);
    const stream = Buffer.from(r.outputs.find((o) => o.portId === 'records').payload);
    eopRows = [];
    for (let at = 0; at < stream.length;) {
      const n = stream.readUInt32LE(at);
      const bytes = stream.subarray(at, at + 4 + n);
      eopRows.push({ mjd: EOP.EOP.getRootAsEOP(new flatbuffers.ByteBuffer(new Uint8Array(bytes.subarray(4)))).MJD(), bytes });
      at += 4 + n;
    }
  }
  const lo = Math.floor(startMs / DAY) + 40587 - 1, hi = Math.ceil(stopMs / DAY) + 40587 + 1;
  const rows = eopRows.filter((row) => row.mjd >= lo && row.mjd <= hi);
  if (!rows.length || rows[0].mjd > lo + 1 || rows.at(-1).mjd < hi - 1) return null;  // C04 not yet published that far
  return { portId: 'earth_orientation', payload: Buffer.concat(rows.map((row) => row.bytes)), typeRef: typeRef('EOP') };
}

// ── product -> reference states ──
let reader, reference;
function frameOf(bytes) {  // [u32 n][$NCD][container], as read_container takes it
  const b = new flatbuffers.Builder(1024);
  const sha = b.createString(sha256(bytes));
  NCD.NCD.startNCD(b);
  NCD.NCD.addSourceByteLength(b, BigInt(bytes.length));
  NCD.NCD.addSourceSha256(b, sha);
  NCD.NCD.finishSizePrefixedNCDBuffer(b, NCD.NCD.endNCD(b));
  return Buffer.concat([Buffer.from(b.asUint8Array()), bytes]);
}
async function referenceStates(key, sp3, identities, provenance) {
  reader ??= await harness('files/orbit-products');
  reference ??= await harness('analysis/reference-states');
  const read = await reader.invoke({ methodId: 'read_container', inputs: [{ portId: 'container', payload: frameOf(sp3), typeRef: typeRef('NCD') }] });
  if (read.statusCode !== 0) return console.warn(`${key}: read_container: ${read.errorMessage}`);
  const port = (id, code) => ({ portId: id, payload: Buffer.from(read.outputs.find((o) => o.portId === id).payload), typeRef: typeRef(code) });
  const ncd = NCD.NCD.getSizePrefixedRootAsNCD(new flatbuffers.ByteBuffer(new Uint8Array(port('descriptor', 'NCD').payload)));
  const start = Date.parse(`${ncd.START_TIME()?.slice(0, 19)}Z`), stop = Date.parse(`${ncd.STOP_TIME()?.slice(0, 19)}Z`);
  const eop = await earthOrientation(start, stop);
  if (!eop) return console.warn(`${key}: no C04 rows bracket ${ncd.START_TIME()} .. ${ncd.STOP_TIME()}`);
  const r = await reference.invoke({ methodId: 'reference_states', inputs: [port('ephemeris', 'OEM'), port('descriptor', 'NCD'), eop,
    { portId: 'identities', payload: Buffer.from(JSON.stringify(identities)), typeRef: { schemaName: 'application/json' } }] });
  if (r.statusCode !== 0) return console.warn(`${key}: reference_states: ${r.errorMessage}`);
  const dir = path.join(out, 'reference', key);
  fs.mkdirSync(dir, { recursive: true });
  const index = [];
  for (const o of r.outputs.filter((x) => x.portId === 'reference')) {
    const bytes = Buffer.from(o.payload);
    const block = OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).EPHEMERIS_DATA_BLOCK(0);
    const norad = block.OBJECT().NORAD_CAT_ID();
    fs.writeFileSync(path.join(dir, `${norad}.oem`), bytes);
    index.push({ norad, objectId: block.OBJECT().OBJECT_ID(), start: block.START_TIME(), stop: block.STOP_TIME(),
      epochs: block.ephemerisDataLinesLength(), file: `${norad}.oem`, comment: block.COMMENT() });
  }
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify({ ...provenance, eop: C04_URL, objects: index }, null, 1)}\n`);
  console.log(`${key}: ${index.length} objects`);
}

// ── GPS: IGS final orbits ──
const SINEX_URL = 'https://files.igs.org/pub/station/general/igs_satellite_metadata.snx';
async function gnssIdentities(midMs) {
  const text = (await fetchCached(SINEX_URL))?.toString();
  if (!text) throw new Error(`IGS satellite metadata unavailable: ${SINEX_URL}`);
  const block = (name) => text.split(`+${name}`)[1].split(`-${name}`)[0].split('\n').filter((l) => l.startsWith(' '));
  const ids = new Map(block('SATELLITE/IDENTIFIER').map((l) => [l.slice(1, 5), { cospar: l.slice(6, 15).trim(), satcat: Number(l.slice(16, 22)), block: l.slice(23, 38).trim() }]));
  const sinexTime = (t) => (t.startsWith('0000') ? Infinity : Date.UTC(Number(t.slice(0, 4)), 0, 1) + (Number(t.slice(5, 8)) - 1) * DAY + Number(t.slice(9, 14)) * 1000);
  const satellites = {};
  for (const l of block('SATELLITE/PRN')) {
    const svn = l.slice(1, 5), prn = l.slice(36, 39);
    if (sinexTime(l.slice(6, 20)) <= midMs && midMs < sinexTime(l.slice(21, 35)) && ids.get(svn)?.satcat)
      satellites[prn] = { norad: ids.get(svn).satcat, objectId: ids.get(svn).cospar, name: `${svn} ${ids.get(svn).block}` };
  }
  return { satellites, sinexSha256: sha256(Buffer.from(text)) };
}
async function gps(day) {
  const d = new Date(day), doy = Math.round((day - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
  const week = Math.floor((day - Date.UTC(1980, 0, 6)) / (7 * DAY));
  const name = `IGS0OPSFIN_${d.getUTCFullYear()}${String(doy).padStart(3, '0')}0000_01D_15M_ORB.SP3.gz`;
  const url = `https://igs.bkg.bund.de/root_ftp/IGS/products/${week}/${name}`;
  const gz = await fetchCached(url);
  if (!gz) return console.warn(`gps: ${name} not published`);
  const sp3 = gunzipSync(gz);
  const { satellites, sinexSha256 } = await gnssIdentities(day + DAY / 2);
  await referenceStates(name.replace('.SP3.gz', ''), sp3, { product: name, source: url, satellites },
    { product: name, url, sha256: sha256(gz), identities: SINEX_URL, identitiesSha256: sinexSha256 });
}

// ── SLR: ILRS combined weekly arcs ──
const SLR = { lageos1: { norad: 8820, objectId: '1976-039A', name: 'LAGEOS 1' }, lageos2: { norad: 22195, objectId: '1992-070B', name: 'LAGEOS 2' },
  etalon1: { norad: 19751, objectId: '1989-001C', name: 'ETALON 1' }, etalon2: { norad: 20026, objectId: '1989-039C', name: 'ETALON 2' } };
function sp3Positions(text) {  // epoch -> km position of the file's one satellite
  const rows = new Map();
  let epoch = null;
  for (const l of text.split('\n')) {
    if (l.startsWith('* ')) epoch = l.slice(3, 31).trim();
    else if (l.startsWith('P') && epoch) {
      const r = [l.slice(4, 18), l.slice(18, 32), l.slice(32, 46)].map(Number);
      if (r.some((x) => x !== 0)) rows.set(epoch, r);
    }
  }
  return rows;
}
async function slr(arc) {
  const yymmdd = new Date(arc).toISOString().slice(2, 10).replaceAll('-', '');
  for (const [sat, identity] of Object.entries(SLR)) {
    const base = `https://edc.dgfi.tum.de/pub/slr/products/orbits/${sat}/${yymmdd}/`;
    const names = await listing(base, new RegExp(`[a-z]+\\.orb\\.${sat}\\.${yymmdd}\\.v\\d+\\.sp3\\.gz`, 'g'));
    const combined = names.find((n) => n.startsWith('ilrsa.'));
    if (!combined) { console.warn(`slr: no ilrsa arc for ${sat} ${yymmdd}`); continue; }
    const gz = await fetchCached(base + combined);
    // ILRS writes its comment lines as "%/*"; SP3-c comments are "/*", and the
    // reader refuses unknown records. Only that prefix is rewritten.
    const sp3 = Buffer.from(gunzipSync(gz).toString().replace(/^%\/\*/gm, '/* '));
    // Stated sigma: per-axis RMS of the analysis centres about the
    // combination (precision; shared data make it a lower bound on error).
    const truth = sp3Positions(sp3.toString());
    let sum = 0, count = 0;
    const centres = [];
    for (const n of names.filter((x) => x !== combined)) {
      const ac = await fetchCached(base + n);
      if (!ac) continue;
      centres.push(n.split('.')[0]);
      for (const [epoch, r] of sp3Positions(gunzipSync(ac).toString())) {
        const c = truth.get(epoch);
        if (c) { sum += r.reduce((s, x, i) => s + (x - c[i]) ** 2, 0); count += 3; }
      }
    }
    if (count < 300) { console.warn(`slr: ${sat} ${yymmdd} has too few analysis-centre epochs to state a sigma`); continue; }
    const sigma = Math.sqrt(sum / count) * 1000;
    const id = sp3.toString().match(/^\+\s+1\s+(\S{3})/m)?.[1];
    const basis = `the per-axis RMS (${sigma.toFixed(4)} m) of the ${centres.join(', ')} analysis-centre orbits about the ILRS combination over the arc`;
    const product = `${combined} (SHA-256 ${sha256(gunzipSync(gz))}, comment prefix "%/*" read as "/*")`;
    await referenceStates(combined.replace('.sp3.gz', ''), sp3, { product, source: base + combined, statedSigmaM: sigma, statedSigmaBasis: basis, satellites: { [id]: identity } },
      { product: combined, url: base + combined, sha256: sha256(gz), statedSigmaM: sigma, statedSigmaBasis: basis });
  }
}

// ── Sentinel-1: AUX_POEORB transcribed to SP3-c ──
const S1 = { S1A: { norad: 39634, objectId: '2014-016A', name: 'SENTINEL 1A' }, S1C: { norad: 62261, objectId: '2024-235A', name: 'SENTINEL 1C' },
  S1D: { norad: 66315, objectId: '2025-251A', name: 'SENTINEL-1D' } };
const S1_SIGMA_M = 0.05 / Math.sqrt(3);
const S1_BASIS = 'the Sentinel-1 precise-orbit (AUX_POEORB) accuracy requirement, 5 cm 3D RMS, as a per-axis sigma';
function eofToSp3(xml, id) {
  const osv = [...xml.matchAll(/<UTC>UTC=([^<]+)<\/UTC>[\s\S]*?<X unit="m">([^<]+)<\/X>\s*<Y unit="m">([^<]+)<\/Y>\s*<Z unit="m">([^<]+)<\/Z>\s*<VX unit="m\/s">([^<]+)<\/VX>\s*<VY unit="m\/s">([^<]+)<\/VY>\s*<VZ unit="m\/s">([^<]+)<\/VZ>\s*<Quality>([^<]+)</g)]
    .filter((m) => m[8] === 'NOMINAL');
  if (osv.length < 10) return null;
  const pad = (v, w) => String(v).padStart(w), fix = (v, w, d) => Number(v).toFixed(d).padStart(w);
  const stamp = (iso) => { const [d, t] = iso.split('T'); const [y, mo, da] = d.split('-'); const [h, mi, s] = t.split(':');
    return `${y} ${pad(Number(mo), 2)} ${pad(Number(da), 2)} ${pad(Number(h), 2)} ${pad(Number(mi), 2)} ${fix(s, 11, 8)}`; };
  const t0 = Date.parse(`${osv[0][1]}Z`), step = (Date.parse(`${osv[1][1]}Z`) - t0) / 1000;
  const gps = (t0 - Date.UTC(1980, 0, 6)) / 1000, week = Math.floor(gps / 604800);  // on the file's own scale, as ILRS UTC files do
  const lines = [`#cV${stamp(osv[0][1])} ${pad(osv.length, 7)} ORBIT ITRF  FIT OPOD`,
    `## ${pad(week, 4)} ${fix(gps - week * 604800, 15, 8)} ${fix(step, 14, 8)} ${pad(Math.floor(t0 / DAY) + 40587, 5)} ${fix((t0 % DAY) / DAY, 15, 13)}`,
    `+    1   ${id}${'  0'.repeat(16)}`, ...Array(4).fill(`+        ${'  0'.repeat(17)}`), ...Array(5).fill(`++       ${'  0'.repeat(17)}`),
    '%c L  cc UTC ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc', '%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
    '%f  0.0000000  0.000000000  0.00000000000  0.000000000000000', '%f  0.0000000  0.000000000  0.00000000000  0.000000000000000',
    '%i    0    0    0    0      0      0      0      0         0', '%i    0    0    0    0      0      0      0      0         0',
    '/* AUX_POEORB EARTH_FIXED STATES TRANSCRIBED TO SP3-C', '/* POSITIONS KM, VELOCITIES DM/S, UTC', '/* NOMINAL-QUALITY STATES ONLY', '/* '];
  for (const m of osv) {
    lines.push(`*  ${stamp(m[1])}`);
    lines.push(`P${id}${[m[2], m[3], m[4]].map((x) => fix(Number(x) / 1000, 14, 6)).join('')}${fix(999999.999999, 14, 6)}`);
    lines.push(`V${id}${[m[5], m[6], m[7]].map((x) => fix(Number(x) * 10, 14, 6)).join('')}${fix(999999.999999, 14, 6)}`);
  }
  lines.push('EOF');
  return Buffer.from(`${lines.join('\n')}\n`);
}
async function sentinel1(day) {
  const d = new Date(day), month = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const validity = `V${d.toISOString().slice(0, 10).replaceAll('-', '')}T`;  // files valid from 22:59:42 the day before
  for (const [unit, identity] of Object.entries(S1)) {
    const base = `https://step.esa.int/auxdata/orbits/Sentinel-1/POEORB/${unit}/${month}/`;
    const names = (await listing(base, /S1[A-D]_OPER_AUX_POEORB_OPOD_\w+?\.EOF\.zip/g)).filter((n) => {
      const start = n.match(/_V(\d{8})T/)?.[1];
      return start && Date.parse(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z`) === day - DAY;
    });
    if (!names.length) continue;
    const name = names.sort().at(-1);  // the latest issue
    const zip = await fetchCached(base + name);
    const eof = unzipFirst(zip);
    const sp3 = eofToSp3(eof.toString(), 'L99');
    if (!sp3) { console.warn(`sentinel1: ${name} has fewer than 10 nominal states`); continue; }
    const product = `${name.replace('.zip', '')} (SHA-256 ${sha256(eof)}), transcribed to SP3-c`;
    await referenceStates(`${name.replace('.EOF.zip', '')}`, sp3, { product, source: base + name, statedSigmaM: S1_SIGMA_M, statedSigmaBasis: S1_BASIS, satellites: { L99: identity } },
      { product: name, url: base + name, sha256: sha256(zip), eofSha256: sha256(eof), statedSigmaM: S1_SIGMA_M, statedSigmaBasis: S1_BASIS, validity });
  }
}

let arcs = null;
for (let day = from; day <= to; day += DAY) {
  if (products.has('gps')) await gps(day);
  if (products.has('sentinel1')) await sentinel1(day);
  // ILRS arcs are named by their last day, one each week.
  if (products.has('slr')) {
    const yymmdd = new Date(day).toISOString().slice(2, 10).replaceAll('-', '');
    arcs ??= await listing('https://edc.dgfi.tum.de/pub/slr/products/orbits/lageos1/', /lageos1\/(\d{6})/g);
    if (arcs.some((x) => x.endsWith(yymmdd))) await slr(day);
  }
}
await reader?.destroy();
await reference?.destroy();
