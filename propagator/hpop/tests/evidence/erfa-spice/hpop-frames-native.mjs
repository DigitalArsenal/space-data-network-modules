// HPOP's clock and Earth orientation from its own sources: builds
// hpop_frames_native.cpp (see its header) with the vendored ERFA amalgamated
// as build.mjs does, and runs it on a list of UTC epochs. Used by
// run-erfa-spice.mjs and ../nyx/make-itrf-bpc.mjs.
//
//   const frames = await buildHpopFrames(work, flatbuffersInclude)
//   frames.at(eopBin, utcs)  -> [{utc, jdTdb, c2t, ...}] (one per epoch)
//   frames.erfaFileCount
//   eopStream(work, CASES, id) -> path of the size-prefixed $EOP stream of an
//                                 Earth-orientation set of the case export
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { composeErfaTranslationUnit } from '../../../../../foundation/frames/erfa-amalgamation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const HPOP = path.resolve(here, '../../..');
export const REPO = path.resolve(HPOP, '../..');
export const DEFAULT_FLATBUFFERS = path.resolve(REPO, '../../main-packages/flatbuffers/include');
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export async function buildHpopFrames(work, flatbuffers = DEFAULT_FLATBUFFERS) {
  const erfa = await composeErfaTranslationUnit();
  const erfaUnit = path.join(work, 'erfa-amalgamation.cpp');
  fs.writeFileSync(erfaUnit, erfa.source);
  const bin = path.join(work, 'hpop-frames');
  const inc = [path.join(HPOP, 'lib'), path.join(HPOP, 'src'), path.join(HPOP, 'src/cpp/include'), path.join(HPOP, 'src/cpp/generated'),
    path.join(HPOP, 'src/cpp/generated/sds'), path.join(REPO, 'foundation/frames/src'), path.join(REPO, 'higherpop/third_party/erfa'), flatbuffers];
  // force_models.cpp is compiled inside the harness's translation unit (it
  // includes it for the file-local gmst2006); the rest of lib/ as the native
  // tests link it (tests/environment_conformance.test.mjs).
  const nrl = path.join(REPO, 'third_party/nrlmsise00'), hwm = path.join(REPO, 'third_party/hwm14');
  const objects = ['nrlmsise-00.c', 'nrlmsise-00_data.c'].map((c) => {
    const obj = path.join(work, `${c}.o`);
    execFileSync('cc', ['-std=c11', '-O2', '-c', path.join(nrl, c), '-o', obj], { stdio: 'inherit' });
    return obj;
  });
  execFileSync('c++', ['-std=c++17', '-O2', ...inc.flatMap((d) => ['-I', d]), '-I', nrl, '-I', hwm, path.join(here, 'hpop_frames_native.cpp'),
    ...['astrodynamics', 'coords', 'ephemeris', 'environment_models', 'atmosphere_winds', 'integrators', 'nrlmsise00', 'time_convert', 'us76', 'atmosphere_plugin']
      .map((f) => path.join(HPOP, 'lib', `${f}.cpp`)),
    path.join(hwm, 'hwm14.cpp'), path.join(hwm, 'hwm14_data.cpp'), ...objects, erfaUnit, '-o', bin], { stdio: 'inherit' });
  return {
    erfaFileCount: erfa.fileCount,
    at: (eopBin, utcs) => execFileSync(bin, [eopBin], { input: utcs.join('\n') + '\n', encoding: 'utf8', maxBuffer: 256 << 20 })
      .trim().split('\n').map((line) => JSON.parse(line)),
  };
}

// The size-prefixed $EOP stream the reference requests carry
// (tests/lib/orekitCases.mjs eopRows), checked against the case export.
export function eopStream(work, CASES, id) {
  const eop = CASES.earthOrientation[id].fixture;
  const fixturePath = path.join(REPO, eop.path);
  if (sha256(fixturePath) !== eop.sha256) throw new Error(`${id}: EOP fixture does not match the case export`);
  const eopBin = path.join(work, `${id}.bin`);
  fs.writeFileSync(eopBin, Buffer.from(JSON.parse(fs.readFileSync(fixturePath, 'utf8')).payloadBase64, 'base64'));
  return eopBin;
}
