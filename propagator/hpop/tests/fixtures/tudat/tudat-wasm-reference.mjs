#!/usr/bin/env node
// Tudat WASM reference trajectories for propagator/hpop: the Tudat C++
// library as repos/ancillary-packages/tudat-wasm compiles it to WebAssembly
// (Emscripten 3.1.51), running the same propagation as tudat_reference.py
// (tudat_wasm_driver.cpp, line for line), under Node. Its difference from
// tudatpy-reference.json is Tudat-native against Tudat-WASM.
//
//   node tests/fixtures/tudat/tudat-wasm-reference.mjs <tudat-wasm source> <its build-wasm dir> <emsdk dir> \
//        <tudat resource tree> <work dir> <out.json> [only]
//
// <tudat-wasm source> is a checkout of the package (git archive of its HEAD
// is enough); <its build-wasm dir> is its own build:
//   cmake -B build-wasm -DCMAKE_TOOLCHAIN_FILE=cmake_modules/toolchain-emscripten.cmake \
//         -DCMAKE_BUILD_TYPE=Release -DCMAKE_DISABLE_FIND_PACKAGE_Eigen3=ON -G Ninja
//   cmake --build build-wasm --target tudatpy_wasm
// (Eigen3 disabled: a system Eigen 5 config leaves EIGEN3_INCLUDE_DIR empty
// and the configure stops; the package then fetches Eigen 3.4.0 itself.)
// This links the driver against that build's libraries with the package's
// own link options, and embeds <tudat resource tree> (the one
// tudat_reference.py wrote, so both Tudat builds read byte-identical EOP and
// space-weather files) at the package's resource root /tudat_data, plus
// de440-2026.bsp and NAIF's naif0012.tls.
//
// Why a C++ driver and not the package's JavaScript API: the package's
// Embind module (its prebuilt docs/tudatpy_wasm.wasm, and a fresh build of
// target tudatpy_wasm at the same commit) aborts while loading on duplicate
// registrations (enum dynamics_environment_setup_ground_station_
// PositionElementTypes; two zero-argument constructors of
// ObservationAncilliarySimulationSettings); patched past those, its static
// initialisation throws std::out_of_range on the station file glo.vel; and
// past that, stl_wasm.cpp and eigen_wasm.cpp, which register the vector, map
// and Eigen types, are not in the target's sources, so a propagation cannot
// be set up from JavaScript (no std::vector<std::string>, std::map or
// Eigen::Vector6d argument converts). The library itself builds and runs:
// station files are not used here and are embedded empty (glo.sit, glo.vel).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [source, build, emsdk, resources, work, out, only] = process.argv.slice(2);
if (!out) throw new Error('usage: tudat-wasm-reference.mjs <tudat-wasm source> <build-wasm> <emsdk> <tudat resource tree> <work dir> <out.json> [only]');
fs.mkdirSync(work, { recursive: true });
const OREKIT = JSON.parse(fs.readFileSync(path.join(here, '../orekit/orekit-reference.json'), 'utf8'));
const LIST = JSON.parse(fs.readFileSync(path.join(here, '../xval/xval-cases.json'), 'utf8')).cases;
const KERNEL = path.resolve(here, '../../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp');
const LSK = path.join(resources, 'spice_kernels/naif0012.tls');
const K = OREKIT.constants;
const AU = 149597870700.0, AU3_DAY2 = AU ** 3 / 86400 ** 2;
const GM_SUN = 2.9591220828411951e-04 * AU3_DAY2, GM_MOON = 8.9970116036316091e-10 * AU3_DAY2 / (1 + 81.3005682214972154);

// The resource subset Tudat reads, as files (the tree holds links).
const stage = path.join(work, 'stage/tudat_data');
fs.rmSync(path.join(work, 'stage'), { recursive: true, force: true });
for (const dir of ['quadrature', 'earth_orientation', 'space_weather', 'ephemeris', 'earth_deformation', 'station_locations'])
  fs.cpSync(path.join(resources, dir), path.join(stage, dir), { recursive: true, dereference: true });
for (const file of ['glo.sit', 'glo.vel']) fs.writeFileSync(path.join(stage, 'station_locations', file), '');

// Compile and link with the flags and libraries of the package's own target.
const ninja = fs.readFileSync(path.join(build, 'build.ninja'), 'utf8');
const compileRule = ninja.slice(ninja.indexOf('createBodies.cpp.obj:'));
const field = (text, name) => text.match(new RegExp(`\\n  ${name} = ([^\\n]*)`))[1];
const linkRule = ninja.slice(ninja.indexOf('build src/tudatpy_wasm/tudatpy_wasm.js:'));
const libs = field(linkRule, 'LINK_LIBRARIES').replace(/-Wl,--whole-archive\s+\S+\s+-Wl,--no-whole-archive/, '').trim().split(/\s+/).map((l) => path.join(build, l));
const em = (args) => execFileSync('bash', ['-c', `source "${emsdk}/emsdk_env.sh" >/dev/null 2>&1 && cd "${work}" && em++ "$@"`, 'em++', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
em(['-sUSE_BOOST_HEADERS=1', '-O3', '-std=c++17', '-DNDEBUG', ...field(compileRule, 'DEFINES').split(/\s+/), ...field(compileRule, 'INCLUDES').split(/\s+/),
  '-c', path.join(here, 'tudat_wasm_driver.cpp'), '-o', 'driver.o']);
em(['-O3', 'driver.o', ...libs, '-o', 'driver.js', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=256MB', '-sDISABLE_EXCEPTION_CATCHING=0',
  '-sEMULATE_FUNCTION_POINTER_CASTS=1', '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1', '-sSTACK_SIZE=8MB',
  '--embed-file', `${stage}@/tudat_data`, '--embed-file', `${KERNEL}@/data/de440-2026.bsp`, '--embed-file', `${LSK}@/data/naif0012.tls`]);

// The cases, as the driver reads them.
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const utcSeconds = (iso) => (Date.parse(`${iso}Z`) - J2000_MS) / 1000;
const coefficients = [...fs.readFileSync(path.join(here, '../../../lib/egm2008_data.h'), 'utf8').matchAll(/\{\s*(\d+),\s*(\d+),\s*([-+0-9.eE]+),\s*([-+0-9.eE]+)\s*\}/g)].filter((m) => Number(m[1]) <= 20);
const cases = LIST.filter((name) => !only || name.includes(only)).map((name) => OREKIT.cases.find((x) => `${x.orbit} ${x.forces}` === name));
const input = [
  `K ${[K.gm, K.fieldRadiusM, K.shadowRadiusM, K.massKg, K.areaM2, K.cr, K.cd, AU, GM_SUN, GM_MOON, 695700e3, 1361].map((v) => v.toPrecision(17)).join(' ')}`,
  `COEF ${coefficients.length}`, ...coefficients.map((m) => `${m[1]} ${m[2]} ${m[3]} ${m[4]}`),
  'KERNEL /data/naif0012.tls', 'KERNEL /data/de440-2026.bsp',
  ...cases.flatMap((c) => [
    `CASE ${c.orbit} ${c.forces} ${c.degree} ${c.order} ${+c.thirdBodies} ${+c.srp} ${+c.drag} ${c.samples.length}`,
    c.samples[0].slice(1, 7).map((v) => v.toPrecision(17)).join(' '),
    ...c.samples.map((s) => `${s[0]} ${utcSeconds(s[7])}`),
  ]),
].join('\n');
fs.writeFileSync(path.join(work, 'input.txt'), `${input}\n`);
const output = execFileSync(process.execPath, [path.join(work, 'driver.js')], { input, maxBuffer: 64 << 20, encoding: 'utf8' });

const blocks = output.split(/^CASE /m).slice(1);
const results = blocks.map((block) => {
  // Sample rows only (CALCEPH announces each file it opens on stdout).
  const [head, ...rest] = block.trim().split('\n');
  const lines = rest.filter((l) => /^\d/.test(l));
  const [orbit, forces] = head.split(' ');
  const c = cases.find((x) => x.orbit === orbit && x.forces === forces);
  const samples = lines.map((l, i) => {
    const v = l.trim().split(/\s+/).map(Number);
    return [v[0], ...v.slice(1, 4).map((x) => Number(x.toFixed(6))), ...v.slice(4, 7).map((x) => Number(x.toFixed(9))), c.samples[i][7]];
  });
  return { orbit, forces, degree: c.degree, order: c.order, thirdBodies: c.thirdBodies, srp: c.srp, drag: c.drag, samples };
});
if (results.length !== cases.length) throw new Error(`driver returned ${results.length} of ${cases.length} cases`);
const tudatWasmVersion = fs.readFileSync(path.join(source, 'version'), 'utf8').trim();
const doc = {
  source: `Tudat ${tudatWasmVersion} as built by repos/ancillary-packages/tudat-wasm (Emscripten 3.1.51, its vendored Tudat sources), `
    + 'driven by tudat_wasm_driver.cpp under Node; same setup as tudatpy-reference.json (RKDP 8(7) fixed steps, 10 s or 1 s with radiation pressure, TT clock, '
    + 'Lagrange-8 to the samples, GCRS about the Earth, IERS 2010 Earth orientation with the rows of ../orekit/eop-2026-08.json, DE440 tabulated in GCRS, NRLMSISE-00 constant space weather)',
  epochUtc: OREKIT.epochUtc,
  cases: results,
};
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1).replace(/\[\n\s+([^\[\]{}]*?)\n\s+\]/g, (m, body) => `[${body.replace(/\n\s+/g, ' ')}]`)}\n`);
