import {request as epochRequest,truth,perturbed,oemStates,affine} from './epoch-fixture.mjs';
import { oem } from './matching-fixture.mjs';
import { ASOF, MNV, catRecord, labelOf, mnvRecord, ocmEpoch, ocmRecord, ommEpoch, ommRecord, stream } from './integrator-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Builder } from 'flatbuffers';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';

test('one artifact produces identical output in Chromium, native WasmEdge and container WasmEdge', { skip: process.env.SDN_RUN_CATALOG_PARITY !== '1' }, async () => {
  const record = (name, id) => { const b = new Builder(); const n = b.createString(name), d=b.createString('2020-001A'); b.startObject(3); b.addFieldOffset(0,n,0); b.addFieldOffset(1,d,0); b.addFieldInt32(2,id,0); b.finishSizePrefixed(b.endObject(),'$CAT'); return new Uint8Array(b.asUint8Array()); };
  const config = { version:2, layers:['a','b'].map(id=>({id,node:`peer-${id}`,provider:id,source:'satcat',head:`snapshot-${id}`})),asOf:1000,maxAgeSeconds:100,stateSources:[],overrides:{'cospar:2020-001A':{catalogLayer:'b'}} };
  const recipe = JSON.stringify(config);
  const request = { methodId:'compose',inputs:[
    {portId:'recipe',payloadUtf8:recipe,typeRef:{wireFormat:'aligned-binary',byteLength:new TextEncoder().encode(recipe).length,requiredAlignment:1}},
    ...[record('First',1),record('Selected',1)].map(payload=>({portId:'catalogs',payload,typeRef:{schemaName:'CAT.fbs',fileIdentifier:'$CAT',rootTypeName:'CAT'}})),
  ] };
  const invalid = structuredClone(request);invalid.inputs[0].payloadUtf8='!';invalid.inputs[0].typeRef.byteLength=1;
  // A rejected recipe is a structured PIV error response; the command host
  // exits normally after writing it. sdk_compat separately asserts its status.
  const matchingRecipe=JSON.stringify({version:1,candidates:[{id:'a',provider:'a',nativeId:'1',recordId:'hash-a'},{id:'b',provider:'b',nativeId:'2',recordId:'hash-b'}],pairs:[{left:'a',right:'b'}],positionToleranceKm:1,velocityToleranceKmS:.01,finiteDifferenceToleranceKmS:1e-8,minimumSpanSeconds:8});
  const matchingRequest={methodId:'match_catalog',inputs:[{portId:'recipe',payloadUtf8:matchingRecipe,typeRef:{wireFormat:'aligned-binary',byteLength:new TextEncoder().encode(matchingRecipe).length,requiredAlignment:1}},...[oem(),oem()].map(payload=>({portId:'ephemerides',payload,typeRef:{schemaName:'OEM.fbs',fileIdentifier:'$OEM',rootTypeName:'OEM'}}))]};
  const endpointRequest=structuredClone(matchingRequest);
  for(const input of endpointRequest.inputs.slice(1)) input.payload=oem({velocityErrors:{0:.02,8:.02}});
  // The integrator: sources' sets for two objects, one burn reported by two sources (merged) that retires one source's better-measured set, the
  // chosen sets' covariance with its label, and a native name joined by a link its trajectories supported.
  const jsonInput = (value) => { const text = JSON.stringify(value); return { portId: 'recipe', payloadUtf8: text, typeRef: { wireFormat: 'aligned-binary', byteLength: new TextEncoder().encode(text).length, requiredAlignment: 1 } }; };
  const typed = (portId, schemaName, fileIdentifier, rootTypeName, payload) => ({ portId, payload, typeRef: { schemaName, fileIdentifier, rootTypeName } });
  const [S1, S2, S3] = ['space-track-gp', 'celestrak-gp', 'esa-ura'];
  const A = { norad: 90001, cospar: '2026-901A', name: 'ALPHA' }, B = { norad: 90002, cospar: '2026-902A', name: 'BRAVO' };
  const set = (source, who, days, regime = 'LEO-L') => ommRecord({ source, ...who, epoch: ommEpoch(days), label: labelOf(regime) });
  const table = [[S1, 'LEO-L', 0.8, 100], [S2, 'LEO-L', 0.5, 100], [S3, 'LEO-L', 0.2, 10], ['vimpel', 'LEO-L', 0.1, 50], [S1, 'LEO-H', 0.3, 60], [S2, 'LEO-H', 0.45, 60], [S3, 'LEO-H', 0.01, 50]]
    .map(([source, regime, median3dKm, samples]) => ({ source, product: 'sgp4', regime, horizonDays: 1, median3dKm, samples }));
  const thresholds = { positionToleranceKm: 1, velocityToleranceKmS: 0.01, finiteDifferenceToleranceKmS: 1e-8, minimumSpanSeconds: 8 };
  const integration = {
    version: 1, asOf: ASOF, selection: { horizonDays: 1, minSamples: 30, sourceOrder: [S1, S2, S3], table }, maneuvers: { timeToleranceSeconds: 3600, deltaVToleranceKmS: 0.0005 },
    identity: { version: 1, ...thresholds, candidates: [{ id: 'v', provider: 'vimpel', nativeId: 'V-100', recordId: 'immutable-v' }, { id: 'r', provider: 'space-track', nativeId: '90001', recordId: 'immutable-r' }],
      pairs: [{ native: 'v', reference: 'r', object: { norad: 90001 }, evidence: { source: 'datefirst', recordId: 'crosswalk-edition' } }] },
  };
  const integrationRequest = { methodId: 'integrate_catalog', inputs: [
    jsonInput(integration),
    typed('catalog', 'CAT.fbs', '$CAT', 'CAT', stream([catRecord(A), catRecord(B)])),
    ...[oem(), oem()].map((payload) => typed('ephemerides', 'OEM.fbs', '$OEM', 'OEM', payload)),
    typed('omm_products', 'OMM.fbs', '$OMM', 'OMM', stream([set(S1, A, 1), set(S2, A, 2), set(S3, A, 0.5), set(S1, B, 1, 'LEO-H'), set(S2, B, 1, 'LEO-H'), set(S3, B, 2, 'LEO-H'),
      ommRecord({ source: 'vimpel', native: 'V-100', epoch: ommEpoch(0.2), label: labelOf('LEO-L') })])),
    typed('ocm_products', 'OCM.fbs', '$OCM', 'OCM', stream([ocmRecord({ source: 'vimpel', native: 'V-100', epoch: ocmEpoch(0.2), label: labelOf('LEO-L') }), ocmRecord({ source: S1, ...B, epoch: ocmEpoch(1), label: labelOf('LEO-H') })])),
    typed('mnv_products', 'MNV.fbs', '$MNV', 'MNV', stream([
      mnvRecord({ source: S1, id: 'a', ...B, at: ocmEpoch(1.5), dv: 0.001 }),
      mnvRecord({ source: S2, id: 'b', ...B, at: new Date(Date.parse(ocmEpoch(1.5)) + 20 * 60e3).toISOString(), dv: 0.0011, status: MNV.maneuverStatus.CONFIRMED })])),
  ] };
  const refusedIntegration = structuredClone(integrationRequest);
  refusedIntegration.inputs[0] = jsonInput({ version: 1 });
  const plan = await normalizeParityFixture({name:'catalog-composer',threadCounts:[1],cases:[{id:'epoch-position-validation',request:epochRequest('validate_epoch',truth,[oemStates(affine(truth))]),expect:'ok'},{id:'epoch-fit-step',request:epochRequest('fit_epoch_step',truth,perturbed(truth)),expect:'ok'},{id:'endpoint-velocity-error',request:endpointRequest,expect:'ok'},{id:'circular-trajectory-match',request:matchingRequest,expect:'ok'},{id:'exact-id-override',request,expect:'ok'},{id:'malformed-recipe',request:invalid,expect:'ok'},{id:'integrate-selection-maneuvers-identity',request:integrationRequest,expect:'ok'},{id:'integrate-malformed-recipe',request:refusedIntegration,expect:'ok'}]});
  const report = await runParityHarness({wasmPath:fileURLToPath(new URL('../dist/isomorphic/module.wasm',import.meta.url)),plan,autoBuildDockerImage:false,timeoutMs:30000,log:message=>console.log(message)});
  console.log(formatParityReport(report));
  assert.equal(report.ok,true,formatParityReport(report));
  assert.equal(report.lanes.length,3);
});
