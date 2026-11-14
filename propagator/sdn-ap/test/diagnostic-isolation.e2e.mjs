#!/usr/bin/env node
// Each diagnostic build owns its source tree and artifact, even when names repeat or an output override is inherited.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {buildDiagnostic} from './lib/ap-diagnostic.mjs';
import {scratchTemp} from './lib/scratch.mjs';
const outside = scratchTemp('diagnostic-output-');
const previous = process.env.SDNAP_DIST_DIR;
const artifact = [];
try {
  process.env.SDNAP_DIST_DIR = outside;
  for (const value of [17, 29]) artifact.push(buildDiagnostic('diagnostic-isolation', `
SDNAP_EXPORT("sdnap_test_build_identity") uint32_t sdnap_test_build_identity(void) { return ${value}; }
`));
} finally {
  if (previous === undefined) delete process.env.SDNAP_DIST_DIR;
  else process.env.SDNAP_DIST_DIR = previous;
}
assert.notEqual(artifact[0], artifact[1], 'two builds with the same name share an artifact');
assert.equal(fs.existsSync(path.join(outside, 'isomorphic/module.wasm')), false, 'a diagnostic escaped into the inherited output directory');
for (const [i, file] of artifact.entries()) {
  const h = await createStandaloneHarness('browser', file, {surface:'direct', maxThreads:1, enableBrowserWasiThreads:false});
  assert.equal(h.instance.exports.sdnap_test_build_identity(), [17, 29][i], 'a later build replaced an earlier diagnostic');
  await h.destroy?.();
}
console.log('DIAGNOSTIC-ISOLATION PASS: repeated names preserve distinct artifacts and output overrides do not escape');
