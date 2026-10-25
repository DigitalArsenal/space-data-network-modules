#!/usr/bin/env node
// Earth equivalence: the Earth's results of this tree's artifact against a reference tree's (modules main), byte for byte.
//
//   node tests/earth-equivalence.mjs digest [lane [base|edit|edit-subset|redo]]
//                                                         hash the responses on the lane (browser, the default, or wasmedge)
//                                                         into .sdk-build/earth-digest.json of this tree: `base`, the 72
//                                                         Orekit cases, their final-epoch-only variants and the GMAT/Tudat/
//                                                         Nyx/Orekit cross-validation requests; `edit`, the answers (accepted,
//                                                         or refused with the text) to some two thousand edits of three Earth
//                                                         requests: each field of the force model, the integrator, the initial
//                                                         state and the request set one at a time to values it accepts and
//                                                         values it must refuse, and each input left out. Base and edit by
//                                                         default. On WasmEdge, two orders of magnitude slower than V8, run
//                                                         `edit-subset`: every edit the browser digest of this tree has the
//                                                         module refuse (a refusal costs nothing) and every tenth it accepts.
//                                                         `redo` asks again (EARTH_DIGEST_TIMEOUT_MS) the base requests whose
//                                                         answer on the lane was recorded as not given in time.
//   node tests/earth-equivalence.mjs compare <ffm dir>    compare those digests and the parity receipts (the SDK parity plans
//                                                         and the resident stateful run, tests/evidence) of this tree with
//                                                         the same files of the reference tree's propagator/ffm, and the two
//                                                         lanes with each other inside each tree; print the table; write
//                                                         tests/evidence/earth-equivalence.json when every response is
//                                                         identical (a difference exits 1 and writes nothing)
//
// Run `digest` and the parity scripts in each tree first: each tree runs its own artifact. The digest's browser lane is the
// SDK's browser host (createBrowserModuleHarness, the WASI shim and the module under V8) in this process; the parity
// receipts' browser lane is the same host in Chromium's headless shell. Every parity receipt records both lanes, so the lanes
// are compared with each other inside each tree as well.
// Conformance tooling: it hashes bytes and does no physics.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERENCE as OREKIT, requestInputs } from './lib/orekitCases.mjs';
import { residentHarness } from './lib/residentRuntime.mjs';
import { CASES as XVAL_CASES, TOOLS as XVAL_TOOLS, ffmInputs } from './lib/xvalCases.mjs';

const ffm = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestPath = (dir) => path.join(dir, '.sdk-build/earth-digest.json');

// ---- digest -------------------------------------------------------------------------------------------------------
// The edits: one request of the Earth, one field at a time. `base` is an Orekit case cut to ten minutes (the same code paths
// as its full day), `shape` the request as it is built, whose own fields name what can be edited.
const TIMEOUT_MS = Number(process.env.EARTH_DIGEST_TIMEOUT_MS ?? 120000);
const NUMBERS = [-1, 0, 1, 2, 3, 5, 8, 255, 1e30, NaN];
const NESTED = [NaN, -1, 0, 1e30];
const BODY_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 199, 299, 399, 301, 401, 499, 599, 999];
const STRINGS = ['', 'Analytical', 'JPL_SPK', 'bogus'];
const plus = (iso, seconds) => new Date(Date.parse(`${iso}Z`) + seconds * 1000).toISOString().replace('Z', '');
const tenMinutes = (c) => ({ ...c, samples: [c.samples[0], ...[300, 600].map((t) => [t, 0, 0, 0, 0, 0, 0, plus(c.samples[0][7], t)])] });
const label = (v) => (typeof v === 'bigint' ? `${v}n` : Array.isArray(v) ? `[${v.map(label)}]` : String(v));

function* valuesFor(v, nested) {
  if (typeof v === 'number') yield* (nested ? NESTED : NUMBERS);
  else if (typeof v === 'boolean') yield !v;
  else if (typeof v === 'bigint') yield* [0n, 1n, 2n ** 63n];
  else if (typeof v === 'string' || v === null) { if (typeof v === 'string') yield* STRINGS; }
  else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
    yield [];
    for (const x of (nested ? NESTED : NUMBERS)) yield [x];
    yield [...v, 1];
  }
}
// [path of keys, value] over the plain tables below the request, to depth three; a table is also left out (set null).
function* edits(table, trail = [], depth = 0) {
  for (const key of Object.keys(table)) {
    const v = table[key];
    if (depth === 0 && key === 'FORCES') { yield [['FORCES'], null]; yield* edits(v, ['FORCES'], 1); continue; }
    // What the planetary changes add is not the Earth's to compare: the central body, the third body's field, the Moon's and
    // Mars's field and atmosphere selections (their refusals about the Earth are worded for them).
    if (key.startsWith('CENTRAL_BODY') || key.startsWith('THIRD_BODY_MAXIMUM_')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)) {
      yield [[...trail, key], null];
      if (depth < 3) yield* edits(v, [...trail, key], depth + 1);
      continue;
    }
    for (const x of valuesFor(v, depth > 1)) {
      if ((key === 'GRAVITY_CHOICE' && (x === 7 || x === 8)) || (key === 'ATMOSPHERE_MODEL' && x === 7)) continue;
      yield [[...trail, key], x];
    }
    if (key === 'THIRD_BODY_IDS') for (const id of BODY_IDS) yield [[...trail, key], [id]];
  }
}
function setAt(object, trail, value) {
  let at = object;
  for (const key of trail.slice(0, -1)) at = at[key];
  at[trail.at(-1)] = value;
}
function editedRequests() {
  const find = (orbit, prefix) => OREKIT.cases.find((c) => c.orbit === orbit && c.forces.startsWith(prefix));
  const bases = [['leo-full', find('LEO400', 'C2')], ['gps-srp', find('GPS', 'C2')], ['leo-jb2008', find('LEO400', 'J1')]];
  const out = [];
  for (const [name, c] of bases) {
    const base = tenMinutes(c);
    let shape;
    const plain = requestInputs(base, { edit: (exec) => { shape = exec; } });
    for (const [trail, value] of edits(shape)) {
      let inputs;
      try { inputs = requestInputs(base, { edit: (exec) => setAt(exec, trail, value) }); } catch { continue; }  // the encoder refuses it: nothing is sent
      out.push([`edit/${name}/${trail.join('.')}=${label(value)}`, inputs]);
    }
    for (let i = 1; i < plain.length; i++) out.push([`edit/${name}/without ${plain[i].portId}`, plain.filter((_, j) => j !== i)]);
    out.push([`edit/${name}/kernel and weather inputs reversed`, [plain[0], ...plain.slice(1).reverse()]]);
  }
  return out;
}

async function digest(lane = 'browser', groups = 'all') {
  assert(['browser', 'wasmedge'].includes(lane), `unknown lane ${lane}`);
  assert(['all', 'base', 'edit', 'edit-subset', 'redo'].includes(groups), `unknown group ${groups}`);
  const wasm = fs.readFileSync(path.join(ffm, 'dist/isomorphic/module.wasm'));
  const requests = [];
  if (['all', 'base', 'redo'].includes(groups)) {
    for (const c of OREKIT.cases) requests.push([`orekit/${c.orbit} ${c.forces}`, requestInputs(c)]);
    for (const c of OREKIT.cases) if (!c.parameters) requests.push([`orekit-final-epoch/${c.orbit} ${c.forces}`, requestInputs(c, { edit: (exec) => { exec.SAMPLE_EPOCHS = []; } })]);
    const seen = new Set();
    for (const name of XVAL_CASES) {
      for (const tool of XVAL_TOOLS) {
        const c = tool.cases.get(name);
        if (!c) continue;
        const inputs = ffmInputs(c), key = sha(Buffer.concat(inputs.map((i) => Buffer.concat([Buffer.from(i.portId), Buffer.from(i.payload)]))));
        if (seen.has(key)) continue;
        seen.add(key);
        requests.push([`xval/${name}/${c.atmosphere ?? 'NRLMSISE00'}`, inputs]);
      }
    }
  }
  if (groups === 'redo') {
    const held = fs.existsSync(digestPath(ffm)) ? JSON.parse(fs.readFileSync(digestPath(ffm), 'utf8')) : null;
    assert(held?.artifactSha256 === sha(wasm) && held.lanes[lane], `digest the ${lane} lane of this artifact first`);
    const again = requests.splice(0).filter(([name]) => held.lanes[lane][name]?.thrown);
    requests.push(...again);
    console.log(`redo: ${again.length} requests of the ${lane} lane`);
  } else if (groups === 'edit-subset') {
    const held = fs.existsSync(digestPath(ffm)) ? JSON.parse(fs.readFileSync(digestPath(ffm), 'utf8')) : null;
    assert(held?.artifactSha256 === sha(wasm) && held.lanes.browser, 'digest the browser lane of this artifact first');
    let accepted = 0;
    for (const request of editedRequests()) {
      const answer = held.lanes.browser[request[0]];
      if (!answer) continue;
      if (answer.status !== 0 || answer.thrown || accepted++ % 10 === 0) requests.push(request);
    }
  } else if (groups !== 'base') requests.push(...editedRequests());
  const out = { artifactSha256: sha(wasm), lane, responses: {} };
  // A fresh instance for every request, taken in a fixed order by a fixed worker: nothing one request leaves behind can reach
  // another, and two runs of the same artifact give the same digest.
  const workers = Number(process.env.EARTH_DIGEST_WORKERS ?? 8);
  const worker = async (w) => {
    for (let i = w; i < requests.length; i += workers) {
      const [name, inputs] = requests[i];
      const harness = await residentHarness(lane);
      let timer;
      try {
        // A request the host never answers (the module trapped under the interpreter) is recorded as such, not waited for.
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS); });
        const response = await Promise.race([harness.invoke({ methodId: 'invoke', inputs }), timeout]);
        out.responses[name] = {
          status: response.statusCode, error: response.errorCode ?? '', message: response.errorMessage ?? '',
          outputs: response.outputs.map((o) => ({ port: o.portId, bytes: o.payload.length, sha256: sha(o.payload) })),
        };
      } catch (error) {
        out.responses[name] = { thrown: String(error?.message ?? error).slice(0, 300) };
        if (/no answer/.test(out.responses[name].thrown)) console.error(`${lane}: ${name}: ${out.responses[name].thrown}`);
      } finally {
        clearTimeout(timer);
        await Promise.race([harness.destroy().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10000))]);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
  out.responses = Object.fromEntries(Object.entries(out.responses).sort(([a], [b]) => (a < b ? -1 : 1)));
  const file = digestPath(ffm);
  const held = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const lanes = held?.artifactSha256 === out.artifactSha256 && held.lanes ? held.lanes : {};
  lanes[lane] = { ...lanes[lane], ...out.responses };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ artifactSha256: out.artifactSha256, lanes }, null, 1)}\n`);
  console.log(`digest: ${Object.keys(out.responses).length} responses of ${out.artifactSha256.slice(0, 16)} on ${lane} -> ${path.relative(process.cwd(), file)}`);
}

// ---- compare ------------------------------------------------------------------------------------------------------
const load = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const RECEIPTS = [
  'tests/evidence/lane13/prw-parity.json', 'tests/evidence/lane13/variational-parity.json', 'tests/evidence/lane13/finite-burn-parity.json',
  'tests/evidence/lane13/kernel-parity.json', 'tests/evidence/gnss-srp/prw-gnss-parity.json', 'tests/evidence/earth-radiation-tides/prw-earth-radiation-tides-parity.json',
];
// key -> the fields that must match, for each kind of record
const parityRows = (r) => new Map(r.runs.map((x) => [`${x.lane}/${x.caseId}/${x.threadCount}`, `${x.exitClass} ${x.stdoutLength} ${x.stdoutSha256}`]));
const laneRows = (r, lane) => new Map(r.runs.filter((x) => x.lane === lane).map((x) => [`${x.caseId}/${x.threadCount}`, `${x.exitClass} ${x.stdoutLength} ${x.stdoutSha256}`]));
const residentRows = (r) => new Map(r.steps.map((x) => [`${x.group}/${x.label}`, `${x.errorCode} ${x.bytes} ${x.responseSha256}`]));
const digestRows = (responses) => new Map(Object.entries(responses).map(([k, v]) => [k, JSON.stringify(v)]));

// Parity cases whose request carries an impulse. An impulse's time is seconds on the integration clock since
// modules-ffm-sample-epoch-impulse-drop-20261025 (a Julian date cannot carry it to better than 40 us, and the labels are TDB where the arc
// runs on TT), so these answer differently from the reference by design; the impulse E2Es hold them to the closed form
// (start-epoch-impulse.e2e.mjs, sample-epoch-impulse.e2e.mjs). Every other request, Earth arcs without impulses, must be identical.
const CARRIES_AN_IMPULSE = new Set(['RTN-impulse']);
const withoutImpulses = (rows, excluded) => new Map([...rows].filter(([k]) => { const hit = CARRIES_AN_IMPULSE.has(k.split('/')[1]); if (hit) excluded.add(k.split('/')[1]); return !hit; }));

function compareMaps(name, a, b, groups) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let identical = 0;
  const different = [];
  for (const k of keys) { if (a.get(k) !== undefined && a.get(k) === b.get(k)) identical++; else different.push(k); }
  groups.push({ name, compared: keys.size, identical, different });
}

function compare(referenceDir) {
  const reference = path.resolve(referenceDir);
  const groups = [], notes = [], excluded = new Set();
  const refDigest = load(reference, '.sdk-build/earth-digest.json'), digestHere = load(ffm, '.sdk-build/earth-digest.json');
  const refSha = sha(fs.readFileSync(path.join(reference, 'dist/isomorphic/module.wasm'))), here = sha(fs.readFileSync(path.join(ffm, 'dist/isomorphic/module.wasm')));
  assert.equal(refDigest.artifactSha256, refSha, 'the reference digest is of another artifact than the reference tree holds');
  assert.equal(digestHere.artifactSha256, here, 'this tree\'s digest is of another artifact than the tree holds: run digest again');
  assert.notEqual(refSha, here, 'the reference and this tree hold the same artifact');
  const lanesOf = (d) => Object.keys(d.lanes).sort();
  assert.deepEqual(lanesOf(refDigest), lanesOf(digestHere), 'the two trees digested different lanes');
  assert(lanesOf(digestHere).includes('browser'), 'no browser digest: run digest');
  for (const lane of lanesOf(digestHere)) {
    for (const group of ['orekit/', 'orekit-final-epoch/', 'xval/', 'edit/']) {
      const pick = (d) => new Map([...digestRows(d.lanes[lane])].filter(([k]) => k.startsWith(group)));
      assert(pick(refDigest).size > 0 && pick(digestHere).size > 0, `no ${group} responses on the ${lane} lane: run digest ${lane}`);
      compareMaps(`${group.slice(0, -1)} responses (${lane}), reference against this tree`, pick(refDigest), pick(digestHere), groups);
    }
  }
  if (lanesOf(digestHere).includes('wasmedge')) {
    const unanswered = (d) => Object.entries(d.lanes.wasmedge).filter(([, v]) => v.thrown).map(([k]) => k).sort();
    assert.deepEqual(unanswered(refDigest), unanswered(digestHere), 'the two trees leave different requests unanswered on WasmEdge');
    for (const [name, d] of [['reference', refDigest], ['this tree', digestHere]]) {
      const native = new Map([...digestRows(d.lanes.wasmedge)].filter(([k]) => !unanswered(d).includes(k)));
      compareMaps(`orekit, xval and edited-request responses, browser against WasmEdge (${name})`, new Map([...digestRows(d.lanes.browser)].filter(([k]) => native.has(k))), native, groups);
    }
    for (const k of unanswered(digestHere)) notes.push(`WasmEdge gave no answer (the host's wait ended) in both trees, V8 answers ${JSON.stringify(digestHere.lanes.browser[k]?.error ?? digestHere.lanes.browser[k])}: ${k}`);
  }
  for (const file of RECEIPTS) {
    const a = load(reference, file), b = load(ffm, file);
    assert.equal(a.artifactSha256 ?? a.moduleSha256, refSha, `${file}: the reference receipt is of another artifact`);
    assert.equal(b.artifactSha256 ?? b.moduleSha256, here, `${file}: this tree's receipt is of another artifact: run its script again`);
    assert.deepEqual(a.lanes.map((l) => l.lane), ['browser', 'wasmedge'], `${file}: the reference receipt has lanes ${a.lanes.map((l) => l.lane)}`);
    compareMaps(`${path.basename(file, '.json')} (browser, WasmEdge x 1/2/4/8 workers), reference against this tree`, withoutImpulses(parityRows(a), excluded), withoutImpulses(parityRows(b), excluded), groups);
    compareMaps(`${path.basename(file, '.json')}, browser against WasmEdge (this tree)`, laneRows(b, 'browser'), laneRows(b, 'wasmedge'), groups);
  }
  const resident = 'tests/evidence/lane13/resident-stateful-parity.json';
  const ra = load(reference, resident), rb = load(ffm, resident);
  assert.equal(ra.wasmSha256, refSha, `${resident}: the reference receipt is of another artifact`);
  assert.equal(rb.wasmSha256, here, `${resident}: this tree's receipt is of another artifact: run its script again`);
  compareMaps('resident-stateful-parity (browser, WasmEdge)', residentRows(ra), residentRows(rb), groups);

  for (const id of excluded) notes.push(`${id} carries an impulse: excluded from the identity count (its impulse time is exact on the integration clock now); both lanes of this tree still agree on it`);
  const width = Math.max(...groups.map((g) => g.name.length));
  console.log(`Earth equivalence: reference ${refSha.slice(0, 12)} against ${here.slice(0, 12)}`);
  for (const g of groups) console.log(`  ${g.name.padEnd(width)}  ${String(g.compared).padStart(4)} compared  ${String(g.identical).padStart(4)} identical  ${g.different.length} different${g.different.length ? `: ${g.different.slice(0, 5).join('; ')}` : ''}`);
  for (const note of notes) console.log(`  note: ${note}`);
  const total = groups.reduce((n, g) => n + g.compared, 0);
  const bad = groups.reduce((n, g) => n + g.different.length, 0);
  if (bad) { console.log(`FAIL ${bad} of ${total} differ`); process.exit(1); }
  console.log(`PASS ${total} responses identical`);
  fs.writeFileSync(path.join(ffm, 'tests/evidence/earth-equivalence.json'), `${JSON.stringify({
    reference: { artifactSha256: refSha }, candidate: { artifactSha256: here }, dockerLane: 'waived by the owner 2026-10-22 (no Docker)',
    groups: groups.map(({ name, compared, identical }) => ({ name, compared, identical })), compared: total, identical: total, notes,
  }, null, 2)}\n`);
}

const [command, argument] = process.argv.slice(2);
if (command === 'digest') await digest(argument, process.argv[4]);
else if (command === 'compare' && argument) compare(argument);
else { console.error('usage: earth-equivalence.mjs digest | compare <reference propagator/ffm dir>'); process.exit(2); }
