// End-to-end numeric source reader. GDAL independently extracts physical
// source pixels; the same .wasm must return their exact values in both hosts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModule } from 'space-data-module-sdk/host/isomorphic';
import { createReader, readWindow, wasmPath, doubles } from '../read-samples.mjs';

const fixtures = fileURLToPath(new URL('../../../data-source/terrain-ingest/tests/fixtures/body-raster/', import.meta.url));
const cases = [
  ['mercury-180-east.tif', 'mercury-physical.f64'],
  ['mercury-180-east.cub', 'mercury-physical.f64'],
  ['venus-equator.tif', 'venus-physical.f64'],
];
const hosts = process.argv.includes('--native') ? ['browser-harness', 'wasmedge'] : ['browser-harness'];
const reports = [];
for (const host of hosts) {
  const harness = host === 'browser-harness' ? await createReader() : await loadModule({
    wasmSource: wasmPath, runtimeKind: 'wasmedge', surface: 'command', enableThreads: true,
    wasmEdgeBinary: process.env.WASMEDGE_BINARY ?? `${process.env.HOME}/.wasmedge/bin/wasmedge`,
  });
  try {
    for (const [file, reference] of cases) {
      const got = await readWindow(harness, fixtures + file, [0, 0, 32, 32]);
      const expected = doubles(fs.readFileSync(fixtures + reference));
      assert.equal(got.values.length, 1024);
      assert.ok(got.valid.every((n) => n === 1), `${file}: source crop must have no missing pixels`);
      assert.deepEqual(got.values, expected, `${host}: ${file} differs from GDAL physical samples`);
      reports.push({host, file, exactPosts: expected.length});
    }
  } finally {await harness.destroy();}
}
console.log(JSON.stringify({checks: reports, docker: 'waived by owner 2026-10-22', peakRssBytes: process.resourceUsage().maxRSS * 1024}));
