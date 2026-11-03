// foundation/frames `transform_frame_position` state transforms ($FRM requests). Encoding and decoding only: the rotations,
// their epochs and the state transforms are the module's. After repository harness/frames.mjs, generalized to any
// Earth-centered axis pair.
import * as fb from 'flatbuffers';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const standards = path.dirname(require.resolve('spacedatastandards.org/package.json'));
const load = (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)));
const [S, R] = await Promise.all([load('FRM'), load('RFM')]);
const { FRM, FRMT, FRMFrameTransformRequestT, FRMStateVectorT, FRMVector3T, frmOperationCode, frmResultStatus, frmStateRepresentation } = S;
const { RFMCoordinateSystemT, RFMOriginT, rfmAxisType, rfmOriginKind } = R;
const FRM_TYPE = { schemaName: 'FRM.fbs', fileIdentifier: '$FRM', rootTypeName: 'FRM' };
const earth = () => new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399);
const system = (name, axis, epoch) => new RFMCoordinateSystemT(name, rfmAxisType[axis], earth(), 399, epoch, 'UTC');
const stateVector = (state, name, epoch) => new FRMStateVectorT(frmStateRepresentation.CARTESIAN, [...state], new FRMVector3T(state[0], state[1], state[2]), new FRMVector3T(state[3], state[4], state[5]), name, epoch, 'UTC', 3.986004418e14);

/** The axis sets used here: [name, SDS axis type]. */
export const AXES = { GCRF: ['GCRF', 'ICRF'], TEME: ['TEME', 'TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE'], EME2000: ['EME2000', 'MEAN_EQUATOR_EQUINOX_J2000'] };

/** A state [x, y, z, vx, vy, vz] (any consistent length unit) from axes `from` to axes `to` at `epoch` (ISO UTC). */
export async function transformState(frames, from, to, epoch, state) {
  const [fn, fa] = AXES[from], [tn, ta] = AXES[to];
  const request = Object.assign(new FRMFrameTransformRequestT(), {
    OPERATION: frmOperationCode.STATE_TRANSFORM, SOURCE_COORDINATE_SYSTEM: system(fn, fa, epoch), TARGET_COORDINATE_SYSTEM: system(tn, ta, epoch),
    SOURCE_STATE: stateVector(state, fn, epoch), TARGET_REPRESENTATION: frmStateRepresentation.CARTESIAN, EPOCH: epoch, EPOCH_TIME_SYSTEM: 'UTC',
  });
  const b = new fb.Builder(2048);
  FRM.finishFRMBuffer(b, new FRMT(request, null).pack(b));
  const out = await frames.call('transform_frame_position', [{ portId: 'request', typeRef: FRM_TYPE, payload: b.asUint8Array() }]);
  const payload = Object.values(out)[0];
  const r = FRM.getRootAsFRM(new fb.ByteBuffer(new Uint8Array(payload))).FRAME_TRANSFORM_RESULT();
  if (!r || r.STATUS() !== frmResultStatus.OK) throw new Error(`foundation/frames: ${r?.ERROR_MESSAGE() ?? 'no result'}`);
  const t = r.TARGET_STATE(), p = t.POSITION(), v = t.VELOCITY();
  return [p.X(), p.Y(), p.Z(), v.X(), v.Y(), v.Z()];
}
