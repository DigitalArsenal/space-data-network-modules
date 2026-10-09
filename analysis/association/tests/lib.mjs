// Test plumbing: SDS record builders (the published spacedatastandards.org
// JavaScript bindings), one harness per invocation, and output decoding.
// Representation only; no measurement physics lives here.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
export const flatbuffers = require('flatbuffers');
const lib = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
export const RDO = await lib('RDO');
export const EOO = await lib('EOO');
export const RFO = await lib('RFO');
export const OEM = await lib('OEM');
export const EOP = await lib('EOP');

export const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
export const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const wasm = fs.readFileSync(wasmPath);

const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' });
const finish = (mod, code, object) => {
  const b = new flatbuffers.Builder(1 << 16);
  b.finish(object.pack(b), `$${code}`);
  return b.asUint8Array().slice();
};

function assign(object, fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in object)) throw new Error(`${object.constructor.name} has no field ${k}`);
    object[k] = v;
  }
  return object;
}

export const celestial = (name) => assign(new OEM.RFMT(), {
  REFERENCE_FRAME_type: OEM.RFMUnion.CelestialFrameWrapper,
  REFERENCE_FRAME: assign(new OEM.CelestialFrameWrapperT(), { frame: OEM.CelestialFrame[name] }),
});

export const rdo = (fields) => ({ portId: 'radar_observations', typeRef: typeRef('RDO'), payload: finish(RDO, 'RDO', assign(new RDO.RDOT(), fields)) });
export const eoo = (fields) => ({ portId: 'optical_observations', typeRef: typeRef('EOO'), payload: finish(EOO, 'EOO', assign(new EOO.EOOT(), fields)) });
export const rfo = (fields) => ({ portId: 'rf_observations', typeRef: typeRef('RFO'), payload: finish(RFO, 'RFO', assign(new RFO.RFOT(), fields)) });

// One prediction block: states [{epoch, state[6] km km/s}], covariances
// [{epoch, lower[21] km^2 ...}] in `frame`.
export function block({ norad = 0, objectId = '', name = '', frame = 'GCRF', degree = 7, states, covariances, covFrame }) {
  const b = new OEM.ephemerisDataBlockT();
  b.OBJECT = assign(new OEM.CATT(), { NORAD_CAT_ID: norad, OBJECT_ID: objectId, OBJECT_NAME: name });
  b.CENTER_NAME = 'EARTH';
  b.REFERENCE_FRAME = celestial(frame);
  if (covFrame) b.COV_REFERENCE_FRAME = covFrame;
  b.TIME_SYSTEM = OEM.timingStandard.UTC;
  b.INTERPOLATION = 'LAGRANGE';
  b.INTERPOLATION_DEGREE = degree;
  b.EPHEMERIS_DATA_LINES = states.map(({ epoch, state }) => assign(new OEM.ephemerisDataLineT(), {
    EPOCH: epoch, X: state[0], Y: state[1], Z: state[2], X_DOT: state[3], Y_DOT: state[4], Z_DOT: state[5],
  }));
  const names = ['CX_X', 'CY_X', 'CY_Y', 'CZ_X', 'CZ_Y', 'CZ_Z', 'CX_DOT_X', 'CX_DOT_Y', 'CX_DOT_Z', 'CX_DOT_X_DOT',
    'CY_DOT_X', 'CY_DOT_Y', 'CY_DOT_Z', 'CY_DOT_X_DOT', 'CY_DOT_Y_DOT', 'CZ_DOT_X', 'CZ_DOT_Y', 'CZ_DOT_Z', 'CZ_DOT_X_DOT', 'CZ_DOT_Y_DOT', 'CZ_DOT_Z_DOT'];
  b.COVARIANCE_MATRIX_LINES = (covariances ?? []).map(({ epoch, lower }) => {
    const line = new OEM.covarianceMatrixLineT();
    line.EPOCH = epoch;
    names.forEach((n, i) => { line[n] = lower[i]; });
    return line;
  });
  return b;
}

export function predictions(blocks) {
  const m = assign(new OEM.OEMT(), { CREATION_DATE: '2026-10-09T00:00:00Z', ORIGINATOR: 'association tests', EPHEMERIS_DATA_BLOCK: blocks });
  return { portId: 'predictions', typeRef: typeRef('OEM'), payload: finish(OEM, 'OEM', m) };
}

// Diagonal 6x6 covariance as the 21-entry lower triangle.
export function diagonal(position, velocity = position * 1e-6) {
  const lower = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c <= r; c++) lower.push(r === c ? (r < 3 ? position : velocity) : 0);
  return lower;
}

// One $EOP row: IERS values in their published units (arcsec, s).
export function eopRow({ date, mjd, xArcsec, yArcsec, dut1, lod = 0, dXArcsec = 0, dYArcsec = 0 }) {
  const as = Math.PI / 648000;
  const row = new EOP.EOPT();
  assign(row, {
    DATE: date, MJD: mjd,
    X_POLE_WANDER_RADIANS: xArcsec * as, Y_POLE_WANDER_RADIANS: yArcsec * as,
    X_CELESTIAL_POLE_OFFSET_RADIANS: dXArcsec * as, Y_CELESTIAL_POLE_OFFSET_RADIANS: dYArcsec * as,
    UT1_MINUS_UTC_SECONDS: dut1, LENGTH_OF_DAY_CORRECTION_SECONDS: lod,
  });
  for (const [k, v] of [['X_POLE_WANDER_RADIANS_HP', xArcsec * as], ['Y_POLE_WANDER_RADIANS_HP', yArcsec * as], ['UT1_MINUS_UTC_SECONDS_HP', dut1],
    ['X_CELESTIAL_POLE_OFFSET_RADIANS_HP', dXArcsec * as], ['Y_CELESTIAL_POLE_OFFSET_RADIANS_HP', dYArcsec * as], ['LENGTH_OF_DAY_CORRECTION_SECONDS_HP', lod]]) {
    if (k in row) row[k] = v;
  }
  return row;
}

// Rows as one size-prefixed $EOP stream.
export function earthOrientation(rows) {
  const parts = rows.map((row) => {
    const b = new flatbuffers.Builder(256);
    b.finishSizePrefixed(row.pack(b), '$EOP');
    return b.asUint8Array().slice();
  });
  const payload = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { payload.set(p, at); at += p.length; }
  return { portId: 'earth_orientation', typeRef: typeRef('EOP'), payload };
}

export const options = (value) => ({ portId: 'options', typeRef: { schemaName: 'application/json' }, payload: Buffer.from(JSON.stringify(value)) });

async function invoke(methodId, inputs) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  try {
    return await h.invoke({ methodId, inputs });
  } finally {
    await h.destroy();
  }
}

const decoders = {
  radar: (p) => RDO.RDO.getRootAsRDO(new flatbuffers.ByteBuffer(p)).unpack(),
  optical: (p) => EOO.EOO.getRootAsEOO(new flatbuffers.ByteBuffer(p)).unpack(),
  rf: (p) => RFO.RFO.getRootAsRFO(new flatbuffers.ByteBuffer(p)).unpack(),
};

export async function associate(inputs) {
  const result = await invoke('associate_observations', inputs);
  if (result.statusCode !== 0) return { error: result.errorMessage };
  const records = { associated: [], ucts: [] };
  for (const f of result.outputs) {
    const m = /^(radar|optical|rf)_(associated|ucts)$/.exec(f.portId);
    if (m) records[m[2]].push({ family: m[1], record: decoders[m[1]](new Uint8Array(f.payload)) });
  }
  const report = JSON.parse(Buffer.from(result.outputs.find((f) => f.portId === 'report').payload).toString());
  return { report, records };
}

export async function solveAssignment(problem) {
  const result = await invoke('solve_assignment', [{ portId: 'problem', typeRef: { schemaName: 'application/json' }, payload: Buffer.from(JSON.stringify(problem)) }]);
  if (result.statusCode !== 0) return { error: result.errorMessage };
  return JSON.parse(Buffer.from(result.outputs.find((f) => f.portId === 'solution').payload).toString());
}
