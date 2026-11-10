#!/usr/bin/env node
// Re-score FFM's reference evidence on the committed dist, in one command, and keep the result per build.
// Every reference trajectory and table (Orekit, GMAT, Nyx, Tudat, Basilisk, ERFA/SPICE, Horizons, the SGP4-XP
// library) stays as stored; no external engine is run and nothing is fetched. Only FFM's side is flown again,
// serially, through the shipped WASM, and each tool's own scorer reduces it in C++.
//
//   FFM_XVAL_NYX_OUT=<folder> FFM_XVAL_GMAT_WORK=<folder> \
//   nice -n 19 node propagator/ffm/tests/evidence/rescore-all.mjs [--date YYYY-MM-DD] [--skip-scoring]
//        [--commit <sha> --note <text>] [--nyx-out <folder>] [--gmat-work <folder>]       (from the repository root)
//
// FFM_XVAL_NYX_OUT (or --nyx-out) names the folder of the stored Nyx runs that run-nyx.mjs wrote; FFM_XVAL_GMAT_WORK
// (or --gmat-work) the GMAT work folder holding the anomalous-oxygen/ and variants/ diagnostic reports. Both live
// with the tool installs, outside the repository; the command refuses to start without them.
//
// Steps: each tool's scorer, refresh-derived-comparisons.mjs --gmat --nyx --basilisk, rescore.json's date,
// consolidate.mjs --write, check-all.mjs, then scored/<version>-<sha256[0:8]>.json. A comparison whose limits are
// missed is recorded as failed with its numbers; nothing is re-pinned to pass. --skip-scoring keeps the scored
// summaries and redoes the rest. --commit and --note record, for a build scored in a tree other than the one its
// file lands in, the commit of that tree and what differs about it.
//
//   node propagator/ffm/tests/evidence/rescore-all.mjs --record-only --consolidated <consolidated.json> --commit <sha>
//
// writes the per-build file of a build scored earlier, from the consolidated.json committed with its evidence.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const scoredDir = path.join(here, 'scored');
export const scoredFile = (version, sha256) => path.join(scoredDir, `${version}-${sha256.slice(0, 8)}.json`);

// Stored tool outputs kept outside the repository, named by environment variable or option, never by a path here.
export const XVAL = {
  nyx: { env: 'FFM_XVAL_NYX_OUT', option: 'nyx-out',
    what: 'the folder of the stored Nyx runs that run-nyx.mjs wrote (nyx-2.6.0-stm.json, nyx-2.6.0-msis-published.json, nyx-2.6.0-fine.json, nyx-2.6.0-naif-bpc.json)' },
  gmat: { env: 'FFM_XVAL_GMAT_WORK', option: 'gmat-work',
    what: 'the GMAT work folder that holds the anomalous-oxygen/ and variants/ diagnostic reports' },
};
export function xvalDir(key, value = process.env[XVAL[key].env]) {
  const { env, option, what } = XVAL[key];
  if (!value) throw new Error(`Set ${env} (or pass --${option}) to ${what}.`);
  if (!fs.existsSync(value)) throw new Error(`${env} names ${value}, which does not exist; it should be ${what}.`);
  return path.resolve(value);
}
const TUDAT_CACHE = 'propagator/ffm/tests/evidence/tudat/ffm-tudatpy-1.0.0.json';
const EV = 'propagator/ffm/tests/evidence';
// [label, cwd relative to the repository root, script relative to cwd, args]. Order matters:
// - the Nyx summary pins the ERFA/SPICE summary, so ERFA/SPICE (and Horizons, which pins nothing else) run first;
// - the Tudat native run writes the FFM state cache that Tudat WASM, Nyx, Basilisk and the derived diagnostics read;
// - the derived diagnostics read the scored GMAT and Basilisk summaries and rewrite anomalous-oxygen.json,
//   variants.json, drag-settings-diagnostic.json and diagnoses.json;
// - the GMAT annotations, Nyx and Basilisk summaries pin those files, so they are written after them (Basilisk a
//   second time, from the same cached states).
const BASILISK = ['Basilisk', '.', `${EV}/basilisk/score-basilisk.mjs`, ['--cached-only', '--cache', TUDAT_CACHE,
  '--diagnostics', `${EV}/basilisk/basilisk-wgs84-diagnostic.json`,
  '--diagnostics', `${EV}/basilisk/basilisk-wgs84-gtd7d-diagnostic.json`, '--causes', `${EV}/basilisk/diagnoses.json`]];
const steps = (NYX_OUT) => [
  ['ERFA / SPICE', '.', `${EV}/erfa-spice/run-erfa-spice.mjs`, ['--stored-reference']],
  ['Horizons', '.', `${EV}/horizons/run-horizons.mjs`, ['--stored-reference']],
  ['Tudat native', '.', `${EV}/tudat/score-tudat.mjs`, ['--stm', `${EV}/tudat/tudatpy-1.0.0-stm.json`]],
  ['Tudat WASM', '.', `${EV}/tudat/score-tudat.mjs`, ['--wasm', '--cache', TUDAT_CACHE]],
  ['Orekit', 'propagator/ffm', 'tests/orekit-summary.mjs', []],
  ['GMAT R2026a', `${EV}/gmat`, 'score-gmat.mjs', ['gmat-R2026a.json', '--stm', 'gmat-R2026a-stm.json']],
  ['GMAT R2022a', `${EV}/gmat`, 'score-gmat.mjs', ['gmat-R2022a.json']],
  BASILISK,
  ['Derived GMAT, Nyx and Basilisk diagnostics', '.', `${EV}/refresh-derived-comparisons.mjs`, ['--gmat', '--nyx', '--basilisk']],
  ['GMAT annotations', `${EV}/gmat`, 'update-summary.mjs', []],
  ['Nyx', `${EV}/nyx`, 'score-nyx.mjs', ['nyx-2.6.0.json', '--stm', `${NYX_OUT}/nyx-2.6.0-stm.json`,
    '--msis-published', `${NYX_OUT}/nyx-2.6.0-msis-published.json`, '--fine', `${NYX_OUT}/nyx-2.6.0-fine.json`,
    '--naif-bpc', `${NYX_OUT}/nyx-2.6.0-naif-bpc.json`, '--cache', path.join(root, TUDAT_CACHE),
    // The stored Nyx runs carry the module's former name; their display labels follow the current one.
    '--previous-module', 'hpop']],
  [`${BASILISK[0]}, pinning the refreshed diagnoses`, ...BASILISK.slice(1)],
  ['27-case cross-validation subset', 'propagator/ffm', 'tests/xval-summary.mjs', []],
  ['SGP4-XP', 'propagator/sgp4', 'tests/evidence/xp/run-xp.mjs', []],
  // summary-str3.json pins no build; consolidate.mjs labels it with the current propagator/sgp4, so it is run again.
  ['SGP4 against its STR#3 base', 'propagator/sgp4', 'tests/evidence/str3/run-str3.mjs', []],
];
// FFM state caches carry the identity of the build that flew them; a cache from another build is refused by its
// readers, so it is removed and flown again.
const CACHES = [TUDAT_CACHE, `${EV}/tudat/ffm-tudat-wasm.json`, `${EV}/basilisk/ffm-basilisk-2.12.0.json`];

function run(label, cwd, script, args) {
  const started = Date.now();
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, ['--v8-pool-size=1', script, ...args],
    { cwd: path.join(root, cwd), env: { ...process.env, UV_THREADPOOL_SIZE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 << 20 });
  const tail = (s) => s.trim().split('\n').filter((l) => !/^\s+at /.test(l)).slice(-4).join('\n');
  if (r.stdout.trim()) console.log(tail(r.stdout));
  if (r.status !== 0) throw new Error(`${label}: exit ${r.status}${r.signal ? `, signal ${r.signal}` : ''}\n${tail(r.stderr)}`);
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return r.stdout;
}

// The check scripts check-all.mjs runs, as it labels them, with their result.
function checks(stdout) {
  const labels = [...stdout.matchAll(/^=== (.+) ===$/gm)].map((m) => m[1]).filter((l) => l !== 'Independent consolidation');
  const failed = new Set([...stdout.matchAll(/^FAIL child contract: (.+?): /gm)].map((m) => m[1]));
  return labels.map((check) => ({ check, passed: !failed.has(check) }));
}

const ratio = (value, limit) => (limit > 0 ? value / limit : value > 0 ? Infinity : 0);
const round = (x) => (typeof x === 'number' ? Number(x.toPrecision(6)) : x);

// One comparison of consolidated.json, reduced to what it was against, whether it ran on this build, whether every
// primary limit was met, the row closest to (or furthest past) its limit, and every missed row with its cause.
function comparison(tool, data) {
  const module = data.module;
  const c = tool.counts;
  // SGP4 evidence pins its own module, not FFM.
  const sgp4 = ['str3', 'xp'].includes(tool.id);
  const against = sgp4 || tool.label.includes(tool.version) ? tool.label : `${tool.label} ${tool.version}`;
  const base = { id: tool.id, against, evidence: tool.evidence, summarySha256: tool.summarySha256 };
  const pinned = sgp4 ? { module: tool.version, wasmSha256: tool.pins[0].sha256 } : { module: `FFM ${module.version}`, wasmSha256: module.sha256 };
  const rows = { scored: c.scored, met: c.met, missed: c.missed, skipped: c.skipped, diagnostic: c.diagnostic };
  const passed = c.scored > 0 ? c.missed === 0 : null;
  let headline = null, missed = [];
  if (tool.rows.some((r) => r.suite)) {
    // Trajectory tools: the largest 3D position difference over 24 h at the suite's request, against the row's limit.
    for (const r of tool.rows) {
      const h = { quantity: 'largest 3D position difference over 24 h, suite setting', case: r.id, value: round(r.suite.worstM), unit: 'm', display: r.suite.display, limit: r.toleranceM };
      if (!headline || ratio(h.value, h.limit) > ratio(headline.value, headline.limit)) headline = h;
      if (r.suite.met === false) missed.push({ case: r.id, value: round(r.suite.worstM), unit: 'm', display: r.suite.display, limit: r.toleranceM, cause: r.cause?.classification ?? null });
    }
  } else {
    // Metric tools: primary rows against their limits; a tool with no limit (SGP4 against STR#3) by its largest first metric.
    const limited = [], unlimited = [];
    for (const r of tool.rows) r.metrics.forEach((m, i) => {
      const h = { quantity: `${r.label}: ${m.label}`, case: r.id, value: round(m.value), unit: m.unit, display: m.display, limit: m.limit };
      if (r.role === 'primary' && m.limit != null) limited.push(h); else if (i === 0) unlimited.push(h);
      if (r.role === 'primary' && r.status === 'missed' && m.limit != null && !(m.strict ? m.value < m.limit : m.value <= m.limit))
        missed.push({ case: r.id, value: round(m.value), unit: m.unit, display: m.display, limit: m.limit, cause: r.cause?.classification ?? null });
    });
    const key = limited.length ? (h) => ratio(h.value, h.limit) : (h) => h.value;
    for (const h of limited.length ? limited : unlimited) if (!headline || key(h) > key(headline)) headline = h;
  }
  return { ...base, ...pinned, ran: true, passed, rows, headline, missed, publicNote: passed === false ? publicNote(tool, missed, data) : null };
}

// A neutral note the site prints as written, for a comparison that did not meet every limit. The explanations below
// apply only while the missed rows still carry the recorded cause each one states; otherwise the note gives the
// numbers and the recorded cause as they are.
const sig = (x) => String(Number(x.toPrecision(3)));
const meters = (m) => (m >= 1000 ? `${sig(m / 1000)} km` : m >= 1 ? `${sig(m)} m` : `${sig(m * 1000)} mm`);
const count = (n) => ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][n] ?? String(n);
const orbit = (o) => o.replace(/^(LEO|SSO)(\d+)$/, '$2 km');
const span = (rows) => { const v = rows.map((r) => r.value); return `${meters(Math.min(...v))} to ${meters(Math.max(...v))}`; };
const limits = (rows) => [...new Set(rows.map((r) => (r.limit >= 0.1 ? `${sig(r.limit)} m` : meters(r.limit))))].join(' or ');
const adjusted = (data, id) => data.dragDiagnostics.find((d) => d.id === id)?.rows.filter((r) => !r.stockMet) ?? [];
const NOTES = {
  'gmat-2026': (missed, data) => {
    const a = adjusted(data, 'gmat-2026');
    if (!missed.every((r) => /without anomalous oxygen/.test(r.cause ?? '')) || !a.length || !a.every((r) => r.met)) return null;
    return `${count(missed.length)} drag cases differ by ${span(missed)} against a ${limits(missed)} limit. GMAT R2026a's density has no anomalous oxygen; scaling the drag coefficient for it brings them to ${a.map((r) => `${meters(r.correctedM)} at ${orbit(r.orbit)}`).join(' and ')}.`;
  },
  nyx: (missed, data) => {
    const a = adjusted(data, 'nyx');
    if (!missed.every((r) => /NRLMSISE-00/.test(r.cause ?? '')) || !a.length || !a.every((r) => r.met)) return null;
    return `${count(missed.length)} drag cases differ by ${span(missed)} against a ${limits(missed)} limit. Nyx's NRLMSISE-00 differs from the model's published formulas, and the Nyx runner's Earth shape was not WGS84; with both matched, the same cases agree to within ${meters(Math.max(...a.map((r) => r.correctedM)))}.`;
  },
  basilisk: (missed, data) => {
    const a = adjusted(data, 'basilisk');
    if (!missed.every((r) => r.cause === 'model-setting mismatch') || !a.length || !a.every((r) => r.met)) return null;
    return `In ${count(missed.length).toLowerCase()} drag cases Basilisk's atmosphere was not set up like FFM's (spherical rather than WGS84 altitude and latitude, and a different NRLMSISE-00 density entry point), so their ${span(missed)} differences against a ${limits(missed)} limit are not a like-for-like comparison. With those settings matched, the same cases agree to within ${meters(Math.max(...a.map((r) => r.correctedM)))}.`;
  },
  frames: (missed, data, tool) => {
    const same = tool.rows.find((r) => r.id === 'c2tSameInstant')?.metrics[0];
    if (missed.length !== 1 || missed[0].case !== 'c2tSpice' || missed[0].cause !== 'reference spread' || !same) return null;
    return `FFM's GCRF to ITRF rotation differs from SPICE's ITRF93 kernel by ${sig(missed[0].value)} mas against a ${sig(missed[0].limit)} mas limit. That is a difference between the references: the ITRF93 kernel carries its own Earth orientation data and the IAU 1976/1980 model, and against ERFA with the case's Earth orientation data FFM agrees to ${sig(same.value)} mas.`;
  },
};
function publicNote(tool, missed, data) {
  const note = NOTES[tool.id]?.(missed, data, tool);
  if (note) return note;
  const causes = [...new Set(missed.map((r) => r.cause ?? 'none recorded'))].join('; ');
  return `${count(missed.length)} of ${tool.counts.scored} rows exceed their limits: ${missed.map((r) => `${r.case} ${r.display} against ${r.limit} ${r.unit}`).join(', ')}. Recorded cause: ${causes}.`;
}

export function scoredRecord(data, extra = {}) {
  return {
    about: 'FFM reference evidence scored on one build: each comparison against its stored reference. passed is true when every primary row met its limit, false with the missed rows and their recorded causes otherwise, and null for a comparison with no limit. headline is the row nearest its limit, or furthest past it. publicNote, for a comparison that did not pass, states what differs and what the recorded diagnostic shows, in words that can be printed as written.',
    module: { name: 'propagator/ffm', version: data.module.version, wasmSha256: data.module.sha256 },
    scoredOn: data.rescore.date,
    ...extra,
    comparisons: data.tools.map((t) => comparison(t, data)),
    dragDiagnostics: data.dragDiagnostics.map((d) => ({ id: d.id, against: d.label, adjustment: d.adjustment,
      rows: d.rows.map((r) => ({ orbit: r.orbit, cases: r.cases, stock: r.stockDisplay, adjusted: r.correctedDisplay, limit: r.limitDisplay, met: r.met })) })),
    subset27: Object.fromEntries(Object.entries(data.xval.maxima).map(([tool, m]) => [tool, m.all.display])),
  };
}

function writeRecord(record) {
  fs.mkdirSync(scoredDir, { recursive: true });
  const file = scoredFile(record.module.version, record.module.wasmSha256);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
  console.log(`Wrote ${path.relative(root, file)}`);
  for (const c of record.comparisons)
    console.log(`${c.against}: ${c.passed === null ? 'no limit' : c.passed ? 'passed' : `FAILED (${c.missed.length} missed)`}; ${c.rows.met}/${c.rows.scored} met; headline ${c.headline?.display ?? '-'} (${c.headline?.case ?? '-'}, limit ${c.headline?.limit ?? 'none'} ${c.headline?.unit ?? ''})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: o } = parseArgs({ options: { 'record-only': { type: 'boolean', default: false }, consolidated: { type: 'string' },
    commit: { type: 'string' }, date: { type: 'string' }, 'skip-scoring': { type: 'boolean', default: false }, note: { type: 'string' },
    'nyx-out': { type: 'string' }, 'gmat-work': { type: 'string' } } });
  if (o['record-only']) {
    if (!o.consolidated || !o.commit) throw new Error('--record-only needs --consolidated <file> and --commit <sha>');
    writeRecord(scoredRecord(readJson(o.consolidated), { evidenceCommit: o.commit, checks: null,
      note: 'Written from the consolidated.json committed with this build\'s evidence; the check scripts were not run again.' }));
  } else {
    const started = Date.now();
    // The derived diagnostics and consolidate.mjs (also inside check-all.mjs) read the GMAT reports from here.
    process.env[XVAL.gmat.env] = xvalDir('gmat', o['gmat-work']);
    // --skip-scoring keeps the scored summaries and redoes only the consolidation, the checks and the per-build file.
    if (!o['skip-scoring']) {
      const STEPS = steps(xvalDir('nyx', o['nyx-out'] ?? process.env[XVAL.nyx.env]));
      const { propagationIdentity } = await import('./tudat/scoring.mjs');
      const identity = JSON.stringify(propagationIdentity());
      for (const cache of CACHES.map((c) => path.join(root, c)))
        if (fs.existsSync(cache) && JSON.stringify(readJson(cache).identity) !== identity) {
          fs.rmSync(cache); console.log(`Removed ${path.relative(root, cache)}: flown on another build`);
        }
      for (const [label, cwd, script, args] of STEPS) run(label, cwd, script, args);
      const rescore = readJson(path.join(here, 'rescore.json'));
      rescore.date = o.date ?? new Date().toISOString().slice(0, 10);
      fs.writeFileSync(path.join(here, 'rescore.json'), `${JSON.stringify(rescore, null, 1)}\n`);
    }
    run('Consolidation', '.', `${EV}/consolidate.mjs`, ['--write']);
    const data = readJson(path.join(here, 'consolidated.json'));
    // check-all.mjs holds the per-build file to consolidated.json, so it is written first and completed after.
    const tree = { evidenceCommit: o.commit ?? null, ...(o.note ? { note: o.note } : {}) };
    writeRecord(scoredRecord(data, { ...tree, checks: null }));
    console.log('\n=== check-all.mjs ===');
    const all = spawnSync(process.execPath, [`${EV}/check-all.mjs`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
    console.log(all.stdout.trim().split('\n').filter((l) => /^(PASS|FAIL)/.test(l)).join('\n'));
    writeRecord(scoredRecord(data, { ...tree, checks: checks(all.stdout), checkAllPassed: all.status === 0 }));
    console.log(`Re-score: ${((Date.now() - started) / 60000).toFixed(1)} min`);
    if (all.status !== 0) process.exitCode = 1;
  }
}
