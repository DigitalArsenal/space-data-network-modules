#!/usr/bin/env node
// The Orekit agreement table: for every case of fixtures/orekit/orekit-reference.json,
// the largest 3D position difference over 24 h between HPOP (the shipped WASM
// through the SDK's browser harness) and Orekit 13.1, at three integrator settings:
//
//   suite    the suite's request (tests/orekit_reference.test.mjs): RK78 at a
//            relative tolerance of 1e-13 (the point-mass cases at 1e-15) and steps
//            of at most 300 s. HPOP's own integration error is part of the
//            difference.
//   steps30  the same tolerances and steps of at most 30 s.
//   finest   a tolerance of 1e-15 and steps of at most 10 s. It shows how far the
//            integrator settings still move the rows of steps30, and is the
//            reference of HPOP's own integration error at the suite's request.
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
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, integratorTolerance, requestInputs, scoreJacobians } from './lib/orekitCases.mjs';
import { decodeResult } from './lib/prwCodec.mjs';

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

const norm3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const results = Object.fromEntries(SETTINGS.map((s) => [s.id, []]));
for (const setting of SETTINGS) {
  for (const c of reference.cases) {
    const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
    try {
      const response = await harness.invoke({ methodId: 'invoke', inputs: requestInputs(c, { maxStep: setting.maxStep, ...(setting.tolerance ? { tolerance: setting.tolerance } : {}) }) });
      if (response.statusCode !== 0) throw new Error(`${c.orbit} ${c.forces}: ${response.errorCode}: ${response.errorMessage}`);
      const result = decodeResult(response);
      const positions = result.samples.map((s) => s.position.map((v) => v * 1000));
      const difference = positions.map((p, i) => norm3(p, c.samples[i + 1].slice(1, 4)));
      const worst = Math.max(...difference);
      const row = { orbit: c.orbit, forces: c.forces, worstM: worst, atHour: c.samples[difference.indexOf(worst) + 1][0] / 3600,
        steps: result.samples.at(-1).integrationSteps, positions };
      if (c.parameters && setting.id === 'suite') row.jacobians = scoreJacobians(c, response);
      results[setting.id].push(row);
    } finally { harness.destroy(); }
  }
  console.error(`${setting.id} done`);
}

// (HPOP with - without) - (Orekit with - without) at every sample, for a force added to a base set.
const differential = (setting, orbit, base, added) => {
  const a = results[setting].find((r) => r.orbit === orbit && r.forces.startsWith(`${base}-`)), b = results[setting].find((r) => r.orbit === orbit && r.forces.startsWith(`${added}-`));
  const oa = reference.cases.find((c) => c.orbit === orbit && c.forces.startsWith(`${base}-`)), ob = reference.cases.find((c) => c.orbit === orbit && c.forces.startsWith(`${added}-`));
  if (!a || !b || !oa || !ob) return undefined;
  return Math.max(...a.positions.map((p, i) => norm3(
    p.map((v, k) => b.positions[i][k] - v), ob.samples[i + 1].slice(1, 4).map((v, k) => v - oa.samples[i + 1][1 + k]))));
};
const DIFFERENTIALS = [['A1', 'F5', 'LEO400'], ['A1', 'F5', 'GPS'], ['O1', 'F4', 'LEO400'], ['O1', 'F4', 'GPS']].map(([added, base, orbit]) => ({
  added, base, orbit, ...Object.fromEntries(SETTINGS.map((s) => [`${s.id}M`, differential(s.id, orbit, base, added)])) }));

// HPOP's own integration error at the suite's request: its trajectory there against its own at the finest setting.
const integrationError = (c) => {
  const a = results.suite.find((r) => r.orbit === c.orbit && r.forces === c.forces), b = results.finest.find((r) => r.orbit === c.orbit && r.forces === c.forces);
  return Math.max(...a.positions.map((p, i) => norm3(p, b.positions[i])));
};
const mm = (m) => (m * 1000 < 10 ? (m * 1000).toFixed(2) : (m * 1000).toFixed(1));
const cm = (m) => (m < 0.1 ? `${(m * 100).toFixed(1)} cm` : `${(m * 100).toFixed(0)} cm`);
const fmt = (m) => (m < 0.01 ? `${mm(m)} mm` : cm(m));
const maxOf = (rows) => rows.length ? Math.max(...rows.map((r) => r.worstM)) : undefined;
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
console.log(`State-transition matrix, largest relative column difference (suite request): ${Math.max(...jacobians.map((r) => r.jacobians.stm)).toExponential(2)}`);
console.log(`Parameter columns, largest relative difference (suite request): ${Math.max(...jacobians.flatMap((r) => Object.values(r.jacobians.parameters))).toExponential(2)}`);
console.log();
console.log(`| Force added to a base set | Orbit | ${SETTINGS.map((s) => s.id).join(' | ')} |`);
console.log(`|---|---|${SETTINGS.map(() => '---:').join('|')}|`);
for (const d of DIFFERENTIALS) console.log(`| ${d.added} on ${d.base} | ${d.orbit} | ${SETTINGS.map((s) => `${(d[`${s.id}M`] * 1000).toFixed(3)} mm`).join(' | ')} |`);
console.log();
console.log('| Orbit | HPOP\'s own integration error at the suite\'s request |');
console.log('|---|---:|');
for (const orbit of ORBITS) console.log(`| ${orbit} | ${fmt(Math.max(...reference.cases.filter((c) => c.orbit === orbit).map(integrationError)))} |`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({
  note: 'HPOP against Orekit 13.1 (tests/orekit-summary.mjs): the largest 3D position difference over 24 h, by case, at the suite\'s integrator settings, with steps of at most 30 s, and at tolerance 1e-15 with steps of at most 10 s.',
  module: { version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, sha256: createHash('sha256').update(wasm).digest('hex') },
  reference: o.reference ? path.basename(o.reference) : 'tests/fixtures/orekit/orekit-reference.json',
  node: process.version, host: `${os.cpus()[0].model}, ${os.availableParallelism()} cores`,
  settings: SETTINGS,
  cases: reference.cases.map((c) => ({ orbit: c.orbit, forces: c.forces, ...Object.fromEntries(SETTINGS.map((s) => {
    const r = results[s.id].find((x) => x.orbit === c.orbit && x.forces === c.forces);
    return [s.id, { worstM: r.worstM, atHour: r.atHour, steps: r.steps, ...(r.jacobians ? { jacobians: r.jacobians } : {}) }];
  })), integrationErrorM: integrationError(c) })),
  differentials: DIFFERENTIALS,
}, null, 1)}\n`);
