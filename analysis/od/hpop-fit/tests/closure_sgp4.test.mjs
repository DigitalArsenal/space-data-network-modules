// Closure gate, SGP4 OMM fitter (owner 2026-10-10): on ephemerides generated
// by SGP4 itself (propagator/sgp4 1.2.0 propagate_ephemeris, TEME, an
// independent artifact), the OMM fitted to the first half reproduces every
// point of the second half within 1 cm. Sample times are binary fractions of
// a day (86400 / 2^k s) so that the generator's Julian-date doubles are exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFit } from './lib/harness.mjs';
import { rng } from './closure-cases.mjs';
import { invokePiv, loadRawSgp4Module } from '../../../../propagator/sgp4/tests/lib/pivInvokeHelper.mjs';
import { ReferenceFrame, encodeOmmPayload, encodePropagatorBatchRequest, encodeSizePrefixedStream } from '../../../../propagator/sgp4/tests/lib/payloadEncoders.mjs';

const OMM_TYPE = { schemaName: 'orbpro.sds.omm', fileIdentifier: '$OMM', rootTypeName: 'OMM' };
const PROP_TYPE = { schemaName: 'orbpro.propagator.PropagatorBatchRequest', fileIdentifier: 'PROP', rootTypeName: 'PropagatorBatchRequest' };
const OEM_TYPE = { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer' };
const GATE_KM = 1e-5;
const EPOCH_JD = 2461226.625;  // 2026-07-05T03:00:00 UTC
// [regime, mean motion rev/day, eccentricity, inclination deg, B*, span days, step = 86400 / 2^k]
const CASES = [
  ['leo-drag', 15.55, 0.0008, 53.0, 4.5e-4, 0.25, 13],
  ['leo-drag long', 15.3, 0.0012, 97.6, 1.2e-4, 3, 10],
  ['leo-upper', 13.4, 0.0011, 86.4, 2e-6, 1, 11],
  ['meo (deep space)', 2.0056, 0.009, 55.0, 0, 7, 7],
  ['geo (deep space)', 1.00272, 0.0002, 0.04, 0, 7, 7],
  ['heo (deep space)', 2.006, 0.72, 63.4, 0, 3, 8],
];

for (const [regime, n, e, i, bstar, days, k] of CASES) {
  test(`SGP4 closure <= 1 cm: ${regime}, ${days} d at ${(86400 / 2 ** k).toFixed(3)} s`, async (t) => {
    const u = rng(Math.round(n * 1000));
    const sgp4 = await loadRawSgp4Module();
    const od = await loadFit();
    t.after(() => { sgp4._plugin_destroy(); od.destroy?.(); });
    const omm = encodeOmmPayload({ noradId: 99901, objectName: 'SYNTH', objectId: '2026-901A', epoch: '2026-07-05T03:00:00',
      meanMotion: n, eccentricity: e, inclination: i, raan: 360 * u(), argPericenter: regime.startsWith('heo') ? 270 : 360 * u(),
      meanAnomaly: 360 * u(), bstar, meanMotionDot: 0, meanMotionDdot: 0 });
    let r = invokePiv(sgp4, { methodId: 'ingest_omm', inputs: [{ portId: 'omm', typeRef: OMM_TYPE, payload: encodeSizePrefixedStream([omm]) }] });
    assert.equal(r.response.STATUS_CODE, 0, r.response.ERROR_MESSAGE);
    r = invokePiv(sgp4, { methodId: 'propagate_ephemeris', outputStreamCap: 4, inputs: [{ portId: 'request', typeRef: PROP_TYPE,
      payload: encodePropagatorBatchRequest({ epoch: EPOCH_JD, stopEpoch: EPOCH_JD + days, stepSeconds: 86400 / 2 ** k, catalogNumbers: [99901], outputFrame: ReferenceFrame.TEME }) }] });
    assert.equal(r.response.STATUS_CODE, 0, r.response.ERROR_MESSAGE);
    const oem = r.outputPayloads[0].bytes;
    const response = await od.invoke({ methodId: 'fit', inputs: [
      { portId: 'ephemeris', typeRef: OEM_TYPE, payload: oem },
      { portId: 'options', typeRef: { schemaName: 'application/json' }, payload: Buffer.from(JSON.stringify({ hpop: false, ommSpanSeconds: days * 86400 + 1, maximumFitPoints: 720 })) },
    ] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const result = JSON.parse(Buffer.from(response.outputs.find((o) => o.portId === 'result').payload).toString());
    assert.equal(result.ok, true, `${result.failureCode}: ${result.failureMessage}`);
    const c = result.sgp4.closure;
    t.diagnostic(JSON.stringify({ fitRms3dKm: result.sgp4.stats.rms3dKm, closureMaxKm: c.secondHalf?.max3dKm, n: c.secondHalf?.n, samples: result.samples }));
    assert.equal(c.done, true, c.error);
    assert.ok(c.secondHalf.max3dKm <= GATE_KM, `closure max ${(c.secondHalf.max3dKm * 1e5).toFixed(4)} cm`);
    assert.ok(result.sgp4.stats.max3dKm <= GATE_KM);
  });
}
