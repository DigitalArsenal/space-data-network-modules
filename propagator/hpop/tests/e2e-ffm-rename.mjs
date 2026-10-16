// One end-to-end rename gate. Only orchestration and byte comparisons live here;
// the SDK direct browser harness executes all dynamics in the supplied WASM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

const moduleDir = fileURLToPath(new URL('../', import.meta.url));
const checkout = path.resolve(moduleDir, '../..');
const legacyTerm = ['hp', 'op'].join('');
const TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
const defaultWasm = path.join(moduleDir, 'dist/isomorphic/module.wasm');
const concise = (text) => String(text).replace(/\s+/g, ' ').trim();
let failed = false;

async function part(label, run) {
  try {
    const result = await run();
    if (!result.pass) failed = true;
    console.log(`${label} ${result.pass ? 'PASS' : 'FAIL'} ${concise(result.evidence)}`);
  } catch (error) {
    failed = true;
    console.log(`${label} FAIL ${concise(error.message)}`);
  }
}

await part('(iii) profile', () => {
  const result = spawnSync(process.execPath, [path.join(moduleDir, 'tests/ffm-profile-check.mjs')], {
    cwd: moduleDir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    pass: result.status === 0 && /FFM profile check: PASS/.test(result.stdout),
    evidence: [result.stdout, result.stderr, result.signal && `signal=${result.signal}`].filter(Boolean).join(' '),
  };
});

await part('(ii) repository names', () => {
  const allowlist = JSON.parse(fs.readFileSync(new URL('./ffm-history-allowlist.json', import.meta.url), 'utf8'));
  const matchesPath = (name, patterns) => patterns.some((pattern) =>
    path.matchesGlob(pattern.includes('/') ? name : path.basename(name), pattern));
  const coincidental = allowlist.coincidentalPatterns.map((pattern) => new RegExp(pattern, 'gi'));
  const repositories = new Map([[checkout, path.basename(checkout)]]);
  for (const entry of (process.env.FFM_REPOS ?? '').split(',').filter(Boolean)) {
    const equals = entry.indexOf('=');
    if (equals <= 0 || !entry.slice(equals + 1).trim()) throw new Error(`Invalid FFM_REPOS entry: ${entry}`);
    repositories.set(path.resolve(checkout, entry.slice(equals + 1).trim()), entry.slice(0, equals).trim());
  }
  let remaining = 0;
  const evidence = [];
  for (const [directory, name] of repositories) {
    // Git is deliberately confined to this requested E2E audit, against HEAD.
    const result = spawnSync('git', ['grep', '-n', '-i', legacyTerm, 'HEAD'], {
      cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_PAGER: 'cat' },
    });
    if (result.error) throw result.error;
    if (![0, 1].includes(result.status)) throw new Error(`${name}: git grep exited ${result.status}: ${result.stderr}`);
    let disallowed = 0, history = 0, coincidence = 0;
    const samples = [];
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const textMatch = /^HEAD:(.*?):(\d+):(.*)$/.exec(line);
      const binaryMatch = /^Binary file HEAD:(.*?) matches$/.exec(line);
      if (!textMatch && !binaryMatch) throw new Error(`${name}: unrecognized git grep output: ${line}`);
      const filename = textMatch?.[1] ?? binaryMatch[1];
      if (matchesPath(filename, allowlist.historyPaths)) { history++; continue; }
      if (matchesPath(filename, allowlist.coincidentalPaths)) { coincidence++; continue; }
      let content = textMatch?.[3] ?? legacyTerm;
      for (const pattern of coincidental) content = content.replace(pattern, '');
      if (!content.toLowerCase().includes(legacyTerm)) { coincidence++; continue; }
      disallowed++;
      if (samples.length < 2) samples.push(`${filename}${textMatch ? `:${textMatch[2]}` : ' (binary)'}`);
    }
    remaining += disallowed;
    evidence.push(`${name}: ${disallowed} remaining lines, ${history} history, ${coincidence} coincidental${samples.length ? `; e.g. ${samples.join(', ')}` : ''}`);
  }
  const pending = fs.existsSync(path.join(checkout, 'propagator', legacyTerm));
  return { pass: remaining === 0, evidence: `${evidence.join(' | ')}${remaining && pending ? '; expected FAIL before the rename' : ''}` };
});

await part('(i) response byte identity', async () => {
  const oldSet = Boolean(process.env.FFM_OLD_WASM), newSet = Boolean(process.env.FFM_NEW_WASM);
  if (oldSet !== newSet) throw new Error('Set both FFM_OLD_WASM and FFM_NEW_WASM, or neither.');
  const oldPath = path.resolve(moduleDir, process.env.FFM_OLD_WASM ?? defaultWasm);
  const newPath = path.resolve(moduleDir, process.env.FFM_NEW_WASM ?? defaultWasm);
  const requestDir = path.resolve(moduleDir, process.env.FFM_REQUESTS ?? 'tests/fixtures/ffm-e2e-requests');
  const wasm = [fs.readFileSync(oldPath), fs.readFileSync(newPath)];
  const manifest = JSON.parse(fs.readFileSync(path.join(moduleDir, 'plugin-manifest.json'), 'utf8'));
  const files = fs.readdirSync(requestDir).filter((name) => name.endsWith('.prw')).sort();
  const skipped = files.filter((name) => fs.statSync(path.join(requestDir, name)).size > 2_000_000);
  const available = files.filter((name) => !skipped.includes(name));
  const invokeFiles = available.filter((name) => /^(?:ffm-)?invoke-.+\.prw$/.test(name));
  assert.ok(invokeFiles.length, `No invoke request seeds in ${requestDir}; skipped >2 MB: ${skipped.join(', ') || 'none'}`);
  const fixture = (stem) => {
    const filename = [`ffm-${stem}.prw`, `${stem}.prw`].find((name) => available.includes(name));
    assert.ok(filename, `Missing ${stem}.prw; skipped >2 MB: ${skipped.join(', ') || 'none'}`);
    return new Uint8Array(fs.readFileSync(path.join(requestDir, filename)));
  };
  const port = (portId, payload) => ({ portId, typeRef: TYPE, payload });
  const environment = ['kernel', 'earth_orientation', 'space_weather'].map((name) => port(name, fixture(name)));
  const load = (index) => createBrowserModuleHarness({ wasmSource: wasm[index], manifest, surface: 'direct' });
  let pairs = 0, bytes = 0;
  const digest = createHash('sha256');
  const compare = async (hosts, methodId, inputs, seed) => {
    const responses = [];
    for (let index = 0; index < hosts.length; index++) {
      const response = await hosts[index].invoke({ methodId, inputs });
      assert.equal(response.statusCode, 0, `${seed} ${index ? 'new' : 'old'} ${methodId}: ${response.errorCode}: ${response.errorMessage}`);
      responses.push(response);
    }
    const [oldResponse, newResponse] = responses;
    assert.equal(newResponse.outputs.length, oldResponse.outputs.length, `${seed} ${methodId}: output count`);
    if (methodId !== 'ingest_state') assert.ok(oldResponse.outputs.length, `${seed} ${methodId}: no response payload`);
    for (let index = 0; index < oldResponse.outputs.length; index++) {
      const oldOutput = oldResponse.outputs[index], newOutput = newResponse.outputs[index];
      assert.equal(newOutput.portId, oldOutput.portId, `${seed} ${methodId}: output port`);
      assert.deepEqual(newOutput.typeRef, oldOutput.typeRef, `${seed} ${methodId}: output type`);
      const oldBytes = Buffer.from(oldOutput.payload), newBytes = Buffer.from(newOutput.payload);
      assert.ok(oldBytes.equals(newBytes), `${seed} ${methodId}: response ${index} bytes differ (${oldBytes.length}/${newBytes.length} bytes)`);
      digest.update(oldBytes);
      bytes += oldBytes.length;
    }
    pairs++;
  };
  const seeds = [];
  for (const filename of invokeFiles) {
    const seed = filename.replace(/^(?:ffm-)?invoke-/, '').replace(/\.prw$/, '');
    seeds.push(seed);
    const request = Object.fromEntries(['state', 'config', 'prepare', 'describe', 'invoke'].map((kind) => [kind, fixture(`${kind}-${seed}`)]));
    // Same call sequence as the supplied interval harness: configured resident
    // ingest -> prepare -> describe, then stateless invoke in fresh instances.
    const resident = [];
    try {
      resident.push(await load(0)); resident.push(await load(1));
      await compare(resident, 'ingest_state', [port('state', request.state), port('configuration', request.config), ...environment], seed);
      await compare(resident, 'prepare_trajectory_segments', [port('request', request.prepare)], seed);
      await compare(resident, 'describe_trajectory_segments', [port('request', request.describe)], seed);
    } finally {
      for (const host of resident) await host.destroy();
    }
    const stateless = [];
    try {
      stateless.push(await load(0)); stateless.push(await load(1));
      await compare(stateless, 'invoke', [port('request', request.invoke), ...environment], seed);
    } finally {
      for (const host of stateless) await host.destroy();
    }
  }
  return { pass: true, evidence: `${seeds.length} seeds (${seeds.join(',')}), ${pairs} paired calls, ${bytes} response bytes identical; sha256=${digest.digest('hex')}; ${oldSet ? 'old/new artifacts' : 'same artifact (pre-rename)'}; skipped >2 MB: ${skipped.join(', ') || 'none'}` };
});

await part('(iv) artifact scan', () => {
  let total = 0;
  const evidence = ['dist/isomorphic/module.wasm', 'dist/browser/module.js'].map((filename) => {
    const contents = fs.readFileSync(path.join(moduleDir, filename)).toString('latin1');
    const count = [...contents.matchAll(new RegExp(legacyTerm, 'gi'))].length;
    total += count;
    return `${filename}=${count}`;
  });
  const pending = fs.existsSync(path.join(checkout, 'propagator', legacyTerm));
  return { pass: total === 0, evidence: `${evidence.join(', ')} occurrences${total && pending ? '; expected FAIL before the rename' : ''}` };
});

process.exitCode = failed ? 1 : 0;
