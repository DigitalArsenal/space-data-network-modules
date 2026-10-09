// Tri-runtime parity of the GNSS radiation pressure on the PRW request path:
// every Orekit GNSS case (box-wing IIF and IIR, ECOM2 with its parameters)
// plus box-wing IIF and ECOM2 together, byte-identical in Chrome, native
// WasmEdge and Docker WasmEdge at 1/2/4/8 workers.
//   PATH="$HOME/.wasmedge/bin:$PATH" node tests/prw-gnss-parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import { REFERENCE, inputs } from './lib/gnssSrpCases.mjs';
import { sds } from './lib/prwCodec.mjs';

const hex = (list) => list.map(({ payload, ...rest }) => ({ ...rest, payloadHex: Buffer.from(payload).toString('hex') }));
const ecom = REFERENCE.cases.find((c) => c.model === 'ecom2');
const cases = [
  ...REFERENCE.cases.map((c) => ({ id: c.name, request: { methodId: 'invoke', inputs: hex(inputs(c)) } })),
  { id: 'IIF-boxwing-plus-ecom2', request: { methodId: 'invoke', inputs: hex(inputs(ecom, (e) => {
    e.FORCES.RADIATION_PRESSURE_MODEL = sds.prwRadiationPressureFamily.GNSS_BOX_WING;
    e.FORCES.GNSS_BLOCK = sds.prwGnssSpacecraftBlock.GPS_IIF;
  })) } },
];
const plan = await normalizeParityFixture({ name: 'propagator/hpop PRW GNSS radiation pressure', threadCounts: [1, 2, 4, 8], cases });
const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, timeoutMs: 120000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(new URL('./evidence/gnss-srp/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./evidence/gnss-srp/prw-gnss-parity.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
