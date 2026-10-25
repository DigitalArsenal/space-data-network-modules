// OD's translation units, in link order: the one list both builds compile, build-wasi.mjs (the WASI module) and
// src/cpp/CMakeLists.txt (the Emscripten browser bundle and command module, configured by build.sh). FFM's physics is
// propagator/ffm/lib/units.mjs's list; with it come FFM's resident dynamics, HWM14, NRLMSISE-00 and the ERFA
// amalgamation foundation/frames composes. Each build adds only its own entry glue after OD's units: noexcept_stubs
// (the exception-free wasi-threads libc++) or direct_initialize (the Emscripten bundle's _initialize).
//   node units.mjs --cmake <out.cmake> --erfa <erfa.cpp>    (CMakeLists.txt runs this at configure time)
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {composeErfaTranslationUnit} from '../../foundation/frames/erfa-amalgamation.mjs';
import {physicsUnits} from '../../propagator/ffm/lib/units.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const modules = path.resolve(root, '../..');
const ffm = path.join(modules, 'propagator/ffm');

// OD's own units (C++, -fignore-exceptions).
export const odUnits = [
  'meme_parser', 'frame_transform', 'oem_parser', 'oem_fb_reader', 'omm_fb_builder', 'obd_fb_builder', 'ocm_fb_builder',
  'sgp4_fitter', 'plugin_runtime', 'plugin_entrypoints', 'plugin_invoke_bridge', 'operator_fit', 'operator_records',
  'operator_mnv',
].map((name) => ({path: path.join(root, 'src/cpp/src', `${name}.cpp`), language: 'c++', exceptions: 'ignore'}));

// FFM's physics and resident dynamics (C++, -fno-exceptions), HWM14 (C++), NRLMSISE-00 (C) and ERFA (C++, written to
// erfaPath).
export async function modelUnits({erfaPath}) {
  await fs.mkdir(path.dirname(erfaPath), {recursive: true});
  await fs.writeFile(erfaPath, (await composeErfaTranslationUnit()).source);
  return [
    ...physicsUnits.map((name) => ({path: path.join(ffm, 'lib', `${name}.cpp`), language: 'c++', exceptions: 'none'})),
    ...['prw_dynamics', 'resident_dynamics', 'kernel_store']
      .map((name) => ({path: path.join(ffm, 'src/cpp/src', `${name}.cpp`), language: 'c++', exceptions: 'none'})),
    ...['hwm14/hwm14.cpp', 'hwm14/hwm14_data.cpp']
      .map((name) => ({path: path.join(modules, 'third_party', name), language: 'c++', exceptions: 'ignore'})),
    ...['nrlmsise00/nrlmsise-00.c', 'nrlmsise00/nrlmsise-00_data.c']
      .map((name) => ({path: path.join(modules, 'third_party', name), language: 'c'})),
    {path: erfaPath, language: 'c++', exceptions: 'ignore'},
  ];
}

// The include directories and definitions the model units need.
export const modelIncludeDirs = [
  ...['lib', 'src', 'src/cpp/include', 'src/cpp/generated', 'src/cpp/generated/sds'].map((dir) => path.join(ffm, dir)),
  ...['third_party/nrlmsise00', 'third_party/hwm14', 'foundation/frames/src', 'higherpop/third_party/erfa']
    .map((dir) => path.join(modules, dir)),
];
export async function modelDefinitions() {
  const manifest = JSON.parse(await fs.readFile(path.join(ffm, 'plugin-manifest.json'), 'utf8'));
  const identity = (value) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Invalid FFM build identity');
    return `"${value}"`;
  };
  return [`FFM_MODULE_ID=${identity(manifest.pluginId)}`, `FFM_MODULE_VERSION=${identity(manifest.version)}`, 'FFM_TYPED_INPUTS_ONLY=1'];
}

// The same list as CMake variables: OD_UNITS_IGNORE_EXCEPTIONS, OD_UNITS_NO_EXCEPTIONS, OD_UNITS_C (each in link
// order), OD_MODEL_INCLUDE_DIRS and OD_MODEL_DEFINITIONS.
async function writeCMake(out, erfaPath) {
  const units = [...odUnits, ...await modelUnits({erfaPath})];
  const list = (values) => values.map((value) => `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`).join('\n    ');
  const of = (test) => list(units.filter(test).map((unit) => unit.path));
  const text = [
    '# Written by analysis/od/units.mjs; do not edit.',
    `set(OD_UNITS_IGNORE_EXCEPTIONS\n    ${of((u) => u.language === 'c++' && u.exceptions === 'ignore')}\n)`,
    `set(OD_UNITS_NO_EXCEPTIONS\n    ${of((u) => u.language === 'c++' && u.exceptions === 'none')}\n)`,
    `set(OD_UNITS_C\n    ${of((u) => u.language === 'c')}\n)`,
    `set(OD_MODEL_INCLUDE_DIRS\n    ${list(modelIncludeDirs)}\n)`,
    `set(OD_MODEL_DEFINITIONS\n    ${list(await modelDefinitions())}\n)`,
    '',
  ].join('\n');
  await fs.mkdir(path.dirname(out), {recursive: true});
  await fs.writeFile(out, text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flag = (name) => {
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error('usage: node units.mjs --cmake <out.cmake> --erfa <erfa.cpp>');
    return path.resolve(process.argv[index + 1]);
  };
  await writeCMake(flag('--cmake'), flag('--erfa'));
}
