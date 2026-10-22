import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateArtifactWithStandards, validateManifestWithStandards } from 'space-data-module-sdk/compliance';
import { inspectModule } from 'space-data-module-sdk/host/isomorphic';
const require = createRequire(import.meta.url);
const standardsRoot = path.dirname(require.resolve('spacedatastandards.org/package.json'));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));

test('manifest validates against fixed SDS 1.249.0 and declares typed object_covariance ports', async () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(standardsRoot, 'package.json'))).version, '1.249.0');
  const report = await validateManifestWithStandards(manifest, { standardsRoot });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  const method = manifest.methods.find((m) => m.methodId === 'object_covariance');
  const types = (ports) => Object.fromEntries(ports.map((p) => {
    assert.equal(p.acceptedTypeSets.length, 1);
    const allowed = p.acceptedTypeSets[0].allowedTypes;
    assert.equal(allowed.length, 1); assert.equal(allowed[0].wireFormat, 'flatbuffer');
    return [p.portId, allowed[0].fileIdentifier];
  }));
  assert.deepEqual(types(method.inputPorts), { elements: '$OMM', models: '$ERM', request: '$ERM' });
  assert.deepEqual(Object.fromEntries(method.inputPorts.map((p) => [p.portId, { required: p.required, minStreams: p.minStreams }])), {
    elements: { required: true, minStreams: 1 }, models: { required: false, minStreams: 0 }, request: { required: true, minStreams: 1 },
  });
  assert.deepEqual(types(method.outputPorts), { covariance: '$ERM', report: '$ERM' });
  assert.deepEqual(method.invokeSurfaces, ['direct']);
  assert.equal(manifest.version, '0.8.1');
  assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, manifest.version);
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../dist/plugin-manifest.json', import.meta.url))), manifest);
});

test('isomorphic artifact passes SDK compliance and exports the canonical ABI plus object_covariance', async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath, standardsRoot });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  const inspection = await inspectModule(fs.readFileSync(wasmPath));
  for (const name of ['plugin_alloc', 'plugin_free', 'plugin_invoke_stream', 'plugin_get_manifest_flatbuffer',
    'plugin_get_manifest_flatbuffer_size', 'object_covariance']) assert.ok(inspection.exports.includes(name), name);
  assert.deepEqual(manifest.runtimeTargets, ['browser', 'wasmedge']);
});
