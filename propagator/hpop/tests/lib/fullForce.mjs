// The full force model's records for the configured-profile tests: the
// configuration and resident states as the catalog builds them (catalog.mjs),
// the environment frames, and a PPE reader. Encoding and decoding only; the
// propagation is the module's.
import fs from 'node:fs';
import * as flatbuffers from 'flatbuffers';
import { encodePrw, makeTable, nativeInput, sds, TYPE } from './prwCodec.mjs';
import * as catalog from '../../catalog.mjs';

export const GM = catalog.GM;
export const CATALOG_INTEGRATOR = catalog.CATALOG_INTEGRATOR;
export const fullForceRequest = catalog.fullForceRequest;
export const KERNEL = fs.readFileSync(new URL('../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp', import.meta.url));
const EOP = JSON.parse(fs.readFileSync(new URL('../fixtures/resident/eop-2026-08.json', import.meta.url), 'utf8'));
const SPW = JSON.parse(fs.readFileSync(new URL('../fixtures/resident/spw-2026-08-synthetic.json', import.meta.url), 'utf8'));

export const isoInstant = (iso, scale = 'TDB') => catalog.instant(iso, scale);

// One resident state: GCRF, UTC epoch, Cd*A/m and Cr*A/m.
export function residentRecord({ instance, handle, epoch, state, cdAm, crAm, extra = {} }) {
  return catalog.residentState({ instanceId: instance.INSTANCE_ID, generation: instance.GENERATION, handle, catalogNumber: handle,
    objectId: `object-${handle}`, epoch, state, cdAm, crAm, extra });
}

const eopRows = () => {
  const bytes = Buffer.from(EOP.payloadBase64, 'base64'), rows = [];
  for (let at = 0; at < bytes.length;) {
    const n = bytes.readUInt32LE(at);
    rows.push(sds.EOP.getSizePrefixedRootAsEOP(new flatbuffers.ByteBuffer(new Uint8Array(bytes.subarray(at, at + 4 + n)))).unpack());
    at += 4 + n;
  }
  return rows;
};
// The environment frames: kernel, Earth orientation and daily space weather.
export function environmentInputs() {
  return [
    { portId: 'kernel', typeRef: TYPE, payload: nativeInput(KERNEL) },
    { portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: eopRows() })) },
    { portId: 'space_weather', typeRef: TYPE, payload: encodePrw('SPACE_WEATHER', makeTable('PRWSpaceWeatherTable', { ROWS: SPW.rows.map((row) => makeTable('SPW', row)) })) },
  ];
}

// Seconds of a TDB ISO epoch since J2000 TDB, as [whole, fraction] (exact
// differences at the nanosecond).
export function isoSeconds(iso) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z?$/.exec(iso);
  const whole = (Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - Date.UTC(2000, 0, 1, 12)) / 1000;
  return [whole, m[7] ? Number(`0.${m[7]}`) : 0];
}
export const secondsBetween = (a, b) => (b[0] - a[0]) + (b[1] - a[1]);
export const isoAfter = (iso, seconds) => {
  const [whole, fraction] = isoSeconds(iso);
  const sum = fraction + seconds, carry = Math.floor(sum);
  let w = whole + carry, ns = Math.round((sum - carry) * 1e9);
  if (ns >= 1e9) { ns -= 1e9; w += 1; }
  return `${new Date(Date.UTC(2000, 0, 1, 12) + w * 1000).toISOString().slice(0, 19)}.${String(ns).padStart(9, '0')}`;
};

// A PPE position record evaluated at a TDB ISO epoch (Clenshaw), km and km/s.
// Conformance tooling: the module's own consumers evaluate PPE in WASM.
export function evaluatePpe(ephemeris, iso) {
  const at = isoSeconds(iso);
  for (const record of ephemeris.POSITION_RECORDS) {
    const tau = secondsBetween(isoSeconds(record.EPOCH_MID), at) / record.EPOCH_HALF_SPAN;
    if (tau < -1 - 1e-12 || tau > 1 + 1e-12) continue;
    const clenshaw = (c) => { let b1 = 0, b2 = 0; for (let j = c.length - 1; j >= 1; --j) { const b0 = 2 * tau * b1 - b2 + c[j]; b2 = b1; b1 = b0; } return tau * b1 - b2 + c[0]; };
    return { position: [record.POS_COEFF_X, record.POS_COEFF_Y, record.POS_COEFF_Z].map(clenshaw),
      velocity: [record.VEL_COEFF_X, record.VEL_COEFF_Y, record.VEL_COEFF_Z].map(clenshaw) };
  }
  throw new Error(`no PPE record holds ${iso}`);
}
