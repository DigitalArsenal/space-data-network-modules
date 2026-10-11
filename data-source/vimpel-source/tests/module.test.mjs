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
import { datefirst, ephemerisFile, objects, orbitTable } from './fixtures/vimpel-format.mjs';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
const standardsRoot = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const MU = 398600.4418; // km^3/s^2: the catalog paper's value

const text = (portId, value) => {
  const payload = new TextEncoder().encode(value);
  return { portId, payload, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length } };
};
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
const json = (result, port) => JSON.parse(new TextDecoder().decode(frames(result, port)[0]));
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
  const result = await host.invoke({ methodId: 'normalize_orbits', inputs: [text('source', orbitTable([objects.geo, objects.polar, objects.perigee, objects.heo]))] });
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
  const result = await host.invoke({ methodId: 'normalize_orbits', inputs: [text('source', table)] });
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
  const report = json(result, 'report');
  assert.equal(report.sha256, createHash('sha256').update(table).digest('hex'));
  assert.equal(report.muKm3PerS2, MU);
  assert.deepEqual(report.objects[0], ['40004', '2026-09-21T18:30:45Z', '16072020', '-3', '3.89e-01', '18.8', '0.3', '54']);
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
    const result = await host.invoke({ methodId: 'normalize_orbits', inputs: [text('source', table)] });
    assert.notEqual(result.statusCode, 0, name);
    assert.equal(result.outputs?.length ?? 0, 0, `${name}: partial output`);
  }
  assert.equal(oems(await host.invoke({ methodId: 'normalize_orbits', inputs: [text('source', good)] }), 'states').length, 2);
});

test('read_ephemeris: positions only, 600 s apart from the epoch in the file name, J2000 and UTC', async (t) => {
  const host = await harness(t);
  // Ten samples a revolution on a circle of 7000 km, as the printed one-decimal numbers.
  const positions = [0, 1, 2, 3, 4, 5].map((k) => [Number((7000 * Math.cos(k * Math.PI / 5)).toFixed(1)), Number((7000 * Math.sin(k * Math.PI / 5)).toFixed(1)), Number((10.1 * k).toFixed(1))]);
  const result = await host.invoke({ methodId: 'read_ephemeris', inputs: [text('name', '000123_20260921_000000'), text('source', ephemerisFile(positions))] });
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
  const report = json(result, 'report');
  assert.deepEqual({ samples: report.samples, stepSeconds: report.stepSeconds, nativeId: report.nativeId }, { samples: 6, stepSeconds: 600, nativeId: '123' });
  for (const [name, source, file] of [
    ['an index that is not the row number', ephemerisFile(positions).replace('3,', '9,'), '000123_20260921_000000'],
    ['a position inside the Earth', ephemerisFile([...positions.slice(0, 5), [10, 10, 10]]), '000123_20260921_000000'],
    ['fewer than five rows', ephemerisFile(positions.slice(0, 4)), '000123_20260921_000000'],
    ['a file name without an epoch', ephemerisFile(positions), '000123.txt'],
  ]) {
    const bad = await host.invoke({ methodId: 'read_ephemeris', inputs: [text('name', file), text('source', source)] });
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
  const result = await host.invoke({ methodId: 'read_datefirst', inputs: [text('source', file)] });
  const crosswalk = json(result, 'crosswalk');
  const sha = createHash('sha256').update(file).digest('hex');
  assert.equal(crosswalk.status, 'candidate');
  assert.equal(crosswalk.sha256, sha);
  assert.deepEqual(crosswalk.counts, { links: 7, clean: 3, ambiguous: 4, vimpelNumbers: 6, noradNumbers: 6, datesDiffer: 1, unreadableDates: 1 });
  assert.equal(crosswalk.rows, 9);
  assert.equal(crosswalk.duplicateLines, 2);
  const link = (v, n) => crosswalk.links.find((l) => l.native === `vimpel:${v}` && l.object.norad === n);
  assert.deepEqual(link(10201, 45952), { native: 'vimpel:10201', nativeId: '010201', object: { norad: 45952 }, firstDetectedVimpel: '2020-07-16', firstDetectedNorad: '2020-07-27', declarations: 2,
    status: 'candidate', ambiguous: false, evidence: { source: 'datefirst', recordId: sha } });
  assert.equal(link(10400, 45932).ambiguous, true);
  assert.equal(link(10400, 45933).ambiguous, true);
  assert.equal(link(10901, 45924).ambiguous, true);
  assert.equal(link(10902, 45924).ambiguous, true);
  assert.equal(link(11000, 40001).ambiguous, false);
  assert.equal(link(11000, 40001).datesDiffer, true);
  assert.deepEqual([link(11100, 40002).firstDetectedVimpel, link(11100, 40002).firstDetectedNorad, link(11100, 40002).datesAsPrinted], [null, '2020-06-29', ['20209511', '20200629']]);
  assert.ok(crosswalk.links.every((l) => l.status === 'candidate'), 'a datefirst row proposes a link; it does not prove one');
  assert.deepEqual(crosswalk.conflicts.map((c) => c.reason).sort(), ['one NORAD number is declared against several Vimpel numbers', 'one Vimpel number is declared against several NORAD numbers']);
  for (const [name, bad] of [['no header', '010201 20200716 45952 20200727\n'], ['a short row', ' Nvym  t_det_v  Nnor  t_det_n  \n010201 20200716 45952\n'],
    ['a date that is not eight digits', ' Nvym  t_det_v  Nnor  t_det_n  \n010201 2020071 45952 20200727\n'], ['a zero NORAD number', ' Nvym  t_det_v  Nnor  t_det_n  \n010201 20200716 0 20200727\n'], ['no rows', ' Nvym  t_det_v  Nnor  t_det_n  \n']]) {
    const refused = await host.invoke({ methodId: 'read_datefirst', inputs: [text('source', bad)] });
    assert.notEqual(refused.statusCode, 0, name);
    assert.equal(refused.outputs?.length ?? 0, 0, `${name}: partial output`);
  }
});
