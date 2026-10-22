#!/usr/bin/env node
// One unmodified WASM, real headless browser + native WasmEdge.
// Docker is waived by the owner (2026-10-22); never invoke or start it here.
// Randomized ciphertext is intentionally unequal; lengths/layout and decrypted
// fixture SHA-256 must agree exactly. No module-side test entropy hooks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePluginInvokeRequest, decodePluginInvokeResponse } from 'space-data-module-sdk/invoke';
import {
  loadWasmEdgePin, runBrowserLane,
  resolveWasmEdgeBinary, assertWasmEdgeVersionMatchesPin, normalizeWasmEdgeOutcome,
} from 'space-data-module-sdk/testing';
import { generateX25519Keypair, decryptBytesFromEnvelope } from 'space-data-module-sdk/transport';
import { sealRequest, checkLayout, sha256, decodeFileContent } from './lib/wire.mjs';

const scratch = process.env.PUBLICATION_SEAL_SCRATCH;
assert.ok(scratch, 'Set PUBLICATION_SEAL_SCRATCH to an authorized scratch directory (never /tmp).');
process.env.TMPDIR = scratch;
const names = ['499-root.dtts.gz', '499-12-1462_615.dtts.gz', '301-root.dtts.gz', '301-9-0_0.dtts.gz'];
const files = names.map(name => fs.readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const wasmBytes = fs.readFileSync(wasmPath);
const release = await generateX25519Keypair();
const request = sealRequest(files, release.privateKey, 'space-data-network/terrain/20261022', names);
const stdinBytes = encodePluginInvokeRequest(request);
const pin = loadWasmEdgePin();
const timeoutMs = 60_000;
const context = {
  wasmPath, wasmBytes, pin, timeoutMs, log: message => console.log(message), autoBuildDockerImage: false,
  plan: { threadEnvVar: 'SDM_THREADS', cases: [{ id: 'four-real-tiles', stdinBytes, args: [], env: {}, threadCounts: [1] }] },
};
function child(command, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${command} timed out`)); }, timeoutMs);
    p.stdout.on('data', b => out.push(b)); p.stderr.on('data', b => err.push(b));
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
    p.stdin.on('error', () => {}); p.stdin.end(input);
  });
}
const receipt = {
  artifactSha256: sha256(wasmBytes), wasmedgeVersion: pin.wasmedgeVersion, runs: [],
  waived: [{ lane: 'docker-wasmedge', authority: 'owner 2026-10-22',
    reason: 'Never start Docker or Docker Desktop; browser and native WasmEdge only.' }],
};
let reference;
async function verify(lane, bytes) {
  const response = decodePluginInvokeResponse(bytes);
  assert.equal(response.statusCode, 0, `${lane}: ${response.errorMessage}`);
  assert.equal(response.outputs.length, files.length);
  const results = [];
  for (let i = 0; i < files.length; i++) {
    assert.equal(response.outputs[i].portId, 'file');
    const sealed = decodeFileContent(response.outputs[i].payload);
    const layout = checkLayout(sealed, files[i].length, `space-data-network/terrain/20261022/${names[i]}`);
    const plaintext = await decryptBytesFromEnvelope({ envelope: { protectedBlobBase64: Buffer.from(sealed).toString('base64') }, recipientPrivateKey: release.privateKey });
    assert.equal(sha256(plaintext), sha256(files[i]), `${lane}: exact original bytes`);
    results.push({ name: names[i], length: sealed.length, overhead: sealed.length - files[i].length,
      trailerLength: layout.trailerLength, aadLength: layout.aad.length, plaintextSha256: sha256(plaintext) });
  }
  if (reference) assert.deepEqual(results, reference, 'same lengths, layout and decrypted plaintext across runtimes');
  else reference = results;
  receipt.runs.push({ lane, files: results });
  console.log(`PASS ${lane}: all four files; same length/layout; identical decrypted SHA-256`);
}
try {
  // Native command invocation needs no staged secret files or scratch at all.
  const native = await resolveWasmEdgeBinary();
  const version = await child(native, ['--version']);
  assert.equal(version.code, 0); assertWasmEdgeVersionMatchesPin(version.stdout.toString(), pin, native);
  const output = await child(native, [wasmPath], stdinBytes);
  const normalized = normalizeWasmEdgeOutcome(output);
  assert.equal(output.code, 0, normalized.diagnosticText);
  await verify('wasmedge', normalized.stdout);
  // SDK browser runner always starts exactly one headless Chrome, closes its
  // private HTTP server, kills its own PID and removes its own profile in finally.
  const browser = await runBrowserLane(context);
  for (const run of browser) { assert.equal(run.exitClass, 'ok', run.exitDetail); await verify('browser', run.stdout); }
  assert.deepEqual(receipt.runs.map(run => run.lane), ['wasmedge', 'browser']);
  receipt.verdict = 'PASS';
  fs.writeFileSync(new URL('./parity-receipt.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
  console.log('PASS browser/native WasmEdge parity; Docker WasmEdge WAIVED by owner 2026-10-22');
} finally {
  release.privateKey.fill(0); stdinBytes.fill(0);
  request.inputs.find(x => x.portId === 'release_key').payload.fill(0);
}
