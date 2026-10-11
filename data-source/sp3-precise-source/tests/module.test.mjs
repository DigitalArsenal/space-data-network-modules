// The module through the SDK's browser harness. Real files: the IGS final combined orbit of GPS week 1500 (SP3-c, position
// only, IGS05) and the CODE multi-GNSS final of 2025-01-19 (SP3-d, 122 satellites, IGS20), three epochs each, both
// IGS products offered under the IGS terms of use and kept in files/orbit-products/fixtures with their provenance; expected
// positions are the numbers printed in those files. Synthetic files stand for what is not ours to reproduce (the ESA/ESOC
// GLONASS and low-Earth-orbit products): velocity records (decimetres per second in the file, kilometres per second in the
// OEM), an absent position, other time systems and frames.
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
import { sp3File } from './fixtures/sp3-format.mjs';

const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
const standardsRoot = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`../../../files/orbit-products/fixtures/${name}`, import.meta.url)));

const request = (payload) => ({ methodId: 'read_sp3', inputs: [{ portId: 'source', payload, typeRef: { wireFormat: 'aligned-binary', requiredAlignment: 1, byteLength: payload.length } }] });
async function harness(t) {
  const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  t.after(() => host.destroy());
  return host;
}
const oems = (result) => {
  assert.equal(result.statusCode, 0, result.errorMessage);
  return result.outputs.filter((f) => f.portId === 'oem').map((f) => OEM.getRootAsOEM(new ByteBuffer(f.payload)).unpack());
};
const report = (result) => JSON.parse(new TextDecoder().decode(result.outputs.find((f) => f.portId === 'report').payload));
const block = (oem, k = 0) => oem.EPHEMERIS_DATA_BLOCK[k];
const name = (oem) => block(oem).OBJECT.OBJECT_NAME;
const CUSTOM_FRAME_WRAPPER = 4; // RFMUnion.CustomFrameWrapper (NONE, Celestial, Spacecraft, Orbit, Custom)
const GPS = 1, GLONASS = 12, ECEF = 0; // timingStandard.GPS, timingStandard.GLONASS, CustomFrame.ECEF

test('the SDK artifact validates against the canonical standards', async () => {
  const result = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test('the IGS final combined orbit (SP3-c, position only, IGS05): one OEM per satellite, the printed positions, the header\'s frame and time', async (t) => {
  const host = await harness(t);
  const file = fixture('igs15000.3ep.sp3');
  const result = await host.invoke(request(file));
  const all = oems(result);
  assert.equal(all.length, 32);
  assert.deepEqual(all.map(name), Array.from({ length: 32 }, (_, k) => `G${String(k + 1).padStart(2, '0')}`));
  const g01 = all[0];
  assert.equal(g01.ORIGINATOR, 'IGS');
  assert.equal(g01.EPHEMERIS_DATA_BLOCK.length, 1);
  const b = block(g01);
  // The positions printed for G01 at 2008-10-05 00:00, 00:15 and 00:30 GPS time, kilometres, IGS05 (Earth-fixed).
  assert.deepEqual(b.EPHEMERIS_DATA, [-12657.447359, 16740.372976, 16448.768851, -14280.592133, 17329.911574, 14337.203284, -15645.499594, 17894.53686, 11981.188166]);
  assert.equal(b.STATE_VECTOR_SIZE, 3); // position only: the file has no velocity records, and none is made of the positions
  assert.equal(b.STEP_SIZE, 900);
  assert.equal(b.START_TIME, '2008-10-05T00:00:00.000000');
  assert.equal(b.STOP_TIME, '2008-10-05T00:30:00.000000');
  assert.equal(b.TIME_SYSTEM, GPS);
  assert.equal(b.CENTER_NAME, 'EARTH');
  assert.equal(b.REFERENCE_FRAME.NAME, 'IGS05');
  assert.equal(b.REFERENCE_FRAME.REFERENCE_FRAME_type, CUSTOM_FRAME_WRAPPER);
  assert.equal(b.REFERENCE_FRAME.REFERENCE_FRAME.frame, ECEF);
  assert.equal(b.OBJECT.NORAD_CAT_ID, 0, 'a PRN slot is not a catalog number');
  assert.deepEqual(block(all[31]).EPHEMERIS_DATA.slice(0, 3), [8838.987717, 18843.874891, 17044.227107]); // G32
  const r = report(result);
  assert.deepEqual({ v: r.fileVersion, pv: r.positionVelocity, agency: r.agency, cs: r.coordinateSystem, type: r.orbitType, ts: r.timeSystem, interval: r.epochIntervalSeconds, n: r.satellites.length, frame: r.frame },
    { v: 'c', pv: 'P', agency: 'IGS', cs: 'IGS05', type: 'HLM', ts: 'GPS', interval: 900, n: 32, frame: 'Earth-fixed' });
  assert.equal(r.sha256, createHash('sha256').update(file).digest('hex'));
  assert.deepEqual(r.satellites[0], { id: 'G01', states: 3, blocks: 1, velocity: false, accuracyExponent: 4, clock: true, predictedStates: 0, maneuverFlags: 0 });
});

test('the CODE multi-GNSS final (SP3-d, 122 satellites past SP3-c\'s 85, IGS20): every constellation, each satellite its own OEM', async (t) => {
  const host = await harness(t);
  const result = await host.invoke(request(fixture('COD0MGXFIN_20250190000_01D_05M_ORB.3ep.sp3')));
  const all = oems(result);
  assert.equal(all.length, 122);
  const count = (letter) => all.filter((o) => name(o).startsWith(letter)).length;
  assert.deepEqual(['G', 'R', 'E', 'C', 'J'].map(count), [32, 21, 29, 37, 3]);
  const g01 = all.find((o) => name(o) === 'G01');
  assert.equal(g01.ORIGINATOR, 'AIUB');
  assert.deepEqual(block(g01).EPHEMERIS_DATA, [19419.818181, 11503.13012, 14013.621854, 19656.872914, 11970.102153, 13272.334875, 19885.565929, 12409.712778, 12505.656892]);
  assert.equal(block(g01).STEP_SIZE, 300);
  assert.equal(block(g01).REFERENCE_FRAME.NAME, 'IGS20');
  assert.equal(block(g01).START_TIME, '2025-01-19T00:00:00.000000');
  assert.equal(block(g01).STOP_TIME, '2025-01-19T00:10:00.000000');
  assert.deepEqual(block(all.find((o) => name(o) === 'R01')).EPHEMERIS_DATA.slice(0, 3), [20267.20541, -14561.813914, -5250.030872]);
  const r = report(result);
  assert.deepEqual({ v: r.fileVersion, agency: r.agency, cs: r.coordinateSystem, type: r.orbitType, ts: r.timeSystem, n: r.satellites.length }, { v: 'd', agency: 'AIUB', cs: 'IGS20', type: 'FIT', ts: 'GPS', n: 122 });
});

test('a file with velocity records gives full states in kilometres per second, a gap starts the next block, and the header\'s time system and frame are kept', async (t) => {
  const host = await harness(t);
  // Two low-Earth-orbit satellites, five epochs 30 s apart; L51's position at the third epoch is absent (0.000000), so its states
  // run in two blocks; velocities are written in decimetres per second as SP3-d fixes (7.123456 km/s = 71234.56 dm/s).
  const state = (k) => [6871 + k, 100 * k, -200 * k, 0.1 * k, 7.123456, 1.5];
  const l51 = [0, 1, 2, 3, 4].map((k) => (k === 2 ? null : state(k)));
  const l52 = [0, 1, 2, 3, 4].map((k) => state(10 + k));
  const file = sp3File({ flag: 'V', interval: 30, timeSystem: 'GLO', coordinateSystem: 'IGb14', agency: 'ESOC', orbitType: 'HLM', sats: [{ id: 'L51', epochs: l51 }, { id: 'L52', epochs: l52 }] });
  const result = await host.invoke(request(Buffer.from(file)));
  const [a, b] = oems(result);
  assert.deepEqual([name(a), name(b)], ['L51', 'L52']);
  assert.equal(a.EPHEMERIS_DATA_BLOCK.length, 2, 'the absent epoch splits the states into runs of evenly spaced epochs');
  assert.deepEqual(a.EPHEMERIS_DATA_BLOCK.map((x) => [x.START_TIME, x.STOP_TIME, x.EPHEMERIS_DATA.length / 6]), [['2026-10-11T00:00:00.000000', '2026-10-11T00:00:30.000000', 2], ['2026-10-11T00:01:30.000000', '2026-10-11T00:02:00.000000', 2]]);
  assert.ok(a.EPHEMERIS_DATA_BLOCK.every((x) => x.STATE_VECTOR_SIZE === 6 && x.STEP_SIZE === 30));
  // The first state of L52 (epoch 10): the position as printed and the velocity converted from dm/s to km/s.
  const [x, y, z, vx, vy, vz] = block(b).EPHEMERIS_DATA.slice(0, 6);
  [x, y, z].forEach((v, i) => assert.ok(Math.abs(v - [6881, 1000, -2000][i]) < 1e-6));
  [vx, vy, vz].forEach((v, i) => assert.ok(Math.abs(v - [1.0, 7.123456, 1.5][i]) < 1e-9, `v${i} = ${v}`));
  assert.equal(block(a).TIME_SYSTEM, GLONASS);
  assert.equal(block(a).REFERENCE_FRAME.NAME, 'IGb14');
  assert.equal(block(a).REFERENCE_FRAME.REFERENCE_FRAME.frame, ECEF);
  assert.deepEqual(report(result).satellites.map((s) => [s.id, s.states, s.blocks, s.velocity]), [['L51', 4, 2, true], ['L52', 5, 1, true]]);
});

test('a header that names an inertial frame gives that frame; a time system with no standard, a damaged file and a file with no position are refused whole', async (t) => {
  const host = await harness(t);
  const sats = [{ id: 'G01', epochs: [[26000, 0, 0], [25990, 100, 5], [25960, 200, 10]] }];
  // The header's coordinate system is five columns wide: J2000 fits.
  const inertial = oems(await host.invoke(request(Buffer.from(sp3File({ coordinateSystem: 'J2000', sats })))));
  assert.equal(block(inertial[0]).REFERENCE_FRAME.NAME, 'J2000');
  assert.equal(block(inertial[0]).REFERENCE_FRAME.REFERENCE_FRAME.frame, 2); // CelestialFrame.J2000
  const good = sp3File({ sats });
  for (const [label, text] of [['an unknown time system', sp3File({ timeSystem: 'XYZ', sats })], ['not SP3', 'ORBIT POSITIONS\n1 2 3\n'], ['truncated in the header', good.slice(0, 120)],
    ['empty', '\n'], ['no position at all', sp3File({ sats: [{ id: 'G01', epochs: [null, null, null] }] })]]) {
    const refused = await host.invoke(request(Buffer.from(text)));
    assert.notEqual(refused.statusCode, 0, label);
    assert.equal(refused.outputs?.length ?? 0, 0, `${label}: partial output`);
  }
  assert.equal(oems(await host.invoke(request(Buffer.from(good)))).length, 1);
});
