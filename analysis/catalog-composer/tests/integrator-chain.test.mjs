// The integrator on what flows/source-products really writes: two sources' element sets go through the compiled flow, and
// their $OMM and $OCM (source, provider and covariance label in the records as the flow writes them) are integrated. The
// contract between the two modules is the records, so this fails if either side changes what it writes or reads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { recipeFor } from '../../../flows/source-products/recipe.mjs';
// The flow as its own tests run it (its harness answers whatever host calls the compiled flow makes).
import { egressBytes, runSource } from '../../../flows/source-products/tests/flow-harness.mjs';
import { ASOF, DAY, OCM, catRecord, frames, integrate, ommEpoch, ommRecord, records, stream, unpackOcm, unpackOmm } from './integrator-fixtures.mjs';
import { x } from './xmt-recipes.mjs';

// One source's run of the flow: its recipe is the flow's node configuration, its models the `models` trigger.
async function runFlow(ingress, recipe) {
  const { egress } = await runSource(ingress.map(({ trigger, portId, bytes }) => ({ trigger, portId, bytes })), recipe);
  return (port) => egressBytes(egress, port);
}

// A 15.5 rev/day orbit: a = (mu / n^2)^(1/3) = 6796 km, 418 km above the equatorial radius: E14's LEO-L (0 to 500 km).
const A = { norad: 90001, cospar: '2026-901A', name: 'ALPHA' };
// The element set as its source publishes it: no source named yet; the flow names it.
const set = (daysBefore) => ommRecord({ ...A, epoch: ommEpoch(daysBefore) });
const productsOf = async (id, via, daysBefore) => {
  const recipe = recipeFor(id, { created: '2026-10-10T00:00:00Z', via, ages: [0, 1] });
  const out = await runFlow([{ trigger: 'element_sets', portId: 'omm', bytes: set(daysBefore) }], recipe);
  return { omm: out('omm'), ocm: out('ocm') };
};

test('the products the flow writes for two sources are integrated: the lower measured median wins and its covariance and label come out as the flow wrote them', async () => {
  const celestrak = await productsOf('celestrak-gp', 'data-source/celestrak-reference', 2);
  const spaceTrack = await productsOf('space-track-gp', 'data-source/retrieval', 1);
  assert.ok(celestrak.omm.length > 0 && celestrak.ocm.length > 0 && spaceTrack.omm.length > 0);

  const mu = 398600.4418, n = (15.5 * 2 * Math.PI) / DAY;
  const altitude = Math.cbrt(mu / (n * n)) - 6378.137;
  assert.ok(altitude > 0 && altitude < 500, `${altitude} km is E14's LEO-L`);

  const table = [['celestrak-gp', 0.5], ['space-track-gp', 0.8]].map(([source, median]) => ({ source, product: 'sgp4', regime: 'LEO-L', horizonDays: 1, median3dKm: median, samples: 100 }));
  const recipe = { asOf: ASOF, selection: { horizonDays: 1, sourceOrder: ['space-track-gp', 'celestrak-gp'], table } };
  const r = await integrate([frames.recipe(recipe), frames.catalog(stream([catRecord(A)])), frames.omm(Buffer.concat([spaceTrack.omm, celestrak.omm])), frames.ocm(Buffer.concat([spaceTrack.ocm, celestrak.ocm]))]);
  assert.equal(r.statusCode, 0, r.message);

  // Both sets were read as the flow wrote them: source, regime and covariance label from the records alone.
  const alpha = r.report.OBJECTS[0];
  assert.equal(alpha.REGIME, 'LEO-L');
  assert.deepEqual(alpha.PRODUCTS[0].CANDIDATES.map((c) => [c.SOURCE_ID, c.STANDING, c.MEDIAN_3D_KM]),
    [['space-track-gp', x.xmtCandidateStanding.NotSelected, 0.8], ['celestrak-gp', x.xmtCandidateStanding.Selected, 0.5]]);
  assert.deepEqual(records(r.omm), records(celestrak.omm), 'the chosen source\'s $OMM, byte for byte');
  assert.deepEqual(records(r.ocm), records(celestrak.ocm), 'and its $OCM');
  const selected = alpha.PRODUCTS[0].SELECTED;
  assert.equal(selected.COVARIANCE_ORIGIN, x.xmtCovarianceOrigin.FromOcm);
  assert.equal(selected.COVARIANCE.CALIBRATION, OCM.covarianceCalibration.Uncalibrated, 'E14 found only LEO-H at 0 and 0.5 days realistic');
  const written = unpackOcm(records(celestrak.ocm)[0]).COV_REALISM[0];
  assert.equal(selected.COVARIANCE.RULE, OCM.covarianceRule.SourceModel);
  assert.equal(selected.COVARIANCE.REGIME, 'LEO-L');
  assert.equal(selected.COVARIANCE.MODEL_ID, written.MODEL_ID, 'the model the flow named');
  assert.equal(selected.COVARIANCE.MEAN_D2_OVER_3, written.MEAN_D2_OVER_3);

  // What the integrator read is what the flow wrote.
  const chosen = unpackOmm(records(r.omm)[0]);
  assert.equal(chosen.PROVENANCE.ORIGINATOR, 'CelesTrak', "the source's originator; ORIGINATOR names the message's creator");
  assert.equal(chosen.PROVENANCE.SOURCE_ID, 'celestrak-gp');
  assert.equal(unpackOcm(records(r.ocm)[0]).PROVENANCE.SOURCE_ID, 'celestrak-gp');
  assert.equal(OCM.covarianceCalibration.Uncalibrated, unpackOcm(records(r.ocm)[0]).COV_CALIBRATION);

  // With the measurements reversed the other source's products come out, covariance with them.
  const reversed = { ...recipe, selection: { ...recipe.selection, table: table.map((t) => ({ ...t, median3dKm: 1.3 - t.median3dKm })) } };
  const other = await integrate([frames.recipe(reversed), frames.catalog(stream([catRecord(A)])), frames.omm(Buffer.concat([spaceTrack.omm, celestrak.omm])), frames.ocm(Buffer.concat([spaceTrack.ocm, celestrak.ocm]))]);
  assert.deepEqual(records(other.omm), records(spaceTrack.omm));
  assert.deepEqual(records(other.ocm), records(spaceTrack.ocm));
});
