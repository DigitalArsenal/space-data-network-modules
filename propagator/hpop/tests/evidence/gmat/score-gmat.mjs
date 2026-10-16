#!/usr/bin/env node
// HPOP against NASA GMAT on the reference cases GMAT models: the largest 3D
// position difference over 24 h (25 hourly samples) between the shipped HPOP
// WASM (the SDK's browser harness) and each GMAT trajectory of run-gmat.mjs,
// with HPOP at the three settings of the Orekit table (tests/orekit-summary.mjs):
//
//   suite    RK78 at 1e-13 (point mass 1e-15), steps <= 300 s (the suite's request)
//   steps30  the same, steps <= 30 s
//   finest   1e-15, steps <= 10 s
//
// and, where the GMAT file carries them, the 6x6 STMs against HPOP's analytic
// STM at the suite's request (largest relative column difference, position and
// velocity rows apart, as tests/lib/orekitCases.mjs scoreJacobians). Orekit 13.1
// against GMAT on the same case is printed beside it: where Orekit and HPOP
// are equally far from GMAT, the difference is GMAT's.
//
//   node tests/evidence/gmat/score-gmat.mjs <gmat.json> [--stm <gmat-stm.json>]
//        [--out summary.json] [--settings suite,steps30,finest] [--only s]
//
// HPOP requests are the Orekit suite's (tests/lib/orekitCases.mjs requestInputs)
// for the same case; on cases GMAT ran with Jacchia-Roberts (R2022a) HPOP is
// asked for Jacchia-Roberts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs } from '../../lib/orekitCases.mjs';
import { decodePrw, decodeResult, sds } from '../../lib/prwCodec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: o, positionals } = parseArgs({ options: {
  stm: { type: 'string' }, out: { type: 'string' }, settings: { type: 'string', default: 'suite,steps30,finest' }, only: { type: 'string' },
}, allowPositionals: true });
const gmatFile = positionals[0];
if (!gmatFile) throw new Error('usage: score-gmat.mjs <gmat.json> [--stm <gmat-stm.json>] [--out summary.json]');
const GMAT = JSON.parse(fs.readFileSync(gmatFile, 'utf8'));
const STM = o.stm ? JSON.parse(fs.readFileSync(o.stm, 'utf8')) : null;
const CASES = JSON.parse(fs.readFileSync(path.join(here, '../cases/hpop-reference-cases.json'), 'utf8'));
const TOL = CASES.protocol.tolerancesM.gmat;
const WASM = new URL('../../../dist/isomorphic/module.wasm', import.meta.url);
const MANIFEST = new URL('../../../plugin-manifest.json', import.meta.url);
const wasm = fs.readFileSync(WASM), manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

const ALL = [{ id: 'suite', maxStep: 300, label: 'steps <= 300 s (the suite\'s request)' }, { id: 'steps30', maxStep: 30, label: 'steps <= 30 s' },
  { id: 'finest', maxStep: 10, tolerance: 1e-15, label: 'tolerance 1e-15, steps <= 10 s' }];
const SETTINGS = ALL.filter((s) => o.settings.split(',').includes(s.id));
const ORBITS = ['LEO400', 'SSO700', 'GPS', 'GEO', 'MOLNIYA'];
const ROWS = [['Point mass', 'pointMass'], ['Field, third bodies, radiation pressure, tides, relativity, thrust', 'fullNoDrag'], ['With drag', 'drag']];
const caseId = (c) => c.forceSet.split('-')[0];
const FAMILIES = [
  ['Geopotential, EGM2008 (F1 F2 F3)', /^(F1|F2|F3)$/], ['Geopotential, EGM96 and 36Z,24T (G1 G2)', /^(G1|G2)$/],
  ['Sun and Moon (F4 Z1)', /^(F4|Z1)$/], ['Radiation pressure (F5 Z2)', /^(F5|Z2)$/], ['EME2000 (E1)', /^E1$/],
  ['Solid tides (T1)', /^T1$/], ['Relativity (R2)', /^R2$/], ['In-track thrust (I1)', /^I1$/], ['Drag (F6 Z3 W1)', /^(F6|Z3|W1)$/],
];
const reference = (g) => REFERENCE.cases.find((c) => `${c.orbit} ${c.forces}` === g.id);
const norm3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const worstOf = (positions, samples) => {
  const d = positions.map((p, i) => norm3(p, samples[i + 1].slice(1, 4)));
  const worst = Math.max(...d);
  return { worstM: worst, atHour: samples[d.indexOf(worst) + 1][0] / 3600 };
};

function inputs(g, setting, stm) {
  const c = reference(g);
  return requestInputs(c, { maxStep: setting.maxStep, ...(setting.tolerance ? { tolerance: setting.tolerance } : {}), edit: (exec) => {
    if (g.atmosphere === 'JACCHIA_ROBERTS') exec.FORCES.ATMOSPHERE_MODEL = sds.prwAtmosphereFamily.JACCHIA_ROBERTS;
    if (stm) Object.assign(exec, { INCLUDE_STM: true, STM_TECHNIQUE: sds.prwDerivativeTechnique.ANALYTIC,
      DENSITY_TREATMENT: sds.prwDensityTreatment.FINITE_DIFFERENCE, DYNAMIC_PARAMETERS: [] });
  } });
}
async function run(g, setting, stm = false) {
  const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  try {
    const response = await harness.invoke({ methodId: 'invoke', inputs: inputs(g, setting, stm) });
    if (response.statusCode !== 0) throw new Error(`${g.id}: ${response.errorCode}: ${response.errorMessage}`);
    return response;
  } finally { harness.destroy(); }
}

// Largest relative difference of an STM column (position rows and velocity
// rows apart) over the samples, HPOP against GMAT.
function stmDifference(response, gstm) {
  const root = decodePrw(response.outputs.find((x) => x.portId === 'response').payload).EXECUTION_RESULT;
  const rel = (a, b) => { const d = Math.hypot(...a.map((x, i) => x - b[i])), r = Math.hypot(...b); return r > 0 ? d / r : d; };
  let worst = 0, worstAt = 0;
  root.SAMPLES.forEach((sample, k) => {
    const m = sample.STM.VALUES, n = sample.STM.DIMENSION, ref = gstm[k + 1];
    for (let j = 0; j < 6; ++j) for (const rows of [[0, 1, 2], [3, 4, 5]]) {
      const d = rel(rows.map((i) => m[i * n + j]), rows.map((i) => ref[i * 6 + j]));
      if (d > worst) { worst = d; worstAt = (k + 1); }
    }
  });
  return { worst, atHour: worstAt };
}

const cases = GMAT.cases.filter((g) => !o.only || g.id.includes(o.only));
const results = [];
for (const g of cases) {
  const c = reference(g);
  const orekit = g.atmosphere === 'JACCHIA_ROBERTS' ? null : worstOf(c.samples.slice(1).map((s) => s.slice(1, 4)), g.samples);
  const row = { id: g.id, orbit: g.orbit, forceSet: g.forceSet, row: g.row, toleranceClass: g.toleranceClass, toleranceM: TOL[g.toleranceClass],
    ...(g.atmosphere ? { atmosphere: g.atmosphere } : {}), icrfDriftM: g.icrfDriftM, orekitMinusGmat: orekit };
  for (const s of SETTINGS) {
    const result = decodeResult(await run(g, s));
    const positions = result.samples.map((x) => x.position.map((v) => v * 1000));
    row[s.id] = { ...worstOf(positions, g.samples), steps: result.samples.at(-1).integrationSteps };
    if (s.id === 'suite') row.hpopPositions = positions;
  }
  const gs = STM?.cases.find((x) => x.id === g.id);
  if (gs) row.stm = stmDifference(await run(g, ALL[0], true), gs.stm);
  results.push(row);
  console.error(`${g.id}: ${SETTINGS.map((s) => `${s.id} ${row[s.id].worstM.toExponential(3)} m`).join(', ')}${orekit ? `; Orekit-GMAT ${orekit.worstM.toExponential(3)} m` : ''}${row.stm ? `; STM ${row.stm.worst.toExponential(2)}` : ''}`);
}

const mm = (m) => (m * 1000 < 10 ? (m * 1000).toFixed(2) : (m * 1000).toFixed(1));
const fmt = (m) => (m === undefined ? '-' : m < 0.01 ? `${mm(m)} mm` : m < 1 ? `${(m * 100).toFixed(m < 0.1 ? 1 : 0)} cm` : `${m.toFixed(2)} m`);
const maxOf = (rows, key) => {
  const values = rows.map((r) => (key === 'orekit' ? r.orekitMinusGmat?.worstM : r[key].worstM)).filter((v) => v !== undefined);
  return values.length ? Math.max(...values) : undefined;
};
const label = GMAT.tool.version.replace('Build Date: ', 'GmatConsole built ');
console.log(`HPOP against GMAT (${label}), ${GMAT.settings.integrator} at ${GMAT.settings.accuracy}, steps <= ${GMAT.settings.maxStepS} s; ${results.length} cases.\n`);
console.log(`| Force set | Cases | ${SETTINGS.map((s) => s.label).join(' | ')} | Orekit 13.1 - GMAT |`);
console.log(`|---|---:|${SETTINGS.map(() => '---:').join('|')}|---:|`);
for (const [name, key] of ROWS) {
  const rows = results.filter((r) => r.row === key);
  if (rows.length) console.log(`| ${name} | ${rows.length} | ${SETTINGS.map((s) => fmt(maxOf(rows, s.id))).join(' | ')} | ${fmt(maxOf(rows, 'orekit'))} |`);
}
console.log(`| All ${results.length} cases | ${results.length} | ${SETTINGS.map((s) => fmt(maxOf(results, s.id))).join(' | ')} | ${fmt(maxOf(results, 'orekit'))} |`);
console.log();
console.log(`| Orbit | Row | ${SETTINGS.map((s) => s.id).join(' | ')} | Orekit - GMAT |`);
console.log(`|---|---|${SETTINGS.map(() => '---:').join('|')}|---:|`);
for (const orbit of ORBITS) for (const [name, key] of ROWS) {
  const rows = results.filter((r) => r.orbit === orbit && r.row === key);
  if (rows.length) console.log(`| ${orbit} | ${name} | ${SETTINGS.map((s) => fmt(maxOf(rows, s.id))).join(' | ')} | ${fmt(maxOf(rows, 'orekit'))} |`);
}
console.log();
console.log(`| Force family | ${SETTINGS.map((s) => s.id).join(' | ')} | Orekit - GMAT |`);
console.log(`|---|${SETTINGS.map(() => '---:').join('|')}|---:|`);
for (const [name, re] of FAMILIES) {
  const rows = results.filter((r) => re.test(caseId(r)));
  if (rows.length) console.log(`| ${name} | ${SETTINGS.map((s) => fmt(maxOf(rows, s.id))).join(' | ')} | ${fmt(maxOf(rows, 'orekit'))} |`);
}
console.log();
console.log(`| Case | Limit | ${SETTINGS.map((s) => s.id).join(' | ')} | Orekit - GMAT | STM (rel.) | Within limit (${SETTINGS[0].id}) |`);
console.log(`|---|---:|${SETTINGS.map(() => '---:').join('|')}|---:|---:|---|`);
for (const r of results) console.log(`| ${r.id}${r.atmosphere === 'JACCHIA_ROBERTS' ? ' (JR)' : ''} | ${fmt(r.toleranceM)} | ${SETTINGS.map((s) => fmt(r[s.id].worstM)).join(' | ')} | ${fmt(r.orekitMinusGmat?.worstM)} | ${r.stm ? r.stm.worst.toExponential(1) : '-'} | ${r[SETTINGS[0].id].worstM <= r.toleranceM ? 'yes' : 'NO'} |`);
const stms = results.filter((r) => r.stm);
if (stms.length) {
  console.log();
  console.log(`STM, largest relative column difference (suite request): ${Math.max(...stms.map((r) => r.stm.worst)).toExponential(2)} over ${stms.length} cases`);
  for (const [name, key] of ROWS) { const rows = stms.filter((r) => r.row === key); if (rows.length) console.log(`  ${name}: ${Math.max(...rows.map((r) => r.stm.worst)).toExponential(2)}`); }
}
if (GMAT.skipped.length) {
  console.log();
  console.log(`Not modelled by GMAT (${GMAT.skipped.length}): ${GMAT.skipped.map((s) => s.id).join(', ')}`);
}

const out = o.out ?? path.join(here, `summary-${path.basename(gmatFile, '.json')}.json`);
fs.writeFileSync(out, `${JSON.stringify({
  note: 'HPOP against NASA GMAT (tests/evidence/gmat/score-gmat.mjs): the largest 3D position difference over 24 h, hourly samples, by case, HPOP at three integrator settings; Orekit 13.1 against GMAT beside it; STM: largest relative column difference at the suite\'s request.',
  module: { version: JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version, sha256: createHash('sha256').update(wasm).digest('hex') },
  gmat: { file: path.basename(gmatFile), sha256: createHash('sha256').update(fs.readFileSync(gmatFile)).digest('hex'), tool: GMAT.tool, settings: GMAT.settings,
    ...(o.stm ? { stmFile: path.basename(o.stm), stmSha256: createHash('sha256').update(fs.readFileSync(o.stm)).digest('hex') } : {}) },
  node: process.version, host: `${os.cpus()[0].model}, ${os.availableParallelism()} cores`,
  settings: SETTINGS, tolerancesM: TOL,
  cases: results.map(({ hpopPositions, ...r }) => r),
  skipped: GMAT.skipped,
}, null, 1)}\n`);
console.error(`-> ${out}`);
