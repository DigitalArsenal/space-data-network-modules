import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { headlessShell } from '../tests/lib/headlessShell.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function browserMemory({ frames, seeds, epoch, manifest, parityRequests }) {
  const bundle = await build({ stdin: { resolveDir: root, contents: `
    import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
    import { catalogClient } from './scripts/catalog-coverage-client.mjs';
    window.residentParity = async (manifest, count) => {
      const h = await createBrowserModuleHarness({ wasmSource: await (await fetch('/module.wasm')).arrayBuffer(), manifest, surface: 'direct' });
      try {
        const outputs = [];
        for (let i = 0; i < count; ++i) outputs.push([...await h.invokeRaw(new Uint8Array(await (await fetch('/parity/' + i)).arrayBuffer()))]);
        return outputs;
      } finally { await h.destroy(); }
    };
    window.measure = async ({ count, seeds, epoch, manifest, frameCount }) => {
      if (!crossOriginIsolated) throw new Error('browser is not cross-origin isolated');
      const wasm = await (await fetch('/module.wasm')).arrayBuffer();
      const frames = await Promise.all(Array.from({ length: frameCount }, async (_, i) => new Uint8Array(await (await fetch('/frame/' + i)).arrayBuffer())));
      const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
      let client;
      try {
        const objects = Array.from({ length: count }, (_, i) => seeds[i % seeds.length]);
        const start = performance.now();
        client = catalogClient(h, frames, objects, epoch);
        const seedMilliseconds = performance.now() - start;
        const windows = [];
        // Two nonoverlapping retained windows prove memory remains bounded
        // after dropping the first window, over all 1k/10k valid entities.
        for (const seconds of [1800, 3600]) {
          const start = performance.now(); client.ensure(epoch + seconds / 86400);
          const positions = client.positions(epoch + (seconds - 1) / 86400);
          if (!positions.every(Number.isFinite) || positions.some(v => v === 0)) throw new Error('missing catalog positions');
          windows.push({ seconds, milliseconds: performance.now() - start, wasmMemoryBytes: client.memoryBytes() });
        }
        return { entities: count, profile: client.profile(), seedMilliseconds, workerCount: 1,
          highWaterBytes: client.memoryBytes(), windows, crossOriginIsolated, browser: navigator.userAgent };
      } finally { client?.dispose(); await h.destroy(); }
    };
  ` }, bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent' });
  const wasm = fs.readFileSync(path.join(root, 'dist/isomorphic/module.wasm'));
  const server = http.createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script src="/bundle.js"></script>'); }
    else if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
    else if (req.url === '/module.wasm') { res.setHeader('Content-Type', 'application/wasm'); res.end(wasm); }
    else if (/^\/parity\/\d+$/.test(req.url) && parityRequests[Number(req.url.slice(8))]) res.end(parityRequests[Number(req.url.slice(8))]);
    else if (/^\/frame\/\d+$/.test(req.url) && frames[Number(req.url.slice(7))]) res.end(frames[Number(req.url.slice(7))]);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const rows = [];
  try {
    browser = await chromium.launch({ executablePath: headlessShell(), headless: true });
    for (const count of [1000, 10000]) {
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const row = await page.evaluate(options => window.measure(options), { count, seeds, epoch, manifest, frameCount: frames.length });
      if (errors.length) throw new Error(errors.join('\n'));
      rows.push(row); console.log(JSON.stringify(row)); await page.close();
    }
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const parity = await page.evaluate(({ manifest, count }) => window.residentParity(manifest, count), { manifest, count: parityRequests.length });
    await page.close();
    return { measurements: rows, parity };
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
