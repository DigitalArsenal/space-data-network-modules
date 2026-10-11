// ISS study (PLAN-2026-10): NASA-confirmed truth, detection over the GP
// history through the propagator query port, and scoring.
//
//   node study/iss.mjs truth  <work> --from 2020-09-01 --to 2025-01-01
//   node study/iss.mjs detect <work> --history <gp-25544.json> --from ... --to ... --variants <variants.json> [--provider sgp4|keplerian-reference] [--label x]
//   node study/iss.mjs score  <work> --truth <truth.json> --events <events.json> [--before-h 6] [--after-h 36]
//
// Operator files are read in memory; <work> receives derived records only.
import fs from 'node:fs';
import path from 'node:path';
import { loadModule, json, TYPES, iso, seconds, outputsOf, jsonOf, unpackMnv, mnvRecord, MNV } from './lib/host.mjs';
import { listFiles, readFiles, versionOem, plannedBurns, plannedMnv, listedEvents, coverage } from './lib/nasa.mjs';
import { runPool, waitForLoad } from './lib/pool.mjs';

const [command, work, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
fs.mkdirSync(work, { recursive: true });
const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

export function months(from, to) {
  const out = [], start = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  for (let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); m < end; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    out.push({ from: (m < start ? start : m).toISOString(), to: (next > end ? end : next).toISOString() });
  }
  return out;
}

async function truth() {
  const from = seconds(`${flag('from')}T00:00:00`), to = seconds(`${flag('to')}T00:00:00`);
  const keys = (await listFiles()).filter((k) => {
    const d = seconds(`${k.key.split('/')[1]}T00:00:00`);
    return d >= from - 40 * 86400 && d < to + 30 * 86400;
  });
  log(`${keys.length} NASA files to read`);
  const files = await readFiles(keys, { concurrency: 6, onFile: (n, of) => { if (n % 50 === 0) log(`read ${n}/${of}`); } });
  const burns = plannedBurns(files);
  const inWindow = burns.filter((b) => b.tig >= from && b.tig < to);
  const compare = await loadModule('analysis/maneuver-detection');
  const checked = new Map();
  // Burns whose windows touch are checked in one call, with every burn of the
  // versions' span (each burn's post-burn version must precede the next burn).
  const groups = [];
  for (const b of inWindow) {
    if (groups.length && b.tig - groups.at(-1).at(-1).tig < 2 * 86400) groups.at(-1).push(b); else groups.push([b]);
  }
  for (const group of groups) {
    const lo = group[0].tig - 4 * 86400, hi = group.at(-1).tig + 16 * 86400;
    const versions = files.filter((f) => f.created >= lo && f.created < hi);
    const planned = burns.filter((b) => b.tig >= lo && b.tig < hi);
    const r = await compare.invoke('compare_ephemerides', [
      ...versions.map((f) => ({ portId: 'versions', payload: versionOem(f), typeRef: TYPES.OEM })),
      { portId: 'planned', payload: Buffer.concat(planned.map((b) => Buffer.from(plannedMnv(b)))), typeRef: TYPES.MNV },
      json('options', { margin_s: 1800, post_start_after_s: 3600 }),
    ]);
    const report = jsonOf(r, 'report');
    const rows = new Map((report.objects[0]?.planned ?? []).map((p) => [p.id, p]));
    for (const m of outputsOf(r, 'maneuvers').map(unpackMnv)) {
      const id = m.ID.replace(/:check$/, '');
      if (!group.some((b) => `ISS:${iso(b.tig)}:${b.name}` === id)) continue;
      checked.set(id, { id, tig: m.EVENT_START_TIME, status: MNV.maneuverStatus[m.STATUS], executed_in_track_mps: m.DELTA_VEL_U * 1000,
        executed_cross_track_mps: m.DELTA_VEL_V * 1000, executed_mps: m.DELTA_VEL * 1000, check: rows.get(id) });
    }
    log(`${iso(group[0].tig).slice(0, 10)}: ${group.length} burn(s), ${versions.length} versions`);
  }
  await compare.destroy();
  const out = {
    source: 'https://nasa-public-data.s3.amazonaws.com/iss-coords/', window: [flag('from'), flag('to')], files: files.length,
    burns: inWindow.map((b) => ({ ...b, issued: iso(b.lastIssued), tig_iso: iso(b.tig), ...checked.get(`ISS:${iso(b.tig)}:${b.name}`) })),
    listed_events: listedEvents(files).map((e) => ({ ...e, tig: iso(e.tig) })),
    coverage: coverage(files).map(([a, b]) => [iso(a), iso(b)]),
  };
  const file = path.join(work, `iss-truth-${flag('from')}-${flag('to')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  const count = (s) => out.burns.filter((b) => b.status === s).length;
  log(`${out.burns.length} planned burns: ${count('EXECUTED')} executed, ${count('CANCELLED')} cancelled, ${count('UNKNOWN')} unknown -> ${file}`);
}

async function detect() {
  const variants = JSON.parse(fs.readFileSync(flag('variants'), 'utf8'));
  const items = months(flag('from'), flag('to')).map((m) => ({ ...m, history: path.resolve(flag('history')) }));
  await waitForLoad(45, log);
  const started = Date.now();
  const results = await runPool(new URL('./lib/detect-task.mjs', import.meta.url), items,
    { variants, marginDays: 5, provider: flag('provider', 'sgp4') }, { workers: Number(flag('workers', 6)),
      onDone: (n, of, item) => log(`${n}/${of} ${item.from.slice(0, 7)} ${Math.round((Date.now() - started) / 1000)} s`) });
  const events = Object.fromEntries(variants.map((v) => [v.name, results.flatMap((r) => r.variants[v.name])]));
  const file = path.join(work, `events-${flag('label', 'iss')}-${flag('from')}-${flag('to')}.json`);
  fs.writeFileSync(file, JSON.stringify({ window: [flag('from'), flag('to')], provider: flag('provider', 'sgp4'), variants, sets: results.reduce((a, r) => a + r.sets, 0), events }));
  log(`-> ${file}`);
}

export function truthMnv(burns) {
  return Buffer.concat(burns.filter((b) => b.status === 'EXECUTED').map((b) => Buffer.from(mnvRecord({
    ID: b.id, SAT_NO: 25544, ORIG_OBJECT_ID: '1998-067A', STATUS: MNV.maneuverStatus.EXECUTED,
    EVENT_START_TIME: b.tig_iso, EVENT_END_TIME: b.tig_iso, DELTA_VEL: b.executed_mps / 1000,
    DELTA_VEL_U: b.executed_in_track_mps / 1000, DELTA_VEL_V: b.executed_cross_track_mps / 1000 }))));
}
export const eventsMnv = (events) => Buffer.concat(events.map((e) => Buffer.from(mnvRecord({ ...e, STATUS: MNV.maneuverStatus.DETECTED, MNVR_ACCELS: e.MNVR_ACCELS ?? [] }))));

async function score() {
  const truthFile = JSON.parse(fs.readFileSync(flag('truth'), 'utf8'));
  const eventsFile = JSON.parse(fs.readFileSync(flag('events'), 'utf8'));
  const [from, to] = eventsFile.window;
  const scorer = await loadModule('analysis/maneuver-detection');
  const key = 'NORAD:25544';
  const options = {
    before_s: Number(flag('before-h', 6)) * 3600, after_s: Number(flag('after-h', 36)) * 3600,
    explained: truthFile.listed_events.map((e) => ({ object: key, from: iso(seconds(e.tig) - 1.5 * 86400), to: iso(seconds(e.tig) + 1.5 * 86400) })),
    assessed: truthFile.coverage.map(([a, b]) => ({ object: key, from: a, to: b })),
    spans: [{ object: key, from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z` }],
  };
  const burns = truthFile.burns.filter((b) => b.tig_iso >= `${from}T00:00:00` && b.tig_iso < `${to}T00:00:00`);
  const out = {};
  for (const [name, events] of Object.entries(eventsFile.events)) {
    const r = await scorer.invoke('score_detections', [
      { portId: 'detected', payload: eventsMnv(events), typeRef: TYPES.MNV },
      { portId: 'truth', payload: truthMnv(burns), typeRef: TYPES.MNV },
      json('options', options),
    ]);
    out[name] = jsonOf(r, 'report');
  }
  await scorer.destroy();
  const file = flag('out', flag('events').replace(/events-/, 'score-'));
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  for (const [name, r] of Object.entries(out)) {
    const s = r.summary;
    log(`${name.padEnd(28)} recall ${s.detected}/${s.truth} events ${s.events} unexplained ${s.false_alarms} (${(s.false_alarms_per_object_year ?? 0).toFixed(2)}/y) ` +
        `|dt| ${s.time_error_abs_s ? (s.time_error_abs_s.median / 60).toFixed(0) + ' min' : '-'} dv ${s.dv_ratio ? s.dv_ratio.median.toFixed(2) : '-'}`);
  }
}

if (command === 'truth') await truth();
else if (command === 'detect') await detect();
else if (command === 'score') await score();
else if (command) throw new Error(`unknown command ${command}`);
