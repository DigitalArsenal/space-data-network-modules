// The requests of the parity check (tests/parity.mjs) and of the comparison with analysis/density-calibration 0.4.0's JSON
// artifact: every method of the module on the inputs of tests/density_calibration.test.mjs, decay.test.mjs, energy.test.mjs and
// nrlmsise.test.mjs, plus the requests those tests expect to be refused. Each case is { id, method, request } with the request
// in the tests' own units (dcl.mjs encodeRequest turns it into the $DCL).
//
// Where a test takes its inputs from something parity cannot carry, the same request is built from synthetic values:
// - SET's JB2008 validation package (evaluate raw, calibrate): no redistribution licence, so the points have its shape
//   and the observed densities are the module's own JB2008 at the printed drivers, which calibrate then starts 37 K
//   cooler, as the test does with SET's densities;
// - propagator/hpop's integrated tracks (energy, drag_work): the module only reads the states, so they are the two-body
//   arc of the tests' own starting state;
// - calibrate_decay's eight days of seven objects: the same generator on three objects over three days. The histories
//   come from the module's own `decay`, as in the test.
import fs from 'node:fs';
import { call as local, dayOfMjd } from './dcl.mjs';

// Constant synthetic JB2008 drivers on the whole days first..last (MJD): F10, F10B, S10, S10B, M10, M10B, Y10, Y10B and a flat DTC.
const JB_INDICES = ['F10', 'F10_CENTRED_81', 'S10', 'S10_CENTRED_81', 'M10', 'M10_CENTRED_81', 'Y10', 'Y10_CENTRED_81'];
function constantRows(first, last, dtc = 40, indices = [150, 145, 140, 138, 148, 146, 130, 128]) {
  const out = [];
  for (let d = first; d <= last; ++d) out.push({ DATE: dayOfMjd(d), ...Object.fromEntries(JB_INDICES.map((k, i) => [k, indices[i]])), DTC_HOURLY_K: Array(24).fill(dtc) });
  return out;
}
const decayRows = (fromMjd, toMjd, add = 0) => constantRows(Math.floor(fromMjd), Math.ceil(toMjd), 40 + add);       // decay.test.mjs
const energyRows = (fromMjd, toMjd) => constantRows(Math.floor(fromMjd) - 6, Math.ceil(toMjd) + 1, 40);           // energy.test.mjs
// The PRW SPW rows of nrlmsise.test.mjs as the module reads them: F10.7, its 81-day mean and Ap move from day to day.
const spwRows = (fromDay, toDay) => Array.from({ length: toDay - fromDay + 1 }, (_, k) => ({ DATE: dayOfMjd(fromDay + k), F107_OBS: 110 + 9 * k, F107_OBS_CENTER81: 125 + 3 * k, AP_AVG: 6 + 11 * k }));

// ---- evaluate, JB2008 (density_calibration.test.mjs) ----
// 'a global correction equals raising every DTC value': eight days of drivers, fifty points, a segment correction and a point before the drivers.
const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
const segmentRows = (add) => days.map((DATE, k) => ({ DATE, F10: 140 + k, F10_CENTRED_81: 150, S10: 130, S10_CENTRED_81: 135, M10: 145, M10_CENTRED_81: 148,
  Y10: 120, Y10_CENTRED_81: 125, DTC_HOURLY_K: Array.from({ length: 24 }, (_, h) => 20 + 3 * h + add) }));
const n = 50;
const points = { mjd: Array.from({ length: n }, (_, i) => 61047 + i * 0.013), latDeg: Array.from({ length: n }, (_, i) => -80 + 3.2 * i),
  lonDeg: Array.from({ length: n }, (_, i) => -170 + 7 * i), altKm: Array.from({ length: n }, (_, i) => 300 + 8 * i) };
const segmentCorrection = { degree: 1, segments: [{ fromMjd: 61040, toMjd: 61050, coefficients: [40, 0, 0, 0] }] };
// 'the Sun's Earth-fixed direction matches JPL Horizons': four instants over three years, diagnostics on.
const horizons = ['2023-04-01T00:00:00Z', '2025-01-25T06:00:00Z', '2026-01-19T15:00:00Z', '2026-06-08T21:36:00Z'];
const horizonsMjd = horizons.map((t) => Date.parse(t) / 86400000 + 40587);
const horizonsRows = constantRows(Math.floor(Math.min(...horizonsMjd)) - 6, Math.ceil(Math.max(...horizonsMjd)) + 2, 30, Array(8).fill(150));
// 'JB2008 reproduces SET's Fortran validation output': SET's driver passes JB2008 the point's right ascension THETA(D1950) + LON with
// the printed drivers (F10, F10B, S10, S10B, M10, M10B, Y10, Y10B, DSTDTC) and the Sun's RA and Dec. The same arguments for 2023 day 91,
// 00 UT, on a grid of altitude, longitude and latitude, with drivers of the size SET printed.
function setTheta(t1950) {
  const ts70 = t1950 - 7305, ids70 = Math.trunc(ts70), tfrac = ts70 - ids70, twoPi = 6.28318530717958648;
  const v = (1.73213438565 + 1.720279169407e-2 * ids70 + (1.720279169407e-2 + twoPi) * tfrac + 5.0755141943e-15 * ts70 ** 2) % twoPi;
  return v < 0 ? v + twoPi : v;
}
const setFile = { mjd: 60035, d1950: 60035 - 33281, sunRa: 0.1742, sunDec: 0.0766, inputs: [129, 133, 125, 128, 132, 135, 124, 127, 85] };
const setGrid = [];
for (const z of [250, 400, 600]) for (let lon = -160; lon <= 160; lon += 40) for (const lat of [-70, -35, 0, 35, 70]) setGrid.push({ z, lon, lat });
const rawPoints = (inputs) => setGrid.map((g) => ({ mjd: setFile.mjd, sunRaRad: setFile.sunRa, sunDecRad: setFile.sunDec,
  lonRad: (setTheta(setFile.d1950) + g.lon * Math.PI / 180 + 2 * Math.PI) % (2 * Math.PI), latRad: g.lat * Math.PI / 180, altKm: g.z, inputs }));
// decay.test.mjs 'a node correction in evaluate applies dT(t, h) linear in time and altitude'.
const t0 = 61046.0;  // 2026-01-05 00:00 UTC
const nodePoints = { mjd: [t0 + 0.25, t0 + 0.5, t0 + 0.75, t0 + 0.5, t0 + 0.5, t0 + 0.5], latDeg: [10, 10, 10, 10, 10, 10], lonDeg: [20, 20, 20, 20, 20, 20],
  altKm: [600, 600, 600, 300, 1000, 200] };
const nodeCorrection = { nodesMjd: [t0, t0 + 1], altitudeKm: [400, 800], values: [[10, 50], [30, 90]] };

// ---- calibrate: the test's request (SET's densities against drivers 37 K cooler) on the module's own densities ----
const nominal = rawPoints(setFile.inputs);
const pointDensities = (await local('evaluate', { points, jb2008: { rows: segmentRows(40) } })).POINTS.DENSITY_KG_M3;
const observed = (await local('evaluate', { raw: nominal })).POINTS.DENSITY_KG_M3;
const calibrateRaw = { raw: rawPoints([...setFile.inputs.slice(0, 8), setFile.inputs[8] - 37]).map((p, i) => ({ ...p, rho: observed[i] })),
  degree: 2, binHours: 3, fromMjd: setFile.mjd - 0.01, toMjd: setFile.mjd + 0.1, logSigma: 0.01, priorSigmaK: [500, 500, 500], minPoints: 10, iterations: 20, editSigma: 0 };

// ---- decay (decay.test.mjs) ----
// Vallado's SGP4 verification sets (the near-Earth ones, as the test takes them), their t = 0 states sampled. The test passes all three in one
// call, whose drivers then span 2000 to 2006, and the module builds the Sun's direction for every hour of the span (seconds in V8, minutes in
// WasmEdge's interpreter); each cluster of epochs is a call of its own here, with the test's rows around it.
const vallado = JSON.parse(fs.readFileSync(new URL('../../epoch-state/tests/vallado-verification.json', import.meta.url), 'utf8')).cases
  .filter((c) => c.MEAN_MOTION > 1440 / 225).map((c) => ({ ...c, mjd: c.epochUnix / 86400 + 40587 })).sort((a, b) => a.mjd - b.mjd);
const valladoClusters = [];
for (const c of vallado) {
  const last = valladoClusters.at(-1);
  if (last && c.mjd - last.at(-1).mjd < 30) last.push(c); else valladoClusters.push([c]);
}
const valladoCall = (cluster) => ({ jb2008: { rows: decayRows(cluster[0].mjd - 7, cluster.at(-1).mjd + 2) }, samples: true, stepSeconds: 60,
  objects: cluster.map((c) => ({ id: String(c.satnum), spanDays: 0.01, sets: [{ mjd: c.mjd, MEAN_MOTION: c.MEAN_MOTION, ECCENTRICITY: c.ECCENTRICITY,
    INCLINATION: c.INCLINATION, RA_OF_ASC_NODE: c.RA_OF_ASC_NODE, ARG_OF_PERICENTER: c.ARG_OF_PERICENTER, MEAN_ANOMALY: c.MEAN_ANOMALY, BSTAR: c.BSTAR }] })) });
const meanMotion = (aKm) => 86400 / (2 * Math.PI * Math.sqrt(aKm ** 3 / 398600.8));
const set = (mjd, aKm, e, inc, extra = {}) => ({ mjd, MEAN_MOTION: meanMotion(aKm), ECCENTRICITY: e, INCLINATION: inc, RA_OF_ASC_NODE: 40,
  ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 0, BSTAR: 1e-5, ...extra });
// 'the drag decay of an element set matches HPOP's': one day, the module's side of the comparison.
const span = 1;
const circular = { name: 'circular 400 km, 51.6 deg', B: 0.02, s: set(t0, 6778.137 + 2, 0.0004, 51.6) };
const eccentric = { name: 'eccentric, perigee ~320 km, e 0.05', B: 0.05, s: set(t0, 7050, 0.05, 82.9) };
const decayOf = ({ name, B, s }, add) => ({ jb2008: { rows: decayRows(t0 - 8, t0 + span + 2) }, stepSeconds: 30, objects: [{ id: name, B, spanDays: span, sets: [s] }],
  ...(add ? { correction: { nodesMjd: [t0 - 1, t0 + span + 1], altitudeKm: [], values: [[add], [add]] } } : {}) });

// calibrate_decay: synthetic histories (element sets every 8 h whose Brouwer semi-major axes follow the forward model under a known correction and known B,
// plus noise), the test's generator and its anchored request on three objects over three days.
function brouwerToKozai(aKm, e, incDeg) {
  const ke = 60 / Math.sqrt(6378.135 ** 3 / 398600.8), k2 = 0.5 * 0.001082616, ci = Math.cos(incDeg * Math.PI / 180);
  const shape = (3 * ci * ci - 1) / (1 - e * e) ** 1.5;
  const aOf = (nRevDay) => {
    const n0 = nRevDay * 2 * Math.PI / 1440, a1 = (ke / n0) ** (2 / 3), d1 = 1.5 * k2 / a1 ** 2 * shape;
    const a0 = a1 * (1 - d1 / 3 - d1 * d1 - 134 / 81 * d1 ** 3), d0 = 1.5 * k2 / a0 ** 2 * shape;
    return a0 / (1 - d0) * 6378.135;
  };
  let lo = 5, hi = 17;
  for (let k = 0; k < 200; ++k) { const mid = (lo + hi) / 2; if (aOf(mid) > aKm) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0; z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0; return ((z ^ (z >>> 16)) >>> 0) / 4294967296; };
}
async function synthetic({ days, objects, correction, noiseM, seed, stepSeconds }) {
  const rnd = random(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const histories = objects.map((o) => ({ ...o, sets: Array.from({ length: Math.floor(days * 3) + 1 }, (_, k) => set(t0 + k / 3, o.aKm, o.e, o.inc, { MEAN_ANOMALY: (k * 97) % 360 })) }));
  const noise = histories.map((h) => h.sets.map((_, k) => noiseM * gauss() + (h.trendMPerDay ?? 0) * k / 3));
  // Two passes: the sets' mean motions follow the modelled decay of the trajectories they define.
  for (let pass = 0; pass < 2; ++pass) {
    const out = await local('decay', { jb2008: { rows: decayRows(t0 - 8, t0 + days + 2) }, stepSeconds, correction, objects: histories.map((h) => ({ id: h.id, B: h.B, sets: h.sets })) });
    out.OBJECTS.forEach((o, i) => {
      const h = histories[i];
      h.sets = h.sets.map((s, k) => ({ ...s, MEAN_MOTION: brouwerToKozai(h.aKm + (o.SET_CUMULATIVE_DECAY_M[k] + noise[i][k]) / 1000, s.ECCENTRICITY, s.INCLINATION) }));
    });
  }
  return histories;
}
const fitDays = 3, fitStep = 300;
// The true correction: 30 K, a one-day 90 K excursion from day 1, then 10 K.
const trueAt = (t) => { const d = t - t0; return d < 1 ? 30 : d < 2 ? 90 : 10; };
const truth = { nodesMjd: [], altitudeKm: [], values: [] };
for (let h = 0; h <= fitDays * 24 + 24; h += 6) { truth.nodesMjd.push(t0 - 1 + h / 24); truth.values.push([trueAt(t0 - 1 + h / 24)]); }
const histories = await synthetic({ days: fitDays, correction: truth, noiseM: 1, seed: 20261009, stepSeconds: fitStep, objects: [
  { id: 'A', aKm: 6378.137 + 360, e: 0.0008, inc: 65, B: 0.012 }, { id: 'C', aKm: 6378.137 + 480, e: 0.0015, inc: 98, B: 0.02 },
  { id: 'E', aKm: 7100, e: 0.06, inc: 74, B: 0.012 }] });
// The test's anchored request: object C's ballistic coefficient is known to 1 %, which fixes the level of the correction.
const calibrateDecay = () => ({ jb2008: { rows: decayRows(t0 - 8, t0 + fitDays + 2) }, stepSeconds: fitStep, iterations: 12, nodes: { fromMjd: t0, toMjd: t0 + fitDays, stepHours: 6 },
  priors: { randomWalkKPerSqrtDay: 60, meanLevelK: 200 }, sigmaFloorM: 0.5,
  objects: histories.map((h) => ({ id: h.id, sets: h.sets, ...(h.id === 'C' ? { lnBPrior: { mean: Math.log(h.B), sigma: 0.01 } } : {}) })) });

// ---- energy and drag_work (energy.test.mjs, nrlmsise.test.mjs) ----
const GM = 398600.4418e9, OMEGA = 7.292115e-5;
// A Cartesian GCRF state from Keplerian elements (a m, e, angles deg): the textbook rotation.
function keplerState(a, e, iDeg, raanDeg, argpDeg, nuDeg) {
  const d = Math.PI / 180, nu = nuDeg * d, p = a * (1 - e * e), r = p / (1 + e * Math.cos(nu)), vq = Math.sqrt(GM / p);
  const pqw = [r * Math.cos(nu), r * Math.sin(nu), 0], vpqw = [-vq * Math.sin(nu), vq * (e + Math.cos(nu)), 0];
  const cO = Math.cos(raanDeg * d), sO = Math.sin(raanDeg * d), ci = Math.cos(iDeg * d), si = Math.sin(iDeg * d), cw = Math.cos(argpDeg * d), sw = Math.sin(argpDeg * d);
  const R = [[cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si], [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si], [sw * si, cw * si, ci]];
  const mul = (v) => R.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  return { r: mul(pqw), v: mul(vpqw) };
}
const ORBIT = [6378137 + 500e3, 0.001, 97.4, 120, 80, 10];  // the tests' starting state: 500 km, sun-synchronous
const start = keplerState(...ORBIT);
// The two-body arc of the starting state over spanSeconds, one state every stepSeconds (the tests integrate it with propagator/hpop).
function arc(epochMjd, spanSeconds, stepSeconds) {
  const [a, e, i, raan, argp, nu0] = ORBIT, nu = nu0 * Math.PI / 180;
  const E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2)), M0 = E0 - e * Math.sin(E0), rate = Math.sqrt(GM / a ** 3);
  const states = [];
  for (let t = 0; t <= spanSeconds + 1e-6; t += stepSeconds) {
    const M = M0 + rate * t;
    let E = M;
    for (let k = 0; k < 8; ++k) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const anomaly = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    states.push({ mjd: epochMjd + t / 86400, ...keplerState(a, e, i, raan, argp, anomaly * 180 / Math.PI) });
  }
  return states;
}
const MJD0 = 61131.25;                                // 2026-04-01 06:00 UTC
const states = arc(MJD0, 6 * 3600, 60);
const jbRows = energyRows(MJD0, MJD0 + 1);
const B = 0.02;                                       // Cd*A/m, m^2/kg
// nrlmsise.test.mjs: the 6 h arc from 21:00 UTC crosses 00:00 UTC over rows whose F10.7, 81-day mean and Ap differ from day to day.
const MJD_NIGHT = 61131.875;
const nightStates = arc(MJD_NIGHT, 6 * 3600, 60);
const nightRows = spwRows(Math.floor(MJD_NIGHT) - 3, Math.floor(MJD_NIGHT) + 3);
// 'evaluate: NRLMSISE-00 densities at points': day of year 172, 29000 s; a point above 1000 km is refused.
const jan1 = 61041;
const msisMjd = jan1 + 171 + 29000 / 86400;
const msisPoints = { mjd: [msisMjd, msisMjd, msisMjd, msisMjd], latDeg: [60, 60, 60, 0], lonDeg: [-70, 110, -70, 30], altKm: [400, 400, 1200, 300] };
const msisRows = spwRows(jan1 + 160, jan1 + 180);
const lowState = { states: [{ mjd: 61000, r: [7e6, 0, 0], v: [0, 7.5e3, 0] }] };

export const cases = [
  // evaluate, JB2008
  { id: 'evaluate-jb2008', method: 'evaluate', request: ({ points, jb2008: { rows: segmentRows(40) } }) },
  { id: 'evaluate-jb2008-segment-correction', method: 'evaluate', request: ({ points, jb2008: { rows: segmentRows(0) }, correction: segmentCorrection }) },
  { id: 'evaluate-jb2008-point-before-drivers', method: 'evaluate', request: ({ points: { mjd: [61041.5], latDeg: [0], lonDeg: [0], altKm: [400] }, jb2008: { rows: segmentRows(0) } }) },
  { id: 'evaluate-jb2008-node-correction', method: 'evaluate', request: ({ points: nodePoints, jb2008: { rows: decayRows(t0 - 8, t0 + 2) }, correction: nodeCorrection }) },
  { id: 'evaluate-jb2008-derivative', method: 'evaluate', request: ({ points: nodePoints, jb2008: { rows: decayRows(t0 - 8, t0 + 2) }, correction: nodeCorrection, derivative: true }) },
  { id: 'evaluate-jb2008-sun-diagnostics', method: 'evaluate', request: ({ points: { mjd: horizonsMjd, latDeg: horizonsMjd.map(() => 0), lonDeg: horizonsMjd.map(() => 0),
    altKm: horizonsMjd.map(() => 400) }, jb2008: { rows: horizonsRows }, diagnostics: true }) },
  { id: 'evaluate-jb2008-raw-drivers', method: 'evaluate', request: ({ raw: nominal }) },
  // evaluate, NRLMSISE-00
  { id: 'evaluate-nrlmsise00', method: 'evaluate', request: ({ points: msisPoints, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: msisRows } }) },
  // calibrate
  { id: 'calibrate-raw-drivers', method: 'calibrate', request: (calibrateRaw) },
  { id: 'calibrate-points-weights', method: 'calibrate', request: ({ points: { ...points, rho: pointDensities.map((r, i) => r * (1 + 0.01 * Math.sin(i))),
    weight: points.mjd.map((_, i) => 1 + (i % 3)) }, jb2008: { rows: segmentRows(0) }, degree: 1, binHours: 6, fromMjd: 61047, toMjd: 61047.7, minPoints: 5 }) },
  // decay
  ...valladoClusters.map((cluster) => ({ id: `decay-vallado-samples-${cluster.map((c) => c.satnum).join('-')}`, method: 'decay', request: (valladoCall(cluster)) })),
  { id: 'decay-circular', method: 'decay', request: (decayOf(circular, 0)) },
  { id: 'decay-eccentric-correction', method: 'decay', request: (decayOf(eccentric, 60)) },
  // calibrate_decay
  { id: 'calibrate-decay-anchored', method: 'calibrate_decay', request: (calibrateDecay()) },
  { id: 'calibrate-decay-altitude-nodes-residuals', method: 'calibrate_decay', request: ({ ...calibrateDecay(), residuals: true, editSigma: 3,
    nodes: { fromMjd: t0, toMjd: t0 + fitDays, stepHours: 12, altitudeKm: [350, 700] }, priors: { randomWalkKPerSqrtDay: 60, meanLevelK: 200, altitudeDifferenceK: 80 } }) },
  // energy
  { id: 'energy-arc', method: 'energy', request: ({ states, degree: 36, gm: GM, omega: OMEGA }) },
  { id: 'energy-gradient', method: 'energy', request: ({ states: [{ mjd: MJD0 + 0.1, r: start.r, v: start.v }], degree: 36, gm: GM, omega: OMEGA, gradient: true }) },
  { id: 'energy-inside-earth', method: 'energy', request: ({ states: [{ mjd: 61000, r: [1e6, 0, 0], v: [0, 7.5e3, 0] }] }) },
  { id: 'energy-earth-orientation', method: 'energy', request: ({ states: states.slice(0, 5).map((x, i) => ({ ...x, dut1: -0.1 + 0.01 * i, xp: 0.12, yp: 0.35 })),
    degree: 20, order: 12, gm: GM, omega: OMEGA, gradient: true }) },
  // drag_work
  { id: 'drag-work-jb2008', method: 'drag_work', request: ({ states, jb2008: { rows: jbRows }, B }) },
  { id: 'drag-work-jb2008-correction', method: 'drag_work', request: ({ states, jb2008: { rows: jbRows }, B,
    correction: { nodesMjd: [MJD0 - 1, MJD0 + 2], altitudeKm: [], values: [[60], [60]] } }) },
  { id: 'drag-work-nrlmsise00', method: 'drag_work', request: ({ states: nightStates, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: nightRows }, B }) },
  // requests the tests expect to be refused: the error code and message are part of the output
  { id: 'refused-energy-degree', method: 'energy', request: ({ ...lowState, degree: 1 }) },
  { id: 'refused-drag-work-without-drivers', method: 'drag_work', request: (lowState) },
  { id: 'refused-evaluate-nrlmsise00-derivative', method: 'evaluate', request: ({ points: msisPoints, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: msisRows }, derivative: true }) },
  { id: 'refused-calibrate-nrlmsise00', method: 'calibrate', request: ({ points: { mjd: [msisMjd], latDeg: [0], lonDeg: [0], altKm: [400], rho: [1e-12] }, atmosphere: 'NRLMSISE00', nrlmsise00: { rows: msisRows } }) },
];
