// Parity (browser and native WasmEdge; the owner waived the Docker leg on 2026-10-22, it is never started) of every
// method of analysis/vcm-adapter: read (the sample VCM, its parameter rows as printed, a refused message), ocm (an FFM
// result of the sample's request) and write (the sample's $OCM with and without its $EOP records): identical request
// bytes and node config must give byte-identical outputs, and the same exit class, in every lane. Typed contracts 1.0:
// the VCM text travels as a $FIL, the read options and the ocm header are the node config every lane answers
// (plugin.getConfig, tables "read" and "header"). A failed run leaves the committed receipt untouched: assert, then write.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs   (through headless-run: the browser lane)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as flatbuffers from 'flatbuffers';
import { decodeFlowNotice } from 'space-data-module-sdk/runtime-contracts';
import { createBrowserModuleHarness, formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { FIL } from 'spacedatastandards.org/lib/js/FIL/main.js';

const here = (p) => new URL(p, import.meta.url);
const wasmPath = new URL('../dist/isomorphic/module.wasm', import.meta.url).pathname;
const SAMPLE = fs.readFileSync(here('fixtures/sample-vcm.txt'));
const FIL_REF = { schemaName: 'FIL.fbs', fileIdentifier: '$FIL', rootTypeName: 'FIL', wireFormat: 'flatbuffer' };
const PRW = { schemaName: 'PRW.fbs', fileIdentifier: '$PRW', rootTypeName: 'PRW', wireFormat: 'flatbuffer' };
const OCM = { schemaName: 'OCM.fbs', fileIdentifier: '$OCM', rootTypeName: 'OCM', wireFormat: 'flatbuffer' };
const EOP = { schemaName: 'EOP.fbs', fileIdentifier: '$EOP', rootTypeName: 'EOP', wireFormat: 'flatbuffer' };
const load = async (module, config = {}) => createBrowserModuleHarness({ wasmSource: fs.readFileSync(here(`${module}/dist/isomorphic/module.wasm`)), manifest: JSON.parse(fs.readFileSync(here(`${module}/plugin-manifest.json`), 'utf8')), surface: 'direct', hostOptions: { config } });
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const out = (response, port) => response.outputs.find((o) => o.portId === port).payload;
const ok = (response) => { assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`); return response; };
// A $FIL carrying the text as CONTENT: the typed form of the VCM message.
const filOf = (text) => {
  const b = new flatbuffers.Builder(1024);
  const content = FIL.createContentVector(b, new Uint8Array(text));
  FIL.startFIL(b); FIL.addContent(b, content); FIL.finishFILBuffer(b, FIL.endFIL(b));
  return b.asUint8Array();
};

// The inputs that are another module's output, made in this process (V8): read's $OCM and $EOP records, and the
// result FFM gives for the request read builds.
const options = { ephemerisSource: 'Analytical', arcSeconds: 3600 };
const adapter = await load('..', { read: options }), ffm = await load('../../../propagator/ffm');
const read = ok(await adapter.invoke({ methodId: 'read', inputs: [{ portId: 'message', typeRef: FIL_REF, payload: filOf(SAMPLE) }] }));
const run = ok(await ffm.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: PRW, payload: out(read, 'request') }, { portId: 'earth_orientation', typeRef: PRW, payload: out(read, 'earth_orientation') }] }));
// read's report is a FlowNotice whose ITEMS are "key=value" lines.
const report = Object.fromEntries(decodeFlowNotice(out(read, 'report')).items.map((item) => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }));
await adapter.destroy(); await ffm.destroy();

const header = { satelliteNumber: 0, internationalDesignator: report.internationalDesignator, commonName: 'PARITY', center: 'SDN', geopotential: report.geopotential,
  zonals: Number(report.zonals), tesserals: Number(report.tesserals), drag: report.drag, lunarSolar: 'ON', solarRadiationPressure: 'OFF', solidEarthTides: 'ON', inTrackThrust: 'OFF',
  ballisticCoefficient: Number(report.ballisticCoefficientM2Kg), f10: Number(report.f10), averageF10: Number(report.averageF10), averageAp: Number(report.averageAp),
  taiMinusUtcS: Number(report.taiMinusUtcS), ut1MinusUtcS: Number(report.ut1MinusUtcS), weightedRms: Number(report.weightedRms) };
const typed = (portId, typeRef, bytes) => ({ portId, typeRef, payloadHex: hex(bytes) });
const cases = [
  { id: 'read-sample', config: { read: options }, request: { methodId: 'read', inputs: [typed('message', FIL_REF, filOf(SAMPLE))] } },
  { id: 'read-sample-parameter-rows-as-printed', config: { read: { ...options, parameterRows: 'absolute', meanMotionUnit: 'rad/ks' } }, request: { methodId: 'read', inputs: [typed('message', FIL_REF, filOf(SAMPLE))] } },
  { id: 'read-refused-not-a-vcm', request: { methodId: 'read', inputs: [typed('message', FIL_REF, filOf('<> NOT A MESSAGE\n'))] } },
  { id: 'ocm-from-result', config: { header }, request: { methodId: 'ocm', inputs: [typed('result', PRW, out(run, 'response'))] } },
  { id: 'write-sample-ocm-with-eop', request: { methodId: 'write', inputs: [typed('ocm', OCM, out(read, 'ocm')), typed('eop', EOP, out(read, 'eop'))] } },
  { id: 'write-sample-ocm-without-eop', request: { methodId: 'write', inputs: [typed('ocm', OCM, out(read, 'ocm'))] } },
];
const plan = await normalizeParityFixture({ name: 'analysis/vcm-adapter methods', cases: cases.map((c) => ({ ...c, expect: 'ok' })) });
const parity = await runParityHarness({ wasmPath, plan, lanes: ['browser', 'wasmedge'], timeoutMs: 600000, log: console.log });
console.log(formatParityReport(parity));
assert.equal(parity.ok, true, JSON.stringify(parity.failures));
fs.mkdirSync(here('../conformance/'), { recursive: true });
fs.writeFileSync(here('../conformance/parity.json'), `${JSON.stringify({ ...parity, wasmPath: 'dist/isomorphic/module.wasm', dockerLane: 'waived by the owner 2026-10-22 (no Docker)' }, null, 2)}\n`);
