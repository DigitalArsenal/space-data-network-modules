#!/usr/bin/env node
// SPEC 19.5: where and how large AP's own output steps, in position and in velocity. A dense scan (every 0.25 s) of AP's states of seeded sets, from one hour after
// the epoch plus DAYS days. A step is a jump found as a spike of the 5th difference of the series (a jump s gives 6 s there). Prints, for each configuration (perigee
// height, ballistic term BTERM in m^2/kg, eccentricity): steps an hour, their size (p50, p90, max) in position (mm) and in velocity (1e-5 m/s), and the gap between
// consecutive position steps (p10, p50, p90, s).
//   node test/frames-steps.mjs [--days 2] [--hours 2] [--objects 2] [--table heights|terms|eccentric|all]
import { KINDS, population, openFrames, EPOCH_MS, DAY } from "./lib/frame-cells.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DAYS = Number(arg("--days", 2)), HOURS = Number(arg("--hours", 2)), OBJECTS = Number(arg("--objects", 2)), TABLE = arg("--table", "all"), DT = 0.25;
const configs = [];
if (TABLE === "heights" || TABLE === "all") for (const hp of [200, 250, 300, 350, 400, 450, 500, 520, 560, 600, 650, 700]) configs.push({ hp, bterm: 0.01, e: 0.0005 });
if (TABLE === "terms" || TABLE === "all") for (const hp of [450, 500, 520, 560, 600, 650]) for (const bterm of [0.001, 0.1, 1]) configs.push({ hp, bterm, e: 0.0005 });
if (TABLE === "eccentric" || TABLE === "all") for (const hp of [500, 600, 700, 800]) configs.push({ hp, bterm: 0.01, e: 0.03 });
const d5 = (x) => { let y = x; for (let q = 0; q < 5; q++) { const z = new Float64Array(y.length - 1); for (let k = 0; k < z.length; k++) z[k] = y[k + 1] - y[k]; y = z; } return y; };
const q = (a, p, scale = 1) => { const s = [...a].sort((x, y) => x - y); return s.length ? +(s[Math.min(s.length - 1, Math.floor(p * s.length))] * scale).toFixed(2) : null; };
// spikes of a magnitude series above `thr`, at least 2 s apart: [{ t, size }]
const spikes = (mag, thr) => {
  const out = []; let last = -1e9;
  for (let k = 1; k < mag.length - 1; k++) if (mag[k] > thr && mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1]) {
    const t = k * DT;
    if (t - last < 2) { if (mag[k] > out[out.length - 1].size) out[out.length - 1].size = mag[k]; continue; }
    out.push({ t, size: mag[k] }); last = t;
  }
  return out;
};
for (const c of configs) {
  const name = `h${c.hp}b${c.bterm}e${c.e}`;
  KINDS[name] = { hp: c.hp, e: c.e, serves: true, fixedE: true, incs: [55], bterm: c.bterm };
  const pop = population([[name, OBJECTS]], 17, 1440).map((o) => ({ ...o, bterm: c.bterm }));
  const f = await openFrames();
  await f.load(pop);
  const ps = [], vs = [], gaps = [];
  let hours = 0;
  for (let i = 0; i < f.count; i++) {
    const t0 = EPOCH_MS + DAYS * DAY + 3600e3, n = Math.round((HOURS * 3600) / DT);
    const P = [[], [], []], V = [[], [], []];
    let ok = true;
    for (let k = 0; k < n && ok; k++) { const a = f.ap(i, t0 + k * DT * 1000); if (!a) { ok = false; break; } for (let m = 0; m < 3; m++) { P[m].push(a[m] * 1000); V[m].push(a[3 + m] * 1000); } }
    if (!ok) continue;
    hours += HOURS;
    const mag = (S) => { const D = S.map(d5), out = new Float64Array(D[0].length); for (let k = 0; k < out.length; k++) out[k] = Math.hypot(D[0][k], D[1][k], D[2][k]) / 6; return out; };
    const sp = spikes(mag(P), 1e-3), sv = spikes(mag(V), 1e-6);
    ps.push(...sp.map((x) => x.size)); vs.push(...sv.map((x) => x.size));
    for (let k = 1; k < sp.length; k++) gaps.push(sp[k].t - sp[k - 1].t);
  }
  console.log(JSON.stringify({ hp: c.hp, bterm: c.bterm, e: c.e }), JSON.stringify({ hours, positionStepsPerHour: +(ps.length / Math.max(hours, 1)).toFixed(1), positionMm: { p50: q(ps, 0.5, 1000), p90: q(ps, 0.9, 1000), max: q(ps, 1, 1000) }, velocityE5ms: { stepsPerHour: +(vs.length / Math.max(hours, 1)).toFixed(1), p50: q(vs, 0.5, 1e5), p90: q(vs, 0.9, 1e5), max: q(vs, 1, 1e5) }, gapS: { p10: q(gaps, 0.1), p50: q(gaps, 0.5), p90: q(gaps, 0.9) } }));
}
