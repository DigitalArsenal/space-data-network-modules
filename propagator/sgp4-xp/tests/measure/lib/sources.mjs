// The ephemerides of the measurement, as objects { id, norad, name, objectId, originator, creation, frame,
// timeSystem, lines: [{ epoch, r, v }], t: Float64Array of ms }. Positions in km.
//
// Operator ephemerides (NASA's ISS, SpaceX's Starlink) are fetched into memory and dropped with the process: the
// owner's rule is that no raw operator ephemeris is stored (/opt/data/sdn-archive/operator-ephemerides/README.md).
// The precise-orbit references (ESA/IGS GNSS finals, ILRS laser-ranging orbits) are read from the archive's
// reference states: GCRF $OEM files made by analysis/reference-states from the products' SP3, with the Earth
// orientation supplied.
import fs from 'node:fs';
import path from 'node:path';
import { flatbuffers, OEM } from '../../lib/sds.mjs';
import { parseOemKvn } from '../../lib/oemkvn.mjs';
import { ms } from './time.mjs';

const ARCHIVE = process.env.SDN_ARCHIVE ?? '/opt/data/sdn-archive';
const STARLINK_ROOT = 'https://api.starlink.com/public-files/ephemerides';
const ISS_URL = 'https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt';

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

function finish(object) {
  object.t = Float64Array.from(object.lines, (l) => ms(l.epoch));
  return object;
}

/** NASA's ISS ephemeris (OEM, EME2000, UTC, 4 min), the 15 days of the current file. */
export async function iss({ text } = {}) {
  const { header, blocks } = parseOemKvn(text ?? (await fetchText(ISS_URL)));
  const lines = blocks.flatMap((b) => b.lines);
  return [finish({ source: 'iss', id: 'ISS', norad: 25544, name: 'ISS', objectId: '1998-067A', originator: header.ORIGINATOR, creation: header.CREATION_DATE, frame: 'EME2000', timeSystem: 'UTC', lines })];
}

// SpaceX MEME: a header, then per state the line `YYYYDDDHHMMSS.sss x y z vx vy vz` (km, km/s, EME2000) and three lines of covariance.
function memeEpoch(token) {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2}\.\d+)$/.exec(token);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), 0, 1) + (Number(m[2]) - 1) * 86400000 + Number(m[3]) * 3600000 + Number(m[4]) * 60000 + Number(m[5]) * 1000;
  return new Date(t).toISOString();
}
export function parseMeme(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const f = raw.trim().split(/\s+/);
    if (f.length !== 7) continue;
    const epoch = memeEpoch(f[0]);
    if (!epoch) continue;
    lines.push({ epoch, r: f.slice(1, 4).map(Number), v: f.slice(4, 7).map(Number) });
  }
  return lines;
}

/** Starlink public ephemerides (MEME, EME2000, UTC, 60 s, 48 h each) of the sample list's satellites. */
export async function starlink({ limit = 20, sampleFile = path.join(ARCHIVE, 'operator-ephemerides/_capture/starlink-sample.txt'), onProgress } = {}) {
  const sample = fs.readFileSync(sampleFile, 'utf8').split(/\s+/).filter(Boolean).slice(0, limit);
  const manifest = (await fetchText(`${STARLINK_ROOT}/MANIFEST.txt`)).split('\n').filter(Boolean);
  const objects = [];
  for (const norad of sample) {
    const file = manifest.find((f) => f.startsWith(`MEME_${norad}_`));
    if (!file) continue;
    const text = await fetchText(`${STARLINK_ROOT}/${file}`);
    const lines = parseMeme(text);
    if (lines.length < 100) continue;
    const created = /created:(\S+ \S+) UTC/.exec(text)?.[1];
    const name = file.split('_')[2];
    objects.push(finish({ source: 'starlink', id: `${name} (${norad})`, norad: Number(norad), name, objectId: '', originator: 'SpaceX', creation: created ? `${created.replace(' ', 'T')}` : '', frame: 'EME2000', timeSystem: 'UTC', lines }));
    onProgress?.(objects.length, sample.length);
  }
  return objects;
}

// A reference-states $OEM (size-prefixed, GCRF, UTC, verbose lines with velocities).
function readReference(file) {
  const oem = OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(fs.readFileSync(file)))).unpack();
  const block = oem.EPHEMERIS_DATA_BLOCK[0];
  return {
    norad: block.OBJECT.NORAD_CAT_ID, name: block.OBJECT.OBJECT_NAME, objectId: block.OBJECT.OBJECT_ID,
    lines: block.EPHEMERIS_DATA_LINES.map((l) => ({ epoch: l.EPOCH, r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT] })),
  };
}
// Consecutive reference files of one satellite as one series (the files overlap at their ends).
function chain(files) {
  const byEpoch = new Map();
  let head = null;
  for (const file of files) {
    const ref = readReference(file);
    head ??= ref;
    for (const line of ref.lines) byEpoch.set(line.epoch, line);
  }
  const lines = [...byEpoch.values()].sort((a, b) => ms(a.epoch) - ms(b.epoch));
  return { ...head, lines };
}
const referenceDir = (name) => path.join(ARCHIVE, 'reference-states/reference', name);

/**
 * ESA's final GNSS orbits (5 min), `days` consecutive days from `firstDay` (a day of 2024, 268...): the satellites in `norads`, or
 * `perConstellation` of each constellation (G GPS, E Galileo, R GLONASS, C BeiDou) taken evenly from the first day's files.
 */
export function gnss({ norads, perConstellation = 2, firstDay = 268, days = 20 } = {}) {
  const directories = Array.from({ length: days }, (_, k) => `ESA0OPSFIN_2024${String(firstDay + k).padStart(3, '0')}0000_01D_05M_ORB`).filter((d) => fs.existsSync(referenceDir(d)));
  if (!directories.length) return [];
  const first = referenceDir(directories[0]);
  const available = fs.readdirSync(first).filter((f) => f.endsWith('.oem')).map((f) => Number(f.replace('.oem', '')));
  let chosen = norads?.filter((n) => available.includes(n));
  if (!chosen) {
    const byConstellation = new Map();
    for (const norad of available) {
      const name = readReference(path.join(first, `${norad}.oem`)).name;
      const key = /^([A-Z])\d/.exec(name)?.[1];
      if (key) byConstellation.set(key, [...(byConstellation.get(key) ?? []), norad]);
    }
    chosen = [];
    for (const key of ['G', 'E', 'R', 'C']) {
      const list = byConstellation.get(key) ?? [];
      const take = Math.min(perConstellation, list.length);
      for (let k = 0; k < take; k += 1) chosen.push(list[Math.floor(((k + 0.5) * list.length) / take)]);
    }
  }
  return chosen.map((norad) => {
    const files = directories.map((d) => path.join(referenceDir(d), `${norad}.oem`)).filter((f) => fs.existsSync(f));
    const series = chain(files);
    return finish({ source: 'gnss', id: `${series.name} (${norad})`, norad, name: series.name, objectId: series.objectId, originator: 'ESA/ESOC ESA0OPSFIN', creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: series.lines });
  });
}

/** ILRS combined weekly laser-ranging orbits (2 or 15 min), consecutive weeks of one target. */
export function slr({ target = 'lageos1', weeks = 3, first = 0 } = {}) {
  const prefix = `ilrsa.orb.${target}.`;
  const directories = fs.readdirSync(path.join(ARCHIVE, 'reference-states/reference')).filter((d) => d.startsWith(prefix)).sort().slice(first, first + weeks);
  const files = directories.map((d) => fs.readdirSync(referenceDir(d)).filter((f) => f.endsWith('.oem')).map((f) => path.join(referenceDir(d), f))[0]);
  const series = chain(files);
  return [finish({ source: 'slr', id: `${series.name || target} (${series.norad})`, norad: series.norad, name: series.name || target, objectId: series.objectId, originator: 'ILRS combination (ilrsa)', creation: '', frame: 'GCRF', timeSystem: 'UTC', lines: series.lines })];
}
