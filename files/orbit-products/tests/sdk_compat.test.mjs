import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as fb from 'flatbuffers';
import { createStandaloneHarness } from 'space-data-module-sdk/testing/isomorphic';
import { validatePluginArtifact } from 'space-data-module-sdk/compliance';
import { NCD } from 'spacedatastandards.org/lib/js/NCD/NCD.js';
import { de440Cases, excerptPath, excerptSha256 } from './de440-fixture.mjs';

const wasmPath = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../plugin-manifest.json', import.meta.url)));

for (const runtimeKind of ['browser', 'wasmedge']) {
  test(`orbit-products DE440 metadata and explicit refusals (${runtimeKind})`, async () => {
    assert.equal(createHash('sha256').update(readFileSync(excerptPath)).digest('hex'), excerptSha256);
    const validation = await validatePluginArtifact({ manifest, wasmBytes: readFileSync(wasmPath) });
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    const harness = await createStandaloneHarness(runtimeKind, wasmPath, { enableThreads: true });
    try {
      for (const [id, request] of de440Cases()) {
        const response = await harness.invoke(request);
        if (id === 'de440-describe') {
          assert.equal(response.statusCode, 0, response.errorMessage);
          assert.equal(response.outputs.length, 1, 'describe emits metadata only');
          assert.equal(response.outputs[0].portId, 'descriptor');
          const ncd = NCD.getSizePrefixedRootAsNCD(new fb.ByteBuffer(response.outputs[0].payload));
          assert.equal(ncd.SOURCE_SHA256(), excerptSha256);
          assert.equal(ncd.SOURCE_BYTE_LENGTH(), 114688n);
          assert.equal(ncd.NATIVE_TIME_SYSTEM(), 'TDB');
          assert.equal(ncd.NATIVE_FRAME_NAME(), 'J2000');
          assert.equal(ncd.segmentsLength(), 14);
          for (let i = 0; i < ncd.segmentsLength(); ++i) {
            const segment = ncd.SEGMENTS(i);
            assert.equal(segment.SEGMENT_TYPE(), 2);
            assert.equal(segment.FRAME_NAIF_ID(), 1);
            assert.ok(segment.POLYNOMIAL_DEGREE() > 0);
          }
        } else {
          assert.equal(response.statusCode, 400, id);
          assert.equal(response.outputs.length, 0, id);
          if (id === 'de440-no-coefficient-materialization') {
            assert.equal(response.errorCode, 'unsupported-spk-materialization');
            assert.match(response.errorMessage, /Chebyshev coefficients/);
          } else {
            assert.equal(response.errorCode, 'descriptor-hash-mismatch');
            assert.match(response.errorMessage, /SOURCE_SHA256/);
          }
        }
      }
    } finally {
      await harness.close?.();
    }
  });
}
