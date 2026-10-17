#!/usr/bin/env node
// The Orekit agreement table: for every case of fixtures/orekit/orekit-reference.json,
// the largest 3D position difference over 24 h between FFM (the shipped WASM
// through the SDK's browser harness) and Orekit 13.1, at three integrator settings:
//
//   suite    the suite's request (tests/orekit_reference.test.mjs): RK78 at a
//            relative tolerance of 1e-13 (the point-mass cases at 1e-15) and steps
//            of at most 300 s. FFM's own integration error is part of the
//            difference.
//   steps30  the same tolerances and steps of at most 30 s.
//   finest   a tolerance of 1e-15 and steps of at most 10 s. It shows how far the
//            integrator settings still move the rows of steps30, and is the
//            reference of FFM's own integration error at the suite's request.
//
//   node tests/orekit-summary.mjs [out.json] [--reference <orekit-reference.json>]
//
// --reference scores against another file of the generator's format, for example one
// written by `java -Dorekit.simpleEOP=true ... OrekitReference.java`, which leaves
// out the IERS 2010 sub-daily corrections to polar motion and UT1 that the checked-in
// reference applies (tests/fixtures/orekit/SOURCES.md).
//
// Prints Markdown tables (README.md quotes them) and writes the numbers as JSON
// (default tests/evidence/orekit/summary.json).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs } from './lib/orekitCases.mjs';
import { buildMetrics, scoreResponse } from './evidence/orekit/scoring.mjs';

const { values: o, positionals } = parseArgs({ options: { reference: { type: 'string' } }, allowPositionals: true });
const reference = o.reference ? JSON.parse(fs.readFileSync(o.reference, 'utf8')) : REFERENCE;
const out = positionals[0] ?? new URL('./evidence/orekit/summary.json', import.meta.url).pathname;
const WASM = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const MANIFEST = new URL('../plugin-manifest.json', import.meta.url);
const wasm = fs.readFileSync(WASM), manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

const SETTINGS = [{ id: 'suite', maxStep: 300, label: 'steps <= 300 s' }, { id: 'steps30', maxStep: 30, label: 'steps <= 30 s' },
  { id: 'finest', maxStep: 10, tolerance: 1e-15, label: 'steps <= 10 s, 1e-15' }];
const ORBITS = ['LEO400', 'SSO700', 'GPS', 'GEO', 'MOLNIYA'];
// The paper's three rows, and the force families of its equivalence column.
const ROWS = [
  ['Point mass', (c) => !(c.degree > 0 || c.thirdBodies || c.srp || c.drag)],
  ['Field, third bodies, radiation pressure, tides, relativity, thrust', (c) => !c.drag && (c.degree > 0 || c.thirdBodies || c.srp)],
  ['With drag', (c) => c.drag],
];
const caseId = (c) => c.forces.split('-')[0];
const FAMILIES = [
  ['Geopotential, EGM2008 (F1 F2 F3)', /^(F1|F2|F3)$/], ['Geopotential, EGM96 and 36Z,24T (G1 G2)', /^(G1|G2)$/],
  ['Sun and Moon (F4 Z1)', /^(F4|Z1)$/], ['Radiation pressure (F5 Z2)', /^(F5|Z2)$/], ['Earth radiation (A1)', /^A1$/],
  ['Solid tides (T1)', /^T1$/], ['Ocean tides (O1 O2)', /^(O1|O2)$/], ['Relativity (R1 R2)', /^(R1|R2)$/],
  ['In-track thrust (I1)', /^I1$/], ['Drag-area rate (B1)', /^B1$/], ['Drag (F6 Z3 W1 J1)', /^(F6|Z3|W1|J1)$/],
];

const work = fs.mkdtempSync(new URL('./evidence/orekit/.refresh-', import.meta.url).pathname);
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
const metrics = buildMetrics(work);
const max = (values) => metrics({ mode: 'maximum', values });
const met = (value, limit) => metrics({ mode: 'met', value, limit });
const results = Object.fromEntries(SETTINGS.map((s) => [s.id, []]));
for (const setting of SETTINGS) {
  for (const c of reference.cases) {
    const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
    try {
      const response = await harness.invoke({ methodId: 'invoke', inputs: requestInputs(c, { maxStep: setting.maxStep, ...(setting.tolerance ? { tolerance: setting.tolerance } : {}) }) });
      if (response.statusCode !== 0) throw new Error(`${c.orbit} ${c.forces}: ${response.errorCode}: ${response.errorMessage}`);
      const row = { orbit: c.orbit, forces: c.forces, ...scoreResponse(c, response, metrics, Boolean(c.parameters && setting.id === 'suite')) };
      results[setting.id].push(row);
    } finally { harness.destroy(); }
  }
  console.error(`${setting.id} done`);
}

// (FFM with - without) - (Orekit with - without) at every sample, for a force added to a base set.
const differential = (setting, orbit, base, added) => {
  const a = results[setting].find((r) => r.orbit === orbit && r.forces.startsWith(`${base}-`)), b = results[setting].find((r) => r.orbit === orbit && r.forces.startsWith(`${added}-`));
  const oa = reference.cases.find((c) => c.orbit === orbit && c.forces.startsWith(`${base}-`)), ob = reference.cases.find((c) => c.orbit === orbit && c.forces.startsWith(`${added}-`));
  if (!a || !b || !oa || !ob) return undefined;
  return metrics({ mode: 'difference', a: a.positions, b: b.positions, referenceA: oa.samples, referenceB: ob.samples });
};
const DIFFERENTIALS = [['A1', 'F5', 'LEO400'], ['A1', 'F5', 'GPS'], ['O1', 'F4', 'LEO400'], ['O1', 'F4', 'GPS']].map(([added, base, orbit]) => ({
  added, base, orbit, ...Object.fromEntries(SETTINGS.map((s) => [`${s.id}M`, differential(s.id, orbit, base, added)])) }));

// FFM's own integration error at the suite's request: its trajectory there against its own at the finest setting.
const integrationError = (c) => {
  const a = results.suite.find((r) => r.orbit === c.orbit && r.forces === c.forces), b = results.finest.find((r) => r.orbit === c.orbit && r.forces === c.forces);
  return metrics({ mode: 'difference', a: a.positions, b: b.positions });
};
const fmt = (value) => metrics({ mode: 'format', value });
const maxOf = (rows) => rows.length ? max(rows.map((r) => r.worstM)) : undefined;
const find = (id, pred) => results[id].filter((r) => pred(reference.cases.find((c) => c.orbit === r.orbit && c.forces === r.forces)));

console.log(`| Force set | ${SETTINGS.map((s) => `${s.id} (${s.label})`).join(' | ')} |`);
console.log(`|---|${SETTINGS.map(() => '---:').join('|')}|`);
for (const [name, pred] of ROWS) console.log(`| ${name} | ${SETTINGS.map((s) => fmt(maxOf(find(s.id, pred)))).join(' | ')} |`);
console.log(`| All ${reference.cases.length} cases | ${SETTINGS.map((s) => fmt(maxOf(results[s.id]))).join(' | ')} |`);
console.log();
console.log(`| Orbit | Row | ${SETTINGS.map((s) => s.id).join(' | ')} |`);
console.log(`|---|---|${SETTINGS.map(() => '---:').join('|')}|`);
for (const orbit of ORBITS) for (const [name, pred] of ROWS) {
  const cells = SETTINGS.map((s) => maxOf(find(s.id, (c) => c.orbit === orbit && pred(c))));
  if (cells.some((x) => x !== undefined)) console.log(`| ${orbit} | ${name} | ${cells.map((x) => (x === undefined ? '-' : fmt(x))).join(' | ')} |`);
}
console.log();
console.log(`| Force family | ${SETTINGS.map((s) => s.id).join(' | ')} |`);
console.log(`|---|${SETTINGS.map(() => '---:').join('|')}|`);
for (const [name, re] of FAMILIES) {
  const cells = SETTINGS.map((s) => maxOf(results[s.id].filter((r) => re.test(caseId(r)))));
  if (cells.some((x) => x !== undefined)) console.log(`| ${name} | ${cells.map((x) => (x === undefined ? '-' : fmt(x))).join(' | ')} |`);
}
console.log();
const jacobians = results.suite.filter((r) => r.jacobians);
console.log(`State-transition matrix, largest relative column difference (suite request): ${metrics({ mode: 'format-scientific', value: max(jacobians.map((r) => r.jacobians.stm)) })}`);
console.log(`Parameter columns, largest relative difference (suite request): ${metrics({ mode: 'format-scientific', value: max(jacobians.flatMap((r) => Object.values(r.jacobians.parameters))) })}`);
console.log();
console.log(`| Force added to a base set | Orbit | ${SETTINGS.map((s) => s.id).join(' | ')} |`);
console.log(`|---|---|${SETTINGS.map(() => '---:').join('|')}|`);
for (const d of DIFFERENTIALS) console.log(`| ${d.added} on ${d.base} | ${d.orbit} | ${SETTINGS.map((s) => `${metrics({ mode: 'format-mm', value: d[`${s.id}M`] })} mm`).join(' | ')} |`);
console.log();
console.log('| Orbit | FFM\'s own integration error at the suite\'s request |');
console.log('|---|---:|');
for (const orbit of ORBITS) console.log(`| ${orbit} | ${fmt(max(reference.cases.filter((c) => c.orbit === orbit).map(integrationError)))} |`);

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exported = JSON.parse(fs.readFileSync(new URL('./evidence/cases/ffm-reference-cases.json', import.meta.url), 'utf8'));
const limitFor = (c) => exported.protocol.tolerancesM.default[exported.cases.find((g) => g.id === `${c.orbit} ${c.forces}`).toleranceClass];
const inputFiles = [new URL(o.reference ?? './fixtures/orekit/orekit-reference.json', import.meta.url), ...['eop-2026-06.json', 'eop-2026-08.json', 'spw-2026-08.json', 'jb2008-2026-06.json', 'OrekitReference.java'].map((name) => new URL(`./fixtures/orekit/${name}`, import.meta.url)), new URL('./evidence/cases/ffm-reference-cases.json', import.meta.url), ...['./orekit-summary.mjs', './evidence/orekit/scoring.mjs', './evidence/orekit/score-metrics.cpp', './evidence/orekit/check-orekit.mjs'].map((file) => new URL(file, import.meta.url))];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({
  note: 'FFM against Orekit 13.1 (tests/orekit-summary.mjs): the largest 3D position difference over 24 h, by case, at the suite\'s integrator settings, with steps of at most 30 s, and at tolerance 1e-15 with steps of at most 10 s.',
  module: { version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, sha256: createHash('sha256').update(wasm).digest('hex') },
  reference: o.reference ? path.basename(o.reference) : 'tests/fixtures/orekit/orekit-reference.json',
  orekit: { version: '13.1', settings: reference.source, sourcePin: { kind: 'reference-generator-source', path: '../../fixtures/orekit/OrekitReference.java', sha256: hash(new URL('./fixtures/orekit/OrekitReference.java', import.meta.url)) }, engineBinary: { status: 'unavailable', reason: 'The original Orekit 13.1 jar is not retained locally; the stored trajectory and generation source are pinned. Installed 13.1.2 and 13.1.6 jars are not substituted.' } },
  fileHashes: inputFiles.map((file) => ({ path: path.relative(new URL('./evidence/orekit/', import.meta.url).pathname, file.pathname), sha256: hash(file) })),
  verdict: Object.fromEntries(SETTINGS.map((setting) => { const rows = results[setting.id]; const { flags, ...verdict } = metrics({ mode: 'verdict', values: rows.map((r) => r.worstM), limits: rows.map(limitFor) }); return [setting.id, verdict]; })),
  skipped: [],
  settings: SETTINGS,
  cases: reference.cases.map((c) => ({ id: `${c.orbit} ${c.forces}`, orbit: c.orbit, forces: c.forces, toleranceM: limitFor(c), ...Object.fromEntries(SETTINGS.map((s) => {
    const r = results[s.id].find((x) => x.orbit === c.orbit && x.forces === c.forces);
    return [s.id, { worstM: r.worstM, met: met(r.worstM, limitFor(c)), atHour: r.atHour, steps: r.steps, ...(r.jacobians ? { jacobians: r.jacobians } : {}) }];
  })), integrationErrorM: integrationError(c) })),
  differentials: DIFFERENTIALS,
}, null, 1)}\n`);
