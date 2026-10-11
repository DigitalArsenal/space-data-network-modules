// `fit`: SGP4-XP element sets fitted to ephemerides, through the SDK browser harness.
//
// What is asserted is specific and does not depend on this module's own fit being right:
// - an ephemeris made BY the library (propagate, from a known SGP4-XP set) is fitted back to that set, to the digits of the
//   two-line text, in every frame the module reads and with positions only: the model is exactly the library, so the truth is known;
// - the real NASA ISS ephemeris (files/ccsds-messages/fixtures/real/nasa-iss.oem, a U.S. Government work) fits within the
//   misfit any SGP4-family model leaves on it (the SGP4 fit of analysis/od scores 0.071 km on its first 3.2 hours and the
//   CelesTrak segment 0.111 km: tests/data/supgp-reference/iss in analysis/od);
// - the refusals are named.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadModule } from './lib/module.mjs';
import { OMM, blockLines, frame, iso, oemBytes, ommBytes, readObd, readOem, readOmm } from './lib/sds.mjs';
import { parseOemKvn, sdsFrame } from './lib/oemkvn.mjs';

const TRUTH = { epoch: '2024-04-09T12:00:00.000000', meanMotion: 15.5, eccentricity: 0.0006317, inclination: 51.64, raan: 208.9163, argPerigee: 69.9862, meanAnomaly: 25.2906, bterm: 0.005, agom: 0.01, norad: 25544, name: 'ISS', id: '1998-067A', originator: 'SYNTHETIC' };
const OBJECT = { name: 'ISS', id: '1998-067A', norad: 25544 };
const parameters = (omm) => Object.fromEntries(omm.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));
// The OMM prints statistics to nine significant digits; the OBD holds the double.
const sameStatistic = (double, printed, label) => assert.ok(Math.abs(double - Number(printed)) <= 1e-8 * Math.abs(double), `${label}: ${double} against ${printed}`);

async function propagated(module, set, { frameName = 'TEMEOFDATE', hours = 48, step = 120 } = {}) {
  const stop = new Date(Date.parse(`${set.epoch}Z`) + hours * 3600000).toISOString();
  const grid = oemBytes({ blocks: [{ frame: frameName, start: `${set.epoch}Z`, stop, step, data: [] }] });
  const out = await module.invoke('propagate', [frame('omm', 'OMM', ommBytes(set)), frame('grid', 'OEM', grid)]);
  return blockLines(readOem(out.ephemeris[0]).EPHEMERIS_DATA_BLOCK[0]);
}
const fitted = async (module, block, extra = {}) => {
  const out = await module.invoke('fit', [frame('ephemeris', 'OEM', oemBytes({ originator: 'SYNTHETIC', blocks: [{ object: OBJECT, ...block }], ...extra }))]);
  return { omm: readOmm(out.elements[0]), obd: readObd(out.determination[0]) };
}
const assertSet = (omm, truth, label) => {
  assert.equal(omm.EPOCH, `${truth.epoch}Z`.replace(/\.000000Z$/, '.000000Z'), `${label}: epoch`);
  assert.equal(omm.MEAN_MOTION, truth.meanMotion, `${label}: mean motion`);
  assert.ok(Math.abs(omm.ECCENTRICITY - truth.eccentricity) <= 2e-7, `${label}: eccentricity ${omm.ECCENTRICITY}`);
  assert.ok(Math.abs(omm.INCLINATION - truth.inclination) <= 2e-4, `${label}: inclination ${omm.INCLINATION}`);
  assert.ok(Math.abs(omm.RA_OF_ASC_NODE - truth.raan) <= 2e-4, `${label}: node ${omm.RA_OF_ASC_NODE}`);
  // The argument of perigee and mean anomaly of a near-circular orbit are one angle: their sum is what is measured.
  const sum = ((omm.ARG_OF_PERICENTER + omm.MEAN_ANOMALY - truth.argPerigee - truth.meanAnomaly + 540) % 360) - 180;
  assert.ok(Math.abs(sum) <= 4e-4, `${label}: argument of perigee + mean anomaly differ by ${sum}`);
  assert.ok(Math.abs(omm.BSTAR - truth.bterm) <= 2e-4 * truth.bterm + 1e-6, `${label}: BTERM ${omm.BSTAR}`);
};

test('a fit recovers the SGP4-XP set that made the ephemeris, and predicts the next day to a metre', async () => {
  const module = await loadModule();
  try {
    const lines = await propagated(module, TRUTH);
    const { omm, obd } = await fitted(module, { lines, start: lines[0].epoch, stop: lines.at(-1).epoch, useableStart: lines[0].epoch, useableStop: '2024-04-10T12:00:00.000000Z' });
    assertSet(omm, TRUTH, 'synthetic');
    assert.equal(omm.MEAN_ELEMENT_THEORY, OMM.meanElementSource.SGP4XP);
    assert.equal(omm.ORIGINATOR, 'SYNTHETIC', 'the source of the ephemeris is the set\'s ORIGINATOR');
    assert.equal(omm.NORAD_CAT_ID, 25544);
    const p = parameters(omm);
    assert.ok(Number(p.FIT_RMS_KM) < 1e-3, `fit RMS ${p.FIT_RMS_KM} km`);
    assert.equal(Number(p.FIT_STATES), 721);
    assert.equal(p.FIT_CONVERGED, 'true');
    assert.ok(Number(p.HELD_OUT_RMS_KM) < 1e-3, `held-out RMS ${p.HELD_OUT_RMS_KM} km`);
    assert.equal(Number(p.HELD_OUT_STATES), 720);
    assert.equal(Number(p.HELD_OUT_DAY1_STATES), 720);
    sameStatistic(obd.WRMS, p.FIT_RMS_KM, 'OBD WRMS');
    assert.equal(obd.SAT_NO, 25544);
    assert.equal(obd.NUM_ACCEPTED_OBS, 721);
    assert.equal(obd.FIT_SPAN, 1);
  } finally {
    await module.destroy();
  }
});

test('the same ephemeris written in GCRF and in EME2000 fits to the same set; so do positions alone', async () => {
  const module = await loadModule();
  try {
    for (const frameName of ['GCRF', 'EME2000']) {
      const lines = await propagated(module, TRUTH, { frameName, hours: 24, step: 300 });
      const { omm } = await fitted(module, { frame: frameName, lines, start: lines[0].epoch, stop: lines.at(-1).epoch });
      // The module rotated TEME to this frame and back: the two rotations agree to well under a metre.
      assertSet(omm, TRUTH, frameName);
      assert.ok(Number(parameters(omm).FIT_RMS_KM) < 5e-3, `${frameName}: fit RMS ${parameters(omm).FIT_RMS_KM} km`);
    }
    const lines = await propagated(module, TRUTH, { hours: 24, step: 300 });
    const { omm } = await fitted(module, { data: lines.flatMap((l) => l.r), stateSize: 3, step: 300, start: lines[0].epoch, stop: lines.at(-1).epoch });
    assertSet(omm, TRUTH, 'positions only (compact, STATE_VECTOR_SIZE 3)');
    assert.ok(Number(parameters(omm).FIT_RMS_KM) < 1e-3);
  } finally {
    await module.destroy();
  }
});

test('the real NASA ISS ephemeris: a 6-hour fit leaves what an SGP4-family model leaves, and is scored on the next 6 hours', async () => {
  const module = await loadModule();
  try {
    const { header, blocks } = parseOemKvn(fs.readFileSync(fileURLToPath(new URL('../../../files/ccsds-messages/fixtures/real/nasa-iss.oem', import.meta.url)), 'utf8'));
    const b = blocks[0];
    const { omm, obd } = await fitted(module, { frame: sdsFrame(b.frame), lines: b.lines, start: b.start, stop: b.stop, useableStart: b.lines[0].epoch, useableStop: b.lines[90].epoch }, { originator: header.ORIGINATOR, creation: header.CREATION_DATE });
    assert.equal(omm.ORIGINATOR, 'NASA/JSC/FOD/TOPO');
    assert.equal(omm.CREATION_DATE, header.CREATION_DATE);
    assert.equal(omm.EPOCH, '2026-07-13T12:00:00.000000Z', 'the set\'s epoch is the first state of the fit interval');
    const p = parameters(omm);
    // Measured 2026-10-11: 0.164 km over the 91 fitted states and 0.79 km over the next 90; BTERM and AGOM stay 0 on an arc this short.
    assert.equal(Number(p.FIT_STATES), 91);
    assert.ok(Number(p.FIT_RMS_KM) < 0.25, `fit RMS ${p.FIT_RMS_KM} km`);
    assert.equal(Number(p.HELD_OUT_STATES), 90);
    assert.ok(Number(p.HELD_OUT_RMS_KM) < 1.2, `held-out RMS ${p.HELD_OUT_RMS_KM} km`);
    assert.ok(omm.BSTAR >= 0 && omm.MEAN_MOTION_DDOT >= 0);
    assert.ok(omm.MEAN_MOTION > 15.4 && omm.MEAN_MOTION < 15.6);
    sameStatistic(obd.WRMS, p.FIT_RMS_KM, 'OBD WRMS');
    assert.ok(obd.ERROR_GROWTH_RATE > 0);
  } finally {
    await module.destroy();
  }
});

test('refusals are named', async () => {
  const module = await loadModule();
  try {
    const lines = await propagated(module, TRUTH, { hours: 6, step: 300 });
    const ask = (block, extra) => module.refused('fit', [frame('ephemeris', 'OEM', oemBytes({ blocks: [{ object: OBJECT, ...block }], ...extra }))]);
    const code = async (block, extra) => (await ask(block, extra)).errorCode;
    assert.equal(await code({ lines: lines.slice(0, 5) }), 'too-few-states');
    assert.equal(await code({ lines, frame: 'B1950' }), 'unsupported-frame');
    assert.equal(await code({ lines, timeSystem: 'TDB' }), 'unsupported-time-system');
    // 2016-12-31 ended with a leap second: minutes since epoch are counted in 86400-second days, so an arc across it is refused.
    const response = await ask({ lines: lines.map((l, i) => ({ ...l, epoch: iso(Date.parse('2016-12-31T22:00:00Z') + i * 300000) })) });
    assert.equal(response.errorCode, 'leap-second-in-arc', response.errorMessage);
    assert.equal(await code({ lines: lines.map((l, i) => ({ ...l, epoch: i === 3 ? 'not a time' : l.epoch })) }), 'bad-epoch');
  } finally {
    await module.destroy();
  }
});
