// Production $FRM requests containing canonical SDS $RFM coordinate systems.
// References are independent published numbers or the exact closed forms in
// RFM_SELECTORS_VERIFICATION.md. No fixture comes from the module under test.
import assert from 'node:assert/strict';
import * as fb from 'flatbuffers';
import {
  FRM, FRMT, FRMFrameTransformRequestT, FRMStateVectorT, FRMVector3T,
  RFMCoordinateSystemT, RFMOriginT, frmOperationCode, frmResultStatus,
  frmStateRepresentation, rfmAxisType, rfmOriginKind,
} from 'spacedatastandards.org/lib/js/FRM/main.js';
import { EOP, EOPT } from 'spacedatastandards.org/lib/js/EOP/main.js';

export { frmOperationCode, frmResultStatus, rfmAxisType, rfmOriginKind };
export const EPOCH = '2007-04-05T12:00:00Z';
export const AS2R = Math.PI / 648000;
export const OBJECT_ID = 'closed-form-object';
export const FRM_TYPE = { schemaName: 'FRM.fbs', fileIdentifier: '$FRM', rootTypeName: 'FRM' };
const q = Math.sqrt(3) / 2;

export const CASES = [
  {
    name: 'IERS1996', selector: 'TRUE_OF_DATE_EQUATOR_IERS1996', wire: 25,
    family: 'earth', tolerance: 1e-12, source: 'SOFA Earth Attitude §5.2, p.21',
    expected: [
      .999998403176203, -.001639032970562, -.000712190961847,
      .001639000942243, .999998655799521, -.000045552846624,
      .000712264667137, .000044385492226, .999999745354454,
    ],
  },
  {
    name: 'IERS2003', selector: 'TRUE_OF_DATE_EQUATOR_IERS2003', wire: 26,
    family: 'earth', tolerance: 1e-12, source: 'SOFA Earth Attitude §5.4, p.24',
    expected: [
      .999998402755640, -.001639289519579, -.000712191013215,
      .001639257491365, .999998655379006, -.000045552787478,
      .000712264729795, .000044385250265, .999999745354420,
    ],
  },
  {
    name: 'ENU', selector: 'TOPOCENTRIC_EAST_NORTH_UP', wire: 27,
    family: 'local', tolerance: 1e-14, source: 'geodetic tangent vectors, latitude 30°, longitude 0°',
    expected: [0, 1, 0, -.5, 0, q, q, 0, .5],
  },
  {
    name: 'NED', selector: 'TOPOCENTRIC_NORTH_EAST_DOWN', wire: 28,
    family: 'local', tolerance: 1e-14, source: 'geodetic tangent vectors, latitude 30°, longitude 0°',
    expected: [-.5, 0, q, 0, 1, 0, -q, 0, -.5],
  },
  {
    name: 'SEZ', selector: 'TOPOCENTRIC_SOUTH_EAST_ZENITH', wire: 29,
    family: 'local', tolerance: 1e-14, source: 'geodetic tangent vectors, latitude 30°, longitude 0°',
    expected: [.5, 0, -q, 0, 1, 0, q, 0, .5],
  },
  {
    name: 'wire VNC', selector: 'ORBITAL_VELOCITY_NORMAL_CONORMAL', wire: 30,
    family: 'orbital', tolerance: 1e-15, source: 'SDS 1.219.0 rfmAxisType: X=velocity, Z=orbit normal; r=(2,0,0), v=(3,4,0)',
    expected: [.6, .8, 0, -.8, .6, 0, 0, 0, 1],
  },
  {
    name: 'RTN', selector: 'ORBITAL_RADIAL_TRANSVERSE_NORMAL', wire: 31,
    family: 'orbital', tolerance: 1e-15, source: 'SDS radial/transverse/normal closed form; r=(2,0,0), v=(3,4,0)',
    expected: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  },
  {
    name: 'LVLH', selector: 'ORBITAL_LOCAL_VERTICAL_LOCAL_HORIZONTAL', wire: 32,
    family: 'orbital', tolerance: 1e-15, source: 'SDS nadir/-normal closed form; r=(2,0,0), v=(3,4,0)',
    expected: [0, 1, 0, 0, 0, -1, -1, 0, 0],
  },
];

export function earthOrigin() { return new RFMOriginT(rfmOriginKind.CELESTIAL_BODY, 399); }
export function siteOrigin(latitude = 30, longitude = 0) {
  const origin = new RFMOriginT(rfmOriginKind.GROUND_SITE);
  Object.assign(origin, { SITE_BODY_ID: 399, SITE_ID: 'closed-form-site',
    SITE_LATITUDE: latitude, SITE_LONGITUDE: longitude, SITE_ALTITUDE: 0 });
  return origin;
}
export function objectOrigin(id = OBJECT_ID) {
  const origin = new RFMOriginT(rfmOriginKind.SPACE_OBJECT);
  origin.OBJECT_ID = id;
  return origin;
}
export function system(name, axis, origin = earthOrigin()) {
  return new RFMCoordinateSystemT(name, axis, origin, 399, EPOCH, 'UTC');
}
export function systems(reference) {
  const origin = reference.family === 'local' ? siteOrigin()
    : reference.family === 'orbital' ? objectOrigin() : earthOrigin();
  return {
    source: system('reference-source', reference.family === 'local' ? rfmAxisType.BODY_FIXED : rfmAxisType.ICRF,
      reference.family === 'local' ? siteOrigin() : earthOrigin()),
    target: system(reference.name, rfmAxisType[reference.selector], origin),
  };
}
export function state(position, velocity = [0, 0, 0], name = 'reference-source') {
  return new FRMStateVectorT(frmStateRepresentation.CARTESIAN, [...position, ...velocity],
    new FRMVector3T(...position), new FRMVector3T(...velocity), name, EPOCH, 'UTC', 3.986004418e14);
}
export function frame(request, portId = 'request') {
  const builder = new fb.Builder(2048);
  FRM.finishFRMBuffer(builder, new FRMT(request, null).pack(builder));
  return { portId, typeRef: FRM_TYPE, payload: builder.asUint8Array() };
}
export function objectState(position = [2, 0, 0], velocity = [3, 4, 0], id = OBJECT_ID) {
  const request = new FRMFrameTransformRequestT();
  request.SOURCE_STATE = state(position, velocity, 'ICRF');
  // Synthetic inverse-square central field, SI units, for independently
  // calculable orbital rates: a=(-mu/r²,0,0)=(-2.5,0,0) m/s².
  request.SOURCE_STATE.GRAVITATIONAL_PARAMETER = 10;
  request.SOURCE_COORDINATE_SYSTEM = system('ICRF', rfmAxisType.ICRF, objectOrigin(id));
  return frame(request, 'object_state');
}
export function cookbookEop(overrides = {}) {
  const row = new EOPT();
  Object.assign(row, {
    DATE: '2007-04-05T00:00:00Z', MJD: 54195, SERIES: 5, IAU_CONVENTION: 1,
    DATA_SET_CID: 'sofa-cookbook-rfm-selectors',
    X_POLE_WANDER_RADIANS_HP: .0349282 * AS2R,
    Y_POLE_WANDER_RADIANS_HP: .4833163 * AS2R,
    UT1_MINUS_UTC_SECONDS_HP: -.072073685,
    X_CELESTIAL_POLE_OFFSET_RADIANS_HP: .0001725 * AS2R,
    Y_CELESTIAL_POLE_OFFSET_RADIANS_HP: -.0002650 * AS2R,
    NUTATION_DPSI_RADIANS: -.0550655 * AS2R,
    NUTATION_DEPS_RADIANS: -.0063580 * AS2R,
  }, overrides);
  const builder = new fb.Builder(1024);
  EOP.finishEOPBuffer(builder, row.pack(builder));
  return { portId: 'earth_orientation',
    typeRef: { schemaName: 'EOP.fbs', fileIdentifier: '$EOP', rootTypeName: 'EOP' }, payload: builder.asUint8Array() };
}
export function invokeRequest(reference, options = {}) {
  const { source, target } = systems(reference);
  const request = new FRMFrameTransformRequestT();
  Object.assign(request, {
    OPERATION: options.operation ?? frmOperationCode.FRAME_ROTATION,
    SOURCE_COORDINATE_SYSTEM: options.source ?? source,
    TARGET_COORDINATE_SYSTEM: options.target ?? target,
    EPOCH: EPOCH, EPOCH_TIME_SYSTEM: 'UTC',
  });
  if (options.state) {
    request.SOURCE_STATE = options.state;
    request.TARGET_REPRESENTATION = frmStateRepresentation.CARTESIAN;
  }
  const inputs = [frame(request)];
  if (reference.family !== 'orbital' && options.eop !== false) inputs.push(...(options.eop ?? [cookbookEop()]));
  if (reference.family === 'orbital' && options.object !== false) inputs.push(options.object ?? objectState());
  return { methodId: 'transform_frame_position', inputs };
}
export async function invokeResult(harness, reference, options) {
  const response = await harness.invoke(invokeRequest(reference, options));
  assert.equal(response.statusCode, 0, response.errorMessage);
  const output = response.outputs?.[0];
  assert.ok(output, 'module emitted no result');
  const buffer = new fb.ByteBuffer(output.payload);
  assert.ok(FRM.bufferHasIdentifier(buffer), 'result must be canonical $FRM');
  const result = FRM.getRootAsFRM(buffer).FRAME_TRANSFORM_RESULT();
  assert.ok(result, 'missing FRM result');
  return result;
}
export function matrixOf(result) {
  assert.equal(result.STATUS(), frmResultStatus.OK, result.ERROR_MESSAGE());
  return matrixValues(result.ROTATION_DCM());
}
export function matrixValues(m) {
  assert.ok(m, 'missing rotation DCM');
  return [m.M11(), m.M12(), m.M13(), m.M21(), m.M22(), m.M23(), m.M31(), m.M32(), m.M33()];
}
export const transpose = matrix => [0, 3, 6, 1, 4, 7, 2, 5, 8].map(i => matrix[i]);
export const apply = (matrix, vector) => [0, 3, 6].map(i =>
  matrix[i] * vector[0] + matrix[i + 1] * vector[1] + matrix[i + 2] * vector[2]);
export const vectorOf = vector => [vector.X(), vector.Y(), vector.Z()];
export function measuredError(actual, expected) {
  assert.equal(actual.length, expected.length);
  assert.ok(actual.every(Number.isFinite), 'result must be finite');
  return Math.max(...actual.map((value, i) => Math.abs(value - expected[i])));
}
