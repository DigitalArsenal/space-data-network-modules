// A source module's own records through the compiled flow. sources.test.mjs feeds every registered source the same
// designed history, so it proves the registry's wiring and naming; this proves that what a module gives, parsed from the
// provider's format, is what the flow can use: the products come out, the designed 1 m/s burn is found, and each record
// names the source, the provider (the module's plugin id) and the licence. Fixtures are synthetic and in the provider's
// own format; expected values come from the designed history (a closed-form J2 secular drift with a 1 m/s in-track burn,
// analysis/maneuver-detection tests/fixtures.mjs), not from the module.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

import { flatbuffers, OCM, ommParam, param, records, unpackMnv, unpackOcm, unpackOmm } from '../../../analysis/gp-error-model/tests/products-fixtures.mjs';
import { gpHistory } from '../../../analysis/maneuver-detection/tests/fixtures.mjs';
import { aoeRecord } from '../../../data-source/spacemapper-aoe-source/tests/fixtures/aoe-format.mjs';
import { gpRecord, synthetic } from '../../../data-source/spacetrack-source/tests/fixtures/spacetrack-format.mjs';
import { unpackTdm } from '../../../data-source/ilrs-crd-source/tests/fixtures/read-tdm.mjs';
import { ephemerisFile, keplerArc } from '../../../data-source/vimpel-source/tests/fixtures/vimpel-format.mjs';
import { decode, encode, typeRef as estimationType } from '../../../analysis/estimation/tests/wire.mjs';
import { recipeFor } from '../recipe.mjs';
import { bytesOf, egressBytes, framesOf, moduleAt, runFlow } from './flow-harness.mjs';

const textPort = (portId, text) => {
  const payload = Buffer.from(text);
  return { portId, payload, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length } };
};

// The designed history, written as the provider writes it.
function designedHistory() {
  const { tb, rows } = gpHistory(1);
  const sets = rows.map((r, k) => synthetic({ gpId: 900001000 + k, norad: r.NORAD_CAT_ID, objectId: r.OBJECT_ID, epoch: r.EPOCH, meanMotion: r.MEAN_MOTION, ecc: r.ECCENTRICITY, inc: r.INCLINATION,
    raan: r.RA_OF_ASC_NODE, argp: r.ARG_OF_PERICENTER, ma: r.MEAN_ANOMALY, bstar: r.BSTAR, elset: 100 + k, rev: 1000 + k }));
  return { tb, sets };
}

async function throughFlow(id, module, omm) {
  const recipe = recipeFor(id, { created: '2026-10-11T00:00:00Z', via: module, ages: [0, 0.5] });
  const { egress, result } = await runFlow([{ trigger: 'element_sets', portId: 'omm', bytes: omm }, { trigger: 'element_set_recipe', portId: 'recipe', bytes: Buffer.from(JSON.stringify(recipe)) }]);
  assert.equal(result.handlersSkipped, 0);
  return { egress, recipe };
}

function assertNamed({ egress, recipe }, tb) {
  const { id, kind, originator, lineage, provider, licence } = recipe.source;
  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  assert.equal(param(ocm, 'SOURCE_ID'), id);
  assert.equal(param(ocm, 'SOURCE_KIND'), kind);
  assert.equal(param(ocm, 'SOURCE_PROVIDER'), provider);
  assert.equal(param(ocm, 'LICENCE_CLASS'), licence.class);
  assert.equal(JSON.parse(param(ocm, 'COV_LABELS'))[0].regime, 'LEO-L');
  const [omm] = records(egressBytes(egress, 'omm')).map(unpackOmm);
  assert.equal(omm.ORIGINATOR, originator);
  assert.equal(omm.NORAD_CAT_ID, 99999);
  assert.equal(ommParam(omm, 'SOURCE_PROVIDER'), provider);
  const burns = records(egressBytes(egress, 'mnv')).map(unpackMnv).filter((m) => m.DELTA_VEL_V !== 0);
  assert.equal(burns.length, 1);
  assert.ok(Math.abs(burns[0].DELTA_VEL_V * 1000 - 1) < 0.2, `${burns[0].DELTA_VEL_V * 1000} m/s`);
  assert.ok(Math.abs(Date.parse(burns[0].EVENT_START_TIME) / 1000 - tb) < 8 * 3600);
  for (const tag of [`source:${id}`, `originator:${originator}`, `provider:${provider}`, `licence:${licence.class}`, ...(lineage === id ? [] : [`lineage:${lineage}`])]) assert.ok(burns[0].TAGS.includes(tag), tag);
}

test('space-track-gp through data-source/spacetrack-source: a gp_history as the REST API serves it', async () => {
  const { tb, sets } = designedHistory();
  const parsed = await moduleAt('data-source/spacetrack-source')('parse_gp', [textPort('source', JSON.stringify(sets.map((s) => gpRecord(s))))]);
  assert.equal(JSON.parse(bytesOf(parsed, 'report')).rejected, 0);
  assertNamed(await throughFlow('space-track-gp', 'data-source/spacetrack-source', bytesOf(parsed, 'omm')), tb);
});

test('spacemapper-aoe through data-source/spacemapper-aoe-source: AOE records, as the archive stores them', async () => {
  const { tb, sets } = designedHistory();
  const lines = sets.map((s, k) => JSON.stringify(aoeRecord({ ...s, recordId: 7000 + k }))).join('\n');
  const parsed = await moduleAt('data-source/spacemapper-aoe-source')('parse_aoe', [textPort('source', lines)]);
  const report = JSON.parse(bytesOf(parsed, 'report'));
  assert.equal(report.rejected, 0);
  assert.equal(report.emitted, sets.length);
  assertNamed(await throughFlow('spacemapper-aoe', 'data-source/spacemapper-aoe-source', bytesOf(parsed, 'omm')), tb);
});

// analysis/od, as an ephemeris source's own flow runs it: the ephemeris in, the SGP4 element set it is fitted to out.
async function odFit(oem) {
  const dir = fileURLToPath(new URL('../../../analysis/od/', import.meta.url));
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(`${dir}dist/isomorphic/module.wasm`), surface: 'direct' });
  try {
    const response = await h.invoke({ methodId: 'fit', inputs: [{ portId: 'oem', payload: oem,
      typeRef: { schemaName: 'OEM.fbs', fileIdentifier: '$OEM', rootTypeName: 'OEM', wireFormat: 'flatbuffer', requiredAlignment: 8, byteLength: oem.length } }] });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    return Buffer.from(response.outputs.find((f) => f.portId === 'omm').payload);
  } finally {
    h.destroy();
  }
}

test('vimpel through data-source/vimpel-source: a rectangular ephemeris, fitted by analysis/od, gets the pooled model\'s covariance, uncalibrated for a lineage it was not measured on', async () => {
  // Seven days of a synthetic MEO object, every 600 s, as Vimpel prints the positions (one decimal).
  const arc = keplerArc({ a: 26560, e: 0.02, inc: 55, raan: 100, w: 45, M0: 30 });
  const read = await moduleAt('data-source/vimpel-source')('read_ephemeris', [textPort('name', '040004_20260921_000000'), textPort('source', ephemerisFile(arc))]);
  const ephemeris = bytesOf(read, 'ephemeris');
  const recipe = recipeFor('vimpel', { created: '2026-10-11T00:00:00Z', via: 'data-source/vimpel-source', ages: [0, 1] });
  const { egress, result } = await runFlow([{ trigger: 'fit_omm', portId: 'omm', bytes: await odFit(ephemeris) }, { trigger: 'ephemeris', portId: 'operator', bytes: ephemeris },
    { trigger: 'fit_recipe', portId: 'recipe', bytes: Buffer.from(JSON.stringify(recipe)) }]);
  assert.equal(result.handlersSkipped, 0);
  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  const { source } = recipe;
  assert.equal(param(ocm, 'SOURCE_ID'), 'vimpel');
  assert.equal(param(ocm, 'SOURCE_KIND'), 'ephemeris');
  assert.equal(param(ocm, 'SOURCE_PROVIDER'), 'com.digitalarsenal.data-source.vimpel-source');
  assert.equal(param(ocm, 'LICENCE_CLASS'), 'cite-only');
  const label = JSON.parse(param(ocm, 'COV_LABELS'))[0];
  assert.equal(label.rule, 4, 'Vimpel states no covariance and no model of its own exists: the pooled model answers');
  assert.equal(label.regime, 'MEO');
  assert.equal(label.calibration, 'UNCALIBRATED');
  assert.match(label.basis, /not measured on vimpel/);
  const [omm] = records(egressBytes(egress, 'omm')).map(unpackOmm);
  assert.equal(omm.ORIGINATOR, source.originator);
  assert.equal(omm.OBJECT_NAME, 'vimpel:40004', 'the native identity survives the fit');
  assert.equal(ommParam(omm, 'SOURCE_PROVIDER'), source.provider);
  assert.ok(Math.abs(omm.MEAN_MOTION - 2.0056) < 0.001, `${omm.MEAN_MOTION} rev/day for a = 26560 km`);
});

test('igs-gps-precise through data-source/sp3-precise-source: the IGS final orbit of GPS week 1500 (a real SP3-c file), one satellite fitted by analysis/od', async () => {
  const file = fs.readFileSync(fileURLToPath(new URL('../../../files/orbit-products/fixtures/igs15000.3ep.sp3', import.meta.url)));
  const read = await moduleAt('data-source/sp3-precise-source')('read_sp3', [{ portId: 'source', payload: file, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: file.length } }]);
  const ephemerides = framesOf(read, 'oem');
  assert.equal(ephemerides.length, 32, 'one OEM per satellite');
  const g01 = ephemerides[0];
  const recipe = recipeFor('igs-gps-precise', { created: '2026-10-11T00:00:00Z', via: 'data-source/sp3-precise-source', ages: [0, 1] });
  const { egress, result } = await runFlow([{ trigger: 'fit_omm', portId: 'omm', bytes: await odFit(g01) }, { trigger: 'ephemeris', portId: 'operator', bytes: g01 },
    { trigger: 'fit_recipe', portId: 'recipe', bytes: Buffer.from(JSON.stringify(recipe)) }]);
  assert.equal(result.handlersSkipped, 0);
  const [ocm] = records(egressBytes(egress, 'ocm')).map(unpackOcm);
  assert.equal(param(ocm, 'SOURCE_ID'), 'igs-gps-precise');
  assert.equal(param(ocm, 'SOURCE_PROVIDER'), 'com.digitalarsenal.data-source.sp3-precise-source');
  assert.equal(param(ocm, 'LICENCE_CLASS'), 'reproducible');
  assert.equal(param(ocm, 'LICENCE_ID'), 'igs');
  const label = JSON.parse(param(ocm, 'COV_LABELS'))[0];
  assert.equal(label.rule, 4);
  assert.equal(label.regime, 'MEO');
  assert.equal(label.calibration, 'UNCALIBRATED');
  const [omm] = records(egressBytes(egress, 'omm')).map(unpackOmm);
  assert.equal(omm.ORIGINATOR, 'IGS / BKG');
  assert.equal(omm.OBJECT_NAME, 'G01', 'the satellite keeps the file\'s own id through the fit');
  assert.ok(Math.abs(omm.MEAN_MOTION - 2.0057) < 0.05, `${omm.MEAN_MOTION} rev/day: a GPS satellite (semimajor axis 26,560 km)`);
});

// An observation source: the module's $TDM is what analysis/estimation takes on tracking_data. The first pass of the real
// LAGEOS-1 file (EDC, 2026-10-08, station SVEL), 9 normal points. The geometry is a stand-in, so the check is on what the
// estimator reads: the station is the origin and the satellite sits on the x axis at the range the file prints (c x time of
// flight / 2), the propagator's sample at each epoch. If the module gave the two-way range, kilometres or another epoch, the
// innovation would not be zero and the observation would be edited out.
test('ilrs-crd through data-source/ilrs-crd-source: a real LAGEOS-1 pass (EDC, 2026-10-08), read by analysis/estimation as nine laser ranges', async () => {
  const file = fs.readFileSync(fileURLToPath(new URL('../../../data-source/ilrs-crd-source/tests/fixtures/lageos1_20261008.first-two-passes.np2', import.meta.url)));
  const read = await moduleAt('data-source/ilrs-crd-source')('read_crd', [{ portId: 'source', payload: file, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: file.length } }]);
  const report = JSON.parse(bytesOf(read, 'report'));
  assert.deepEqual([report.passesRead, report.normalPointsRead], [2, 15]);
  const [svel] = framesOf(read, 'observations');

  // The numbers the file prints for the first pass: the times of flight of its normal points (record 11, field 3).
  const lines = file.toString().split('\n');
  const printed = lines.slice(0, lines.findIndex((l) => /^h8/i.test(l))).filter((l) => l.startsWith('11 ')).map((l) => l.split(/\s+/)[2]);
  assert.equal(printed.length, 9);
  const ranges = printed.map((t) => Number(t) * 299792458 / 2);

  // analysis/estimation reads a TDM epoch as seconds in one double and takes a precomputed sample only within 1e-8 s of it, so the
  // samples' epochs are built the way it reads them (the registry says so in the limits of ilrs-crd).
  const rows = unpackTdm(svel).SEGMENTS[0].OBSERVATIONS.filter((o) => o.KEYWORD === 'LASER_RANGE');
  assert.equal(rows.length, 9);
  rows.forEach((row, i) => assert.ok(Math.abs(row.VALUE - ranges[i]) < 1e-6, `range ${i}: ${row.VALUE} against ${ranges[i]}`));
  const days = (iso) => Date.UTC(...iso.slice(0, 10).split('-').map((x, k) => (k === 1 ? Number(x) - 1 : Number(x)))) / 86400000;
  const secondOfDay = (iso) => Number(iso.slice(11, 13)) * 3600 + Number(iso.slice(14, 16)) * 60 + Number(iso.slice(17));
  const unixSeconds = (iso) => days(iso) * 86400.0 + Number(iso.slice(11, 13)) * 3600.0 + Number(iso.slice(14, 16)) * 60.0 + Number(iso.slice(17));
  const jdDay = 2440587.5 + days(rows[0].EPOCH);
  const reference = secondOfDay(rows[0].EPOCH) - 1; // the request epoch, a second before the first normal point
  const referenceUnix = days(rows[0].EPOCH) * 86400.0 + reference;
  const identity = Array.from({ length: 36 }, (_, i) => (i % 7 === 0 ? 1 : 0));
  const estimate = (tdm) => moduleAt('analysis/estimation')('run_estimation', [
    { portId: 'request', typeRef: estimationType, payload: encode({ request: {
      config: { initial_epoch: { jd_day: jdDay, seconds: reference }, initial_state: [ranges[0], 0, 0, 0, 0, 0], initial_covariance: identity.map((v, i) => (v ? (i < 18 ? 1e6 : 1e-2) : 0)),
        process_noise_spectral_density: [0, 0, 0, 0, 0, 0], state_convergence_tolerance: 1e-6, rms_convergence_tolerance: 1e-9, sigma_edit_threshold: 10, dynamic_model_correlation_time_seconds: 300,
        maximum_iterations: 12, reference_frame: 'ICRF', estimator: 'EXTENDED_KALMAN_FILTER', process_noise: 'NONE', flags: 0 },
      observations: [],
      // Station-origin geometry: no light time or Sagnac correction (flags 3), a 2 cm range noise.
      error_models: [{ noise_sigma: 0.02, bias: 0, bias_sigma: 0, correlation_time_seconds: 0, minimum_value: 0, maximum_value: 0, sigma_edit_threshold: 0, random_seed: 1,
        measurement_kind: 'LASER_RANGE', troposphere: 'NONE', ionosphere: 'NONE', flags: 3 }],
      propagator_port_id: 'reference-provider', propagator_capability: 'plugin_propagate plugin_compute_stm', trace_id: 'ilrs-crd' } }) },
    { portId: 'propagator_samples', typeRef: estimationType, payload: encode({ propagator_samples: rows.map((row, i) => ({
      epoch: { jd_day: jdDay, seconds: reference + (unixSeconds(row.EPOCH) - referenceUnix) }, state: [ranges[i], 0, 0, 0, 0, 0], stm: identity })) }) },
    ...(tdm ? [{ portId: 'tracking_data', typeRef: { schemaName: 'TDM.fbs', fileIdentifier: '$TDM', rootTypeName: 'TDM', wireFormat: 'flatbuffer' }, payload: tdm }] : []),
  ]);

  const fit = await estimate(svel);
  const { result } = decode(bytesOf(fit, 'result'));
  assert.equal(result.status, 'OK');
  assert.deepEqual([result.estimate.accepted_count, result.estimate.rejected_count], [9, 0]);
  assert.equal(result.filter_history.length, 9);
  result.filter_history.forEach((epoch, i) => {
    assert.ok(epoch.normalized_innovation_squared < 1e-9, `innovation ${epoch.normalized_innovation_squared} at ${i}`);
    assert.ok(Math.abs(epoch.filtered_state[0] - ranges[i]) < 1e-6, `filtered range ${epoch.filtered_state[0]} against ${ranges[i]}`);
  });
  const ocm = OCM.OCM.getRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(bytesOf(fit, 'ocm')))).unpack();
  assert.deepEqual(ocm.ORBIT_DETERMINATION.OD_OBSERVATIONS_TYPE, ['LASER_RANGE']);
  assert.equal(ocm.ORBIT_DETERMINATION.OD_OBSERVATIONS_USED, 9);
  // Without the $TDM the estimator has no observations to pair with the nine samples: the observations are the module's.
  await assert.rejects(() => estimate(null), /propagator-protocol/);
});
