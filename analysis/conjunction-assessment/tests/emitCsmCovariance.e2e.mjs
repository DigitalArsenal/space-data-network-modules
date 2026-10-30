// emit_csm on a pair whose sources carry covariance writes a CSM, and a
// refused message names its reason.
// Cause (0.16.0): conjunction_to_csm refused every event with a covariance
// Pc, or with a probability note or failure, because the CSM has no field for
// a covariance Pc's method, usage or confidence; emit() then masked that
// refusal as serialization-failed, "Unable to serialize conjunction message."
// The SDS CSM (1.271.0) carries no covariance at all: the objects, days since
// epoch, TCA, range, relative speed, MAX_PROB and DILUTION. 0.17.0: a CSM's
// MAX_PROB is the covariance-free Alfano maximum, and DILUTION its dilution
// threshold, from the miss distance and the combined hard-body radius,
// whatever the sources carry; the covariance Pc is on the CDM (emit_cdm). A
// message emit cannot write is refused with its reason (cdm-build-failed,
// message-too-large).
//
// Sources (invented, no real object), as tests/pairWindowTca.e2e.mjs builds
// them: two circular TEME orbits on one node line, ISS-like (a 6798 km, i
// 51.64 deg) and CSS-like (a 6765 km, i 41.47 deg), both at the ascending node
// at 2026-10-09T15:14:50Z (mu 398600.4418 km^3/s^2), sampled every 60 s as OEM
// (cubic Hermite, UTC), each with a 25 km^2 isotropic position covariance
// (TEME axes); hard-body radii 5 m each; a 30 min window about their 33 km
// node pass.
// (1) The covariance-bearing tracks, FOSTER (a covariance Pc) and
//     ALFANO_MAXIMUM: emit_csm answers a CSM; 0.16.0 refuses both requests
//     (serialization-failed). Read by the SDS CSM bindings and written back by
//     them, the CSM reads the same. Its objects, TCA, range, relative speed and
//     days since epoch are assess_conjunction's event; its MAX_PROB and
//     DILUTION are alfano_max_probability's for the event's miss and the 10 m
//     combined radius. For FOSTER, emit_cdm's CDM carries the event's Pc.
// (2) Sources without covariance: the same tracks without their covariance
//     lines (FOSTER and ALFANO_MAXIMUM, the generic engine) and two invented
//     GP element sets (tests/lib/syntheticCatalog.mjs, SYN-0-0 at 53 deg and
//     SYN-1-0 at 97.6 deg, ALFANO_MAXIMUM, the SGP4 path, 2 h from their
//     epoch): every CSM is 0.16.0's, byte for byte.
// (3) Captured-request replay against 0.16.0 (tests/lib/requestReplay.mjs):
//     every request of the module's suites, with GP input or without, answers
//     byte for byte alike, the instant a CDM is created aside.
// Tolerances: the CSM's TCA is (TCA Julian date - 2440587.5) x 86400 and its
// days since epoch the event's, exactly. The event reports metres and m/s, the
// CSM km and km/s, so range, relative speed and dilution agree to 1e-12 km
// (km/s), and MAX_PROB to 1e-12 relative (the Alfano method takes the event's
// miss in metres). Every answer is read with the SDS bindings, which keep each
// double exact.
// Run: node --test tests/emitCsmCovariance.e2e.mjs (needs dist/ built and the
// repository's git history)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Builder, ByteBuffer } from 'flatbuffers';
import { CDM } from 'spacedatastandards.org/lib/js/CDM/CDM.js';
import { CQR } from 'spacedatastandards.org/lib/js/CQR/CQR.js';
import { cqrProbabilityAlgorithm } from 'spacedatastandards.org/lib/js/CQR/cqrProbabilityAlgorithm.js';
import { CSM } from 'spacedatastandards.org/lib/js/CSM/CSM.js';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { earthFrame, encodeCqr, gpSource, initCqrFlatc, screeningControls } from './lib/cqr.mjs';
import { syntheticGp } from './lib/syntheticCatalog.mjs';
import { artifactAt, assertAllAlike, replaySuites } from './lib/requestReplay.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '478ad791079d24dcb1c8c2da693b54fa390b1b6b';  // conjunction-assessment 0.16.0
const MU = 398600.4418, STEP_S = 60, DEG = Math.PI / 180, JD_UNIX = 2440587.5;
const jdOf = (iso) => Date.parse(iso) / 86400000 + JD_UNIX;
const iso = (jd) => new Date((jd - JD_UNIX) * 86400000).toISOString();
const T0 = jdOf('2026-10-09T15:14:50Z');
const START_S = -6 * 3600, SAMPLES = 12 * 60 + 1;

const FRAME = { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } };
function source(a, iDeg, raanDeg, k, covariance) {
  const n = Math.sqrt(MU / a ** 3), i = iDeg * DEG, raan = raanDeg * DEG, data = [];
  const P = [Math.cos(raan), Math.sin(raan), 0], Q = [-Math.sin(raan) * Math.cos(i), Math.cos(raan) * Math.cos(i), Math.sin(i)];
  for (let s = 0; s < SAMPLES; s++) {
    const u = n * (START_S + s * STEP_S);
    for (let c = 0; c < 3; c++) data.push(a * (Math.cos(u) * P[c] + Math.sin(u) * Q[c]));
    for (let c = 0; c < 3; c++) data.push(a * n * (-Math.sin(u) * P[c] + Math.cos(u) * Q[c]));
  }
  const edges = [START_S, START_S + (SAMPLES - 1) * STEP_S];
  return { OBJECT_ID: `SAMPLED-${k}`, OBJECT_NAME: `SAMPLED-${k}`, NORAD_CATALOG_ID: 900011 + 'AB'.indexOf(k),
    EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399, REFERENCE_FRAME: FRAME, COV_REFERENCE_FRAME: FRAME,
      TIME_SYSTEM: 'UTC', START_TIME: iso(T0 + START_S / 86400), INTERPOLATION: 'HERMITE', INTERPOLATION_DEGREE: 3, STEP_SIZE: STEP_S,
      STATE_VECTOR_SIZE: 6, EPHEMERIS_DATA: data,
      ...(covariance ? { COVARIANCE_MATRIX_LINES: edges.map((sec) => ({ EPOCH: iso(T0 + sec / 86400),
        CX_X: 25, CY_Y: 25, CZ_Z: 25, CX_DOT_X_DOT: 1e-6, CY_DOT_Y_DOT: 1e-6, CZ_DOT_Z_DOT: 1e-6 })) } : {}) }] } };
}
const tracks = (covariance) => [source(6798, 51.64, 100, 'A', covariance), source(6765, 41.47, 100, 'B', covariance)];
const COVARIANT = tracks(true), PLAIN = tracks(false);
const PASS_WINDOW = [T0 - 900 / 86400, 1800];
const GP = (() => { const all = syntheticGp({ epoch: '2026-10-01T00:00:00.000000' }); return [all[0], all[40]].map(gpSource); })();
const GP_WINDOW = [jdOf('2026-10-01T00:00:00Z'), 7200];

const flatc = await initCqrFlatc();
const pairRecord = ([PRIMARY, SECONDARY], algorithm, [startJd, durationSeconds] = PASS_WINDOW) => ({ PAIR_REQUEST: { PRIMARY, SECONDARY,
  PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME'), CONTROLS: { ...screeningControls({ startJd, durationSeconds,
    coarseStepSec: 60, thresholdKm: 2000, fineTolSec: 0.001, combinedRadiusM: 10 }), ALGORITHM: algorithm } } });
const invoke = (harness, methodId, record) => harness.invoke({ methodId, inputs: [{ portId: 'request', payload: encodeCqr(flatc, record) }] });
// Answers are read with the SDS bindings, which keep every double exact.
const answer = (response) => CQR.getRootAsCQR(new ByteBuffer(response.outputs[0].payload)).unpack();
const close = (x, y, tolerance, label) => assert.ok(Math.abs(x - y) <= tolerance, `${label}: ${x} against ${y}`);
const csmOf = (response) => {
  assert.equal(response.statusCode, 0, `emit_csm ${response.errorCode}: ${response.errorMessage}`);
  const frame = response.outputs.find((f) => f.portId === 'csm');
  assert.ok(frame && CSM.bufferHasIdentifier(new ByteBuffer(frame.payload)), 'a $CSM on the csm port');
  return frame.payload;
};

test('emit_csm writes a CSM whatever the sources carry; MAX_PROB is the covariance-free Alfano maximum', { concurrency: true }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-emit-csm-'));
  const base = artifactAt(packageRoot, BASE, work);
  try {
    await Promise.all([
      t.test('a covariance-bearing pair: a CSM that round-trips through the SDS bindings, with the event\'s values and the Alfano maximum; the CDM keeps the Pc; without covariance the CSM is 0.16.0\'s', async () => {
        const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
        const previous = await createConjunctionCommandHarness({ runtimeKind: 'browser', wasmSource: base });
        try {
          // (1) Covariance on both tracks.
          for (const algorithm of ['FOSTER', 'ALFANO_MAXIMUM']) {
            const label = `${algorithm}, covariance-bearing`;
            const assessed = await invoke(harness, 'assess_conjunction', pairRecord(COVARIANT, algorithm));
            assert.equal(assessed.statusCode, 0, `${label}: assess_conjunction ${assessed.errorCode}: ${assessed.errorMessage}`);
            const event = answer(assessed).EVENT_RESULT;

            // 0.16.0 refuses the same request behind a generic message.
            const refused = await invoke(previous, 'emit_csm', pairRecord(COVARIANT, algorithm));
            assert.equal(refused.statusCode, 400, `${label}: 0.16.0`);
            assert.equal(refused.errorCode, 'serialization-failed', `${label}: 0.16.0 ${refused.errorMessage}`);

            const bytes = csmOf(await invoke(harness, 'emit_csm', pairRecord(COVARIANT, algorithm)));
            const read = CSM.getRootAsCSM(new ByteBuffer(bytes)).unpack();
            const builder = new Builder(1024);
            CSM.finishCSMBuffer(builder, read.pack(builder));
            assert.deepEqual(CSM.getRootAsCSM(new ByteBuffer(builder.asUint8Array())).unpack(), read, `${label}: written back and read again, the same CSM`);

            const alfano = await invoke(harness, 'alfano_max_probability', { ALFANO_REQUEST: { MISS_DISTANCE_M: event.MISS_DISTANCE_M, COMBINED_RADIUS_M: 10 } });
            assert.equal(alfano.statusCode, 0, `alfano_max_probability ${alfano.errorCode}: ${alfano.errorMessage}`);
            const maximum = answer(alfano).ALFANO_RESULT;
            for (const [object, name, norad] of [[read.OBJECT_1, 'SAMPLED-A', 900011], [read.OBJECT_2, 'SAMPLED-B', 900012]]) {
              assert.equal(object.OBJECT_NAME, name, label);
              assert.equal(object.OBJECT_ID, name, label);
              assert.equal(object.NORAD_CAT_ID, norad, label);
            }
            assert.equal(read.TCA, (event.TCA.JULIAN_DATE - JD_UNIX) * 86400, `${label}: TCA, Unix seconds`);
            close(read.TCA_RANGE, event.MISS_DISTANCE_M / 1000, 1e-12, `${label}: range, km`);
            close(read.TCA_RELATIVE_SPEED, event.RELATIVE_SPEED_M_S / 1000, 1e-12, `${label}: relative speed, km/s`);
            assert.equal(read.DSE_1, event.PRIMARY_DAYS_SINCE_EPOCH, `${label}: primary days since epoch`);
            assert.equal(read.DSE_2, event.SECONDARY_DAYS_SINCE_EPOCH, `${label}: secondary days since epoch`);
            close(read.MAX_PROB, maximum.MAXIMUM_PROBABILITY, 1e-12 * maximum.MAXIMUM_PROBABILITY, `${label}: MAX_PROB, the Alfano maximum`);
            close(read.DILUTION, maximum.DILUTION_THRESHOLD_M / 1000, 1e-12, `${label}: DILUTION, km`);
            if (algorithm !== 'FOSTER') continue;

            // The covariance Pc is the CDM's.
            assert.equal(event.PROBABILITY.ALGORITHM, cqrProbabilityAlgorithm.FOSTER, `${label}: the event's Pc is the covariance method's`);
            assert.ok(event.PROBABILITY.PROBABILITY > 0 && read.MAX_PROB !== event.PROBABILITY.PROBABILITY, `${label}: Pc ${event.PROBABILITY.PROBABILITY}`);
            const emitted = await invoke(harness, 'emit_cdm', pairRecord(COVARIANT, algorithm));
            assert.equal(emitted.statusCode, 0, `${label}: emit_cdm ${emitted.errorCode}: ${emitted.errorMessage}`);
            const cdm = CDM.getRootAsCDM(new ByteBuffer(emitted.outputs.find((f) => f.portId === 'cdm').payload));
            assert.equal(cdm.COLLISION_PROBABILITY(), event.PROBABILITY.PROBABILITY, `${label}: the CDM carries the FOSTER Pc`);
            console.log(`${label}: CSM MAX_PROB ${read.MAX_PROB} (Alfano maximum at ${event.MISS_DISTANCE_M.toFixed(3)} m, 10 m), ` +
              `CDM Pc ${cdm.COLLISION_PROBABILITY()}; 0.16.0: ${refused.errorCode}`);
          }

          // (2) Without covariance the CSM is 0.16.0's, byte for byte.
          for (const [label, record] of [['FOSTER, tracks without covariance', pairRecord(PLAIN, 'FOSTER')],
            ['ALFANO_MAXIMUM, tracks without covariance', pairRecord(PLAIN, 'ALFANO_MAXIMUM')],
            ['ALFANO_MAXIMUM, GP element sets', pairRecord(GP, 'ALFANO_MAXIMUM', GP_WINDOW)]]) {
            const now = csmOf(await invoke(harness, 'emit_csm', record)), before = csmOf(await invoke(previous, 'emit_csm', record));
            assert.equal(Buffer.compare(Buffer.from(now), Buffer.from(before)), 0, `${label}: the CSM is 0.16.0's`);
          }
        } finally {
          await harness.destroy?.();
          await previous.destroy?.();
        }
      }),
      t.test('captured-request replay: every request of the module suites answers byte for byte as 0.16.0 does', async () => {
        console.log(assertAllAlike(await replaySuites({ packageRoot, base, dir: work }), `0.16.0 (${BASE.slice(0, 9)})`));
      }),
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
