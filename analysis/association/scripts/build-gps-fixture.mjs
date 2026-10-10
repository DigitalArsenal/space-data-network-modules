// Builds tests/fixtures/gps-20260802.json.gz: a synthetic GNSS day.
//
// The fixture used to hold ESA/ESOC final orbits and the IGS final combined
// orbits for 2026-08-02. ESA/ESOC states no terms that allow a public copy, so
// this builds the same structure from SGP4 truth (Vallado 2020-07-13, deep-space
// branch; propagate_state of propagator/sgp4) and keeps nothing of either centre:
//
//   - 32 GPS-like satellites (12 sidereal hours, i 55 deg, six planes) as
//     G01..G32, and 24 Galileo-like satellites (14.08 h, i 56 deg, three planes)
//     as E01..E24 (the objects the catalog does not hold);
//   - esaItrf, the observation "truth": Earth-fixed positions every 5 minutes,
//     05:15-08:45 GPST, each satellite shifted by a constant Earth-fixed offset
//     drawn from the catalog's stated position sigma, so truth and catalog are
//     two analyses of one orbit as before;
//   - igsItrf and catalog, the catalog side: the GPS-like orbits as an SP3-c file
//     (Earth-fixed, GPS time, 15 min, 04:00-10:00), turned into GCRF/UTC states
//     with covariance by files/orbit-products read_container and
//     analysis/reference-states reference_states, the chain the real IGS product
//     went through (IAU 2006/2000A with the day's EOP); igsItrf holds the
//     Earth-fixed positions at the observation epochs (06:00-08:00 GPST, 15 min),
//     from which the test recovers the rotation;
//   - eop: the two IERS EOP 20 C04 rows for the day (IERS, public).
//
// The Earth-fixed positions are propagate_state's ECEF (TEME turned by GMST), a
// smooth Earth-fixed orbit. They are not an ITRF realization, which does not
// matter: truth and catalog are both made from them and rotated by the same ITRF
// to GCRF chain.
//
// Run from the repository root:  node analysis/association/scripts/build-gps-fixture.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { sgp4States } from '../../od/scripts/synthetic-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, '../../..');
const sdsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const flatbuffers = createRequire(path.join(sdsRoot, 'package.json'))('flatbuffers');
const lib = (code) => import(pathToFileURL(path.join(sdsRoot, `lib/js/${code}/main.js`)));
const [OEM, NCD, EOP] = await Promise.all(['OEM', 'NCD', 'EOP'].map(lib));
const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' });

// Draws the orbital phases. The association test requires that no withheld GPS
// satellite's one-way Doppler lands inside the gate of a catalogued one (a single
// candidate carries no ambiguity flag), which random phasing can break; the value
// here is one for which it holds. SEED=<n> tries another.
const SEED = Number(process.env.SEED ?? 1);
const GPS_MINUS_UTC = 18;
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (u) => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
const text = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '');
const DAY0 = Date.parse('2026-08-02T00:00:00Z');
const gpstEpochs = (fromMin, toMin, stepMin) => { const out = []; for (let m = fromMin; m <= toMin; m += stepMin) out.push(text(DAY0 + m * 60000)); return out; };
const utcOf = (gpst) => text(Date.parse(`${gpst}Z`) - GPS_MINUS_UTC * 1000);

const truthEpochs = gpstEpochs(315, 525, 5);         // 43
const observationEpochs = gpstEpochs(360, 480, 15);  // 9
const sp3Epochs = gpstEpochs(240, 600, 15);          // 25, 04:00-10:00 GPST
const SP3_SDEV_N = 3;                                // record standard deviation 1.25^3 mm per axis

function elements(system, index) {
  const r = rng((system === 'G' ? 3000 + index : 4000 + index) + 100 * SEED);
  const gps = system === 'G';
  const plane = gps ? Math.floor((index - 1) / 6) % 6 : Math.floor((index - 1) / 8) % 3;
  const slot = gps ? (index - 1) % 6 : (index - 1) % 8;
  return {
    noradId: gps ? 99600 + index : 99700 + index,
    objectName: `SYN-${gps ? 'GPS' : 'GAL'}-${String(index).padStart(2, '0')}`,
    // International designators must be unique: the module keys catalog objects by them.
    objectId: (() => { const k = (gps ? 0 : 32) + index - 1; return `2026-${900 + Math.floor(k / 26)}${String.fromCharCode(65 + (k % 26))}`; })(),
    epoch: '2026-08-02T00:00:00',
    meanMotion: gps ? 2.0056 + 0.0002 * r() : 1.7047 + 0.0001 * r(),
    eccentricity: gps ? 0.001 + 0.01 * r() : 0.0002 + 0.0004 * r(),
    inclination: gps ? 55 + 0.6 * (r() - 0.5) : 56 + 0.2 * (r() - 0.5),
    raan: gps ? (60 * plane + 3 * r()) % 360 : (120 * plane + 2 * r()) % 360,
    argPericenter: 360 * r(),
    meanAnomaly: gps ? (60 * slot + 10 * plane + 4 * r()) % 360 : (45 * slot + 15 * plane + 3 * r()) % 360,
    bstar: 0, meanMotionDot: 0, meanMotionDdot: 0,
  };
}

// SP3-c: GPS-like satellites, Earth-fixed km, GPS time, one record sigma each.
function sp3Text(epochs, rows) {
  const pad = (v, w) => String(v).padStart(w);
  const fix = (v, w, d) => v.toFixed(d).padStart(w);
  const start = new Date(`${epochs[0]}Z`);
  const stamp = (d) => `${pad(d.getUTCFullYear(), 4)} ${pad(d.getUTCMonth() + 1, 2)} ${pad(d.getUTCDate(), 2)} ${pad(d.getUTCHours(), 2)} ${pad(d.getUTCMinutes(), 2)} ${fix(d.getUTCSeconds(), 11, 8)}`;
  const gpsSeconds = (start.getTime() - Date.UTC(1980, 0, 6)) / 1000;
  const week = Math.floor(gpsSeconds / 604800);
  const ids = rows.map((r) => r.prn).concat(Array(85 - rows.length).fill('  0'));
  const acc = rows.map(() => 5).concat(Array(85 - rows.length).fill(0));
  const lines = [
    `#cP${stamp(start)} ${pad(epochs.length, 7)} ORBIT IGS20 HLM  SYN`,
    `## ${pad(week, 4)} ${fix(gpsSeconds - week * 604800, 15, 8)} ${fix(900, 14, 8)} ${pad(Math.floor(start.getTime() / 86400000) + 40587, 5)} ${fix((start.getTime() % 86400000) / 86400000, 15, 13)}`,
  ];
  for (let row = 0; row < 5; ++row) lines.push(`${row ? '+        ' : `+  ${pad(rows.length, 3)}   `}${ids.slice(row * 17, row * 17 + 17).join('')}`);
  for (let row = 0; row < 5; ++row) lines.push(`++       ${acc.slice(row * 17, row * 17 + 17).map((a) => pad(a, 3)).join('')}`);
  lines.push('%c G  cc GPS ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc', '%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
    '%f  1.2500000  1.025000000  0.00000000000  0.000000000000000', '%f  0.0000000  0.000000000  0.00000000000  0.000000000000000',
    '%i    0    0    0    0      0      0      0      0         0', '%i    0    0    0    0      0      0      0      0         0',
    '/* SYNTHETIC GPS-LIKE ORBITS FOR THE ASSOCIATION FIXTURE: SGP4 TRUTH, NO IGS DATA', '/* WRITTEN BY analysis/association/scripts/build-gps-fixture.mjs', '/* ', '/* ');
  epochs.forEach((e, k) => {
    lines.push(`*  ${stamp(new Date(`${e}Z`))}`);
    for (const row of rows) lines.push(`P${row.prn}${row.itrf[k].map((x) => fix(x, 14, 6)).join('')}${fix(0.5, 14, 6)} ${pad(SP3_SDEV_N, 2)} ${pad(SP3_SDEV_N, 2)} ${pad(SP3_SDEV_N, 2)}    `);
  });
  lines.push('EOF');
  return Buffer.from(`${lines.join('\n')}\n`);
}

// [u32 n][$NCD][container bytes], as files/orbit-products read_container takes them.
function container(bytes) {
  const b = new flatbuffers.Builder(1024);
  const sha = b.createString(createHash('sha256').update(bytes).digest('hex'));
  NCD.NCD.startNCD(b);
  NCD.NCD.addSourceByteLength(b, BigInt(bytes.byteLength));
  NCD.NCD.addSourceSha256(b, sha);
  NCD.NCD.finishSizePrefixedNCDBuffer(b, NCD.NCD.endNCD(b));
  return Buffer.concat([Buffer.from(b.asUint8Array()), bytes]);
}

const EOP_ROWS = [
  { date: '2026-08-02', mjd: 61254, xArcsec: 0.222428, yArcsec: 0.364675, dut1: 0.0122951, dXArcsec: 0.000391, dYArcsec: -0.000321, lod: 0.0004833 },
  { date: '2026-08-03', mjd: 61255, xArcsec: 0.222732, yArcsec: 0.363935, dut1: 0.0117718, dXArcsec: 0.0004, dYArcsec: -0.000304, lod: 0.0005395 },
];
function eopStream() {
  const AS2R = Math.PI / 648000;
  const frames = EOP_ROWS.map((r) => {
    const fields = { X_POLE_WANDER_RADIANS: r.xArcsec * AS2R, Y_POLE_WANDER_RADIANS: r.yArcsec * AS2R, UT1_MINUS_UTC_SECONDS: r.dut1,
      X_CELESTIAL_POLE_OFFSET_RADIANS: r.dXArcsec * AS2R, Y_CELESTIAL_POLE_OFFSET_RADIANS: r.dYArcsec * AS2R, LENGTH_OF_DAY_CORRECTION_SECONDS: r.lod };
    const b = new flatbuffers.Builder(1024);
    const date = b.createString(`${r.date}T00:00:00Z`);
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
    const plain = Buffer.from(b.asUint8Array());   // a plain buffer after a separately written length
    const length = Buffer.alloc(4);
    length.writeUInt32LE(plain.length);
    return Buffer.concat([length, plain]);
  });
  return { portId: 'earth_orientation', payload: Buffer.concat(frames), typeRef: typeRef('EOP') };
}

async function harness(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(modules, dir, 'plugin-manifest.json')));
  return createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(modules, dir, 'dist/isomorphic/module.wasm')), manifest, surface: 'direct' });
}

async function main() {
  const offsets = rng(20260802);
  const esaItrf = Object.fromEntries(truthEpochs.map((e) => [e, {}]));
  const igsItrf = Object.fromEntries(observationEpochs.map((e) => [e, {}]));
  const gps = [];
  const sats = [...Array.from({ length: 32 }, (_, i) => ['G', i + 1]), ...Array.from({ length: 24 }, (_, i) => ['E', i + 1])];
  for (const [system, index] of sats) {
    const prn = `${system}${String(index).padStart(2, '0')}`;
    const el = elements(system, index);
    const all = [...new Set([...truthEpochs, ...sp3Epochs])].sort();
    const states = new Map((await sgp4States(el, all.map(utcOf))).map((s, i) => [all[i], s]));
    const shift = [0, 1, 2].map(() => 1.25 ** SP3_SDEV_N * 1e-6 * gauss(offsets));   // km, one record sigma per axis
    for (const e of truthEpochs) esaItrf[e][prn] = states.get(e).ecef.slice(0, 3).map((v, k) => Number((v + shift[k]).toFixed(6)));
    if (system !== 'G') continue;
    const itrf = sp3Epochs.map((e) => states.get(e).ecef.slice(0, 3).map((v) => Number(v.toFixed(6))));
    for (const e of observationEpochs) igsItrf[e][prn] = itrf[sp3Epochs.indexOf(e)];
    gps.push({ prn, el, itrf });
  }

  // SP3 -> read_container -> reference_states: GCRF/UTC states with covariance.
  const sp3 = sp3Text(sp3Epochs, gps);
  const reader = await harness('files/orbit-products'), reference = await harness('analysis/reference-states');
  const read = await reader.invoke({ methodId: 'read_container', inputs: [{ portId: 'container', payload: container(sp3), typeRef: typeRef('NCD') }] });
  if (read.statusCode !== 0) throw new Error(`read_container: ${read.errorMessage}`);
  const port = (id, code) => ({ portId: id, payload: Buffer.from(read.outputs.find((o) => o.portId === id).payload), typeRef: typeRef(code) });
  const identities = { product: 'synthetic SP3', source: 'analysis/association/scripts/build-gps-fixture.mjs',
    satellites: Object.fromEntries(gps.map(({ prn, el }) => [prn, { norad: el.noradId, objectId: el.objectId, name: el.objectName }])) };
  const result = await reference.invoke({ methodId: 'reference_states', inputs: [port('ephemeris', 'OEM'), port('descriptor', 'NCD'), eopStream(),
    { portId: 'identities', payload: Buffer.from(JSON.stringify(identities)), typeRef: { schemaName: 'application/json' } }] });
  if (result.statusCode !== 0) throw new Error(`reference_states: ${result.errorMessage}`);
  await reader.destroy(); await reference.destroy();

  const COV = ['CX_X', 'CY_X', 'CY_Y', 'CZ_X', 'CZ_Y', 'CZ_Z', 'CX_DOT_X', 'CX_DOT_Y', 'CX_DOT_Z', 'CX_DOT_X_DOT', 'CY_DOT_X', 'CY_DOT_Y', 'CY_DOT_Z',
    'CY_DOT_X_DOT', 'CY_DOT_Y_DOT', 'CZ_DOT_X', 'CZ_DOT_Y', 'CZ_DOT_Z', 'CZ_DOT_X_DOT', 'CZ_DOT_Y_DOT', 'CZ_DOT_Z_DOT'];
  const catalog = [];
  for (const o of result.outputs.filter((x) => x.portId === 'reference')) {
    const oem = OEM.OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(o.payload))).unpack();
    for (const b of oem.EPHEMERIS_DATA_BLOCK) {
      const prn = Object.keys(identities.satellites).find((k) => identities.satellites[k].norad === b.OBJECT.NORAD_CAT_ID);
      const utcMinutes = (e) => (Date.parse(e) - DAY0) / 60000;
      const keep = (e) => utcMinutes(e) >= 299 && utcMinutes(e) <= 540;
      catalog.push({
        prn, norad: b.OBJECT.NORAD_CAT_ID, objectId: b.OBJECT.OBJECT_ID, name: b.OBJECT.OBJECT_NAME,
        states: b.EPHEMERIS_DATA_LINES.filter((l) => keep(l.EPOCH)).map((l) => ({ epoch: l.EPOCH, state: [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] })),
        covariances: b.COVARIANCE_MATRIX_LINES.filter((l) => keep(l.EPOCH)).map((l) => ({ epoch: l.EPOCH, lower: COV.map((k) => l[k]) })),
        comment: b.COMMENT,
      });
    }
  }
  catalog.sort((a, b) => (a.prn < b.prn ? -1 : 1));

  const fixture = {
    description: 'Synthetic GNSS day (2026-08-02) in the layout of the ESA/ESOC and IGS final-orbit scenario: SGP4 truth for 32 GPS-like and 24 Galileo-like satellites. esaItrf is the observation truth (Earth-fixed, GPS time); igsItrf and catalog are the catalog side (Earth-fixed positions at the observation epochs; GCRF/UTC states with covariance, made by files/orbit-products and analysis/reference-states). Earth orientation: IERS EOP 20 C04. Written by scripts/build-gps-fixture.mjs.',
    timeScale: { sp3: 'GPS', gpsMinusUtcSeconds: GPS_MINUS_UTC },
    sources: [
      { file: 'scripts/build-gps-fixture.mjs', what: 'SGP4 truth from invented element sets (propagator/sgp4 propagate_state): esaItrf, igsItrf, catalog', url: null },
      { file: 'eopc04.1962-now', what: 'IERS EOP 20 C04, two rows', url: 'https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now' },
    ],
    eop: EOP_ROWS,
    observationEpochsGpst: observationEpochs,
    esaItrf, igsItrf, catalog,
  };
  const out = path.join(here, '../tests/fixtures/gps-20260802.json.gz');
  fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(fixture), { level: 9, mtime: 0 }));
  console.log(`${out}: ${fs.statSync(out).size} bytes; ${catalog.length} catalog objects, ${truthEpochs.length} truth epochs, ${observationEpochs.length} observation epochs`);
}

await main();
