// End-to-end numeric source reader. GDAL independently extracts physical
// source pixels; the same .wasm must return their exact values in both hosts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModule } from 'space-data-module-sdk/host/isomorphic';
import { createReader, readWindow, wasmPath, doubles } from '../read-samples.mjs';

const fixtures = fileURLToPath(new URL('../../../data-source/terrain-ingest/tests/fixtures/body-raster/', import.meta.url));
const cases = JSON.parse(fs.readFileSync(fixtures + 'cases.json'));
const hosts = process.argv.includes('--native') ? ['browser-harness', 'wasmedge'] : ['browser-harness'];
const reports = [];
for (const host of hosts) {
  const harness = host === 'browser-harness' ? await createReader() : await loadModule({
    wasmSource: wasmPath, runtimeKind: 'wasmedge', surface: 'command', enableThreads: true,
    wasmEdgeBinary: process.env.WASMEDGE_BINARY ?? `${process.env.HOME}/.wasmedge/bin/wasmedge`,
  });
  try {
    for (const {file, reference, mask} of cases) {
      const got = await readWindow(harness, fixtures + file, [0, 0, 32, 32]);
      const expected = doubles(fs.readFileSync(fixtures + reference));
      assert.equal(got.values.length, 1024);
      const valid = fs.readFileSync(fixtures + mask);
      let missing=0;
      for(let i=0;i<expected.length;++i) {
        assert.equal(got.valid[i],valid[i]===0?0:1,`${file}: validity ${i}`);
        assert.equal(got.values[i],valid[i]===0?0:expected[i],`${host}: ${file} physical sample ${i}`);
        if(valid[i]===0)missing++;
      }
      reports.push({host, file, exactPosts: expected.length, missing, min:Math.min(...got.values),max:Math.max(...got.values)});
    }
  } finally {await harness.destroy();}
}
console.log(JSON.stringify({checks: reports, docker: 'waived by owner 2026-10-22', peakRssBytes: process.resourceUsage().maxRSS * 1024}));
