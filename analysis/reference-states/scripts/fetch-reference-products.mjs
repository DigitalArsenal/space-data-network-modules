#!/usr/bin/env node
// Fetches independent precise orbits and turns them into reference states:
// product -> files/orbit-products read_container -> reference_states, with
// IERS Earth orientation rows (data-source/eop-parser): EOP 20 C04, or with
// --eop finals the observed rows of finals2000A, for the Earth rotation.
//
//   node scripts/fetch-reference-products.mjs --from 2026-09-01 --to 2026-09-07 \
//     [--products gps,slr,slr-daily,sentinel1,swarm,doris,gfz-rso,cosmic2] \
//     [--local-archive DIR] [--out DIR]
//
// Products (all public):
//   gps        IGS final orbits (IGS0OPSFIN, 15 min, IGS20; ESA0OPSFIN, 5 min,
//              where BKG no longer holds the day), satellite
//              identity from the IGS satellite metadata SINEX (PRN -> SVN ->
//              COSPAR and catalog number, valid at the file's midpoint).
//   slr        ILRS combined orbits (ilrsa, weekly arcs) of LAGEOS-1/2 and
//              ETALON-1/2; the stated sigma is the RMS of the analysis
//              centres' orbits about the combination over the arc.
//   sentinel1  Copernicus Sentinel-1 precise orbits (AUX_POEORB, 10 s),
//              transcribed to SP3-c; the stated sigma is the mission's 5 cm
//              3D RMS precise-orbit requirement.
//   slr-daily  ILRS analysis-centre (NSGF) 4-day fitted arcs of Ajisai,
//              Starlette, Stella, LARETS, WESTPAC, LARES and LARES-2, one
//              arc every 4 days from --from (non-overlapping); the stated
//              sigma is the per-axis RMS of the arc's 3-day overlap with the
//              next day's arc. Their frame is written "ECF" with the comment
//              that it is ITRF, and is read as ITRF.
//   swarm      Swarm A, B and C precise orbits (TU Delft reduced-dynamic SP3,
//              10 s, IGc20) from the ESA Swarm dissemination server; the
//              stated sigma is the per-axis RMS of the kinematic minus the
//              reduced-dynamic orbit over the day.
//   doris      CNES SSALTO precise orbits distributed by the IDS (DORIS, with
//              GNSS where the type code is DG_; 60 s, TAI, ITRF) of CryoSat-2,
//              SARAL, Sentinel-3A/B and SWOT: 7- to 9-day arcs, each
//              overlapping the next by 2.5 to 3 hours.
//   gfz-rso    GFZ rapid science orbits (ISDC) of GRACE-FO 1 and 2 (codes L64,
//              L65): 14-hour arcs every 12 hours, 30 s, GPS time. Their
//              coordinate system is written "CTS", the conventional
//              terrestrial system, and is read as ITRF.
//   cosmic2    UCAR CDAAC near-real-time orbits of the COSMIC-2 spacecraft:
//              daily tarballs of overlapping SP3-c arcs about 2 hours long
//              (60 s, IGS08), named leoOrb_<yyyy>.<ddd>.<FM>.<nn>.
//   These three read copies already downloaded under --local-archive
//   (default /opt/data/sdn-archive/hac), each checked against the SHA-256 in
//   its .provenance.json, whose URL is the source; every arc that meets the
//   days --from to --to is converted. Their files state no accuracy and no
//   published figure is in the archive, so the stated sigma is the per-axis
//   RMS of the arc's overlap with the adjacent arc it overlaps longest: the
//   precision of consecutive fits.
// Output (outside the repository): DIR/products/ holds the downloads,
// DIR/reference/<product>/<norad>.oem the size-prefixed $OEM per object, and
// DIR/reference/<product>/index.json what each came from.
import { execFileSync } from 'node:child_process';
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
  products: { type: 'string', default: 'gps,slr,slr-daily,sentinel1,swarm' },
  out: { type: 'string', default: process.env.SDN_REFERENCE_CACHE ?? path.join(os.homedir(), '.cache', 'sdn-reference-states') },
  // c04: IERS EOP 20 C04 (final, about 30 days behind). finals: IERS finals2000A,
  // observed rows only, for truth newer than C04 reaches.
  eop: { type: 'string', default: 'c04' },
  // Already-downloaded copies, read by doris, gfz-rso and cosmic2.
  'local-archive': { type: 'string', default: '/opt/data/sdn-archive/hac' },
} });
if (!['c04', 'finals'].includes(values.eop)) throw new Error('--eop is c04 or finals.');
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
async function fetchCached(url, dir = 'products', name = path.basename(new URL(url).pathname)) {
  const file = path.join(out, dir, name);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  for (let attempt = 1; ; ++attempt) {
    const response = await fetch(url).catch((error) => ({ ok: false, status: error.message }));
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      // A server's "not found" page sent with status 200 is not the product.
      if (/\.gz$/i.test(name) && !(bytes[0] === 0x1f && bytes[1] === 0x8b)) return null;
      if (/\.zip$/i.test(name) && bytes.readUInt32LE(0) !== 0x04034b50) return null;
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
function unzipEntry(zip, suffix) {  // the entry whose name ends with suffix, via the central directory
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) --end;
  if (end < 0) return null;
  for (let at = zip.readUInt32LE(end + 16), k = zip.readUInt16LE(end + 10); k > 0; --k) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), n = zip.readUInt16LE(at + 28);
    const name = zip.toString('latin1', at + 46, at + 46 + n), local = zip.readUInt32LE(at + 42);
    at += 46 + n + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (!name.toLowerCase().endsWith(suffix)) continue;
    const data = zip.subarray(local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)).subarray(0, size);
    return method === 8 ? inflateRawSync(data) : Buffer.from(data);
  }
  return null;
}
function unzipFirst(zip) {  // one stored or deflated entry
  const name = zip.readUInt16LE(26), extra = zip.readUInt16LE(28), size = zip.readUInt32LE(18);
  const data = zip.subarray(30 + name + extra, 30 + name + extra + size);
  return zip.readUInt16LE(8) === 8 ? inflateRawSync(data) : Buffer.from(data);
}

// ── Earth orientation: IERS rows (C04 or observed finals2000A) bracketing each file ──
const EOP_URL = values.eop === 'c04' ? 'https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now' : 'https://datacenter.iers.org/data/9/finals2000A.all';
let eopRows = null;
// finals2000A up to the last row whose polar motion (column 17) and UT1-UTC
// (column 58) are both flagged I (IERS observed); predictions are dropped.
function observedFinals(body) {
  const lines = body.toString('latin1').split('\n');
  let last = -1;
  lines.forEach((l, i) => { if (l[16] === 'I' && l[57] === 'I') last = i; });
  return Buffer.from(`${lines.slice(0, last + 1).join('\n')}\n`);
}
async function earthOrientation(startMs, stopMs) {
  if (!eopRows) {
    const fetched = await fetchCached(EOP_URL);
    if (!fetched) throw new Error(`EOP source unavailable: ${EOP_URL}`);
    const body = values.eop === 'c04' ? fetched : observedFinals(fetched);
    const method = values.eop === 'c04' ? 'parse_c04' : 'parse_finals2000a';
    const h = await harness('data-source/eop-parser');
    const r = await h.invoke({ methodId: method, inputs: [{ portId: 'body', payload: body, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: body.length } }] });
    await h.destroy();
    if (r.statusCode !== 0) throw new Error(`${method}: ${r.errorMessage}`);
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
  if (!rows.length || rows[0].mjd > lo + 1 || rows.at(-1).mjd < hi - 1) return null;  // not yet published (or observed) that far
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
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify({ ...provenance, eop: EOP_URL, objects: index }, null, 1)}\n`);
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
  // The IGS combined final orbit from BKG's mirror; where BKG no longer holds
  // the day (older weeks), ESA's final orbit (an IGS analysis centre, 5 min).
  const day3 = `${d.getUTCFullYear()}${String(doy).padStart(3, '0')}`;
  let name = `IGS0OPSFIN_${day3}0000_01D_15M_ORB.SP3.gz`;
  let url = `https://igs.bkg.bund.de/root_ftp/IGS/products/${week}/${name}`;
  let gz = await fetchCached(url);
  if (!gz) {
    const esa = `ESA0OPSFIN_${day3}0000_01D_05M_ORB.SP3.gz`;
    const esaUrl = `https://navigation-office.esa.int/products/gnss-products/${week}/${esa}`;
    gz = await fetchCached(esaUrl);
    if (gz) { console.warn(`gps: ${name} not at BKG; using ${esa}`); name = esa; url = esaUrl; }
  }
  if (!gz) return console.warn(`gps: ${name} not published (BKG, ESA)`);
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
// Per-axis RMS (m) of b about a over the epochs both hold (sp3Positions maps).
function overlapRms(a, b) {
  let sum = 0, count = 0;
  for (const [epoch, r] of b) {
    const c = a.get(epoch);
    if (c) { sum += r.reduce((s, x, i) => s + (x - c[i]) ** 2, 0); count += 3; }
  }
  return { sigma: count ? Math.sqrt(sum / count) * 1000 : 0, epochs: count / 3 };
}
async function slr(arc) {
  const yymmdd = new Date(arc).toISOString().slice(2, 10).replaceAll('-', '');
  for (const [sat, identity] of Object.entries(SLR)) {
    const base = `https://edc.dgfi.tum.de/pub/slr/products/orbits/TRF/${sat}/20${yymmdd.slice(0, 2)}/${yymmdd}/`;  // EDC layout since October 2026
    const names = await listing(base, new RegExp(`[a-z]+\\.orb\\.${sat}\\.${yymmdd}\\.v\\d+\\.sp3\\.gz`, 'g'));
    // The combination with positions: EDC also lists versions published empty
    // (header only), so each is tried in version order.
    let combined = null, gz = null, sp3 = null, truth = null;
    for (const name of names.filter((n) => n.startsWith('ilrsa.')).sort()) {
      const bytes = await fetchCached(base + name);
      if (!bytes) continue;
      // ILRS writes its comment lines as "%/*"; SP3-c comments are "/*", and the
      // reader refuses unknown records. Only that prefix is rewritten.
      const text = gunzipSync(bytes).toString().replace(/^%\/\*/gm, '/* ');
      const positions = sp3Positions(text);
      if (!positions.size) continue;
      combined = name; gz = bytes; sp3 = Buffer.from(text); truth = positions;
      break;
    }
    if (!combined) { console.warn(`slr: no ilrsa arc with positions for ${sat} ${yymmdd}`); continue; }
    // Stated sigma: per-axis RMS of the analysis centres about the
    // combination (precision; shared data make it a lower bound on error).
    let sum = 0, count = 0;
    const centres = [];
    // The analysis centres' orbits of the combination's own version (EDC also holds other versions).
    const version = combined.split('.').at(-3);
    for (const n of names.filter((x) => x !== combined && x.split('.').at(-3) === version && !x.startsWith('ilrsb.'))) {
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

// ── SLR daily: NSGF 4-day arcs, sigma from the overlap with the next arc ──
const SLR_DAILY = { ajisai: { norad: 16908, objectId: '1986-061A', name: 'AJISAI' }, starlette: { norad: 7646, objectId: '1975-010A', name: 'STARLETTE' },
  stella: { norad: 22824, objectId: '1993-061B', name: 'STELLA' }, larets: { norad: 27944, objectId: '2003-042F', name: 'LARETS' },
  westpac: { norad: 25398, objectId: '1998-043E', name: 'WESTPAC' }, lares: { norad: 38077, objectId: '2012-006A', name: 'LARES' },
  lares2: { norad: 53105, objectId: '2022-080A', name: 'LARES-2' } };
const yymmdd = (ms) => new Date(ms).toISOString().slice(2, 10).replaceAll('-', '');
async function slrDaily(arcStart) {
  // The arc in file F spans F-4 00:00 to F-1; the next file's arc overlaps it by 3 days.
  for (const [sat, identity] of Object.entries(SLR_DAILY)) {
    // EDC layout since October 2026: rapid/<sat>/<yyyy>/<yymmdd>/, daily files, version v000.
    const file = (ms) => `https://edc.dgfi.tum.de/pub/slr/products/orbits/rapid/${sat}/${new Date(ms).getUTCFullYear()}/${yymmdd(ms)}/nsgf.orb.${sat}.${yymmdd(ms)}.v000.sp3.gz`;
    const gz = await fetchCached(file(arcStart + 4 * DAY));
    const next = await fetchCached(file(arcStart + 5 * DAY));
    if (!gz || !next) { console.warn(`slr-daily: ${sat} arc from ${yymmdd(arcStart)} or its successor not published`); continue; }
    const text = gunzipSync(gz).toString();
    if (!text.startsWith(`#cV${new Date(arcStart).toISOString().slice(0, 4)}`)) { console.warn(`slr-daily: ${sat} ${yymmdd(arcStart)} is not SP3-c`); continue; }
    const { sigma, epochs } = overlapRms(sp3Positions(text), sp3Positions(gunzipSync(next).toString()));
    if (epochs < 100) { console.warn(`slr-daily: ${sat} ${yymmdd(arcStart)} overlap too short to state a sigma`); continue; }
    const id = text.match(/^\+\s+1\s+(\S{3})/m)?.[1];
    const name = path.basename(new URL(file(arcStart + 4 * DAY)).pathname);
    // Header columns 47-51 carry the frame; "  ECF" is ITRF by the file's own comment.
    const sp3 = Buffer.from(text.replace(/^(#cV.{43})  ECF/, '$1ITRF '));
    const basis = `the per-axis RMS (${sigma.toFixed(4)} m) of this arc's overlap with the next day's arc (${epochs} epochs)`;
    const product = `${name} (SHA-256 ${sha256(gunzipSync(gz))}, coordinate system "ECF" read as ITRF per the file's comment)`;
    await referenceStates(name.replace('.sp3.gz', ''), sp3, { product, source: file(arcStart + 4 * DAY), statedSigmaM: sigma, statedSigmaBasis: basis, satellites: { [id]: identity } },
      { product: name, url: file(arcStart + 4 * DAY), sha256: sha256(gz), statedSigmaM: sigma, statedSigmaBasis: basis });
  }
}

// ── Swarm: TU Delft reduced-dynamic orbits, sigma from kinematic minus reduced-dynamic ──
const SWARM = { A: { norad: 39452, objectId: '2013-067B', name: 'SWARM A' }, B: { norad: 39451, objectId: '2013-067A', name: 'SWARM B' },
  C: { norad: 39453, objectId: '2013-067C', name: 'SWARM C' } };
const SWARM_SERVER = 'https://swarm-diss.eo.esa.int/';
const swarmListings = new Map();
async function swarmList(dir) {
  if (!swarmListings.has(dir)) {
    const response = await fetch(`${SWARM_SERVER}?do=list&maxfiles=10000&pos=0&file=${encodeURIComponent(dir)}`).catch(() => null);
    swarmListings.set(dir, response?.ok ? (await response.json()).results.map((r) => r.name) : []);
  }
  return swarmListings.get(dir);
}
async function swarmFile(dir, pattern) {
  const name = (await swarmList(dir)).filter((n) => pattern.test(n)).sort().at(-1);
  if (!name) return null;
  const url = `${SWARM_SERVER}?do=download&file=${encodeURIComponent(`${dir}/${name}`)}`;
  const zip = await fetchCached(url, 'products', name);
  return zip && { name, url, zip, sp3: unzipEntry(zip, '.sp3') };
}
async function swarm(day) {
  const d = new Date(day - DAY).toISOString().slice(0, 10).replaceAll('-', '');  // files run 23:59:42 the day before to the day's end
  for (const [sat, identity] of Object.entries(SWARM)) {
    const span = new RegExp(`^SW_OPER_SP3${sat}(COM|RD_)_2__${d}T235942_`);
    const rd = await swarmFile(`swarm/Level2daily/Latest_baselines/POD/RD/Sat_${sat}`, span);
    const kin = await swarmFile(`swarm/Level2daily/Latest_baselines/POD/KIN/Sat_${sat}`, new RegExp(`^SW_OPER_SP3${sat}KIN_2__${d}T235942_`));
    if (!rd?.sp3 || !kin?.sp3) { console.warn(`swarm: Swarm ${sat} ${d} not published (reduced-dynamic and kinematic both needed)`); continue; }
    const truth = sp3Positions(rd.sp3.toString());
    let sum = 0, count = 0, excluded = 0;
    for (const [epoch, r] of sp3Positions(kin.sp3.toString())) {
      const c = truth.get(epoch);
      if (!c) continue;
      const d2 = r.reduce((a, x, i) => a + (x - c[i]) ** 2, 0);
      if (d2 > 1e-6) { ++excluded; continue; }  // kinematic outliers beyond 1 m
      sum += d2;
      count += 3;
    }
    if (count < 300) { console.warn(`swarm: Swarm ${sat} ${d} has too few kinematic epochs to state a sigma`); continue; }
    const sigma = Math.sqrt(sum / count) * 1000;
    const id = rd.sp3.toString().match(/^\+\s+1\s+(\S{3})/m)?.[1];
    const basis = `the per-axis RMS (${sigma.toFixed(4)} m) of the kinematic minus reduced-dynamic Swarm ${sat} orbit over the day ` +
      `(${count / 3} epochs, ${excluded} beyond 1 m excluded); kinematic noise dominates it`;
    const product = `${rd.name} (SP3 SHA-256 ${sha256(rd.sp3)})`;
    await referenceStates(rd.name.replace('.ZIP', ''), rd.sp3, { product, source: rd.url, statedSigmaM: sigma, statedSigmaBasis: basis, satellites: { [id]: identity } },
      { product: rd.name, url: rd.url, sha256: sha256(rd.zip), kinematic: kin.name, statedSigmaM: sigma, statedSigmaBasis: basis });
  }
}

// ── local copies (--local-archive): each file with a .provenance.json (url, sha256) ──
function localCopy(file) {
  const bytes = fs.readFileSync(file);
  const { url, sha256: recorded } = JSON.parse(fs.readFileSync(`${file}.provenance.json`));
  if (sha256(bytes) !== recorded) { console.warn(`${path.basename(file)}: SHA-256 differs from its provenance record`); return null; }
  return { bytes, url, sha256: recorded };
}
function untar(tar) {  // ustar: [name, bytes] of each regular file
  const files = [];
  for (let at = 0; at + 512 <= tar.length && tar[at];) {
    const size = parseInt(tar.toString('latin1', at + 124, at + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    if (tar[at + 156] === 0x30 || tar[at + 156] === 0) files.push([tar.toString('latin1', at, at + 100).replace(/\0.*$/s, ''), tar.subarray(at + 512, at + 512 + size)]);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
// arcs: one satellite's arcs in time order, { name, file, start, stop, read() ->
// { sp3, sp3Sha256, url, sha256 } }. Each arc meeting [lo, hi) becomes a product
// whose stated sigma is the per-axis RMS of its overlap with the adjacent arc
// (previous or next) it overlaps longest, over at least minEpochs epochs. An
// identical neighbour is not an independent fit and is passed over.
async function localArcs(arcs, lo, hi, minEpochs, identity, note = '') {
  const cache = new Map();
  const load = (i) => {
    if (!cache.has(i)) { const copy = arcs[i].read(); cache.set(i, copy && { ...copy, rows: sp3Positions(copy.sp3.toString()) }); }
    return cache.get(i);
  };
  for (let i = 0; i < arcs.length; ++i) {
    if (arcs[i].stop <= lo || arcs[i].start >= hi) continue;
    for (const k of cache.keys()) if (k < i - 1) cache.delete(k);
    const own = load(i);
    if (!own) continue;
    let best = null;
    for (const j of [i - 1, i + 1]) {
      const o = arcs[j] && load(j) && overlapRms(own.rows, load(j).rows);
      if (o && o.sigma > 0 && o.epochs >= minEpochs && o.epochs > (best?.epochs ?? 0)) best = { ...o, arc: arcs[j].name };
    }
    if (!best) { console.warn(`${arcs[i].name}: no adjacent arc overlaps it by ${minEpochs} epochs; no sigma can be stated`); continue; }
    const id = own.sp3.toString().match(/^\+\s+1\s+(\S{3})/m)?.[1];
    const basis = `the per-axis RMS (${best.sigma.toFixed(4)} m) of this arc's overlap with the adjacent arc ${best.arc} (${best.epochs} epochs), ` +
      'the precision of consecutive fits: the file states no accuracy and no published figure for the product is in the local archive';
    const product = `${arcs[i].file} (SP3 SHA-256 ${own.sp3Sha256}${note})`;
    await referenceStates(arcs[i].name, own.sp3, { product, source: own.url, statedSigmaM: best.sigma, statedSigmaBasis: basis, satellites: { [id]: identity } },
      { product: arcs[i].file, ...arcs[i].provenance, url: own.url, sha256: own.sha256, statedSigmaM: best.sigma, statedSigmaBasis: basis });
  }
}

// ── DORIS: CNES SSALTO precise orbits (IDS), ssa<sat><version>.b<yyddd>.e<yyddd>.<type>.sp3.<nnn>.Z ──
const DORIS = { cs2: { norad: 36508, objectId: '2010-013A', name: 'CRYOSAT 2' }, srl: { norad: 39086, objectId: '2013-009A', name: 'SARAL' },
  s3a: { norad: 41335, objectId: '2016-011A', name: 'SENTINEL 3A' }, s3b: { norad: 43437, objectId: '2018-039A', name: 'SENTINEL 3B' },
  swo: { norad: 54754, objectId: '2022-173A', name: 'SWOT' } };
const yyddd = (s) => Date.UTC(2000 + Number(s.slice(0, 2)), 0, Number(s.slice(2)));
async function doris(lo, hi) {
  const dir = path.join(values['local-archive'], 'ids-doris', 'ssa');
  const names = fs.readdirSync(dir).filter((n) => /^ssa\w{5}\.b\d{5}\.e\d{5}\.\w{3}\.sp3\.\d{3}\.Z$/.test(n)).sort();
  for (const [sat, identity] of Object.entries(DORIS)) {
    // One arc per first day, the latest version; .Z (LZW) is read by gzip.
    const byStart = new Map(names.filter((n) => n.slice(3, 6) === sat).map((n) => [n.slice(10, 15), n]));
    const arcs = [...byStart].sort().map(([b, file]) => ({ name: file.replace(/\.sp3\.\d{3}\.Z$/, ''), file, start: yyddd(b), stop: yyddd(file.slice(17, 22)) + DAY,
      read: () => {
        const copy = localCopy(path.join(dir, file));
        const sp3 = copy && execFileSync('gzip', ['-dc'], { input: copy.bytes, maxBuffer: 1 << 28 });
        return copy && { ...copy, sp3, sp3Sha256: sha256(sp3) };
      } }));
    await localArcs(arcs, lo, hi, 100, identity);
  }
}

// ── GRACE-FO: GFZ rapid science orbits (ISDC), GFZOP_RSO_<code>_G_<start>_<stop>_v<nn>.sp3.gz ──
// L64's positions are those of ESA's GRACE-FO 1 density product (DNS1ACC);
// L65 is the other satellite.
const GFZ_RSO = { L64: { norad: 43476, objectId: '2018-047A', name: 'GRACE-FO 1' }, L65: { norad: 43477, objectId: '2018-047B', name: 'GRACE-FO 2' } };
const stamp = (s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
async function gfzRso(lo, hi) {
  for (const [code, identity] of Object.entries(GFZ_RSO)) {
    const dir = path.join(values['local-archive'], 'gfz-isdc-rso', 'RSO', code);
    const names = fs.readdirSync(dir).filter((n) => /^GFZOP_RSO_L\d\d_G_\d{8}_\d{6}_\d{8}_\d{6}_v\d\d\.sp3\.gz$/.test(n)).sort();
    const byStart = new Map(names.map((n) => [n.slice(16, 31), n]));  // the latest version
    const arcs = [...byStart].sort().map(([start, file]) => ({ name: file.replace('.sp3.gz', ''), file, start: stamp(start), stop: stamp(file.slice(32, 47)),
      read: () => {
        const copy = localCopy(path.join(dir, file));
        const text = copy && gunzipSync(copy.bytes);
        // Header columns 47-51 carry the frame; "CTS  " is the conventional terrestrial system.
        return copy && { ...copy, sp3: Buffer.from(text.toString().replace(/^(#[cd][PV].{43})CTS  /, '$1ITRF ')), sp3Sha256: sha256(text) };
      } }));
    await localArcs(arcs, lo, hi, 100, identity, ', coordinate system "CTS" read as ITRF');
  }
}

// ── COSMIC-2: UCAR CDAAC near-real-time LEO orbits, leoOrb_nrt_<yyyy>_<ddd>.tar.gz ──
// Members leoOrb_<yyyy>.<ddd>.<FM>.<nn>_<...>_sp3, FM the spacecraft number.
const COSMIC2 = { '001': { norad: 44349, objectId: '2019-036L', name: 'FORMOSAT7-1/COSMIC2-1' }, '002': { norad: 44351, objectId: '2019-036N', name: 'FORMOSAT7-2/COSMIC2-2' },
  '003': { norad: 44343, objectId: '2019-036E', name: 'FORMOSAT7-3/COSMIC2-3' }, '004': { norad: 44350, objectId: '2019-036M', name: 'FORMOSAT7-4/COSMIC2-4' },
  '005': { norad: 44358, objectId: '2019-036V', name: 'FORMOSAT7-5/COSMIC2-5' }, '006': { norad: 44353, objectId: '2019-036Q', name: 'FORMOSAT7-6/COSMIC2-6' } };
async function cosmic2(lo, hi) {
  const dir = path.join(values['local-archive'], 'ucar-cosmic2', 'nrt-leoOrb');
  const opened = new Map();  // the last few tarballs read
  const tarball = (name) => {
    if (!opened.has(name)) {
      const copy = localCopy(path.join(dir, name));
      opened.set(name, copy && { ...copy, files: new Map(untar(gunzipSync(copy.bytes))) });
      if (opened.size > 3) opened.delete(opened.keys().next().value);
    }
    return opened.get(name);
  };
  const byFm = new Map();
  // A day's tarball holds the arcs that begin from about 22:00 the day before.
  for (let day = lo - DAY; day <= hi; day += DAY) {
    const d = new Date(day), doy = Math.round((day - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
    const name = `leoOrb_nrt_${d.getUTCFullYear()}_${String(doy).padStart(3, '0')}.tar.gz`;
    const t = fs.existsSync(path.join(dir, name)) ? tarball(name) : null;
    if (!t) { console.warn(`cosmic2: ${name} is not in the local archive`); continue; }
    for (const [member, bytes] of t.files) {
      const file = path.basename(member);
      if (!file.endsWith('_sp3')) continue;
      const [line1, line2] = bytes.toString('latin1', 0, 160).split('\n');
      const f = line1.slice(3, 31).trim().split(/\s+/).map(Number);
      const start = Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5]);
      const fm = file.split('.')[2];
      if (!byFm.has(fm)) byFm.set(fm, []);
      byFm.get(fm).push({ name: file.replace(/_sp3$/, ''), file, start, stop: start + (Number(line1.slice(32, 39)) - 1) * Number(line2.slice(24, 38)) * 1000,
        provenance: { tarball: name },
        read: () => { const copy = tarball(name), sp3 = copy?.files.get(member); return sp3 && { url: copy.url, sha256: copy.sha256, sp3, sp3Sha256: sha256(sp3) }; } });
    }
  }
  for (const [fm, arcs] of [...byFm].sort()) {
    if (!COSMIC2[fm]) { console.warn(`cosmic2: spacecraft ${fm} has no catalogued identity here`); continue; }
    await localArcs(arcs.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name)), lo, hi, 60, COSMIC2[fm]);
  }
}

let arcs = null;
for (let day = from; day <= to; day += DAY) {
  if (products.has('swarm')) await swarm(day);
  if (products.has('slr-daily') && (day - from) % (4 * DAY) === 0) await slrDaily(day);
  if (products.has('gps')) await gps(day);
  if (products.has('sentinel1')) await sentinel1(day);
  // ILRS arcs are named by their last day, one each week.
  if (products.has('slr')) {
    const yymmdd = new Date(day).toISOString().slice(2, 10).replaceAll('-', '');
    const years = [...new Set([new Date(from).getUTCFullYear(), new Date(to).getUTCFullYear()])];
    arcs ??= (await Promise.all(years.map((y) => listing(`https://edc.dgfi.tum.de/pub/slr/products/orbits/TRF/lageos1/${y}/`, /lageos1\/\d{4}\/(\d{6})/g)))).flat();
    if (arcs.some((x) => x.endsWith(yymmdd))) await slr(day);
  }
}
// Local arcs that meet the days --from to --to.
if (products.has('doris')) await doris(from, to + DAY);
if (products.has('gfz-rso')) await gfzRso(from, to + DAY);
if (products.has('cosmic2')) await cosmic2(from, to + DAY);
await reader?.destroy();
await reference?.destroy();
