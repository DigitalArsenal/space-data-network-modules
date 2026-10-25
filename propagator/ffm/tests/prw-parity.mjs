// Parity (browser and native WasmEdge, 1/2/4/8 workers) of the PRW malformed-request classifications.
import { parity } from './lib/parity.mjs';
import { cases } from './prw-contract-fixture.mjs';
await parity({ name: 'TMPL lane13 PRW malformed classifications', cases, receipt: 'lane13/prw-parity.json' });
