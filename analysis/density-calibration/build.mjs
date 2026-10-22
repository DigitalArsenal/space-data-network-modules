import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModuleFromSource } from 'space-data-module-sdk/compiler';
import { composeErfaTranslationUnit } from '../../foundation/frames/erfa-amalgamation.mjs';
import { generateSdsHeaders } from '../../scripts/lib/sds-cpp-headers.mjs';

// One translation unit: the SDS standards' generated C++ headers for the $DCL
// frames (scripts/lib/sds-cpp-headers.mjs, with the object API of DCL and
// every standard it includes, in include order, inlined in place of
// `#include "DCL_generated.h"`: each include guard renamed, since every one is
// "main_generated.h", and the flatc version static_assert relaxed, as
// hostcap/clock/build.mjs does), ERFA (the Sun's direction and the Earth's rotation), propagator/ffm's JB2008
// (lib/jb2008.h, unchanged), the public-domain C port of NRLMSISE-00 in
// third_party/nrlmsise00 (unchanged but for a malloc cast and an array bound, inside the
// namespace nrlmsise00 so that its global names stay out of the rest),
// propagator/sgp4's Vallado SGP4 (the element sets' trajectories for the
// decay methods; as analysis/epoch-state compiles it) and this module's source.
const root = fileURLToPath(new URL('.', import.meta.url));
// Reuse FFM's compiler, units and EH runtime; the SDK still owns this module's
// ABI. Internal-linkage SDS headers isolate this consumer's released layout.
const previousStandards=process.env.SPACE_DATA_STANDARDS_ROOT;
delete process.env.SPACE_DATA_STANDARDS_ROOT;
await import('../../propagator/ffm/build.mjs');
if(previousStandards)process.env.SPACE_DATA_STANDARDS_ROOT=previousStandards;
else delete process.env.SPACE_DATA_STANDARDS_ROOT;
const jb2008Header = path.resolve(root, '../../propagator/ffm/lib/jb2008.h');
const egm2008Header = path.resolve(root, '../../propagator/ffm/lib/egm2008_data.h');
const sgp4Src = path.resolve(root, '../../propagator/sgp4/src/cpp/src');
const msisDir = path.resolve(root, '../../third_party/nrlmsise00');
const erfa = await composeErfaTranslationUnit(); // provenance; FFM links the authoritative ERFA unit
const jb2008 = await fs.readFile(jb2008Header, 'utf8');
const egm2008 = await fs.readFile(egm2008Header, 'utf8');
// SGP4.cpp carries Latin-1 bytes in comments and defines a `pi` macro that
// must not leak past it.
const sgp4Header = await fs.readFile(path.join(sgp4Src, 'SGP4.h'), 'latin1');
const sgp4Source = (await fs.readFile(path.join(sgp4Src, 'SGP4.cpp'), 'latin1')).replace('#include "SGP4.h"', '');
// NRLMSISE-00: header, coefficient data and model, as one C++ block in a namespace. The package includes its own header and the C standard headers
// (taken out here and included once, before the namespace); the one construct C++ refuses is the void* from malloc in spline().
const msisHeader = await fs.readFile(path.join(msisDir, 'nrlmsise-00.h'), 'latin1');
const msisData = await fs.readFile(path.join(msisDir, 'nrlmsise-00_data.c'), 'latin1');
const mallocCast = 'u=malloc(sizeof(double)*(unsigned int)n);';
const ptmExtern = 'extern double ptm[10];';              // declared 10 long in the model file and defined 50 long in the data file: C accepts that across files, C++ in one unit does not
const msisModel = (await fs.readFile(path.join(msisDir, 'nrlmsise-00.c'), 'latin1'))
  .replace('#include "nrlmsise-00.h"', '').replace(/#include <(math|stdio|stdlib)\.h>/g, '').replace(ptmExtern, 'extern double ptm[50];');
if (!msisModel.includes(mallocCast)) throw new Error('nrlmsise-00.c no longer has the malloc call this build casts');
const msis = ['#include <math.h>', '#include <stdio.h>', '#include <stdlib.h>', 'namespace nrlmsise00 {', msisHeader, msisData, msisModel.replace(mallocCast, 'u=(double*)malloc(sizeof(double)*(unsigned int)n);'), '}'].join('\n');
// The SDS headers: DCL and the standards its schema includes, each once, after the ones it includes.
const {header:sdsHeaders,version:sdsVersion,families:ordered}=await generateSdsHeaders(['DCL'],import.meta.url);
const energyArcs=await fs.readFile(path.join(root,'src/open_dca_energy_arcs.hpp'),'utf8');
const commonMode=await fs.readFile(path.join(root,'src/open_dca_common_mode.hpp'),'utf8');
const source = (await fs.readFile(path.join(root, 'src/density_calibration.cpp'), 'utf8'))
  .replace(/^#include "DCL_generated\.h".*$/m, () => sdsHeaders.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/g,''))
  .replace('#include "open_dca_common_mode.hpp"',()=>commonMode)
  .replace('#include "open_dca_energy_arcs.hpp"',()=>energyArcs);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'plugin-manifest.json'), 'utf8'));
const outputPath = path.join(root, 'dist/isomorphic/module.wasm');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
export const compilation = await compileModuleFromSource({
  manifest,
  sourceCode: ['#include "space_data_module_invoke.h"', '#include "erfa.h"', jb2008, egm2008, msis, sgp4Header, sgp4Source, '#undef pi', source].join('\n\n'),
  language: 'c++',
  outputPath,
  threadModel: 'wasi-sequential',stackSize:2*1024*1024,
});
if (!compilation.report?.ok) throw new Error('Density calibration validation failed',{cause:compilation.report?.issues});
await fs.copyFile(path.join(root, 'plugin-manifest.json'), path.join(root, 'dist/plugin-manifest.json'));
await fs.writeFile(path.join(root, 'dist/build-provenance.json'), `${JSON.stringify({
  erfaSourceFiles: erfa.fileCount, jb2008: 'propagator/ffm/lib/jb2008.h', nrlmsise00: 'third_party/nrlmsise00 (nrlmsise-00.h, nrlmsise-00_data.c, nrlmsise-00.c)', sgp4: 'propagator/sgp4/src/cpp/src/SGP4.cpp',
  sdsHeaders: ordered.map((code) => `schema/${code}/main.fbs (scripts/lib/sds-cpp-headers.mjs)`), threadModel: 'wasi-sequential',
}, null, 2)}\n`);
console.log(`Built ${outputPath}`);
