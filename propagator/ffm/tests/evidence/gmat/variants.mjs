#!/usr/bin/env node
// GMAT settings other than run-gmat.mjs's defaults, scored the same way
// (FFM with steps <= 30 s, and Orekit 13.1, against GMAT), to show what each
// setting choice of the runner is worth:
//
//   - integrator: the earlier runner's PrinceDormand78 at 1e-13 with steps
//     <= 60 s; RungeKutta89 at 1e-14 with steps <= 5, 2 and 1 s on the
//     radiation-pressure cases (GMAT does not stop at shadow boundaries);
//   - solid tides: GMAT's 'Solid' (step 1 only) and 'SolidAndPole' (steps 1
//     and 2 plus the solid and ocean pole tides) as GMAT applies them;
//   - CSSI space weather: GMAT reading the synthetic file as published (rows
//     from 2026-08-01 in the daily-predicted block) and with every row moved
//     to the observed block.
//
//   node tests/evidence/gmat/variants.mjs <GmatConsole> <work dir> [out.json]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [gmat, workArg, outArg] = process.argv.slice(2);
if (!workArg) throw new Error('usage: variants.mjs <GmatConsole> <work dir> [out.json]');
const work = path.resolve(workArg, 'variants');
const out = outArg ?? path.join(here, 'variants.json');
const VARIANTS = [
  { id: 'pd78-60s', label: 'PrinceDormand78 at 1e-13, steps <= 60 s', args: ['--integrator', 'PD78', '--accuracy', '1e-13', '--max-step', '60'] },
  ...[5, 2, 1].map((s) => ({ id: `rk89-${s}s-srp`, label: `RungeKutta89 at 1e-14, steps <= ${s} s (radiation pressure cases)`, args: ['--max-step', String(s)], only: ['F5', 'Z2'] })),
  { id: 'tide-solid', label: 'TideModel Solid (IERS step 1 only)', args: ['--tide', 'Solid'], only: ['T1'] },
  { id: 'tide-solid-and-pole', label: 'TideModel SolidAndPole (steps 1 and 2, solid and ocean pole tides)', args: ['--tide', 'SolidAndPole'], only: ['T1'] },
  { id: 'cssi-published', label: 'CSSI file read by GMAT, as published', args: ['--cssi', 'published'], only: ['W1'] },
  { id: 'cssi-observed', label: 'CSSI file read by GMAT, every row in the observed block', args: ['--cssi', 'observed'], only: ['W1'] },
];
const doc = { about: 'GMAT setting variants against FFM (steps <= 30 s) and Orekit 13.1: largest 3D difference over 24 h, m. tests/evidence/gmat/variants.mjs.', variants: [] };
for (const v of VARIANTS) {
  const filters = v.only ?? [''];
  const cases = [];
  for (const only of filters) {
    const traj = path.join(work, `${v.id}-${only || 'all'}.json`), summary = path.join(work, `${v.id}-${only || 'all'}.summary.json`);
    execFileSync(process.execPath, [path.join(here, 'run-gmat.mjs'), gmat, path.join(work, v.id), traj, ...(only ? ['--only', only] : []), ...v.args], { stdio: 'ignore' });
    execFileSync(process.execPath, [path.join(here, 'score-gmat.mjs'), traj, '--settings', 'steps30', '--out', summary, ...(only ? ['--only', only] : [])], { stdio: 'ignore' });
    const s = JSON.parse(fs.readFileSync(summary, 'utf8'));
    for (const r of s.cases.filter((x) => !only || x.id.includes(only))) cases.push({ id: r.id, ffmMinusGmatM: r.steps30.worstM, orekitMinusGmatM: r.orekitMinusGmat?.worstM ?? null });
  }
  doc.variants.push({ id: v.id, label: v.label, args: v.args, gmat: JSON.parse(fs.readFileSync(path.join(work, `${v.id}-${filters[0] || 'all'}.json`), 'utf8')).tool.version, cases });
  console.error(`${v.id}: ${cases.length} cases, largest FFM-GMAT ${Math.max(...cases.map((c) => c.ffmMinusGmatM)).toExponential(3)} m`);
}
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1).replace(/\{\n\s+("id": [^{}]*?)\n\s+\}/g, (m, body) => `{${body.replace(/\n\s+/g, ' ')}}`)}\n`);
