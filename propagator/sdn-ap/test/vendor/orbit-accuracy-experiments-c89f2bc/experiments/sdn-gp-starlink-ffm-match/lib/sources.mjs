// The ephemerides of the experiment as objects { source, id, norad, name, objectId, originator, creation, frame,
// timeSystem, lines: [{epoch, r, v}], t } with positions in km and velocities in km/s. Precise orbits are read from the
// archive's reference states (GCRF $OEM made by analysis/reference-states from the products' SP3, Earth orientation
// applied); operator files are parsed in memory and never written. Source selection follows modules
// propagator/sgp4-xp tests/measure/lib/sources.mjs so windows compare with that measurement.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { OEM, flatbuffers, blockLines } from './sds.mjs';
import { ms, withT } from './windows.mjs';
import { store } from '../common.mjs';
import { gate } from '../../../harness/truth-gate.mjs';

export const ARCHIVE = process.env.SDN_ARCHIVE ?? '/opt/data/sdn-archive';
const referenceRoot = path.join(ARCHIVE, 'reference-states/reference');
export const referenceDir = (name) => path.join(referenceRoot, name);
export const referenceRootDir = referenceRoot;

// ---- CCSDS OEM text (NASA ISS) ----
export function parseOemKvn(text) {
  const blocks = [];
  const header = {};
  let meta = null, current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('COMMENT')) continue;
    if (line === 'META_START') { meta = {}; continue; }
    if (line === 'META_STOP') {
      current = { frame: meta.REF_FRAME, timeSystem: meta.TIME_SYSTEM, name: meta.OBJECT_NAME, id: meta.OBJECT_ID, lines: [] };
      blocks.push(current); meta = null; continue;
    }
    const kv = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (kv) { (meta ?? header)[kv[1]] = kv[2].trim(); continue; }
    if (!current) continue;
    const f = line.split(/\s+/);
    if (f.length >= 7 && /^\d{4}-/.test(f[0])) current.lines.push({ epoch: f[0], r: f.slice(1, 4).map(Number), v: f.slice(4, 7).map(Number) });
  }
  return { header, blocks };
}
const readText = (file) => { const b = fs.readFileSync(file); return (file.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8'); };

/** NASA JSC ISS OEM (EME2000, UTC, 4 min): the local copy named by `file`. */
export function iss({ file = path.join(ARCHIVE, 'hac/nasa-iss-oem/20261009/ISS.OEM_J2K_EPH.txt') } = {}) {
  const { header, blocks } = parseOemKvn(readText(file));
  const lines = gate(blocks.flatMap((b) => b.lines), { product: `nasa-iss-oem/${header.CREATION_DATE}`, norad: 25544 }).kept; // the truth gate (harness/truth-gate.mjs)
  return [withT({ source: 'iss', id: 'ISS', norad: 25544, name: 'ISS', objectId: '1998-067A', originator: header.ORIGINATOR, creation: header.CREATION_DATE, frame: 'EME2000', timeSystem: 'UTC', lines })];
}

// ---- SpaceX MEME ----
const memeEpoch = (token) => {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2}\.\d+)$/.exec(token);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), 0, 1) + (Number(m[2]) - 1) * 86400000 + Number(m[3]) * 3600000 + Number(m[4]) * 60000 + Number(m[5]) * 1000).toISOString();
};
/** The state lines of a SpaceX MEME text (EME2000, km, km/s, UTC). */
/** The states of a SpaceX MEME file, through the truth gate (harness/truth-gate.mjs): the sanity rule, and the ledger when `product` is given. */
export function parseMeme(text, { product = 'spacex-meme', norad = 0, raw = false } = {}) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const f = raw.trim().split(/\s+/);
    if (f.length !== 7) continue;
    const epoch = memeEpoch(f[0]);
    if (epoch) lines.push({ epoch, r: f.slice(1, 4).map(Number), v: f.slice(4, 7).map(Number) });
  }
  return raw ? lines : gate(lines, { product, norad }).kept;
}
export const memeHeader = (text) => ({
  start: /ephemeris_start:(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/.exec(text)?.slice(1).join('T') ?? null,
  stop: /ephemeris_stop:(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/.exec(text)?.slice(1).join('T') ?? null,
  created: /created:(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/.exec(text)?.slice(1).join('T') ?? null,
});

// ---- reference states ($OEM, size-prefixed, GCRF, UTC) ----
export function readReference(file, { raw = false } = {}) { // raw: the file's states as written (the truth gate's scan)
  const oem = OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(fs.readFileSync(file)))).unpack();
  const block = oem.EPHEMERIS_DATA_BLOCK[0];
  // the truth gate (harness/truth-gate.mjs): states listed for this product and object, or failing the sanity rule, are not read
  const lines = raw ? blockLines(block) : gate(blockLines(block), { product: path.basename(path.dirname(file)), norad: block.OBJECT.NORAD_CAT_ID }).kept;
  return { norad: block.OBJECT.NORAD_CAT_ID, name: block.OBJECT.OBJECT_NAME, objectId: block.OBJECT.OBJECT_ID, lines };
}
export function chain(files) { // consecutive files of one object as one series (they overlap at their ends)
  const byEpoch = new Map();
  let head = null;
  for (const file of files) {
    const ref = readReference(file);
    head ??= ref;
    for (const line of ref.lines) byEpoch.set(line.epoch, line);
  }
  return { ...head, lines: [...byEpoch.values()].sort((a, b) => ms(a.epoch) - ms(b.epoch)) };
}

/** ESA/ESOC final GNSS orbits (5 min): `perConstellation` satellites of each constellation, taken evenly from the first day's files. */
export function gnss({ perConstellation = 2, firstDay = 268, days = 20 } = {}) {
  const directories = Array.from({ length: days }, (_, k) => `ESA0OPSFIN_2024${String(firstDay + k).padStart(3, '0')}0000_01D_05M_ORB`).filter((d) => fs.existsSync(referenceDir(d)));
  if (!directories.length) return [];
  const first = referenceDir(directories[0]);
  const available = fs.readdirSync(first).filter((f) => f.endsWith('.oem')).map((f) => Number(f.replace('.oem', '')));
  const byConstellation = new Map();
  for (const norad of available) {
    const key = /^([A-Z])\d/.exec(readReference(path.join(first, `${norad}.oem`)).name)?.[1];
    if (key) byConstellation.set(key, [...(byConstellation.get(key) ?? []), norad]);
  }
  const chosen = [];
  for (const key of ['G', 'E', 'R', 'C']) {
    const list = byConstellation.get(key) ?? [];
    const take = Math.min(perConstellation, list.length);
    for (let k = 0; k < take; k += 1) chosen.push(list[Math.floor(((k + 0.5) * list.length) / take)]);
  }
  return chosen.map((norad) => {
    const series = chain(directories.map((d) => path.join(referenceDir(d), `${norad}.oem`)).filter((f) => fs.existsSync(f)));
    return withT({ source: 'gnss', id: `${series.name} (${norad})`, norad, name: series.name, objectId: series.objectId, originator: 'ESA/ESOC ESA0OPSFIN', creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: series.lines });
  });
}

/** ILRS combined weekly laser-ranging orbits (2 or 15 min), consecutive weeks of one target. */
export function slrHigh({ target, weeks = 4, first = 0 }) {
  const prefix = `ilrsa.orb.${target}.`;
  const directories = fs.readdirSync(referenceRoot).filter((d) => d.startsWith(prefix)).sort().slice(first, first + weeks);
  const files = directories.map((d) => fs.readdirSync(referenceDir(d)).filter((f) => f.endsWith('.oem')).map((f) => path.join(referenceDir(d), f))[0]).filter(Boolean);
  if (!files.length) return [];
  const series = chain(files);
  return [withT({ source: 'slr-high', id: `${series.name || target} (${series.norad})`, norad: series.norad, name: series.name || target, objectId: series.objectId, originator: 'ILRS combination (ilrsa)', creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: series.lines })];
}

/** ILRS analysis-center 4-day arcs (NSGF) of the low laser-ranged satellites; each arc is its own object. */
export function slrLow({ target, arcs = 8, first = 0 }) {
  const prefix = `nsgf.orb.${target}.`;
  const directories = fs.readdirSync(referenceRoot).filter((d) => d.startsWith(prefix)).sort().slice(first, first + arcs);
  return directories.map((d) => {
    const ref = readReference(path.join(referenceDir(d), fs.readdirSync(referenceDir(d)).filter((f) => f.endsWith('.oem'))[0]));
    return withT({ source: 'slr-low', id: `${ref.name || target} arc ${d.split('.')[3]} (${ref.norad})`, norad: ref.norad, name: ref.name || target, objectId: ref.objectId, originator: 'ILRS NSGF analysis-center arc', creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: ref.lines });
  });
}

// ---- GFZ multi-GNSS rapid orbits in E14's reference set: GEO (names ending G) and IGSO (names ending I) satellites ----
// Amendment A4: 20 consecutive days from 2025-10-01, fit windows every 48 h.
export const MGEX_A4 = Object.freeze({ year: 2025, firstDay: 274, days: 20, strideSeconds: 172800 });
const mgexRoot = path.join(ARCHIVE, 'e14-covariance-realism/reference');
export function mgex({ klass, year = 2025, firstDay = 274, days = 20 }) {
  const directories = Array.from({ length: days }, (_, k) => `GFZ0MGXRAP_${year}${String(firstDay + k).padStart(3, '0')}0000_01D_05M_ORB`).filter((d) => fs.existsSync(path.join(mgexRoot, d)));
  if (!directories.length) return [];
  const first = path.join(mgexRoot, directories[0]);
  const wanted = klass === 'geo' ? /\dG$/ : /\dI$/;
  const chosen = fs.readdirSync(first).filter((f) => f.endsWith('.oem')).map((f) => ({ norad: Number(f.replace('.oem', '')), name: readReference(path.join(first, f)).name })).filter((o) => wanted.test(o.name));
  return chosen.map((o) => {
    const series = chain(directories.map((d) => path.join(mgexRoot, d, `${o.norad}.oem`)).filter((f) => fs.existsSync(f)));
    return withT({ source: `mgex-${klass}`, id: `${series.name} (${o.norad})`, norad: o.norad, name: series.name, objectId: series.objectId, originator: 'GFZ MGEX rapid orbits (GFZ0MGXRAP)', creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: series.lines });
  });
}

// ---- GFZ rapid orbits (amendment A8b): reference states made by gnss-rapid-convert.mjs under <store>/gnss-rapid/reference ----
// GFZ0OPSRAP_ (GPS, GLONASS, Galileo) and GFZ0MGXRAP_ (BeiDou, QZSS), one directory per day, 2026-10-11 to 2026-10-22.
// The days from 2026-10-20 use Bulletin A predicted Earth orientation (A8c).
export const GNSS_RAPID = Object.freeze({ strideSeconds: 172800, predictedEopFromUtc: '2026-10-20T00:00:00Z' });
export const rapidRoot = () => path.join(store, 'gnss-rapid/reference');
export const rapidDirs = (prefix) => (fs.existsSync(rapidRoot()) ? fs.readdirSync(rapidRoot()).filter((d) => d.startsWith(prefix) && /ORB$/.test(d)).sort() : []);
const typeOf = (name) => name.split(/\s+/)[1] ?? '';
const rapidOem = (prefix, norad) => rapidDirs(prefix).map((d) => path.join(rapidRoot(), d, `${norad}.oem`)).filter((f) => fs.existsSync(f));
const rapidObject = (prefix, norad, source) => {
  const series = chain(rapidOem(prefix, norad));
  return withT({ source, id: `${series.name} (${norad})`, norad, name: series.name, objectId: series.objectId, originator: `GFZ rapid orbits (${prefix.replace('_', '')}), CDDIS copy`, creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: series.lines });
};
const rapidFirstDay = (prefix) => {
  const dirs = rapidDirs(prefix);
  if (!dirs.length) return [];
  const first = path.join(rapidRoot(), dirs[0]);
  return fs.readdirSync(first).filter((f) => f.endsWith('.oem')).map((f) => { const norad = Number(f.replace('.oem', '')); const ref = readReference(path.join(first, f)); return { norad, name: ref.name, key: /^([A-Z])\d/.exec(ref.name)?.[1], type: typeOf(ref.name) }; });
};

/** Two satellites per constellation, evenly from the first day's files in listing order (the rule of A1): G, R, E from GFZ0OPSRAP_, BeiDou MEO from GFZ0MGXRAP_. */
export function gnssRapid({ perConstellation = 2 } = {}) {
  const chosen = [];
  const pickFrom = (prefix, key, filter = () => true) => {
    const list = rapidFirstDay(prefix).filter((o) => o.key === key && filter(o));
    const take = Math.min(perConstellation, list.length);
    for (let k = 0; k < take; k += 1) chosen.push([prefix, list[Math.floor(((k + 0.5) * list.length) / take)].norad]);
  };
  for (const key of ['G', 'E', 'R']) pickFrom('GFZ0OPSRAP_', key);
  pickFrom('GFZ0MGXRAP_', 'C', (o) => /^BDS-\d?M/.test(o.type));
  return chosen.map(([prefix, norad]) => rapidObject(prefix, norad, 'gnss-rapid'));
}

/** All BeiDou and QZSS GEO (type ...G) or IGSO (type ...I) satellites of the first MGX day (A4's classes), whole series. */
export function mgexRapid({ klass }) {
  const wanted = klass === 'geo' ? /^(BDS-\d?|QZS-\d+)G\b/ : /^(BDS-\d?|QZS-\d+)I\b/;
  return rapidFirstDay('GFZ0MGXRAP_').filter((o) => wanted.test(o.type)).map((o) => rapidObject('GFZ0MGXRAP_', o.norad, `mgex-${klass}-rapid`));
}

/** The orbit class of a GNSS satellite from its reference-state name ("C201 BDS-3M-CAST", "J003 QZS-2G", "G044 GPS-IIR-A"): meo, igso, geo or other. */
export function gnssClass(name) {
  const type = typeOf(name);
  if (/^(BDS-\d?|QZS-\d+)G\b/.test(type)) return 'geo';
  if (/^(BDS-\d?|QZS-\d+)I\b/.test(type)) return 'igso';
  if (/^BDS-\d?M/.test(type) || /^[GRE]\d/.test(name)) return 'meo';
  return 'other';
}

// ---- ILRS orbits from CDDIS (amendment A9): reference states made by slr-convert.mjs under <store>/slr-ref/reference ----
// nsgf.orb.<sat>.<yymmdd>.v000: NSGF daily rapid orbits of the LEO spheres, the arc of file F is F-4 to F-1; ilrsa.orb.<sat>.<yymmdd>.v80: ILRS combined weekly orbits.
export const slrRefRoot = () => path.join(store, 'slr-ref/reference');
const slrDirs = (prefix) => (fs.existsSync(slrRefRoot()) ? fs.readdirSync(slrRefRoot()).filter((d) => d.startsWith(prefix)).sort() : []);
const yymmddMs = (s) => Date.UTC(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)));

/** The NSGF rapid arcs of one LEO sphere, every `every` days from the first file (non-overlapping 4-day arcs), each arc its own object. */
export function slrLowCurrent({ target, every = 4 }) {
  const dirs = slrDirs(`nsgf.orb.${target}.`);
  if (!dirs.length) return [];
  const first = yymmddMs(dirs[0].split('.')[3]);
  return dirs.filter((d) => ((yymmddMs(d.split('.')[3]) - first) / 86400000) % every === 0).map((d) => {
    const file = fs.readdirSync(path.join(slrRefRoot(), d)).find((f) => f.endsWith('.oem'));
    const ref = readReference(path.join(slrRefRoot(), d, file));
    return withT({ source: 'slr-low-current', id: `${ref.name || target} arc ${d.split('.')[3]} (${ref.norad})`, norad: ref.norad, name: ref.name || target, objectId: ref.objectId, originator: 'ILRS NSGF rapid orbit (CDDIS copy)', creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: ref.lines });
  });
}

/** The ILRS combined weekly orbits of one MEO target: one object per run of consecutive weeks (a week the product omits ends the run), so no window crosses a hole. */
export function slrHighCurrent({ target }) {
  const dirs = slrDirs(`ilrsa.orb.${target}.`);
  const files = dirs.map((d) => path.join(slrRefRoot(), d, fs.readdirSync(path.join(slrRefRoot(), d)).find((f) => f.endsWith('.oem')))).filter(Boolean);
  if (!files.length) return [];
  const runs = [];
  for (const file of files) {
    const ref = readReference(file);
    const last = runs.at(-1);
    if (last && ms(ref.lines[0].epoch) - ms(last.at(-1).lines.at(-1).epoch) <= 3600e3) last.push({ file, lines: ref.lines }); else runs.push([{ file, lines: ref.lines }]);
  }
  return runs.map((run) => {
    const series = chain(run.map((x) => x.file));
    return withT({ source: 'slr-high-current', id: `${series.name || target} (${series.norad}) from ${series.lines[0].epoch.slice(0, 10)}`, norad: series.norad, name: series.name || target, objectId: series.objectId, originator: 'ILRS combination (ilrsa), CDDIS copy', creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: series.lines });
  });
}

/** One sphere's NSGF rapid orbits for the COMSPOC scoring: every daily file chained, the latest file winning where arcs overlap. */
export function slrLowSeries({ norad }) {
  const files = slrDirs('nsgf.orb.').map((d) => path.join(slrRefRoot(), d, `${norad}.oem`)).filter((f) => fs.existsSync(f));
  return files.length ? chain(files) : null;
}

// ---- the truth series of the COMSPOC-aligned fit-span windows (amendment A9e) ----
/** One satellite's GFZ rapid orbits (OPS or MGX product), every day chained: an object, or null when neither product holds the satellite. */
export function gnssRapidSeries({ norad, source }) {
  for (const prefix of ['GFZ0OPSRAP_', 'GFZ0MGXRAP_']) if (rapidOem(prefix, norad).length) return rapidObject(prefix, norad, source);
  return null;
}
/** One sphere's NSGF rapid orbits from CDDIS, every daily file chained, the later file winning where arcs overlap: an object, or null. */
export function slrSeriesObject({ norad, source }) {
  const s = slrLowSeries({ norad });
  return s ? withT({ source, id: `${s.name} (${norad})`, norad, name: s.name, objectId: s.objectId, originator: 'ILRS NSGF rapid orbit (CDDIS copy), daily files chained', creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: s.lines }) : null;
}
