import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as fb from 'flatbuffers';
import {createStandaloneHarness} from 'space-data-module-sdk/testing/isomorphic';
import {OEM} from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import {QRP} from 'spacedatastandards.org/lib/js/QRP/QRP.js';
import {qrpKind} from 'spacedatastandards.org/lib/js/QRP/qrpKind.js';
import {frame, pack, ommBytes, flightPcf, fitPcf, weather} from './fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const candidate = process.env.CATALOG_CHAIN_WASM || path.join(root, 'dist/isomorphic/module.wasm');
const control = process.env.SDNAP_WASM || path.resolve(root, '../../propagator/sdn-ap/dist/isomorphic/module.wasm');
const make = p => createStandaloneHarness('browser', p, {surface: 'direct', enableBrowserWasiThreads: false});
const payload = (r, port) => r.outputs.find(f => f.portId === port)?.payload;
const inputs = includeWeather => [frame('omm', 'OMM', ommBytes), frame('flight_config', 'PCF', flightPcf),
  frame('fit_config', 'PCF', fitPcf), ...(includeWeather ? [frame('weather', 'SPW', weather)] : [])];
const outcome = r => QRP.getRootAsQRP(new fb.ByteBuffer(payload(r, 'decision'))).unpack();

// Synthetic orbit, UTC epochs, GCRF flight in km and km/s. These are serialization
// and orchestration tests: the reference is the unchanged propagator, with zero
// byte tolerance. They make no independent orbit-accuracy claim.
test('exact-W adapter preserves both direct propagator records byte for byte', async () => {
  const a = await make(candidate), b = await make(control);
  try {
    const ingest = await b.invoke({methodId: 'ingest_omm', inputs: [frame('omm', 'OMM', ommBytes)]});
    assert.equal(ingest.statusCode, 0, ingest.errorMessage);
    const sgp4 = payload(ingest, 'ocm');
    const flight = await b.invoke({methodId: 'propagate', inputs: [frame('ocm', 'OCM', sgp4), frame('configuration', 'PCF', flightPcf)]});
    assert.equal(flight.statusCode, 0, flight.errorMessage);
    const arc = OEM.getRootAsOEM(new fb.ByteBuffer(payload(flight, 'ephemeris'))).unpack();
    const block = arc.EPHEMERIS_DATA_BLOCK[0];
    block.USEABLE_START_TIME = block.START_TIME; block.USEABLE_STOP_TIME = block.STOP_TIME;
    const expected = await b.invoke({methodId: 'fit', inputs: [frame('ephemeris', 'OEM', pack(arc, 'OEM')),
      frame('configuration', 'PCF', fitPcf), frame('space_weather', 'SPW', weather)]});
    assert.equal(expected.statusCode, 0, expected.errorMessage);
    const got = await a.invoke({methodId: 'run_chain', inputs: inputs(true)});
    assert.equal(got.statusCode, 0, got.errorMessage);
    assert.equal(outcome(got).KIND, qrpKind.Page, outcome(got).MESSAGE);
    assert.deepEqual(payload(got, 'elements'), payload(expected, 'elements'));
    assert.deepEqual(payload(got, 'fallback'), sgp4);
  } finally { a.destroy(); b.destroy(); }
});

test('refused fit emits a named outcome and SGP4 fallback, with no partial AP output', async () => {
  const h = await make(candidate);
  try {
    const refused = await h.invoke({methodId: 'run_chain', inputs: inputs(false)});
    assert.equal(refused.statusCode, 0, refused.errorMessage);
    assert.equal(outcome(refused).KIND, qrpKind.Error);
    assert.match(outcome(refused).ERROR_CODE, /weather/);
    assert.ok(payload(refused, 'fallback')?.length);
    assert.equal(payload(refused, 'elements'), undefined);
    // A later invocation has no retained failure or output from the refusal.
    const good = await h.invoke({methodId: 'run_chain', inputs: inputs(true)});
    assert.equal(good.statusCode, 0, good.errorMessage);
    assert.equal(outcome(good).KIND, qrpKind.Page, outcome(good).MESSAGE);
    assert.equal(outcome(good).ERROR_CODE ?? '', '');
  } finally { h.destroy(); }
});

test('surplus seed frames are refused without output records', async () => {
  const h = await make(candidate);
  try {
    const r = await h.invoke({methodId: 'run_chain', inputs: [...inputs(true), frame('omm', 'OMM', ommBytes)]});
    assert.equal(r.statusCode, 0, r.errorMessage);
    assert.equal(outcome(r).ERROR_CODE, 'invalid-input');
    assert.equal(payload(r, 'elements'), undefined);
    assert.equal(payload(r, 'fallback'), undefined);
  } finally { h.destroy(); }
});
