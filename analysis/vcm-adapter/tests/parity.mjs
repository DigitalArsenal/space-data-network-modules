// Tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of every method of analysis/vcm-adapter 0.2.0: read (the
// sample VCM, its parameter rows as printed, a refused message), ocm (an FFM result of the sample's request) and
// write (the sample's $OCM with and without its $EOP records): identical request bytes must give byte-identical
// outputs, and the same exit class, in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBrowserModuleHarness, formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';

const here = (p) => new URL(p, import.meta.url);
const wasmPath = new URL('../dist/isomorphic/module.wasm', import.meta.url).pathname;
const SAMPLE = fs.readFileSync(here('fixtures/sample-vcm.txt'));
const PRW = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
const OCM = { schemaName: 'OCM.fbs', fileIdentifier: '$OCM', rootTypeName: 'OCM', wireFormat: 'flatbuffer' };
const EOP = { schemaName: 'EOP.fbs', fileIdentifier: '$EOP', rootTypeName: 'EOP', wireFormat: 'flatbuffer' };
const load = async (module) => createBrowserModuleHarness({ wasmSource: fs.readFileSync(here(`${module}/dist/isomorphic/module.wasm`)), manifest: JSON.parse(fs.readFileSync(here(`${module}/plugin-manifest.json`), 'utf8')), surface: 'direct' });
const jsonInput = (portId, value) => ({ portId, payloadUtf8: JSON.stringify(value) });
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const out = (response, port) => response.outputs.find((o) => o.portId === port).payload;
const ok = (response) => { assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`); return response; };

// The inputs that are another module's output, made in this process (V8): read's $OCM and $EOP records, and the
// result FFM gives for the request read builds.
const adapter = await load('..'), ffm = await load('../../../propagator/ffm');
const options = { ephemerisSource: 'Analytical', arcSeconds: 3600 };
const read = ok(await adapter.invoke({ methodId: 'read', inputs: [{ portId: 'message', payload: SAMPLE }, { portId: 'options', payload: Buffer.from(JSON.stringify(options)) }] }));
const run = ok(await ffm.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: PRW, payload: out(read, 'request') }, { portId: 'earth_orientation', typeRef: PRW, payload: out(read, 'earth_orientation') }] }));
const report = JSON.parse(Buffer.from(out(read, 'report')).toString());
await adapter.destroy(); await ffm.destroy();

const header = { satelliteNumber: 0, internationalDesignator: report.internationalDesignator, commonName: 'PARITY', center: 'SDN', geopotential: report.geopotential,
  zonals: report.zonals, tesserals: report.tesserals, drag: report.drag, lunarSolar: 'ON', solarRadiationPressure: 'OFF', solidEarthTides: 'ON', inTrackThrust: 'OFF',
  ballisticCoefficient: report.ballisticCoefficientM2Kg, f10: report.f10, averageF10: report.averageF10, averageAp: report.averageAp,
  taiMinusUtcS: report.taiMinusUtcS, ut1MinusUtcS: report.ut1MinusUtcS, weightedRms: report.weightedRms };
const typed = (portId, typeRef, bytes) => ({ portId, typeRef, payloadHex: hex(bytes) });
const cases = [
  { id: 'read-sample', request: { methodId: 'read', inputs: [{ portId: 'message', payloadHex: hex(SAMPLE) }, jsonInput('options', options)] } },
  { id: 'read-sample-parameter-rows-as-printed', request: { methodId: 'read', inputs: [{ portId: 'message', payloadHex: hex(SAMPLE) }, jsonInput('options', { ...options, parameterRows: 'absolute', meanMotionUnit: 'rad/ks' })] } },
  { id: 'read-refused-not-a-vcm', request: { methodId: 'read', inputs: [{ portId: 'message', payloadUtf8: '<> NOT A MESSAGE\n' }] } },
  { id: 'ocm-from-result', request: { methodId: 'ocm', inputs: [typed('result', PRW, out(run, 'response')), jsonInput('header', header)] } },
  { id: 'write-sample-ocm-with-eop', request: { methodId: 'write', inputs: [typed('ocm', OCM, out(read, 'ocm')), typed('eop', EOP, out(read, 'eop'))] } },
  { id: 'write-sample-ocm-without-eop', request: { methodId: 'write', inputs: [typed('ocm', OCM, out(read, 'ocm'))] } },
];
const plan = await normalizeParityFixture({ name: 'analysis/vcm-adapter 0.2.0 methods', cases: cases.map((c) => ({ ...c, expect: 'ok' })) });
const report2 = await runParityHarness({ wasmPath, plan, timeoutMs: 600000, log: console.log });
console.log(formatParityReport(report2));
fs.mkdirSync(here('../conformance/'), { recursive: true });
fs.writeFileSync(here('../conformance/parity.json'), `${JSON.stringify({ ...report2, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
assert.equal(report2.ok, true, JSON.stringify(report2.failures));
