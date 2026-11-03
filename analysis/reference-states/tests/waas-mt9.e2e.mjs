// GEO truth from the WAAS MT9 broadcast (modules-reference-states-waas-mt9-20261103).
//
//   node analysis/reference-states/tests/waas-mt9.e2e.mjs
//
// Registered before the reader exists. The archived CDDIS SBAS file of 2026-10-01 (/opt/data/sdn-archive/hac/cddis-sbas/
// 2026/274.json: RINEX navigation records of PRN 131, 133, 135 as {prn, gpsMs, r (km, Earth-fixed), v (km/s), ura (m), health})
// goes to `sbas_reference_states` as one $FIL with the IERS finals2000A observed rows around it. Nothing is fetched.
//
// Checks, each a number: the three PRNs convert, one state per record at the record's time of applicability (GPS time
// minus 18 s); the GCRF positions rotated back to Earth-fixed by foundation/frames reproduce the records within 1 mm; the
// GCRF velocity agrees with the 9-point derivative of the GCRF positions within 1 mm/s; the covariance is the record's URA
// as a protection bound (a position sigma equal to it on every axis, and the comment says it is a bound, not a realized
// error); the comment states the source file's SHA-256; a PRN absent from the file gives no state and the named reason
// `prn-absent`; a PRN whose records sit off its slot gives no state and `slot-mismatch`; the output is a verifiable $OEM
// with a covariance line per state; the existing SP3 conversions are byte-identical (tests/fetch-offline.e2e.mjs).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { decodeFlowNotice } from 'space-data-module-sdk/runtime-contracts';
import * as flatbuffers from 'flatbuffers';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const modules = path.resolve(root, '../..');
const standards = path.dirname(createRequire(path.join(root, 'package.json')).resolve('spacedatastandards.org/package.json'));
process.env.SPACE_DATA_STANDARDS_ROOT = standards;
const lib = (code) => import(pathToFileURL(path.join(standards, `lib/js/${code}/main.js`)).href);
const [OEM, EOP, FRM] = await Promise.all([lib('OEM'), lib('EOP'), lib('FRM')]);
const { body } = await import(pathToFileURL(path.join(modules, 'data-source/eop-parser/tests/frames.mjs')).href);

const SBAS = '/opt/data/sdn-archive/hac/cddis-sbas/2026/274.json';
const FINALS = '/opt/data/sdn-archive/reference-states/products/finals2000A.all';
// PRN -> the satellite it is broadcast from, by the nominal slot the records sit at (131: 116.8 W, 133: 129 W, 135: 125 W).
const SATELLITES = { 131: { norad: 41589, name: 'EUTE 117W B', slot: -116.8 }, 133: { norad: 42709, name: 'SES 15', slot: -129 }, 135: { norad: 46114, name: 'GALAXY 30', slot: -125 } };
const GPS_UTC_S = 18;  // GPS time minus UTC in 2026

const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' });
const harness = async (dir, manifest = true) => createBrowserModuleHarness({
  wasmSource: fs.readFileSync(path.join(modules, dir, 'dist/isomorphic/module.wasm')), surface: 'direct',
  ...(manifest ? { manifest: JSON.parse(fs.readFileSync(path.join(modules, dir, 'plugin-manifest.json'))) } : {}) });

// ── inputs: the file, and the observed finals2000A rows around it through eop-parser ──
const fileBytes = fs.readFileSync(SBAS);
const file = JSON.parse(fileBytes);
const lines = fs.readFileSync(FINALS, 'latin1').split('\n');
let lastObserved = -1;
lines.forEach((l, i) => { if (l[16] === 'I' && l[57] === 'I') lastObserved = i; });
const finals = Buffer.from(`${lines.slice(0, lastObserved + 1).join('\n')}\n`);
const parser = await harness('data-source/eop-parser');
const parsed = await parser.invoke({ methodId: 'parse_finals2000a', inputs: [body(finals)] });
assert.equal(parsed.statusCode, 0, parsed.errorMessage);
const stream = Buffer.from(parsed.outputs.find((o) => o.portId === 'records').payload);
const day0 = Math.floor(file.records[0].gpsMs / 86400000) + 40587;  // MJD of the file's first record
const rows = [];
for (let at = 0; at < stream.length;) {
  const n = stream.readUInt32LE(at), bytes = stream.subarray(at, at + 4 + n);
  const mjd = EOP.EOP.getRootAsEOP(new flatbuffers.ByteBuffer(new Uint8Array(bytes.subarray(4)))).MJD();
  if (mjd >= day0 - 1 && mjd <= day0 + 2) rows.push(bytes);
  at += 4 + n;
}
assert.ok(rows.length >= 3, 'EOP rows bracket the file');
const earthOrientation = { portId: 'earth_orientation', payload: Buffer.concat(rows), typeRef: typeRef('EOP') };
parser.destroy();

const reader = await harness('analysis/reference-states');
async function convert(bytes) {
  const r = await reader.invoke({ methodId: 'sbas_reference_states', inputs: [body(bytes), earthOrientation] });
  assert.equal(r.statusCode, 0, r.errorMessage);
  const states = r.outputs.filter((o) => o.portId === 'reference')
    .map((o) => OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(o.payload))).unpack().EPHEMERIS_DATA_BLOCK[0]);
  const notices = r.outputs.filter((o) => o.portId === 'notice').map((o) => decodeFlowNotice(o.payload));
  return { states, notices };
}

const { states, notices } = await convert(fileBytes);
const byPrn = new Map(states.map((b) => [Object.entries(SATELLITES).find(([, s]) => s.norad === b.OBJECT.NORAD_CAT_ID)?.[0], b]));
assert.deepEqual([...byPrn.keys()].sort(), ['131', '133', '135'], 'one block per PRN');
assert.equal(notices.length, 0, 'nothing is missing from the 2026-10-01 file');

// ── time of applicability, per record ──
const records = (prn) => file.records.filter((r) => r.prn === prn);
for (const [prn, block] of byPrn) {
  const want = records(Number(prn));
  const got = block.EPHEMERIS_DATA_LINES;
  assert.equal(got.length, want.length, `PRN ${prn}: one state per record`);
  got.forEach((l, i) => assert.equal(l.EPOCH, new Date(want[i].gpsMs - GPS_UTC_S * 1000).toISOString().replace('Z', '000Z'), `PRN ${prn} record ${i}: time of applicability`));
  assert.equal(block.OBJECT.OBJECT_NAME, SATELLITES[prn].name);
}
console.log(`time of applicability: ${[...byPrn].map(([p, b]) => `PRN ${p} ${b.EPHEMERIS_DATA_LINES.length} states`).join(', ')}`);

// ── positions back to Earth-fixed with foundation/frames, velocity against the 9-point derivative ──
const frames = await harness('foundation/frames', false);
const sys = (name, axisType) => new FRM.RFMCoordinateSystemT(name, axisType, new FRM.RFMOriginT(FRM.rfmOriginKind.CELESTIAL_BODY, 399), 399, '2026-10-01T00:00:00Z', 'UTC', null);
async function toEarthFixed(l) {
  const epoch = l.EPOCH.replace(/\.\d+Z$/, 'Z');
  const sourceState = new FRM.FRMStateVectorT(FRM.frmStateRepresentation.CARTESIAN, [l.X * 1e3, l.Y * 1e3, l.Z * 1e3, l.X_DOT * 1e3, l.Y_DOT * 1e3, l.Z_DOT * 1e3],
    new FRM.FRMVector3T(l.X * 1e3, l.Y * 1e3, l.Z * 1e3), new FRM.FRMVector3T(l.X_DOT * 1e3, l.Y_DOT * 1e3, l.Z_DOT * 1e3), 'ICRF', epoch, 'UTC', 3.986004418e14);
  const request = new FRM.FRMFrameTransformRequestT(FRM.frmOperationCode.STATE_TRANSFORM, null, null, 0, 0, null, sys('ICRF', FRM.rfmAxisType.ICRF), sys('ITRF', FRM.rfmAxisType.BODY_FIXED),
    sourceState, FRM.frmStateRepresentation.CARTESIAN, epoch, 'UTC', null);
  const b = new flatbuffers.Builder(4096);
  FRM.FRM.finishFRMBuffer(b, new FRM.FRMT(request, null).pack(b));
  const r = await frames.invoke({ methodId: 'transform_frame_position', inputs: [{ portId: 'request', payload: b.asUint8Array(), typeRef: typeRef('FRM') }, earthOrientation] });
  assert.equal(r.statusCode, 0, r.errorMessage);
  const s = FRM.FRM.getRootAsFRM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).FRAME_TRANSFORM_RESULT().TARGET_STATE();
  return [s.POSITION().X(), s.POSITION().Y(), s.POSITION().Z()];
}
let worstPosition = 0, worstVelocity = 0, velocityCount = 0;
const D9 = [1 / 280, -4 / 105, 1 / 5, -4 / 5, 0, 4 / 5, -1 / 5, 4 / 105, -1 / 280];  // 9-point central difference, per step
for (const [prn, block] of byPrn) {
  const want = records(Number(prn)), got = block.EPHEMERIS_DATA_LINES;
  for (let i = 0; i < got.length; i += 1) {
    const back = await toEarthFixed(got[i]);
    worstPosition = Math.max(worstPosition, Math.hypot(...back.map((x, k) => x - want[i].r[k] * 1e3)));
  }
  for (let i = 4; i < got.length - 4; i += 1) {
    if (want[i + 4].gpsMs - want[i - 4].gpsMs !== 8 * 256000) continue;  // a gap in the records
    const d = [0, 0, 0];
    D9.forEach((c, k) => { const l = got[i - 4 + k]; d[0] += c * l.X; d[1] += c * l.Y; d[2] += c * l.Z; });
    const dv = Math.hypot(d[0] / 256 - got[i].X_DOT, d[1] / 256 - got[i].Y_DOT, d[2] / 256 - got[i].Z_DOT) * 1e3;
    worstVelocity = Math.max(worstVelocity, dv);
    velocityCount += 1;
  }
}
frames.destroy();
console.log(`position: worst ${worstPosition.toExponential(3)} m after the inverse rotation; velocity: worst ${worstVelocity.toExponential(3)} m/s against the 9-point derivative (${velocityCount} epochs)`);
assert.ok(worstPosition <= 1e-3, `positions differ by ${worstPosition} m`);
assert.ok(worstVelocity <= 1e-3, `velocities differ by ${worstVelocity} m/s`);

// ── the URA as a protection bound ──
for (const [prn, block] of byPrn) {
  const want = records(Number(prn));
  block.COVARIANCE_MATRIX_LINES.forEach((c, i) => {
    const sigmaKm = (want[i].ura * 1e-3);
    assert.ok(Math.abs(Math.sqrt((c.CX_X + c.CY_Y + c.CZ_Z) / 3) / sigmaKm - 1) < 1e-9, `PRN ${prn} record ${i}: position sigma is the URA ${want[i].ura} m`);
  });
  assert.equal(block.COVARIANCE_MATRIX_LINES.length, block.EPHEMERIS_DATA_LINES.length);
  assert.match(block.COMMENT, /protection bound/);
  assert.match(block.COMMENT, /not a realized (orbit )?error/);
  assert.ok(block.COMMENT.includes(createHash('sha256').update(fileBytes).digest('hex')), 'the comment states the source file SHA-256');
  assert.ok(block.COMMENT.includes(file.url), 'and its upstream URL');
  assert.equal(block.REFERENCE_FRAME.NAME, 'GCRF');
  assert.equal(block.TIME_SYSTEM, OEM.timingStandard.UTC);
}
console.log('URA: position sigma equals the record URA on every state; comment names it a protection bound, the file SHA-256 and the URL');

// ── a PRN absent from the file, and a PRN off its slot ──
const without = { ...file, records: file.records.filter((r) => r.prn !== 133) };
const absent = await convert(Buffer.from(JSON.stringify(without)));
assert.deepEqual(absent.states.map((b) => b.OBJECT.NORAD_CAT_ID).sort(), [41589, 46114]);
assert.equal(absent.notices.length, 1);
assert.equal(absent.notices[0].REASON, 'prn-absent');
assert.deepEqual(absent.notices[0].ITEMS, ['133']);
const moved = { ...file, records: file.records.map((r) => (r.prn === 131 ? { ...r, r: [r.r[0], -r.r[1], r.r[2]], v: [r.v[0], -r.v[1], r.v[2]] } : r)) };  // longitude -117 -> +117
const off = await convert(Buffer.from(JSON.stringify(moved)));
assert.deepEqual(off.states.map((b) => b.OBJECT.NORAD_CAT_ID).sort(), [42709, 46114]);
assert.equal(off.notices[0].REASON, 'slot-mismatch');
assert.deepEqual(off.notices[0].ITEMS, ['131']);
console.log('absent PRN 133: no state, reason prn-absent; PRN 131 moved to +117: no state, reason slot-mismatch');

// ── schema and the existing conversions ──
const compliance = await validateArtifactWithStandards({ manifest: JSON.parse(fs.readFileSync(path.join(root, 'plugin-manifest.json'))), wasmPath: path.join(root, 'dist/isomorphic/module.wasm'), standardsRoot: standards });
assert.equal(compliance.ok, true, JSON.stringify(compliance.issues));
reader.destroy();
execFileSync(process.execPath, [path.join(here, 'fetch-offline.e2e.mjs')], { stdio: 'pipe' });
console.log('existing SP3 conversions byte-identical (fetch-offline.e2e.mjs)');
console.log('PASS');
