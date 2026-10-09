import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { block, celestial, earthOrientation, eoo, eopRow, options, predictions, rdo, rfo } from './lib.mjs';

// Association of real GNSS geometry, where the right answer is known by
// construction from independent sources (fixture: scripts/build-gps-fixture.mjs).
//
// Truth: the ESA/ESOC final orbits (Earth-fixed IGS20, GPS time) of GPS and
// Galileo on 2026-08-02. Catalog: the IGS final combined GPS orbits, an
// independent analysis, as GCRF/UTC predictions with their stated covariance,
// minus two GPS satellites. Observations are generated here from the ESA
// truth at three IGS sites, 06:00-08:00 GPST every 15 min, above 10 degrees
// elevation:
//   WTZR radar ($RDO): range 10 m, range rate 5 cm/s, azimuth and elevation
//     0.005 deg (1-sigma);
//   GOLD optical ($EOO): topocentric GCRF RA and declination, 1 arcsec;
//   YAR2 RF ($RFO): one-way Doppler of the GPS L1 carrier (1575.42 MHz),
//     1 Hz (GPS satellites only).
// Geometry of the generation, independent of the module's formulation: the
// one-way light time is solved in the Earth-fixed frame with the Sagnac
// rotation R3(omega tau) (the Sagnac correction); range rate is the central
// difference (+-0.5 s) of that range; RA and declination use the IGS
// ITRF-to-GCRF rotation recovered by least squares from the IGS Earth-fixed
// and GCRF positions of the same satellites at the same instants.
// Gaussian noise of the stated sigma is added (seeded).

const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('./fixtures/gps-20260802.json.gz', import.meta.url))));

const C = 299792.458, OMEGA = 7.292115e-5, DEG = Math.PI / 180;
const WGS84 = { a: 6378.137, f: 1 / 298.257223563 };
const SITES = {  // approximate IGS site positions (WGS-84 geodetic)
  WTZR: { lat: 49.1442, lon: 12.8789, h: 0.666 },
  GOLD: { lat: 35.4252, lon: -116.8893, h: 0.986 },
  YAR2: { lat: -29.0466, lon: 115.3470, h: 0.241 },
};
const SIGMA = { range: 0.010, rangeRate: 5e-5, angle: 0.005, radec: 1 / 3600, frequencyHz: 1 };
const L1_MHZ = 1575.42;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.sqrt(dot(a, a));
const mat = (m, v) => m.map((row) => dot(row, v));
function ecef({ lat, lon, h }) {
  const e2 = WGS84.f * (2 - WGS84.f), p = lat * DEG, l = lon * DEG;
  const n = WGS84.a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return [(n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - e2) + h) * Math.sin(p)];
}
const enu = ({ lat, lon }) => {
  const p = lat * DEG, l = lon * DEG;
  return [[-Math.sin(l), Math.cos(l), 0], [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)], [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]];
};
const seconds = (gpst) => (Date.parse(`${gpst}Z`) - Date.parse('2026-08-02T00:00:00Z')) / 1000;
const utcText = (gpst) => new Date(Date.parse(`${gpst}Z`) - fx.timeScale.gpsMinusUtcSeconds * 1000).toISOString().replace('.000Z', '.000000Z');

// Degree-9 Lagrange interpolation of the ESA Earth-fixed positions.
const truthEpochs = Object.keys(fx.esaItrf).sort();
const truthTimes = truthEpochs.map(seconds);
function truth(sat, t) {
  let i = truthTimes.findIndex((x) => x >= t);
  const first = Math.max(0, Math.min(truthTimes.length - 10, i - 5));
  const out = [0, 0, 0];
  for (let a = first; a < first + 10; a++) {
    let w = 1;
    for (let b = first; b < first + 10; b++) if (b !== a) w *= (t - truthTimes[b]) / (truthTimes[a] - truthTimes[b]);
    const r = fx.esaItrf[truthEpochs[a]][sat];
    for (let k = 0; k < 3; k++) out[k] += w * r[k];
  }
  return out;
}
const hasTruth = (sat) => truthEpochs.every((e) => fx.esaItrf[e][sat]);
// Down-leg light time in the Earth-fixed frame of reception: the satellite
// at t - tau, rotated by the Earth's turn during tau (Sagnac).
function downleg(sat, t, site) {
  let tau = 0.07, rel;
  for (let i = 0; i < 8; i++) {
    const r = truth(sat, t - tau), a = OMEGA * tau;
    const rotated = [Math.cos(a) * r[0] + Math.sin(a) * r[1], -Math.sin(a) * r[0] + Math.cos(a) * r[1], r[2]];
    rel = sub(rotated, site);
    tau = norm(rel) / C;
  }
  return { rel, range: norm(rel) };
}

// The IGS ITRF -> GCRF rotation at an epoch: M = (sum g e^T)(sum e e^T)^-1.
const catalogByPrn = Object.fromEntries(fx.catalog.map((c) => [c.prn, c]));
function rotation(gpst) {
  const utc = utcText(gpst);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const [prn, e] of Object.entries(fx.igsItrf[gpst])) {
    const g = catalogByPrn[prn]?.states.find((s) => s.epoch.startsWith(utc.slice(0, 19)))?.state;
    if (!g) continue;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { A[i][j] += g[i] * e[j]; B[i][j] += e[i] * e[j]; }
  }
  const det = B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1]) - B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0]) + B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0]);
  const inv = [[0, 1, 2], [0, 1, 2], [0, 1, 2]].map((row, i) => row.map((j) => {
    const r = [0, 1, 2].filter((x) => x !== j), c = [0, 1, 2].filter((x) => x !== i);
    return ((i + j) % 2 ? -1 : 1) * (B[r[0]][c[0]] * B[r[1]][c[1]] - B[r[0]][c[1]] * B[r[1]][c[0]]) / det;
  }));
  const M = A.map((row) => [0, 1, 2].map((j) => row.reduce((s, x, k) => s + x * inv[k][j], 0)));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const mtm = M.reduce((s, row) => s + row[i] * row[j], 0);
    assert.ok(Math.abs(mtm - (i === j ? 1 : 0)) < 1e-9, `recovered rotation is orthonormal at ${gpst}`);
  }
  return M;
}

function random(seed) {
  let a = seed >>> 0;
  const uniform = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}


// The inputs of one associate_observations call, the truth satellite of each
// observation and the catalog it was given.
export function gpsScenario() {
  const gauss = random(20261009);
  const prns = Object.keys(catalogByPrn).sort();
  const dropped = [prns[3], prns[11]];
  const catalog = fx.catalog.filter((c) => !dropped.includes(c.prn));
  const sats = Object.keys(fx.esaItrf[truthEpochs[0]]).filter((s) => /^[GE]/.test(s) && hasTruth(s)).sort();
  const inputs = [], truthOf = new Map();
  for (const gpst of fx.observationEpochsGpst) {
    const t0 = seconds(gpst), M = rotation(gpst), obTime = utcText(gpst);
    for (const [name, site] of Object.entries(SITES)) {
      const optical = name === 'GOLD';
      const position = optical ? ecef(site).map(Math.fround) : ecef(site);
      const local = enu(site);
      for (const sat of sats) {
        if (name === 'YAR2' && !sat.startsWith('G')) continue;
        const { rel, range } = downleg(sat, t0, position);
        const [e, n, u] = mat(local, rel);
        const el = Math.asin(u / range) / DEG;
        if (el < 10) continue;
        const id = `${name}-${sat}-${gpst.slice(11, 16)}`;
        truthOf.set(id, sat);
        if (name === 'WTZR') {
          const rate = (downleg(sat, t0 + 0.5, position).range - downleg(sat, t0 - 0.5, position).range) / 1.0;
          let az = Math.atan2(e, n) / DEG;
          if (az < 0) az += 360;
          inputs.push(rdo({ ID: id, OB_TIME: obTime, ID_SENSOR: name, SEN_REFERENCE_FRAME: 'ITRF', SENX: position[0], SENY: position[1], SENZ: position[2],
            RANGE: range + SIGMA.range * gauss(), RANGE_UNC: SIGMA.range, RANGE_RATE: rate + SIGMA.rangeRate * gauss(), RANGE_RATE_UNC: SIGMA.rangeRate,
            AZIMUTH: az + SIGMA.angle * gauss(), AZIMUTH_UNC: SIGMA.angle, ELEVATION: el + SIGMA.angle * gauss(), ELEVATION_UNC: SIGMA.angle }));
        } else if (optical) {
          const d = mat(M, rel);
          let ra = Math.atan2(d[1], d[0]) / DEG;
          if (ra < 0) ra += 360;
          const dec = Math.asin(d[2] / norm(d)) / DEG;
          inputs.push(eoo({ ID: id, OB_TIME: obTime, SENSOR_ID: name, SENX: position[0], SENY: position[1], SENZ: position[2], REFERENCE_FRAME: celestial('GCRF'),
            RA: ra + SIGMA.radec * gauss() / Math.cos(dec * DEG), RA_UNC: SIGMA.radec / Math.cos(dec * DEG), DECLINATION: dec + SIGMA.radec * gauss(), DECLINATION_UNC: SIGMA.radec }));
        } else {
          const rate = (downleg(sat, t0 + 0.5, position).range - downleg(sat, t0 - 0.5, position).range) / 1.0;
          inputs.push(rfo({ ID: id, OB_TIME: obTime, ID_SENSOR: name, SENLAT: site.lat, SENLON: site.lon, SENALT: site.h,
            NOMINAL_FREQUENCY: L1_MHZ, FREQUENCY: L1_MHZ * (1 - rate / C) + SIGMA.frequencyHz * 1e-6 * gauss() }));
        }
      }
    }
  }
  inputs.push(predictions(catalog.map((c) => block({ norad: c.norad, objectId: c.objectId, name: c.name, frame: 'GCRF', degree: 7, states: c.states, covariances: c.covariances }))));
  inputs.push(earthOrientation(fx.eop.map(eopRow)));
  inputs.push(options({ frequency_sigma_hz: SIGMA.frequencyHz }));
  return { inputs, truthOf, catalog };
}
