// modules-sdn-ap-drag-high-eccentricity-20261103, step 1: the drag work of one perigee pass along FFM's true path
// against AP's averaged drag. node drag-pass-work.mjs <Fixture> <nobodies module wasm> <out.json>
// FFM (drag on and off, Sun and Moon off) and AP (the same, BTERM seeded at 0.044) on a 9 s grid for 1 day from AP's
// epoch state. Per pass (apogee to apogee):
//   dE FFM, dE AP   (E_on - E_off) differenced across the pass, point-mass specific energy, km^2/s^2
//   W path          integral of a_drag . v dt along FFM's path, a_drag = -(1/2) rho B |v_rel| v_rel, rho from AP's own
//                   NRLMSISE-00 (sdnap_atmosphere_probe, the nodes' density) at FFM's TEME position
//   tail            the share of W path above the radius r_p + Delta where AP's arc ends (SPEC 3.4)
// The arithmetic is measurement (a line integral of module densities), not a model.
import fs from 'node:fs';
import * as fb from 'flatbuffers';
import {SPW, SPWT} from 'spacedatastandards.org/lib/js/SPW/SPW.js';
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {openModule} from './lib/module.mjs';
import {rotate, jdOf, FRAME_PROBE} from './lib/frames.mjs';
const [fixture, nobodies, out] = process.argv.slice(2);
const FIXTURES = {
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10},
  GTO: {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10},
  'GTO-500': {n: 2.40, e: 0.7081, i: 27, raan: 40, argp: 270, ma: 10},
};
const f = FIXTURES[fixture];
const MU = 398600.4418, OMEGA_E = 7.2921158553e-5, RE = 6378.1363, FLAT = 3.3528197529902951e-3, B = 0.044;
const common = {...f, mode: 'seed', seedGridMin: 0.15, seedDays: 1, thirdBody: false, modulePath: nobodies};
const on = await runModelTruth({name: fixture + '-on', ...common, drag: true});
const off = await runModelTruth({name: fixture + '-off', ...common, drag: false});
const N = on.referenceStates.length;
const dtSec = 9;
const ffmOn = on.referenceStates.map((s) => [...s.position, ...s.velocity]);
const ffmOff = off.referenceStates.map((s) => [...s.position, ...s.velocity]);
const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const energy = (s) => 0.5 * (s[3] ** 2 + s[4] ** 2 + s[5] ** 2) - MU / norm(s);
// the density and the drag power along FFM's true path
const m = await openModule(), x = m.x;
const rows = JSON.parse(fs.readFileSync(process.env.FFM_SPW_FIXTURE ?? '/Users/tj/software/terrain-work/ffm-spw-fixture/spw-constant-20261029.json'));
const weather = Buffer.concat((Array.isArray(rows) ? rows : rows.rows).map((row) => { const b = new fb.Builder(256); SPW.finishSizePrefixedSPWBuffer(b, Object.assign(new SPWT(), row).pack(b)); return b.asUint8Array(); }));
const rp = x.sdnap_alloc(24), rowsPtr = x.sdnap_alloc(weather.length), po = x.sdnap_alloc(56);
new Uint8Array(m.harness.memory.buffer, rowsPtr, weather.length).set(weather);
const jd = jdOf('2026-10-29T00:00:00.000');
const along = (states) => {
  const rho = new Float64Array(N), power = new Float64Array(N), height = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const t = (k + 1) * dtSec;
    const teme = rotate(m, jd.whole, jd.frac + t / 86400, states[k], FRAME_PROBE.GCRF_TO_TEME).out;
    new Float64Array(m.harness.memory.buffer, rp, 3).set(teme.slice(0, 3));
    if (x.sdnap_atmosphere_probe(2, jd.whole, jd.frac + t / 86400, rp, rowsPtr, weather.length, 0, 0, po) !== 0) throw new Error('probe refused');
    const o = new Float64Array(m.harness.memory.buffer, po, 7);
    rho[k] = o[0]; height[k] = o[3];
    const vrel = [teme[3] + OMEGA_E * teme[1], teme[4] - OMEGA_E * teme[0], teme[5]];
    const speed = norm(vrel);
    const k1 = 0.5 * rho[k] * B * 1000 * speed;  // 1/s: (1/2) rho B (kg/m^3 m^2/kg = 1/m = 1000/km)
    power[k] = -k1 * (vrel[0] * teme[3] + vrel[1] * teme[4] + vrel[2] * teme[5]);
  }
  return {rho, power, height};
};
const {rho, power, height} = along(ffmOn);
const apPath = along(on.flown);
// AP's arc (SPEC 3.4) from the seeded mean elements
const ke = 0.074366859954178854, n0 = f.n * 2 * Math.PI / 1440;
const a = (ke / n0) ** (2 / 3) * RE, rad = Math.PI / 180;
const rpKm = a * (1 - f.e);
const hp = rpKm - RE * (1 - FLAT * Math.sin(f.i * rad) ** 2 * Math.sin(f.argp * rad) ** 2);
const bb = Math.min(900, Math.max(90, hp));
const c = [-3.130124, 0.061710434, -3.4111266e-4, 8.7321429e-7, -1.122534e-9, 7.1123451e-13, -1.776575e-16];
let band = 0; for (let k = c.length - 1; k >= 0; k--) band = band * bb + c[k]; band *= bb;
const rArcEnd = rpKm + band;
const radius = ffmOn.map(norm);
const apRadius = on.flown.map(norm);
const simpson = (arr, lo, hi) => { let w = 0; for (let k = lo; k + 2 <= hi; k += 2) w += (arr[k] + 4 * arr[k + 1] + arr[k + 2]) * dtSec / 3; if ((hi - lo) % 2) w += 0.5 * (arr[hi - 1] + arr[hi]) * dtSec; return w; };
const apo = [];
for (let k = 1; k < N - 1; k++) {
  let top = true;
  for (let j = Math.max(0, k - 1800); j <= Math.min(N - 1, k + 1800); j++) if (radius[j] > radius[k]) { top = false; break; }
  if (top) apo.push(k);
}
const rowsOut = [];
for (let i = 0; i + 1 < apo.length; i++) {
  const lo = apo[i], hi = apo[i + 1];
  let W = 0, tail = 0, W2 = 0, tail2 = 0, minR = Infinity;
  const bins = {};
  for (let k = lo; k < hi; k++) {
    const seg = 0.5 * (power[k] + power[k + 1]) * dtSec;
    W += seg; if (radius[k] > rArcEnd) tail += seg;
    if (k + 2 <= hi) { const s2 = 0.5 * (power[k] + power[k + 2]) * 2 * dtSec, s1 = 0.5 * (power[k] + power[k + 1]) * dtSec + 0.5 * (power[k + 1] + power[k + 2]) * dtSec; if (k % 2 === lo % 2) { W2 += (4 * s1 - s2) / 3; if (radius[k + 1] > rArcEnd) tail2 += (4 * s1 - s2) / 3; } }
    minR = Math.min(minR, radius[k]);
    const hb = Math.floor((height[k] - 0) / 50) * 50;
    if (hb < 1000) bins[hb] = (bins[hb] ?? 0) + seg;
  }
  const dEf = energy(ffmOn[hi]) - energy(ffmOff[hi]) - (energy(ffmOn[lo]) - energy(ffmOff[lo]));
  
  if ((hi - lo) % 2 === 1) { /* odd interval count: the last trapezoid joins the Simpson sum */ const k = hi - 1; const seg = 0.5 * (power[k] + power[k + 1]) * dtSec; W2 += seg; if (radius[k] > rArcEnd) tail2 += seg; }
  const apMin = Math.min(...apRadius.slice(lo, hi)), apWork = simpson(apPath.power, lo, hi);
  rowsOut.push({pass: i + 1, apPerigeeMinusFfmM: (apMin - minR) * 1000, W_ap_path: apWork, apPathMaxRhoOverFfm: Math.max(...apPath.rho.slice(lo, hi)) / Math.max(...rho.slice(lo, hi)), perigeeKm: minR - RE, dE_ffm: dEf, W_path: W2, W_trapezoid: W, tailShare: tail2 / W2, byHeight50km: Object.fromEntries(Object.entries(bins).map(([h, v]) => [h, v / W])), lo, hi});
}
const flownOn = on.flown, flownOff = off.flown;
const result = {fixture, perigeeKm: on.perigeeKm, hpKm: hp, bandKm: band, arcEndAboveRpKm: band, arcEndRadiusKm: rArcEnd,
  note: 'dE_ffm, W_path in km^2/s^2 per pass; tailShare the fraction of W_path above the AP arc end', rows: rowsOut,
  rhoPerigeeKgM3: Math.max(...rho)};
// AP's energy change over the same apogee windows from the module's own flown states
for (const r of rowsOut) {
  r.dE_ap = (energy(on.flown[r.hi]) - energy(off.flown[r.hi])) - (energy(on.flown[r.lo]) - energy(off.flown[r.lo]));
  r.ap_over_ffm = r.dE_ap / r.dE_ffm;
  r.W_over_dE = r.W_path / r.dE_ffm;
  r.Wap_over_W = r.W_ap_path / r.W_path;
}
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify({fixture, perigeeKm: result.perigeeKm, hpKm: hp, DeltaKm: band, arcEndRadiusAboveSurfaceKm: rArcEnd - RE}));
for (const r of rowsOut) console.log(JSON.stringify({pass: r.pass, perigeeKm: +r.perigeeKm.toFixed(1), dE_ffm: r.dE_ffm, W_path: r.W_path, 'W/dE': +r.W_over_dE.toFixed(4), dE_ap: r.dE_ap, 'AP/FFM': +r.ap_over_ffm.toFixed(4), 'W_apPath/W_ffmPath': +r.Wap_over_W.toFixed(4), apPerigeeMinusFfmM: +r.apPerigeeMinusFfmM.toFixed(0), rhoMaxApPath_over_ffmPath: +r.apPathMaxRhoOverFfm.toFixed(4), tailShare: +r.tailShare.toFixed(4)}));
x.sdnap_free(rp); x.sdnap_free(rowsPtr); x.sdnap_free(po);
