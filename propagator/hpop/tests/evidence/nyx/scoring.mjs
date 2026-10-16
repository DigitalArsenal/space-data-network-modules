// Shared evidence transport. All difference/STM arithmetic is in
// score-metrics.cpp; all propagation is in the shipped isomorphic HPOP WASM.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs } from '../../lib/orekitCases.mjs';
import { decodePrw, decodeResult, sds } from '../../lib/prwCodec.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const WASM = new URL('../../../dist/isomorphic/module.wasm', import.meta.url);
export const MANIFEST = new URL('../../../plugin-manifest.json', import.meta.url);
export const wasm = fs.readFileSync(WASM);
export const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
export const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const CASES = JSON.parse(fs.readFileSync(new URL('../cases/hpop-reference-cases.json', import.meta.url), 'utf8'));
export const ALL = [
  { id: 'suite', maxStep: 300, label: 'steps <= 300 s (the suite\'s request)' },
  { id: 'steps30', maxStep: 30, label: 'steps <= 30 s' },
  { id: 'finest', maxStep: 10, tolerance: 1e-15, label: 'tolerance 1e-15, steps <= 10 s' },
];

export function reference(g) {
  const c = REFERENCE.cases.find((candidate) => `${candidate.orbit} ${candidate.forces}` === g.id);
  if (!c) throw new Error(`No Orekit reference case for ${g.id}`);
  return c;
}

export function parametersOf(g) {
  const c = CASES.cases.find((candidate) => candidate.id === g.id);
  if (!c) throw new Error(`No exported case for ${g.id}`);
  return [
    ...(c.forces.solarRadiationPressure ? [['SRP_AREA_OVER_MASS', 'srpAreaOverMass']] : []),
    ...(c.forces.drag ? [['DRAG_AREA_OVER_MASS', 'dragAreaOverMass']] : []),
  ];
}

export async function run(g, setting, stm = false) {
  const inputs = requestInputs(reference(g), {
    maxStep: setting.maxStep,
    ...(setting.tolerance ? { tolerance: setting.tolerance } : {}),
    edit: (exec) => {
      if (stm) Object.assign(exec, {
        INCLUDE_STM: true,
        STM_TECHNIQUE: sds.prwDerivativeTechnique.ANALYTIC,
        DENSITY_TREATMENT: sds.prwDensityTreatment.FINITE_DIFFERENCE,
        DYNAMIC_PARAMETERS: parametersOf(g).map(([parameter]) => sds.prwDynamicParameter[parameter]),
      });
    },
  });
  const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
  try {
    const response = await harness.invoke({ methodId: 'invoke', inputs });
    if (response.statusCode !== 0) throw new Error(`${g.id}: ${response.errorCode}: ${response.errorMessage}`);
    return response;
  } finally {
    harness.destroy();
  }
}

// The caller chooses a scratch directory in the worktree. Compiling and
// invoking one helper at a time preserves the evidence lane's CPU limit.
export function buildMetrics(workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const directory = path.resolve(workDir);
  const binary = path.join(directory, 'score-metrics');
  // Lower the parent priority once so both children inherit it. Sandboxes may
  // forbid setpriority; that is a scheduling limitation, not a scoring error.
  try {
    if (os.getPriority(0) < 10) os.setPriority(0, 10);
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.info?.code ?? error.code)) throw error;
  }
  execFileSync('c++', ['-std=c++17', '-O2',
    '-I', path.resolve(here, '../../../src/cpp/include'),
    path.join(here, 'score-metrics.cpp'), '-o', binary,
  ], { cwd: directory, env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'ignore', 'inherit'] });
  return (input) => JSON.parse(execFileSync(binary, [], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 16 << 20,
    cwd: directory, stdio: ['pipe', 'pipe', 'inherit'],
  }));
}

export function scoreResponse(response, g, metrics) {
  const result = decodeResult(response);
  return {
    ...metrics({ mode: 'positions', positions: result.samples.map((sample) => sample.position), scale: 1000, samples: g.samples }),
    steps: result.samples.at(-1).integrationSteps,
  };
}

export function stmDifference(response, g, nyxStm, metrics) {
  const root = decodePrw(response.outputs.find((output) => output.portId === 'response').payload).EXECUTION_RESULT;
  // Exclude unrelated wire fields such as uint64 integration counters: the
  // JSON bridge carries only the matrices needed by the numerical reduction.
  return metrics({ mode: 'stm', samples: root.SAMPLES.map((sample) => ({ STM: sample.STM })), reference: nyxStm, parameters: parametersOf(g) });
}
