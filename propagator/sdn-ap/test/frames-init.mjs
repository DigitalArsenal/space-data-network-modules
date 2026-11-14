#!/usr/bin/env node
// SPEC 19.5: what a cold set costs by eccentricity and by tesseral degree (a refill row's first cost). The first state of a freshly loaded AP set at its epoch
// is its initialization alone; the median over 8 sets, milliseconds, CPU time. Seeded sets at a perigee height of 800 km unless the line says another.
//   node test/frames-init.mjs
import { seedOcm, rowsThrough } from "./lib/ocm.mjs";
import { spwRows } from "./lib/fixture-inputs.mjs";
import { openFrames, EPOCH, EPOCH_MS, revPerDay } from "./lib/frame-cells.mjs";

const rows = rowsThrough(spwRows({ first: "2026-10-10", days: 60 }).values);
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const f = await openFrames();
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const cases = [];
for (const e of [0.01, 0.02, 0.028, 0.03, 0.04, 0.05]) cases.push({ e, tess: 31, zon: 20, hp: 800 });
for (const [tess, zon] of [[0, 20], [8, 20], [31, 20], [70, 70]]) cases.push({ e: 0.03, tess, zon, hp: 800 });
for (const hp of [400, 1400, 5000]) cases.push({ e: 0.03, tess: 31, zon: 20, hp });
for (const c of cases) {
  const ts = [];
  for (let k = 0; k < 8; k++) {
    const a = (6378.137 + c.hp) / (1 - c.e);
    const ocm = seedOcm({ epoch: EPOCH, n: revPerDay(a), e: c.e, i: 55, raan: 10 + 37 * k, argp: 20 + 51 * k, ma: 5 + 29 * k, bterm: 0.01, agom: 0.01, norad: 400000, msis: true, records: true, tesseral: c.tess, zonal: c.zon, rows });
    await f.load(null, [ocm]);
    const c0 = cpu(); f.ap(0, EPOCH_MS + 1000); ts.push(cpu() - c0);
  }
  console.log(JSON.stringify(c), "first state ms", med(ts).toFixed(2));
}
