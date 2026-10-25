// Parity (browser and native WasmEdge, 1/2/4/8 workers) of the PRW SDS 1.243.0 forces on the request path: the Orekit cases
// with Knocke Earth radiation and FES2004 ocean tides (LEO400 and GPS, the STM and parameter columns included). Each case
// runs its forces from its initial state over its first ten minutes (samples at 5 and 10 min): the same code paths as the
// full-day cases, which the interpreted native runs could not finish within the harness timeout under load. The full-day
// cases' accuracy is tests/orekit_reference.test.mjs.
//   PATH="$HOME/.wasmedge/bin:$PATH" node tests/prw-earth-radiation-tides-parity.mjs   (through headless-run: the browser lane)
import { parity } from './lib/parity.mjs';
import { REFERENCE, requestInputs } from './lib/orekitCases.mjs';

const hex = (list) => list.map(({ payload, ...rest }) => ({ ...rest, payloadHex: Buffer.from(payload).toString('hex') }));
// "2026-08-02T00:00:00.000" plus seconds, in the same form.
const plus = (iso, seconds) => new Date(Date.parse(`${iso}Z`) + seconds * 1000).toISOString().replace('Z', '');
const tenMinutes = (c) => ({ ...c, samples: [c.samples[0], ...[300, 600].map((t) => [t, 0, 0, 0, 0, 0, 0, plus(c.samples[0][7], t)])] });
const cases = REFERENCE.cases
  .filter((c) => (c.orbit === 'LEO400' || c.orbit === 'GPS') && (c.earthRadiation || c.oceanTidesDegree))
  .filter((c) => !c.forces.startsWith('O2'))
  .map((c) => ({ id: `${c.orbit}-${c.forces}`, request: { methodId: 'invoke', inputs: hex(requestInputs(tenMinutes(c))) } }));
await parity({ name: 'propagator/ffm PRW Earth radiation and ocean tides', cases, receipt: 'earth-radiation-tides/prw-earth-radiation-tides-parity.json', timeoutMs: 300000 });
