// Known answer: com.orbpro.hpop 1.1.0, the identity authored in
// plugin-manifest.json (sdk_compat.test.mjs proves the artifact embeds exactly
// that manifest as its $PLG). A PRW VERSION_QUERY sent to the BUILT
// dist/isomorphic/module.wasm must answer with that identity on every runtime:
// real headless Chrome, native WasmEdge and, when the Docker daemon is up, the
// pinned Docker WasmEdge image (the SDK's parity lanes), byte for byte alike.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import { defaultParityLaneRunners, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { TYPE, encodePrw, decodePrw } from './lib/prwCodec.mjs';

const EXPECTED = { MODULE_ID: 'com.orbpro.hpop', VERSION: '1.1.0' };
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));

function dockerUp() {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('PRW VERSION_QUERY answers com.orbpro.hpop 1.1.0 on every runtime', async () => {
  const authored = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual({ MODULE_ID: authored.pluginId, VERSION: authored.version }, EXPECTED);
  const lanes = ['browser', 'wasmedge', ...(dockerUp() ? ['docker-wasmedge'] : [])];
  const stdout = {};
  const laneRunners = Object.fromEntries(lanes.map((lane) => [lane, async (context) => {
    const runs = await defaultParityLaneRunners[lane](context);
    stdout[lane] = runs.map((run) => Buffer.from(run.stdout));
    return runs;
  }]));
  const plan = await normalizeParityFixture({
    name: 'hpop PRW VERSION_QUERY identity',
    threadCounts: [1],
    cases: [{
      id: 'version-query',
      request: {
        methodId: 'invoke',
        inputs: [{ portId: 'request', typeRef: TYPE, payloadHex: Buffer.from(encodePrw('VERSION_QUERY', true)).toString('hex') }],
      },
    }],
  });
  const report = await runParityHarness({ wasmPath, plan, lanes, laneRunners, timeoutMs: 60000 });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  for (const lane of lanes) {
    assert.equal(stdout[lane].length, 1, `${lane}: one run`);
    const response = decodePluginInvokeResponse(stdout[lane][0]);
    assert.equal(response.statusCode, 0, `${lane}: ${response.errorMessage}`);
    const { VERSION_RESULT } = decodePrw(response.outputs[0].payload);
    assert.deepEqual({ MODULE_ID: VERSION_RESULT.MODULE_ID, VERSION: VERSION_RESULT.VERSION }, EXPECTED, lane);
  }
});
