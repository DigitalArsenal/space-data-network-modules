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

import { ommParam, param, records, unpackMnv, unpackOcm, unpackOmm } from '../../../analysis/gp-error-model/tests/products-fixtures.mjs';
import { gpHistory } from '../../../analysis/maneuver-detection/tests/fixtures.mjs';
import { aoeRecord } from '../../../data-source/spacemapper-aoe-source/tests/fixtures/aoe-format.mjs';
import { gpRecord, synthetic } from '../../../data-source/spacetrack-source/tests/fixtures/spacetrack-format.mjs';
import { ephemerisFile, keplerArc } from '../../../data-source/vimpel-source/tests/fixtures/vimpel-format.mjs';
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
