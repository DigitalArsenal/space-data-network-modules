#!/usr/bin/env node
// E2E (task modules-catalog-products-ocm-sets-20261103): the element set as an $OCM, end to end through the modules.
// - catalog-composer integrate_catalog lists the AP $OCM of propagator/sdn-ap 0.5.1 `fit` (tests/fixtures, published by
//   two sources) as product "ap" with EPOCH = MEAN_ELEMENTS.EPOCH; with the AP products measured 0.3 and 0.6 km it
//   selects the 0.3 km source's (LowestMeasuredMedian), with 0.6 and 0.3 km the other's; the selected $OCM goes out on
//   'ocm' byte for byte and the $CAT names it: CATProduct KIND ApElements, RECORD_CID the record's CID, EPOCH its
//   MEAN_ELEMENTS.EPOCH. The SGP4 $OMM selection is unchanged: 'omm' is byte-identical to the 0.5.1 dist's
//   (tests/fixtures/ocm-sets.before.json).
// - flows/source-products, run with the space-track-gp recipe (recipe.mjs) on an SGP4 and an SGP4-XP set, names the
//   source on the SGP4XP set it gives on 'omm'; the recipe's xpProduct (propagator/sgp4-xp ingest_omm) makes it one
//   $OCM with MEAN_ELEMENTS theory SGP4XP, the source in PROVENANCE, NORAD_CAT_ID the input's. Given to the integrator
//   it is $CAT KIND Sgp4XpElements.
// - analysis/epoch-state derive_omm refuses the AP $OCM and the XP $OCM on its set port 'omm' omm-expected; from the
//   SGP4 $OMM its states are byte-identical to the 0.4.0 dist's and their OBJECT NORAD_CAT_ID is the input's 90400.
// - assertNoUserDefined on every emitted $OMM and $OCM.
// JS only builds inputs with the SDS object API, moves bytes and compares what the modules produced.
//   node analysis/catalog-composer/tests/ocm-sets.e2e.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNoUserDefined } from '../../../common/tests/no-user-defined.mjs';
import { xpProduct } from '../../../flows/source-products/recipe.mjs';
import { CAT, OCM, OMM, catRecord, cidOf, flatbuffers, frames, integrate, records, sha256, stream, unpackCat, unpackOcm, unpackOmm } from './integrator-fixtures.mjs';
import { AP_SOURCES, OBJECT, apFitEpoch, apOcms, catalog, integrateSets, recipe, sgp4Omm, xpOmm } from './ocm-sets-inputs.mjs';
import { SOURCE, moduleRun, runXpFlow, version } from './ocm-sets-chain.mjs';
import { x } from './xmt-recipes.mjs';

const before = JSON.parse(fs.readFileSync(fileURLToPath(new URL('fixtures/ocm-sets.before.json', import.meta.url)), 'utf8'));
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const noUserDefined = (label, bytes) => { try { assertNoUserDefined(bytes); } catch (e) { failures.push(`${label}: ${e.message}`); } };
const KIND = CAT.catalogProductKind;
let emitted = 0;
const emittedSets = (label, bytes) => records(bytes).forEach((r, i) => { noUserDefined(`${label}[${i}]`, r); emitted++; });

// 1. The integrator: AP $OCM sets, selected by measured error, named in the $CAT.
const apEpochMs = BigInt(Date.parse(`${apFitEpoch}Z`));
const selections = [];
for (const [medians, winner] of [[[0.3, 0.6], 0], [[0.6, 0.3], 1]]) {
  const r = await integrateSets(medians);
  check(r.statusCode === 0, `integrate ${medians}: ${r.message}`);
  if (r.statusCode !== 0) continue;
  const object = r.report.OBJECTS[0];
  const ap = object.PRODUCTS.find((p) => p.PRODUCT === 'ap');
  check(ap && ap.CANDIDATES.length === 2, `integrate ${medians}: product "ap" with ${ap?.CANDIDATES.length} candidates`);
  if (!ap) continue;
  check(ap.CANDIDATES.every((c) => c.EPOCH_MS === apEpochMs), `AP candidate epochs ${ap.CANDIDATES.map((c) => c.EPOCH_MS)} against MEAN_ELEMENTS.EPOCH ${apEpochMs}`);
  check(ap.SELECTED.SOURCE_ID === AP_SOURCES[winner] && ap.SELECTED.REASON === x.xmtSelectionReason.LowestMeasuredMedian && ap.SELECTED.MEASURED?.MEDIAN_3D_KM === Math.min(...medians),
    `integrate ${medians}: selected ${ap.SELECTED.SOURCE_ID} reason ${ap.SELECTED.REASON} median ${ap.SELECTED.MEASURED?.MEDIAN_3D_KM}`);
  check(ap.SELECTED.OCM_REF?.CID === cidOf(apOcms[winner]) && !ap.SELECTED.OMM_REF, `AP OCM_REF ${ap.SELECTED.OCM_REF?.CID}`);
  const outOcm = records(r.ocm);
  check(outOcm.length === 1 && outOcm[0].equals(apOcms[winner]), `'ocm': ${outOcm.length} records, the selected AP set byte for byte: ${outOcm[0]?.equals(apOcms[winner])}`);
  const cat = unpackCat(records(r.catalog)[0]);
  const apProduct = cat.PRODUCTS.find((p) => p.KIND === KIND.ApElements);
  check(apProduct && apProduct.RECORD_CID === cidOf(apOcms[winner]) && apProduct.SOURCE_ID === AP_SOURCES[winner] && apProduct.EPOCH === apFitEpoch
    && apProduct.SELECTION_REASON === 'LowestMeasuredMedian', `$CAT ApElements product ${JSON.stringify(apProduct)}`);
  check(cat.PRODUCTS_AS_OF === '2026-10-02T00:00:00.000000Z' && cat.NORAD_CAT_ID === OBJECT.norad, `$CAT PRODUCTS_AS_OF ${cat.PRODUCTS_AS_OF}, NORAD ${cat.NORAD_CAT_ID}`);
  check(sha256(r.omm) === before.integrator.omm, `'omm' (the SGP4 selection) moved from the 0.5.1 dist's`);
  check(r.report.OMM_RECORDS === 1 && r.report.OCM_RECORDS === 2 && r.report.REFUSED_COUNT === 0, `report counts ${r.report.OMM_RECORDS} ${r.report.OCM_RECORDS} ${r.report.REFUSED_COUNT}`);
  emittedSets('integrator omm', r.omm);
  emittedSets('integrator ocm', r.ocm);
  selections.push({ medians, source: ap.SELECTED.SOURCE_ID, cid: apProduct?.RECORD_CID });
}

// 2. The source-products flow's XP product, through the recipe's xpProduct stage.
const stage = xpProduct();
const { egress } = await runXpFlow([sgp4Omm, xpOmm]);
const xpSets = records(Buffer.concat(egress.get('omm') ?? [])).filter((b) => unpackOmm(b).MEAN_ELEMENT_THEORY === OMM.meanElementSource.SGP4XP);
check(xpSets.length === 1 && unpackOmm(xpSets[0]).PROVENANCE?.SOURCE_ID === SOURCE, `flow 'omm': ${xpSets.length} SGP4XP sets named ${xpSets.map((b) => unpackOmm(b).PROVENANCE?.SOURCE_ID)}`);
for (const port of ['omm', 'ocm']) emittedSets(`flow ${port}`, Buffer.concat(egress.get(port) ?? []));
const xp = await moduleRun(stage.module, stage.method, [{ port: stage.input, type: 'OMM', bytes: Buffer.concat(xpSets) }]);
check(xp.statusCode === 0, `${stage.module} ${stage.method}: ${xp.errorCode} ${xp.errorMessage}`);
const xpOcm = Buffer.concat(xp.byPort.get(stage.output) ?? []);
const xpRecords = xpOcm.length ? records(xpOcm) : [];
const xpRecord = xpRecords.length === 1 ? unpackOcm(xpRecords[0]) : null;
check(xpRecord && xpRecord.MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY === OCM.meanElementSource.SGP4XP && xpRecord.PROVENANCE?.SOURCE_ID === SOURCE
  && xpRecord.METADATA?.NORAD_CAT_ID === OBJECT.norad, `XP product: ${xpRecords.length} $OCM, theory ${xpRecord?.MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY}, source ${xpRecord?.PROVENANCE?.SOURCE_ID}, NORAD ${xpRecord?.METADATA?.NORAD_CAT_ID}`);
emittedSets('XP product', xpOcm);
let xpKind = null;
if (xpRecords.length === 1) {
  const r = await integrate([frames.recipe(recipe([0.3, 0.6])), frames.catalog(catalog), frames.omm(stream([sgp4Omm])), frames.ocm(stream([...apOcms, xpRecords[0]]))]);
  check(r.statusCode === 0, `integrate with the XP product: ${r.message}`);
  const cat = r.statusCode === 0 ? unpackCat(records(r.catalog)[0]) : { PRODUCTS: [] };
  const kinds = cat.PRODUCTS.map((p) => [p.KIND, p.SOURCE_ID]);
  const want = [[KIND.ApElements, AP_SOURCES[0]], [KIND.Sgp4Elements, 'space-track-gp'], [KIND.Sgp4XpElements, SOURCE]];
  check(JSON.stringify(kinds) === JSON.stringify(want), `$CAT kinds ${JSON.stringify(kinds)} against ${JSON.stringify(want)}`);
  xpKind = cat.PRODUCTS.find((p) => p.KIND === KIND.Sgp4XpElements);
  check(xpKind?.RECORD_CID === cidOf(xpRecords[0]), `Sgp4XpElements RECORD_CID ${xpKind?.RECORD_CID}`);
  if (r.statusCode === 0) { emittedSets('integrator omm (XP run)', r.omm); emittedSets('integrator ocm (XP run)', r.ocm); }
}

// 3. epoch-state: the set port takes $OMM SGP4 only.
const refusals = [];
for (const [label, bytes] of [['AP $OCM', apOcms[0]], ['XP $OCM', xpRecords[0] ?? apOcms[1]]]) {
  const r = await moduleRun('analysis/epoch-state', 'derive_omm', [{ port: 'omm', type: 'OMM', bytes }]);
  check(r.statusCode === 400 && r.errorCode === 'omm-expected', `epoch-state ${label} on 'omm': ${r.statusCode} ${r.errorCode}`);
  refusals.push(r.errorCode);
}
const es = await moduleRun('analysis/epoch-state', 'derive_omm', [{ port: 'omm', type: 'OMM', bytes: sgp4Omm }]);
const states = Buffer.concat(es.byPort.get('states') ?? []);
check(es.statusCode === 0 && sha256(states) === before.epochState.sgp4.ports.states && sha256(Buffer.concat(es.byPort.get('report') ?? [])) === before.epochState.sgp4.ports.report,
  `epoch-state SGP4 states and report moved from the 0.4.0 dist's`);
const { OEM } = await import('spacedatastandards.org/lib/js/OEM/OEM.js');
const oem = records(states).map((b) => OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(b))).unpack());
const statesNorad = oem[0]?.EPHEMERIS_DATA_BLOCK?.[0]?.OBJECT?.NORAD_CAT_ID;
check(oem.length === 1 && statesNorad === unpackOmm(sgp4Omm).NORAD_CAT_ID, `epoch-state states OBJECT NORAD_CAT_ID ${statesNorad}`);

const versions = ['analysis/catalog-composer', 'analysis/epoch-state', 'flows/source-products', 'propagator/sgp4-xp'].map((m) => `${m.split('/')[1]} ${version(m)}`).join(', ');
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`OCM-SETS ${versions}: AP $OCM product "ap" selected ${selections.map((s) => `${s.source} at ${Math.min(...s.medians)} km`).join(' and ')} `
  + `(LowestMeasuredMedian), $CAT ApElements RECORD_CID = the selected record's CID; XP product 1 $OCM theory SGP4XP from ${SOURCE}, $CAT Sgp4XpElements; `
  + `epoch-state ${refusals.join(', ')} on 'omm', SGP4 states byte-identical, NORAD_CAT_ID ${statesNorad}; ${emitted} emitted $OMM/$OCM records, 0 USER_DEFINED_PARAMETERS`);
console.log('\nocm-sets E2E: PASS');
process.exit(0);
