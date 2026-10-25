// Parity (browser and native WasmEdge, 1/2/4/8 workers) of the GNSS radiation pressure on the PRW request path: every Orekit
// GNSS case (box-wing IIF and IIR, ECOM2 with its parameters) plus box-wing IIF and ECOM2 together.
//   PATH="$HOME/.wasmedge/bin:$PATH" node tests/prw-gnss-parity.mjs   (through headless-run: the browser lane)
import { parity } from './lib/parity.mjs';
import { REFERENCE, inputs } from './lib/gnssSrpCases.mjs';
import { sds } from './lib/prwCodec.mjs';

const hex = (list) => list.map(({ payload, ...rest }) => ({ ...rest, payloadHex: Buffer.from(payload).toString('hex') }));
const ecom = REFERENCE.cases.find((c) => c.model === 'ecom2');
const cases = [
  ...REFERENCE.cases.map((c) => ({ id: c.name, request: { methodId: 'invoke', inputs: hex(inputs(c)) } })),
  { id: 'IIF-boxwing-plus-ecom2', request: { methodId: 'invoke', inputs: hex(inputs(ecom, (e) => {
    e.FORCES.RADIATION_PRESSURE_MODEL = sds.pcfRadiationPressureFamily.GNSS_BOX_WING;
    e.FORCES.GNSS_BLOCK = sds.pcfGnssSpacecraftBlock.GPS_IIF;
  })) } },
];
await parity({ name: 'propagator/ffm PRW GNSS radiation pressure', cases, receipt: 'gnss-srp/prw-gnss-parity.json', timeoutMs: 120000 });
