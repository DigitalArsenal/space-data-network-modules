// Published SDS -> modules' C++ generator -> compiled consumer -> published JS.
// Wire fixtures exercise schema/CVR,SRO,SFE,SDI,SRT at SDS 1.261.0; no physics.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Builder, ByteBuffer } from 'flatbuffers';
import { FlatcRunner } from 'flatc-wasm';
import { generateSdsHeaders } from '../lib/sds-cpp-headers.mjs';

assert.equal(process.env.SPACE_DATA_STANDARDS_ROOT, undefined, 'use published npm dependencies');
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const sds = path.dirname(require.resolve('spacedatastandards.org/package.json'));
assert.equal(require('spacedatastandards.org/package.json').version, '1.261.0');
// These are the bumped packages with explicit CVR ports. The solar and surface
// producers are separate lanes; their new records use the shared generator below.
for (const pkg of ['analysis/rpo-history', 'analysis/reference-states']) {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, pkg, 'package.json'))).devDependencies['spacedatastandards.org'], '1.261.0');
  execFileSync('npm', ['run', 'build'], { cwd: path.join(root, pkg), stdio: 'inherit' });
}
const codes = ['CVR', 'SRO', 'SFE', 'SDI', 'SRT'];
const modules = Object.fromEntries(await Promise.all(codes.map(async code =>
  [code, await import(pathToFileURL(path.join(sds, 'lib/js', code, 'main.js')))])));
const table = (m, type, fields) => Object.assign(new m[`${type}T`](), fields);
const provenance = m => table(m, 'PVN', {
  SOURCE_ID: 'sds-1261-wire-fixture', PRODUCER: 'modules-sds-consumer-e2e',
  LICENSE_ID: 'CC0-1.0', LINEAGE: 'synthetic schema contract fixture',
});
const epoch = '2026-10-23T00:00:00Z';
const { CVR: C, SRO: R, SFE: F, SDI: I, SRT: T } = modules;
assert.equal(C.covarianceRule.EmpiricalHistoryShrunk, 5);
const records = {
  CVR: table(C, 'CVR', {
    RULE: C.covarianceRule.EmpiricalHistoryShrunk, MODEL_ID: 'population-prior',
    CALIBRATION: C.covarianceCalibration.Uncalibrated, HISTORY_SAMPLES: 17,
    HISTORY_SETS: 6, HISTORY_WINDOW: '2026-10-01/2026-10-22', SHRINKAGE_WEIGHT: 0.25,
    SAMPLES: 0, OBJECTS: 0, EVIDENCE: 'synthetic retained-bin fixture',
  }),
  SRO: table(R, 'SRO', { REGION_NUMBER: 1234, REGION_AUTHORITY: 'fixture',
    POSITION_EPOCH: epoch, REGION_KIND: R.sroRegionKind.SUNSPOT_GROUP,
    SPOT_COUNT: 0, HAS_SPOT_COUNT: true, HG_LATITUDE_DEG: -14,
    HG_LONGITUDE_DEG: 32, PROVENANCE: provenance(R) }),
  SFE: table(F, 'SFE', { EVENT_ID: 'fixture-event', EVENT_KIND: F.sfeEventKind.XRAY,
    BEGIN_TIME: epoch, XRAY_CLASS: 'C1.4', HAS_REGION_NUMBER: false,
    PROVENANCE: provenance(F) }),
  SDI: table(I, 'SDI', { OBSERVED_AT: epoch, WIDTH: 4096, HEIGHT: 4096,
    CTYPE1: 'HPLN-TAN', CTYPE2: 'HPLT-TAN', CRPIX1: 2048.5, CRPIX2: 2048.5,
    CDELT1: 0.6, CDELT2: 0.6, PC: [1, 0, 0, 1], IMAGE_SIZE_BYTES: 4294967297n,
    QUALITY: 0n, HAS_QUALITY: true, PROVENANCE: provenance(I) }),
  SRT: table(T, 'SRT', { TILESET_ID: 'fixture-landcover', CRS: 'EPSG:4326',
    QUANTITY: T.srtQuantity.CATEGORICAL_CLASS, SAMPLE_TYPE: T.srtSampleType.UINT8,
    CLASS_LEGEND: [table(T, 'SRTClass', { CODE: 10, LABEL: 'Tree cover', COLOR_RGBA: 0x006400ff })],
    AFFINE_TRANSFORM: [0, 1, 0, 1, 0, -1], GRID_WIDTH: 1, GRID_HEIGHT: 1,
    PAYLOAD_FORMAT: T.srtPayloadFormat.SAMPLES_ROW_MAJOR_LE,
    PAYLOAD: table(T, 'DTTPayloadRef', {}), PROVENANCE: table(T, 'DTTProvenance', {}) }),
};
const { header, version, families } = await generateSdsHeaders(codes, import.meta.url);
assert.equal(version, '1.261.0');
for (const code of codes) assert.ok(families.includes(code));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modules-sds-1261-'));
try {
  fs.writeFileSync(path.join(tmp, 'schemas.h'), header);
  const flatc = await FlatcRunner.init();
  for (const [name, content] of Object.entries(flatc.getEmbeddedRuntime('cpp'))) {
    const target = path.join(tmp, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const branches = codes.map(code => `
  if (SizePrefixed${code}BufferHasIdentifier(bytes.data())) {
    assert(VerifySizePrefixed${code}Buffer(v));
    auto row = std::unique_ptr<${code}T>(GetSizePrefixed${code}(bytes.data())->UnPack());
    FinishSizePrefixed${code}Buffer(b, ${code}::Pack(b, row.get()));
  } else`).join('');
  fs.writeFileSync(path.join(tmp, 'roundtrip.cpp'), `
#include <cmath>
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
  ${branches} { return 2; }
  std::ofstream output(argv[2], std::ios::binary);
  output.write(reinterpret_cast<const char *>(b.GetBufferPointer()), b.GetSize());
}
`);
  const binary = path.join(tmp, 'roundtrip');
  execFileSync(process.env.CXX || 'c++', ['-std=c++17', '-I', tmp, path.join(tmp, 'roundtrip.cpp'), '-o', binary], { stdio: 'inherit' });
  for (const code of codes) {
    const Type = modules[code][code], builder = new Builder(2048);
    Type[`finishSizePrefixed${code}Buffer`](builder, records[code].pack(builder));
    const input = path.join(tmp, `${code}.in.fb`), output = path.join(tmp, `${code}.out.fb`);
    fs.writeFileSync(input, builder.asUint8Array());
    execFileSync(binary, [input, output], { stdio: 'inherit' });
    const decode = file => Type[`getSizePrefixedRootAs${code}`](new ByteBuffer(fs.readFileSync(file))).unpack();
    assert.deepEqual(decode(output), decode(input), `${code}: all fields survive native consumption`);
    console.log(`PASS SDS 1.261.0 ${code} JS -> modules-generated C++ -> JS`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
