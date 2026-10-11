// A source module's own records through the compiled flow. sources.test.mjs feeds every registered source the same
// designed history, so it proves the registry's wiring and naming; this proves that what a module gives, parsed from the
// provider's format, is what the flow can use: the products come out, the designed 1 m/s burn is found, and each record
// names the source, the provider (the module's plugin id) and the licence. Fixtures are synthetic and in the provider's
// own format; expected values come from the designed history (a closed-form J2 secular drift with a 1 m/s in-track burn,
// analysis/maneuver-detection tests/fixtures.mjs), not from the module.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ommParam, param, records, unpackMnv, unpackOcm, unpackOmm } from '../../../analysis/gp-error-model/tests/products-fixtures.mjs';
import { gpHistory } from '../../../analysis/maneuver-detection/tests/fixtures.mjs';
import { gpRecord, synthetic } from '../../../data-source/spacetrack-source/tests/fixtures/spacetrack-format.mjs';
import { recipeFor } from '../recipe.mjs';
import { bytesOf, egressBytes, moduleAt, runFlow } from './flow-harness.mjs';

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
  const burns = records(egressBytes(egress, 'mnv')).map(unpackMnv).filter((m) => m.DELTA_VEL_U !== 0);
  assert.equal(burns.length, 1);
  assert.ok(Math.abs(burns[0].DELTA_VEL_U * 1000 - 1) < 0.2, `${burns[0].DELTA_VEL_U * 1000} m/s`);
  assert.ok(Math.abs(Date.parse(burns[0].EVENT_START_TIME) / 1000 - tb) < 8 * 3600);
  for (const tag of [`source:${id}`, `originator:${originator}`, `provider:${provider}`, `licence:${licence.class}`, ...(lineage === id ? [] : [`lineage:${lineage}`])]) assert.ok(burns[0].TAGS.includes(tag), tag);
}

test('space-track-gp through data-source/spacetrack-source: a gp_history as the REST API serves it', async () => {
  const { tb, sets } = designedHistory();
  const parsed = await moduleAt('data-source/spacetrack-source')('parse_gp', [textPort('source', JSON.stringify(sets.map((s) => gpRecord(s))))]);
  assert.equal(JSON.parse(bytesOf(parsed, 'report')).rejected, 0);
  assertNamed(await throughFlow('space-track-gp', 'data-source/spacetrack-source', bytesOf(parsed, 'omm')), tb);
});
