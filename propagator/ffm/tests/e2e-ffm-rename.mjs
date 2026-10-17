// One end-to-end rename gate. Only orchestration and byte comparisons live here;
// the SDK direct browser harness executes all dynamics in the supplied WASM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import * as PLG from 'spacedatastandards.org/lib/js/PLG/main.js';
import * as PRW from 'spacedatastandards.org/lib/js/PRW/main.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { checkTargetingFrameConversion } from '../../../analysis/targeting/tests/ffm-frame-reference.mjs';

const moduleDir = fileURLToPath(new URL('../', import.meta.url));
const checkout = path.resolve(moduleDir, '../..');
const legacyTerm = ['hp', 'op'].join('');
const TYPE = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
const defaultWasm = path.join(moduleDir, 'dist/isomorphic/module.wasm');
const oldCommit = '7e536d80';
const oldArtifactSha256 = 'eb05fc526683d6592a8207319e6b8b3eda582d00d4da273198e6126467732629';
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
  assert.equal(allowlist.binaryBase64MinimumRunLength, 64, 'Binary base64 exemption must require a 64-character run');
  const counts = { files: 0, remaining: 0, history: 0, otherLane: 0, generatedSds: 0, coincidence: 0, skippedCaches: 0, skippedLinks: 0 };
  const samples = [];
  const record = (filename, location, contents, base64RunLength = 0) => {
    if (!contents.toLowerCase().includes(legacyTerm)) return;
    if (matchesPath(filename, allowlist.historyPaths)) { counts.history++; return; }
    if (matchesPath(filename, allowlist.otherLanePaths)) { counts.otherLane++; return; }
    if (matchesPath(filename, allowlist.generatedSdsPaths)) { counts.generatedSds++; return; }
    if (matchesPath(filename, allowlist.coincidentalPaths)) { counts.coincidence++; return; }
    for (const pattern of coincidental) contents = contents.replace(pattern, '');
    if (!contents.toLowerCase().includes(legacyTerm)) { counts.coincidence++; return; }
    if (base64RunLength >= allowlist.binaryBase64MinimumRunLength) {
      counts.coincidence++;
      console.log(`  coincidental base64 match: ${filename}${location}; run length=${base64RunLength}`);
      return;
    }
    counts.remaining++;
    samples.push(`${filename}${location}`);
  };
  const visit = (relative = '') => {
    for (const entry of fs.readdirSync(path.join(checkout, relative), { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { counts.skippedLinks++; continue; }
      if (matchesPath(filename, allowlist.cachePaths)) { counts.skippedCaches++; continue; }
      if (entry.isDirectory()) { record(filename, ' (directory name)', entry.name); visit(filename); continue; }
      if (!entry.isFile()) continue;
      counts.files++;
      record(filename, ' (filename)', entry.name);
      const contents = fs.readFileSync(path.join(checkout, filename));
      const text = contents.toString('latin1');
      if (!text.toLowerCase().includes(legacyTerm)) continue;
      if (contents.includes(0)) {
        let runStart = -1, runEnd = -1;
        for (const match of text.matchAll(new RegExp(legacyTerm, 'gi'))) {
          if (match.index >= runEnd) {
            runStart = match.index;
            runEnd = match.index + match[0].length;
            while (runStart > 0 && /[A-Za-z0-9+/=]/.test(text[runStart - 1])) runStart--;
            while (runEnd < text.length && /[A-Za-z0-9+/=]/.test(text[runEnd])) runEnd++;
          }
          record(filename, ` (binary byte ${match.index})`, text.slice(Math.max(0, match.index - 80), match.index + 84), runEnd - runStart);
        }
      } else {
        text.split('\n').forEach((line, index) => record(filename, `:${index + 1}`, line));
      }
    }
  };
  visit();
  for (const sample of samples) console.log(`  non-exempt legacy name: ${sample}`);
  return {
    pass: counts.remaining === 0,
    evidence: `${path.basename(checkout)}: ${counts.files} worktree files, ${counts.remaining} remaining line/name/binary matches; exemptions: ${counts.history} history, ${counts.otherLane} other-lane, ${counts.generatedSds} generated SDS, ${counts.coincidence} coincidental; skipped ${counts.skippedCaches} dependency/tool-cache entries and ${counts.skippedLinks} symlinks`,
  };
});

await part('(i) response byte identity', async () => {
  const readOldArtifact = () => {
    if (process.env.FFM_OLD_WASM) {
      const contents = fs.readFileSync(path.resolve(moduleDir, process.env.FFM_OLD_WASM));
      console.log(`  old artifact override: ${contents.length} bytes; sha256=${createHash('sha256').update(contents).digest('hex')}`);
      return contents;
    }
    const history = (args) => {
      const result = spawnSync('git', ['-C', checkout, ...args], {
        cwd: checkout, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Read-only artifact history failed: ${result.stderr?.toString('utf8') ?? result.signal}`);
      return result.stdout;
    };
    const commit = history(['rev-parse', '--verify', `${oldCommit}^{commit}`]).toString('utf8').trim();
    assert.match(commit, /^[0-9a-f]{40}$/, 'History must resolve to an exact commit SHA');
    assert.ok(commit.startsWith(oldCommit), 'Resolved commit must match the recorded short SHA');
    const contents = history(['show', `${commit}:propagator/${legacyTerm}/dist/isomorphic/module.wasm`]);
    const checksum = createHash('sha256').update(contents).digest('hex');
    assert.equal(checksum, oldArtifactSha256, 'Historical artifact checksum differs from the authenticated pre-rename build');
    console.log(`  old artifact history: ${commit}; ${contents.length} bytes; sha256=${checksum}`);
    return contents;
  };
  const newPath = path.resolve(moduleDir, process.env.FFM_NEW_WASM ?? defaultWasm);
  const requestDir = path.resolve(moduleDir, process.env.FFM_REQUESTS ?? 'tests/fixtures/ffm-e2e-requests');
  const wasm = [readOldArtifact(), fs.readFileSync(newPath)];
  const embeddedIdentity = (contents) => {
    for (let offset = contents.indexOf('$PLG'); offset >= 0; offset = contents.indexOf('$PLG', offset + 1)) {
      try {
        const manifest = PLG.PLG.getRootAsPLG(new flatbuffers.ByteBuffer(contents.subarray(offset - 4))).unpack();
        if (manifest.PLUGIN_ID && manifest.VERSION) return `${manifest.PLUGIN_ID}@${manifest.VERSION}`;
      } catch { /* A schema identifier string is not necessarily an embedded manifest. */ }
    }
    return 'embedded identity unavailable';
  };
  const identities = wasm.map(embeddedIdentity);
  const manifest = JSON.parse(fs.readFileSync(path.join(moduleDir, 'plugin-manifest.json'), 'utf8'));
  assert.equal(identities[1], `${manifest.pluginId}@${manifest.version}`, 'New embedded manifest must match the authoring manifest');
  const moduleIds = [identities[0].split('@')[0], manifest.pluginId];
  assert.ok(moduleIds[0].startsWith('com.'), 'Old embedded module identity is unavailable');
  const decode = (payload) => PRW.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(payload)).unpack();
  const pack = (record) => {
    const builder = new flatbuffers.Builder();
    PRW.PRW.finishSizePrefixedPRWBuffer(builder, record.pack(builder));
    return Buffer.from(builder.asUint8Array());
  };
  const residentFor = (payload, moduleId) => {
    const record = decode(payload);
    const arm = ['RESIDENT_STATE', 'PREPARE_REQUEST', 'DESCRIBE_REQUEST'].find((name) => record[name]?.INSTANCE);
    assert.ok(arm, 'Resident request must carry an explicit PRW instance');
    record[arm].INSTANCE.MODULE_ID = moduleId;
    return pack(record);
  };
  const fieldPath = (keys) => keys.reduce((result, key) => /^\d+$/.test(key) ? `${result}[${key}]` : `${result}.${key}`, 'PRW');
  const decodedDifferences = (oldValue, newValue, keys = []) => {
    if (isDeepStrictEqual(oldValue, newValue)) return [];
    if (oldValue && newValue && typeof oldValue === 'object' && typeof newValue === 'object'
        && Object.getPrototypeOf(oldValue) === Object.getPrototypeOf(newValue)) {
      const fields = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
      if (Array.isArray(oldValue)) fields.add('length');
      return [...fields].flatMap((key) => {
        const childKeys = [...keys, key];
        if (Object.hasOwn(oldValue, key) !== Object.hasOwn(newValue, key))
          return [{ keys: childKeys, oldValue: oldValue[key], newValue: newValue[key] }];
        return decodedDifferences(oldValue[key], newValue[key], childKeys);
      });
    }
    return [{ keys, oldValue, newValue }];
  };
  const renameComment = (value) => [
    [`com.orbpro.${legacyTerm}`, 'com.orbpro.ffm'],
    [legacyTerm.toUpperCase(), 'FFM'], [legacyTerm, 'ffm'],
    [legacyTerm[0].toUpperCase() + legacyTerm.slice(1), 'Ffm'],
  ].reduce((text, [oldName, newName]) => text.replaceAll(oldName, newName), value);
  const differenceKind = ({ keys, oldValue, newValue }) => {
    // The module's own identity: INSTANCE.MODULE_ID carries the id, EPHEMERIS_SOURCE "<id>@<version>".
    const identityField = (keys.at(-2) === 'INSTANCE' && keys.at(-1) === 'MODULE_ID') || keys.at(-1) === 'EPHEMERIS_SOURCE';
    if (identityField && typeof oldValue === 'string' && typeof newValue === 'string'
        && oldValue.includes(moduleIds[0]) && oldValue.replaceAll(moduleIds[0], moduleIds[1]) === newValue) return 'identity';
    const comment = keys.at(-1) === 'COMMENT'
      || (keys.at(-2) === 'COMMENT' && /^\d+$/.test(keys.at(-1)));
    if (comment && typeof oldValue === 'string' && typeof newValue === 'string'
        && renameComment(oldValue) === newValue) return 'comment';
    return 'disallowed';
  };
  const validateInstances = (record, moduleId, keys = []) => {
    if (!record || typeof record !== 'object') return;
    for (const [key, value] of Object.entries(record)) {
      if (key === 'INSTANCE' && value)
        assert.equal(value.MODULE_ID, moduleId, `${fieldPath([...keys, key, 'MODULE_ID'])} must match its manifest`);
      validateInstances(value, moduleId, [...keys, key]);
    }
  };
  const setField = (record, keys, value) => {
    const parent = keys.slice(0, -1).reduce((item, key) => item[key], record);
    parent[keys.at(-1)] = value;
  };
  const files = fs.readdirSync(requestDir).filter((name) => name.endsWith('.prw')).sort();
  const skipped = files.filter((name) => fs.statSync(path.join(requestDir, name)).size > 2_000_000);
  const available = files.filter((name) => !skipped.includes(name));
  const invokeFiles = available.filter((name) => /^(?:ffm-)?invoke-.+\.prw$/.test(name));
  const expectedSeeds = ['GEO', 'GPS', 'GTO', 'ISS', 'LOW250', 'MOLNIYA', 'SSO800', 'STARLINK'];
  assert.deepEqual(invokeFiles.map((name) => name.replace(/^(?:ffm-)?invoke-/, '').replace(/\.prw$/, '')).sort(), expectedSeeds,
    `All eight invoke seeds are required; skipped >2 MB: ${skipped.join(', ') || 'none'}`);
  const fixture = (stem) => {
    const filename = [`ffm-${stem}.prw`, `${stem}.prw`].find((name) => available.includes(name));
    assert.ok(filename, `Missing ${stem}.prw; skipped >2 MB: ${skipped.join(', ') || 'none'}`);
    return new Uint8Array(fs.readFileSync(path.join(requestDir, filename)));
  };
  const port = (portId, payload) => ({ portId, typeRef: TYPE, payload });
  const environment = ['kernel', 'earth_orientation', 'space_weather'].map((name) => port(name, fixture(name)));
  const load = (index) => createBrowserModuleHarness({ wasmSource: wasm[index], manifest: { ...manifest, pluginId: moduleIds[index] }, surface: 'direct' });
  let pairs = 0, bytes = 0;
  const methods = new Map();
  const digest = createHash('sha256');
  let seedDigest, seedIdentity, seedComment;
  const compare = async (hosts, methodId, inputs, seed) => {
    const responses = [];
    for (let index = 0; index < hosts.length; index++) {
      const response = await hosts[index].invoke({ methodId, inputs: typeof inputs === 'function' ? inputs(index) : inputs });
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
      const records = [decode(oldBytes), decode(newBytes)];
      const rawIdentical = oldBytes.equals(newBytes);
      const differences = decodedDifferences(records[0], records[1]).map((difference) => ({
        ...difference, kind: differenceKind(difference),
      }));
      for (const difference of differences) {
        const show = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
        const detail = difference.kind === 'disallowed'
          ? `; old=${show(difference.oldValue)}, new=${show(difference.newValue)}` : '';
        console.log(`  ${seed} ${methodId} response ${index}: ${fieldPath(difference.keys)} (${difference.kind})${detail}`);
      }
      const invalid = differences.filter(({ kind }) => kind === 'disallowed');
      if (invalid.length) {
        let offset = 0;
        while (offset < Math.min(oldBytes.length, newBytes.length) && oldBytes[offset] === newBytes[offset]) offset++;
        assert.fail(`${seed} ${methodId}: fields outside the rename exception: ${invalid.map(({ keys }) => fieldPath(keys)).join(', ')}; first raw difference at byte ${offset}`);
      }
      records.forEach((record, side) => validateInstances(record, moduleIds[side]));
      // Only the approved differing fields are set to the new values. Every
      // other decoded field and the full re-packed wire format stay strict.
      for (const { keys, newValue, kind } of differences) {
        for (const record of records) setField(record, keys, newValue);
        if (kind === 'identity') seedIdentity = true;
        if (kind === 'comment') seedComment = true;
      }
      const compared = records.map(pack);
      if ((!differences.length && !rawIdentical) || !isDeepStrictEqual(records[0], records[1]) || !compared[0].equals(compared[1])) {
        let offset = 0;
        while (offset < Math.min(oldBytes.length, newBytes.length) && oldBytes[offset] === newBytes[offset]) offset++;
        const start = Math.max(0, offset - 16), end = offset + 8;
        const context = (buffer) => `${buffer.subarray(start, end).toString('hex')} (${JSON.stringify(buffer.subarray(start, end).toString('latin1')).replace(/[\u007f-\u00ff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)})`;
        assert.fail(`${seed} ${methodId}: response ${index} differs beyond the approved rename (${oldBytes.length}/${newBytes.length} bytes); first raw difference at byte ${offset}; old[${start}:${end}]=${context(oldBytes)}; new[${start}:${end}]=${context(newBytes)}`);
      }
      digest.update(compared[0]);
      seedDigest.update(compared[0]);
      bytes += compared[0].length;
    }
    pairs++;
    methods.set(methodId, (methods.get(methodId) ?? 0) + 1);
  };
  const seeds = [];
  for (const filename of invokeFiles) {
    const seed = filename.replace(/^(?:ffm-)?invoke-/, '').replace(/\.prw$/, '');
    seeds.push(seed);
    seedDigest = createHash('sha256');
    seedIdentity = seedComment = false;
    const request = Object.fromEntries(['state', 'config', 'prepare', 'describe', 'invoke'].map((kind) => [kind, fixture(`${kind}-${seed}`)]));
    // Same call sequence as the supplied interval harness: configured resident
    // ingest -> prepare -> describe, then stateless invoke in fresh instances.
    const resident = [];
    try {
      resident.push(await load(0)); resident.push(await load(1));
      await compare(resident, 'ingest_state', (index) => [port('state', residentFor(request.state, moduleIds[index])), port('configuration', request.config), ...environment], seed);
      await compare(resident, 'prepare_trajectory_segments', (index) => [port('request', residentFor(request.prepare, moduleIds[index]))], seed);
      await compare(resident, 'describe_trajectory_segments', (index) => [port('request', residentFor(request.describe, moduleIds[index]))], seed);
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
    console.log(`  ${seed}: ${seedComment ? 'identity+comment' : seedIdentity ? 'identity-only' : 'raw-identical'}; re-packed sha256=${seedDigest.digest('hex')}`);
  }
  assert.equal(pairs, expectedSeeds.length * 4, 'Every seed must complete all four paired calls');
  for (const method of ['ingest_state', 'prepare_trajectory_segments', 'describe_trajectory_segments', 'invoke'])
    assert.equal(methods.get(method), expectedSeeds.length, `Every seed must complete ${method}`);
  return {
    pass: true,
    evidence: `${seeds.length} seeds (${seeds.join(',')}), ${pairs} successful paired calls (${[...methods].map(([method, count]) => `${method}=${count}`).join(',')}), ${bytes} response bytes identical after exact identity/COMMENT normalization; responses without allowed differences are raw-identical; sha256=${digest.digest('hex')}; old/new artifacts: ${identities.join(' -> ')}; skipped >2 MB: ${skipped.join(', ') || 'none'}`,
  };
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

await part('(v) targeting ECEF->GCRF', () => checkTargetingFrameConversion({
  workDir: path.join(checkout, '.ffm-rename-work/second-followup/tmp'),
}));

process.exitCode = failed ? 1 : 0;
