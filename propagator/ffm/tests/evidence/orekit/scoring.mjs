// File and ABI transport only; score-metrics.cpp owns numerical reductions.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodePrw, decodeResult } from '../../lib/prwCodec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export function buildMetrics(work) {
  const binary = path.join(work, 'score-metrics');
  execFileSync('c++', ['-std=c++17', '-O2', '-I', path.resolve(here, '../../../src/cpp/include'), path.join(here, 'score-metrics.cpp'), '-o', binary],
    { cwd: work, env: { ...process.env, TMPDIR: work }, stdio: ['ignore', 'pipe', 'pipe'] });
  return (input) => JSON.parse(execFileSync(binary, [], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 16 << 20, cwd: work }));
}
export function scoreResponse(c, response, metrics, jacobians = false) {
  const result = decodeResult(response);
  const matrices = jacobians ? decodePrw(response.outputs.find((o) => o.portId === 'response').payload).EXECUTION_RESULT.SAMPLES.map((s) => s.STM) : undefined;
  return { ...metrics({ mode: 'score', reference: c, samples: result.samples.map((s) => ({ position: s.position })), jacobians, matrices }), steps: result.samples.at(-1).integrationSteps };
}
