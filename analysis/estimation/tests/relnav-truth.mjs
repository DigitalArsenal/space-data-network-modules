// Truth for the relative-navigation and innovation-recovery E2E: every state
// comes from propagator/ffm (the modules' full-force propagator, ffm-port.mjs
// FULL_FORCE) running as C++ WASM; the filters' dynamics never generate it.
// Planted maneuvers are FFM's own: PRW impulses (FFM-1 IMPULSES, RTN basis) and
// a PRW finite burn with propagated mass.
//
// CONFORMANCE TOOLING (graph/checks/no-js-physics.mjs, class `test`): this file
// lives under a test tree, is never imported by a shipped bundle and runs no
// filter. Its only own geometry is the construction of initial conditions
// (Keplerian elements to an inertial state, an RTN offset, an equal-energy
// velocity) and the packing of FFM's inputs.
//
// TEST INPUTS EXTENDED FOR 72 h: the committed FFM fixtures cover the space
// weather days 2026-08-01..04 and the Earth orientation MJD 61252..61256, which
// is short of a 72 h arc. The space-weather table here repeats the last row on
// the added dates and the Earth orientation rows extrapolate linearly, so the
// arcs run on the same fixture family. These inputs reach FFM only; no filter
// sees them.
import * as flatbuffers from 'flatbuffers';
import { EOP, REFERENCE, SPW, isoUtc, requestInputs } from '../../../propagator/ffm/tests/lib/orekitCases.mjs';
import { TYPE, decodePrw, encodePrw, execution, makeTable, sds } from '../../../propagator/ffm/tests/lib/prwCodec.mjs';
import { EPOCH_JD, FULL_FORCE, isoOf, module } from './ffm-port.mjs';

export { EPOCH_JD, FULL_FORCE };
// The gravitational parameter FFM integrates with (REFERENCE.constants.gm) and the
// zonal constants of the EGM2008 field it uses (field radius, C20).
export const MU = REFERENCE.constants.gm;
export const FIELD_RADIUS_M = REFERENCE.constants.fieldRadiusM;
export const J2 = 1.08262668355e-3;
export const CADENCE_S = 60;

export const openFfm = () => module('../../../propagator/ffm/');

// ---- Earth orientation and space weather covering 2026-07-31 .. 2026-08-07 ----
const DAY_MS = 86400000, MJD_UNIX_EPOCH = 40587;
function fixtureEopRows() {
  const bytes = Buffer.from(EOP.payloadBase64, 'base64'), rows = [];
  for (let at = 0; at < bytes.length;) {
    const n = bytes.readUInt32LE(at);
    rows.push(sds.EOP.getSizePrefixedRootAsEOP(new flatbuffers.ByteBuffer(new Uint8Array(bytes.subarray(at, at + 4 + n)))).unpack());
    at += 4 + n;
  }
  return rows;
}
const LINEAR_FIELDS = ['X_POLE_WANDER_RADIANS', 'Y_POLE_WANDER_RADIANS', 'X_CELESTIAL_POLE_OFFSET_RADIANS', 'Y_CELESTIAL_POLE_OFFSET_RADIANS',
  'UT1_MINUS_UTC_SECONDS', 'X_POLE_WANDER_RADIANS_HP', 'Y_POLE_WANDER_RADIANS_HP', 'X_CELESTIAL_POLE_OFFSET_RADIANS_HP', 'Y_CELESTIAL_POLE_OFFSET_RADIANS_HP', 'UT1_MINUS_UTC_SECONDS_HP'];
export function extendedEopRows(lastMjd = 61258) {
  const rows = fixtureEopRows(), tail = rows.slice(-3), last = rows.at(-1);
  const rate = Object.fromEntries(LINEAR_FIELDS.map((f) => [f, (last[f] - tail[0][f]) / (last.MJD - tail[0].MJD)]));
  for (let mjd = last.MJD + 1; mjd <= lastMjd; ++mjd) {
    const row = Object.assign(new sds.EOPT(), last);
    for (const f of LINEAR_FIELDS) row[f] = last[f] + rate[f] * (mjd - last.MJD);
    row.MJD = mjd;
    row.DATE = new Date((mjd - MJD_UNIX_EPOCH) * DAY_MS).toISOString().slice(0, 19) + 'Z';
    rows.push(row);
  }
  return rows;
}
export function extendedSpaceWeatherRows(lastDate = '2026-08-07') {
  const rows = SPW.rows.map((r) => ({ ...r })), last = rows.at(-1);
  for (let ms = Date.parse(`${last.DATE}T00:00:00Z`) + DAY_MS; ms <= Date.parse(`${lastDate}T00:00:00Z`); ms += DAY_MS)
    rows.push({ ...last, DATE: new Date(ms).toISOString().slice(0, 10) });
  return rows;
}
const EOP_INPUT = { portId: 'earth_orientation', typeRef: TYPE, payload: encodePrw('EARTH_ORIENTATION', makeTable('PRWEarthOrientation', { ROWS: extendedEopRows() })) };
const SPW_INPUT = { portId: 'space_weather', typeRef: TYPE, payload: encodePrw('SPACE_WEATHER', makeTable('PRWSpaceWeatherTable', { ROWS: extendedSpaceWeatherRows().map((row) => makeTable('SPW', row)) })) };
const withExtendedInputs = (inputs) => inputs.map((input) => (input.portId === 'earth_orientation' ? EOP_INPUT : input.portId === 'space_weather' ? SPW_INPUT : input));

// ---- initial conditions (test tooling) ----
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (a) => scale(a, 1 / norm(a));

// Inertial [r, v] (SI) from classical elements (degrees), mu = FFM's.
export function keplerState({ a, e, incDeg, raanDeg = 0, argpDeg = 0, nuDeg = 0 }, mu = MU) {
  const d = Math.PI / 180, nu = nuDeg * d, p = a * (1 - e * e), r = p / (1 + e * Math.cos(nu)), s = Math.sqrt(mu / p);
  const rp = [r * Math.cos(nu), r * Math.sin(nu), 0], vp = [-s * Math.sin(nu), s * (e + Math.cos(nu)), 0];
  const [co, so] = [Math.cos(raanDeg * d), Math.sin(raanDeg * d)], [ci, si] = [Math.cos(incDeg * d), Math.sin(incDeg * d)], [cw, sw] = [Math.cos(argpDeg * d), Math.sin(argpDeg * d)];
  const q = [[co * cw - so * sw * ci, -co * sw - so * cw * ci, so * si], [so * cw + co * sw * ci, -so * sw + co * cw * ci, -co * si], [sw * si, cw * si, ci]];
  const rot = (v) => q.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  return [...rot(rp), ...rot(vp)];
}

// RTN axes of an inertial state (CCSDS: R = r/|r|, N = r x v/|r x v|, T = N x R).
export function rtnAxes(state) {
  const r = state.slice(0, 3), v = state.slice(3, 6), R = unit(r), N = unit(cross(r, v));
  return { R, T: cross(N, R), N };
}

// The deputy: the chief offset by `separationM` along the RTN direction
// `direction` (unit-normalized here), with a speed from equal specific
// energy (two-body, mu) along the chief's velocity direction, so the relative
// orbit is bounded rather than drifting. The full-force truth then perturbs it.
export const OFFSET_DIRECTION_RTN = [0.5, 0.7, 0.5];
export function deputyInitialState(chief, separationM, direction = OFFSET_DIRECTION_RTN, mu = MU) {
  const { R, T, N } = rtnAxes(chief), u = unit(direction);
  const r = add(chief.slice(0, 3), scale(add(add(scale(R, u[0]), scale(T, u[1])), scale(N, u[2])), separationM));
  const speed = Math.sqrt(dot(chief.slice(3), chief.slice(3)) + 2 * mu * (1 / norm(r) - 1 / norm(chief.slice(0, 3))));
  return [...r, ...scale(unit(chief.slice(3, 6)), speed)];
}

// ---- FFM arcs ----
const isoAt = (seconds) => isoOf({ jdDay: EPOCH_JD, seconds });
const impulseTable = ({ seconds, deltaVRtn }) => makeTable('PRWImpulse', {
  EPOCH: isoUtc(isoAt(seconds)),
  DELTA_V: makeTable('FRMVector3', { X: deltaVRtn[0], Y: deltaVRtn[1], Z: deltaVRtn[2] }),
  VECTOR_BASIS: sds.prwSteeringBasis.RTN_AXES,
});
// PRW finite burns come from prwCodec's own builder: a `finiteBurns` entry in
// the parameters of `execution` yields the PRWFiniteBurn table. Edges are
// seconds after the initial epoch of the execution that carries the burn.
const finiteBurnTable = ({ startSeconds, stopSeconds, thrustNewtons, ispSeconds, direction }) =>
  execution({ epochJD: EPOCH_JD, targetJD: EPOCH_JD + 1, position: [7000, 0, 0], velocity: [0, 7.5, 0], massKg: REFERENCE.constants.massKg,
    finiteBurns: [{ startSeconds, stopSeconds, thrustNewtons, ispSeconds, frame: 'RTN', direction }] }).FINITE_BURNS[0];

// One FFM execution from `state` at `startSeconds` after the arc epoch, sampled
// at `times` (strictly later, increasing). `edit` adds maneuvers to the request.
async function execute(ffm, startSeconds, state, times, forces, edit) {
  const c = { ...forces, epochUtc: isoAt(startSeconds), samples: [[0, ...state], ...times.map((t) => [t, 0, 0, 0, 0, 0, 0, isoAt(t)])] };
  const inputs = withExtendedInputs(requestInputs(c, { edit }));
  const response = await ffm.invoke({ methodId: 'invoke', inputs });
  if (response.statusCode !== 0) throw new Error(`FFM arc failed: ${response.errorCode}: ${response.errorMessage}`);
  return decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.SAMPLES.map((s) => {
    const p = s.STATE.STATE.POSITION, v = s.STATE.STATE.VELOCITY;
    return [p.X, p.Y, p.Z, v.X, v.Y, v.Z];
  });
}

// The sampled inertial states [[x, y, z, vx, vy, vz], ...] (SI) of an FFM run
// from `state` at the arc epoch, sampled at `times` (seconds after the epoch,
// increasing, the first > 0). `maneuver` plants FFM's own maneuver on the object:
//   { impulse: { seconds, deltaVRtn: [dR, dT, dN] m/s } }   an FFM-1 impulse, or
//   { finiteBurn: { startSeconds, stopSeconds, thrustNewtons, ispSeconds, direction } }
//   a finite burn with propagated mass, RTN direction.
// A run with a maneuver is three chained FFM executions at sample epochs: the
// coast to the last sample before it, the maneuver window (up to the first
// sample after it), and the coast after; each starts from FFM's own state. (A
// finite burn makes FFM integrate a 7 x 7 STM for every sample from the
// execution's epoch: over 72 h that is hours of CPU, over the window seconds.
// The coast after the burn restarts at the initial mass, 0.03 kg of 1000 off.)
export async function ffmArc(ffm, state, times, { maneuver = null, forces = FULL_FORCE } = {}) {
  if (!maneuver) return execute(ffm, 0, state, times, forces, undefined);
  const burn = maneuver.finiteBurn, start = burn ? burn.startSeconds : maneuver.impulse.seconds, stop = burn ? burn.stopSeconds : maneuver.impulse.seconds;
  const before = times.filter((t) => t < start), within = times.filter((t) => t >= start && t <= stop);
  const afterAt = times.findIndex((t) => t > stop);
  if (afterAt < 0) throw new Error('the arc must continue past the maneuver');
  const window = [...before.slice(-1), ...within, times[afterAt]], first = before.length ? before.at(-1) : 0;
  const out = before.length ? await execute(ffm, 0, state, before, forces, undefined) : [];
  const windowStart = before.length ? out.at(-1) : state;
  const edit = burn
    ? (exec) => {
      exec.FINITE_BURNS = [finiteBurnTable({ ...burn, startSeconds: burn.startSeconds - first, stopSeconds: burn.stopSeconds - first })];
      exec.INCLUDE_MASS_DYNAMICS = true;
      // The seventh (mass) tolerance is the common scalar tolerance in kg, as prwCodec builds it.
      exec.INTEGRATOR.ABSOLUTE_TOLERANCES = [...exec.INTEGRATOR.ABSOLUTE_TOLERANCES.slice(0, 6), exec.INTEGRATOR.ABSOLUTE_TOLERANCES[0] / 1000];
    }
    : (exec) => { exec.IMPULSES = [impulseTable(maneuver.impulse)]; };
  const mid = await execute(ffm, first, windowStart, window.filter((t) => t > first), forces, edit);
  const lastAt = window.at(-1), tail = times.slice(afterAt + 1);
  const result = [...out, ...mid];
  if (tail.length) result.push(...await execute(ffm, lastAt, result.at(-1), tail, forces, undefined));
  return result;
}

// The propagator the filter calls through the inverted port is ffm-port.mjs's
// answerQueries (one FFM execution per query, STM on request); the filter arcs
// are short enough for the fixtures' own space weather and Earth orientation.
export { answerQueries } from './ffm-port.mjs';
