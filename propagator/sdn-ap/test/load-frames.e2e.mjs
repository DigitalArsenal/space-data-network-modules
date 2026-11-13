#!/usr/bin/env node
// No allocation of a load follows a record count read from the payload's framing (SPEC 1.6): a payload of a million minimal frames (12 bytes each, a
// length, a root offset and the file identifier $OCM) names a million records, and the load reserved arrays for all of them before decoding the first.
// Here the first frame is refused (invalid-ocm), and the instance has grown by about the staged payload alone. The control is the build that reserved
// from the count (38ea2ea4): it must have grown by many times the payload (or been refused for want of memory) on the same bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {T} from './lib/ocm.mjs';
import {packageRoot, wasmPath} from './lib/module.mjs';
import {scratchDir} from './lib/scratch.mjs';
const FRAMES = 1000000, MIB = 1048576;
const frame = Buffer.alloc(12); frame.writeUInt32LE(8, 0); frame.write('$OCM', 8, 'latin1');
const payload = Buffer.alloc(FRAMES * 12);
for (let k = 0; k < FRAMES; ++k) frame.copy(payload, k * 12);
const open = file => createStandaloneHarness('browser', file, {surface: 'direct', maxThreads: 1, enableBrowserWasiThreads: false, initialMemoryBytes: 2 * MIB});
const load = h => h.invoke({methodId: 'load_epochs', inputs: [{portId: 'ocm', typeRef: T('OCM'), payload}]});
const h = await open(wasmPath);
const r = await load(h);
assert.equal(r.statusCode, 3);
assert.equal(r.errorCode, 'invalid-ocm', `${r.errorCode}: ${r.errorMessage}`);
const grown = h.memory.buffer.byteLength - 2 * MIB;
assert.ok(grown < 2 * payload.length, `a load of ${FRAMES} minimal frames grew the instance by ${grown} bytes for a ${payload.length} byte payload`);
const x = h.instance.exports, p = x.sdnap_alloc(64);
x.sdnap_epochs_stats(p);
assert.deepEqual([x.sdnap_epochs_count(), new Float64Array(h.memory.buffer, p, 8)[7]], [0, 0]);
const oldPath = path.join(scratchDir('load-frames'), 'baseline.wasm');
fs.writeFileSync(oldPath, execFileSync('git', ['-C', packageRoot, 'show', '38ea2ea4:propagator/sdn-ap/dist/isomorphic/module.wasm'], {maxBuffer: 1 << 24}));
const old = await open(oldPath);
let oldGrown, oldCode;
try { const a = await load(old); oldCode = a.errorCode; oldGrown = old.memory.buffer.byteLength - 2 * MIB; } catch (e) { oldCode = `trap ${e?.message ?? e}`.slice(0, 80); oldGrown = Infinity; }
assert.ok(oldGrown > 8 * payload.length || oldCode === 'out-of-memory' || String(oldCode).startsWith('trap'), `the old build grew by ${oldGrown} bytes (${oldCode}): the control does not show the reserve`);
console.log(JSON.stringify({frames: FRAMES, payload: payload.length, grown, oldGrown, oldCode}));
await h.destroy?.(); await old.destroy?.();
console.log('LOAD-FRAMES PASS');
