// A sampled track whose coverage ends inside a screening window, or before it,
// no longer fails the window: screen_window screens each pair over its joint
// coverage inside the window, reports a track covering part of the window or
// none of it once on the `excluded` port (README, "Objects screened in part
// or excluded"), and a pair with no joint coverage has no conjunction and no
// failure. Every window is checked against a dense brute force on the
// module's own cubic Hermite interpolant (tests/native/sampled_brute_force.cpp:
// each pair's range every second over its joint coverage, refined by golden
// section to 0.1 ms), built natively here.
// Run: node --test tests/sampledCoverage.e2e.mjs
//
// The console's shape (spaceaware-ui conjunction mode, T7 prefix coverage):
// invented circular orbits as compact OEM grids, TEME, UTC, cubic Hermite,
// 60 s samples from 2026-10-29T23:25:00Z, one resident sampled index, 30 min
// windows through screen_window, 10 s coarse step, 1,000 km threshold (many
// minima per window). FULL-1 and FULL-2 cover every window; DECAY-A (623
// states) ends at 09:47 and DECAY-B (640) at 10:04, inside a window, each
// meeting another track a few minutes before its end; HOLE (213) ends at
// 02:57, inside the 02:30 window, meeting FULL-1 24 s before its end (within
// a step of it), and no window from 03:00 on holds any of it; HOLE-2 (213)
// ends there too, its approach falling 19 s after its end, so it has no
// conjunction (a bracket that refines onto a coverage edge is not a
// minimum); DEAD (3) ends before the first window. The pair methods and the
// tight path still refuse a track that does not cover their window, by name,
// and a non-finite state inside a track is still refused.
//
// Tolerances: every reported event against the brute force, TCA within 1 ms
// (the refinement tolerance) and miss within 1 cm, and no event the brute
// force lacks; COVERAGE_START and COVERAGE_END the tracks' first and last
// sample epochs (exact to the millisecond).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, initCqrFlatc, parseFlatcJson, publishedSchema, screeningControls } from './lib/cqr.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JD_UNIX = 2440587.5, jdOf = (iso) => Date.parse(iso) / 86400000 + JD_UNIX;
const isoOf = (jd) => new Date(Math.round((jd - JD_UNIX) * 86400000)).toISOString();
const START = '2026-10-29T23:25:00.000Z', STEP_S = 60, THRESHOLD_KM = 1000;

// Invented circular orbits (TEME, km, km/s), sampled at the grid.
const MU = 398600.4418, DEG = Math.PI / 180;
function track(name, norad, a, iDeg, raanDeg, phaseDeg, states, meetsBeforeEnd = true) {
  const n = Math.sqrt(MU / a ** 3), i = iDeg * DEG, raan = raanDeg * DEG, u0 = phaseDeg * DEG;
  const P = [Math.cos(raan), Math.sin(raan), 0], Q = [-Math.sin(raan) * Math.cos(i), Math.cos(raan) * Math.cos(i), Math.sin(i)];
  const data = [];
  for (let k = 0; k < states; k++) {
    const u = u0 + n * k * STEP_S;
    for (let c = 0; c < 3; c++) data.push(a * (Math.cos(u) * P[c] + Math.sin(u) * Q[c]));
    for (let c = 0; c < 3; c++) data.push(a * n * (-Math.sin(u) * P[c] + Math.cos(u) * Q[c]));
  }
  return { name, norad, handle: norad - 910000, data, states, meetsBeforeEnd };
}
// Phases chosen with the brute force for the approaches described above.
const TRACKS = [
  track('FULL-1', 910001, 6798, 51.64, 100, 0, 1600),
  track('FULL-2', 910002, 6765, 41.47, 100, 40, 1600),
  track('DECAY-A', 910003, 6790, 97.5, 30, 80, 623),
  track('DECAY-B', 910004, 6780, 70, 100, 48, 640),
  track('HOLE', 910005, 6800, 60, 160, 324, 213),
  track('HOLE-2', 910007, 6830, 60, 160, 324, 213, false),
  track('DEAD', 910006, 6810, 80, 300, 300, 3),
];
const firstJd = jdOf(START), lastJd = (t) => jdOf(START) + ((t.states - 1) * STEP_S) / 86400;
const oem = (t, data = t.data) => ({ OBJECT_ID: t.name, OBJECT_NAME: t.name, NORAD_CATALOG_ID: t.norad, SOURCE_HANDLE: t.handle,
  EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399, REFERENCE_FRAME: { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } },
    TIME_SYSTEM: 'UTC', START_TIME: START, INTERPOLATION: 'HERMITE', INTERPOLATION_DEGREE: 3, STEP_SIZE: STEP_S, STATE_VECTOR_SIZE: 6, EPHEMERIS_DATA: data }] } });
// Windows of 30 min: the first, and each one a coverage ends in or before.
const WINDOWS = ['2026-10-29T23:30:00.000Z', '2026-10-30T02:30:00.000Z', '2026-10-30T03:00:00.000Z', '2026-10-30T09:30:00.000Z',
  '2026-10-30T10:00:00.000Z', '2026-10-30T10:30:00.000Z'];
const WINDOW_S = 1800;

// ── The native brute force ──
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-sampled-coverage-'));
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
const bruteForceExe = path.join(build, 'sampled-brute-force');
await run(process.env.CXX || 'c++', ['-std=c++17', '-O2', '-include', prefix, '-Isrc/cpp/include', `-I${include}`, 'tests/native/sampled_brute_force.cpp',
  path.join(build, 'libconjunction_assessment.a'), path.join(build, 'liberfa_lib.a'), '-pthread', '-o', bruteForceExe]);
test.after(() => fs.rmSync(build, { recursive: true, force: true }));
const tracksFile = path.join(build, 'tracks.txt');
fs.writeFileSync(tracksFile, [String(TRACKS.length), ...TRACKS.flatMap((t) => [`${t.name} ${t.norad} ${START} ${STEP_S} ${t.states}`,
  ...Array.from({ length: t.states }, (_, k) => t.data.slice(6 * k, 6 * k + 6).map(String).join(' '))])].join('\n') + '\n');
const reference = JSON.parse(execFileSync(bruteForceExe, [tracksFile, String(THRESHOLD_KM), ...WINDOWS.flatMap((w) => [w, String(WINDOW_S)])],
  { encoding: 'utf8', maxBuffer: 1 << 26 })).windows;

// ── The module ──
const flatc = await initCqrFlatc();
const ommSchema = publishedSchema('OMM');
const controls = (startJd) => ({ ...screeningControls({ startJd, durationSeconds: WINDOW_S, coarseStepSec: 10, thresholdKm: THRESHOLD_KM, numThreads: 2 }),
  ALGORITHM: 'ALFANO_MAXIMUM' });
const encode = (record) => [{ portId: 'request', payload: encodeCqr(flatc, record) }];
let generation = 0;
async function prepare(harness, tracks, primaries = tracks) {
  const INSTANCE = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'sampled-coverage', GENERATION: ++generation };
  const r = await harness.invoke({ methodId: 'prepare_sample_screening_index', inputs: encode({ INDEX_REQUEST: { INSTANCE, INDEX_CONTENT: 'SAMPLED_STATES',
    REFINEMENT_MODE: 'EXACT_ONLY', PRIMARY_SOURCE_HANDLES: primaries.map((t) => t.handle), SOURCES: tracks.map((t) => oem(t)) } }) });
  return { r, INSTANCE, handle: r.statusCode === 0 ? decodeCqr(flatc, r.outputs[0].payload).INDEX_RESULT.SCREENING_INDEX_HANDLE : 0 };
}
async function screenWindow(harness, index, startJd, methodId = 'screen_window') {
  const inputs = encode({ WINDOW_REQUEST: { INSTANCE: index.INSTANCE, SCREENING_INDEX_HANDLE: index.handle, CONTROLS: controls(startJd), EVALUATION_FRAME: earthFrame('TEME') } });
  const events = [], excluded = [];
  for (;;) {
    const r = await harness.invoke({ methodId, inputs });
    if (r.statusCode !== 0) return { error: `${r.errorCode}: ${r.errorMessage}` };
    const result = decodeCqr(flatc, r.outputs.find((f) => f.portId === 'result').payload).CATALOG_RESULT;
    events.push(...(result.EVENTS ?? []));
    for (const f of r.outputs.filter((o) => o.portId === 'excluded')) {
      excluded.push(parseFlatcJson(flatc.generateJSON(ommSchema, { path: '/omm.bin', data: f.payload }, { defaultsJson: true })));
    }
    if (result.FINAL_CHUNK) return { events, excluded, statistics: result.STATISTICS, objectsParsed: Number(result.OBJECTS_PARSED) };
  }
}
const pairKey = (a, b) => [Number(a), Number(b)].sort((x, y) => x - y).join('-');
const ISO = '(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z)';
const FORMS = {
  none: new RegExp(`^Excluded from conjunction screening; its trajectory does not cover the window\\. COVERAGE_START=${ISO}; COVERAGE_END=${ISO}$`),
  ends: new RegExp(`^Screened until COVERAGE_END; its trajectory ends inside the window\\. COVERAGE_START=${ISO}; COVERAGE_END=${ISO}$`),
};
// What each window must report: a track whose coverage ends inside it, or
// before it starts.
function expectedReports(startJd) {
  const endJd = startJd + WINDOW_S / 86400, out = new Map();
  for (const t of TRACKS) {
    if (lastJd(t) <= startJd) out.set(t.norad, 'none');
    else if (lastJd(t) < endJd) out.set(t.norad, 'ends');
  }
  return out;
}

test('screen_window screens each pair of sampled tracks over its joint coverage inside the window, and reports the tracks covering part of it or none', async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const index = await prepare(harness, TRACKS);
    assert.equal(index.r.statusCode, 0, index.r.errorMessage);
    for (const [w, iso] of WINDOWS.entries()) {
      const startJd = jdOf(iso), label = `window ${iso}`;
      const answer = await screenWindow(harness, index, startJd);
      assert.ok(!answer.error, `${label}: ${answer.error}`);
      assert.equal(Number(answer.statistics.FAILED_PAIRS), 0, `${label}: failed pairs`);
      // Reports: each track ending in or before the window, once, in the documented form.
      const expected = expectedReports(startJd);
      assert.deepEqual(answer.excluded.map((o) => Number(o.NORAD_CAT_ID)).sort(), [...expected.keys()].sort(), `${label}: reported tracks`);
      for (const o of answer.excluded) {
        const t = TRACKS.find((x) => x.norad === Number(o.NORAD_CAT_ID));
        const match = FORMS[expected.get(t.norad)].exec(o.COMMENT);
        assert.ok(match, `${label}: ${o.COMMENT}`);
        assert.equal(match[1], isoOf(firstJd), `${label}: ${t.name} COVERAGE_START`);
        assert.equal(match[2], isoOf(lastJd(t)), `${label}: ${t.name} COVERAGE_END`);
        assert.equal(o.OBJECT_ID, t.name);
        assert.equal(o.REFERENCE_FRAME.REFERENCE_FRAME.frame, 'TEMEOFDATE');
      }
      const none = [...expected.values()].filter((x) => x === 'none').length;
      assert.equal(answer.objectsParsed - Number(answer.statistics.TOTAL_OBJECTS), none, `${label}: TOTAL_OBJECTS leaves out the tracks with no coverage`);
      // Events: the brute force's, each once, and nothing else.
      const brute = reference[w].events;
      // A track ending inside the window meets another before its end there
      // (HOLE-2's approach falls after its end: none).
      for (const [norad, form] of expected) {
        if (form !== 'ends') continue;
        const meets = brute.some((r) => r.a === norad || r.b === norad);
        assert.equal(meets, TRACKS.find((t) => t.norad === norad).meetsBeforeEnd, `${label}: ${norad} before its coverage ends`);
      }
      assert.equal(answer.events.length, brute.length, `${label}: ${answer.events.length} events, brute force ${brute.length}`);
      for (const r of brute) {
        const found = answer.events.filter((e) => pairKey(e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID) === pairKey(r.a, r.b)
          && Math.abs(e.TCA.JULIAN_DATE - r.tca_jd) * 86400 <= 0.001);
        assert.equal(found.length, 1, `${label}: ${r.a} x ${r.b} at ${isoOf(r.tca_jd)}`);
        assert.ok(Math.abs(found[0].MISS_DISTANCE_M - r.miss_km * 1000) <= 0.01, `${label}: ${r.a} x ${r.b} miss`);
      }
      for (const e of answer.events) {
        for (const norad of [e.PRIMARY_NORAD_ID, e.SECONDARY_NORAD_ID]) {
          const t = TRACKS.find((x) => x.norad === Number(norad));
          assert.ok(e.TCA.JULIAN_DATE < lastJd(t), `${label}: ${t.name} has an event after its coverage ends`);
        }
      }
    }
  } finally {
    await harness.destroy?.();
  }
});

test('the pair methods and the tight path still refuse a track that does not cover their window, by name; a non-finite state is still refused', async () => {
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const startJd = jdOf('2026-10-30T03:00:00.000Z');
    const [full, hole] = [TRACKS[0], TRACKS[4]];
    const pair = await harness.invoke({ methodId: 'assess_conjunction', inputs: encode({ PAIR_REQUEST: { PRIMARY: oem(full), SECONDARY: oem(hole),
      CONTROLS: controls(startJd), PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME') } }) });
    assert.equal(pair.errorCode, 'invalid-coverage');
    assert.match(pair.errorMessage, /^Source HOLE covers 2026-10-29T23:25:00\.000Z to 2026-10-30T02:57:00\.000Z, not the complete requested UTC screening window\.$/);
    // The tight path (every source against every other: no primaries).
    const index = await prepare(harness, [hole, full], []);
    assert.equal(index.r.statusCode, 0, index.r.errorMessage);
    const tight = await screenWindow(harness, index, startJd, 'refine_candidates');
    assert.match(tight.error ?? '', /^invalid-coverage: Source HOLE covers /);
    const bad = full.data.slice();
    bad[6 * 100 + 1] = Number.NaN;
    const refused = await prepare(harness, [{ ...full, data: bad }, hole]);
    assert.notEqual(refused.r.statusCode, 0);
    assert.match(refused.r.errorMessage, /finite/);
  } finally {
    await harness.destroy?.();
  }
});
