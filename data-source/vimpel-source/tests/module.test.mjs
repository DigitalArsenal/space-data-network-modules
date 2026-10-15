// The module through the SDK's browser harness. Expected values are the two-body relations of the osculating
// elements, never the module's own output: closed cases whose state follows from the geometry (a circular
// equatorial orbit at the synchronous radius, a circular polar orbit, perigee of an eccentric orbit), and for a
// general orbit the invariants every osculating orbit satisfies (radius, vis-viva speed, angular momentum and its
// direction, the eccentricity vector). The relations are textbook (Vallado, Fundamentals of Astrodynamics, ch. 2
// and 3) and used here as an oracle only; tolerance 1e-9 km and 1e-12 km/s covers binary64 rounding of
// the trigonometric rotation of a state of 4e4 km.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ByteBuffer } from 'flatbuffers';
import { OEM } from 'spacedatastandards.org/lib/js/OEM/OEM.js';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { decodeFlowNotice, decodeIngestRequest, encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { oilConflictShape, oilLinkStatus, unpackOil } from './fixtures/oil.mjs';
import { datefirst, ephemerisFile, objects, orbitTable } from './fixtures/vimpel-format.mjs';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
const standardsRoot = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const MU = 398600.4418; // km^3/s^2: the catalog paper's value

// Every method's one input: the HttpResponse hostcap/http-request answers, BODY the provider's file verbatim. An
// ephemeris file's name is the last segment of its URL.
const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };
const BASE = 'https://spacedata.vimpel.ru/data/';
const response = (value, { url = `${BASE}orbits.csv`, status = 200, error = '' } = {}) => ({ portId: 'response', typeRef: HRSP,
  payload: encodeHttpResponse({ url, status, error, headers: {}, body: new TextEncoder().encode(value), retrievedMs: Date.UTC(2026, 9, 14) }) });
const named = (name, value) => response(value, { url: `${BASE}ephemeris/${name}` });
async function harness(t) {
  const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  t.after(() => host.destroy());
  return host;
}
const frames = (result, port) => {
  assert.equal(result.statusCode, 0, result.errorMessage);
  return result.outputs.filter((f) => f.portId === port).map((f) => f.payload);
};
const oems = (result, port) => frames(result, port).map((bytes) => OEM.getRootAsOEM(new ByteBuffer(bytes)).unpack());
const meta = (result) => decodeIngestRequest(frames(result, 'report')[0]);
const attributes = (result) => meta(result).provenance.attributes.map((h) => [h.name, h.value]);
const attribute = (result, name) => attributes(result).find(([n]) => n === name)?.[1];
// Size-prefixed frames, as tests/fixtures/legacy holds the legacy artifact's outputs.
const prefixed = (payloads) => Buffer.concat(payloads.map((p) => { const n = Buffer.alloc(4); n.writeUInt32LE(p.length); return Buffer.concat([n, Buffer.from(p)]); }));
const legacy = (name) => fs.readFileSync(new URL(`./fixtures/legacy/${name}`, import.meta.url));
const circle = () => [0, 1, 2, 3, 4, 5].map((k) => [Number((7000 * Math.cos(k * Math.PI / 5)).toFixed(1)), Number((7000 * Math.sin(k * Math.PI / 5)).toFixed(1)), Number((10.1 * k).toFixed(1))]);
const line = (oem) => oem.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES[0];
const state = (oem) => { const l = line(oem); return [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT]; };
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
const vec = (a, b, tolerance, label) => a.forEach((x, k) => near(x, b[k], tolerance, `${label}[${k}]`));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.sqrt(dot(a, a));
const scale = (a, s) => a.map((x) => x * s);

test('the SDK artifact validates against the canonical standards', async () => {
  const result = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('normalize_orbits: the closed cases give the states their geometry fixes', async (t) => {
  const host = await harness(t);
  const result = await host.invoke({ methodId: 'normalize_orbits', inputs: [response(orbitTable([objects.geo, objects.polar, objects.perigee, objects.heo]))] });
  const states = oems(result, 'states');
  assert.equal(states.length, 4);
  const [geo, polar, perigee] = states;
  const vc = Math.sqrt(MU / 42164.2);
  vec(state(geo), [0, 42164.2, 0, -vc, 0, 0], 1e-9, 'geo');
  near(line(geo).X_DOT, -vc, 1e-12, 'geo speed');
  vec(state(polar), [7000, 0, 0, 0, 0, Math.sqrt(MU / 7000)], 1e-9, 'polar');
  // Perigee of a = 26000 km, e = 0.7: r = a(1 - e) on +x, speed sqrt(mu (1 + e) / (a (1 - e))) on +y (vis-viva).
  vec(state(perigee), [26000 * 0.3, 0, 0, 0, Math.sqrt((MU * 1.7) / (26000 * 0.3)), 0], 1e-9, 'perigee');
  near(state(perigee)[4], 9.3206467, 1e-6, 'the perigee speed, 9.3206467 km/s, worked by hand');
});

test('normalize_orbits: a general orbit satisfies the two-body invariants, and the object is named for what Vimpel says it is', async (t) => {
  const host = await harness(t);
  const heo = objects.heo;
  const table = orbitTable([heo]);
  const result = await host.invoke({ methodId: 'normalize_orbits', inputs: [response(table)] });
  const [oem] = oems(result, 'states');
  const s = state(oem);
  const r = s.slice(0, 3), v = s.slice(3);
  const d2r = Math.PI / 180;
  const nu = (((heo.u - heo.w) % 360) + 360) % 360 * d2r; // true anomaly = argument of latitude - argument of perigee
  const p = heo.a * (1 - heo.e ** 2);
  near(norm(r), p / (1 + heo.e * Math.cos(nu)), 1e-9, 'radius');
  near(dot(v, v), MU * (2 / norm(r) - 1 / heo.a), 1e-12, 'vis-viva');
  const h = cross(r, v);
  near(norm(h), Math.sqrt(MU * p), 1e-9, 'angular momentum');
  const i = heo.inc * d2r, O = heo.raan * d2r, w = heo.w * d2r;
  vec(scale(h, 1 / norm(h)), [Math.sin(i) * Math.sin(O), -Math.sin(i) * Math.cos(O), Math.cos(i)], 1e-12, 'orbit normal');
  // eccentricity vector: magnitude e, along the perigee direction the node and the argument of perigee fix
  const ev = scale(cross(v, h), 1 / MU).map((x, k) => x - r[k] / norm(r));
  near(norm(ev), heo.e, 1e-12, 'eccentricity');
  vec(scale(ev, 1 / norm(ev)), [Math.cos(O) * Math.cos(w) - Math.sin(O) * Math.cos(i) * Math.sin(w), Math.sin(O) * Math.cos(w) + Math.cos(O) * Math.cos(i) * Math.sin(w), Math.sin(i) * Math.sin(w)], 1e-12, 'perigee direction');
  // Identity, frame and time are the provider's, and nothing is invented.
  const block = oem.EPHEMERIS_DATA_BLOCK[0];
  assert.equal(block.OBJECT.OBJECT_NAME, 'vimpel:40004');
  assert.equal(block.OBJECT.CATALOG_URI, 'http://spacedata.vimpel.ru/');
  assert.equal(block.OBJECT.CATALOG_OBJECT_ID, '40004');
  assert.equal(block.OBJECT.NORAD_CAT_ID, 0);
  assert.equal(block.OBJECT.OBJECT_ID, null);
  assert.equal(block.CENTER_NAME, 'EARTH');
  assert.equal(block.REFERENCE_FRAME.NAME, 'J2000');
  assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME.frame, 2); // J2000
  assert.equal(block.TIME_SYSTEM, 11); // UTC
  assert.equal(line(oem).EPOCH, '2026-09-21T18:30:45.000000');
  assert.equal(oem.ORIGINATOR, 'JSC Vimpel');
  // The provider's other columns ride in the report as printed (the signed age, the area/mass ratio, the 50 % scalars).
  const sha = createHash('sha256').update(table).digest('hex');
  const m = meta(result);
  assert.equal(m.schema, 'OEM.fbs');
  assert.equal(m.tags.sourceName, 'vimpel');
  assert.equal(m.tags.batchId, sha);
  assert.equal(m.provenance.sourceSha256, sha);
  assert.equal(m.provenance.sourceUrl, `${BASE}orbits.csv`);
  assert.equal(Number(m.provenance.normalizedCount), 1);
  assert.equal(Number(attribute(result, 'muKm3PerS2')), MU);
  assert.equal(attribute(result, 'columns'), 'nativeId,epoch,firstObservation,daysSinceUpdate,areaToMassM2PerKg,magnitude,alongTrackTimingMinutes50,transversePositionKm50');
  assert.equal(attribute(result, 'object.1'), ['40004', '2026-09-21T18:30:45Z', '16072020', '-3', '3.89e-01', '18.8', '0.3', '54'].join(','));
});

test('normalize_orbits refuses a damaged table whole', async (t) => {
  const host = await harness(t);
  const good = orbitTable([objects.geo, objects.polar]);
  const rows = good.trim().split('\n');
  for (const [name, table] of [
    ['a duplicate object and epoch', `${good}${rows[0]}\n`],
    ['a retrograde inclination past 180 degrees', orbitTable([{ ...objects.geo, inc: 181 }])],
    ['an eccentricity of one', orbitTable([{ ...objects.geo, e: 1 }])],
    ['an impossible date', orbitTable([{ ...objects.geo, epoch: '31022026 000000' }])],
    ['fourteen columns', `${rows[0].split(',').slice(0, 14).join(',')}\n`],
    ['an orbit inside the Earth', orbitTable([{ ...objects.polar, a: 5000 }])],
    ['nothing', '\n'],
  ]) {
    const result = await host.invoke({ methodId: 'normalize_orbits', inputs: [response(table)] });
    assert.notEqual(result.statusCode, 0, name);
    assert.equal(result.outputs?.length ?? 0, 0, `${name}: partial output`);
  }
  assert.equal(oems(await host.invoke({ methodId: 'normalize_orbits', inputs: [response(good)] }), 'states').length, 2);
});

test('read_ephemeris: positions only, 600 s apart from the epoch in the file name, J2000 and UTC', async (t) => {
  const host = await harness(t);
  // Ten samples a revolution on a circle of 7000 km, as the printed one-decimal numbers.
  const positions = circle();
  const result = await host.invoke({ methodId: 'read_ephemeris', inputs: [named('000123_20260921_000000', ephemerisFile(positions))] });
  const [oem] = oems(result, 'ephemeris');
  const block = oem.EPHEMERIS_DATA_BLOCK[0];
  assert.equal(block.OBJECT.OBJECT_NAME, 'vimpel:123');
  assert.equal(block.OBJECT.CATALOG_OBJECT_ID, '123');
  assert.equal(block.START_TIME, '2026-09-21T00:00:00.000000');
  assert.equal(block.STOP_TIME, '2026-09-21T00:50:00.000000'); // five steps of 600 s
  assert.equal(block.STEP_SIZE, 600);
  assert.equal(block.STATE_VECTOR_SIZE, 3); // position only: no velocity is made of rounded positions
  assert.deepEqual(block.EPHEMERIS_DATA, positions.flat());
  assert.equal(block.REFERENCE_FRAME.REFERENCE_FRAME.frame, 2);
  assert.equal(block.TIME_SYSTEM, 11);
  assert.deepEqual(['samples', 'stepSeconds', 'nativeId', 'fileName'].map((n) => attribute(result, n)), ['6', '600', '123', '000123_20260921_000000']);
  assert.equal(meta(result).provenance.sourceSha256, createHash('sha256').update(ephemerisFile(positions)).digest('hex'));
  for (const [name, source, file] of [
    ['an index that is not the row number', ephemerisFile(positions).replace('3,', '9,'), '000123_20260921_000000'],
    ['a position inside the Earth', ephemerisFile([...positions.slice(0, 5), [10, 10, 10]]), '000123_20260921_000000'],
    ['fewer than five rows', ephemerisFile(positions.slice(0, 4)), '000123_20260921_000000'],
    ['a file name without an epoch', ephemerisFile(positions), '000123.txt'],
  ]) {
    const bad = await host.invoke({ methodId: 'read_ephemeris', inputs: [named(file, source)] });
    assert.notEqual(bad.statusCode, 0, name);
    assert.equal(bad.outputs?.length ?? 0, 0, `${name}: partial output`);
  }
});

test('read_datefirst: candidate links with their evidence, duplicates collapsed, aliases and conflicts marked and never bound', async (t) => {
  const host = await harness(t);
  const file = datefirst([
    ['10201', '20200716', 45952, '20200727'], // a clean one-to-one pair
    ['10201', '20200716', 45952, '20200727'], // the same declaration again
    ['10400', '20200524', 45932, '20200722'], // one Vimpel number declared against two NORAD numbers
    ['10400', '20200524', 45933, '20200723'],
    ['10901', '20200720', 45924, '20200722'], // one NORAD number declared against two Vimpel numbers
    ['10902', '20200721', 45924, '20200722'],
    ['11000', '20200101', 40001, '20200102'], // a clean pair whose second declaration carries other dates
    ['11000', '20200105', 40001, '20200106'],
    ['11100', '20209511', 40002, '20200629'], // a pairing whose date is not a calendar date (as the provider's own file has): the pair stays, the date is not made up
  ]);
  const result = await host.invoke({ methodId: 'read_datefirst', inputs: [response(file, { url: `${BASE}datefirst.txt` })] });
  const [bytes] = frames(result, 'crosswalk');
  assert.equal(new TextDecoder().decode(bytes.subarray(4, 8)), '$OIL');
  const oil = unpackOil(bytes);
  const sha = createHash('sha256').update(file).digest('hex');
  assert.deepEqual([oil.PROVIDER, oil.KIND, oil.LEFT_NAMESPACE, oil.RIGHT_NAMESPACE, oil.HEADER, oil.SHA256, Number(oil.BYTES)],
    ['vimpel', 'datefirst', 'vimpel', 'NORAD', 'Nvym t_det_v Nnor t_det_n', sha, Buffer.byteLength(file)]);
  assert.deepEqual([oil.LINK_COUNT, oil.CLEAN_COUNT, oil.AMBIGUOUS_COUNT, oil.LEFT_ID_COUNT, oil.RIGHT_ID_COUNT, oil.DATES_DIFFER_COUNT, oil.UNREADABLE_DATE_COUNT], [7, 3, 4, 6, 6, 1, 1]);
  assert.equal(oil.ROWS, 9);
  assert.equal(oil.DUPLICATE_LINES, 2);
  assert.equal(Number(oil.GENERATED_AT_MS), 0, 'nothing in the output depends on when it was made');
  const link = (v, n) => oil.LINKS.find((l) => l.LEFT.ID === String(v) && l.RIGHT.NORAD_CAT_ID === n);
  const l = link(10201, 45952);
  assert.deepEqual([l.LEFT.NAMESPACE, l.LEFT.ID, l.LEFT.ID_AS_PRINTED, l.LEFT.FIRST_DETECTED, l.RIGHT.NAMESPACE, l.RIGHT.ID, l.RIGHT.ID_AS_PRINTED, l.RIGHT.FIRST_DETECTED],
    ['vimpel', '10201', '010201', '2020-07-16', 'NORAD', '45952', null, '2020-07-27']);
  assert.deepEqual([l.STATUS, l.AMBIGUOUS, l.EVIDENCE.SOURCE, l.EVIDENCE.RECORD_ID, l.EVIDENCE.LINE, l.EVIDENCE.DECLARATIONS, l.EVIDENCE.DATES_DIFFER],
    [oilLinkStatus.Candidate, false, 'datefirst', sha, 2, 2, false], 'line 2: the first row after the header');
  assert.equal(link(10400, 45932).AMBIGUOUS, true);
  assert.equal(link(10400, 45933).AMBIGUOUS, true);
  assert.equal(link(10901, 45924).AMBIGUOUS, true);
  assert.equal(link(10902, 45924).AMBIGUOUS, true);
  assert.equal(link(11000, 40001).AMBIGUOUS, false);
  assert.equal(link(11000, 40001).EVIDENCE.DATES_DIFFER, true);
  const odd = link(11100, 40002);
  assert.deepEqual([odd.LEFT.FIRST_DETECTED, odd.LEFT.FIRST_DETECTED_AS_PRINTED, odd.RIGHT.FIRST_DETECTED, odd.RIGHT.FIRST_DETECTED_AS_PRINTED], [null, '20209511', '2020-06-29', null]);
  assert.ok(oil.LINKS.every((x) => x.STATUS === oilLinkStatus.Candidate), 'a datefirst row proposes a link; it does not prove one');
  const conflicts = oil.CONFLICTS.map((c) => [c.LEFT_IDS, c.RIGHT_IDS, c.SHAPE, c.REASON]).sort((x, y) => x[3].localeCompare(y[3]));
  assert.deepEqual(conflicts, [
    [['vimpel:10901', 'vimpel:10902'], ['NORAD:45924'], oilConflictShape.ManyLeftOneRight, 'one NORAD number is declared against several Vimpel numbers'],
    [['vimpel:10400'], ['NORAD:45932', 'NORAD:45933'], oilConflictShape.OneLeftManyRight, 'one Vimpel number is declared against several NORAD numbers'],
  ]);
  for (const [name, bad] of [['no header', '010201 20200716 45952 20200727\n'], ['a short row', ' Nvym  t_det_v  Nnor  t_det_n  \n010201 20200716 45952\n'],
    ['a date that is not eight digits', ' Nvym  t_det_v  Nnor  t_det_n  \n010201 2020071 45952 20200727\n'], ['a zero NORAD number', ' Nvym  t_det_v  Nnor  t_det_n  \n010201 20200716 0 20200727\n'], ['no rows', ' Nvym  t_det_v  Nnor  t_det_n  \n']]) {
    const refused = await host.invoke({ methodId: 'read_datefirst', inputs: [response(bad)] });
    assert.notEqual(refused.statusCode, 0, name);
    assert.equal(refused.outputs?.length ?? 0, 0, `${name}: partial output`);
  }
});

test('the $OEM records are byte-identical to the legacy (untyped) artifact\'s on the fixtures', async (t) => {
  const host = await harness(t);
  const orbits = await host.invoke({ methodId: 'normalize_orbits', inputs: [response(orbitTable(Object.values(objects)))] });
  assert.deepEqual(prefixed(frames(orbits, 'states')), legacy('orbits-states.bin'));
  const eph = await host.invoke({ methodId: 'read_ephemeris', inputs: [named('000123_20260921_000000', ephemerisFile(circle()))] });
  assert.deepEqual(prefixed(frames(eph, 'ephemeris')), legacy('ephemeris.bin'));
});

test('a 304 is one FlowNotice Unchanged and nothing else; another status, a transport error or a frame that is not an HttpResponse refuses the call', async (t) => {
  const host = await harness(t);
  for (const [methodId, schema] of [['normalize_orbits', 'OEM.fbs'], ['read_ephemeris', 'OEM.fbs'], ['read_datefirst', 'OIL.fbs']]) {
    const result = await host.invoke({ methodId, inputs: [response('', { status: 304, url: `${BASE}x` })] });
    assert.equal(result.statusCode, 0, result.errorMessage);
    assert.deepEqual(result.outputs.map((f) => f.portId), ['unchanged'], methodId);
    const n = decodeFlowNotice(result.outputs[0].payload);
    assert.deepEqual([n.schema, n.sourceName, n.reason, n.items], [schema, 'vimpel', 'not-modified', [`${BASE}x`]]);
    for (const input of [response(orbitTable([objects.geo]), { status: 500 }), response(orbitTable([objects.geo]), { status: 200, error: 'connection reset' })]) {
      const bad = await host.invoke({ methodId, inputs: [input] });
      assert.equal(bad.errorCode, 'fetch-failed', methodId);
      assert.equal(bad.outputs?.length ?? 0, 0);
    }
    const payload = new TextEncoder().encode(orbitTable([objects.geo]));
    const wrong = await host.invoke({ methodId, inputs: [{ portId: 'response', payload, typeRef: { ...HRSP } }] });
    assert.notEqual(wrong.statusCode, 0, `${methodId}: a frame that is not an HttpResponse is refused`);
  }
});
