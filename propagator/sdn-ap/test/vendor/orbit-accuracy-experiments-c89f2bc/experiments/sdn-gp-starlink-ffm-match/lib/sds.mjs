// SDS records the experiment sends to and reads from the modules, through the published package's JavaScript
// bindings. Host side only: it builds and decodes bytes; every orbit computation is a module's.
// The OEM/OMM encoders follow modules propagator/sgp4-xp tests/lib/sds.mjs (commit 118de023), trimmed to what G1 uses.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as flatbuffers from 'flatbuffers';

const require = createRequire(import.meta.url);
const standards = path.dirname(require.resolve('spacedatastandards.org/package.json'));
const load = (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)));
export const [OMM, OEM, RFM, TIM] = await Promise.all(['OMM', 'OEM', 'RFM', 'TIM'].map(load));
export { flatbuffers };
export const sdsVersion = JSON.parse(fs.readFileSync(path.join(standards, 'package.json'), 'utf8')).version;

export const TYPES = {
  OMM: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' },
  OEM: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' },
  ERM: { schemaName: 'ERM.fbs', fileIdentifier: '$ERM', rootTypeName: 'ERM', wireFormat: 'flatbuffer' },
};
export const frame = (portId, type, bytes) => ({ portId, payload: Buffer.from(bytes), typeRef: TYPES[type] });
export const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });

const readSizePrefixed = (cls, finder) => (bytes) => cls[finder](new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack();
export const readOmm = readSizePrefixed(OMM.OMM, 'getSizePrefixedRootAsOMM');
export const readOem = readSizePrefixed(OEM.OEM, 'getSizePrefixedRootAsOEM');
export const blockLines = (block) => block.EPHEMERIS_DATA_LINES.map((l) => ({ epoch: l.EPOCH, r: [l.X, l.Y, l.Z], v: [l.X_DOT, l.Y_DOT, l.Z_DOT] }));

const rfm = (name) => new RFM.RFMT(RFM.RFMUnion.CelestialFrameWrapper, new RFM.CelestialFrameWrapperT(RFM.CelestialFrame[name]));

/** A size-prefixed $OEM of one block: { frame, center ('EARTH' by default), timeSystem, object: {name, id, norad}, lines: [{epoch, r, v}], start, stop, useableStart, useableStop }. */
export function oemBytes({ originator = 'G1', creation = '', block, sizePrefixed = true }) {
  const t = new OEM.OEMT();
  t.CCSDS_OEM_VERS = 2.0;
  t.CREATION_DATE = creation;
  t.ORIGINATOR = originator;
  const b = new OEM.ephemerisDataBlockT();
  b.OBJECT = new OEM.CATT();
  Object.assign(b.OBJECT, { OBJECT_NAME: block.object?.name ?? '', OBJECT_ID: block.object?.id ?? '', NORAD_CAT_ID: block.object?.norad ?? 0 });
  b.CENTER_NAME = block.center ?? 'EARTH';
  b.REFERENCE_FRAME = rfm(block.frame ?? 'GCRF');
  if (block.frameName) b.REFERENCE_FRAME.NAME = block.frameName; // some readers (sdn-gp-propagator) identify the frame by this string, not by the enumeration
  b.TIME_SYSTEM = TIM.timingStandard[block.timeSystem ?? 'UTC'];
  b.START_TIME = block.start ?? null;
  b.STOP_TIME = block.stop ?? null;
  b.USEABLE_START_TIME = block.useableStart ?? null;
  b.USEABLE_STOP_TIME = block.useableStop ?? null;
  b.EPHEMERIS_DATA_LINES = block.lines.map((l) => {
    const line = new OEM.ephemerisDataLineT();
    line.EPOCH = l.epoch;
    [line.X, line.Y, line.Z] = l.r;
    [line.X_DOT, line.Y_DOT, line.Z_DOT] = l.v ?? [0, 0, 0];
    return line;
  });
  t.EPHEMERIS_DATA_BLOCK = [b];
  const builder = new flatbuffers.Builder(1 << 16);
  if (sizePrefixed) OEM.OEM.finishSizePrefixedOEMBuffer(builder, t.pack(builder)); else OEM.OEM.finishOEMBuffer(builder, t.pack(builder));
  return builder.asUint8Array();
}

// ---- $OMM -----------------------------------------------------------------------------------------------------
const THEORY = { SGP4XP: OMM.meanElementSource.SGP4XP, SGP4: OMM.meanElementSource.SGP4 };
/** A size-prefixed $OMM holding only a set's elements (no fit statistics, covariance or comments): the set's own bytes. */
export function ommBytes(o) {
  const t = new OMM.OMMT();
  Object.assign(t, {
    CCSDS_OMM_VERS: 3.0, CREATION_DATE: '', ORIGINATOR: 'G1', OBJECT_NAME: '', OBJECT_ID: '', CENTER_NAME: 'EARTH',
    TIME_SYSTEM: TIM.timingStandard.UTC, MEAN_ELEMENT_THEORY: THEORY[o.theory], EPOCH: o.epoch,
    MEAN_MOTION: o.meanMotion, ECCENTRICITY: o.eccentricity, INCLINATION: o.inclination, RA_OF_ASC_NODE: o.raan, ARG_OF_PERICENTER: o.argPerigee,
    MEAN_ANOMALY: o.meanAnomaly, NORAD_CAT_ID: o.norad ?? 0, BSTAR: o.bstar ?? 0, MEAN_MOTION_DDOT: o.agom ?? 0,
  });
  const b = new flatbuffers.Builder(512);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return b.asUint8Array();
}
export const ommFrame = (portId, bytes) => ({ portId, payload: Buffer.from(bytes), typeRef: TYPES.OMM });
export const paramsOf = (omm) => Object.fromEntries(omm.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
