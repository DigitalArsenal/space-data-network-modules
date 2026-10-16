#!/usr/bin/env node
// HPOP's clock, Earth orientation, TEME axes and third-body states against
// ERFA (pyerfa) and NAIF SPICE (SpiceyPy) at the 50 hourly sample epochs of the
// reference cases (tests/evidence/cases/hpop-reference-cases.json: 25 on
// 2026-08-02 with eop-2026-08, 25 on 2026-06-10 with eop-2026-06).
//
//   XVAL_PYTHON=<venv>/bin/python XVAL_NAIF=<kernel dir> \
//     node tests/evidence/erfa-spice/run-erfa-spice.mjs [--flatbuffers <include>]
//
// 1. hpop_frames_native.cpp, compiled from HPOP's own sources and the vendored
//    ERFA (amalgamated as build.mjs does), reports HPOP's TT, TDB, the single-
//    double TDB Julian date its force model receives, EarthRotation's GCRF ->
//    ITRF matrix at that date, and the SGP4 module's GCRF -> TEME matrix.
// 2. The shipped HPOP WASM (dist/isomorphic/module.wasm) answers the Sun and
//    Moon relative to the Earth at that date from the case export's DE440 file.
// 3. reference.py evaluates ERFA and SPICE at the same epochs.
// 4. The comparison is written to hpop-frames.json, reference.json and
//    summary-erfa-spice.json beside this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { composeErfaTranslationUnit } from '../../../../../foundation/frames/erfa-amalgamation.mjs';
import { requestFor, decodeResult } from '../../lib/prwCodec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hpop = path.resolve(here, '../../..');
const repo = path.resolve(hpop, '../..');
const { values: o } = parseArgs({ options: {
  flatbuffers: { type: 'string', default: path.resolve(repo, '../../main-packages/flatbuffers/include') },
  python: { type: 'string', default: process.env.XVAL_PYTHON ?? '/Users/tj/software/tools/xval/erfa-spice/bin/python' },
  naif: { type: 'string', default: process.env.XVAL_NAIF ?? '/Users/tj/software/tools/xval/naif-kernels' },
} });
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const CASES_PATH = path.join(here, '../cases/hpop-reference-cases.json');
const CASES = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const DE440 = path.join(repo, CASES.models.ephemeris.path);
if (sha256(DE440) !== CASES.models.ephemeris.sha256) throw new Error('DE440 kernel does not match the case export');

// The sample epochs of each Earth-orientation set.
const sets = new Map();
for (const c of CASES.cases) if (!sets.has(c.earthOrientation)) sets.set(c.earthOrientation, c.sampleEpochsUtc);

// 1. HPOP's clock and rotations (native, HPOP's sources).
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hpop-erfa-spice-'));
try {
  const erfa = await composeErfaTranslationUnit();
  const erfaUnit = path.join(work, 'erfa-amalgamation.cpp');
  fs.writeFileSync(erfaUnit, erfa.source);
  const bin = path.join(work, 'hpop-frames');
  const inc = [path.join(hpop, 'lib'), path.join(hpop, 'src'), path.join(hpop, 'src/cpp/include'), path.join(hpop, 'src/cpp/generated'),
    path.join(hpop, 'src/cpp/generated/sds'), path.join(repo, 'foundation/frames/src'), path.join(repo, 'higherpop/third_party/erfa'), o.flatbuffers];
  // force_models.cpp is compiled inside the harness's translation unit (it
  // includes it for the file-local gmst2006); the rest of lib/ as the native
  // tests link it (tests/environment_conformance.test.mjs).
  const nrl = path.join(repo, 'third_party/nrlmsise00'), hwm = path.join(repo, 'third_party/hwm14');
  const objects = ['nrlmsise-00.c', 'nrlmsise-00_data.c'].map((c) => {
    const obj = path.join(work, `${c}.o`);
    execFileSync('cc', ['-std=c11', '-O2', '-c', path.join(nrl, c), '-o', obj], { stdio: 'inherit' });
    return obj;
  });
  execFileSync('c++', ['-std=c++17', '-O2', ...inc.flatMap((d) => ['-I', d]), '-I', nrl, '-I', hwm, path.join(here, 'hpop_frames_native.cpp'),
    ...['astrodynamics', 'coords', 'ephemeris', 'environment_models', 'atmosphere_winds', 'integrators', 'nrlmsise00', 'time_convert', 'us76', 'atmosphere_plugin']
      .map((f) => path.join(hpop, 'lib', `${f}.cpp`)),
    path.join(hwm, 'hwm14.cpp'), path.join(hwm, 'hwm14_data.cpp'), ...objects, erfaUnit, '-o', bin], { stdio: 'inherit' });

  const epochs = [];
  for (const [id, utcs] of sets) {
    const eop = CASES.earthOrientation[id].fixture;
    const fixturePath = path.join(repo, eop.path);
    if (sha256(fixturePath) !== eop.sha256) throw new Error(`${id}: EOP fixture does not match the case export`);
    // The size-prefixed $EOP stream the reference requests carry (tests/lib/orekitCases.mjs eopRows).
    const eopBin = path.join(work, `${id}.bin`);
    fs.writeFileSync(eopBin, Buffer.from(JSON.parse(fs.readFileSync(fixturePath, 'utf8')).payloadBase64, 'base64'));
    const text = execFileSync(bin, [eopBin], { input: utcs.join('\n') + '\n', encoding: 'utf8' });
    for (const line of text.trim().split('\n')) epochs.push({ earthOrientation: id, ...JSON.parse(line) });
  }

  // 2. Sun and Moon from the shipped WASM at the TDB date the force model reads.
  const wasmPath = path.join(hpop, 'dist/isomorphic/module.wasm');
  const manifest = JSON.parse(fs.readFileSync(path.join(hpop, 'plugin-manifest.json'), 'utf8'));
  const kernel = fs.readFileSync(DE440);
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'command' });
  try {
    for (const e of epochs) {
      for (const [key, target] of [['sun', 10], ['moon', 301]]) {
        const r = await h.invoke(requestFor('ephemeris', { target, center: 399, epochTDBJD: e.jdTdb }, kernel));
        if (r.statusCode !== 0) throw new Error(`ephemeris ${target} at ${e.utc}: ${r.errorMessage}`);
        const d = decodeResult(r);
        e[key] = [...d.position, ...d.velocity];
      }
    }
  } finally { h.destroy(); }
  // One epoch per line.
  const write = (file, head, rows) => fs.writeFileSync(file, `${JSON.stringify(head, null, 1).slice(0, -2)},\n "epochs": [\n${rows.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n ]\n}\n`);
  const hpopFile = path.join(here, 'hpop-frames.json');
  write(hpopFile, {
    about: 'HPOP side of the ERFA/SPICE cross-check (run-erfa-spice.mjs). Time: prw_codec toTT and tdbMinusTtSeconds; c2t: EarthRotation::matrix (GCRF -> ITRF, row-major) at jdTdb; gcrfToTeme: foundation/frames as propagator/sgp4 temeToGcrf; sun, moon: the shipped WASM ephemeris operation at jdTdb (km, km/s, ICRF, relative to the Earth).',
    module: { version: JSON.parse(fs.readFileSync(path.join(hpop, 'package.json'), 'utf8')).version, sha256: sha256(wasmPath) },
    sources: Object.fromEntries(['propagator/hpop/src/cpp/include/hpop/prw_environment.h', 'propagator/hpop/src/cpp/include/hpop/prw_codec.h',
      'propagator/hpop/lib/time_convert.cpp', 'propagator/hpop/lib/coords.cpp', 'propagator/hpop/lib/force_models.cpp',
      'foundation/frames/src/axis_engine.hpp', 'foundation/frames/src/eop_series.hpp'].map((f) => [f, sha256(path.join(repo, f))])),
    erfaSourceFiles: erfa.fileCount }, epochs);

  // 3. ERFA and SPICE.
  const ref = execFileSync(o.python, ['-I', path.join(here, 'reference.py'), CASES_PATH, hpopFile, o.naif, DE440],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  const refJson = JSON.parse(ref);
  write(path.join(here, 'reference.json'), { about: 'ERFA and SPICE references (reference.py) at the epochs of hpop-frames.json.', tools: refJson.tools }, refJson.epochs);
} finally { fs.rmSync(work, { recursive: true, force: true }); }

// 4. Scores.
const H = JSON.parse(fs.readFileSync(path.join(here, 'hpop-frames.json'), 'utf8'));
const R = JSON.parse(fs.readFileSync(path.join(here, 'reference.json'), 'utf8'));
const MAS = Math.PI / 180 / 3600 / 1000, LEO = 6778137, GEO = 42164170;
// Small-rotation vector of A * B^T (A, B row-major 3x3), radians, in A's target axes.
function rotation(a, b) {
  const m = (i, j) => a[3 * i] * b[3 * j] + a[3 * i + 1] * b[3 * j + 1] + a[3 * i + 2] * b[3 * j + 2];
  const v = [(m(2, 1) - m(1, 2)) / 2, (m(0, 2) - m(2, 0)) / 2, (m(1, 0) - m(0, 1)) / 2];
  return { angle: Math.hypot(...v), pole: Math.hypot(v[0], v[1]), spin: Math.abs(v[2]) };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ref = new Map(R.epochs.map((e) => [e.utc, e]));
const max = (rows, f) => rows.reduce((m, x) => Math.max(m, f(x)), 0);
const at = (rows, f) => rows.reduce((b, x) => (f(x) > f(b) ? x : b), rows[0]).utc;
const pairs = H.epochs.map((h) => ({ h, r: ref.get(h.utc), utc: h.utc }));

const rows = [];
function row(id, quantity, reference, value, unit, tolerance, note, extra = {}) {
  rows.push({ id, quantity, reference, max: value, unit, tolerance, met: tolerance == null ? null : value <= tolerance, note, ...extra });
}
row('leap', 'TAI - UTC', 'ERFA eraDat; SPICE naif0012.tls', max(pairs, ({ h, r }) => Math.max(Math.abs(h.leapSeconds - r.leapSeconds), Math.abs(h.leapSeconds - r.leapSecondsSpice))), 's', 0, '37 s at every epoch on all three');
row('tt', 'TT from UTC', 'ERFA eraUtctai + eraTaitt (two-part)', max(pairs, ({ r }) => Math.abs(r.ttMinusHpopS)), 's', 1e-9, 'HPOP carries TT as whole seconds and their fraction');
row('tdb', 'TDB - TT', 'ERFA eraDtdb (geocentre)', max(pairs, ({ h, r }) => Math.abs(h.tdbMinusTtS - r.tdbMinusTtErfaS)), 's', null,
  'HPOP: 1.658 ms sin M + 14 us sin 2M, the difference taken in one double Julian date (40 us steps)', { at: at(pairs, ({ h, r }) => Math.abs(h.tdbMinusTtS - r.tdbMinusTtErfaS)) });
row('tdbSpice', 'TDB - TT', 'SPICE (deltet: its two-term formula), against ERFA', max(pairs, ({ r }) => Math.abs(r.tdbMinusTtSpiceS - r.tdbMinusTtErfaS)), 's', null, 'reference spread');
row('forceClock', 'TDB date the force model receives', 'ERFA TT + eraDtdb', max(pairs, ({ r }) => Math.abs(r.etHpop - r.etErfa)), 's', null,
  'one double Julian date (resolution 40 us) of HPOP\'s TDB');
const rot = (k1, k2, f) => max(pairs, ({ h, r }) => f(rotation(k1(h, r), k2(h, r))));
const c2tSame = (f) => rot((h) => h.c2t, (h, r) => r.c2tErfaAtHpopInstant, f);
const c2tTrue = (f) => rot((h) => h.c2t, (h, r) => r.c2tErfa, f);
row('c2tSameInstant', 'GCRF -> ITRF at HPOP\'s own instant', 'ERFA, IERS 2010 CIO chain, full X/Y/s series at that instant', c2tSame((x) => x.angle) / MAS, 'mas', 0.021,
  'HPOP interpolates X, Y and s linearly between whole hours of TT (stated bound 0.02 mas)',
  { poleMas: c2tSame((x) => x.pole) / MAS, spinMas: c2tSame((x) => x.spin) / MAS, leoM: c2tSame((x) => x.angle) * LEO, geoM: c2tSame((x) => x.angle) * GEO });
row('c2tTrue', 'GCRF -> ITRF at the UTC epoch', 'ERFA, the same chain at the exact epoch', c2tTrue((x) => x.angle) / MAS, 'mas', 0.021 + 0.001,
  'adds the force model\'s clock: Earth rotation at the single-double TDB date and HPOP\'s TDB - TT',
  { poleMas: c2tTrue((x) => x.pole) / MAS, spinMas: c2tTrue((x) => x.spin) / MAS, leoM: c2tTrue((x) => x.angle) * LEO, geoM: c2tTrue((x) => x.angle) * GEO });
const clock = (f) => rot((h, r) => r.c2tErfaAtHpopInstant, (h, r) => r.c2tErfa, f);
row('c2tClock', 'ERFA at HPOP\'s instant against ERFA at the epoch', 'ERFA', clock((x) => x.angle) / MAS, 'mas', null, 'the clock alone (Earth rotation over the instant difference)',
  { spinMas: clock((x) => x.spin) / MAS, leoM: clock((x) => x.angle) * LEO });
const spice = (f) => rot((h) => h.c2t, (h, r) => r.c2tSpiceItrf93, f);
row('c2tSpice', 'GCRF -> ITRF', 'SPICE J2000 -> ITRF93 (earth_latest_high_prec.bpc)', spice((x) => x.angle) / MAS, 'mas', 5,
  'independent chain: IAU 1976/1980 with the BPC\'s own EOP and nutation corrections, J2000 taken as ICRF',
  { poleMas: spice((x) => x.pole) / MAS, spinMas: spice((x) => x.spin) / MAS, leoM: spice((x) => x.angle) * LEO });
const spiceErfa = (f) => rot((h, r) => r.c2tErfa, (h, r) => r.c2tSpiceItrf93, f);
row('c2tSpiceErfa', 'GCRF -> ITRF, reference spread', 'SPICE ITRF93 against ERFA at the epoch', spiceErfa((x) => x.angle) / MAS, 'mas', null, 'reference spread',
  { poleMas: spiceErfa((x) => x.pole) / MAS, spinMas: spiceErfa((x) => x.spin) / MAS });
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
row('gmstSame', 'GMST of the tides (gmst2006) at HPOP\'s own UT1 and TT', 'ERFA eraGmst06 at the same dates', max(pairs, ({ h, r }) => angDiff(h.gmst, r.gmst06AtHpopInstant)) / MAS, 'mas', 0.001,
  'HPOP\'s own ERA + IAU 2006 polynomial (not ERFA)');
row('gmstTrue', 'GMST of the tides at the UTC epoch', 'ERFA eraGmst06 at the exact UT1 and TT', max(pairs, ({ h, r }) => angDiff(h.gmst, r.gmst06)) / MAS, 'mas', null,
  'adds the single-double UT1 and TT dates');
const builtIn = (f) => rot((h) => h.c2tBuiltIn, (h, r) => r.c2tErfa, f);
row('c2tBuiltIn', 'GCRF -> Earth-fixed without Earth orientation input', 'ERFA, IERS 2010 chain with the case rows', builtIn((x) => x.angle) / MAS, 'mas', null,
  'HPOP\'s fallback when no EOP is supplied: IAU 1976/1980, GAST at UTC, no polar motion, no frame bias, as documented (force_models.h); the pole part is the omitted polar motion, the spin part UT1 - UTC. A PRW request with an Earth-fixed force is refused without EOP (eop-data-required), so no reference case reaches it',
  { poleMas: builtIn((x) => x.pole) / MAS, spinMas: builtIn((x) => x.spin) / MAS, leoM: builtIn((x) => x.angle) * LEO });
const same = (hk, rk, f) => rot((h) => h[hk], (h, r) => r[rk], f);
row('coordsPrecession', 'IAU 1976 precession (lib/coords precession)', 'ERFA eraPmat76 at the same TT', same('coordsPrecession', 'pmat76AtHpopInstant', (x) => x.angle) / MAS, 'mas', 0.001,
  'stated "as ERFA pmat76"', { poleMas: same('coordsPrecession', 'pmat76AtHpopInstant', (x) => x.pole) / MAS, spinMas: same('coordsPrecession', 'pmat76AtHpopInstant', (x) => x.spin) / MAS });
row('coordsNutation', 'IAU 1980 nutation (lib/coords nutationMatrix)', 'ERFA eraNutm80 at the same TT', same('coordsNutation', 'nutm80AtHpopInstant', (x) => x.angle) / MAS, 'mas', 10,
  'HPOP keeps 63 of the 106 terms (each omitted term under 0.3 mas)', { poleMas: same('coordsNutation', 'nutm80AtHpopInstant', (x) => x.pole) / MAS, spinMas: same('coordsNutation', 'nutm80AtHpopInstant', (x) => x.spin) / MAS });
row('coordsTeme', 'GCRF -> TEME (lib/coords gcrfToTeme)', 'ERFA eraPnm80, eraEqeq94 at the same TT', same('coordsGcrfToTeme', 'gcrfToTemeFk5AtHpopInstant', (x) => x.angle) / MAS, 'mas', 10,
  'the plugin\'s coords::transform TEME axes', { leoM: same('coordsGcrfToTeme', 'gcrfToTemeFk5AtHpopInstant', (x) => x.angle) * LEO, geoM: same('coordsGcrfToTeme', 'gcrfToTemeFk5AtHpopInstant', (x) => x.angle) * GEO });
row('c2tBuiltInClassical', 'GCRF -> Earth-fixed without Earth orientation input', 'ERFA eraGmst82 + eraEqeq94, eraNutm80, eraPmat76 (UT1 = UTC, no polar motion) at the same instant', same('c2tBuiltIn', 'c2tClassicalAtHpopInstant', (x) => x.angle) / MAS, 'mas', 10,
  'the chain the fallback states it implements', { poleMas: same('c2tBuiltIn', 'c2tClassicalAtHpopInstant', (x) => x.pole) / MAS, spinMas: same('c2tBuiltIn', 'c2tClassicalAtHpopInstant', (x) => x.spin) / MAS, leoM: same('c2tBuiltIn', 'c2tClassicalAtHpopInstant', (x) => x.angle) * LEO });
const teme = (k, f) => rot((h) => h.gcrfToTeme, (h, r) => r[k], f);
row('teme', 'GCRF -> TEME (SGP4 axes)', 'ERFA eraPnm06a, eraEe06a at the exact epoch', teme('gcrfToTemeErfa06', (x) => x.angle) / MAS, 'mas', 0.001,
  'the definition propagator/sgp4 uses', { leoM: teme('gcrfToTemeErfa06', (x) => x.angle) * LEO });
row('temeFk5', 'GCRF -> TEME (SGP4 axes)', 'ERFA eraPnm80, eraEqeq94 (the FK5 definition)', teme('gcrfToTemeFk5', (x) => x.angle) / MAS, 'mas', null,
  'spread between the two published TEME definitions', { poleMas: teme('gcrfToTemeFk5', (x) => x.pole) / MAS, spinMas: teme('gcrfToTemeFk5', (x) => x.spin) / MAS, leoM: teme('gcrfToTemeFk5', (x) => x.angle) * LEO });
for (const [key, name] of [['sun', 'Sun'], ['moon', 'Moon']]) {
  row(`${key}Same`, `${name} relative to the Earth, at HPOP's TDB date`, 'SPICE spkgeo, the same DE440 file and date', max(pairs, ({ h, r }) => dist(h[key], r[`${key}SpiceAtHpopInstant`])) * 1e3, 'm', 1e-3,
    'kernel reading and interpolation', { velocityMS: max(pairs, ({ h, r }) => dist(h[key].slice(3), r[`${key}SpiceAtHpopInstant`].slice(3))) * 1e3 });
  row(`${key}True`, `${name} relative to the Earth, at the UTC epoch`, 'SPICE spkgeo at TDB = ERFA TT + eraDtdb', max(pairs, ({ h, r }) => dist(h[key], r[`${key}SpiceAtErfaTdb`])) * 1e3, 'm', null,
    'adds HPOP\'s TDB clock');
}
const tools = { ...R.tools, naifKernels: Object.fromEntries(['naif0012.tls', 'earth_latest_high_prec.bpc'].map((f) => [f, sha256(path.join(o.naif, f))])),
  de440: { path: CASES.models.ephemeris.path, sha256: CASES.models.ephemeris.sha256 } };
const summary = { about: 'HPOP against ERFA and NAIF SPICE: clock, Earth orientation, TEME axes, Sun and Moon at the 50 hourly sample epochs of the reference cases (run-erfa-spice.mjs). Largest value over the epochs.',
  module: H.module, tools, epochs: pairs.length, rows };
fs.writeFileSync(path.join(here, 'summary-erfa-spice.json'), JSON.stringify(summary, null, 1) + '\n');
const fmt = (x, u) => (u === 'mas' ? `${x.toPrecision(3)} mas` : u === 's' ? `${(x * 1e6).toPrecision(3)} us` : x < 1e-3 ? `${(x * 1e6).toPrecision(3)} um` : x < 1 ? `${(x * 1e3).toPrecision(3)} mm` : `${x.toPrecision(3)} m`);
for (const r of rows) console.log(`${r.id.padEnd(16)} ${fmt(r.max, r.unit).padStart(12)} ${r.tolerance == null ? '        -' : (r.met ? '      met' : '   MISSED')}  ${r.quantity} | ${r.reference}${r.leoM != null ? ` | LEO ${fmt(r.leoM, 'm')}` : ''}`);
