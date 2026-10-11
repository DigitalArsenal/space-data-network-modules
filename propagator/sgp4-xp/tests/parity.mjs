// Tri-runtime parity (browser, native WasmEdge, Docker WasmEdge) of propagator/sgp4-xp 0.1.0: the same request bytes
// must give byte-identical outputs, and the same exit class, in every lane.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
//
// The cases: propagate (SGP4-XP and SGP4 sets in LEO, sun-synchronous, MEO, GEO and highly eccentric orbits, on a
// uniform grid in TEME and in GCRF, and on explicit epochs), fit (an ephemeris made by propagate from a known set; the
// real NASA ISS OEM; a position-only ephemeris; a block with a declared fit interval and a held-out stretch), ingest_omm,
// and the requests the module refuses. Where a case needs a forward model it is the module's own propagate, in this
// process (V8), as in analysis/density-calibration's parity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatParityReport, normalizeParityFixture, runParityHarness } from 'space-data-module-sdk/testing';
import { loadModule, wasmPath, root } from './lib/module.mjs';
import { frame, oemBytes, ommBytes, readOem, blockLines } from './lib/sds.mjs';
import { battery, omm as ommOfLines } from './lib/tle.mjs';
import { parseOemKvn, sdsFrame } from './lib/oemkvn.mjs';

const local = await loadModule();
const grid = (block) => oemBytes({ blocks: [{ frame: 'TEMEOFDATE', ...block }] });
const request = (methodId, frames) => ({ methodId, inputs: frames.map((f) => ({ portId: f.portId, payloadHex: Buffer.from(f.payload).toString('hex'), typeRef: f.typeRef })) });
// An ISO time `seconds` after `epoch` ('YYYY-MM-DDTHH:MM:SS[.ffffff]', UTC), to the microsecond.
function isoPlus(epoch, seconds) {
  const [whole, fraction = ''] = epoch.replace(/Z$/, '').split('.');
  const micro = Date.parse(`${whole}Z`) * 1000 + Number(fraction.padEnd(6, '0').slice(0, 6)) + Math.round(seconds * 1e6);
  const date = new Date(Math.floor(micro / 1000));
  return `${date.toISOString().slice(0, 19)}.${String(((micro % 1e6) + 1e6) % 1e6).padStart(6, '0')}Z`;
}

const cases = [];
// ---- propagate: the battery of element sets of the reference comparison (tests/ussf_parity.test.mjs) ----
const sets = battery(10, 20261011);
for (const t of sets) {
  const fields = ommOfLines(t.lines, { name: `SET ${t.index}`, norad: 10000 + t.index });
  const start = `${fields.epoch}Z`;
  cases.push({ id: `propagate-${t.type === 4 ? 'xp' : 'sgp4'}-kind${t.kind}-teme`, request: request('propagate', [frame('omm', 'OMM', ommBytes(fields)), frame('grid', 'OEM', grid({ start, stop: isoPlus(fields.epoch, 7200), step: 600, data: [] }))]) });
}
{
  const t = sets.find((s) => s.type === 4 && s.kind === 0);
  const fields = ommOfLines(t.lines, { norad: 10000 + t.index });
  const g = oemBytes({ blocks: [{ frame: 'GCRF', start: `${fields.epoch}Z`, stop: isoPlus(fields.epoch, 3600), step: 300, data: [] }] });
  cases.push({ id: 'propagate-xp-gcrf', request: request('propagate', [frame('omm', 'OMM', ommBytes(fields)), frame('grid', 'OEM', g)]) });
  const explicit = oemBytes({ blocks: [{ frame: 'TEMEOFDATE', lines: [-3600, 0, 61.5, 86400, 259200].map((s) => ({ epoch: isoPlus(fields.epoch, s) })) }] });
  cases.push({ id: 'propagate-xp-explicit-epochs', request: request('propagate', [frame('omm', 'OMM', ommBytes(fields)), frame('omm', 'OMM', ommBytes(ommOfLines(sets[3].lines))), frame('grid', 'OEM', explicit)]) });
  cases.push({ id: 'propagate-default-grid', request: request('propagate', [frame('omm', 'OMM', ommBytes(fields))]) });
  cases.push({ id: 'ingest-omm', request: request('ingest_omm', [frame('omm', 'OMM', ommBytes(fields))]) });
  cases.push({ id: 'refused-ingest-omm-sgp4', request: request('ingest_omm', [frame('omm', 'OMM', ommBytes({ ...ommOfLines(sets[0].lines) }))]) });
  cases.push({ id: 'refused-propagate-itrf-grid', request: request('propagate', [frame('omm', 'OMM', ommBytes(fields)), frame('grid', 'OEM', oemBytes({ blocks: [{ frame: 'ITRF2000', start: `${fields.epoch}Z`, stop: isoPlus(fields.epoch, 600), step: 60, data: [] }] }))]) });
  // The SDK refuses a missing required port before the method runs: the exit class is the guest's error in every lane.
  cases.push({ id: 'refused-propagate-no-omm', expect: null, request: request('propagate', [frame('grid', 'OEM', grid({ start: `${fields.epoch}Z`, stop: isoPlus(fields.epoch, 600), step: 60, data: [] }))]) });
}

// ---- fit ----
const truth = { epoch: '2024-04-09T12:00:00.000000', meanMotion: 15.5, eccentricity: 0.0006317, inclination: 51.64, raan: 208.9163, argPerigee: 69.9862, meanAnomaly: 25.2906, bterm: 0.005, agom: 0.01, norad: 25544, name: 'ISS', id: '1998-067A' };
async function ephemerisOf(set, hours, stepSeconds, frameName = 'TEMEOFDATE') {
  const g = oemBytes({ blocks: [{ frame: frameName, start: `${set.epoch}Z`, stop: isoPlus(set.epoch, hours * 3600), step: stepSeconds, data: [] }] });
  const out = await local.invoke('propagate', [frame('omm', 'OMM', ommBytes(set)), frame('grid', 'OEM', g)]);
  return blockLines(readOem(out.ephemeris[0]).EPHEMERIS_DATA_BLOCK[0]);
}
const lines = await ephemerisOf(truth, 8, 300);
const object = { name: 'ISS', id: '1998-067A', norad: 25544 };
cases.push({ id: 'fit-xp-synthetic-8h', request: request('fit', [frame('ephemeris', 'OEM', oemBytes({ originator: 'SYNTHETIC', blocks: [{ frame: 'TEMEOFDATE', object, lines, start: lines[0].epoch, stop: lines.at(-1).epoch }] }))]) });
cases.push({ id: 'fit-xp-declared-interval-held-out', request: request('fit', [frame('ephemeris', 'OEM', oemBytes({ originator: 'SYNTHETIC', blocks: [{ frame: 'TEMEOFDATE', object, lines, start: lines[0].epoch, stop: lines.at(-1).epoch, useableStart: lines[0].epoch, useableStop: lines[60].epoch }] }))]) });
cases.push({ id: 'fit-xp-position-only-compact', request: request('fit', [frame('ephemeris', 'OEM', oemBytes({ originator: 'SYNTHETIC', blocks: [{ frame: 'TEMEOFDATE', object, data: lines.flatMap((l) => l.r), stateSize: 3, step: 300, start: lines[0].epoch, stop: lines.at(-1).epoch }] }))]) });
{
  const { header, blocks } = parseOemKvn(fs.readFileSync(fileURLToPath(new URL('../../../files/ccsds-messages/fixtures/real/nasa-iss.oem', import.meta.url)), 'utf8'));
  const b = blocks[0];
  const first = b.lines.slice(0, 91); // 6 h at 4 min
  cases.push({ id: 'fit-real-nasa-iss-eme2000-6h', request: request('fit', [frame('ephemeris', 'OEM', oemBytes({ originator: header.ORIGINATOR, creation: header.CREATION_DATE, blocks: [{ frame: sdsFrame(b.frame), object: { name: 'ISS', id: b.object.id, norad: 25544 }, lines: first, start: first[0].epoch, stop: first.at(-1).epoch, useableStart: first[0].epoch, useableStop: first[60].epoch }] }))]) });
  cases.push({ id: 'refused-fit-too-few-states', request: request('fit', [frame('ephemeris', 'OEM', oemBytes({ blocks: [{ frame: 'EME2000', lines: first.slice(0, 5) }] }))]) });
  cases.push({ id: 'refused-fit-leap-second', request: request('fit', [frame('ephemeris', 'OEM', oemBytes({ blocks: [{ frame: 'TEMEOFDATE', lines: lines.slice(0, 30).map((l, i) => ({ ...l, epoch: isoPlus('2016-12-31T22:00:00.000', i * 300) })) }] }))]) });
  cases.push({ id: 'refused-fit-unsupported-frame', request: request('fit', [frame('ephemeris', 'OEM', oemBytes({ blocks: [{ frame: 'B1950', lines: first }] }))]) });
}

const plan = await normalizeParityFixture({ name: 'propagator/sgp4-xp 0.1.0 methods', cases: cases.map((c) => ({ ...c, expect: c.expect === null ? undefined : 'ok' })) });
const report = await runParityHarness({ wasmPath, plan, timeoutMs: 1800000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(`${root}/conformance`, { recursive: true });
fs.writeFileSync(`${root}/conformance/parity.json`, `${JSON.stringify({ ...report, wasmPath: 'dist/isomorphic/module.wasm' }, null, 2)}\n`);
await local.destroy();
assert.equal(report.ok, true, JSON.stringify(report.failures));
