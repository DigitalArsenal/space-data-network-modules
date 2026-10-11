// GEO study (PLAN-2026-10): Intelsat's post-manoeuvre IESS-412 files as truth.
//
//   node study/geo.mjs <work> --listing <intelsat m-file list JSON> --gp-dir <dir of gp/<norad>.json> --variants <variants.json> [--now ISO]
//
// my.intelsat.com/ephemeris/public lists, per satellite, its latest
// post-manoeuvre file ("m"), named by its epoch m. A manoeuvre is taken to
// lie in [m - 3 d, m]; an event in [m - 3 d, m + 1 d] detects it. One known
// manoeuvre per satellite: the truth is incomplete, so other events are
// counted, not called false. The listing JSON holds only the file names and
// the NORAD numbers matched to them through the SATCAT (no ephemeris).
import fs from 'node:fs';
import path from 'node:path';
import { iso, seconds, mnvRecord, MNV } from './lib/host.mjs';
import { detectHistories, scoreVariants, printScores, writeJson, log } from './lib/run.mjs';

const [work, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
fs.mkdirSync(work, { recursive: true });
const now = seconds(flag('now', new Date().toISOString()));
const listing = JSON.parse(fs.readFileSync(flag('listing'), 'utf8'));
const variants = JSON.parse(fs.readFileSync(flag('variants'), 'utf8'));
const windows = [['tuning', '2020-09-01', '2025-01-01'], ['held-out', '2025-01-01', '2026-10-01'], ['live', '2026-10-01', iso(now).slice(0, 10)]];
const out = { listing: listing.length, windows: {} };
for (const [label, from, to] of windows) {
  const cases = listing.filter((r) => r.norad && r.epoch >= from && r.epoch < to && seconds(r.epoch) <= now &&
    fs.existsSync(path.join(flag('gp-dir'), `${r.norad}.json`)));
  if (!cases.length) { log(`${label}: no dated post-manoeuvre file with element sets`); continue; }
  // Each satellite from the start of the month 35 days before m to 10 days after it.
  const histories = cases.map((r) => {
    const m = seconds(r.epoch);
    const start = new Date((m - 35 * 86400) * 1000);
    return { history: path.join(flag('gp-dir'), `${r.norad}.json`), from: iso(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1) / 1000).slice(0, 10),
      to: iso(Math.min(m + 10 * 86400, now)).slice(0, 10) };
  });
  const { sets, events } = await detectHistories(histories, variants, { workers: 6, marginSets: 10 });
  const truth = Buffer.concat(cases.map((r) => Buffer.from(mnvRecord({ ID: `INTELSAT:${r.file}`, SAT_NO: r.norad, STATUS: MNV.maneuverStatus.EXECUTED,
    EVENT_START_TIME: iso(seconds(r.epoch) - 3 * 86400), EVENT_END_TIME: iso(seconds(r.epoch)) }))));
  log(`== ${label}: ${cases.length} post-manoeuvre files (${cases.map((r) => r.code).join(', ')})`);
  const scores = await scoreVariants(events, truth, { before_s: 0, after_s: 86400,
    spans: histories.map((h, k) => ({ object: `NORAD:${cases[k].norad}`, from: `${h.from}T00:00:00Z`, to: `${h.to}T00:00:00Z` })) });
  printScores(scores);
  out.windows[label] = { cases, sets, events, scores };
}
writeJson(work, 'geo.json', out);
