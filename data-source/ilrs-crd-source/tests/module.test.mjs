// The module through the SDK's browser harness. A real file: the first two passes of the ILRS daily LAGEOS-1 normal points of
// 2026-10-08 (EDC; ILRS data are not copyrighted, citation requested; PROVENANCE.md). Expected values are the numbers printed
// in it and arithmetic worked by hand: a one-way range is c x time of flight / 2 with c = 299,792,458 m/s exactly, so a
// time of flight of 0.04 s is 5,995,849.16 m and of 0.048792077262 s is 7,313,748.386650445 m (Decimal arithmetic), and the
// frequency of 532 nm light is c / 532e-9 = 563,519,657,894,736.8 Hz. Synthetic passes cover what a real day does not hold.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ByteBuffer } from 'flatbuffers';
import { TDM } from 'spacedatastandards.org/lib/js/TDM/TDM.js';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { crdFile, pass } from './fixtures/crd-format.mjs';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
const standardsRoot = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const real = fs.readFileSync(fileURLToPath(new URL('./fixtures/lageos1_20261008.first-two-passes.np2', import.meta.url)));

const request = (payload) => ({ methodId: 'read_crd', inputs: [{ portId: 'source', payload, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length } }] });
const text = (value) => request(new TextEncoder().encode(value));
async function harness(t) {
  const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  t.after(() => host.destroy());
  return host;
}
const tdms = (result) => {
  assert.equal(result.statusCode, 0, result.errorMessage);
  return result.outputs.filter((f) => f.portId === 'observations').map((f) => TDM.getRootAsTDM(new ByteBuffer(f.payload)).unpack());
};
const report = (result) => JSON.parse(new TextDecoder().decode(result.outputs.find((f) => f.portId === 'report').payload));
const ranges = (segment) => segment.OBSERVATIONS.filter((o) => o.KEYWORD === 'LASER_RANGE');
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

test('the SDK artifact validates against the canonical standards', async () => {
  const result = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('the real ILRS file: one TDM per pass, the printed times of flight as one-way ranges, UTC epochs to the digit, the pass\'s meteorology', async (t) => {
  const host = await harness(t);
  const result = await host.invoke(request(real));
  const [svel, tkbl] = tdms(result);
  assert.equal(svel.OBSERVER_ID, '18889801'); // CDP pad 1888, system 98, occupancy 01
  assert.equal(svel.ORIGINATOR, 'SVEL (ILRS)');
  assert.equal(svel.CREATION_DATE, '2026-10-08T21:00:00');
  assert.equal(svel.SEGMENTS.length, 1);
  const s = svel.SEGMENTS[0];
  assert.deepEqual([s.TIME_SYSTEM, s.PARTICIPANT_1, s.PARTICIPANT_2, s.MODE, s.PATH, s.TIMETAG_REF, s.DATA_QUALITY], ['UTC', 'SVEL', 'lageos1', 'SINGLE_TRACK', '1,2,1', 'TRANSMIT', 'VALIDATED']);
  assert.equal(ranges(s).length, 9);
  // time of flight 0.048792077262 s at 1524.299049040001 s of day: 00:25:24.299049040 UTC
  assert.deepEqual([ranges(s)[0].EPOCH, ranges(s)[0].KEYWORD], ['2026-10-08T00:25:24.299049040', 'LASER_RANGE']);
  near(ranges(s)[0].VALUE, 7313748.386650445, 1e-6, 'first range');
  near(ranges(s)[1].VALUE, 7122058.523381389, 1e-6, 'second range'); // 0.047513260146 s
  assert.equal(s.START_TIME, ranges(s)[0].EPOCH);
  assert.equal(s.STOP_TIME, ranges(s).at(-1).EPOCH);
  // the meteorological record "20 1502.845 1008.48 275.65 99 0": 00:25:02.845 UTC, hPa, K, %
  const met = s.OBSERVATIONS.filter((o) => o.KEYWORD !== 'LASER_RANGE');
  assert.deepEqual(met.map((o) => [o.KEYWORD, o.EPOCH, o.VALUE]), [['PRESSURE', '2026-10-08T00:25:02.845000000', 1008.48], ['TEMPERATURE', '2026-10-08T00:25:02.845000000', 275.65], ['RHUMIDITY', '2026-10-08T00:25:02.845000000', 99]]);
  near(s.TRANSMIT_FREQ_1, 563519657894736.8, 1e-3, '532 nm as a frequency');
  assert.match(s.COMMENT.join('\n'), /CDP pad 1888 system 98 occupancy 01.*target lageos1 ILRS id 7603901 NORAD 08820.*wavelength 532000 pm/s);
  assert.match(s.COMMENT.join('\n'), /tropospheric refraction applied: no, centre of mass applied: no/);
  // the second pass: another station, its own meteorology (six records)
  assert.equal(tkbl.OBSERVER_ID, '73069301'); // pad 7306, system 93, occupancy 1 written 01
  assert.equal(ranges(tkbl.SEGMENTS[0]).length, 6);
  assert.equal(tkbl.SEGMENTS[0].OBSERVATIONS.length, 6 + 6 * 3);
  const r = report(result);
  assert.deepEqual({ sessions: r.sessions, passes: r.passesRead, inFile: r.normalPointsInFile, read: r.normalPointsRead, met: r.meteorologicalRecords, skipped: r.sessionsSkipped },
    { sessions: 2, passes: 2, inFile: 15, read: 15, met: 7, skipped: {} });
  assert.deepEqual(r.normalPoints[0], ['SVEL/lageos1/2026-10-08T00:25:02', '2026-10-08T00:25:24.299049040', '0.048792077262', 34, 85.5, 120, 'std']);
});

test('synthetic passes: a time of day before the pass\'s start is the next day, the epoch event is the time-tag reference, two configurations are two segments', async (t) => {
  const host = await harness(t);
  const across = pass({ start: [2026, 10, 11, 23, 58, 0], points: [{ sod: '86300.500000000000', tof: '0.04' }, { sod: '30.250000000000', tof: '0.04' }] });
  const receive = pass({ station: { name: 'RCV1' }, points: [{ sod: '100.000000000001', tof: '0.04', event: 0 }] });
  const two = pass({ station: { name: 'TWO1', pad: '7777' }, configs: [{ id: 'g532', nm: '532.000' }, { id: 'ir', nm: '1064.000' }],
    points: [{ sod: '200.5', tof: '0.04', cfg: 'g532' }, { sod: '201.5', tof: '0.04', cfg: 'ir' }, { sod: '202.5', tof: '0.04', cfg: 'g532' }] });
  const result = await host.invoke(text(crdFile([across, receive, two])));
  const [a, b, c] = tdms(result);
  // 0.04 s of two-way flight is 0.04 x 299792458 / 2 = 5,995,849.16 m
  assert.deepEqual(ranges(a.SEGMENTS[0]).map((o) => o.EPOCH), ['2026-10-11T23:58:20.500000000', '2026-10-12T00:00:30.250000000'], 'seconds of day wrap to the next UTC day');
  near(ranges(a.SEGMENTS[0])[0].VALUE, 5995849.16, 1e-6, 'range of 0.04 s');
  assert.equal(a.SEGMENTS[0].TIMETAG_REF, 'TRANSMIT');
  assert.equal(b.SEGMENTS[0].TIMETAG_REF, 'RECEIVE', 'epoch event 0 is the ground receive time');
  assert.equal(ranges(b.SEGMENTS[0])[0].EPOCH, '2026-10-11T00:01:40.000000000'); // 100.000000000001 s: nine digits kept
  assert.equal(c.SEGMENTS.length, 2);
  assert.deepEqual(c.SEGMENTS.map((s) => ranges(s).length), [2, 1]);
  near(c.SEGMENTS[0].TRANSMIT_FREQ_1, 563519657894736.8, 1e-3, '532 nm');
  near(c.SEGMENTS[1].TRANSMIT_FREQ_1, 281759828947368.4, 1e-3, '1064 nm');
  assert.equal(c.OBSERVER_ID, '77770101');
});

test('passes that are not two-way normal points on a UTC station clock are not read, and the file says why', async (t) => {
  const host = await harness(t);
  const good = pass({ station: { name: 'GOOD' }, points: [{ sod: '10.0', tof: '0.04' }] });
  const skipped = [
    pass({ station: { name: 'FULL' }, dataType: 0, points: [{ sod: '10.0', tof: '0.04' }] }),
    pass({ station: { name: 'ONEW' }, rangeType: 1, points: [{ sod: '10.0', tof: '0.04' }] }),
    pass({ station: { name: 'LOCL', scale: 12 }, points: [{ sod: '10.0', tof: '0.04' }] }),
    pass({ station: { name: 'BNCE' }, points: [{ sod: '10.0', tof: '0.04', event: 1 }] }),
    pass({ station: { name: 'POOR' }, quality: 2, points: [{ sod: '10.0', tof: '0.04' }] }),
    pass({ station: { name: 'NODL' }, stationDelay: 0, points: [{ sod: '10.0', tof: '0.04' }] }),
  ];
  const result = await host.invoke(text(crdFile([...skipped, good])));
  const read = tdms(result);
  assert.equal(read.length, 1);
  assert.equal(read[0].SEGMENTS[0].PARTICIPANT_1, 'GOOD');
  assert.deepEqual(report(result).sessionsSkipped, {
    'not a normal point session (full rate or sampled engineering)': 1,
    'not two-way ranging': 1,
    'station time scale is not UTC (CRD 3, 4 or 7)': 1,
    'epoch event is not ground transmit (2) or ground receive (0)': 1,
    'poor or unknown data quality': 1,
    'station system delay not applied': 1,
  });
  // a suspect pass is read and says so
  const suspect = tdms(await host.invoke(text(crdFile([pass({ quality: 1, points: [{ sod: '10.0', tof: '0.04' }] })]))));
  assert.equal(suspect[0].SEGMENTS[0].DATA_QUALITY, 'DEGRADED');
});

test('a damaged file is refused whole: no partial output', async (t) => {
  const host = await harness(t);
  const ok = crdFile([pass({ points: [{ sod: '10.0', tof: '0.04' }] })]);
  for (const [name, bad] of [['truncated (no H9)', crdFile([pass({ points: [{ sod: '10.0', tof: '0.04' }] })], { eof: false })], ['CRD version 1', crdFile([pass({ points: [{ sod: '10.0', tof: '0.04' }] })], { version: 1 })],
    ['not CRD', 'Date,Range\n2026-10-11,5995849\n'], ['no format header', ok.replace(/^H1.*\n/, '')], ['records after H9', `${ok}11 5.0 0.04 std 2 120.0 5 100.0 0.1 -0.5 na na 0 na\n`],
    ['a normal point without a time of flight', ok.replace('0.04 std', 'na std')], ['no readable pass', crdFile([pass({ rangeType: 1, points: [{ sod: '10.0', tof: '0.04' }] })])]]) {
    const refused = await host.invoke(text(bad));
    assert.notEqual(refused.statusCode, 0, name);
    assert.equal(refused.outputs?.length ?? 0, 0, `${name}: partial output`);
  }
  assert.equal(tdms(await host.invoke(text(ok))).length, 1);
});
