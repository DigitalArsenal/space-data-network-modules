#!/usr/bin/env node
// How far the embedded Moon field has to go: the one-day fit and the day-2 prediction error of two LRO windows (the planetary E2E's
// fit, tests/lib/planetaryFit.mjs) at a sweep of field degrees, and the lowest degree past which the day-2 error changes by under 1%.
//
//   PATH=$HOME/.wasmedge/bin:$PATH headless-run node tests/planetary-degree-sweep.mjs [out.json]
//
// The error is the root of the sum of the windows' squared day-2 rms errors. Run against an artifact that embeds the field to at
// least the highest degree swept (the sweep ends at 260).
import fs from 'node:fs';
import { destroyLanes, MOON, readTruth } from './lib/planetary.mjs';
import { byDay, fit, fitIndices } from './lib/planetaryFit.mjs';

const KERNEL = fs.readFileSync(new URL('../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const windows = ['lro-2026-03-20', 'lro-2026-03-27'].map((name) => ({ name, truth: readTruth(`${name}.json`) }));
const DEGREES = [40, 60, 80, 100, 120, 150, 200, 260];
const forces = (degree) => ({ gm: 4902.7998069317, degree, order: degree, thirdBodies: [10, 399], massKg: 1100, areaM2: 12, srp: { cr: 1.3 } });
const rows = [];
for (const degree of DEGREES) {
  const row = { degree, windows: {} };
  for (const { name, truth } of windows) {
    const ctx = { truth, center: MOON, forces: forces(degree), kernel: KERNEL, lane: 'browser' };
    const solution = await fit(ctx, fitIndices(truth));
    const days = await byDay(ctx, solution, 3);
    row.windows[name] = { fitRms: solution.fitRms, day2: days[1].rms, day3: days[2].rms };
  }
  row.day2 = Math.sqrt(Object.values(row.windows).reduce((a, w) => a + w.day2 * w.day2, 0));
  rows.push(row);
  console.log(`degree ${String(degree).padStart(3)}: combined day-2 rms ${row.day2.toFixed(2)} m; ` + Object.entries(row.windows).map(([n, w]) => `${n.slice(4)} fit ${w.fitRms.toFixed(1)} day-2 ${w.day2.toFixed(1)} day-3 ${w.day3.toFixed(1)}`).join('; '));
}
// The lowest degree D with |e(D') - e(D)| < 1% of e(D) for every swept D' above it.
const chosen = rows.find((r, i) => rows.slice(i + 1).every((q) => Math.abs(q.day2 - r.day2) / r.day2 < 0.01));
console.log(chosen ? `lowest degree past which the day-2 error changes by under 1%: ${chosen.degree}` : 'no swept degree meets the 1% criterion');
if (process.argv[2]) fs.writeFileSync(process.argv[2], `${JSON.stringify({ rows, chosen: chosen?.degree ?? null }, null, 2)}\n`);
await destroyLanes();
process.exit(0);
