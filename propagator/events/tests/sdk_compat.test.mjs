import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as fb from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { validatePluginArtifact } from 'space-data-module-sdk/compliance';
import { EVL } from 'spacedatastandards.org/lib/js/EVL/main.js';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import { eclipseRequest, kernelFrame } from './kernel-fixture.mjs';

const wasmPath = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
for (const runtimeKind of ['browser', 'wasmedge']) {
  test(`events DE440 invoke + explicit fallback + refusal (${runtimeKind})`, async () => {
    const wasmBytes = readFileSync(wasmPath);
    const validation = await validatePluginArtifact({ manifest, wasmBytes });
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    const h = await createStandaloneHarness(runtimeKind, wasmPath, { enableThreads: true });
    try {
      for (const [name, request, good, hasSource] of [
        ['DE440', eclipseRequest({kernel: kernelFrame()}), true, true],
        ['Analytical', eclipseRequest(), true, false],
        ['bad descriptor hash', eclipseRequest({kernel: kernelFrame(undefined, '0'.repeat(64))}), false, false],
        ['non-UTC trajectory', eclipseRequest({kernel: kernelFrame(), timeSystem: 7}), false, false],
        ['mismatched center', eclipseRequest({kernel: kernelFrame(), center: 301}), false, false],
        ['non-inertial trajectory', eclipseRequest({kernel: kernelFrame(), frame: 7}), false, false],
        ['out of coverage', eclipseRequest({kernel: kernelFrame(), start: '2030-01-02T00:00:00Z'}), false, false],
      ]) {
        const response = await h.invoke(request);
        assert.equal(response.statusCode, 0, `${name}: ${response.errorMessage}`);
        const output = response.outputs.find(x => x.portId === 'report');
        assert.ok(output, name);
        const report = EVL.getRootAsEVL(new fb.ByteBuffer(output.payload)).EVENT_REPORT();
        assert.equal(report.STATUS() === 1, good, `${name}: ${report.ERROR_MESSAGE()}`);
        if (good) assert.ok(report.eventsLength() > 0, 'circle crosses the terrestrial shadow');
        const source = response.outputs.find(x => x.portId === 'ephemeris_source');
        assert.equal(Boolean(source), hasSource, name);
        if (source) assert.equal(NCD.getSizePrefixedRootAsNCD(new fb.ByteBuffer(source.payload)).SOURCE_SHA256(),
          'e612a95953ca8211c629bdb632d4c7483cc339f0e963592bd8cae4a7d24ad7ef');
      }
    } finally { await h.close?.(); }
  });
}
