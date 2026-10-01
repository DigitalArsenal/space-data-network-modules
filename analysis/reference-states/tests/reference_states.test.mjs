import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';

// SP3 text -> files/orbit-products read_container -> reference_states.
// Expected values are independent of the module: Vallado, Fundamentals of
// Astrodynamics and Applications, 4th ed., Example 3-15 (ITRF -> GCRF, IAU
// 2006/2000 CIO with dX, dY), and the SP3 accuracy definitions (record
// standard deviation base^n mm, header accuracy 2^n mm).
// The SP3 trajectory is r(t) = r0 + v0 t + a t^2 / 2 in ITRF around the
// Vallado epoch, so the degree-9 interpolant's derivative at t = 0 is v0.
const root = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const require = createRequire(path.join(root, 'package.json'));
const flatbuffers = require('flatbuffers');
const load = async (code) => import(pathToFileURL(path.join(root, `lib/js/${code}/main.js`)));
const [OEM, NCD, EOP] = await Promise.all(['OEM', 'NCD', 'EOP'].map(load));
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json', import.meta.url)));
const readerDir = new URL('../../../files/orbit-products/', import.meta.url);
const readerWasm = fs.readFileSync(new URL('dist/isomorphic/module.wasm', readerDir));
const readerManifest = JSON.parse(fs.readFileSync(new URL('plugin-manifest.json', readerDir)));

const AS2R = Math.PI / 648000;
const MU = 398600.4418;
// Vallado Example 3-15: 2004-04-06 07:51:28.386009 UTC (GPS = UTC + 13 s).
const R_ITRF = [-1033.4793830, 7901.2952754, 6380.3565958];
const V_ITRF = [-3.225636520, -2.872451450, 5.531924446];
const R_GCRF = [5102.508959, 6123.011403, 6378.136925];
const V_GCRF = [-4.743220156, 0.790536497, 5.533755728];
const ERFA_GCRF = { r: [5102.508959486, 6123.011392961, 6378.136934384], v: [-4.74322016045, 0.790536499422, 5.533755724026] };
const EOP_ROW = { mjd: 53101, date: '2004-04-06T00:00:00Z', x: -0.140682, y: 0.333309, dut1: -0.4399619, dx: -0.000205, dy: -0.000136, lod: 0.0015563 };
const T0_GPS = Date.UTC(2004, 3, 6, 7, 51, 41) + 0.386009 * 1000;  // ms, sub-ms carried separately below
const STEP = 900;
const K = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];

const norm = (a) => Math.hypot(...a);
const accel = R_ITRF.map((x) => (-MU * x) / norm(R_ITRF) ** 3);
const position = (t, offset = [0, 0, 0]) => R_ITRF.map((x, i) => x + offset[i] + V_ITRF[i] * t + 0.5 * accel[i] * t * t);

// One SP3-c file: satellites [{ id, offset, sdev, accuracy }], positions in km.
function sp3(satellites, { coordinates = 'IGS05' } = {}) {
  const pad = (v, w) => String(v).padStart(w);
  const fix = (v, w, d) => v.toFixed(d).padStart(w);
  const start = new Date(Math.floor(T0_GPS) + K[0] * STEP * 1000);
  const frac = (ms) => (ms % 60000) / 1000 + 0.000009;
  const stamp = (d) => `${pad(d.getUTCFullYear(), 4)} ${pad(d.getUTCMonth() + 1, 2)} ${pad(d.getUTCDate(), 2)} ${pad(d.getUTCHours(), 2)} ${pad(d.getUTCMinutes(), 2)} ${fix(frac(d.getTime()), 11, 8)}`;
  const gpsSeconds = (start.getTime() - Date.UTC(1980, 0, 6)) / 1000 + 0.000009;
  const week = Math.floor(gpsSeconds / 604800);
  const mjd = Math.floor(start.getTime() / 86400000) + 40587;
  const dayFraction = ((start.getTime() % 86400000) / 1000 + 0.000009) / 86400;
  const ids = satellites.map((s) => s.id).concat(Array(85 - satellites.length).fill('  0'));
  const acc = satellites.map((s) => s.accuracy).concat(Array(85 - satellites.length).fill(0));
  const lines = [
    `#cP${stamp(start)} ${pad(K.length, 7)} ORBIT ${coordinates.padEnd(5)} HLM  TST`,
    `## ${pad(week, 4)} ${fix(gpsSeconds - week * 604800, 15, 8)} ${fix(STEP, 14, 8)} ${pad(mjd, 5)} ${fix(dayFraction, 15, 13)}`,
  ];
  for (let row = 0; row < 5; ++row) lines.push(`${row ? '+        ' : `+  ${pad(satellites.length, 3)}   `}${ids.slice(row * 17, row * 17 + 17).join('')}`);
  for (let row = 0; row < 5; ++row) lines.push(`++       ${acc.slice(row * 17, row * 17 + 17).map((a) => pad(a, 3)).join('')}`);
  lines.push('%c G  cc GPS ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc', '%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
    '%f  1.2500000  1.025000000  0.00000000000  0.000000000000000', '%f  0.0000000  0.000000000  0.00000000000  0.000000000000000',
    '%i    0    0    0    0      0      0      0      0         0', '%i    0    0    0    0      0      0      0      0         0',
    '/* SYNTHETIC REFERENCE-STATES FIXTURE', '/* VALLADO EXAMPLE 3-15 STATE AT THE CENTRE EPOCH', '/* POSITIONS QUADRATIC IN TIME', '/* ');
  for (const k of K) {
    lines.push(`*  ${stamp(new Date(Math.floor(T0_GPS) + k * STEP * 1000))}`);
    for (const s of satellites) {
      const r = position(k * STEP, s.offset);
      const sdev = s.sdev === undefined ? '' : ` ${pad(s.sdev, 2)} ${pad(s.sdev, 2)} ${pad(s.sdev, 2)}    `;
      lines.push(`P${s.id}${r.map((x) => fix(x, 14, 6)).join('')}${fix(0.5, 14, 6)}${sdev}`);
    }
  }
  lines.push('EOF');
  return Buffer.from(`${lines.join('\n')}\n`);
}

// [u32le n][$NCD][container bytes], as files/orbit-products reads them.
function container(bytes) {
  const b = new flatbuffers.Builder(1024);
  const sha = b.createString(createHash('sha256').update(bytes).digest('hex'));
  NCD.NCD.startNCD(b);
  NCD.NCD.addSourceByteLength(b, BigInt(bytes.byteLength));
  NCD.NCD.addSourceSha256(b, sha);
  NCD.NCD.finishSizePrefixedNCDBuffer(b, NCD.NCD.endNCD(b));
  return Buffer.concat([Buffer.from(b.asUint8Array()), bytes]);
}

function eop() {
  const r = EOP_ROW;
  const fields = { X_POLE_WANDER_RADIANS: r.x * AS2R, Y_POLE_WANDER_RADIANS: r.y * AS2R, UT1_MINUS_UTC_SECONDS: r.dut1,
    X_CELESTIAL_POLE_OFFSET_RADIANS: r.dx * AS2R, Y_CELESTIAL_POLE_OFFSET_RADIANS: r.dy * AS2R, LENGTH_OF_DAY_CORRECTION_SECONDS: r.lod };
  const b = new flatbuffers.Builder(1024);
  const date = b.createString(r.date);
  EOP.EOP.startEOP(b);
  EOP.EOP.addDate(b, date);
  EOP.EOP.addMjd(b, r.mjd);
  EOP.EOP.addIauConvention(b, EOP.iauPrecessionNutationModel.IAU_2006);
  for (const [key, value] of Object.entries(fields)) {
    const name = key.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    EOP.EOP[`add${name}`](b, value);
    EOP.EOP[`add${name}Hp`](b, value);
  }
  EOP.EOP.finishEOPBuffer(b, EOP.EOP.endEOP(b));
  return { portId: 'earth_orientation', payload: Buffer.from(b.asUint8Array()), typeRef: { schemaName: 'EOP.fbs', fileIdentifier: '$EOP', rootTypeName: 'EOP', wireFormat: 'flatbuffer' } };
}

async function run(t, satellites, identities) {
  const bytes = sp3(satellites);
  const reader = await createBrowserModuleHarness({ wasmSource: readerWasm, manifest: readerManifest, surface: 'direct' });
  t.after(() => reader.destroy());
  const read = await reader.invoke({ methodId: 'read_container', inputs: [{ portId: 'container', payload: container(bytes), typeRef: { schemaName: 'NCD.fbs', fileIdentifier: '$NCD', rootTypeName: 'NCD', wireFormat: 'flatbuffer' } }] });
  assert.equal(read.statusCode, 0, read.errorMessage);
  const frame = (port, schema) => {
    const f = read.outputs.find((o) => o.portId === port);
    return { portId: port, payload: Buffer.from(f.payload), typeRef: { schemaName: `${schema}.fbs`, fileIdentifier: `$${schema}`, rootTypeName: schema, wireFormat: 'flatbuffer' } };
  };
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  t.after(() => h.destroy());
  const result = await h.invoke({ methodId: 'reference_states', inputs: [frame('ephemeris', 'OEM'), frame('descriptor', 'NCD'), eop(),
    { portId: 'identities', payload: Buffer.from(JSON.stringify(identities)), typeRef: { schemaName: 'application/json' } }] });
  if (result.statusCode !== 0) return { error: result.errorMessage, sha: createHash('sha256').update(bytes).digest('hex') };
  const blocks = result.outputs.filter((o) => o.portId === 'reference')
    .map((o) => OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(o.payload))).unpack().EPHEMERIS_DATA_BLOCK[0]);
  return { blocks, sha: createHash('sha256').update(bytes).digest('hex') };
}

const centre = (block) => {
  const i = block.EPHEMERIS_DATA_LINES.findIndex((l) => l.EPOCH === '2004-04-06T07:51:28.386009Z');
  assert.ok(i >= 0, 'the Vallado epoch is among the outputs, in UTC');
  return { line: block.EPHEMERIS_DATA_LINES[i], cov: block.COVARIANCE_MATRIX_LINES[i] };
};

test('the artifact satisfies the SDK contract', async () => {
  const report = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot: root });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test('GPS-time ITRF SP3 becomes GCRF/UTC matching Vallado 3-15, with the SP3 accuracy as covariance', async (t) => {
  const { blocks, sha, error } = await run(t, [
    { id: 'G01', offset: [0, 0, 0], sdev: 10, accuracy: 0 },
    { id: 'G02', offset: [0, 0, 1000], accuracy: 3 },
    { id: 'G03', offset: [0, 1000, 0], accuracy: 3 },
  ], {
    product: 'synthetic SP3', source: 'tests/reference_states.test.mjs',
    satellites: { G01: { norad: 90001, objectId: '2004-901A', name: 'ONE' }, G02: { norad: 90002, objectId: '2004-902A' } },
  });
  assert.equal(error, undefined, error);
  assert.deepEqual(blocks.map((b) => b.OBJECT.NORAD_CAT_ID), [90001, 90002], 'one OEM per identified satellite; G03 has no identity');
  const [one, two] = blocks;
  assert.equal(one.OBJECT.OBJECT_ID, '2004-901A');
  assert.equal(one.REFERENCE_FRAME.NAME, 'GCRF');
  assert.equal(one.TIME_SYSTEM, OEM.timingStandard.UTC);
  assert.equal(one.EPHEMERIS_DATA_LINES.length, K.length);
  assert.match(one.COMMENT, new RegExp(sha));

  // Vallado's printed position sits 1 cm from SOFA's IAU 2006/2000A with these
  // EOP (his implementation's own rounding), so it bounds at 2 cm and 1e-8
  // km/s. ERFA_GCRF (pyerfa 2.0.1.5: xy06, s06, c2ixys with dX/dY, era00,
  // pom00, LOD-scaled rotation rate) bounds at the SP3's 1 mm and the 1 mm
  // positions' interpolant at 900 s.
  const { line, cov } = centre(one);
  const r = [line.X, line.Y, line.Z], v = [line.X_DOT, line.Y_DOT, line.Z_DOT];
  r.forEach((x, i) => assert.ok(Math.abs(x - R_GCRF[i]) < 2e-5, `r[${i}] ${x} vs Vallado ${R_GCRF[i]}`));
  v.forEach((x, i) => assert.ok(Math.abs(x - V_GCRF[i]) < 1e-8, `v[${i}] ${x} vs Vallado ${V_GCRF[i]}`));
  r.forEach((x, i) => assert.ok(Math.abs(x - ERFA_GCRF.r[i]) < 1e-6, `r[${i}] ${x} vs ERFA ${ERFA_GCRF.r[i]}`));
  v.forEach((x, i) => assert.ok(Math.abs(x - ERFA_GCRF.v[i]) < 2e-9, `v[${i}] ${x} vs ERFA ${ERFA_GCRF.v[i]}`));

  // Record standard deviation 1.25^10 mm on every axis: isotropic, so the
  // GCRF position block is sigma^2 I.
  const s1 = 1.25 ** 10 * 1e-6;
  for (const k of ['CX_X', 'CY_Y', 'CZ_Z']) assert.ok(Math.abs(cov[k] / s1 ** 2 - 1) < 1e-9, `${k} ${cov[k]}`);
  for (const k of ['CY_X', 'CZ_X', 'CZ_Y']) assert.ok(Math.abs(cov[k]) < 1e-9 * s1 ** 2, `${k} ${cov[k]}`);
  assert.match(one.COMMENT, /records' standard deviations/);

  // Header accuracy 2^3 mm when the records carry none.
  const s2 = 8e-6;
  const c2 = centre(two).cov;
  for (const k of ['CX_X', 'CY_Y', 'CZ_Z']) assert.ok(Math.abs(c2[k] / s2 ** 2 - 1) < 1e-9, `${k} ${c2[k]}`);
  assert.match(two.COMMENT, /header accuracy/);

  // Velocity variance: at least the position variance through the
  // derivative weights, sigma^2 sum w^2, which for ten 900 s epochs is
  // below (sigma / 900 s)^2 * 10.
  const vv = cov.CX_DOT_X_DOT + cov.CY_DOT_Y_DOT + cov.CZ_DOT_Z_DOT;
  assert.ok(vv > 0 && vv < 3 * 10 * (s1 / STEP) ** 2, `velocity variance ${vv}`);
});

test('an SP3 with no accuracy needs a stated one, and never gets a default', async (t) => {
  const satellites = [{ id: 'G01', offset: [0, 0, 0], accuracy: 0 }];
  const ids = { product: 'synthetic SP3', satellites: { G01: { norad: 90001 } } };
  const refused = await run(t, satellites, ids);
  assert.match(refused.error ?? '', /no default is assumed/);
  const { blocks, error } = await run(t, satellites, { ...ids, statedSigmaM: 0.025, statedSigmaBasis: 'the product description' });
  assert.equal(error, undefined, error);
  const { cov } = centre(blocks[0]);
  assert.ok(Math.abs(cov.CX_X / (0.025e-3) ** 2 - 1) < 1e-9, `CX_X ${cov.CX_X}`);
  assert.match(blocks[0].COMMENT, /stated by the product description/);
});
