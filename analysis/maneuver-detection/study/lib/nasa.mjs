// NASA's public ISS trajectory archive (JSC FOD/TOPO, s3://nasa-public-data/
// iss-coords/<date>/): CCSDS OEM in EME2000, each with a trajectory event
// summary (name, TIG, delta-V, resulting apogee and perigee) in its header.
// Files are read in memory and dropped; only derived records are kept.
import { OEM, MNV, flatbuffers, iso, seconds, oemFrame, mnvRecord } from './host.mjs';

const BUCKET = 'https://nasa-public-data.s3.amazonaws.com';

async function get(url, attempts = 4) {
  for (let k = 1; ; ++k) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (k >= attempts) throw new Error(`${url}: ${e.message}`);
      await new Promise((ok) => setTimeout(ok, 5000 * k));
    }
  }
}

// Every dated OEM key (not current/).
export async function listFiles() {
  const keys = [];
  let token = null;
  do {
    const page = await get(`${BUCKET}/?list-type=2&prefix=iss-coords/&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`);
    for (const block of page.matchAll(/<Contents>(.*?)<\/Contents>/gs)) {
      const key = /<Key>([^<]+)<\/Key>/.exec(block[1])[1];
      if (key.endsWith('.txt') && key.includes('OEM') && !key.includes('/current/')) keys.push({ key, url: `${BUCKET}/${key}` });
    }
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(page)?.[1] ?? null;
  } while (token);
  return keys;
}

// The parsed file: creation time, the states (UTC s, km, km/s) and the event
// table. TIG is GMT day-of-year in the creation year (or the next year when
// the day is more than 180 days before the creation day).
export function parseFile(text, url) {
  const creationText = /CREATION_DATE\s*=\s*(\S+)/.exec(text)?.[1];
  if (!creationText) return null;
  const created = seconds(creationText);
  const year = new Date(created * 1000).getUTCFullYear();
  const createdDoy = Math.floor((created * 1000 - Date.UTC(year, 0, 1)) / 86400000) + 1;
  const events = [];
  const row = /^COMMENT\s+(\S.*?)\s+(\d{3}):(\d\d):(\d\d):(\d\d(?:\.\d+)?)\s+(?:\d+\s+)?([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*$/;
  const t = [], s = [];
  for (const line of text.split(/\r?\n/)) {
    const m = row.exec(line);
    if (m) {
      const [, name, doy, hh, mm, ss, dv, ha, hp] = m;
      const y = year + (Number(doy) < createdDoy - 180 ? 1 : 0);
      const tig = Date.UTC(y, 0, 1) / 1000 + (Number(doy) - 1) * 86400 + Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
      events.push({ name: name.trim(), tig, dv: Number(dv), ha: Number(ha), hp: Number(hp) });
      continue;
    }
    const p = line.trim().split(/\s+/);
    if (p.length === 7 && p[0].startsWith('20') && p[0].includes('T')) {
      t.push(seconds(p[0]));
      s.push(p.slice(1).map(Number));
    }
  }
  if (t.length < 10) return null;
  return { url, created, events, t: Float64Array.from(t), s: Float64Array.from(s.flat()) };
}

export async function readFiles(keys, { concurrency = 6, onFile } = {}) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < keys.length) {
      const k = keys[next++];
      const parsed = parseFile(await get(k.url), k.url);
      if (parsed) out.push(parsed);
      onFile?.(out.length, keys.length);
    }
  }));
  return out.sort((a, b) => a.created - b.created);
}

// One version as a $OEM (EME2000, UTC, km): CREATION_DATE is its issue time.
export function versionOem(file) {
  const b = new OEM.ephemerisDataBlockT();
  b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: 25544, OBJECT_ID: '1998-067A', OBJECT_NAME: 'ISS' });
  b.COMMENT = `NASA ISS trajectory ${file.url.split('/iss-coords/')[1]}`;
  b.CENTER_NAME = 'EARTH';
  b.TIME_SYSTEM = OEM.timingStandard.UTC;
  b.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { REFERENCE_FRAME_type: OEM.RFMUnion.CelestialFrameWrapper,
    REFERENCE_FRAME: Object.assign(new OEM.CelestialFrameWrapperT(), { frame: OEM.CelestialFrame.EME2000 }) });
  b.EPHEMERIS_DATA_LINES = Array.from(file.t, (t, i) => {
    const l = new OEM.ephemerisDataLineT();
    l.EPOCH = iso(t);
    [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = file.s.subarray(6 * i, 6 * i + 6);
    return l;
  });
  return oemFrame([b], iso(file.created));
}

// Planned burns: for every event with DV > 0 listed ahead of its TIG (within 4
// days), the last plan issued before the TIG. Listings of one burn in
// different files are the same burn when their TIGs are within 3 h (a
// replanned time); burns of one plan stay separate.
export function plannedBurns(files) {
  const burns = [];
  for (const f of files) {
    const listed = f.events.filter((e) => e.dv > 0 && f.created <= e.tig && e.tig - f.created <= 4 * 86400);
    const taken = new Set();
    for (const e of listed) {
      let best = null;
      for (const b of burns) {
        if (taken.has(b) || Math.abs(b.tig - e.tig) > 3 * 3600) continue;
        if (!best || Math.abs(b.tig - e.tig) < Math.abs(best.tig - e.tig)) best = b;
      }
      const plan = { tig: e.tig, dv: e.dv, name: e.name, lastIssued: f.created, ha: e.ha, hp: e.hp };
      if (best) { Object.assign(best, plan); taken.add(best); } else { burns.push(plan); taken.add(plan); }
    }
  }
  return burns.sort((a, b) => a.tig - b.tig);
}

export function plannedMnv(burn) {
  const t = new MNV.MNVT();
  Object.assign(t, { ID: `ISS:${iso(burn.tig)}:${burn.name}`, SAT_NO: 25544, ORIG_OBJECT_ID: '1998-067A', STATUS: MNV.maneuverStatus.PLANNED,
    EVENT_START_TIME: iso(burn.tig), EVENT_END_TIME: iso(burn.tig), DELTA_VEL: burn.dv / 1000,
    DESCRIPTION: `NASA plan issued ${iso(burn.lastIssued)}: ${burn.name}, ${burn.dv} m/s, HA ${burn.ha} km, HP ${burn.hp} km` });
  const b = new flatbuffers.Builder(1024);
  MNV.MNV.finishSizePrefixedMNVBuffer(b, t.pack(b));
  return b.asUint8Array();
}

// Every event listed ahead of its time (dockings and undockings too), and the
// day after each file's creation (a fresh plan is on hand).
export function listedEvents(files) {
  const all = new Map();
  for (const f of files) for (const e of f.events) if (e.tig >= f.created) all.set(Math.round(e.tig), { tig: e.tig, name: e.name, dv: e.dv });
  return [...all.values()].sort((a, b) => a.tig - b.tig);
}
export const coverage = (files) => files.map((f) => [f.created, f.created + 86400]);

// Executed burns of a truth file as truth $MNV (size-prefixed stream). NASA's
// plans are in-plane, and compare_ephemerides judges them by the in-track
// change; its cross-track estimate across a TIG carries the nodal-regression
// correction's error, so the truth is the in-track change alone.
export function truthMnv(burns) {
  return Buffer.concat(burns.filter((b) => b.status === 'EXECUTED').map((b) => Buffer.from(mnvRecord({
    ID: b.id, SAT_NO: 25544, ORIG_OBJECT_ID: '1998-067A', STATUS: MNV.maneuverStatus.EXECUTED,
    EVENT_START_TIME: b.tig_iso, EVENT_END_TIME: b.tig_iso, DELTA_VEL: Math.abs(b.executed_in_track_mps) / 1000,
    DELTA_VEL_U: b.executed_in_track_mps / 1000 }))));
}
