#!/usr/bin/env node
// HPOP against Nyx Space on the reference cases Nyx models: the largest 3D
// position difference over 24 h (25 hourly samples) between the shipped HPOP
// WASM (the SDK's browser harness) and each Nyx trajectory of run-nyx.mjs,
// with HPOP at the three settings of the Orekit table (tests/orekit-summary.mjs):
//
//   suite    RK78 at 1e-13 (point mass 1e-15), steps <= 300 s (the suite's request)
//   steps30  the same, steps <= 30 s
//   finest   1e-15, steps <= 10 s
//
// and, where the Nyx file carries them (run-nyx.mjs --stm), the 6x6 STMs and
// the Cr*A/m and Cd*A/m columns against HPOP's analytic STM with those
// parameters at the suite's request (largest relative column difference,
// position and velocity rows apart, as tests/lib/orekitCases.mjs
// scoreJacobians). Orekit 13.1 against Nyx on the same case is printed beside
// it: where Orekit and HPOP are equally far from Nyx, the difference is Nyx's.
//
//   node tests/evidence/nyx/score-nyx.mjs <nyx.json> [--stm <nyx-stm.json>]
//        [--out summary.json] [--settings suite,steps30,finest] [--only s]
//        [--msis-published published.json --fine fine.json --naif-bpc naif.json]
// The three optional diagnostics reuse each HPOP result; they do not rerun it.
// For the complete table, first run measure-drag-settings.mjs <nyx scratch>.
// With all three diagnostics and --stm, explain-nyx.mjs adds measured causes
// and a file-hash inventory (including any unavailable historical binaries).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { explainSummary } from './explain-nyx.mjs';
import { ALL, wasm, sha256, CASES, reference, run, buildMetrics, scoreResponse, stmDifference } from './scoring.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: o, positionals } = parseArgs({ options: {
  'msis-published': { type: 'string' }, fine: { type: 'string' }, 'naif-bpc': { type: 'string' },
  stm: { type: 'string' }, out: { type: 'string' }, settings: { type: 'string', default: 'suite,steps30,finest' }, only: { type: 'string' },
}, allowPositionals: true });
const nyxFile = positionals[0];
if (!nyxFile) throw new Error('usage: score-nyx.mjs <nyx.json> [--stm <nyx-stm.json>] [--out summary.json]');
const NYX = JSON.parse(fs.readFileSync(nyxFile, 'utf8'));
const STM = o.stm ? JSON.parse(fs.readFileSync(o.stm, 'utf8')) : null;
const TOL = CASES.protocol.tolerancesM.default;
const work = fs.mkdtempSync(path.join(here, '.score-work-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
const metrics = buildMetrics(work);
const variants = Object.fromEntries(['msis-published', 'fine', 'naif-bpc'].filter((key) => o[key]).map((key) => [key, JSON.parse(fs.readFileSync(o[key], 'utf8'))]));
const diagnostics = Object.fromEntries(Object.entries(variants).map(([key, doc]) => [key, { file: path.resolve(o[key]), sha256: sha256(o[key]), tool: doc.tool, settings: doc.settings, cases: [] }]));
const worstOf = (positions, samples) => metrics({ mode: 'positions', positions, scale: 1, samples });
const SETTINGS = ALL.filter((s) => o.settings.split(',').includes(s.id));
const ORBITS = ['LEO400', 'SSO700', 'GPS', 'GEO', 'MOLNIYA'];
const ROWS = [['Point mass', 'pointMass'], ['Field, third bodies, radiation pressure, tides, relativity, thrust', 'fullNoDrag'], ['With drag', 'drag']];
const caseId = (c) => c.forceSet.split('-')[0];
const FAMILIES = [
  ['Geopotential, EGM2008 (F1 F2 F3)', /^(F1|F2|F3)$/], ['Geopotential, EGM96 and 36Z,24T (G1 G2)', /^(G1|G2)$/],
  ['Sun and Moon (F4 Z1)', /^(F4|Z1)$/], ['Radiation pressure (F5 Z2)', /^(F5|Z2)$/], ['EME2000 (E1)', /^E1$/],
  ['Relativity (R1 R2)', /^(R1|R2)$/], ['In-track thrust (I1)', /^I1$/], ['Jacobian cases (C1)', /^C1$/], ['Drag (F6 Z3 W1 B1)', /^(F6|Z3|W1|B1)$/],
];
const cases = NYX.cases.filter((g) => !o.only || g.id.includes(o.only));
const results = [];
for (const g of cases) {
  const c = reference(g);
  const orekit = worstOf(c.samples.slice(1).map((s) => s.slice(1, 4)), g.samples);
  const row = { id: g.id, orbit: g.orbit, forceSet: g.forceSet, row: g.row, toleranceClass: g.toleranceClass, toleranceM: TOL[g.toleranceClass], orekitMinusNyx: orekit };
  const comparisons = Object.entries(variants).filter(([key]) => key !== 'msis-published' || g.row === 'drag').map(([key, doc]) => {
    const variant = doc.cases.find((c) => c.id === g.id);
    if (!variant) throw new Error(`${key}: missing ${g.id}`);
    const r = { id: g.id, toleranceM: row.toleranceM, orekitMinusNyx: worstOf(c.samples.slice(1).map((s) => s.slice(1, 4)), variant.samples), stockMinusVariant: worstOf(g.samples.slice(1).map((s) => s.slice(1, 4)), variant.samples) };
    diagnostics[key].cases.push(r);
    return { variant, r };
  });
  for (const s of SETTINGS) {
    const response = await run(g, s);
    row[s.id] = scoreResponse(response, g, metrics);
    row[s.id].met = row[s.id].worstM <= row.toleranceM;
    for (const { variant, r } of comparisons) { r[s.id] = scoreResponse(response, variant, metrics); r[s.id].met = r[s.id].worstM <= row.toleranceM; }
  }
  row.met = row[SETTINGS[0].id].met;
  const ns = STM?.cases.find((x) => x.id === g.id);
  if (ns) row.stm = stmDifference(await run(g, ALL[0], true), g, ns.stm, metrics);
  results.push(row);
  console.error(`${g.id}: ${SETTINGS.map((s) => `${s.id} ${row[s.id].worstM.toExponential(3)} m`).join(', ')}; Orekit-Nyx ${orekit.worstM.toExponential(3)} m${row.stm ? `; STM ${row.stm.worst.toExponential(2)}` : ''}`);
}

const mm = (m) => (m * 1000 < 10 ? (m * 1000).toFixed(2) : (m * 1000).toFixed(1));
const fmt = (m) => (m === undefined ? '-' : m < 0.01 ? `${mm(m)} mm` : m < 1 ? `${(m * 100).toFixed(m < 0.1 ? 1 : 0)} cm` : `${m.toFixed(2)} m`);
const maxOf = (rows, key) => {
  const values = rows.map((r) => (key === 'orekit' ? r.orekitMinusNyx.worstM : r[key].worstM));
  return values.length ? Math.max(...values) : undefined;
};
console.log(`HPOP against Nyx ${NYX.tool.nyxSpace} (ANISE ${NYX.tool.anise}), ${NYX.settings.integrator} at ${NYX.settings.tolerance}, steps <= ${NYX.settings.maxStepS} s, ${NYX.settings.earthOrientation}; ${results.length} cases.\n`);
console.log(`| Force set | Cases | ${SETTINGS.map((s) => s.label).join(' | ')} | Orekit 13.1 - Nyx |`);
console.log(`|---|---:|${SETTINGS.map(() => '---:').join('|')}|---:|`);
for (const [name, key] of ROWS) {
  const rows = results.filter((r) => r.row === key);
  if (rows.length) console.log(`| ${name} | ${rows.length} | ${SETTINGS.map((s) => fmt(maxOf(rows, s.id))).join(' | ')} | ${fmt(maxOf(rows, 'orekit'))} |`);
}
console.log(`| All ${results.length} cases | ${results.length} | ${SETTINGS.map((s) => fmt(maxOf(results, s.id))).join(' | ')} | ${fmt(maxOf(results, 'orekit'))} |`);
console.log();
console.log(`| Orbit | Row | ${SETTINGS.map((s) => s.id).join(' | ')} | Orekit - Nyx |`);
console.log(`|---|---|${SETTINGS.map(() => '---:').join('|')}|---:|`);
for (const orbit of ORBITS) for (const [name, key] of ROWS) {
  const rows = results.filter((r) => r.orbit === orbit && r.row === key);
  if (rows.length) console.log(`| ${orbit} | ${name} | ${SETTINGS.map((s) => fmt(maxOf(rows, s.id))).join(' | ')} | ${fmt(maxOf(rows, 'orekit'))} |`);
}
console.log();
console.log(`| Force family | ${SETTINGS.map((s) => s.id).join(' | ')} | Orekit - Nyx |`);
console.log(`|---|${SETTINGS.map(() => '---:').join('|')}|---:|`);
for (const [name, re] of FAMILIES) {
  const rows = results.filter((r) => re.test(caseId(r)));
  if (rows.length) console.log(`| ${name} | ${SETTINGS.map((s) => fmt(maxOf(rows, s.id))).join(' | ')} | ${fmt(maxOf(rows, 'orekit'))} |`);
}
console.log();
console.log(`| Case | Limit | ${SETTINGS.map((s) => s.id).join(' | ')} | Orekit - Nyx | STM (rel.) | Cr, Cd columns (rel.) | Within limit (${SETTINGS[0].id}) |`);
console.log(`|---|---:|${SETTINGS.map(() => '---:').join('|')}|---:|---:|---:|---|`);
for (const r of results) {
  const p = r.stm?.parameters ? Object.values(r.stm.parameters).map((v) => v.toExponential(1)).join(', ') : '-';
  console.log(`| ${r.id} | ${fmt(r.toleranceM)} | ${SETTINGS.map((s) => fmt(r[s.id].worstM)).join(' | ')} | ${fmt(r.orekitMinusNyx.worstM)} | ${r.stm ? r.stm.worst.toExponential(1) : '-'} | ${p} | ${r[SETTINGS[0].id].worstM <= r.toleranceM ? 'yes' : 'NO'} |`);
}
const stms = results.filter((r) => r.stm);
if (stms.length) {
  console.log();
  console.log(`STM, largest relative column difference (suite request): ${Math.max(...stms.map((r) => r.stm.worst)).toExponential(2)} over ${stms.length} cases`);
  for (const [name, key] of ROWS) { const rows = stms.filter((r) => r.row === key); if (rows.length) console.log(`  ${name}: ${Math.max(...rows.map((r) => r.stm.worst)).toExponential(2)}`); }
  for (const p of ['SRP_AREA_OVER_MASS', 'DRAG_AREA_OVER_MASS']) {
    const v = stms.filter((r) => r.stm.parameters?.[p] !== undefined).map((r) => r.stm.parameters[p]);
    if (v.length) console.log(`  ${p} column: ${Math.max(...v).toExponential(2)} over ${v.length} cases`);
  }
}
if (NYX.skipped.length) {
  console.log();
  console.log(`Not modelled by Nyx (${NYX.skipped.length}): ${NYX.skipped.map((s) => s.id).join(', ')}`);
}

const out = o.out ?? path.join(here, `summary-${path.basename(nyxFile, '.json')}.json`);
const summary = {
  note: 'HPOP against Nyx Space (tests/evidence/nyx/score-nyx.mjs): the largest 3D position difference over 24 h, hourly samples, by case, HPOP at three integrator settings; Orekit 13.1 against Nyx beside it; STM: largest relative column difference at the suite\'s request, and of the Cr*A/m and Cd*A/m columns.',
  module: { version: JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version, sha256: createHash('sha256').update(wasm).digest('hex') },
  nyx: { file: path.basename(nyxFile), sha256: sha256(nyxFile), caseExportSha256: NYX.caseExportSha256, tool: NYX.tool, settings: NYX.settings, inputFiles: NYX.inputFiles,
    ...(o.stm ? { stmFile: path.resolve(o.stm), stmSha256: sha256(o.stm) } : {}) },
  node: process.version, host: `${os.cpus()[0].model}, ${os.availableParallelism()} cores`,
  settings: SETTINGS, tolerancesM: TOL,
  cases: results,
  skipped: NYX.skipped, diagnostics,
};
if (o.stm && !o.only && SETTINGS.length === ALL.length && ['msis-published', 'fine', 'naif-bpc'].every((key) => variants[key])) explainSummary(summary, path.resolve(path.dirname(o['msis-published']), '..'));
fs.writeFileSync(out, `${JSON.stringify(summary, null, 1)}\n`);
console.error(`-> ${out}`);
