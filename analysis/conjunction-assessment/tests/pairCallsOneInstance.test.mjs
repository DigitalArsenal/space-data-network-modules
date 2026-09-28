// Ten thousand pair calls on one module instance, each request encoded by the
// test host as it is sent.
//
// Before tests/lib/cqr.mjs ran flatc with argv on the heap, the host could not
// get past the 1,783rd CQR encode in a process: flatc-wasm's callMain leaves
// every conversion's argv on flatc's 2 MiB stack (1,168 bytes per CQR encode),
// and the next encode ran off it ("memory access out of bounds"). That is the
// trap MC2 saw after about 1,780 pair calls: the host's encoder, not the
// conjunction module.
//
// Source: CelesTrak GP element sets, SGP4 mean elements in TEME of date, UTC
// (fixtures/decaying/gp_2026-07-06.json): EXPLORER 7 (NORAD 22) and
// STARLINK-4714 (NORAD 53704), which pass within 5 km of each other twice on
// 2026-07-06. Requests: 24 one-hour windows of that day, 60 s coarse step,
// 1 ms refinement tolerance, 5 m radii, ALFANO_MAXIMUM. Calls cycle
// find_tca, assess_conjunction and emit_cdm over the windows.
//
// Exact assertions only: every call succeeds, and every output is
// byte-identical to the first output of the same method and window (the
// instance keeps no state between pair calls, so a repeated request has one
// answer). find_tca and assess_conjunction name the same TCA for a window
// (assess_conjunction evaluates the pair at find_tca's TCA).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, encodeCqr, gpSource, initCqrFlatc, pairRequest } from './lib/cqr.mjs';

const GP = JSON.parse(fs.readFileSync(new URL('./fixtures/decaying/gp_2026-07-06.json', import.meta.url), 'utf8'));
const PRIMARY = GP.find((g) => g.NORAD_CAT_ID === 22);
const SECONDARY = GP.find((g) => g.NORAD_CAT_ID === 53704);
const START_JD = Date.parse('2026-07-06T00:00:00Z') / 86400000 + 2440587.5;
const WINDOWS = 24;
const CALLS = 10000;
const METHODS = [['find_tca', 'result'], ['assess_conjunction', 'result'], ['emit_cdm', 'cdm']];

test('one instance answers 10,000 pair calls, each request encoded as it is sent', { timeout: 1800000 }, async (t) => {
  const flatc = await initCqrFlatc();
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser', surface: 'direct' });
  t.after(() => harness.destroy());
  const record = (window) => pairRequest({ PRIMARY: gpSource(PRIMARY), SECONDARY: gpSource(SECONDARY),
    startJd: START_JD + window / 24, durationSeconds: 3600, coarseStepSec: 60, fineTolSec: 0.001 });
  const first = new Map();
  for (let call = 0; call < CALLS; call++) {
    const [methodId, port] = METHODS[call % METHODS.length];
    const window = Math.floor(call / METHODS.length) % WINDOWS;
    const response = await harness.invoke({ methodId, inputs: [{ portId: 'request', payload: encodeCqr(flatc, record(window)) }] });
    assert.equal(response.statusCode, 0, `call ${call + 1} ${methodId}: ${response.errorCode}: ${response.errorMessage}`);
    const outputs = response.outputs.filter((f) => f.portId === port);
    assert.equal(outputs.length, 1, `call ${call + 1} ${methodId}: one ${port} frame`);
    const bytes = Buffer.from(outputs[0].payload);
    const key = `${methodId} ${window}`;
    if (!first.has(key)) first.set(key, bytes);
    else assert.ok(bytes.equals(first.get(key)), `call ${call + 1} ${key}: output differs from its first answer`);
  }
  assert.equal(first.size, METHODS.length * WINDOWS);
  for (let window = 0; window < WINDOWS; window++) {
    const tca = decodeCqr(flatc, first.get(`find_tca ${window}`)).TCA_RESULT.JULIAN_DATE;
    const event = decodeCqr(flatc, first.get(`assess_conjunction ${window}`)).EVENT_RESULT;
    assert.equal(event.TCA.JULIAN_DATE, tca, `window ${window}: assess_conjunction evaluates find_tca's TCA`);
    assert.equal(first.get(`emit_cdm ${window}`).subarray(4, 8).toString('latin1'), '$CDM');
  }
});
