// Parity (browser and native WasmEdge, 1/2/4/8 workers) of the finite-burn requests: one artifact, identical requests.
// Numerical acceptance is in finite_burn_invoke.test.mjs.
import { parity } from './lib/parity.mjs';
import { cases } from './finite-burn-fixture.mjs';
await parity({ name: 'TMPL lane13 canonical PRW finite burns artifact', cases, receipt: 'lane13/finite-burn-parity.json' });
