// The pair methods on two sampled sources: the time of closest approach in a
// window is the window's least-miss local minimum of the range, the very event
// screen_catalog reports for that minimum, and never a window edge (checked
// through find_tca, assess_conjunction and emit_cdm). A window whose range has
// no local minimum is refused by find_tca, assess_conjunction, emit_cdm and
// emit_csm alike: 422, no-close-approach. A range constant over the window
// (co-located objects, a formation) is refused apart: 422, constant-range,
// with the range in the message.
// Run: node --test tests/pairWindowTca.e2e.mjs (needs dist/ built; the
// wasmedge leg needs WasmEdge under ~/.wasmedge, CQR_TEST_RUNTIME picks one).
//
// Sources (invented, no real object): two circular TEME orbits on one node
// line, ISS-like (a 6798 km, i 51.64 deg) and CSS-like (a 6765 km, i 41.47 deg),
// both at the ascending node at 2026-10-09T15:14:50Z: uniform circular motion
// r = a (cos u P + sin u Q), u = n (t - t0), n = sqrt(mu / a^3), mu =
// 398600.4418 km^3/s^2, sampled every 60 s in UTC as OEM compact grids (cubic
// Hermite), as tests/windowedScreenParity.test.mjs builds them. Every node
// passage, half an orbit apart, is a local minimum of the range: 33.000 km at
// t0, 158 km half an orbit either side, 620 km two orbits later. Each object
// carries a 25 km^2 isotropic position covariance (TEME axes) so the FOSTER
// probability is a covariance result; ALFANO_MAXIMUM needs none. Windows lie
// on a 12 h grid, or on a 30 min grid whose first or last sample is the window
// edge: a minimum 1 s or 3 s inside the start or end of an ephemeris is found,
// a range rising away from that edge has none, and a window starting 30 s
// inside its coverage is the control.
//
// Reference (a test-only oracle, not shipped physics): the range of the same
// cubic Hermite interpolation of the same samples that the module applies
// (src/cpp/src/ephemeris_source.cpp, OEMEphemerisSource::state_at), scanned
// every 10 ms across the window, each local minimum refined by golden section
// to 1 us, in seconds from the grid start (a Julian date resolves 40 us).
//
// Tolerances: the pair methods and screen_catalog run one search, so their
// TCA, miss distance, relative speed and probability are identical (exact
// equality). Against the reference: TCA within 1 ms, the requested refinement
// tolerance (REFINEMENT_TOLERANCE_SECONDS); module and reference interpolate
// the same samples alike, so interpolation adds no error between them. Miss
// within 1 cm.
//
// The mean-element leg: two invented GP element sets (SGP4, TEME) whose
// closest approach in a 20 min window is above 50 km, the case the former
// search answered with a point beside the window edge. Its reference is
// screen_catalog's event for that minimum on the generic engine path (FOSTER),
// so pair and catalog agree exactly there; on the ALFANO_MAXIMUM branch the
// catalog event comes from the SGP4 screener, a separate refinement, and
// agrees to 1 ms and 1 cm.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpSource, initCqrFlatc, screeningControls } from './lib/cqr.mjs';

const MU = 398600.4418, STEP_S = 60, DEG = Math.PI / 180;
const JD_UNIX = 2440587.5, jdOf = (iso) => Date.parse(iso) / 86400000 + JD_UNIX;
const iso = (jd) => new Date((jd - JD_UNIX) * 86400000).toISOString();
const T0 = jdOf('2026-10-09T15:14:50Z'); // both objects at the node: the 33 km pass

// Both tracks sampled every 60 s from t0 + startSec, count samples: the
// coverage is [t0 + startSec, t0 + startSec + (count - 1) 60 s].
function grid(startSec, count) {
  const orbit = (a, iDeg, raanDeg) => {
    const n = Math.sqrt(MU / a ** 3), i = iDeg * DEG, raan = raanDeg * DEG;
    const P = [Math.cos(raan), Math.sin(raan), 0], Q = [-Math.sin(raan) * Math.cos(i), Math.cos(raan) * Math.cos(i), Math.sin(i)];
    const data = [];
    for (let k = 0; k < count; k++) {
      const u = n * (startSec + k * STEP_S);
      for (let c = 0; c < 3; c++) data.push(a * (Math.cos(u) * P[c] + Math.sin(u) * Q[c]));
      for (let c = 0; c < 3; c++) data.push(a * n * (-Math.sin(u) * P[c] + Math.cos(u) * Q[c]));
    }
    return data;
  };
  const startIso = iso(T0 + startSec / 86400);
  return { startSec, count, startIso, g0: jdOf(startIso), endSec: startSec + (count - 1) * STEP_S,
    data: [orbit(6798, 51.64, 100), orbit(6765, 41.47, 100)] };
}

// The reference interpolant: seconds from t0 on grid g.
function position(g, data, sec) {
  const s = (sec - g.startSec) / STEP_S, k = Math.min(Math.max(Math.floor(s), 0), g.count - 2), t = s - k;
  const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
  return [0, 1, 2].map((c) => h00 * data[6 * k + c] + h10 * STEP_S * data[6 * k + 3 + c]
    + h01 * data[6 * (k + 1) + c] + h11 * STEP_S * data[6 * (k + 1) + 3 + c]);
}
function range(g, sec) {
  const a = position(g, g.data[0], sec), b = position(g, g.data[1], sec);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
// Local minima of the range with TCA in [s0, s1) inside the coverage: a dense
// 10 ms scan, each sample below both neighbours refined by golden section.
function referenceMinima(g, s0, s1) {
  const out = [], h = 0.01, ratio = (Math.sqrt(5) - 1) / 2;
  const lo0 = Math.max(s0 - h, g.startSec), hi0 = Math.min(s1 + h, g.endSec);
  let previous = range(g, lo0), current = range(g, lo0 + h);
  for (let s = lo0 + h; s + h <= hi0; s += h) {
    const next = range(g, s + h);
    if (current < previous && current <= next) {
      let lo = s - h, hi = s + h;
      while (hi - lo > 1e-6) {
        const c = hi - ratio * (hi - lo), d = lo + ratio * (hi - lo);
        if (range(g, c) < range(g, d)) hi = d; else lo = c;
      }
      const sec = (lo + hi) / 2;
      if (sec >= s0 && sec < s1) out.push({ sec, miss: range(g, sec) });
    }
    previous = current;
    current = next;
  }
  return out;
}

const COVARIANCE_FRAME = { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } };
const sampledSources = (g) => g.data.map((data, i) => ({ OBJECT_ID: `SAMPLED-${'AB'[i]}`, OBJECT_NAME: `SAMPLED-${'AB'[i]}`, NORAD_CATALOG_ID: 900011 + i,
  EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399, REFERENCE_FRAME: COVARIANCE_FRAME,
    COV_REFERENCE_FRAME: COVARIANCE_FRAME, TIME_SYSTEM: 'UTC', START_TIME: g.startIso,
    INTERPOLATION: 'HERMITE', INTERPOLATION_DEGREE: 3, STEP_SIZE: STEP_S, STATE_VECTOR_SIZE: 6, EPHEMERIS_DATA: data,
    COVARIANCE_MATRIX_LINES: [g.startSec, g.endSec].map((sec) => ({ EPOCH: iso(T0 + sec / 86400),
      CX_X: 25, CY_Y: 25, CZ_Z: 25, CX_DOT_X_DOT: 1e-6, CY_DOT_Y_DOT: 1e-6, CZ_DOT_Z_DOT: 1e-6 })) }] } }));

const flatc = await initCqrFlatc();
const controls = (startJd, durationSeconds, algorithm) => ({ ...screeningControls({ startJd, durationSeconds,
  coarseStepSec: 60, thresholdKm: 2000, fineTolSec: 0.001, combinedRadiusM: 10 }), ALGORITHM: algorithm });
const pairRecord = (primary, secondary, c) => ({ PAIR_REQUEST: { PRIMARY: primary, SECONDARY: secondary, CONTROLS: c,
  PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME') } });
const catalogRecord = (primary, secondary, c) => ({ CATALOG_REQUEST: { PRIMARIES: [primary], SECONDARIES: [secondary],
  CONTROLS: c, EVALUATION_FRAME: earthFrame('TEME') } });

async function invoke(harness, methodId, record) {
  const response = await harness.invoke({ methodId, inputs: [{ portId: 'request', payload: encodeCqr(flatc, record) }] });
  return response;
}
async function pairEvent(harness, primary, secondary, c, label) {
  const assessed = await invoke(harness, 'assess_conjunction', pairRecord(primary, secondary, c));
  assert.equal(assessed.statusCode, 0, `${label}: assess_conjunction ${assessed.errorCode}: ${assessed.errorMessage}`);
  const event = decodeCqr(flatc, assessed.outputs[0].payload).EVENT_RESULT;
  const found = await invoke(harness, 'find_tca', pairRecord(primary, secondary, c));
  assert.equal(found.statusCode, 0, `${label}: find_tca ${found.errorCode}: ${found.errorMessage}`);
  assert.equal(decodeCqr(flatc, found.outputs[0].payload).TCA_RESULT.JULIAN_DATE, event.TCA.JULIAN_DATE, `${label}: find_tca names assess_conjunction's TCA`);
  const emitted = await invoke(harness, 'emit_cdm', pairRecord(primary, secondary, c));
  assert.equal(emitted.statusCode, 0, `${label}: emit_cdm ${emitted.errorCode}: ${emitted.errorMessage}`);
  return event;
}
async function catalogEvents(harness, primary, secondary, c, label) {
  const response = await invoke(harness, 'screen_catalog', catalogRecord(primary, secondary, c));
  assert.equal(response.statusCode, 0, `${label}: screen_catalog ${response.errorCode}: ${response.errorMessage}`);
  const result = decodeCqr(flatc, response.outputs[0].payload).CATALOG_RESULT;
  assert.equal(result.STATISTICS.FAILED_PAIRS, 0, `${label}: screen_catalog failed pairs`);
  return result.EVENTS ?? [];
}
async function assertRefused(harness, primary, secondary, c, label, code = 'no-close-approach', text = /no local minimum in the window/) {
  for (const methodId of ['find_tca', 'assess_conjunction', 'emit_cdm', 'emit_csm']) {
    const response = await invoke(harness, methodId, pairRecord(primary, secondary, c));
    assert.equal(response.statusCode, 422, `${label}: ${methodId} status ${response.statusCode} ${response.errorCode}`);
    assert.equal(response.errorCode, code, `${label}: ${methodId} ${response.errorMessage}`);
    assert.match(response.errorMessage, text, `${label}: ${methodId}`);
  }
}
const exactlyAlike = (pair, event, label) => {
  assert.equal(pair.TCA.JULIAN_DATE, event.TCA.JULIAN_DATE, `${label}: TCA equals screen_catalog's`);
  assert.equal(pair.MISS_DISTANCE_M, event.MISS_DISTANCE_M, `${label}: miss equals screen_catalog's`);
  assert.equal(pair.RELATIVE_SPEED_M_S, event.RELATIVE_SPEED_M_S, `${label}: relative speed equals screen_catalog's`);
  assert.deepEqual(pair.PROBABILITY, event.PROBABILITY, `${label}: probability equals screen_catalog's`);
};

// Windows [start, start + duration), in seconds from t0, on the 12 h grid
// from 09:00Z or on a 30 min grid whose coverage edge is the window edge.
const HALF_ORBIT = 2787, MAIN = grid(-22490, 12 * 60 + 1);
const FOUND = [
  ['interior', MAIN, -900, 1800],
  ['a 2 s window centred on the pass (edges equally far)', MAIN, -1, 2],
  ['1 s inside the start edge', MAIN, -1, 1800],
  ['1 s inside the end edge', MAIN, 1 - 1800, 1800],
  ['two minima, the closer second', MAIN, -HALF_ORBIT - 900, HALF_ORBIT + 1800],
  ['two minima, the closer first', MAIN, -900, HALF_ORBIT + 1800],
  ['closest approach above 50 km', MAIN, 4 * HALF_ORBIT - 900, 1800],
  ['1 s inside a coverage start', grid(-1, 31), -1, 600],
  ['3 s inside a coverage start', grid(-3, 31), -3, 600],
  ['1 s inside a coverage end', grid(1 - 1800, 31), 1 - 600, 600],
  ['3 s inside a coverage end', grid(3 - 1800, 31), 3 - 600, 600],
  ['1 s inside a window 30 s inside coverage (control)', grid(-31, 31), -1, 600],
];
const REFUSED = [
  ['minimum 1 s before the start edge', MAIN, 1, 600],
  ['minimum 1 s after the end edge', MAIN, -601, 600],
  ['monotonic range', MAIN, 600, 1200],
  ['range increasing away from a coverage start', grid(1, 31), 1, 600],
  ['range increasing away from a coverage end', grid(-1 - 1800, 31), -601, 600],
];
// A range constant over the window has no time of closest approach, and is
// refused apart from "no close approach", with its value: the second track is
// the first (co-located), or the first scaled out by 10 m (a formation).
const alongside = (g, km) => ({ ...g, data: [g.data[0], g.data[0].map((x) => x * (1 + km / 6798))] });
const CONSTANT = [['co-located', alongside(MAIN, 0), '0.000'], ['a formation at 10 m', alongside(MAIN, .01), '10.000']];
const windowStartJd = (g, offset) => g.g0 + (offset - g.startSec) / 86400;
const secondsFromT0 = (g, jd) => (jd - g.g0) * 86400 + g.startSec;

for (const runtimeKind of (process.env.CQR_TEST_RUNTIME ? [process.env.CQR_TEST_RUNTIME] : ['browser', 'wasmedge'])) {
  test(`${runtimeKind}: sampled sources, the pair TCA is screen_catalog's least-miss minimum, never a window edge`, async () => {
    const harness = await createConjunctionCommandHarness({ runtimeKind });
    try {
      for (const [label, g, offset, duration] of FOUND) {
        const [a, b] = sampledSources(g), startJd = windowStartJd(g, offset);
        const minima = referenceMinima(g, offset, offset + duration);
        assert.ok(minima.length >= 1 && minima.length <= 2, `${label}: ${minima.length} reference minima`);
        if (label.startsWith('two minima')) assert.equal(minima.length, 2, `${label}: two reference minima`);
        if (label.includes('above 50 km')) assert.ok(minima[0].miss > 50, `${label}: reference miss ${minima[0].miss} km`);
        const closest = minima.reduce((x, y) => (y.miss < x.miss ? y : x));
        for (const algorithm of ['ALFANO_MAXIMUM', 'FOSTER']) {
          const c = controls(startJd, duration, algorithm), tag = `${label} (${algorithm})`;
          const pair = await pairEvent(harness, a, b, c, tag);
          const events = await catalogEvents(harness, a, b, c, tag);
          assert.equal(events.length, minima.length, `${tag}: screen_catalog reports every minimum`);
          const least = events.reduce((x, y) => (y.MISS_DISTANCE_M < x.MISS_DISTANCE_M ? y : x));
          exactlyAlike(pair, least, tag);
          const dt = secondsFromT0(g, pair.TCA.JULIAN_DATE) - closest.sec;
          assert.ok(Math.abs(dt) <= 0.001, `${tag}: TCA ${dt} s from the reference`);
          assert.ok(Math.abs(pair.MISS_DISTANCE_M - closest.miss * 1000) <= 0.01, `${tag}: miss ${pair.MISS_DISTANCE_M - closest.miss * 1000} m from the reference`);
          if (algorithm === 'FOSTER') assert.equal(pair.PRIMARY_COVARIANCE_BASIS, 'SOURCE_EPHEMERIS', `${tag}: covariance probability`);
        }
      }
      for (const [label, g, offset, duration] of REFUSED) {
        const [a, b] = sampledSources(g), startJd = windowStartJd(g, offset);
        assert.equal(referenceMinima(g, offset, offset + duration).length, 0, `${label}: no reference minimum in the window`);
        for (const algorithm of ['ALFANO_MAXIMUM', 'FOSTER']) {
          const c = controls(startJd, duration, algorithm), tag = `${label} (${algorithm})`;
          await assertRefused(harness, a, b, c, tag);
          assert.equal((await catalogEvents(harness, a, b, c, tag)).length, 0, `${tag}: screen_catalog reports none`);
        }
      }
      for (const [label, g, metres] of CONSTANT) {
        const [a, b] = sampledSources(g);
        for (const algorithm of ['ALFANO_MAXIMUM', 'FOSTER'])
          await assertRefused(harness, a, b, controls(windowStartJd(g, -900), 1800, algorithm), `${label} (${algorithm})`,
            'constant-range', new RegExp(`constant over the window at ${metres.replace('.', '\\.')} m`));
      }
    } finally {
      await harness.destroy?.();
    }
  });

  test(`${runtimeKind}: mean elements, a closest approach above 50 km is found on both pair branches`, async () => {
    const harness = await createConjunctionCommandHarness({ runtimeKind });
    try {
      const gp = (name, norad, elements) => gpSource({ OBJECT_NAME: name, OBJECT_ID: name, NORAD_CAT_ID: norad, EPOCH: '2026-10-09T00:00:00.000000',
        ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1, CLASSIFICATION_TYPE: 'U', BSTAR: 0, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
        ECCENTRICITY: 0.0001, ARG_OF_PERICENTER: 0, ...elements });
      const a = gp('SYN-MEAN-A', 900021, { MEAN_MOTION: 15.05, INCLINATION: 53, RA_OF_ASC_NODE: 10, MEAN_ANOMALY: 0 });
      const b = gp('SYN-MEAN-B', 900022, { MEAN_MOTION: 15.06, INCLINATION: 97.6, RA_OF_ASC_NODE: 12, MEAN_ANOMALY: 3 });
      const day = jdOf('2026-10-09T00:00:00Z');
      // Every minimum within 2000 km over 6 h, from the generic engine path.
      const minima = await catalogEvents(harness, a, b, controls(day, 6 * 3600, 'FOSTER'), 'mean survey');
      const far = minima.filter((e) => e.MISS_DISTANCE_M > 50e3);
      assert.ok(far.length > 0, `mean survey: ${minima.length} minima, none above 50 km`);
      const target = far[0];
      const startJd = target.TCA.JULIAN_DATE - 600 / 86400;
      const near = minima.filter((e) => Math.abs(e.TCA.JULIAN_DATE - target.TCA.JULIAN_DATE) * 86400 < 600);
      assert.equal(near.length, 1, 'mean: one minimum in the 20 min window');
      for (const algorithm of ['FOSTER', 'ALFANO_MAXIMUM']) {
        const c = controls(startJd, 1200, algorithm), tag = `mean ${algorithm}`;
        const pair = await pairEvent(harness, a, b, c, tag);
        const events = await catalogEvents(harness, a, b, c, tag);
        assert.equal(events.length, 1, `${tag}: screen_catalog reports the one minimum`);
        if (algorithm === 'FOSTER') exactlyAlike(pair, events[0], tag);
        assert.ok(Math.abs(pair.TCA.JULIAN_DATE - target.TCA.JULIAN_DATE) * 86400 <= 0.001, `${tag}: TCA`);
        assert.ok(Math.abs(pair.MISS_DISTANCE_M - target.MISS_DISTANCE_M) <= 0.01, `${tag}: miss`);
        assert.ok(Math.abs(pair.TCA.JULIAN_DATE - events[0].TCA.JULIAN_DATE) * 86400 <= 0.001, `${tag}: TCA against screen_catalog`);
        assert.ok(Math.abs(pair.MISS_DISTANCE_M - events[0].MISS_DISTANCE_M) <= 0.01, `${tag}: miss against screen_catalog`);
      }
      // A window on the outbound leg after that minimum holds none.
      await assertRefused(harness, a, b, controls(target.TCA.JULIAN_DATE + 1 / 86400, 60, 'ALFANO_MAXIMUM'), 'mean outbound');
    } finally {
      await harness.destroy?.();
    }
  });
}
