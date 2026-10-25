// Parity (browser and native WasmEdge, 1/2/4/8 workers) of the variational requests: one artifact, identical invoke inputs.
// Numerical acceptance runs separately against the independent Kepler fixture in variational_invoke.test.mjs.
import { parity } from './lib/parity.mjs';
import { cases } from './variational-fixture.mjs';
await parity({ name: 'TMPL lane13 canonical PRW variational artifact', cases, receipt: 'lane13/variational-parity.json' });
