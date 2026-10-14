// GNSS study (PLAN-2026-10): manoeuvres seen in precise orbits as truth.
//
//   node study/gnss.mjs <work> --gp-dir <dir of gp/<norad>.json> --variants <variants.json>
//        [--esa /opt/data/sdn-archive/reference-states/reference] [--gfz /opt/data/sdn-archive/e14-covariance-realism/reference]
//
// Truth: each satellite's daily precise arcs (analysis/reference-states GCRF
// $OEM, IGS-family products) through compare_ephemerides: an arc's first
// revolution against the previous arc's last, and consecutive revolutions
// within an arc; a change of at least 0.2 km in orbit-averaged SMA is a
// manoeuvre in that interval (across a missing day, in the gap).
import fs from 'node:fs';
import path from 'node:path';
import { loadModule, config, TYPES, iso, seconds, outputsOf, unpackMnv, mnvRecord, OEM, MNV, flatbuffers } from './lib/host.mjs';
import { detectHistories, scoreVariants, printScores, writeJson, log } from './lib/run.mjs';

const [work, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
fs.mkdirSync(work, { recursive: true });
const ESA = flag('esa', '/opt/data/sdn-archive/reference-states/reference');
const GFZ = flag('gfz', '/opt/data/sdn-archive/e14-covariance-realism/reference');

// GPS from ESA finals (IGS finals for a day ESA lacks); Galileo 34 from GFZ's
// MGEX rapid orbits. GPS 67588 has no GFZ MGEX arc on this machine, so it uses
// ESA finals like the other GPS satellites.
const SATELLITES = [
  { norad: 26407, name: 'NAVSTAR 48', sources: [[ESA, 'ESA0OPSFIN'], [ESA, 'IGS0OPSFIN']] },
  { norad: 29486, name: 'NAVSTAR 58', sources: [[ESA, 'ESA0OPSFIN'], [ESA, 'IGS0OPSFIN']] },
  { norad: 55268, name: 'NAVSTAR 82', sources: [[ESA, 'ESA0OPSFIN'], [ESA, 'IGS0OPSFIN']] },
  { norad: 67588, name: 'NAVSTAR 85', sources: [[ESA, 'ESA0OPSFIN'], [ESA, 'IGS0OPSFIN']] },
  { norad: 67162, name: 'GALILEO 34', sources: [[GFZ, 'GFZ0MGXRAP']] },
];

// One arc per day (the first source holding that day), with CREATION_DATE set
// to its first epoch so compare_ephemerides can order the versions.
function arcs(sat) {
  const byDay = new Map();
  for (const [dir, prefix] of sat.sources) {
    for (const product of fs.readdirSync(dir).filter((d) => d.startsWith(prefix)).sort()) {
      const file = path.join(dir, product, `${sat.norad}.oem`);
      if (!fs.existsSync(file)) continue;
      const day = product.split('_')[1].slice(0, 7);
      if (byDay.has(day)) continue;
      const oem = OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(fs.readFileSync(file)))).unpack();
      const lines = oem.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
      if (lines.length < 10) continue;
      oem.CREATION_DATE = lines[0].EPOCH;
      const b = new flatbuffers.Builder(1 << 17);
      OEM.OEM.finishOEMBuffer(b, oem.pack(b));
      byDay.set(day, { day, start: seconds(lines[0].EPOCH), stop: seconds(lines.at(-1).EPOCH), product, bytes: b.asUint8Array() });
    }
  }
  return [...byDay.values()].sort((a, b) => a.start - b.start);
}

const variants = JSON.parse(fs.readFileSync(flag('variants'), 'utf8'));
const compare = await loadModule('analysis/maneuver-detection');
const truth = [], explained = [], coverage = [], histories = [], summary = [];
for (const sat of SATELLITES) {
  const list = arcs(sat);
  if (!list.length) { log(`${sat.name}: no precise arcs`); continue; }
  const key = `NORAD:${sat.norad}`;
  const r = await compare.invoke('compare_ephemerides', [...list.map((a) => ({ portId: 'versions', payload: a.bytes, typeRef: TYPES.OEM })),
    config({ unplanned_threshold_km: 0.2, within_version: true })]);
  const events = outputsOf(r, 'maneuvers').map(unpackMnv);
  for (const m of events) {
    truth.push(mnvRecord({ ID: m.ID, SAT_NO: sat.norad, STATUS: MNV.maneuverStatus.EXECUTED, EVENT_START_TIME: m.EVENT_START_TIME,
      EVENT_END_TIME: m.EVENT_END_TIME, DELTA_VEL: m.DELTA_VEL, DELTA_VEL_V: m.DELTA_VEL_V, DELTA_VEL_W: m.DELTA_VEL_W }));
    explained.push({ object: key, from: iso(seconds(m.EVENT_START_TIME) - 2 * 86400), to: iso(seconds(m.EVENT_END_TIME) + 2 * 86400) });
  }
  // Missing days explain events near them too (a manoeuvre under 0.2 km, or one
  // a product left out).
  for (let i = 1; i < list.length; ++i)
    if (list[i].start - list[i - 1].stop > 3600) explained.push({ object: key, from: iso(list[i - 1].stop - 2 * 86400), to: iso(list[i].start + 2 * 86400) });
  coverage.push({ object: key, from: iso(list[0].start), to: iso(list.at(-1).stop) });
  const first = iso(list[0].start).slice(0, 10), last = iso(list.at(-1).stop + 86400).slice(0, 10);
  histories.push({ history: path.join(flag('gp-dir'), `${sat.norad}.json`), from: first, to: last });
  summary.push({ norad: sat.norad, name: sat.name, arcs: list.length, from: first, to: last, truth: events.length,
    truthEvents: events.map((m) => ({ from: m.EVENT_START_TIME, to: m.EVENT_END_TIME, in_track_mps: m.DELTA_VEL_V * 1000, cross_track_mps: m.DELTA_VEL_W * 1000 })) });
  log(`${sat.name}: ${list.length} arcs ${first} to ${last}, ${events.length} precise-orbit manoeuvres`);
}
await compare.destroy();
const { sets, events } = await detectHistories(histories, variants, { workers: 6, marginSets: Number(flag('margin-sets', 10)) });
// Scored over the precise-orbit coverage, split at the plan's windows.
const windows = [['tuning', '2024-09-24', '2025-01-01'], ['held-out', '2025-01-01', '2026-10-01']];
const out = { satellites: summary, sets, scores: {} };
for (const [label, from, to] of windows) {
  const inside = (t) => t >= `${from}T00:00:00` && t < `${to}T00:00:00`;
  const truthIn = truth.filter((b) => inside(unpackMnv(b.subarray(4)).EVENT_START_TIME));
  const eventsIn = Object.fromEntries(Object.entries(events).map(([k, v]) => [k, v.filter((e) => inside(e.EVENT_START_TIME))]));
  const spans = coverage.map((c) => ({ object: c.object, from: c.from > `${from}T00:00:00Z` ? c.from : `${from}T00:00:00Z`, to: c.to < `${to}T00:00:00Z` ? c.to : `${to}T00:00:00Z` }))
    .filter((c) => c.to > c.from);
  if (!truthIn.length) { log(`${label}: no truth`); continue; }
  log(`== ${label} (${from} to ${to}): ${truthIn.length} precise-orbit manoeuvres`);
  out.scores[label] = await scoreVariants(eventsIn, Buffer.concat(truthIn.map((b) => Buffer.from(b))), {
    before_s: 86400, after_s: 86400, explained, assessed: spans, spans });
  printScores(out.scores[label]);
}
out.events = events;
writeJson(work, 'gnss.json', out);
