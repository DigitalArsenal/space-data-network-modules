// A single Pc on a needle covariance (one object's along-track sigma hundreds
// of km, radial and normal a few km) no longer runs for minutes to hours.
// Cause: such encounters fail the 2D usage checks, so the cascade runs 2D-Nc,
// 3D-Nc, then Monte Carlo. Where Hall's peak-overlap solve did not converge at
// an epoch inside the window, the 3D-Nc time integral took 0 there, did not
// cache it, recursed to its depth limit around every such epoch, then
// discarded the series. 0.15.0 stops the integral at the first such epoch, at
// a non-finite flux, and at a fixed budget of 2^30 sphere-point flux
// evaluations or 2^16 epochs, each by name (NC3_KERNEL_UNAVAILABLE_REQUIRES_MC,
// NC3_NONFINITE_FLUX_REQUIRES_MC, NC3_WORK_BUDGET_REQUIRES_MC). Monte Carlo
// then answers exactly as before.
//
// Native leg (tests/native/pc_elongated.cpp, built here against the candidate
// library; synthetic encounters only):
// - identity: 100 encounters (aspect ratio 1 to 1e4, three covariance models)
//   and the public CARA vectors through the candidate and through the previous
//   3D-Nc integral (git blob e89e03be, src/cpp/src/pc_fallbacks.cpp at
//   0.14.0). Every event is byte-identical, except that a stopped 3D-Nc names
//   its reason in the cascade trace; run on its own, a stopped 3D-Nc also
//   evaluates fewer epochs and asks for Monte Carlo.
// - bound: the two needle encounters whose previous 3D-Nc ran 306 s and 51 s
//   native stop by name; Monte Carlo answers with its 65,536 samples.
// - accuracy: Foster's disk integral, aspect ratio 1 to 1e4, against a
//   compensated binary64 polar reference, within 1e-10 + 1e-15 A^2 relative.
// Module leg: the first needle encounter as sampled OEM tracks through
// assess_conjunction in the built module (browser WASI, and WasmEdge when it
// is on PATH): the event's CDM carries the named refusal and Monte Carlo's
// interval. The same request takes 347 s on 0.14.0 in browser WASI.
// Run: node --test tests/pcElongatedCovariance.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, initCqrFlatc, screeningControls } from './lib/cqr.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREVIOUS_NC3 = 'e89e03bee236db893c21675be0ee4a46586247a2';
const STOP = / NC3_(?:KERNEL_UNAVAILABLE|WORK_BUDGET|NONFINITE_FLUX)_REQUIRES_MC: [^\]]*? s from the input epoch\./;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (chunk) => { out += chunk; });
    p.once('error', reject);
    p.once('exit', (code, signal) => code === 0 ? resolve(out) : reject(Error(`${command} ${args[0] ?? ''}: exit ${code}, signal ${signal}`)));
  });
}

// The candidate library, as tests/ncCascade.e2e.mjs builds it, and the driver
// linked twice: once as built, once with the previous 3D-Nc integral.
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-pc-elongated-e2e-'));
async function drivers() {
  const cache = path.join(os.homedir(), '.cache/sdn-tools');
  const headers = fs.existsSync(cache) ? fs.readdirSync(cache).filter((x) => x.startsWith('flatbuffers-include-'))
    .map((x) => path.join(cache, x)).filter((x) => fs.existsSync(path.join(x, 'flatbuffers/flatbuffers.h'))) : [];
  const include = process.env.SDN_FLATBUFFERS_INCLUDE_DIR || (headers.length === 1 ? headers[0] : null);
  if (!include) throw Error('Set SDN_FLATBUFFERS_INCLUDE_DIR to the FlatBuffers C++ headers used by the module build');
  // Darwin's obsolete math.h SING macro collides with the SDS country enum (as in ncCascade.e2e.mjs).
  const prefix = path.join(build, 'native-platform.h');
  fs.writeFileSync(prefix, '#include <cmath>\n#ifdef SING\n#undef SING\n#endif\n');
  await run('cmake', ['-S', 'src/cpp', '-B', build, '-DCMAKE_BUILD_TYPE=Release', `-DFLATBUFFERS_INCLUDE_DIR=${include}`, `-DCMAKE_CXX_FLAGS=-include "${prefix}"`]);
  await run('cmake', ['--build', build, '--target', 'conjunction_assessment', '-j', '6']);
  const previousSource = path.join(build, 'pc_fallbacks_previous.cpp');
  fs.writeFileSync(previousSource, execFileSync('git', ['-C', root, 'cat-file', 'blob', PREVIOUS_NC3]));
  const library = [path.join(build, 'libconjunction_assessment.a'), path.join(build, 'liberfa_lib.a'), '-pthread'];
  const flags = ['-std=c++17', '-O2', '-include', prefix, '-Isrc/cpp/include', '-Isrc/cpp/src'];
  const candidate = path.join(build, 'pc-elongated'), previous = path.join(build, 'pc-elongated-previous');
  const cxx = process.env.CXX || 'c++';
  await Promise.all([
    run(cxx, [...flags, 'tests/native/pc_elongated.cpp', ...library, '-o', candidate]),
    run(cxx, [...flags, 'tests/native/pc_elongated.cpp', previousSource, ...library, '-o', previous]),
  ]);
  return { candidate, previous };
}
const built = drivers();
built.catch(() => {});  // each test awaits it and reports its failure

// One encounter's line from each build: identical, or the candidate's 3D-Nc
// stopped by name where the previous integral ran on and discarded its series.
function compare(before, now) {
  if (before === now) return 'identical';
  assert.equal(now.match(new RegExp(STOP.source, 'g'))?.length, 1, `differs without one named stop:\n${before}\n${now}`);
  if (before.startsWith('EVENT ')) {
    assert.equal(now.replace(STOP, ''), before, 'a stopped 3D-Nc changes only the cascade trace');
    return 'stopped';
  }
  const fields = (line) => {
    const m = /^NC3 (\S+) converged=(\d) requires_mc=(\d) nc=(\S+) pc=(\S+) iterations=(\d+) repaired=(\d) \| (.*)$/.exec(line);
    assert.ok(m, `unparsed line ${line}`);
    return { name: m[1], converged: m[2], requiresMc: m[3], nc: m[4], pc: m[5], iterations: Number(m[6]), repaired: Number(m[7]), limitation: m[8] };
  };
  const a = fields(before), b = fields(now);
  assert.equal(a.name, b.name);
  assert.equal(a.converged, '0', `${a.name}: the previous integral converged where the candidate stopped`);
  assert.equal(b.converged, '0');
  assert.equal(b.requiresMc, '1', `${b.name}: a stopped 3D-Nc asks for Monte Carlo`);
  assert.equal(b.nc, a.nc); assert.equal(b.pc, a.pc);
  assert.ok(b.iterations <= a.iterations, `${b.name}: a stopped 3D-Nc evaluates no more epochs`);
  assert.ok(b.repaired <= a.repaired);
  assert.equal(b.limitation.replace(STOP, ''), a.limitation);
  return 'stopped';
}

test('needle covariances, native: bounded 3D-Nc, named refusals, byte identity, Foster accuracy', { timeout: 900000 }, async () => {
  const { candidate, previous } = await built;
  const fixtures = path.join(root, 'src/cpp/tests/fixtures');
  const [now, before, bound, accuracy] = await Promise.all([
    run(candidate, ['identity', fixtures]), run(previous, ['identity', fixtures]), run(candidate, ['bound']), run(candidate, ['accuracy'])]);
  const a = before.trimEnd().split('\n'), b = now.trimEnd().split('\n');
  assert.equal(a.at(-1), 'IDENTITY DONE'); assert.equal(b.at(-1), 'IDENTITY DONE');
  assert.equal(b.length, a.length);
  const counts = { identical: 0, stopped: 0 };
  a.slice(0, -1).forEach((line, i) => { counts[compare(line, b[i])]++; });
  console.log(`identity: ${a.length - 1} lines, ${counts.identical} byte-identical, ${counts.stopped} with a named 3D-Nc stop`);
  assert.ok(counts.identical >= 200 && counts.stopped >= 1, JSON.stringify(counts));
  assert.ok(a.filter((line) => line.startsWith('EVENT cara-') || line.startsWith('NC3 cara-')).every((line) => b.includes(line)),
    'the public CARA encounters are byte-identical');

  const stops = Object.fromEntries([...bound.matchAll(/^BOUND (\S+) stop=(\S+) nc3_epochs=(\d+) nc3_wall_s=(\S+) cascade_wall_s=(\S+)$/gm)]
    .map((m) => [m[1], { stop: m[2], epochs: Number(m[3]), nc3: Number(m[4]), cascade: Number(m[5]) }]));
  console.log(`bound: ${JSON.stringify(stops)}`);
  assert.equal(stops['needle-kernel']?.stop, 'NC3_KERNEL_UNAVAILABLE_REQUIRES_MC');
  assert.equal(stops['needle-budget']?.stop, 'NC3_WORK_BUDGET_REQUIRES_MC');
  assert.match(bound, /BOUND DONE/);

  const rows = [...accuracy.matchAll(/^ACCURACY foster A=(\S+) cases=(\d+) max_relative_error=(\S+) tolerance=(\S+) max_quadrature_points=(\d+) max_wall_us=(\S+)$/gm)];
  for (const m of rows) console.log(`Foster A=${m[1]}: ${m[2]} cases, max relative error ${m[3]} (tolerance ${m[4]}), max ${m[5]} quadrature points, max ${m[6]} us per call`);
  assert.deepEqual(rows.map((m) => Number(m[1])), [1, 10, 100, 1000, 10000]);
  assert.match(accuracy, /^ACCURACY DONE cases=225 /m);
});

const iso = (jd) => new Date((jd - 2440587.5) * 86400000).toISOString();
const RSW = { REFERENCE_FRAME_type: 'OrbitFrameWrapper', REFERENCE_FRAME: { frame: 'RSW_INERTIAL' } };
const TEME = { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } };
const COVARIANCE_KEYS = ['CX_X', 'CY_X', 'CY_Y', 'CZ_X', 'CZ_Y', 'CZ_Z', 'CX_DOT_X', 'CX_DOT_Y', 'CX_DOT_Z', 'CX_DOT_X_DOT',
  'CY_DOT_X', 'CY_DOT_Y', 'CY_DOT_Z', 'CY_DOT_X_DOT', 'CY_DOT_Y_DOT', 'CZ_DOT_X', 'CZ_DOT_Y', 'CZ_DOT_Z', 'CZ_DOT_X_DOT',
  'CZ_DOT_Y_DOT', 'CZ_DOT_Z_DOT'];
function source(tracks, key, norad) {
  const lines = tracks.samples.map((s) => {
    const [X, Y, Z, X_DOT, Y_DOT, Z_DOT] = s[key];
    return { EPOCH: iso(tracks.epochJd + s.t / 86400), X, Y, Z, X_DOT, Y_DOT, Z_DOT };
  });
  const lower = tracks.covariance[key];
  const covariance = tracks.samples.map((s) => ({ EPOCH: iso(tracks.epochJd + s.t / 86400),
    ...Object.fromEntries(COVARIANCE_KEYS.map((name, i) => [name, lower[i]])) }));
  // Synthetic identifiers are fixture metadata, not real spacecraft.
  return { OBJECT_ID: `needle-${key}`, OBJECT_NAME: `needle-${key}`, NORAD_CATALOG_ID: norad, EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{
    CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399, TIME_SYSTEM: 'UTC', REFERENCE_FRAME: TEME, COV_REFERENCE_FRAME: RSW,
    EPHEMERIS_DATA_LINES: lines, COVARIANCE_MATRIX_LINES: covariance }] } };
}

const wasmedgeAvailable = spawnSync('wasmedge', ['--version'], { stdio: 'ignore' }).status === 0;
for (const runtimeKind of (process.env.CQR_TEST_RUNTIME ? [process.env.CQR_TEST_RUNTIME] : ['browser', 'wasmedge'])) {
  test(`${runtimeKind}: a needle covariance through assess_conjunction answers by Monte Carlo with the named 3D-Nc refusal`, { timeout: 900000 }, async (t) => {
    if (runtimeKind === 'wasmedge' && !wasmedgeAvailable) { t.skip('wasmedge is not on PATH'); return; }
    const { candidate } = await built;
    const tracks = JSON.parse(await run(candidate, ['tracks']));
    const flatc = await initCqrFlatc();
    const h = await createConjunctionCommandHarness({ runtimeKind });
    t.after(() => h.destroy?.());
    const radiusM = tracks.radiusKm * 1000 / 2;
    const request = { PAIR_REQUEST: {
      PRIMARY: source(tracks, 'primary', 900101), SECONDARY: source(tracks, 'secondary', 900102),
      CONTROLS: { ...screeningControls({ startJd: tracks.epochJd - 60 / 86400, durationSeconds: 120, coarseStepSec: 5,
        combinedRadiusM: 2 * radiusM }), ALGORITHM: 'FOSTER' },
      PRIMARY_RADIUS_M: radiusM, SECONDARY_RADIUS_M: radiusM, EVALUATION_FRAME: earthFrame('TEME') } };
    const started = performance.now();
    const r = await h.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, request) }] });
    const seconds = (performance.now() - started) / 1000;
    assert.equal(r.statusCode, 0, `${r.errorCode ?? ''} ${r.errorMessage ?? ''}`);
    const e = decodeCqr(flatc, r.outputs.find((f) => f.portId === 'result').payload).EVENT_RESULT;
    assert.ok(Math.abs(e.MISS_DISTANCE_M - 1264.0123674698371) < 1, `miss ${e.MISS_DISTANCE_M} m`);
    assert.equal(e.PROBABILITY, undefined, 'a sampled answer is not a plane method');
    const comment = e.CONJUNCTION_MESSAGE?.OBJECT1?.COMMENT ?? '';
    console.log(`${runtimeKind}: assess_conjunction ${seconds.toFixed(2)} s; ${comment.match(STOP)?.[0].trim()}`);
    assert.match(comment, /3D-NC-HALL rejected \[[^\]]* NC3_KERNEL_UNAVAILABLE_REQUIRES_MC: /);
    assert.match(comment, /SDMC-TWO-BODY accepted/);
    assert.match(comment, /MC samples=65536 hits=\d+ /);
    assert.ok(seconds < 300, `assess_conjunction took ${seconds} s`);
  });
}
