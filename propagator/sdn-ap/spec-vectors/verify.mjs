#!/usr/bin/env node
// The task's end-to-end check: recomputes every spec vector through the oracle (the unmodified library; SDN_AP_ORACLE_ROOT) and compares
// with vectors.json, then checks the claims SPEC.md marks "confirmed by black-box probing" against those numbers.
// Usage (from the modules repository root): SDN_AP_ORACLE_ROOT=<closed-modules>/packages/sgp4-xp-oracle node propagator/sdn-ap/spec-vectors/verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stored = JSON.parse(fs.readFileSync(path.join(here, 'vectors.json'), 'utf8'));
const fresh = await build();
const failures = [];
const fail = (msg) => failures.push(msg);

// 1. The library reproduces every stored number.
let compared = 0;
function same(a, b, where) {
  if (typeof a === 'number' && typeof b === 'number') {
    compared += 1;
    if (!(Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a)))) fail(`${where}: stored ${a} vs oracle ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) fail(`${where}: length ${a.length} vs ${b.length}`);
    a.forEach((x, i) => same(x, b[i], `${where}[${i}]`));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of Object.keys(a)) same(a[k], b[k], `${where}.${k}`);
  } else if (a !== b) fail(`${where}: stored ${String(a)} vs oracle ${String(b)}`);
}
same(stored.sections, fresh.sections, 'sections');

// 2. The claims of SPEC.md.
const V = fresh.sections;
const RE = 6378.1363, KE = 0.074366859954178854, D = Math.PI / 180;
const field = (l2, a, b) => Number(l2.slice(a, b));
const near = (a, b, tol, where) => { if (!(Math.abs(a - b) <= tol)) fail(`${where}: ${a} vs ${b} (tol ${tol})`); };
const dist = (p, q) => Math.hypot(...p.map((x, i) => x - q[i]));

for (const s of V['1']) { // 1.4, 1.5
  const l2 = s.lines[1];
  const inc = field(l2, 8, 16), raan = field(l2, 17, 25), ecc = Number(`0.${l2.slice(26, 33)}`), argp = field(l2, 34, 42), ma = field(l2, 43, 51), mm = field(l2, 52, 63);
  const n = mm * 2 * Math.PI / 1440;
  near(s.meanKepT0[0], RE * (KE / n) ** (2 / 3), 1e-8, `1.4 ${s.name} mean a = R_E (k_e/n)^(2/3)`);
  [ecc, inc, ma, raan, argp].forEach((x, i) => near(s.meanKepT0[i + 1], x, 1e-9, `1.4 ${s.name} mean element ${i + 1} at t=0`));
  const lp = (argp + raan) * D, t = Math.tan(inc * D / 2);
  const want = [ecc * Math.cos(lp), ecc * Math.sin(lp), t * Math.sin(raan * D), t * Math.cos(raan * D)];
  want.forEach((x, i) => near(s.nativeAtEpoch.eqnx[i], x, 1e-12, `1.5 ${s.name} native element ${i + 1}`));
  near(((s.nativeAtEpoch.eqnx[4] - (ma + argp + raan)) % 360 + 540) % 360 - 180, 0, 1e-9, `1.5 ${s.name} lambda`);
  near(s.nativeAtEpoch.eqnx[5], mm, 1e-12, `1.5 ${s.name} n`);
}
for (const s of V['3']) { // 3: drag raises n, and depends on the date
  const dn = (p) => (p.native[1].eqnx[5] - p.native[0].eqnx[5]) / (120 / 1440);
  s.ndot = dn(s.withDrag) - dn(s.noDrag);
  if (!(s.ndot > 0)) fail(`3 ${s.year} ${s.alt} km: drag n-dot ${s.ndot} not positive`);
}
for (const alt of new Set(V['3'].map((s) => s.alt))) {
  const [a, b] = [2009, 2024].map((y) => V['3'].find((s) => s.alt === alt && s.year === y).ndot);
  if (!(b > a)) fail(`3 ${alt} km: 2024 n-dot ${b} not above 2009 ${a} (flux model by date)`);
}
for (const s of V['9']) { // 9.1 path independence
  near(dist(s.direct.slice(0, 3), s.stepped.slice(0, 3)), 0, 1e-9, `9.1 ${s.name} direct vs stepped (km)`);
  near(dist(s.direct.slice(0, 3), s.backward.slice(0, 3)), 0, 1e-9, `9.1 ${s.name} direct vs backward (km)`);
}
{ // 9.2 GEO nodes every 95 minutes: cubic Hermite on the node values and rates reproduces the interior far better
  const herm = (q, y0, y1, d0, d1, H) => (1 + 2 * q) * (1 - q) ** 2 * y0 + q * (1 - q) ** 2 * H * d0 + q * q * (3 - 2 * q) * y1 + q * q * (q - 1) * H * d1;
  const misfit = (v) => { const [a, b, m] = v.native; return Math.max(...[0, 1, 2, 3].map((k) => Math.abs(herm(0.37, a.eqnx[k], b.eqnx[k], a.rates[k], b.rates[k], v.H) - m.eqnx[k]) / Math.abs(b.eqnx[k] - a.eqnx[k]))); };
  const [m95, m96] = [95, 96].map((H) => misfit(V['9.2'].find((v) => v.H === H)));
  if (!(m95 < 1e-6 && m95 < 1e-3 * m96)) fail(`9.2 GEO Hermite misfit 95 min ${m95} vs 96 min ${m96}`);
}
for (const edge of new Set(V['6.2'].map((v) => v.edgeRadPerMin))) { // 6.2 the class changes exactly at each effective limit
  const [a, b, c, d] = V['6.2'].filter((v) => v.edgeRadPerMin === edge).map((v) => v.native[0].rates[5]);
  const within = Math.max(Math.abs(b - a), Math.abs(d - c)), across = Math.abs(c - b);
  const effective = edge !== 0.007875859; // the 16 h upper limit lies inside the 0.5-day band
  if (effective ? !(across > 100 * within) : !(across < 5 * within)) fail(`6.2 limit ${edge}: n-dot steps ${b - a}, ${c - b}, ${d - c}`);
}
{ // 4.2 SRP scales as (1 AU / r_sun)^2: perihelion over aphelion near (1.0167 / 0.9833)^2
  const mag = (v) => Math.hypot(v.withSrp.native[0].rates[0] - v.noSrp.native[0].rates[0], v.withSrp.native[0].rates[1] - v.noSrp.native[0].rates[1]);
  const [peri, aph] = [3.5, 185.5].map((d) => mag(V['4.2'].find((v) => v.day === d)));
  if (!(peri / aph > 1.06 && peri / aph < 1.08)) fail(`4.2 SRP perihelion/aphelion ${peri / aph}`);
}
{ // 3.2 co-rotating atmosphere: retrograde/prograde drag n-dot equals ((v + w r)/(v - w r))^2 within 1 %
  const nd = (v) => v.withDrag.native[0].rates[5] - v.noDrag.native[0].rates[5];
  const [pro, retro] = [0.1, 179.9].map((i) => nd(V['3.2'].find((v) => v.inc === i)));
  const r = 6378.1363 + 400, vc = Math.sqrt(398600.4415 / r), wr = 7.292115e-5 * r;
  const want = ((vc + wr) / (vc - wr)) ** 2;
  if (!(Math.abs(retro / pro / want - 1) < 0.01)) fail(`3.2 co-rotation ratio ${retro / pro} vs ${want}`);
}
{ // 3.5 drag n rate: positive, linear in B, falling with perigee height at fixed date, e and i
  let worstLin = 0;
  for (const v of V['3.5']) {
    const [b2, b1, b0] = v.rates.map((r) => r.native.rates[5]);
    const d2 = b2 - b0, d1 = b1 - b0;
    if (!(d1 > 0 && d2 > 0)) fail(`3.5 ${v.year} ${v.perigeeHeightKm} km e ${v.ecc}: drag n rate ${d1}`);
    worstLin = Math.max(worstLin, Math.abs(d2 / d1 - 2));
    v.ndotPerB = d1 / 0.01;
  }
  if (!(worstLin < 1e-6)) fail(`3.5 drag not linear in B: worst |ratio - 2| ${worstLin}`);
  const key = (v) => `${v.year}|${v.day}|${v.ecc}|${v.inc}`;
  const groups = {};
  for (const v of V['3.5']) (groups[key(v)] ??= []).push(v);
  for (const g of Object.values(groups)) {
    g.sort((x, y) => x.perigeeHeightKm - y.perigeeHeightKm);
    for (let k = 1; k < g.length; k++) if (!(g[k].ndotPerB < g[k - 1].ndotPerB)) fail(`3.5 n rate not falling with height at ${key(g[k])} ${g[k].perigeeHeightKm} km`);
  }
}
{ // 3.7 row probes: drag n rate positive and falling with the node height at every date
  const byDate = {};
  for (const v of V['3.7']) (byDate[`${v.year}|${v.day}`] ??= []).push(v);
  for (const g of Object.values(byDate)) {
    g.sort((x, y) => x.nodeHeightKm - y.nodeHeightKm);
    const nd = g.map((v) => v.rates[0].native.rates[5] - v.rates[1].native.rates[5]);
    nd.forEach((x, k) => { if (!(x > 0)) fail(`3.7 ${g[k].year} ${g[k].nodeHeightKm} km: drag n rate ${x}`); if (k && !(x < nd[k - 1])) fail(`3.7 ${g[k].year}: n rate not falling at ${g[k].nodeHeightKm} km`); });
  }
}
{ // 4.4 the SRP part of the n rate vanishes on a wholly sunlit orbit (GEO solstice) and not when a shadow is found (LEO)
  const nd = (v) => v.withSrp.native.rates[5] - v.noSrp.native.rates[5];
  const geoSol = V['4.4'].find((v) => v.el.mm < 1.01 && v.el.day === 172.5), leo = V['4.4'].find((v) => v.el.mm > 15);
  if (!(Math.abs(nd(geoSol)) <= 1e-15)) fail(`4.4 GEO solstice SRP n rate ${nd(geoSol)}`);
  if (!(Math.abs(nd(leo)) > 1e-12)) fail(`4.4 LEO SRP n rate ${nd(leo)} (shadow expected)`);
}
{ // 3.14 drag below 10 km (negative heights included) is finite and linear in B; above 2500 km it is nonzero
  for (const v of V['3.14']) {
    const [r0, r1, r2] = v.rates.map((r) => r.native);
    if (r1.error || r2.error) fail(`3.14 mm ${v.el.mm} e ${v.el.ecc}: refused at epoch`);
    const d1 = r1.rates[5] - r0.rates[5], d2 = r2.rates[5] - r0.rates[5];
    const slack = 1e-6 * Math.abs(d2) + 1e-13 * Math.max(Math.abs(r0.rates[5]), Math.abs(r2.rates[5])); // rounding of the total n rate
    if (!(Number.isFinite(d1) && d1 > 0 && Math.abs(d2 - 2 * d1) <= slack)) fail(`3.14 mm ${v.el.mm} e ${v.el.ecc}: drag n rate ${d1}, ${d2}`);
  }
}
for (const v of V['6.10']) { // 6.10 the mean motion crosses a class limit within the span
  const limit = v.el.mm < 3 ? 2.4066852459 : 3.6100278459, n = v.nodes.map((x) => x.eqnx[5]);
  if (!(n[0] < limit && n.at(-1) > limit)) fail(`6.10 ${v.el.mm}: n ${n[0]} to ${n.at(-1)} does not cross ${limit}`);
  v.states.forEach((st, i) => { if (st.error) fail(`6.10 ${v.el.mm} t=${v.stateMinutes[i]}: error ${st.error}`); });
}
for (const v of V['8.5']) { // 8.5 refused after the epoch at the first step, or served with the first node at 90 min
  const want = { 1786: 9, 3850: 4, 7042: 9 }[v.set] ?? 0;
  v.codes.forEach((c, i) => { const w = v.T[i] === 0 ? 0 : want; if (c !== w) fail(`8.5 set ${v.set} t=${v.T[i]}: code ${c}, expected ${w}`); });
}
let worstOn = 0;
for (const s of V['11']) { // 11.1 versions differ only through the non-gravitational path
  const worst = Math.max(...s.wasm.map((r, i) => dist(r, s.native[i])));
  if (s.nonGravOff) near(worst, 0, 1e-7, `11.1 ${s.name} AGOM = B = 0: 9.1.1.0 vs 9.9 (km)`);
  else worstOn = Math.max(worstOn, worst);
}
if (!(worstOn > 1e-3)) fail(`11.1 expected a 9.1.1.0 vs 9.9 difference above 1 m with SRP on; worst ${worstOn * 1000} m`);
for (const k of ['7', '10']) for (const s of V[k]) s.states.forEach((st, i) => { if (st.error) fail(`${k} ${s.name ?? s.mm} t=${s.minutes[i]}: error ${st.error}`); });

if (failures.length) {
  console.error(`spec-vectors: FAIL (${failures.length})`);
  for (const f of failures.slice(0, 40)) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`spec-vectors: PASS (${compared} numbers reproduced; sections ${Object.keys(V).join(', ')}; worst 9.1.1.0 vs 9.9 with SRP on ${(worstOn * 1000).toFixed(2)} m)`);
