#!/usr/bin/env node
// SPEC 19.5: where and how large AP's own output steps. A dense scan (every 0.25 s) of AP's states of seeded sets at perigee heights 200 to 700 km, from one
// hour after the epoch plus DAYS days; a step is a jump of the position, found as a spike of the 5th difference of the positions (a jump s gives 6 s there).
// Prints, by perigee height: steps an hour, their size (p50, p90, max, mm) and the gap between consecutive steps (p10, p50, p90, s).
//   node test/frames-steps.mjs [--days 2] [--hours 3]
import { KINDS, population, openFrames, EPOCH_MS, DAY } from "./lib/frame-cells.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const HPS = [200, 250, 300, 350, 400, 450, 500, 600, 700];
for (const hp of HPS) KINDS[`hp${hp}`] = { hp, e: 0.0005, serves: true, drag: true };
const DAYS = arg("--days", 2), HOURS = arg("--hours", 3), DT = 0.25;
for (const hp of HPS) {
  const pop = population([[`hp${hp}`, 4]], 17, 1440);
  const f = await openFrames();
  await f.load(pop);
  const sizes = [], gaps = [];
  let hours = 0;
  for (let i = 0; i < f.count; i++) {
    const t0 = EPOCH_MS + DAYS * DAY + 3600e3;
    const n = Math.round((HOURS * 3600) / DT);
    const P = [[], [], []];
    let ok = true;
    for (let k = 0; k < n && ok; k++) { const a = f.ap(i, t0 + k * DT * 1000); if (!a) { ok = false; break; } for (let c = 0; c < 3; c++) P[c].push(a[c] * 1000); }
    if (!ok) continue;
    hours += HOURS;
    const d5 = (x) => { let y = x; for (let q = 0; q < 5; q++) { const z = new Float64Array(y.length - 1); for (let k = 0; k < z.length; k++) z[k] = y[k + 1] - y[k]; y = z; } return y; };
    const D = P.map(d5), m = D[0].length, mag = new Float64Array(m);
    for (let k = 0; k < m; k++) mag[k] = Math.hypot(D[0][k], D[1][k], D[2][k]) / 6;
    let last = -1e9;
    for (let k = 1; k < m - 1; k++) if (mag[k] > 1e-3 && mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1]) {
      const tk = k * DT;
      if (tk - last < 2) { if (mag[k] > sizes[sizes.length - 1]) sizes[sizes.length - 1] = mag[k]; continue; }
      if (last > -1e8) gaps.push(tk - last);
      sizes.push(mag[k]); last = tk;
    }
  }
  const q = (a, p, scale = 1) => { const s = [...a].sort((x, y) => x - y); return s.length ? +(s[Math.min(s.length - 1, Math.floor(p * s.length))] * scale).toFixed(2) : null; };
  console.log(hp, JSON.stringify({ hoursScanned: hours, stepsPerHour: +(sizes.length / Math.max(hours, 1)).toFixed(1), sizeMm: { p50: q(sizes, 0.5, 1000), p90: q(sizes, 0.9, 1000), max: q(sizes, 1, 1000) }, gapS: { p10: q(gaps, 0.1), p50: q(gaps, 0.5), p90: q(gaps, 0.9) } }));
}
