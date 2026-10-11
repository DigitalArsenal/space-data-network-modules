// Metop-SG A1 (NORAD 65159) study (PLAN-2026-10): EUMETSAT's flight-dynamics
// manoeuvre history (AUX_MHF, rights NoConditions) as truth.
//
//   node study/metop.mjs <work> --mhf-dir /opt/data/sdn-archive/hac/eumetsat-metopsg/AUX_MHF --history <gp-65159.json>
//        --variants <variants.json> --from 2025-08-01 --to 2026-10-01
//
// AUX_MHF lines: UTC time, three accelerations (km/s^2, Fortran D exponents)
// read as radial, along-track and cross-track, and 1 (thrust on) or 0 (off).
// Burns within 3 h are one manoeuvre; entries after the file's generation
// time (its first line) are plans and are left out.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { iso, seconds, mnvRecord, MNV } from './lib/host.mjs';
import { detectHistories, scoreVariants, printScores, writeJson, log } from './lib/run.mjs';

const [work, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
fs.mkdirSync(work, { recursive: true });

const mhfTime = (text) => seconds(text.replace(/^(\d{4})\/(\d\d)\/(\d\d)-/, '$1-$2-$3T'));

// The newest OPER manoeuvre history: its text, from the zip, read in memory.
function newestHistory(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".zip") && f.includes("_OPE_OPER"))
    .map((f) => ({ f, g: /_G(\d{14})Z_/.exec(f)?.[1] })).filter((x) => x.g).sort((a, b) => a.g.localeCompare(b.g));
  const latest = files.at(-1).f;
  const text = execFileSync('unzip', ['-p', path.join(dir, latest), '*MANO_HIST*.txt'], { encoding: 'latin1' });
  return { file: latest, text };
}

export function manoeuvres(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const generated = mhfTime(lines[0].trim().split(/\s+/)[0]);
  const burns = [];
  let on = null;
  for (const line of lines.slice(1)) {
    const when = mhfTime(line.trim().split(/\s+/)[0]);
    const numbers = [...line.replace(/D/g, 'E').matchAll(/-?\d\.\d+E[-+]\d+/g)].map((m) => Number(m[0]));
    const flagOn = Number(line.trim().split(/\s+/).at(-1));
    if (numbers.length !== 3) continue;
    if (flagOn === 1) on = { start: when, accel: numbers };
    else if (on) { burns.push({ ...on, stop: when }); on = null; }
  }
  const groups = [];
  for (const b of burns) {
    if (groups.length && b.start - groups.at(-1).at(-1).stop < 3 * 3600) groups.at(-1).push(b); else groups.push([b]);
  }
  return { generated, groups };
}

// Truth $MNV: the acceleration profile verbatim (U along-track, V cross-track,
// W radial; each value held until the next time, zero after a burn ends).
function truthRecord(group) {
  const times = [], accels = [];
  for (const b of group) {
    const [radial, along, cross] = b.accel;
    times.push(iso(b.start), iso(b.stop));
    accels.push(along, cross, radial, 0, 0, 0);
  }
  return mnvRecord({ ID: `METOP-SGA1:${iso(group[0].start)}`, SAT_NO: 65159, ORIG_OBJECT_ID: '2025-172A', STATUS: MNV.maneuverStatus.EXECUTED,
    EVENT_START_TIME: iso(group[0].start), EVENT_END_TIME: iso(group.at(-1).stop), NUM_ACCEL_POINTS: times.length,
    MNVR_ACCEL_TIMES: times, MNVR_ACCELS: accels });
}

const { file, text } = newestHistory(flag('mhf-dir'));
const { generated, groups } = manoeuvres(text);
const from = flag('from'), to = flag('to');
const inWindow = groups.filter((g) => g[0].start >= seconds(`${from}T00:00:00`) && g[0].start < seconds(`${to}T00:00:00`));
const executed = inWindow.filter((g) => g.at(-1).stop <= generated);
log(`${file}: generated ${iso(generated)}, ${groups.length} manoeuvres, ${executed.length} executed in the window (${inWindow.length - executed.length} planned, left out)`);
const variants = JSON.parse(fs.readFileSync(flag('variants'), 'utf8'));
const { sets, events } = await detectHistories([{ history: flag('history'), from, to }], variants, { workers: 6, marginSets: Number(flag('margin-sets', 0)) });
const key = 'NORAD:65159';
const history = JSON.parse(fs.readFileSync(flag('history'), 'utf8'));
const first = history[0].EPOCH;
const scores = await scoreVariants(events, Buffer.concat(executed.map((g) => Buffer.from(truthRecord(g)))), {
  before_s: 6 * 3600, after_s: 36 * 3600,
  explained: groups.map((g) => ({ object: key, from: iso(g[0].start - 1.5 * 86400), to: iso(g.at(-1).stop + 1.5 * 86400) })),
  spans: [{ object: key, from: iso(Math.max(seconds(`${from}T00:00:00`), seconds(first))), to: `${to}T00:00:00Z` }],
});
printScores(scores);
writeJson(work, `metop-${from}-${to}.json`, { source: file, generated: iso(generated), sets, truth: executed.map((g) => ({ start: iso(g[0].start), burns: g.length })),
  events, scores });
