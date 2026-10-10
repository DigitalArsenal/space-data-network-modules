// Tri-runtime parity of the PRW SDS 1.243.0 forces on the request path: the
// Orekit cases with Knocke Earth radiation and FES2004 ocean tides (LEO400 and
// GPS, the STM and parameter columns included), byte-identical in Chrome,
// native WasmEdge and Docker WasmEdge at 1/2/4/8 workers. Each case runs its
// forces from its initial state over its first ten minutes (samples at 5 and
// 10 min): the same code paths as the full-day cases, which the interpreted
// native runs could not finish within the harness timeout under load. The
// full-day cases' accuracy is tests/orekit_reference.test.mjs.
//   PATH="$HOME/.wasmedge/bin:$PATH" node tests/prw-earth-radiation-tides-parity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeParityFixture, runParityHarness, formatParityReport } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs } from './lib/orekitCases.mjs';

const hex = (list) => list.map(({ payload, ...rest }) => ({ ...rest, payloadHex: Buffer.from(payload).toString('hex') }));
// "2026-08-02T00:00:00.000" plus seconds, in the same form.
const plus = (iso, seconds) => new Date(Date.parse(`${iso}Z`) + seconds * 1000).toISOString().replace('Z', '');
const tenMinutes = (c) => ({ ...c, samples: [c.samples[0], ...[300, 600].map((t) => [t, 0, 0, 0, 0, 0, 0, plus(c.samples[0][7], t)])] });
const cases = REFERENCE.cases
  .filter((c) => (c.orbit === 'LEO400' || c.orbit === 'GPS') && (c.earthRadiation || c.oceanTidesDegree))
  .filter((c) => !c.forces.startsWith('O2'))
  .map((c) => ({ id: `${c.orbit}-${c.forces}`, request: { methodId: 'invoke', inputs: hex(requestInputs(tenMinutes(c))) } }));
const plan = await normalizeParityFixture({ name: 'propagator/hpop PRW Earth radiation and ocean tides', threadCounts: [1, 2, 4, 8], cases });
const report = await runParityHarness({ wasmPath: fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url)), plan, timeoutMs: 300000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(new URL('./evidence/earth-radiation-tides/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./evidence/earth-radiation-tides/prw-earth-radiation-tides-parity.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
