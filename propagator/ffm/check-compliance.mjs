import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { validateManifestWithStandards, validateArtifactWithStandards } from 'space-data-module-sdk';
import { encodePluginManifest, decodePluginManifest } from 'space-data-module-sdk/manifest';
const manifest = JSON.parse(fs.readFileSync(new URL('plugin-manifest.json', import.meta.url)));
const standardsRoot = fileURLToPath(new URL('node_modules/spacedatastandards.org', import.meta.url));
const reports = [
  await validateManifestWithStandards(manifest, {standardsRoot}),
  await validateArtifactWithStandards({manifest, standardsRoot, wasmPath:fileURLToPath(new URL('dist/isomorphic/module.wasm', import.meta.url))}),
];
const encoded=encodePluginManifest(manifest),roundTrip = decodePluginManifest(encoded);
assert.deepEqual(encodePluginManifest(roundTrip),encoded,'PLG encode/decode cycle must be byte-identical');
assert.equal(roundTrip.pluginId,manifest.pluginId);
assert.deepEqual(roundTrip.runtimeTargets,manifest.runtimeTargets);
assert.equal(roundTrip.methods.length,manifest.methods.length);
for(let i=0;i<manifest.methods.length;i++){
  const authored=manifest.methods[i],decoded=roundTrip.methods[i];
  assert.equal(decoded.methodId,authored.methodId);
  for(const direction of ['inputPorts','outputPorts']){
    assert.equal(decoded[direction].length,authored[direction].length);
    for(let j=0;j<authored[direction].length;j++){
      assert.equal(decoded[direction][j].portId,authored[direction][j].portId);
      const expected=authored[direction][j].acceptedTypeSets[0].allowedTypes[0];
      const actual=decoded[direction][j].acceptedTypeSets[0].allowedTypes[0];
      for(const key of ['schemaName','fileIdentifier','rootTypeName','wireFormat'])assert.equal(actual[key],expected[key]);
    }
  }
}
const errors = reports.flatMap(report => report.issues ?? report.errors ?? []).filter(issue => issue.severity === 'error');
const warnings = reports.flatMap(report => report.issues ?? []).filter(issue => issue.severity === 'warning');
const uniqueWarnings=[...new Map(warnings.map(w=>[`${w.code}:${w.location}`,w])).values()];
console.log(JSON.stringify({ok:reports.every(r => r.ok), standards:'1.220.0', errors:errors.length, warnings:uniqueWarnings.length, checks:['manifest','artifact'], plgRoundTrip:true, issues:errors, warningCodes:[...new Set(uniqueWarnings.map(w=>w.code))]},null,2));
if (reports.some(report=>!report.ok)) process.exitCode=1;
