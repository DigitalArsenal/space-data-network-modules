// Independent closed-form validation fixtures. Positions are metres in fixed
// Earth axes; epochs are TT Julian dates relative to J2000 TT. These prescribed
// straight lines test geometry/root location, not orbital dynamics. Expected
// values follow Euclidean angle/range equations and the WGS-84 equatorial limb
// (NGA WGS 84, https://earth-info.nga.mil/?action=wgs84&dir=wgs84,
// defining semi-major axis a=6378137 m). A 0.1 s edge tolerance
// includes requested Brent tolerance and double-precision Julian-date rounding.
import * as fb from 'flatbuffers';
import { ACW, ACWT, ACWRequestT, ACWConstraintT, ACWConstraintSetT,
  ACWObserverTrajectoryT, ACWStateSampleT, ACWBlackoutWindowT } from 'spacedatastandards.org/lib/js/ACW/main.js';
export const JD = 2451545.0;
export const secondsOf = (jd) => (jd - JD) * 86400;
const sample = (t, xyz) => new ACWStateSampleT(JD + t / 86400, ...xyz);
const series = (fn, times = [0, 100]) => times.map(t => sample(t, fn(t)));
const leaf = (KIND, LABEL, fields = {}) => Object.assign(new ACWConstraintT(), { KIND, LABEL }, fields);
const set = (constraints, operator = 0, sets = []) => new ACWConstraintSetT(operator, constraints, sets);
const movingObserver = (fn, blackouts = []) => new ACWObserverTrajectoryT('observer', 'observer', series(fn), blackouts);
function request(constraints, target, observer, extra = {}) {
  return Object.assign(new ACWRequestT(), {
    OPERATION: 1, STATES: series(target), CONSTRAINTS: constraints,
    OBSERVERS: [observer], EVALUATION_MODE: 1, ROOT_TOLERANCE_S: 0.01,
    TRACE_ID: 'events-acw-closed-form',
  }, extra);
}
export function accessCases() {
  const observer = () => movingObserver(() => [7000000, 0, 0]);
  const target = t => [7001000 + 100 * t, 0, 0];
  const rangeSet = set([leaf(4, 'minimum', { MIN_RANGE_M: 2000 }), leaf(3, 'maximum', { MAX_RANGE_M: 9000 })]);
  const cases = [{ id: 'range-and-attribution', request: request(rangeSet, target, observer()),
    expected: [[10, 80]], labels: [['minimum', 'maximum']], ranges: [[2000, 9000]] }];
  const alternatives = set([], 1, [set([leaf(3, 'near', { MAX_RANGE_M: 2000 })]), set([leaf(4, 'far', { MIN_RANGE_M: 9000 })])]);
  cases.push({ id: 'range-nested-or', request: request(alternatives, target, observer()), expected: [[0, 10], [80, 100]] });
  for (const [kind, name, bodyField, distance] of [[5, 'sun', 'SUN_STATES', 149597870700], [6, 'moon', 'MOON_STATES', 384400000]]) {
    cases.push({ id: `${name}-exclusion`, request: request(set([leaf(kind, name, { THRESHOLD_RAD: Math.PI / 4 })]),
      t => [7001000, 2000 - 40 * t, 0], observer(), { [bodyField]: series(() => [7000000 + distance, 0, 0]) }), expected: [[0, 25], [75, 100]] });
  }
  for (const atmosphere of [0, 100]) {
    cases.push({ id: `limb-atmosphere-${atmosphere}`, request: request(set([leaf(8, 'limb', { OCCULTATION_ATMOSPHERE_HEIGHT_M: atmosphere })]),
      t => [2000000, 6377137 + 20 * t, 0], movingObserver(t => [-2000000, 6377137 + 20 * t, 0])), expected: [[50 + atmosphere / 20, 100]] });
  }
  cases.push({ id: 'blackout-between-samples', request: request(set([leaf(9, 'blackout')]), target,
    movingObserver(() => [7000000, 0, 0], [new ACWBlackoutWindowT(JD + 25 / 86400, JD + 75 / 86400)])), expected: [[0, 25], [75, 100]] });
  cases.push({ id: 'target-umbra', request: request(set([leaf(7, 'umbra', { LIGHTING: 3 })]), () => [-7000000, 0, 0], observer(),
    { SUN_STATES: series(() => [149597870700, 0, 0]) }), expected: [[0, 100]] });
  cases.push({ id: 'range-discrete', request: request(rangeSet, target, observer(), { EVALUATION_MODE: 0, STATES: series(target, [0, 20, 40, 60, 80, 100]) }), expected: [[20, 80]] });
  cases.push({ id: 'missing-sun-refused', request: request(set([leaf(5, 'sun', { THRESHOLD_RAD: 0.1 })]), target, observer()), invalid: true });
  return cases;
}
export function encodeAccessRequest(request) {
  const builder = new fb.Builder(4096);
  const envelope = new ACWT(); envelope.REQUEST = request;
  ACW.finishACWBuffer(builder, envelope.pack(builder));
  return { methodId: 'locate_access_windows', inputs: [{ portId: 'request', typeRef: {
    schemaName: 'ACW.fbs', fileIdentifier: '$ACW', rootTypeName: 'ACW',
  }, payload: builder.asUint8Array().slice() }] };
}
export function decodeAccessResponse(response) {
  const output = response.outputs.find(x => x.portId === 'results');
  return output ? ACW.getRootAsACW(new fb.ByteBuffer(output.payload)).RESULT().unpack() : null;
}
