// The SDS records the tests send and read, through the published package's JavaScript bindings. This is the host
// side of the module: it builds and decodes bytes; every orbit computation is the module's.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as flatbuffers from 'flatbuffers';

const require = createRequire(import.meta.url);
const standards = path.dirname(require.resolve('spacedatastandards.org/package.json'));
const load = (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)));
export const [OMM, OEM, OBD, EOP, RFM, TIM] = await Promise.all(['OMM', 'OEM', 'OBD', 'EOP', 'RFM', 'TIM'].map(load));
export { flatbuffers };
export const sdsVersion = JSON.parse((await import('node:fs')).readFileSync(path.join(standards, 'package.json'), 'utf8')).version;

export const TYPES = {
  OMM: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' },
  OEM: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' },
  OBD: { schemaName: 'OBD.fbs', fileIdentifier: '$OBD', rootTypeName: 'OBD', wireFormat: 'flatbuffer' },
  EOP: { schemaName: 'EOP.fbs', fileIdentifier: '$EOP', rootTypeName: 'EOP', wireFormat: 'flatbuffer' },
};
export const frame = (portId, type, bytes) => ({ portId, payload: Buffer.from(bytes), typeRef: TYPES[type] });

// ---- $OMM ------------------------------------------------------------------------------------------------------
const THEORY = { SGP4XP: OMM.meanElementSource.SGP4XP, SGP4: OMM.meanElementSource.SGP4 };
/** A size-prefixed $OMM. `bterm` and `agom` are BSTAR and MEAN_MOTION_DDOT when theory is SGP4XP. */
export function ommBytes(o) {
  const t = new OMM.OMMT();
  Object.assign(t, {
    CCSDS_OMM_VERS: 3.0, CREATION_DATE: o.creation ?? '', ORIGINATOR: o.originator ?? 'TEST', OBJECT_NAME: o.name ?? '', OBJECT_ID: o.id ?? '',
    CENTER_NAME: 'EARTH', TIME_SYSTEM: TIM.timingStandard.UTC, MEAN_ELEMENT_THEORY: THEORY[o.theory ?? 'SGP4XP'], EPOCH: o.epoch,
    MEAN_MOTION: o.meanMotion, ECCENTRICITY: o.eccentricity, INCLINATION: o.inclination, RA_OF_ASC_NODE: o.raan, ARG_OF_PERICENTER: o.argPerigee,
    MEAN_ANOMALY: o.meanAnomaly, NORAD_CAT_ID: o.norad ?? 0, ELEMENT_SET_NO: o.elementSetNo ?? 999, REV_AT_EPOCH: o.rev ?? 0,
    BSTAR: o.bterm ?? o.bstar ?? 0, MEAN_MOTION_DOT: o.meanMotionDot ?? 0, MEAN_MOTION_DDOT: o.agom ?? o.meanMotionDdot ?? 0,
  });
  const b = new flatbuffers.Builder(1024);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return b.asUint8Array();
}
export const readSizePrefixed = (cls, finder) => (bytes) => cls[finder](new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
export const readOmm = readSizePrefixed(OMM.OMM, 'getSizePrefixedRootAsOMM');
export const readOem = readSizePrefixed(OEM.OEM, 'getSizePrefixedRootAsOEM');
export const readObd = readSizePrefixed(OBD.OBD, 'getSizePrefixedRootAsOBD');

// ---- $EOP ------------------------------------------------------------------------------------------------------
/** A size-prefixed $EOP row: UT1-UTC in seconds, pole and celestial pole offsets in radians. */
export function eopBytes({ mjd, dut1 = 0, x = 0, y = 0, dx = 0, dy = 0 }) {
  const t = new EOP.EOPT();
  Object.assign(t, { MJD: mjd, UT1_MINUS_UTC_SECONDS: dut1, X_POLE_WANDER_RADIANS: x, Y_POLE_WANDER_RADIANS: y, X_CELESTIAL_POLE_OFFSET_RADIANS: dx, Y_CELESTIAL_POLE_OFFSET_RADIANS: dy, TAI_MINUS_UTC_SECONDS: 37 });
  const b = new flatbuffers.Builder(256);
  EOP.EOP.finishSizePrefixedEOPBuffer(b, t.pack(b));
  return b.asUint8Array();
}

// ---- $OEM ------------------------------------------------------------------------------------------------------
const rfm = (name) => {
  if (name === 'ECEF') return new RFM.RFMT(RFM.RFMUnion.CustomFrameWrapper, new RFM.CustomFrameWrapperT(RFM.CustomFrame.ECEF));
  return new RFM.RFMT(RFM.RFMUnion.CelestialFrameWrapper, new RFM.CelestialFrameWrapperT(RFM.CelestialFrame[name]));
};
/**
 * A size-prefixed $OEM. Each block: { frame: 'TEMEOFDATE'|'GCRF'|'EME2000'|'ECEF'|..., timeSystem: 'UTC'|'GPS', start, stop,
 * useableStart, useableStop, step + data (compact, stateSize 3|6) | lines [{epoch, r, v?}], object: {name, id, norad} }.
 */
export function oemBytes({ originator = 'TEST', creation = '', blocks }) {
  const t = new OEM.OEMT();
  t.CCSDS_OEM_VERS = 2.0;
  t.CREATION_DATE = creation;
  t.ORIGINATOR = originator;
  t.EPHEMERIS_DATA_BLOCK = blocks.map((bl) => {
    const b = new OEM.ephemerisDataBlockT();
    b.OBJECT = new OEM.CATT();
    Object.assign(b.OBJECT, { OBJECT_NAME: bl.object?.name ?? '', OBJECT_ID: bl.object?.id ?? '', NORAD_CAT_ID: bl.object?.norad ?? 0 });
    b.CENTER_NAME = 'EARTH';
    b.REFERENCE_FRAME = rfm(bl.frame ?? 'TEMEOFDATE');
    b.TIME_SYSTEM = TIM.timingStandard[bl.timeSystem ?? 'UTC'];
    b.START_TIME = bl.start ?? null;
    b.STOP_TIME = bl.stop ?? null;
    b.USEABLE_START_TIME = bl.useableStart ?? null;
    b.USEABLE_STOP_TIME = bl.useableStop ?? null;
    if (bl.data) {
      b.STEP_SIZE = bl.step;
      b.STATE_VECTOR_SIZE = bl.stateSize ?? 6;
      b.EPHEMERIS_DATA = Array.from(bl.data);
    } else if (bl.lines) {
      b.EPHEMERIS_DATA_LINES = bl.lines.map((l) => {
        const line = new OEM.ephemerisDataLineT();
        line.EPOCH = l.epoch;
        [line.X, line.Y, line.Z] = l.r ?? [0, 0, 0];
        [line.X_DOT, line.Y_DOT, line.Z_DOT] = l.v ?? [0, 0, 0];
        return line;
      });
    }
    return b;
  });
  const b = new flatbuffers.Builder(1 << 16);
  OEM.OEM.finishSizePrefixedOEMBuffer(b, t.pack(b));
  return b.asUint8Array();
}
// States of a decoded $OEM block: [{ epoch, r, v }].
export const blockLines = (block) => block.EPHEMERIS_DATA_LINES.map((l) => ({ epoch: l.EPOCH, r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT] }));
export const iso = (ms) => new Date(Math.round(ms)).toISOString().replace('Z', '') + 'Z';
