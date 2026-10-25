// Requests and scoring for the planetary E2E (tests/planetary.e2e.mjs): PRW execution requests about the Moon and Mars
// built as typed tables, and the comparison of a returned trajectory with NAIF's reconstructed ephemeris. Only
// representation and subtraction happen here; propagation runs in the module.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire, } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { decodePrw, encodePrw, makeTable, nativeInput, sds, TYPE } from './prwCodec.mjs';

export const WASM = new URL('../../dist/isomorphic/module.wasm', import.meta.url);
export const KERNELS = new URL('../fixtures/planetary/', import.meta.url);
export const readKernel = (name) => fs.readFileSync(new URL(name, KERNELS));
export const readTruth = (name) => JSON.parse(fs.readFileSync(new URL(name, KERNELS), 'utf8'));

// NAIF IDs
export const MOON = 301, MARS = 499;

// TDB seconds past J2000 (2000-01-01T12:00:00 TDB) -> ISO8601 with nine decimals on the same scale.
export function isoFromSeconds(seconds) {
  const whole = Math.floor(seconds);
  const nanos = Math.round((seconds - whole) * 1e9);
  const carry = nanos >= 1e9 ? 1 : 0;
  const total = whole + carry, frac = nanos - carry * 1e9;
  const date = new Date(Date.UTC(2000, 0, 1, 12, 0, 0) + total * 1000);
  return `${date.toISOString().slice(0, 19)}.${String(frac).padStart(9, '0')}`;
}
export const instant = (seconds, scale = 'TDB') => makeTable('TIMInstant', {
  TIME_SYSTEM: sds.timingStandard[scale], EPOCH_FORMAT: sds.timEpochRepresentation.ISO8601, ISO8601: isoFromSeconds(seconds) });

const frame = (center) => makeTable('RFMCoordinateSystem', {
  NAME: 'ICRF', AXIS_TYPE: sds.rfmAxisType.ICRF, AXIS_REFERENCE_BODY_ID: center,
  ORIGIN: makeTable('RFMOrigin', { KIND: sds.rfmOriginKind.CELESTIAL_BODY, CELESTIAL_BODY_ID: center }) });
const vec = (v, scale = 1000) => makeTable('FRMVector3', { X: v[0] * scale, Y: v[1] * scale, Z: v[2] * scale });

// state: [x y z vx vy vz] km and km/s about `center`, at `epoch` TDB seconds past J2000.
export function state(center, epoch, s) {
  return makeTable('PRWResidentState', {
    STATE: makeTable('FRMStateVector', { REPRESENTATION: sds.frmStateRepresentation.CARTESIAN, POSITION: vec(s.slice(0, 3)), VELOCITY: vec(s.slice(3, 6)),
      COORDINATE_SYSTEM_NAME: 'ICRF', EPOCH: isoFromSeconds(epoch), EPOCH_TIME_SYSTEM: 'TDB' }),
    COORDINATE_SYSTEM: frame(center) });
}

// One execution request: the state at `epoch` propagated to `epoch + span` with a sample at every entry of `samples`
// (TDB seconds). forces: { gm (km^3/s^2), degree, order, thirdBodies, massKg, areaM2 (the one cross-section both radiation
// pressure and drag use), srp: {cr}, drag: {cd}, gravity, atmosphere, extra }. Each body's field and atmosphere are selected by
// name: GRGM660PRIM for the Moon, MRO120F and MARS_EXPONENTIAL for Mars; `gravity` and `atmosphere` name another (the refusals).
export function request({ center, epoch, initial, target, samples = [], forces, integrator = {} }) {
  const f = forces;
  const force = makeTable('PCFForceModel', {
    GRAVITY_CHOICE: f.gravity ?? (center === MOON ? sds.pcfGravitySelection.GRGM660PRIM : center === MARS ? sds.pcfGravitySelection.MRO120F : sds.pcfGravitySelection.SPHERICAL_HARMONICS),
    ENABLE_POINT_MASS: true, GRAVITATIONAL_PARAMETER: f.gm * 1e9, ENABLE_J2: false,
    MAXIMUM_DEGREE: f.degree, HAS_MAXIMUM_DEGREE: true, MAXIMUM_ORDER: f.order ?? f.degree, HAS_MAXIMUM_ORDER: true,
    ENABLE_THIRD_BODY: (f.thirdBodies ?? []).length > 0, THIRD_BODY_IDS: f.thirdBodies ?? [],
    ENABLE_SRP: !!f.srp, ENABLE_DRAG: !!f.drag, INITIAL_MASS_KG: f.massKg ?? 1000, AREA_M2: f.areaM2 ?? 10,
    REFLECTIVITY_COEFFICIENT: f.srp?.cr ?? 1.3, DRAG_COEFFICIENT: f.drag?.cd ?? 2.2,
    ATMOSPHERE_MODEL: f.atmosphere ?? (f.drag && center === MARS ? sds.pcfAtmosphereFamily.MARS_EXPONENTIAL : f.drag ? sds.pcfAtmosphereFamily.EXPONENTIAL : sds.pcfAtmosphereFamily.NRLMSISE00),
    EPHEMERIS_SOURCE: 'JPL_SPK', CENTRAL_BODY_NAIF_ID: center, ...(f.extra ?? {}) });
  if (f.maxTesseralDegree !== undefined) { force.MAXIMUM_TESSERAL_DEGREE = f.maxTesseralDegree; force.HAS_MAXIMUM_TESSERAL_DEGREE = true; }
  const tol = integrator.absM ?? 1e-6;
  const settings = makeTable('PCFIntegratorSettings', {
    ALGORITHM: sds.pcfIntegratorAlgorithm[integrator.algorithm ?? 'RK78'], INITIAL_STEP_SECONDS: integrator.initial ?? 20, MINIMUM_STEP_SECONDS: 1e-3,
    MAXIMUM_STEP_SECONDS: integrator.max ?? 120, ABSOLUTE_TOLERANCES: Array(6).fill(tol), RELATIVE_TOLERANCE: integrator.rel ?? 1e-12, MAXIMUM_STEPS: 5_000_000 });
  return makeTable('PRWExecutionRequest', {
    INITIAL: state(center, epoch, initial), TARGET_EPOCH: instant(target), INTEGRATOR: settings, FORCES: force,
    STM_TECHNIQUE: sds.prwDerivativeTechnique.ANALYTIC, DENSITY_TREATMENT: sds.prwDensityTreatment.NEGLECTED,
    SAMPLE_EPOCHS: samples.map((t) => instant(t)) });
}

export const SHC_TYPE = { schemaName: 'SHC.fbs', fileIdentifier: '$SHC', rootTypeName: 'SHC', wireFormat: 'flatbuffer' };
// `field`: the bytes of a $SHC for the gravity_field input.
export const inputs = (exec, kernel, field) => [
  { portId: 'request', typeRef: TYPE, payload: encodePrw('EXECUTION_REQUEST', exec) },
  { portId: 'kernel', typeRef: TYPE, payload: nativeInput(kernel) },
  ...(field ? [{ portId: 'gravity_field', typeRef: SHC_TYPE, payload: field }] : [])];

const harnesses = {};
export async function lane(kind) {
  if (!harnesses[kind]) harnesses[kind] = await createStandaloneHarness(kind, WASM, { surface: kind === 'browser' ? 'direct' : 'command', enableThreads: true });
  return harnesses[kind];
}
export const destroyLanes = async () => { for (const h of Object.values(harnesses)) await h.destroy?.(); };
// Runs a request on a lane; returns { samples: [[x y z vx vy vz] km, km/s ...], final, steps } or { error }.
export async function run(kind, exec, kernel, field) {
  const h = await lane(kind);
  const response = await h.invoke({ methodId: 'invoke', inputs: inputs(exec, kernel, field) });
  if (response.statusCode !== 0) return { error: `${response.errorCode ?? ''}: ${response.errorMessage ?? ''}`, statusCode: response.statusCode };
  const result = decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT;
  const read = (sample) => { const s = sample.STATE.STATE; return [s.POSITION.X, s.POSITION.Y, s.POSITION.Z, s.VELOCITY.X, s.VELOCITY.Y, s.VELOCITY.Z].map((v) => v / 1000); };
  return { final: read(result.FINAL_SAMPLE), samples: result.SAMPLES.map(read), steps: Number(result.FINAL_SAMPLE.ACCEPTED_STEPS), raw: result };
}
export const dist = (a, b) => 1000 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);   // meters

// ---- the gravity_field input ---------------------------------------------------------------------------------------
const ffmRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const requireFfm = createRequire(path.join(ffmRoot, 'package.json'));
let shcBindings;
export async function shc() {
  return shcBindings ??= await import(pathToFileURL(path.join(path.dirname(requireFfm.resolve('spacedatastandards.org/package.json')), 'lib/js/SHC/main.js')));
}
/** The Moon's GRGM660PRIM as a $SHC to degree 660: the pinned PDS table (fetched and verified into PLANETARY_SOURCES, default
 * .sdk-build/planetary-sources, when absent) written by scripts/make-gravity-field-input.mjs. */
export function grgm660primField() {
  const sources = process.env.PLANETARY_SOURCES ?? path.join(ffmRoot, '.sdk-build/planetary-sources');
  const out = path.join(ffmRoot, '.sdk-build/grgm660prim.shc');
  if (!fs.existsSync(out)) {
    execFileSync(process.execPath, [path.join(ffmRoot, 'scripts/fetch-planetary-sources.mjs'), sources, 'grgm660prim'], { stdio: 'inherit' });
    execFileSync(process.execPath, [path.join(ffmRoot, 'scripts/make-gravity-field-input.mjs'), sources, out], { stdio: 'inherit' });
  }
  return new Uint8Array(fs.readFileSync(out));
}
/** A small valid $SHC of the Moon (degree 4, every coefficient C = S = 1e-6 apart from the sectorial/zonal pattern) and the
 * edits that make it invalid, for the refusals. */
export async function smallField(edit = {}) {
  const { SHCT, shcNormalization, shcTideSystem } = await shc();
  const flatbuffers = await import(pathToFileURL(requireFfm.resolve('flatbuffers')));
  const D = [], O = [], C = [], S = [];
  for (let n = 2; n <= 4; ++n) for (let m = 0; m <= n; ++m) { D.push(n); O.push(m); C.push(1e-6 / n); S.push(m ? 1e-6 / m : 0); }
  const record = Object.assign(new SHCT(), {
    MODEL_NAME: 'GRGM660PRIM', CENTRAL_BODY_NAIF_ID: 301, GM: 4902.7998069317e9, REFERENCE_RADIUS: 1738e3, MAX_DEGREE: 4, MAX_ORDER: 4,
    NORMALIZATION: shcNormalization.FULLY_NORMALIZED, PERMANENT_TIDE_SYSTEM: shcTideSystem.UNSPECIFIED, DEGREES: D, ORDERS: O, C, S, ...edit });
  const builder = new flatbuffers.Builder(4096);
  builder.finish(record.pack(builder), '$SHC');
  return new Uint8Array(builder.asUint8Array());
}
