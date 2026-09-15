// SDK harness on a dedicated owner Worker: memory.atomic.wait is legal there.
// Serve the SDK worker dependency chain at an explicit anchor, without copying
// or modifying SDK runtime code. Each case tears down its complete worker tree.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkTesting = path.dirname(fileURLToPath(import.meta.resolve('space-data-module-sdk/testing')));
const sdkSource = path.resolve(sdkTesting, '..');
const { resolveChromeBinary } = await import(path.join(sdkTesting, 'parityLanes.js'));

export async function runThreadedBrowserLane(context) {
  const factoryImport = context.publicWrapper
    ? `import { createConjunctionAssessmentPlugin as createHarness } from ${JSON.stringify(path.join(root, 'index.js'))};`
    : `import { createBrowserModuleHarness as createHarness } from 'space-data-module-sdk/host/browser-module';`;
  const source = `
    ${factoryImport}
    import { setBrowserWasiThreadWorkerBase } from ${JSON.stringify(path.join(sdkSource, 'host/wasiThreadHost.js'))};
    ${context.publicWrapper ? '' : "setBrowserWasiThreadWorkerBase('/sdk/host/');"}
    let spawnCount = 0;
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      postMessage(message, ...rest) { if (message?.t === 'run') spawnCount += 1; return super.postMessage(message, ...rest); }
    };
    self.onmessage = async ({ data }) => {
      let harness, stdout = new Uint8Array(), exitClass = 'ok', exitDetail = null;
      try {
        harness = await createHarness({ wasmSource: data.wasmBytes, wasmBinary: data.wasmBytes, surface: 'command',
          args: ['module.wasm', ...data.args], env: data.env,
          wasiThreadWorkerBaseUrl: '/sdk/host/',
          enableBrowserWasiThreads: true, maxThreads: data.caseId.startsWith('socrates') && data.threadCount > 1 ? data.threadCount * 2 : 0 });
        stdout = await harness.invokeRaw(data.stdinBytes);
      } catch (error) {
        exitClass = error.name === 'WasiExitError' ? 'guest-error' : 'trap';
        exitDetail = error.name === 'WasiExitError' ? 'exit=' + error.code : error.name + ': ' + error.message;
      } finally { harness?.destroy(); }
      self.postMessage({ exitClass, exitDetail, stdout, spawnCount, hardwareConcurrency: navigator.hardwareConcurrency });
    };`;
  const bundle = await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'cqr-parity-worker.mjs' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome110', external: ['node:*', 'hd-wallet-wasm'], logLevel: 'silent' });
  const plan = context.plan.cases.flatMap(c => c.threadCounts.map(threadCount => ({ caseId: c.id, threadCount, args: c.args, env: { ...c.env, [context.plan.threadEnvVar]: String(threadCount) }, stdinBase64: Buffer.from(c.stdinBytes).toString('base64') })));
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
  const page = `<!doctype html><meta charset="utf-8"><title>CQR SDK threaded parity</title><pre id="status"></pre><script type="module">
    try {
      if (!crossOriginIsolated) throw Error('Cross-origin isolation is required');
      const plan = await (await fetch('/plan')).json();
      const wasmBytes = new Uint8Array(await (await fetch('/module.wasm')).arrayBuffer());
      const runs = [];
      for (const c of plan) {
        document.getElementById('status').textContent = c.caseId + ' / workers ' + c.threadCount;
        await fetch('/progress',{method:'POST',body:c.caseId + ' / workers ' + c.threadCount});
        const worker = new Worker('/case-worker.js', {type:'module'});
        try {
          const run = await new Promise((resolve,reject) => {
            worker.onmessage = e => resolve(e.data); worker.onerror = e => reject(Error(e.message + ' at ' + e.filename + ':' + e.lineno));
            worker.postMessage({...c, wasmBytes, stdinBytes: Uint8Array.from(atob(c.stdinBase64),x=>x.charCodeAt(0))});
          });
          runs.push({...run, caseId:c.caseId, threadCount:c.threadCount, stdoutBase64:btoa(String.fromCharCode(...run.stdout)), stdout:undefined});
        } finally { worker.terminate(); }
      }
      await fetch('/done',{method:'POST',body:JSON.stringify({runs})});
    } catch(error) { await fetch('/done',{method:'POST',body:JSON.stringify({fatal:String(error)})}); }
  </script>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/progress') {
      const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
        context.log('browser: ' + Buffer.concat(chunks).toString()); res.writeHead(200, headers); res.end('ok');
      }); return;
    }
    if (req.method === 'POST' && url.pathname === '/done') {
      const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
        res.writeHead(200, headers); res.end('ok');
        try { const body = JSON.parse(Buffer.concat(chunks)); if (body.fatal) rejectDone(Error(body.fatal)); else resolveDone(body.runs); } catch (error) { rejectDone(error); }
      }); return;
    }
    let body, mime = 'text/javascript';
    if (url.pathname === '/') { body = page; mime = 'text/html'; }
    else if (url.pathname === '/case-worker.js') body = bundle.outputFiles[0].text;
    else if (url.pathname === '/plan') { body = JSON.stringify(plan); mime = 'application/json'; }
    else if (url.pathname === '/module.wasm') { body = Buffer.from(context.loadableBytes); mime = 'application/wasm'; }
    else if (url.pathname.startsWith('/sdk/')) {
      const resource = path.resolve(sdkSource, url.pathname.slice(5));
      if (resource.startsWith(sdkSource + path.sep) && fs.existsSync(resource) && fs.statSync(resource).isFile()) body = fs.readFileSync(resource);
    }
    if (body === undefined) { res.writeHead(404, headers); res.end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': mime }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cqr-parity-chrome-'));
  const chrome = spawn(await resolveChromeBinary(context), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'ignore', 'pipe'] });
  const diagnostics = []; chrome.stderr.on('data', bytes => diagnostics.push(bytes));
  chrome.on('error', rejectDone);
  chrome.on('exit', (code, signal) => rejectDone(Error(`Chrome exited ${code}/${signal}: ${Buffer.concat(diagnostics).toString().slice(-2000)}`)));
  const timeout = setTimeout(() => rejectDone(Error(`Browser parity timed out after ${context.timeoutMs}ms`)), context.timeoutMs);
  try { return (await done).map(run => ({ ...run, stdout: new Uint8Array(Buffer.from(run.stdoutBase64, 'base64')), stderr: new Uint8Array() })); }
  finally {
    clearTimeout(timeout); chrome.removeAllListeners('exit');
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      await new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGKILL'); });
    }
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Temporary-profile cleanup must not mask the runtime result. */ }
  }
}
