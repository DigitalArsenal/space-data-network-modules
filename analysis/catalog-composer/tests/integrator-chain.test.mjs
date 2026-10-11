// The integrator on what flows/source-products really writes: two sources' element sets go through the compiled flow, and
// their $OMM and $OCM (source, provider and covariance label in the records as the flow writes them) are integrated. The
// contract between the two modules is the records, so this fails if either side changes what it writes or reads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlowRuntimeHost } from 'space-data-module-sdk/flow';

import { recipeFor } from '../../../flows/source-products/recipe.mjs';
import { ASOF, DAY, OCM, catRecord, frames, integrate, ommEpoch, ommRecord, records, stream, unpackOcm, unpackOmm } from './integrator-fixtures.mjs';

const dist = fileURLToPath(new URL('../../../flows/source-products/dist/', import.meta.url));
const flowWasm = new Uint8Array(fs.readFileSync(`${dist}isomorphic/module.wasm`));
const flowDocument = JSON.parse(fs.readFileSync(`${dist}flow.json`, 'utf8'));

async function runFlow(ingress) {
  const host = await createFlowRuntimeHost({ wasmSource: flowWasm, runtimeTarget: 'wasmedge' });
  const egress = new Map();
  for (const { trigger, portId, bytes } of ingress) host.enqueueTriggerFrame(flowDocument.triggers.findIndex((t) => t.triggerId === trigger), { portId, bytes });
  await host.drain({ 'sdn.flow.egress:emit': ({ frames: out }) => {
    for (const f of out) egress.set(f.portId, [...(egress.get(f.portId) ?? []), Buffer.from(f.bytes)]);
    return { statusCode: 0 };
  } }, { maxIterations: 500 });
  return (port) => Buffer.concat(egress.get(port) ?? []);
}

// A 15.5 rev/day orbit: a = (mu / n^2)^(1/3) = 6796 km, 418 km above the equatorial radius: E14's LEO-L (0 to 500 km).
const A = { norad: 90001, cospar: '2026-901A', name: 'ALPHA' };
// The element set as its source publishes it: no source named yet; the flow names it.
const set = (daysBefore) => ommRecord({ ...A, epoch: ommEpoch(daysBefore) });
const productsOf = async (id, via, daysBefore) => {
  const recipe = recipeFor(id, { created: '2026-10-10T00:00:00Z', via, ages: [0, 1] });
  const out = await runFlow([{ trigger: 'element_sets', portId: 'omm', bytes: set(daysBefore) }, { trigger: 'element_set_recipe', portId: 'recipe', bytes: Buffer.from(JSON.stringify(recipe)) }]);
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
  const recipe = { version: 1, asOf: ASOF, selection: { horizonDays: 1, sourceOrder: ['space-track-gp', 'celestrak-gp'], table } };
  const r = await integrate([frames.recipe(recipe), frames.catalog(stream([catRecord(A)])), frames.omm(Buffer.concat([spaceTrack.omm, celestrak.omm])), frames.ocm(Buffer.concat([spaceTrack.ocm, celestrak.ocm]))]);
  assert.equal(r.statusCode, 0, r.message);

  // Both sets were read as the flow wrote them: source, regime and covariance label from the records alone.
  const alpha = r.report.objects[0];
  assert.equal(alpha.regime, 'LEO-L');
  assert.deepEqual(alpha.products[0].candidates.map((c) => [c.source, c.status, c.median3dKm]), [['space-track-gp', 'not-selected', 0.8], ['celestrak-gp', 'selected', 0.5]]);
  assert.deepEqual(records(r.omm), records(celestrak.omm), 'the chosen source\'s $OMM, byte for byte');
  assert.deepEqual(records(r.ocm), records(celestrak.ocm), 'and its $OCM');
  const selected = alpha.products[0].selected;
  assert.equal(selected.covariance.from, 'ocm');
  assert.equal(selected.covariance.calibration, 'Uncalibrated', 'E14 found only LEO-H at 0 and 0.5 days realistic');
  assert.equal(selected.covariance.label.rule, 3);
  assert.equal(selected.covariance.label.regime, 'LEO-L');
  assert.equal(selected.covariance.label.method, 'e14-s3-kc');

  // What the integrator read is what the flow wrote.
  const chosen = unpackOmm(records(r.omm)[0]);
  assert.equal(chosen.ORIGINATOR, 'CelesTrak');
  assert.equal(chosen.USER_DEFINED_PARAMETERS.find((p) => p.PARAM_NAME === 'SOURCE_ID').PARAM_VALUE, 'celestrak-gp');
  assert.equal(unpackOcm(records(r.ocm)[0]).USER_DEFINED_PARAMETERS.find((p) => p.PARAM_NAME === 'SOURCE_ID').PARAM_VALUE, 'celestrak-gp');
  assert.equal(OCM.covarianceCalibration.Uncalibrated, unpackOcm(records(r.ocm)[0]).COV_CALIBRATION);

  // With the measurements reversed the other source's products come out, covariance with them.
  const reversed = { ...recipe, selection: { ...recipe.selection, table: table.map((t) => ({ ...t, median3dKm: 1.3 - t.median3dKm })) } };
  const other = await integrate([frames.recipe(reversed), frames.catalog(stream([catRecord(A)])), frames.omm(Buffer.concat([spaceTrack.omm, celestrak.omm])), frames.ocm(Buffer.concat([spaceTrack.ocm, celestrak.ocm]))]);
  assert.deepEqual(records(other.omm), records(spaceTrack.omm));
  assert.deepEqual(records(other.ocm), records(spaceTrack.ocm));
});
