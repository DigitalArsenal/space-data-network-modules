// Tudat evidence transport. The shared Nyx harness supplies HPOP requests;
// its C++ reducer owns every position/STM calculation and unit conversion.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { requestInputs } from '../../lib/orekitCases.mjs';
import { decodePrw, decodeResult, sds } from '../../lib/prwCodec.mjs';
import { ALL, CASES, WASM, MANIFEST, wasm, manifest, sha256, reference,
  parametersOf as nyxParametersOf, run as runNyx, scoreResponse } from '../nyx/scoring.mjs';

export { ALL, CASES, WASM, MANIFEST, sha256, reference, scoreResponse };
export const here = path.dirname(fileURLToPath(import.meta.url));
export const exportPath = path.resolve(here, '../cases/hpop-reference-cases.json');
export const wasmFixturePath = path.resolve(here, '../../fixtures/tudat/tudat-wasm-reference.json');
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
export const pin = (file) => ({ path: path.relative(here, path.resolve(file)), sha256: sha256(file) });

// Preserve the shared Cd/Cr columns and add every sensitivity explicitly
// requested by the neutral export. The native record names columns by their
// physical parameter, so its storage order need not match the PRW matrix.
export function parametersOfExtended(source) {
  const exported = CASES.cases.find((candidate) => candidate.id === source.id);
  if (!exported) throw new Error(`No exported case for ${source.id}`);
  const keys = {
    SRP_AREA_OVER_MASS: 'srpAreaOverMass',
    DRAG_AREA_OVER_MASS: 'dragAreaOverMass',
    DRAG_AREA_OVER_MASS_RATE: 'dragAreaOverMassRate',
    IN_TRACK_ACCELERATION: 'inTrackAcceleration',
  };
  const parameters = new Map(nyxParametersOf(source));
  for (const parameter of exported.sensitivities?.parameters ?? []) {
    if (!keys[parameter] || sds.prwDynamicParameter[parameter] === undefined)
      throw new Error(`${source.id}: unsupported exported sensitivity ${parameter}`);
    parameters.set(parameter, keys[parameter]);
  }
  return [...parameters.entries()];
}

export async function run(source, setting, stm = false) {
  if (!stm) return runNyx(source, setting);
  const inputs = requestInputs(reference(source), {
    maxStep: setting.maxStep,
    ...(setting.tolerance ? { tolerance: setting.tolerance } : {}),
    edit: (execution) => Object.assign(execution, {
      INCLUDE_STM: true,
      STM_TECHNIQUE: sds.prwDerivativeTechnique.ANALYTIC,
      DENSITY_TREATMENT: sds.prwDensityTreatment.FINITE_DIFFERENCE,
      DYNAMIC_PARAMETERS: parametersOfExtended(source).map(([parameter]) => sds.prwDynamicParameter[parameter]),
    }),
  });
  const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  try {
    const response = await harness.invoke({ methodId: 'invoke', inputs });
    if (response.statusCode !== 0) throw new Error(`${source.id}: ${response.errorCode}: ${response.errorMessage}`);
    return response;
  } finally { harness.destroy(); }
}

// Capture compiler/helper diagnostics so the E2E has one clean stdout report,
// including on failure. No machine-global Emscripten or WASM rebuild occurs.
export function buildMetrics(workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const directory = path.resolve(workDir);
  const binary = path.join(directory, 'score-metrics');
  try { if (os.getPriority(0) < 10) os.setPriority(0, 10); } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.info?.code ?? error.code)) throw error;
  }
  const options = { cwd: directory, env: { ...process.env, TMPDIR: directory, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] };
  execFileSync('c++', ['-std=c++17', '-O2', '-I', path.resolve(here, '../../../src/cpp/include'),
    path.resolve(here, '../nyx/score-metrics.cpp'), '-o', binary], options);
  return (input) => JSON.parse(execFileSync(binary, [], {
    ...options, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 << 20,
  }));
}

export function normalizedRecord(file, wasm = false) {
  const document = readJson(file);
  const cases = document.cases.map((source) => {
    const id = source.id ?? `${source.orbit} ${source.forces}`;
    const exported = CASES.cases.find((candidate) => candidate.id === id);
    if (!exported) throw new Error(`Tudat source contains unknown case: ${id}`);
    return { ...source, id, orbit: exported.orbit, forceSet: exported.forceSet, row: exported.row, toleranceClass: exported.toleranceClass,
      ...(wasm ? { stmSkipped: 'The committed Tudat WASM fixture contains state trajectories only; its C++ driver did not save variational equations or sensitivity columns.' } : {}) };
  });
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('Duplicate Tudat source case');
  if (!wasm) return { ...document, cases };
  const covered = new Set(cases.map((c) => c.id));
  return {
    ...document,
    tool: { name: 'Tudat C++ library compiled to WebAssembly', version: '1.0.0.dev4', packageCommit: '1d4718f', emscripten: '3.1.51',
      execution: 'Committed C++ driver trajectory; the package Embind API cannot configure/run propagation (duplicate registrations, station-file initialization, missing STL/Eigen bindings). No Tudat rebuild or rerun was performed.',
      fixtureSha256: sha256(file) },
    settings: { integrator: 'RKDP 8(7)', fixedStepS: 10, radiationPressureFixedStepS: 1, clock: 'TT', frame: 'GCRS about Earth',
      source: document.source, coveredCaseIds: cases.map((c) => c.id),
      convergence: 'Historical 27-case fixture; the existing cross-validation document records step-halving evidence. This task scores committed samples without rebuilding Tudat WASM.',
      coverage: { requestedCount: 28, actualCount: cases.length,
        note: 'The task context calls this a 28-case subset, but the committed Tudat WASM fixture contains 27 cases. Only those stored trajectories are scored; no missing trajectory is inferred.' } },
    cases,
    skipped: CASES.cases.filter((c) => !covered.has(c.id)).map((c) => ({ id: c.id,
      reason: 'Outside the committed 27-case Tudat WASM xval subset (the task context calls it 28); no stored trajectory exists for this exported case, and this task does not rebuild or rerun that package.' })),
  };
}

export function propagationIdentity() {
  return [fileURLToPath(WASM), fileURLToPath(MANIFEST), exportPath,
    path.resolve(here, '../../lib/orekitCases.mjs'), path.resolve(here, '../../lib/prwCodec.mjs'),
    path.resolve(here, '../nyx/scoring.mjs'), path.resolve(here, '../../fixtures/orekit/orekit-reference.json'),
    path.resolve(here, '../../fixtures/orekit/eop-2026-08.json'), path.resolve(here, '../../fixtures/orekit/eop-2026-06.json'),
    path.resolve(here, '../../fixtures/orekit/jb2008-2026-06.json'), path.resolve(here, '../../fixtures/orekit/spw-2026-08.json'),
    path.resolve(here, '../../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp')].map(pin);
}

export function readCache(file) {
  const identity = propagationIdentity();
  if (!fs.existsSync(file)) return { note: 'Shipped HPOP WASM results; positions are km, STM values use the PRW SI column convention. All numerical reduction uses the shared C++ helper.', identity, cases: [] };
  const cache = readJson(file);
  if (JSON.stringify(cache.identity) !== JSON.stringify(identity)) throw new Error(`HPOP cache input hash mismatch: ${file}`);
  return cache;
}

export function storedResponse(response, matrices = false) {
  const result = decodeResult(response);
  const record = { positions: result.samples.map((sample) => sample.position), steps: result.samples.at(-1).integrationSteps };
  if (matrices) {
    const root = decodePrw(response.outputs.find((output) => output.portId === 'response').payload).EXECUTION_RESULT;
    record.samples = root.SAMPLES.map((sample) => ({ STM: sample.STM }));
  }
  return record;
}

export function scoreStored(stored, source, metrics) {
  return { ...metrics({ mode: 'positions', positions: stored.positions, scale: 1000, samples: source.samples }), steps: stored.steps };
}
export function scoreOrekit(source, metrics) {
  return metrics({ mode: 'positions', positions: reference(source).samples.slice(1).map((sample) => sample.slice(1, 4)), scale: 1, samples: source.samples });
}
export function scoreConvergence(source, fine, metrics) {
  return metrics({ mode: 'positions', positions: source.samples.slice(1).map((sample) => sample.slice(1, 4)), scale: 1, samples: fine.samples });
}
export function scoreStm(stored, source, stm, metrics) {
  return metrics({ mode: 'stm', samples: stored.samples, reference: stm.stm, parameters: parametersOfExtended(source) });
}

export function stmLimitation(source, measurement, inputFiles) {
  const exported = CASES.cases.find((candidate) => candidate.id === source.id);
  if (!exported?.forces.solarRadiationPressure) return undefined;
  const sources = ['radiationPressureAccelerationPartial.h', 'createAccelerationPartials.h'].map((name) => {
    const pinned = inputFiles?.find((entry) => path.basename(entry.path) === name);
    if (!pinned) throw new Error(`${source.id}: missing Tudat SRP-partial source pin ${name}`);
    return { ...pinned, symbol: name === 'radiationPressureAccelerationPartial.h'
      ? 'CannonBallRadiationPressurePartial::update' : 'createRadiationPressureAccelerationPartial' };
  });
  return {
    classification: 'Tudat defect',
    statement: 'The native cannonball SRP position partial omits the position derivative of eclipse attenuation. The modern radiation_pressure factory dispatches this partial for the isotropic point source and cannonball target used here. The omission affects paths that encounter an eclipse transition; this record does not establish that this case encounters one. These measured whole-arc column differences do not isolate the eclipse-gradient contribution.',
    evidence: { worstRelativeColumnDifference: measurement.worst, atHour: measurement.atHour,
      parameters: measurement.parameters ?? {}, sources },
  };
}

export function causePresent(cause) {
  return cause && ['model-setting mismatch', 'Tudat defect', 'HPOP defect'].includes(cause.classification)
    && typeof cause.statement === 'string' && cause.statement.trim().length > 0
    && cause.evidence && typeof cause.evidence === 'object' && Object.keys(cause.evidence).length > 0;
}

export function protocolFor(rows, wasm = false) {
  const cases = rows.map((row) => CASES.cases.find((candidate) => candidate.id === row.id));
  if (cases.some((entry) => !entry)) throw new Error('Protocol metadata contains a case outside the shared export');
  return {
    source: { path: '../cases/hpop-reference-cases.json', section: 'protocol', sha256: sha256(exportPath) },
    units: { position: 'm', velocity: 'm/s', stm: 'maximum relative column difference; position and velocity rows compared separately',
      parameterColumns: 'per unit Cr*A/m, Cd*A/m, Cd*A/m rate, or in-track acceleration, as named in the shared export' },
    frames: [...new Set(cases.map((entry) => entry.frame))],
    frameRule: 'Geocentric GCRF, or EME2000 for cases explicitly exported in EME2000; compared states use the same axes.',
    epochTimeScale: 'UTC', epochsUtc: [...new Set(cases.map((entry) => entry.epochUtc))],
    arcS: CASES.protocol.arcS, sampleStepS: CASES.protocol.sampleStepS, sampleCountIncludingInitial: CASES.protocol.samples,
    dynamicsClock: 'TT', ephemerisClock: 'TDB',
    rotationClock: wasm ? 'Historical fixture passes TT into Tudat rotation lookup interpreted as TDB, as documented in cross-validation.md.' : 'Native rotation explicitly configured to use TT.',
    metric: 'Maximum 3D position separation over the 24 propagated hourly samples; the common initial state is stored but excluded from reduction.',
    tolerancesM: CASES.protocol.tolerancesM.default,
    toleranceRationale: 'The unchanged shared protocol requires 1 mm point-mass numerical agreement, 5 cm gravity-field/rotation agreement, and 0.1 m SRP/drag agreement. These are separate prescribed precision classes; a measured discrepancy never changes its limit. The GMAT-only 1.5 m drag allowance does not apply to Tudat.',
    nativeConvergenceLimitM: 0.0003,
    convergenceRationale: 'A 2x finer native run must change every reported trajectory by less than 0.3 mm, below the strictest 1 mm physical comparison limit.',
    replayTolerance: 0,
    replayRationale: 'Identical stored state bytes and the same C++ reducer must reproduce the summary exactly; the one propagated replay also uses identical shipped HPOP WASM and request settings.',
    verdictSetting: 'suite', stmTolerance: null,
    stmToleranceRationale: 'The shared protocol defines the relative-column metric without an STM pass threshold; report the measurements and known partial-model limitations.',
  };
}

export function verdictFor(rows, skipped, tool) {
  const missed = rows.filter((row) => !row.met);
  return {
    tool: { version: tool.version ?? tool.tudatpy, total: rows.length, met: rows.filter((row) => row.met).length,
      missed: missed.length, diagnosed: missed.filter((row) => causePresent(row.cause)).length,
      statement: 'Counts apply to the HPOP suite request and unchanged shared protocol tolerances. Each missed limit requires a measured cause; smaller HPOP steps are reported separately.' },
    coverage: { exported: CASES.cases.length, scored: rows.length, skipped: skipped.length },
    integration: { limitM: 0.0003, checked: rows.filter((row) => row.convergence).length,
      met: rows.filter((row) => row.convergence?.met).length,
      statement: 'Native convergence is the measured 3D position change when Tudat fixed steps are halved; the committed WASM subset retains its historical convergence provenance.' },
    stm: { compared: rows.filter((row) => row.stm).length,
      omitted: rows.filter((row) => row.stmSkipped).length,
      eclipseGradientLimitationCases: rows.filter((row) => row.stm?.limitation).length,
      statement: 'STM and Cd*A/m, Cr*A/m, Cd*A/m-rate, and in-track-acceleration sensitivity agreement is reported as maximum relative column difference, separately for position and velocity rows. Native aerodynamic state partials use central finite differences at 10 m position and 0.01 m/s velocity perturbations, also used by the time-varying-drag adapter. The native cannonball SRP partial omits the eclipse-attenuation position gradient; its effect is conditional on encountering eclipse transitions, not every SRP case. R2 STM omissions record unavailable native non-Schwarzschild partials. Every exported sensitivity is included where its variational case is supported; the shared export defines no STM pass/fail threshold.' },
  };
}
