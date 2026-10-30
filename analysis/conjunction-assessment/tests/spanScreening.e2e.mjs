// An object SGP4 refuses part-way through a window (it reenters) is screened
// up to its last valid instant: its conjunctions before then are reported, it
// is reported once on the `excluded` port with that instant, and no pair
// fails. Every screen is checked against a dense brute force on the library's
// own SGP4 sources (tests/native/span_brute_force.cpp: each object's span from
// a one-second scan bisected to 0.1 ms, each pair's range every second
// refined by golden section to 0.1 ms), built natively here.
// Run: node --test tests/spanScreening.e2e.mjs
//
// Synthetic (invented element sets, SGP4 mean elements, TEME, UTC, epoch
// 2026-10-28T17:00Z): SYN-DECAY-A circular at 400 km, i 53 deg, BSTAR 0.05
// per Earth radius, reenters 5.7 days after epoch; SYN-LOW-B circular at
// 250 km, i 97.6 deg, BSTAR 1e-4, meets it under 5 km 3.6 days after epoch.
// Window: 7 days from epoch, so the reentry is inside it. Screens:
// screen_catalog inline (explicit pairs), all vs all with
// tests/lib/syntheticCatalog.mjs's 721 invented sets (10,080 coarse steps,
// so the chunked path), screen_window on a resident index, and the GPU
// pipeline (gpu/allVsAll.mjs on the module's own CPU search) with SYN-DOWN,
// the invented set SGP4 refuses from the start: its TOTAL_OBJECTS leaves out
// only that one, as screen_catalog's does.
//
// Named (private fixture socrates/reentry-66840-2026-10-28.json: Space-Track
// GP editions SOCRATES used, from the SOCRATES parity run's catalog): 66840
// STARLINK-35837 (BSTAR 0.164) reenters about 2026-11-03T05:00:09Z.
// (a) One call over SOCRATES's 7-day window from 2026-10-28T17:00Z, against
// the 12 objects of its 17 conjunctions under 5 km that the run's 6 h slices
// found: all 17. (CA 0.12.0 excluded 66840 from that call and reported none.)
// (b) 2026-11-03T04:00:00Z + 3,620 s, ending 20 s after its last coarse step
// and after the refusal, against the 30 objects whose pairs CA 0.12.0 failed
// there: no failed pair. (a) again as seven 24 h windows through
// screenWindowsOnGpu (gpu/allVsAll.mjs): the merged conjunctions are the
// single call's.
//
// Tolerances: every reported event against the brute force, TCA within 1 ms
// (the refinement tolerance) and miss within 1 cm, and no event the brute
// force lacks; the reported LAST_VALID within 3 ms of the brute force's span
// end (each bisected to a millisecond or better, printed rounded down).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpRecord, gpSource, initCqrFlatc, parseFlatcJson, publishedSchema, screeningControls } from './lib/cqr.mjs';
import { syntheticGp } from './lib/syntheticCatalog.mjs';
import { screenAllVsAllOnGpu, screenWindowsOnGpu } from '../gpu/allVsAll.mjs';
import { privateFixtureSkip, readPrivateFixtureJson } from './lib/privateFixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'socrates/reentry-66840-2026-10-28.json';
const NAMED_SKIP = privateFixtureSkip(FIXTURE);
const NAMED = readPrivateFixtureJson(FIXTURE, { gp: [] });

const JD_UNIX = 2440587.5, jdOf = (iso) => Date.parse(iso) / 86400000 + JD_UNIX;
const THRESHOLD_KM = 5, STEP_S = 60;
const EPOCH = '2026-10-28T17:00:00.000000';
const element = (name, norad, meanMotion, inclination, meanAnomaly, bstar) => ({ OBJECT_NAME: name, OBJECT_ID: name, NORAD_CAT_ID: norad,
  EPOCH, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1, CLASSIFICATION_TYPE: 'U', BSTAR: bstar, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
  MEAN_MOTION: meanMotion, ECCENTRICITY: 0.0001, INCLINATION: inclination, RA_OF_ASC_NODE: 40, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: meanAnomaly });
const A = element('SYN-DECAY-A', 900201, 15.55741523, 53, 0, 0.05);
const B = element('SYN-LOW-B', 900202, 16.08850695, 97.6, 305.7, 0.0001);

const flatc = await initCqrFlatc();
const ommSchema = publishedSchema('OMM');
const ommBytes = (g) => flatc.generateBinary(ommSchema, JSON.stringify(gpRecord(g)), { sizePrefix: false });
const controls = (startJd, durationSeconds) => ({ ...screeningControls({ startJd, durationSeconds, coarseStepSec: STEP_S,
  thresholdKm: THRESHOLD_KM, numThreads: 2 }), ALGORITHM: 'ALFANO_MAXIMUM' });

// ── The native brute force ──
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-span-screening-'));
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const p = spawn(command, args, { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    p.once('error', reject);
    p.once('exit', (code, signal) => (code === 0 ? resolve() : reject(Error(`${command}: exit ${code}, signal ${signal}`))));
  });
}
const cache = path.join(os.homedir(), '.cache/sdn-tools');
const headers = fs.existsSync(cache) ? fs.readdirSync(cache).filter((x) => x.startsWith('flatbuffers-include-')).map((x) => path.join(cache, x))
  .filter((x) => fs.existsSync(path.join(x, 'flatbuffers/flatbuffers.h'))) : [];
const include = process.env.SDN_FLATBUFFERS_INCLUDE_DIR || (headers.length === 1 ? headers[0] : null);
if (!include) throw Error('Set SDN_FLATBUFFERS_INCLUDE_DIR to the FlatBuffers C++ headers used by the module build');
// Darwin's obsolete math.h SING macro collides with the SDS country enum (as in ncCascade.e2e.mjs).
const prefix = path.join(build, 'native-platform.h');
fs.writeFileSync(prefix, '#include <cmath>\n#ifdef SING\n#undef SING\n#endif\n');
await run('cmake', ['-S', 'src/cpp', '-B', build, '-DCMAKE_BUILD_TYPE=Release', `-DFLATBUFFERS_INCLUDE_DIR=${include}`, `-DCMAKE_CXX_FLAGS=-include "${prefix}"`]);
await run('cmake', ['--build', build, '--target', 'conjunction_assessment', '-j', '6']);
const bruteForceExe = path.join(build, 'span-brute-force');
await run(process.env.CXX || 'c++', ['-std=c++17', '-O2', '-include', prefix, '-Isrc/cpp/include', `-I${include}`, 'tests/native/span_brute_force.cpp',
  path.join(build, 'libconjunction_assessment.a'), path.join(build, 'liberfa_lib.a'), '-pthread', '-o', bruteForceExe]);
test.after(() => fs.rmSync(build, { recursive: true, force: true }));

// The brute force reads GP JSON with numeric values (Space-Track's are
// decimal strings): the same doubles the module parses from the same text.
const NUMERIC = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'NORAD_CAT_ID',
  'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
const numericGp = (g) => {
  const r = gpRecord(g), out = { OBJECT_NAME: r.OBJECT_NAME, OBJECT_ID: r.OBJECT_ID, EPOCH: r.EPOCH, CLASSIFICATION_TYPE: r.CLASSIFICATION_TYPE };
  for (const k of NUMERIC) out[k] = Number(r[k]);
  return out;
};
let calls = 0;
function bruteForce(records, startIso, seconds, primary) {
  const file = path.join(build, `gp-${++calls}.json`);
  fs.writeFileSync(file, JSON.stringify(records.map(numericGp)));
  return JSON.parse(execFileSync(bruteForceExe, [file, startIso, String(seconds), String(THRESHOLD_KM), String(primary)],
    { encoding: 'utf8', maxBuffer: 1 << 26 }));
}

// ── The module ──
let generation = 0;
async function drain(harness, methodId, record, extra = []) {
  const inputs = [{ portId: 'request', payload: encodeCqr(flatc, record) }, ...extra];
  const events = [], excluded = [];
  for (;;) {
    const r = await harness.invoke({ methodId, inputs });
    assert.equal(r.statusCode, 0, `${methodId} ${r.errorCode}: ${r.errorMessage}`);
    const result = decodeCqr(flatc, r.outputs.find((f) => f.portId === 'result').payload).CATALOG_RESULT;
    events.push(...(result.EVENTS ?? []));
    for (const f of r.outputs.filter((o) => o.portId === 'excluded')) {
      excluded.push(parseFlatcJson(flatc.generateJSON(ommSchema, { path: '/omm.bin', data: f.payload }, { defaultsJson: true })));
    }
    if (result.FINAL_CHUNK) return { events, excluded, statistics: result.STATISTICS, objectsParsed: Number(result.OBJECTS_PARSED) };
  }
}
const decodeOmm = (bytes) => parseFlatcJson(flatc.generateJSON(ommSchema, { path: '/omm.bin', data: bytes }, { defaultsJson: true }));
async function residentIndex(harness, set, instanceId) {
  const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: instanceId, GENERATION: ++generation };
  const prepared = await harness.invoke({ methodId: 'prepare_screening_index', inputs: [{ portId: 'request', payload: encodeCqr(flatc, { INDEX_REQUEST: { INSTANCE,
    INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY', SOURCES: set.map((g, i) => ({ ...gpSource(g), SOURCE_HANDLE: i + 1 })) } }) }] });
  assert.equal(prepared.statusCode, 0, prepared.errorMessage);
  return { INSTANCE, handle: decodeCqr(flatc, prepared.outputs[0].payload).INDEX_RESULT.SCREENING_INDEX_HANDLE };
}
const windowRequest = ({ INSTANCE, handle }, startJd, seconds) => encodeCqr(flatc, { WINDOW_REQUEST: { INSTANCE, SCREENING_INDEX_HANDLE: handle,
  CONTROLS: controls(startJd, seconds), EVALUATION_FRAME: earthFrame('TEME') } });
const gpuOptions = (harness) => ({ invoke: (methodId, inputs) => harness.invoke({ methodId, inputs }),
  decodeCatalogResult: (bytes) => decodeCqr(flatc, bytes).CATALOG_RESULT, screener: null, thresholdKm: THRESHOLD_KM, coarseStepSec: STEP_S });
const SPAN = /^Screened until LAST_VALID; SGP4 refuses it from FIRST_REFUSAL\. LAST_VALID=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z); FIRST_REFUSAL=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z); REFUSAL=(.+)$/;
const EXCLUDED = /^Excluded from conjunction screening; SGP4 refuses it from the window start\. LAST_VALID=NONE; FIRST_REFUSAL=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z); REFUSAL=(.+)$/;
const pairKey = (a, b) => [Number(a), Number(b)].sort((x, y) => x - y).join('-');

// The answer against the brute force: the primary reported once with its
// span, every brute-force conjunction of its pairs reported, nothing else.
function check(answer, reference, primary, label, { pairs } = {}) {
  assert.equal(Number(answer.statistics.FAILED_PAIRS), 0, `${label}: failed pairs`);
  const span = reference.objects.find((o) => o.norad === primary);
  const records = answer.excluded.filter((o) => Number(o.NORAD_CAT_ID) === primary);
  assert.equal(records.length, 1, `${label}: ${primary} is reported once`);
  const match = SPAN.exec(records[0].COMMENT);
  assert.ok(match, `${label}: ${records[0].COMMENT}`);
  const lastValid = jdOf(match[1]), firstRefusal = jdOf(match[2]);
  assert.ok(Math.abs(lastValid - span.last_valid_jd) * 86400 <= 0.003, `${label}: LAST_VALID ${match[1]} against ${span.last_valid_jd}`);
  assert.ok(firstRefusal > lastValid && (firstRefusal - lastValid) * 86400 <= 0.003, `${label}: FIRST_REFUSAL ${match[2]}`);
  const inScope = (e) => (pairs ?? null) === null || pairs.has(pairKey(e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID));
  const mine = answer.events.filter((e) => [Number(e.PRIMARY_NORAD_ID), Number(e.SECONDARY_NORAD_ID)].includes(primary) && inScope(e));
  for (const e of mine) assert.ok(e.TCA.JULIAN_DATE <= lastValid + 0.001 / 86400, `${label}: an event after LAST_VALID`);
  assert.equal(mine.length, reference.events.length, `${label}: ${mine.length} events, brute force ${reference.events.length}`);
  for (const r of reference.events) {
    const found = mine.filter((e) => pairKey(e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID) === pairKey(r.a, r.b)
      && Math.abs(e.TCA.JULIAN_DATE - r.tca_jd) * 86400 <= 0.001);
    assert.equal(found.length, 1, `${label}: ${r.a} x ${r.b} at ${r.tca_jd}`);
    assert.ok(Math.abs(found[0].MISS_DISTANCE_M - r.miss_km * 1000) <= 0.01,
      `${label}: ${r.a} x ${r.b} miss ${found[0].MISS_DISTANCE_M} m, brute force ${r.miss_km * 1000} m`);
  }
  return { lastValid: match[1], firstRefusal: match[2], refusal: match[3] };
}

test('a reentering synthetic object: every screen reports its conjunctions up to its last valid instant', async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const startJd = jdOf('2026-10-28T17:00:00Z'), seconds = 7 * 86400;
    const reference = bruteForce([A, B], '2026-10-28T17:00:00Z', seconds, A.NORAD_CAT_ID);
    assert.ok(reference.events.length > 0, 'the brute force finds the pass');
    assert.ok(reference.objects.find((o) => o.norad === A.NORAD_CAT_ID).last_valid_jd < startJd + 7, 'A reenters inside the window');
    // Explicit pairs.
    check(await drain(harness, 'screen_catalog', { CATALOG_REQUEST: { PRIMARIES: [gpSource(A)], SECONDARIES: [gpSource(B)],
      CONTROLS: controls(startJd, seconds), EVALUATION_FRAME: earthFrame('TEME') } }), reference, A.NORAD_CAT_ID, 'inline');
    // All vs all with invented fillers: 10,080 coarse steps, the chunked path.
    const fillers = syntheticGp({ epoch: EPOCH });
    const catalog = [A, B, ...fillers];
    const frames = catalog.map((g) => ({ portId: 'catalog', payload: ommBytes(g) }));
    const all = await drain(harness, 'screen_catalog', { CATALOG_REQUEST: { CONTROLS: controls(startJd, seconds), EVALUATION_FRAME: earthFrame('TEME') } }, frames);
    check(all, reference, A.NORAD_CAT_ID, 'all vs all', { pairs: new Set([pairKey(A.NORAD_CAT_ID, B.NORAD_CAT_ID)]) });
    // The filler SGP4 refuses from the start is excluded, in the documented form.
    const down = all.excluded.filter((o) => o.OBJECT_NAME === 'SYN-DOWN');
    assert.equal(down.length, 1);
    assert.match(down[0].COMMENT, EXCLUDED);
    assert.equal(all.objectsParsed - Number(all.statistics.TOTAL_OBJECTS), 1, 'only the excluded object leaves TOTAL_OBJECTS');
    // Resident index, every object primary.
    const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'span-screening', GENERATION: ++generation };
    const prepared = await harness.invoke({ methodId: 'prepare_screening_index', inputs: [{ portId: 'request', payload: encodeCqr(flatc, { INDEX_REQUEST: { INSTANCE,
      INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY', SOURCES: [A, B].map((g) => ({ ...gpSource(g), SOURCE_HANDLE: g.NORAD_CAT_ID })) } }) }] });
    assert.equal(prepared.statusCode, 0, prepared.errorMessage);
    const handle = decodeCqr(flatc, prepared.outputs[0].payload).INDEX_RESULT.SCREENING_INDEX_HANDLE;
    check(await drain(harness, 'screen_window', { WINDOW_REQUEST: { INSTANCE, SCREENING_INDEX_HANDLE: handle, CONTROLS: controls(startJd, seconds),
      EVALUATION_FRAME: earthFrame('TEME') } }), reference, A.NORAD_CAT_ID, 'screen_window');
    // The GPU pipeline on A, B and SYN-DOWN: TOTAL_OBJECTS leaves out only SYN-DOWN, as screen_catalog's does.
    const three = [A, B, fillers.find((g) => g.OBJECT_NAME === 'SYN-DOWN')];
    const single = await drain(harness, 'screen_catalog', { CATALOG_REQUEST: { CONTROLS: controls(startJd, seconds), EVALUATION_FRAME: earthFrame('TEME') } },
      three.map((g) => ({ portId: 'catalog', payload: ommBytes(g) })));
    const gpu = await screenAllVsAllOnGpu({ ...gpuOptions(harness), request: windowRequest(await residentIndex(harness, three, 'span-gpu'), startJd, seconds) });
    check({ events: gpu.events, excluded: gpu.excludedRecords.map(decodeOmm), statistics: gpu.statistics }, reference, A.NORAD_CAT_ID, 'GPU pipeline');
    assert.equal(Number(gpu.statistics.TOTAL_OBJECTS), 2, 'GPU pipeline: only SYN-DOWN leaves TOTAL_OBJECTS');
    assert.equal(Number(gpu.statistics.TOTAL_OBJECTS), Number(single.statistics.TOTAL_OBJECTS), 'GPU pipeline: screen_catalog\'s TOTAL_OBJECTS');
  } finally {
    await harness.destroy?.();
  }
});

test('66840 reentering: one 7-day call and seven 24 h windows report its 17 conjunctions, and a window ending after the refusal fails no pair', { skip: NAMED_SKIP }, async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const byNorad = new Map(NAMED.gp.map((g) => [Number(g.NORAD_CAT_ID), g]));
    const primary = byNorad.get(NAMED.object);
    let singleCall = null;
    for (const [label, windowSpec, partners, events] of [['(a) seven days', NAMED.windowA, NAMED.partnersA, 17],
      ['(b) past the refusal', NAMED.windowB, NAMED.partnersB, null]]) {
      const set = partners.map((n) => byNorad.get(n));
      const reference = bruteForce([primary, ...set], windowSpec.startUtc, windowSpec.durationSeconds, NAMED.object);
      if (events !== null) assert.equal(reference.events.length, events, `${label}: brute force`);
      const answer = await drain(harness, 'screen_catalog', { CATALOG_REQUEST: { PRIMARIES: [gpSource(primary)], SECONDARIES: set.map(gpSource),
        CONTROLS: controls(jdOf(windowSpec.startUtc), windowSpec.durationSeconds), EVALUATION_FRAME: earthFrame('TEME') } });
      const span = check(answer, reference, NAMED.object, label);
      console.log(`${label}: ${answer.events.length} events; 66840 LAST_VALID ${span.lastValid}, FIRST_REFUSAL ${span.firstRefusal}: ${span.refusal}`);
      if (events !== null) singleCall = answer;
    }
    // (a) as seven 24 h windows (gpu/allVsAll.mjs screenWindowsOnGpu): one
    // index, every window an all-vs-all screen of it; merged, 66840's
    // conjunctions are the single call's.
    const set = [primary, ...NAMED.partnersA.map((n) => byNorad.get(n))];
    const index = await residentIndex(harness, set, 'span-windows');
    const startJd = jdOf(NAMED.windowA.startUtc);
    const windows = Array.from({ length: 7 }, (_, k) => ({ startJd: startJd + k, durationDays: 1 }));
    const merged = await screenWindowsOnGpu({ ...gpuOptions(harness), windows, fineTolSec: 0.001,
      prepareWindow: async (w) => ({ request: windowRequest(index, w.startJd, 86400), objects: set.map((g) => [g.OBJECT_ID, Number(g.NORAD_CAT_ID)]) }) });
    const mine = merged.events.filter((e) => [Number(e.PRIMARY_NORAD_ID), Number(e.SECONDARY_NORAD_ID)].includes(NAMED.object));
    assert.equal(mine.length, 17, `windows: ${mine.length} of 66840's conjunctions`);
    for (const e of singleCall.events) {
      const found = mine.filter((x) => pairKey(x.PRIMARY_NORAD_ID, x.SECONDARY_NORAD_ID) === pairKey(e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID)
        && Math.abs(x.TCA.JULIAN_DATE - e.TCA.JULIAN_DATE) * 86400 <= 0.001);
      assert.equal(found.length, 1, `windows: ${pairKey(e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID)} at ${e.TCA.JULIAN_DATE}`);
      assert.ok(Math.abs(found[0].MISS_DISTANCE_M - e.MISS_DISTANCE_M) <= 0.01, 'windows: the single call\'s miss');
    }
  } finally {
    await harness.destroy?.();
  }
});
