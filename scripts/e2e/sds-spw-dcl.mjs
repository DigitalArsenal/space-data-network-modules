// Published SDS -> modules' object-API generator -> native consumer -> published JS.
// Wire-contract evidence from SDS 1.259.0 schema/{SPW,DCL}/main.fbs. No physics.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Builder, ByteBuffer } from 'flatbuffers';
import { FlatcRunner } from 'flatc-wasm';
import { generateSdsHeaders } from '../lib/sds-cpp-headers.mjs';

assert.equal(process.env.SPACE_DATA_STANDARDS_ROOT, undefined, 'use the installed published dependency');
const require = createRequire(import.meta.url);
const sds = path.dirname(require.resolve('spacedatastandards.org/package.json'));
assert.equal(require('spacedatastandards.org/package.json').version, '1.259.0');
const M = await import(pathToFileURL(path.join(sds, 'lib/js/DCL/main.js')));
const { header, version, families } = await generateSdsHeaders(['SPW', 'DCL'], import.meta.url);
assert.equal(version, '1.259.0');
assert.ok(families.includes('PVN'));
const table = (name, fields) => Object.assign(new M[`${name}T`](), fields);
const provenance = table('PVN', {
  SOURCE_ID: 'gfz-f107-ap', SOURCE_KIND: M.pvnSourceKind.Observation,
  ORIGINATOR: 'GFZ Helmholtz Centre for Geosciences', PROVIDER_ID: 'open-space-weather',
  PRODUCER: 'sds-consumer-e2e', LICENSE_CLASS: M.pvnLicenseClass.Reproducible,
  LICENSE_ID: 'CC-BY-4.0', LINEAGE: 'Matzka et al. (2021), doi:10.1029/2020SW002641',
});
const solve = 1792627200000n;
const weather = table('SPW', { DATE: '2026-10-22', F107_OBS: 150, AP_AVG: 7, PROVENANCE: provenance });
const density = table('DCL', {
  ID: 'fleet-common-mode', PROVENANCE: provenance,
  ATMOSPHERE: table('ATM', { MODEL: M.AtmosphericModelFamily.NRLMSIS00E, YEAR: 2000 }),
  SETTINGS: table('dclSettings', { FROM_MS: solve - 86400000n, TO_MS: solve }),
  SPACE_WEATHER: [weather],
  CORRECTION: table('dclCorrection', {
    FORM: M.dclCorrectionForm.LogDensityNodes,
    NODE_TIMES_MS: [solve - 86400000n, solve, solve + 86400000n, solve + 172800000n],
    NODE_LOG_DENSITY_SCALE_DIMENSIONLESS: [-0.2, 0.4, 0.1, 0],
  }),
});
const kelvin = table('DCL', { CORRECTION: table('dclCorrection', {
  FORM: M.dclCorrectionForm.Nodes, NODE_TIMES_MS: [solve], NODE_VALUES_K: [40],
}) });
assert.equal(M.dclCorrectionForm.LogDensityNodes, 3);
assert.equal(M.dclCorrectionForm.Nodes, 2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modules-sds-e2e-'));
try {
  fs.writeFileSync(path.join(tmp, 'schemas.h'), header);
  const compiler = await FlatcRunner.init();
  for (const [name, content] of Object.entries(compiler.getEmbeddedRuntime('cpp'))) {
    const target = path.join(tmp, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(path.join(tmp, 'roundtrip.cpp'), String.raw`
#include <cmath>
// Darwin's legacy math exception macro collides with an SDS country code.
#ifdef SING
#undef SING
#endif
#include "schemas.h"
#include <fstream>
#include <iterator>
#include <cassert>
int main(int argc, char **argv) {
  assert(argc == 3);
  std::ifstream input(argv[1], std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(input)), {});
  flatbuffers::Verifier v(bytes.data(), bytes.size());
  flatbuffers::FlatBufferBuilder b;
  if (SizePrefixedSPWBufferHasIdentifier(bytes.data())) {
    assert(VerifySizePrefixedSPWBuffer(v));
    auto row = std::unique_ptr<SPWT>(GetSizePrefixedSPW(bytes.data())->UnPack());
    FinishSizePrefixedSPWBuffer(b, SPW::Pack(b, row.get()));
  } else {
    assert(VerifySizePrefixedDCLBuffer(v));
    auto row = std::unique_ptr<DCLT>(GetSizePrefixedDCL(bytes.data())->UnPack());
    FinishSizePrefixedDCLBuffer(b, DCL::Pack(b, row.get()));
  }
  std::ofstream output(argv[2], std::ios::binary);
  output.write(reinterpret_cast<const char *>(b.GetBufferPointer()), b.GetSize());
}
`);
  const binary = path.join(tmp, 'roundtrip');
  execFileSync(process.env.CXX || 'c++', ['-std=c++17', '-I', tmp, path.join(tmp, 'roundtrip.cpp'), '-o', binary], { stdio: 'inherit' });
  for (const [name, Type, value] of [['weather', M.SPW, weather], ['density', M.DCL, density], ['kelvin', M.DCL, kelvin]]) {
    const builder = new Builder(2048);
    Type[`finishSizePrefixed${Type.name}Buffer`](builder, value.pack(builder));
    const input = path.join(tmp, `${name}.in.fb`), output = path.join(tmp, `${name}.out.fb`);
    fs.writeFileSync(input, builder.asUint8Array());
    execFileSync(binary, [input, output], { stdio: 'inherit' });
    const decode = file => Type[`getSizePrefixedRootAs${Type.name}`](new ByteBuffer(fs.readFileSync(file))).unpack();
    assert.deepEqual(decode(output), decode(input), `${name}: every field survives native consumption`);
  }
  console.log('PASS SDS 1.259.0: modules-generated C++ / JS SPW provenance, dimensionless DCL, embedded weather, unchanged kelvin nodes');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
