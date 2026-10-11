// The artifact itself: one file, WASI imports only, the Space Force library in it under the terms of its Agreement,
// the manifest and the propagator ABI the SDK checks.
//
//  - The Space Force build is an Emscripten output. Joined to the SDN code by wasm-merge it must leave nothing for
//    JavaScript to answer: the artifact imports WASI and nothing else, and none of the library's minified exports or
//    the shim's helpers is exported.
//  - The Agreement asks a binary redistribution to reproduce the copyright notice and the Agreement: they are inside
//    the artifact (custom section `ussf-sgp4-notice`) and the library in third_party/ is the one the build checks.
//  - `space-data-module check` and the propagator conformance of the SDK pass.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { manifest, root, wasmPath } from './lib/module.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = fs.readFileSync(wasmPath);
const ussfDir = path.join(root, 'third_party/ussf-sgp4');
const sdk = path.join(root, 'node_modules/space-data-module-sdk/bin/space-data-module.js');
const LIBRARY_SHA256 = '9f061110f12ac85a76ad80dc76cdb8a33ddad64e54d8dab3b6778602e16cbeb7';

test('the artifact imports WASI and nothing else, and exports the module, not the library or the shim', () => {
  const module = new WebAssembly.Module(bytes);
  const modules = new Set(WebAssembly.Module.imports(module).map((i) => i.module));
  assert.deepEqual([...modules], ['wasi_snapshot_preview1']);
  const exported = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
  for (const name of ['propagate', 'fit', 'ingest_omm', 'plugin_init_omm', 'plugin_propagate', 'plugin_propagate_batch', 'plugin_destroy', 'plugin_invoke_stream']) {
    assert.ok(exported.has(name), `exports ${name}`);
  }
  // The library's exports are minified to single letters (k = __wasm_call_ctors, s = malloc, A = Sgp4PropPosVel ...) and
  // the shim's are `put`, `get`, `pages`, `zero` and the nine Emscripten imports `a` to `i`: none may remain.
  for (const name of ['j', 'k', 's', 'q', 't', 'u', 'v', 'A', 'E', 'F', 'put', 'get', 'pages', 'zero', 'a', 'b', 'i']) {
    assert.ok(!exported.has(name), `${name} is not exported`);
  }
  const memories = WebAssembly.Module.exports(module).filter((e) => e.kind === 'memory');
  assert.equal(memories.length, 1, 'one memory is exported: the module\'s (the library\'s is its own, memory 1)');
});

test('the Agreement\'s notice is in the artifact, and the library is the one the build is written for', () => {
  const sections = WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'ussf-sgp4-notice');
  assert.equal(sections.length, 1);
  const notice = new TextDecoder().decode(sections[0]);
  assert.match(notice, /^Copyright 2015 United States Government as represented by the Administrator of US Space Force\. All Rights Reserved\./);
  assert.ok(notice.includes(LIBRARY_SHA256), 'names the library by its checksum');
  assert.match(notice, /does not endorse this module/);
  assert.match(notice, /Export of any goods or technical data from the United States may require an export license/);
  const agreement = fs.readFileSync(path.join(ussfDir, 'AGREEMENT.txt'), 'utf8');
  assert.ok(notice.endsWith(agreement), 'the Agreement follows, whole');
  assert.equal(sha256(fs.readFileSync(path.join(ussfDir, 'Sgp4Prop.xp.wasm'))), LIBRARY_SHA256);
  const noticeFile = fs.readFileSync(path.join(ussfDir, 'NOTICE.md'), 'utf8');
  for (const file of ['Sgp4Prop.xp.wasm', 'Sgp4Prop.xp.js', 'AGREEMENT.txt', 'ReleaseNotes-v9.1.1.0.md']) {
    assert.ok(noticeFile.includes(sha256(fs.readFileSync(path.join(ussfDir, file)))), `NOTICE.md lists the checksum of ${file}`);
  }
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-provenance.json'), 'utf8'));
  assert.equal(provenance.library.sha256, LIBRARY_SHA256);
  assert.equal(provenance.moduleSha256, sha256(bytes), 'dist/ is the build that was recorded');
});

test('the manifest passes the SDK check and the artifact the propagator conformance', () => {
  const check = spawnSync(process.execPath, [sdk, 'check', '--manifest', path.join(root, 'plugin-manifest.json'), '--wasm', wasmPath], { encoding: 'utf8' });
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
  assert.match(check.stdout, /No issues found/);
  assert.equal(manifest.threadModel, 'wasi-sequential');

  const conformance = spawnSync(process.execPath, [sdk, 'conformance', 'propagator', '--artifact', wasmPath, '--json'], { encoding: 'utf8' });
  assert.equal(conformance.status, 0, `${conformance.stdout}${conformance.stderr}`);
  const report = JSON.parse(conformance.stdout);
  const failing = report.checks.filter((c) => c.status === 'fail');
  assert.deepEqual(failing, []);
  assert.ok(report.checks.filter((c) => c.required).every((c) => c.status === 'pass'), 'every required check passes');
  // Measured 2026-10-11: the corpus-dependent checks (Tier B anchors, vis-viva and period closure) are gaps; the rest pass.
  assert.ok(report.checks.filter((c) => c.status === 'pass').length >= 8);
});
