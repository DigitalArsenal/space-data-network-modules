// One E2E: published oracle -> SDS -> browser/WasmEdge module -> typed samples.
// Numerical differences below are conformance metrics, never production physics.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {loadModule} from 'space-data-module-sdk/host/isomorphic';
import {validateArtifactWithStandards} from 'space-data-module-sdk/compliance';
import {encodePluginInvokeRequest, decodePluginInvokeResponse} from 'space-data-module-sdk/invoke';
import {decodeResult} from '../codec.js';
import {exercise} from './exercise.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = path.join(root, '.build');
fs.mkdirSync(scratch, {recursive: true});
const oracleBytes = fs.readFileSync(new URL('./astropy-oracle.json', import.meta.url));
const oracle = JSON.parse(oracleBytes);
const wasmPath = path.join(root, 'dist/isomorphic/module.wasm');
const wasm = fs.readFileSync(wasmPath);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin-manifest.json')));
const compliance = await validateArtifactWithStandards({manifest, wasmPath,
  requireEmbeddedManifest: true, requireCanonicalAbi: true});
assert(compliance.ok, JSON.stringify(compliance.issues));
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const installed = fs.readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse();
const executablePath = process.env.SDM_CHROME_BINARY ?? installed.map(n =>
  path.join(cache, n, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).find(p => fs.existsSync(p));
assert(executablePath, 'Install the Playwright Chromium headless shell or set SDM_CHROME_BINARY.');
assert.match(fs.realpathSync(executablePath), /\/Library\/Caches\/ms-playwright\/chromium_headless_shell-[^/]+\/.*\/chrome-headless-shell$/);
const bundled = await build({entryPoints: [path.join(root, 'tests/browser-runner.mjs')], bundle: true,
  write: false, format: 'esm', platform: 'browser', target: 'chrome110', external: ['node:*', 'hd-wallet-wasm'], logLevel: 'silent'});
const server = http.createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const routes = {
    '/': ['text/html', '<!doctype html><title>Cosmology E2E</title><script type="module" src="/runner.js"></script>'],
    '/runner.js': ['text/javascript', bundled.outputFiles[0].text],
    '/oracle.json': ['application/json', oracleBytes],
    '/module.wasm': ['application/wasm', wasm],
  };
  const route = routes[request.url];
  if (!route) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', route[0]); response.end(route[1]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, native;
const errors = [];
try {
  browser = await chromium.launch({executablePath, headless: true, args: ['--disable-background-networking']});
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof globalThis.runCosmology === 'function');
  const browserResults = await page.evaluate(() => globalThis.runCosmology());
  assert.deepEqual(errors, [], 'Browser console errors');
  native = await loadModule({wasmSource: wasmPath, runtimeKind: 'wasmedge', surface: 'command',
    wasmEdgeBinary: process.env.WASMEDGE_BIN ?? path.join(os.homedir(), '.wasmedge/bin/wasmedge')});
  const nativeResults = await exercise(native, oracle);
  assert.deepEqual(nativeResults, browserResults, 'Identical input must produce byte-identical PCE outputs and errors');
  const dockerImage = process.env.COSMOLOGY_DOCKER_IMAGE ?? 'space-data-module-sdk/parity-wasmedge:0.16.4';
  const dockerVersion = spawnSync('docker', ['run', '--rm', '--network', 'none', dockerImage, '--version'],
    {encoding: 'utf8', timeout: 30000});
  assert.equal(dockerVersion.status, 0, dockerVersion.stderr);
  const nativeVersion = spawnSync(native.launchPlan.command, ['--version'], {encoding: 'utf8', timeout: 10000});
  assert.equal(nativeVersion.stdout.match(/version ([0-9.]+)/)?.[1],
    dockerVersion.stdout.match(/version ([0-9.]+)/)?.[1], 'Native and Docker WasmEdge versions must match');
  let containerIndex = 0;
  const container = {async invoke(request) {
    const name = `cosmology-e2e-${process.pid}-${containerIndex++}`;
    const run = spawnSync('docker', ['run', '--rm', '--name', name, '--network', 'none', '-i',
      '--mount', `type=bind,source=${wasmPath},target=/module.wasm,readonly`, dockerImage,
      '--enable-threads', '/module.wasm'], {input: Buffer.from(encodePluginInvokeRequest(request)),
      timeout: 30000, maxBuffer: 8*1024*1024});
    if (run.status !== 0) {
      // Only this invocation's named temporary container can be removed.
      spawnSync('docker', ['rm', '-f', name], {timeout: 10000, stdio: 'ignore'});
      throw new Error(`Docker WasmEdge failed: ${run.error ?? run.stderr}`);
    }
    return decodePluginInvokeResponse(run.stdout);
  }};
  const containerResults = await exercise(container, oracle);
  assert.deepEqual(containerResults, browserResults, 'Docker must produce byte-identical PCE outputs and errors');
  const metrics = {distanceMaxRelative: 0, angleMaxAbsoluteRad: 0, cmbMaxAbsolute: 0, scalarComparisons: 0,
    invalidRequests: 0, parityInvocations: browserResults.length, browserConsoleErrors: errors.length};
  for (const response of browserResults) {
    if (response.invalid) {
      assert.notEqual(response.statusCode, 0, response.name);
      assert.equal(response.outputs.length, 0, response.name);
      metrics.invalidRequests++; continue;
    }
    assert.equal(response.statusCode, 0, `${response.name}: ${response.errorMessage}`);
    assert.equal(response.outputs.length, 1, response.name);
    assert.equal(response.outputs[0].portId, 'result');
    const actual = decodeResult(Uint8Array.from(response.outputs[0].payload));
    const test = oracle.cases.find(c => c.name === response.name);
    if (!test) {
      for (const values of Object.values(actual)) {
        assert.equal(values.length, response.name === 'maximum batch' ? 4096 : 1);
        assert(values.every(v => v === 0), response.name);
      }
      continue;
    }
    for (const [key, expected] of Object.entries(test.expected)) {
      assert.equal(actual[key]?.length, expected.length, key);
      expected.forEach((reference, i) => {
        const value = actual[key][i];
        assert(Number.isFinite(value), `${key}[${i}] must be finite`);
        const absolute = Math.abs(value - reference);
        metrics.scalarComparisons++;
        if (key.endsWith('_rad')) {
          const error = key.includes('longitude') ? Math.min(absolute, Math.abs(absolute - 2*Math.PI)) : absolute;
          metrics.angleMaxAbsoluteRad = Math.max(metrics.angleMaxAbsoluteRad, error);
          assert(error <= 1e-9, `${key}[${i}]: ${error} rad`);
        } else if (key === 'redshift_cmb' || key === 'placement_redshift_cmb') {
          metrics.cmbMaxAbsolute = Math.max(metrics.cmbMaxAbsolute, absolute);
          assert(absolute <= 2e-12, `${key}[${i}]: ${absolute}`);
        } else if (key === 'distance_source') assert.equal(value, reference);
        else if (key.startsWith('sg')) assert(absolute <= 2e-8, `${key}[${i}]: ${absolute} Mpc`);
        else {
          const relative = reference === 0 ? absolute : absolute / Math.abs(reference);
          metrics.distanceMaxRelative = Math.max(metrics.distanceMaxRelative, relative);
          assert(relative <= 1e-6, `${key}[${i}]: ${relative} relative`);
        }
      });
    }
  }
  const grid = decodeResult(Uint8Array.from(browserResults[0].outputs[0].payload));
  const placement = decodeResult(Uint8Array.from(browserResults[3].outputs[0].payload));
  const distanceAt = z => grid.comoving_distance_mpc[oracle.cases[0].input.redshift_cmb.indexOf(z)];
  // Published-distance sanity checks allow object depth, peculiar velocities,
  // historical H0 conventions and rounding; precision is tested above.
  const spots = {VirgoCF4: placement.comoving_distance_mpc[5], Coma: distanceAt(.023),
    Shapley: distanceAt(.048), SloanGreatWall: distanceAt(.07804)};
  assert(spots.VirgoCF4 >= 15 && spots.VirgoCF4 <= 18, 'NED Virgo 16.5 Mpc');
  assert(spots.Coma >= 96 && spots.Coma <= 108, 'NED Coma 102 +/- 6 Mpc');
  assert(spots.Shapley >= 190 && spots.Shapley <= 230, 'NED Shapley 140/h Mpc');
  assert(spots.SloanGreatWall >= 300 && spots.SloanGreatWall <= 370, 'Sloan Great Wall z~0.07-0.08');
  const report = {verdict: 'PASS', artifactSha256: createHash('sha256').update(wasm).digest('hex'),
    oracleSha256: createHash('sha256').update(oracleBytes).digest('hex'),
    oracle: oracle.oracle, metrics, spotComovingMpc: spots,
    runtimes: ['Chromium headless shell, direct SDK ABI', 'WasmEdge 0.16.4, command SDK ABI',
      `${dockerImage}, command SDK ABI`], skipped: []};
  fs.writeFileSync(path.join(scratch, 'e2e-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await native?.destroy?.();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
