// Request builders and the shared fixture of the observation-simulator tests
// (tests/observation_simulator.test.mjs, tests/parity.mjs). Representation only.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
export const require = createRequire(path.join(root, 'package.json'));
export const flatbuffers = require('flatbuffers');
export const load = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
export const [ACW, RDO, EOO, RFO] = await Promise.all(['ACW', 'RDO', 'EOO', 'RFO'].map(load));
export const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
export const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
export const wasm = fs.readFileSync(wasmPath);

export const DEG = Math.PI / 180, ARCSEC = DEG / 3600, C = 299792458, AU = 1.495978707e11;
export const add = (a, b) => a.map((x, i) => x + b[i]);
export const sub = (a, b) => a.map((x, i) => x - b[i]);
export const mul = (a, s) => a.map((x) => x * s);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => Math.sqrt(dot(a, a));

// JD TT from a UTC calendar instant with TAI-UTC (s).
export const jdTt = (ms, leap) => ms / 86400000 + 2440587.5 + (leap + 32.184) / 86400;
export const T0 = jdTt(Date.UTC(2026, 8, 1, 3, 0, 0), 37);          // 2026-09-01T03:00:00Z

// WGS-84 geodetic to Earth-fixed metres, closed form.
export function ecef(latDeg, lonDeg, h) {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - e2) + h) * Math.sin(lat)];
}
export function enu(latDeg, lonDeg) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  return {
    E: [-Math.sin(lo), Math.cos(lo), 0],
    N: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
    U: [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)],
  };
}

export function sample(jd, p, v = [0, 0, 0]) {
  const s = new ACW.ACWStateSampleT();
  s.JULIAN_DATE_TT = jd;
  [s.POSITION_X_M, s.POSITION_Y_M, s.POSITION_Z_M] = p;
  [s.VELOCITY_X_MPS, s.VELOCITY_Y_MPS, s.VELOCITY_Z_MPS] = v;
  return s;
}
// Constant Earth-fixed velocity v from p at jd0, sampled every step s.
export const straight = (jd0, p, v, seconds, step = 60) =>
  Array.from({ length: Math.floor(seconds / step) + 1 }, (_, k) => sample(jd0 + (k * step) / 86400, add(p, mul(v, k * step)), v));
export function station(id, lat, lon, h) {
  const s = new ACW.ACWGroundStationT();
  s.STATION_ID = id; s.LATITUDE_RAD = lat * DEG; s.LONGITUDE_RAD = lon * DEG; s.ALTITUDE_M = h;
  return s;
}
export function observer(id, states) {
  const o = new ACW.ACWObserverTrajectoryT();
  o.OBSERVER_ID = id; o.STATES = states;
  return o;
}
export function target(id, states, signature = {}) {
  const t = new ACW.ACWTargetT();
  t.TARGET_ID = id; t.NORAD_CAT_ID = 90000 + id.length; t.OBJECT_ID = `2026-9${id.length}A`; t.STATES = states;
  t.SIGNATURE = Object.assign(new ACW.ACWTargetSignatureT(), signature);
  return t;
}
export function model(type, sigma = 0, extra = {}) {
  const m = new ACW.MEMErrorModelT();
  m.MODEL_ID = `${type}`; m.MEASUREMENT_TYPE = ACW.memMeasurementType[type]; m.NOISE_SIGMA = sigma;
  m.APPLY_LIGHT_TIME = false;
  return Object.assign(m, extra);
}
export function sensor(id, host, phenomenology, models, extra = {}) {
  const s = new ACW.ACWSensorT();
  s.SENSOR_ID = id; s.HOST_ID = host; s.PHENOMENOLOGY = ACW.acwSensorPhenomenology[phenomenology];
  s.ERROR_MODELS = models; s.OBSERVATION_INTERVAL_S = 10;
  return Object.assign(s, extra);
}
export function access(sensorId, targetId, windows) {
  const a = new ACW.ACWSensorAccessT();
  a.SENSOR_ID = sensorId; a.TARGET_ID = targetId;
  a.WINDOWS = windows.map(([s, e]) => Object.assign(new ACW.ACWAccessWindowT(), { START_JULIAN_DATE_TT: s, END_JULIAN_DATE_TT: e }));
  return a;
}
export function request(fields) {
  const r = Object.assign(new ACW.ACWRequestT(), { OPERATION: ACW.acwOperationCode.SIMULATE_OBSERVATIONS, RANDOM_SEED: 7n }, fields);
  const m = new ACW.ACWT();
  m.REQUEST = r;
  const b = new flatbuffers.Builder(1 << 20);
  ACW.ACW.finishACWBuffer(b, m.pack(b));
  return b.asUint8Array();
}

// Topocentric fixture: a station at 30 N 0 E, 100 m, and a target fixed on
// the Earth at 300 km east, 400 km north and 500 km up from it: range
// sqrt(3^2 + 4^2 + 5^2) x 100 km = 707.1068 km, azimuth atan2(3, 4) =
// 36.8699 deg, elevation atan2(5, 5) = 45 deg.
export const SITE = ecef(30, 0, 100);
export const AXES = enu(30, 0);
export const OFFSET = add(add(mul(AXES.E, 300e3), mul(AXES.N, 400e3)), mul(AXES.U, 500e3));
export const FIXED = add(SITE, OFFSET);
