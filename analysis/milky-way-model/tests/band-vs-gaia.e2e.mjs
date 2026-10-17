// One complete browser/SAB/module E2E. All geometry and metrics run in C++ WASM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateArtifactWithStandards} from 'space-data-module-sdk/compliance';

const require = createRequire(import.meta.url);
const packageDir = fileURLToPath(new URL('../', import.meta.url));
const worktree = path.resolve(packageDir, '../..');
const buildDir = path.join(packageDir, '.build');
const legacyOnly = process.argv.includes('--legacy-only');
const sources = JSON.parse(fs.readFileSync(new URL('./oracle-sources.json', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'plugin-manifest.json')));
const wasmPath = path.join(packageDir, 'dist/isomorphic/module.wasm');
const wasm = fs.readFileSync(wasmPath);
const binary = process.env.SDM_CHROME_BINARY;
assert(binary, 'Export SDM_CHROME_BINARY to the Playwright cached chromium headless shell.');
assert.match(fs.realpathSync(binary), /\/Library\/Caches\/ms-playwright\/chromium_headless_shell-[^/]+\/.*\/chrome-headless-shell$/,
  'Only the Playwright cached Chromium headless shell is permitted.');
fs.mkdirSync(buildDir, {recursive: true});
process.env.TMPDIR = buildDir;

const assets = new Map();
const missing = [];
if (!legacyOnly) {
  for (const source of [...sources.maps, sources.masers]) {
    const filename = path.join(packageDir, 'oracle', source.file);
    if (!fs.existsSync(filename)) missing.push({file: filename, url: source.url});
    else {
      const bytes = fs.readFileSync(filename);
      if (source.sha256) assert.equal(sha256(bytes), source.sha256, `Unrecognized oracle bytes: ${source.file}`);
      assets.set(`/oracle/${source.file}`, bytes);
    }
  }
}
if (missing.length) {
  console.log('BLOCKED Gaia E2E: offline oracle cache is incomplete.');
  for (const source of missing) console.log(`FETCH ${source.file}\n${source.url}`);
  process.exit(2);
}

// Parsing published tabular identifiers is IO; no coordinate conversion occurs here.
function parseMasers(bytes) {
  const arms = { '3kN': 0, Nor: 1, Out: 1, CtN: 2, ScN: 2, ScF: 2, OSC: 2,
    SgN: 3, SgF: 3, Car: 3, CrN: 3, CrF: 3, Loc: 4, Per: 5 };
  const records = [], excluded = {};
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!/^\s*\d+\t/.test(line)) continue;
    const fields = line.split('\t').map(value => value.trim());
    const name = fields[1].match(/^G(\d+\.\d+)([+-]\d+\.\d+)$/);
    const arm = fields[13];
    if (!name || arms[arm] === undefined) { excluded[arm] = (excluded[arm] ?? 0) + 1; continue; }
    records.push({name: fields[1], longitude: Number(name[1]), latitude: Number(name[2]),
      parallax: Number(fields[5]), parallaxError: Number(fields[6]), arm: arms[arm], armCode: arm});
  }
  assert(records.length > 100, 'Published Reid table must contain the complete modeled-arm sample.');
  return {records, excluded};
}
const masers = legacyOnly ? null : parseMasers(assets.get(`/oracle/${sources.masers.file}`));
const compliance = await validateArtifactWithStandards({manifest, wasmPath,
  standardsRoot: path.dirname(require.resolve('spacedatastandards.org/package.json'))});
assert.equal(compliance.ok, true, JSON.stringify(compliance.issues));
console.log('PASS SDK manifest, SDS ports, canonical invoke ABI and artifact compliance');
const planObject = {legacyOnly, maps: sources.maps, masers};
async function nodeFallback(reason) {
  const summary = /MachPort.*Permission denied/s.test(reason)
    ? 'macOS sandbox denies Chromium Mach-port startup; Node WASM diagnostic follows'
    : reason.split('\n')[0];
  console.log(`BROWSER BLOCKED: ${summary}`);
  const {runE2E} = await import('./browser-e2e.mjs');
  let png;
  if (!legacyOnly) {
    for (const candidate of [process.env.SDM_PNGJS_PATH, 'pngjs',
      path.join(worktree, '../OrbPro--console-body-coordinate-systems-20261016/node_modules/pngjs')].filter(Boolean)) {
      try { png = require(candidate).PNG; break; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    assert(png, 'Offline pngjs decoder required for Node diagnostic fallback.');
  }
  const result = await runE2E({browser: false, plan: planObject, wasm,
    progress: async stage => { if (process.env.SDM_E2E_PROGRESS) console.log(`E2E Node diagnostic ${stage}`); },
    async loadImage(source) {
      const image = png.sync.read(assets.get(`/oracle/${source.file}`));
      return {width: image.width, height: image.height, pixels: image.data};
    }});
  result.browserFailure = reason;
  result.runtime = 'Node diagnostic fallback; browser acceptance failed';
  return result;
}
let report;
if (process.argv.includes('--node-diagnostic')) {
  report = await nodeFallback('Explicit diagnostic run after unavailable headless-shell lane');
} else {

// The optional path supports an already-installed offline bundler; nothing is installed.
let esbuild;
for (const candidate of [process.env.SDM_ESBUILD_PATH, 'esbuild',
  path.join(worktree, '../OrbPro--console-body-coordinate-systems-20261016/node_modules/esbuild')].filter(Boolean)) {
  try { esbuild = require(candidate); break; } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
}
assert(esbuild, 'Offline esbuild is required; set SDM_ESBUILD_PATH to an installed package.');
const options = {bundle: true, write: false, format: 'esm', platform: 'browser', target: ['chrome110'],
  external: ['node:*', 'hd-wallet-wasm'], logLevel: 'silent', absWorkingDir: packageDir};
const runner = await esbuild.build({...options, entryPoints: [path.join(packageDir, 'tests/browser-e2e.mjs')]});
const sdkDir = path.dirname(require.resolve('space-data-module-sdk/host/browser-module'));
const worker = await esbuild.build({...options, entryPoints: [path.join(sdkDir, 'wasiThreadBrowserWorker.mjs')]});
const plan = JSON.stringify(planObject);
let resolveDone, rejectDone;
const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
let completed = false;
const server = http.createServer((req, res) => {
  if (process.env.SDM_E2E_PROGRESS) console.log(`E2E HTTP ${req.method} ${req.url}`);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.url === '/done' && req.method === 'POST') {
    const chunks = [];
    req.on('data', bytes => chunks.push(bytes));
    req.on('end', () => { res.end('ok'); try { completed = true; resolveDone(JSON.parse(Buffer.concat(chunks))); } catch (error) { rejectDone(error); } });
  } else if (req.url === '/progress' && req.method === 'POST') {
    const chunks = [];
    req.on('data', bytes => chunks.push(bytes));
    req.on('end', () => { res.end('ok'); clearTimeout(startupTimer); if (process.env.SDM_E2E_PROGRESS) console.log(`E2E ${Buffer.concat(chunks)}`); });
  } else if (req.url === '/module.wasm') { res.setHeader('Content-Type', 'application/wasm'); res.end(wasm); }
  else if (req.url === '/runner.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(runner.outputFiles[0].text); }
  else if (req.url === '/wasi-worker.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(worker.outputFiles[0].text); }
  else if (req.url === '/plan') { res.setHeader('Content-Type', 'application/json'); res.end(plan); }
  else if (assets.has(req.url)) { res.setHeader('Content-Type', 'image/png'); res.end(assets.get(req.url)); }
  else if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Milky Way E2E</title><script type="module">const w=new Worker("/runner.js",{type:"module"});w.onerror=e=>fetch("/done",{method:"POST",body:JSON.stringify({error:e.message,checks:[]})});</script>'); }
  else { res.statusCode = 404; res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = fs.mkdtempSync(path.join(buildDir, 'chromium-profile-'));
const child = spawn(binary, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--disable-domain-reliability', '--disable-default-apps',
  '--disable-features=OptimizationHints,MediaRouter,AutofillServerCommunication',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
  `http://127.0.0.1:${server.address().port}/`], {cwd: packageDir, stdio: ['ignore', 'ignore', 'pipe']});
const browserErrors = [];
const browserLog = path.join(buildDir, 'browser-stderr.log');
fs.writeFileSync(browserLog, '');
child.stderr.on('data', bytes => { browserErrors.push(bytes); fs.appendFileSync(browserLog, bytes); });
child.on('error', rejectDone);
child.once('exit', (code, signal) => {
  if (!completed) rejectDone(new Error(`Headless shell exited (${code ?? signal}): ${Buffer.concat(browserErrors).toString().slice(-3000)}`));
});
const interrupted = () => rejectDone(new Error('E2E interrupted'));
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
const timer = setTimeout(() => rejectDone(new Error(`E2E browser timeout: ${Buffer.concat(browserErrors).toString().slice(-3000)}`)), 300000);
const startupTimer = setTimeout(() => rejectDone(new Error(`Headless shell did not start the worker in 45s; see .build/browser-stderr.log`)), 45000);
let browserFailure;
try { report = await done; }
catch (error) { browserFailure = error.message; }
finally {
  clearTimeout(timer);
  clearTimeout(startupTimer);
  completed = true;
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  if (child.exitCode === null && child.signalCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await closed; }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(profile, {recursive: true, force: true});
}
if (browserFailure) report = await nodeFallback(browserFailure);
}
assert.equal(sha256(fs.readFileSync(wasmPath)), sha256(wasm), 'Artifact changed during E2E.');
report.artifactSha256 = sha256(wasm);
if (report.skyPng) {
  fs.writeFileSync(path.join(buildDir, 'model-vs-flux.png'), Buffer.from(report.skyPng, 'base64'));
  report.evidenceImage = '.build/model-vs-flux.png (fitted model sky over the ESA flux map, 0.5-degree Galactic grid)';
  delete report.skyPng;
}
report.oracleSources = legacyOnly ? null : sources;
report.maserExclusions = masers?.excluded;
fs.writeFileSync(path.join(buildDir, legacyOnly ? 'legacy-e2e-report.json' : 'band-vs-gaia-report.json'), JSON.stringify(report, null, 2) + '\n');
if (!legacyOnly) fs.writeFileSync(path.join(packageDir, 'dist/calibration-fit.json'), JSON.stringify(report, null, 2) + '\n');
for (const line of report.lines ?? []) console.log(line);
if (report.error) console.log(`FAIL ${report.error}`);
const failed = (report.checks ?? []).filter(check => !check.ok);
if (failed.length) console.log(`FAIL checks: ${failed.map(check => check.name).join('; ')}`);
console.log(`${report.error || failed.length ? 'FAIL' : 'PASS'} ${legacyOnly ? 'legacy refactor' : 'Milky Way band-vs-Gaia'} E2E (${report.checks?.length ?? 0} checks, ${failed.length} failed)`);
process.exitCode = report.error || failed.length ? 1 : 0;
