// The $DCL (Density Calibration) wire of analysis/density-calibration for the tests.
//
// The SDS standard's generated TypeScript bindings (spacedatastandards.org lib/ts/DCL, with the tables of the standards
// it includes) are bundled in memory by the standards repo's own esbuild. `encodeRequest` builds a method's $DCL request
// from the inputs a test states in its own units (UTC MJD, metres, the drivers as rows); `call` runs the built artifact
// through the SDK harness and answers with the unpacked $DCL (DCLT).
//
// `legacyRequest` states the same inputs as the JSON request of analysis/density-calibration 0.4.0 with every value as
// the typed module reads it (times through Unix milliseconds or ISO 8601, positions through km, F10.7 through $SPW's
// float), so that the two artifacts can be compared bit for bit (tests/legacy-parity.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';

export const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT
  ?? fileURLToPath(new URL('../../../../spacedatastandards.org/', import.meta.url));

// Every table and enum of lib/ts/<code> (the standard and the standards it includes) as one ES module, with flatbuffers.
export async function loadStandard(code) {
  const dir = path.join(STANDARDS_ROOT, 'lib', 'ts', code);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'main.ts');
  const esbuild = createRequire(path.join(STANDARDS_ROOT, 'package.json'))('esbuild');
  const built = await esbuild.build({
    stdin: {
      contents: `${files.map((f) => `export * from "./lib/ts/${code}/${f}";`).join('\n')}\nexport * as flatbuffers from "flatbuffers";`,
      resolveDir: STANDARDS_ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}
export const S = await loadStandard('DCL');
export const DCL_TYPE = { schemaName: 'DCL.fbs', fileIdentifier: '$DCL', rootTypeName: 'DCL', wireFormat: 'flatbuffer' };

const wasmPath = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const manifestPath = new URL('../plugin-manifest.json', import.meta.url);

// ── Time ──
// Unix milliseconds of a UTC MJD, and the MJD the module reads from them: (ms + 40587 * 86400000) / 86400000.
export const msOfMjd = (mjd) => Math.round((mjd - 40587) * 86400000);
export const mjdOfMs = (ms) => (Number(ms) + 3506716800000) / 86400000;
// ISO 8601 UTC with microseconds, and the MJD the module reads from it: the day's MJD + (h 3600 + m 60 + s) / 86400.
export function isoOfMjd(mjd) {
  const us = Math.round((mjd - 40587) * 86400e6);
  const ms = Math.floor(us / 1000);
  return `${new Date(ms).toISOString().slice(0, 23)}${String(us - ms * 1000).padStart(3, '0')}Z`;
}
export function mjdOfIso(text) {
  const m = /^(\d+)-(\d+)-(\d+)[T ](\d+):(\d+):([0-9.]+)/.exec(text);
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 + 40587;
  return day + (Number(m[4]) * 3600 + Number(m[5]) * 60 + parseFloat(m[6])) / 86400;
}
const dayOfMjd = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);
export { dayOfMjd };

const T = (name, fields) => Object.assign(new S[`${name}T`](), fields);
const big = (xs) => xs.map((x) => BigInt(x));
const JB_KEYS = ['DATE', 'F10', 'F10_CENTRED_81', 'S10', 'S10_CENTRED_81', 'M10', 'M10_CENTRED_81', 'Y10', 'Y10_CENTRED_81', 'DTC_HOURLY_K'];

// Builds the $DCL request of `method` from a test's inputs (the field names of the 0.4.0 JSON requests, so that the
// tests read as before): returns { dcl: DCLT, legacy: the same values as module 0.4.0 JSON }.
export function encodeRequest(method, req) {
  const dcl = T('DCL', {});
  const legacy = {};
  const settings = T('dclSettings', {});
  dcl.SETTINGS = settings;
  if (req.atmosphere === 'NRLMSISE00') {
    dcl.ATMOSPHERE = T('ATM', { MODEL: S.AtmosphericModelFamily.NRLMSIS00E, YEAR: 2000 });
    legacy.atmosphere = 'NRLMSISE00';
  } else if (req.atmosphere !== undefined && req.atmosphere !== 'JB2008') {
    dcl.ATMOSPHERE = T('ATM', { MODEL: S.AtmosphericModelFamily[req.atmosphere] ?? S.AtmosphericModelFamily.MSIS_86 });
    legacy.atmosphere = req.atmosphere;
  }
  if (req.jb2008) {
    dcl.JB2008_DRIVERS = T('PRWJB2008IndicesTable', { ROWS: req.jb2008.rows.map((r) => T('PRWJB2008Indices', Object.fromEntries(JB_KEYS.map((k) => [k, r[k]])))) });
    legacy.jb2008 = { rows: req.jb2008.rows.map((r) => Object.fromEntries(JB_KEYS.map((k) => [k, r[k]]))) };
  }
  if (req.nrlmsise00) {
    dcl.SPACE_WEATHER = req.nrlmsise00.rows.map((r) => T('SPW', { DATE: r.DATE, F107_OBS: r.F107_OBS, F107_OBS_CENTER81: r.F107_OBS_CENTER81, AP_AVG: r.AP_AVG }));
    legacy.nrlmsise00 = { rows: req.nrlmsise00.rows.map((r) => ({ DATE: r.DATE, F107_OBS: Math.fround(r.F107_OBS), F107_OBS_CENTER81: Math.fround(r.F107_OBS_CENTER81), AP_AVG: Math.trunc(r.AP_AVG) })) };
  }
  if (req.correction) {
    const c = req.correction;
    if (c.nodesMjd) {
      const ms = c.nodesMjd.map(msOfMjd);
      dcl.CORRECTION = T('dclCorrection', { FORM: S.dclCorrectionForm.Nodes, NODE_TIMES_MS: big(ms), NODE_ALTITUDES_KM: c.altitudeKm ?? [], NODE_VALUES_K: c.values.flat() });
      legacy.correction = { nodesMjd: ms.map(mjdOfMs), altitudeKm: c.altitudeKm ?? [], values: c.values };
    } else {
      const segs = c.segments.map((s) => ({ from: msOfMjd(s.fromMjd), to: msOfMjd(s.toMjd), c: s.coefficients }));
      dcl.CORRECTION = T('dclCorrection', { FORM: S.dclCorrectionForm.Harmonic, DEGREE: c.degree,
        SEGMENTS: segs.map((s) => T('dclHarmonicSegment', { FROM_MS: BigInt(s.from), TO_MS: BigInt(s.to), COEFFICIENTS_K: s.c })) });
      legacy.correction = { degree: c.degree, segments: segs.map((s) => ({ fromMjd: mjdOfMs(s.from), toMjd: mjdOfMs(s.to), coefficients: s.c })) };
    }
  }
  if (req.points) {
    const p = req.points, ms = p.mjd.map(msOfMjd);
    dcl.POINTS = T('dclPoints', { TIME_MS: big(ms), LATITUDE_DEG: p.latDeg, LONGITUDE_DEG: p.lonDeg, ALTITUDE_KM: p.altKm,
      OBSERVED_DENSITY_KG_M3: p.rho ?? [], WEIGHT: p.weight ?? [] });
    legacy.points = { mjd: ms.map(mjdOfMs), latDeg: p.latDeg, lonDeg: p.lonDeg, altKm: p.altKm, ...(p.rho ? { rho: p.rho } : {}), ...(p.weight ? { weight: p.weight } : {}) };
  }
  if (req.raw) {
    const deg = 180 / Math.PI, rad = Math.PI / 180;
    const ms = req.raw.map((r) => msOfMjd(r.mjd));
    const col = (k) => req.raw.map((r) => r[k] * deg);
    dcl.POINTS = T('dclPoints', { TIME_MS: big(ms), LATITUDE_DEG: col('latRad'), LONGITUDE_DEG: col('lonRad'), ALTITUDE_KM: req.raw.map((r) => r.altKm),
      SUN_RIGHT_ASCENSION_DEG: col('sunRaRad'), SUN_DECLINATION_DEG: col('sunDecRad'), MODEL_DRIVERS: req.raw.flatMap((r) => r.inputs),
      OBSERVED_DENSITY_KG_M3: req.raw.some((r) => r.rho !== undefined) ? req.raw.map((r) => r.rho ?? 0) : [] });
    legacy.raw = req.raw.map((r, i) => ({ mjd: mjdOfMs(ms[i]), sunRaRad: r.sunRaRad * deg * rad, sunDecRad: r.sunDecRad * deg * rad, lonRad: r.lonRad * deg * rad,
      latRad: r.latRad * deg * rad, altKm: r.altKm, inputs: r.inputs, ...(r.rho !== undefined ? { rho: r.rho } : {}) }));
  }
  if (req.derivative) { settings.WANT_DERIVATIVE = true; legacy.derivative = true; }
  if (req.diagnostics) { settings.WANT_SUN_DIAGNOSTICS = true; legacy.diagnostics = true; }
  // calibrate
  if (req.degree !== undefined && method === 'calibrate') { settings.DEGREE = req.degree; legacy.degree = req.degree; }
  if (req.binHours !== undefined) { settings.BIN_S = req.binHours * 3600; legacy.binHours = settings.BIN_S / 3600; }
  if (req.fromMjd !== undefined) { settings.FROM_MS = BigInt(msOfMjd(req.fromMjd)); legacy.fromMjd = mjdOfMs(settings.FROM_MS); }
  if (req.toMjd !== undefined) { settings.TO_MS = BigInt(msOfMjd(req.toMjd)); legacy.toMjd = mjdOfMs(settings.TO_MS); }
  if (req.logSigma !== undefined) { settings.LOG_DENSITY_SIGMA = req.logSigma; legacy.logSigma = req.logSigma; }
  if (req.priorSigmaK !== undefined) { settings.PRIOR_SIGMA_K = req.priorSigmaK; legacy.priorSigmaK = req.priorSigmaK; }
  if (req.minPoints !== undefined) { settings.MIN_POINTS = req.minPoints; legacy.minPoints = req.minPoints; }
  if (req.iterations !== undefined) { settings.MAX_ITERATIONS = req.iterations; legacy.iterations = req.iterations; }
  // EDIT_SIGMA 0 is the default (4); no editing is a negative value.
  if (req.editSigma !== undefined) { settings.EDIT_SIGMA = req.editSigma === 0 ? -1 : req.editSigma; legacy.editSigma = req.editSigma; }
  // decay and calibrate_decay
  if (req.stepSeconds !== undefined) { settings.STEP_S = req.stepSeconds; legacy.stepSeconds = req.stepSeconds; }
  if (req.maxGapDays !== undefined) { settings.MAX_GAP_S = req.maxGapDays * 86400; legacy.maxGapDays = settings.MAX_GAP_S / 86400; }
  if (req.samples) { settings.WANT_SAMPLES = true; legacy.samples = true; }
  if (req.residuals) { settings.WANT_RESIDUALS = true; legacy.residuals = true; }
  if (req.nodes) {
    const n = req.nodes;
    settings.FROM_MS = BigInt(msOfMjd(n.fromMjd));
    settings.TO_MS = BigInt(msOfMjd(n.toMjd));
    settings.NODE_STEP_S = (n.stepHours ?? 6) * 3600;
    settings.NODE_ALTITUDES_KM = n.altitudeKm ?? [];
    legacy.nodes = { fromMjd: mjdOfMs(settings.FROM_MS), toMjd: mjdOfMs(settings.TO_MS), stepHours: settings.NODE_STEP_S / 3600, altitudeKm: n.altitudeKm ?? [] };
  }
  if (req.priors) {
    settings.RANDOM_WALK_K_PER_SQRT_DAY = req.priors.randomWalkKPerSqrtDay ?? 0;
    settings.MEAN_LEVEL_K = req.priors.meanLevelK ?? 0;
    settings.ALTITUDE_DIFFERENCE_K = req.priors.altitudeDifferenceK ?? 0;
    legacy.priors = { ...req.priors };
  }
  if (req.sigmaFloorM !== undefined) { settings.RESIDUAL_FLOOR_M = req.sigmaFloorM; legacy.sigmaFloorM = req.sigmaFloorM; }
  if (req.reweightIterations !== undefined) { settings.REWEIGHT_ITERATIONS = req.reweightIterations; legacy.reweightIterations = req.reweightIterations; }
  if (req.minSets !== undefined) { settings.MIN_SETS = req.minSets; legacy.minSets = req.minSets; }
  if (req.tolerance) {
    settings.TOLERANCE_K = req.tolerance.K ?? 0; settings.TOLERANCE_LN_B = req.tolerance.lnB ?? 0; settings.TOLERANCE_OFFSET_M = req.tolerance.a0M ?? 0;
    legacy.tolerance = { ...req.tolerance };
  }
  if (req.objects) {
    dcl.OBJECTS = [];
    legacy.objects = [];
    for (const o of req.objects) {
      const sets = o.sets.map((s) => ({ ...s, EPOCH: isoOfMjd(s.mjd) }));
      dcl.OBJECTS.push(T('dclObject', {
        ID: o.id ?? '',
        ELEMENT_SETS: sets.map((s) => T('OMM', { EPOCH: s.EPOCH, MEAN_MOTION: s.MEAN_MOTION, ECCENTRICITY: s.ECCENTRICITY, INCLINATION: s.INCLINATION,
          RA_OF_ASC_NODE: s.RA_OF_ASC_NODE, ARG_OF_PERICENTER: s.ARG_OF_PERICENTER, MEAN_ANOMALY: s.MEAN_ANOMALY, BSTAR: s.BSTAR })),
        BALLISTIC_COEFFICIENT_M2_KG: o.B ?? 0,
        SPAN_S: (o.spanDays ?? 0) * 86400,
        LN_B_PRIOR_MEAN: o.lnBPrior?.mean ?? 0,
        LN_B_PRIOR_SIGMA: o.lnBPrior?.sigma ?? 0,
      }));
      legacy.objects.push({ id: o.id ?? '', ...(o.B !== undefined ? { B: o.B } : {}), ...(o.spanDays !== undefined ? { spanDays: (o.spanDays * 86400) / 86400 } : {}),
        ...(o.lnBPrior ? { lnBPrior: o.lnBPrior } : {}),
        sets: sets.map((s) => ({ mjd: mjdOfIso(s.EPOCH), MEAN_MOTION: s.MEAN_MOTION, ECCENTRICITY: s.ECCENTRICITY, INCLINATION: s.INCLINATION,
          RA_OF_ASC_NODE: s.RA_OF_ASC_NODE, ARG_OF_PERICENTER: s.ARG_OF_PERICENTER, MEAN_ANOMALY: s.MEAN_ANOMALY, BSTAR: s.BSTAR })) });
    }
  }
  // energy and drag_work
  if (req.states) {
    const lines = req.states.map((s) => T('ephemerisDataLine', { EPOCH: isoOfMjd(s.mjd), X: s.r[0] / 1000, Y: s.r[1] / 1000, Z: s.r[2] / 1000,
      X_DOT: s.v[0] / 1000, Y_DOT: s.v[1] / 1000, Z_DOT: s.v[2] / 1000 }));
    const has = (k) => req.states.some((s) => s[k] !== undefined);
    dcl.STATES = T('dclStates', { EPHEMERIS: T('ephemerisDataBlock', { EPHEMERIS_DATA_LINES: lines }),
      DUT1_S: has('dut1') ? req.states.map((s) => s.dut1 ?? 0) : [], POLAR_MOTION_X_ARCSEC: has('xp') ? req.states.map((s) => s.xp ?? 0) : [],
      POLAR_MOTION_Y_ARCSEC: has('yp') ? req.states.map((s) => s.yp ?? 0) : [] });
    legacy.states = lines.map((l, i) => ({ mjd: mjdOfIso(l.EPOCH), r: [l.X * 1000, l.Y * 1000, l.Z * 1000], v: [l.X_DOT * 1000, l.Y_DOT * 1000, l.Z_DOT * 1000],
      ...(req.states[i].dut1 !== undefined ? { dut1: req.states[i].dut1 } : {}), ...(req.states[i].xp !== undefined ? { xp: req.states[i].xp } : {}),
      ...(req.states[i].yp !== undefined ? { yp: req.states[i].yp } : {}) }));
  }
  if (method === 'energy') {
    if (req.degree !== undefined) { dcl.GRAVITY_DEGREE = req.degree; legacy.degree = req.degree; }
    if (req.order !== undefined) { dcl.GRAVITY_ORDER = req.order; legacy.order = req.order; }
    if (req.gm !== undefined) { dcl.GM_M3_S2 = req.gm; legacy.gm = req.gm; }
    if (req.gradient) { settings.WANT_GRADIENT = true; legacy.gradient = true; }
  }
  if (req.omega !== undefined) { dcl.EARTH_ROTATION_RAD_S = req.omega; legacy.omega = req.omega; }
  if (method === 'drag_work' && req.B !== undefined) { dcl.BALLISTIC_COEFFICIENT_M2_KG = req.B; legacy.B = req.B; }
  return { dcl, legacy };
}

export function encodeDcl(dclT) {
  const b = new S.flatbuffers.Builder(1 << 16);
  S.DCL.finishDCLBuffer(b, dclT.pack(b));
  return b.asUint8Array().slice();
}
export function decodeDcl(bytes) {
  const bb = new S.flatbuffers.ByteBuffer(new Uint8Array(bytes));
  if (!S.DCL.bufferHasIdentifier(bb)) throw new Error('the answer is not a $DCL');
  return S.DCL.getRootAsDCL(bb).unpack();
}

// The method through the built artifact: the $DCL answer, unpacked; a refusal throws `code: message`.
export async function call(method, req) {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), surface: 'direct' });
  try {
    const payload = encodeDcl(encodeRequest(method, req).dcl);
    const r = await harness.invoke({ methodId: method, inputs: [{ portId: 'request', payload, typeRef: DCL_TYPE }] });
    if (r.statusCode !== 0) throw new Error(`${r.errorCode}: ${r.errorMessage}`);
    if (r.outputs.length !== 1) throw new Error(`${r.outputs.length} outputs`);
    return decodeDcl(r.outputs[0].payload);
  } finally {
    await harness.destroy();
  }
}
