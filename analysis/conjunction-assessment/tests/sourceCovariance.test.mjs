// Covariance from the sources that carry it (OEM covariance lines), through
// the module surface: the covariance method's probability, labelled as the
// sources' own uncalibrated covariance, survives a CDM round trip; a
// covariance in a frame the guest would have to transform is refused.
//
// Two straight-line OEM tracks cross with a 50 m miss at JD0; each carries an
// RTN covariance of 100/300/100 m (1 sigma).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, initCqrFlatc, screeningControls } from './lib/cqr.mjs';

const JD0 = 2461314.5;
const iso = (jd) => new Date((jd - 2440587.5) * 86400000).toISOString();
const RSW = { REFERENCE_FRAME_type: 'OrbitFrameWrapper', REFERENCE_FRAME: { frame: 'RSW_INERTIAL' } };
const EME2000 = { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'EME2000' } };

function track(id, origin, velocity, covarianceFrame) {
  const lines = [];
  for (let t = -300; t <= 300; t += 60) {
    lines.push({ EPOCH: iso(JD0 + t / 86400),
      X: origin[0] + velocity[0] * t, Y: origin[1] + velocity[1] * t, Z: origin[2] + velocity[2] * t,
      X_DOT: velocity[0], Y_DOT: velocity[1], Z_DOT: velocity[2] });
  }
  const covariance = [-300, 300].map((t) => ({ EPOCH: iso(JD0 + t / 86400),
    CX_X: 0.01, CY_Y: 0.09, CZ_Z: 0.01, CX_DOT_X_DOT: 1e-6, CY_DOT_Y_DOT: 1e-6, CZ_DOT_Z_DOT: 1e-6 }));
  return { OBJECT_ID: id, OBJECT_NAME: id, EPHEMERIS: { EPHEMERIS_DATA_BLOCK: [{
    CENTER_NAME: 'EARTH', CENTER_NAIF_ID: 399, TIME_SYSTEM: 'UTC',
    REFERENCE_FRAME: { REFERENCE_FRAME_type: 'CelestialFrameWrapper', REFERENCE_FRAME: { frame: 'TEMEOFDATE' } },
    COV_REFERENCE_FRAME: covarianceFrame, EPHEMERIS_DATA_LINES: lines, COVARIANCE_MATRIX_LINES: covariance }] } };
}
const request = (covarianceFrame) => ({ PAIR_REQUEST: {
  PRIMARY: track('A', [7000, 0, 0], [0, 7.5, 0], RSW),
  SECONDARY: track('B', [7000.05, 0, 0], [0, 0, 7.5], covarianceFrame),
  CONTROLS: { ...screeningControls({ startJd: JD0 - 200 / 86400, durationSeconds: 400, coarseStepSec: 5 }), ALGORITHM: 'LAAS_2015' },
  PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME') } });

test('OEM covariance gives a covariance probability that survives a CDM round trip', async () => {
  const flatc = await initCqrFlatc();
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const payload = encodeCqr(flatc, request(RSW));
    const assessed = await h.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload }] });
    assert.equal(assessed.statusCode, 0, assessed.errorMessage);
    const e = decodeCqr(flatc, assessed.outputs[0].payload).EVENT_RESULT;
    // A Julian date resolves TCA to about 47 us: 0.5 m along a 10.6 km/s pass.
    assert.ok(Math.abs(e.MISS_DISTANCE_M - 50) < 0.05, `miss ${e.MISS_DISTANCE_M}`);
    assert.equal(e.PROBABILITY.ALGORITHM, 'LAAS_2015');
    assert.equal(e.PROBABILITY.UNCERTAINTY_SOURCE, 'SUPPLIED_COVARIANCE');
    assert.equal(e.PROBABILITY.CALIBRATION, 'Uncalibrated');
    assert.equal(e.PROBABILITY.CROSS_CORRELATION, 'INDEPENDENT');
    assert.equal(e.PRIMARY_COVARIANCE_BASIS, 'SOURCE_EPHEMERIS');
    assert.equal(e.SECONDARY_COVARIANCE_BASIS, 'SOURCE_EPHEMERIS');
    for (const [got, want] of [[e.PRIMARY_SIGMA_RTN_M, [100, 300, 100]], [e.SECONDARY_SIGMA_RTN_M, [100, 300, 100]]]) {
      assert.deepEqual([got.X, got.Y, got.Z].map((x) => Math.round(x)), want);
    }
    assert.ok(e.PROBABILITY.PROBABILITY > 1e-6 && e.PROBABILITY.PROBABILITY < 1);

    const cdm = await h.invoke({ methodId: 'emit_cdm', inputs: [{ portId: 'request', payload }] });
    assert.equal(cdm.statusCode, 0, cdm.errorMessage);
    const cdmFrame = cdm.outputs.find((f) => f.portId === 'cdm');
    const fromCdm = await h.invoke({ methodId: 'compute_pc_from_cdm', inputs: [{ portId: 'cdm', payload: cdmFrame.payload }] });
    assert.equal(fromCdm.statusCode, 0, fromCdm.errorMessage);
    const p = decodeCqr(flatc, fromCdm.outputs[0].payload).PROBABILITY_RESULT.PROBABILITY;
    assert.ok(Math.abs(p - e.PROBABILITY.PROBABILITY) <= 1e-9 * e.PROBABILITY.PROBABILITY,
      `CDM ${p} vs event ${e.PROBABILITY.PROBABILITY}`);
    const kvn = await h.invoke({ methodId: 'write_cdm_kvn', inputs: [{ portId: 'cdm', payload: cdmFrame.payload }] });
    assert.equal(kvn.statusCode, 0, kvn.errorMessage);
  } finally {
    await h.destroy?.();
  }
});

test('a source covariance in another inertial frame is refused', async () => {
  const flatc = await initCqrFlatc();
  const h = await createConjunctionCommandHarness({ runtimeKind: 'browser' });
  try {
    const r = await h.invoke({ methodId: 'assess_conjunction', inputs: [{ portId: 'request', payload: encodeCqr(flatc, request(EME2000)) }] });
    assert.notEqual(r.statusCode, 0);
    assert.equal(r.errorCode, 'covariance-frame-mismatch');
  } finally {
    await h.destroy?.();
  }
});

// Closed-form straight-line encounters. Source: r_A=(7000,7.5t,0) km,
// r_B=(7000.05,0,7.5t) km, t seconds from JD0 UTC, TEME states / RTN
// covariance. Thus TCA=JD0, miss=50 m, RTN relative position=(50,0,0) m.
// Allow 2 ms at TCA / 8 m transversely: the 1 ms refinement tolerance
// at 7.5 km/s bounds each component by 7.5 m, plus JD quantization;
// text round trips allow 1e-6 m (six decimal places in metres).
// Non-PSD oracles: negative variance, or the R/T block determinant
// .01*.09-.04^2=-.0007 km^4 despite positive diagonals. Velocity-only
// negative variance also invalidates the supplied full 6x6 covariance.
// A zero position covariance is PSD but singular: Laas cannot calculate Pc,
// so its internal Alfano-maximum fallback must not be serialized as Pc.
// Pc=0 oracle: isotropic 1 m^2 per object, 1 mm combined radius at 50 m
// miss. The Gaussian disk integral is bounded by
// (R^2/(2*sigma^2))*exp(-(d-R)^2/(2*sigma^2)) < 1e-278, with sigma^2=2 m^2.
// For the underflow case below, 100 m miss makes that bound < 1e-1090,
// below binary64's smallest positive number. Exact zero is expected.
import { publishedSchema } from './lib/cqr.mjs';

const decodeCdm = (flatc, payload) => JSON.parse(flatc.generateJSON(publishedSchema('CDM'),
  { path: '/cdm.bin', data: payload }, { defaultsJson: true }));
const encodeCdm = (flatc, record) => flatc.generateBinary(publishedSchema('CDM'),
  JSON.stringify(record), { sizePrefix: false });

function cdmCase(kind) {
  const r = request(RSW);
  const p = r.PAIR_REQUEST;
  const block = (source) => source.EPHEMERIS.EPHEMERIS_DATA_BLOCK[0];
  if (kind === 'neither' || kind === 'only-secondary') delete block(p.PRIMARY).COVARIANCE_MATRIX_LINES;
  if (kind === 'neither' || kind === 'only-primary') delete block(p.SECONDARY).COVARIANCE_MATRIX_LINES;
  for (const line of block(p.SECONDARY).COVARIANCE_MATRIX_LINES ?? []) {
    if (kind === 'negative-variance') line.CX_X = -0.01;
    if (kind === 'indefinite') line.CY_X = 0.04;
    if (kind === 'negative-velocity') line.CX_DOT_X_DOT = -1e-6;
  }
  if (kind === 'maximum-only') p.CONTROLS.ALGORITHM = 'ALFANO_MAXIMUM';
  if (kind === 'singular') {
    for (const source of [p.PRIMARY, p.SECONDARY]) {
      for (const line of block(source).COVARIANCE_MATRIX_LINES) line.CX_X = line.CY_Y = line.CZ_Z = 0;
    }
  }
  if (kind === 'zero-pc') {
    p.PRIMARY_RADIUS_M = p.SECONDARY_RADIUS_M = 0.0005;
    p.CONTROLS.COMBINED_RADIUS_M = 0.001;
    for (const source of [p.PRIMARY, p.SECONDARY]) {
      for (const line of block(source).COVARIANCE_MATRIX_LINES) {
        line.CX_X = line.CY_Y = line.CZ_Z = 1e-6;
      }
    }
    for (const line of block(p.SECONDARY).EPHEMERIS_DATA_LINES) line.X = 7000.1;
  }
  return r;
}

async function invokeOk(h, methodId, portId, payload) {
  const r = await h.invoke({ methodId, inputs: [{ portId, payload }] });
  assert.equal(r.statusCode, 0, `${methodId}: ${r.errorCode}: ${r.errorMessage}`);
  return r;
}

async function roundTrip(h, flatc, bytes, format) {
  const written = await invokeOk(h, `write_cdm_${format}`, 'cdm', bytes);
  const document = written.outputs.find((f) => f.portId === format).payload;
  const text = new TextDecoder().decode(new Uint8Array(decodeCqr(flatc, document).NATIVE_DOCUMENT.CONTENT));
  const parsed = await invokeOk(h, `parse_cdm_${format}`, format, document);
  const cdm = parsed.outputs.find((f) => f.portId === 'cdm').payload;
  return { text, bytes: cdm, record: decodeCdm(flatc, cdm) };
}

function absentPc(cdm) {
  // The double defaults to zero even when elided; only the method marks presence.
  assert.ok(!cdm.COLLISION_PROBABILITY_METHOD);
}

function geometry(cdm, screen, miss) {
  assert.ok(Math.abs(cdm.MISS_DISTANCE * 1000 - miss) < 0.02, `miss ${cdm.MISS_DISTANCE}`);
  assert.ok(Math.abs(Date.parse(cdm.TCA) - Date.parse(iso(JD0))) <= 2, cdm.TCA);
  assert.ok(Math.abs(cdm.RELATIVE_POSITION_R * 1000 - miss) < 0.02);
  assert.ok(Math.abs(cdm.RELATIVE_POSITION_T * 1000) < 8, `transverse ${cdm.RELATIVE_POSITION_T * 1000}`);
  assert.ok(Math.abs(cdm.RELATIVE_POSITION_N * 1000) < 8, `normal ${cdm.RELATIVE_POSITION_N * 1000}`);
  assert.ok(Math.abs(cdm.MISS_DISTANCE * 1000 - screen.MISS_DISTANCE_M) <= 1e-6);
  assert.ok(Math.abs(Date.parse(cdm.TCA) - Date.parse(iso(screen.TCA.JULIAN_DATE))) <= 1,
    'CDM TCA equals screening TCA at its millisecond text resolution');
  for (const [field, axis] of [['R', 'X'], ['T', 'Y'], ['N', 'Z']]) {
    assert.ok(Math.abs(cdm[`RELATIVE_POSITION_${field}`] * 1000 - screen.RELATIVE_POSITION_RTN[axis]) <= 1e-6,
      `${field}: CDM ${cdm[`RELATIVE_POSITION_${field}`] * 1000}, screen ${screen.RELATIVE_POSITION_RTN[axis]}`);
  }
}

for (const runtimeKind of ['browser', 'wasmedge']) {
  for (const kind of ['neither', 'only-primary', 'only-secondary', 'negative-variance', 'indefinite', 'negative-velocity', 'singular', 'maximum-only', 'zero-pc']) {
    test(`${runtimeKind}: emit/write/parse CDM ${kind} preserves geometry and Pc presence`, async (t) => {
      let h;
      try {
        h = await createConjunctionCommandHarness({ runtimeKind });
      } catch (error) {
        if (runtimeKind === 'wasmedge' && /ENOENT|command not found|Failed to launch|WasmEdge.*(?:not found|missing)/i.test(String(error))) {
          t.skip(`WasmEdge unavailable: ${error.message}`);
          return;
        }
        throw error;
      }
      t.after(() => h.destroy?.());
      const flatc = await initCqrFlatc();
      const r = cdmCase(kind), p = r.PAIR_REQUEST;
      const screened = await invokeOk(h, 'screen_catalog', 'request', encodeCqr(flatc, { CATALOG_REQUEST: {
        PRIMARIES: [p.PRIMARY], SECONDARIES: [p.SECONDARY],
        CONTROLS: { ...p.CONTROLS, COMBINED_RADIUS_M: p.PRIMARY_RADIUS_M + p.SECONDARY_RADIUS_M },
        EVALUATION_FRAME: p.EVALUATION_FRAME,
      } }));
      const events = screened.outputs.filter((f) => f.portId === 'result')
        .flatMap((f) => decodeCqr(flatc, f.payload).CATALOG_RESULT.EVENTS ?? []);
      assert.equal(events.length, 1);
      const screen = events[0];
      const emitted = await invokeOk(h, 'emit_cdm', 'request', encodeCqr(flatc, r));
      const bytes = emitted.outputs.find((f) => f.portId === 'cdm').payload;
      const cdm = decodeCdm(flatc, bytes);
      const miss = kind === 'zero-pc' ? 100 : 50;
      geometry(cdm, screen, miss);
      const missing = ['neither', 'only-primary', 'only-secondary'].includes(kind);
      const reason = missing
        ? kind === 'neither' ? /covariance absent for OBJECT1 and OBJECT2/
          : kind === 'only-primary' ? /covariance absent for OBJECT2/ : /covariance absent for OBJECT1/
        : kind === 'singular' ? /Collision probability calculation failed/
          : kind === 'maximum-only' ? /only the Alfano maximum was requested/
          : /covariance not positive semidefinite \(non-PSD\) for OBJECT2/;
      const has1 = kind !== 'neither' && kind !== 'only-secondary';
      const has2 = kind !== 'neither' && kind !== 'only-primary';
      for (const [o, present] of [[cdm.OBJECT1, has1], [cdm.OBJECT2, has2]]) {
        assert.equal(Boolean(o.COVARIANCE?.length), present);
      }
      if (kind === 'zero-pc') {
        assert.equal(screen.PROBABILITY.ALGORITHM, 'LAAS_2015');
        assert.equal(screen.PROBABILITY.PROBABILITY, 0);
        assert.equal(cdm.COLLISION_PROBABILITY_METHOD, 'LAAS-2015');
        assert.equal(cdm.COLLISION_PROBABILITY, 0);
      } else {
        absentPc(cdm);
        assert.match(cdm.OBJECT1.COMMENT, reason);
        assert.match(cdm.OBJECT2.COMMENT, reason);
      }
      if (kind === 'negative-variance') assert.equal(cdm.OBJECT2.COVARIANCE[0], -0.01);
      if (kind === 'indefinite') assert.equal(cdm.OBJECT2.COVARIANCE[1], 0.04);
      if (kind === 'negative-velocity') assert.equal(cdm.OBJECT2.COVARIANCE[9], -1e-6);
      for (const format of ['kvn', 'xml']) {
        const first = await roundTrip(h, flatc, bytes, format);
        const second = await roundTrip(h, flatc, first.bytes, format);
        for (const result of [first, second]) {
          geometry(result.record, screen, miss);
          for (const object of ['OBJECT1', 'OBJECT2']) {
            assert.deepEqual(result.record[object].COVARIANCE, cdm[object].COVARIANCE);
            assert.equal(result.record[object].COMMENT, cdm[object].COMMENT);
          }
          if (kind === 'zero-pc') {
            assert.equal(result.record.COLLISION_PROBABILITY_METHOD, 'LAAS-2015');
            assert.equal(result.record.COLLISION_PROBABILITY, 0);
            const value = format === 'kvn' ? /COLLISION_PROBABILITY\s*=\s*([^\s]+)/.exec(result.text)
              : /<COLLISION_PROBABILITY>([^<]+)<\/COLLISION_PROBABILITY>/.exec(result.text);
            assert.ok(value, 'computed zero must be explicitly written');
            assert.equal(Number(value[1]), 0);
          } else {
            absentPc(result.record);
            assert.doesNotMatch(result.text, /COLLISION_PROBABILITY/);
            assert.match(result.text, reason);
          }
          if (kind === 'neither') assert.doesNotMatch(result.text, /covarianceMatrix|COVARIANCE_METHOD|CR_R|CT_T|CN_N/);
        }
        if (missing) {
          const pc = await h.invoke({ methodId: 'compute_pc_from_cdm', inputs: [{ portId: 'cdm', payload: first.bytes }] });
          assert.notEqual(pc.statusCode, 0);
          assert.equal(pc.errorCode, 'covariance-unavailable');
        }
      }
      if (kind === 'zero-pc') {
        // A numeric value without a method is absent, regardless of elision.
        const withoutMethod = encodeCdm(flatc, { ...cdm, COLLISION_PROBABILITY: 0.5, COLLISION_PROBABILITY_METHOD: '' });
        for (const format of ['kvn', 'xml']) {
          const result = await roundTrip(h, flatc, withoutMethod, format);
          absentPc(result.record);
          assert.doesNotMatch(result.text, /COLLISION_PROBABILITY/);
        }
      }
      // A stale Pc on an externally supplied CDM cannot override its missing
      // or invalid covariance. Exercise the writers independently of emission.
      if (missing || kind.startsWith('negative-') || kind === 'indefinite') {
        const stale = encodeCdm(flatc, { ...cdm, COLLISION_PROBABILITY: 0.5, COLLISION_PROBABILITY_METHOD: 'LAAS-2015',
          OBJECT1: { ...cdm.OBJECT1, COMMENT: '' }, OBJECT2: { ...cdm.OBJECT2, COMMENT: '' } });
        for (const format of ['kvn', 'xml']) {
          const result = await roundTrip(h, flatc, stale, format);
          absentPc(result.record);
          assert.doesNotMatch(result.text, /COLLISION_PROBABILITY/);
          assert.match(result.record.OBJECT1.COMMENT, reason);
        }
      }
    });
  }
}
