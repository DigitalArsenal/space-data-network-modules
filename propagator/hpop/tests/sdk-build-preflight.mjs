// Read-only SDK admission probe. This does not build or replace HPOP artifacts.
// Supply SDN_MODULE_SDK_ROOT and SPACE_DATA_STANDARDS_ROOT for a private
// worktree without installed dependencies. Both roots must already exist.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'plugin-manifest.json'), 'utf8'));
const sdkRequire = process.env.SDN_MODULE_SDK_ROOT
  ? createRequire(path.join(path.resolve(process.env.SDN_MODULE_SDK_ROOT), 'package.json'))
  : require;
const compilerEntry = sdkRequire.resolve('space-data-module-sdk/compiler');
const { compileModuleFromSource, cleanupCompilation } = await import(pathToFileURL(compilerEntry));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : path.dirname(require.resolve('spacedatastandards.org/package.json'));
const sdkRoot = path.resolve(path.dirname(compilerEntry), '../..');
const version = root => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
console.log(`SDK preflight sdk=${version(sdkRoot)} standards=${version(standardsRoot)}`);

const temporaryRoot = fs.mkdtempSync(path.join(tmpdir(), 'hpop-sdk-preflight-'));
let compilation;
try {
  // The SDK checks this nonempty source argument, then validates the manifest
  // before selecting a compiler. The sentinel prevents accidentally presenting
  // this admission probe as a complete HPOP SDK build if the contract is fixed.
  compilation = await compileModuleFromSource({
    manifest,
    sourceCode: '#error HPOP_SDK_PREFLIGHT_ONLY_NO_IMPLEMENTATION_SOURCE\n',
    language: 'c++',
    standardsRoot,
    outputPath: path.join(temporaryRoot, 'module.wasm'),
  });
  console.error('SDK preflight unexpected success; this probe cannot certify an HPOP build.');
  process.exitCode = 1;
} catch (error) {
  const errors = error.report?.errors ?? error.report?.issues?.filter(issue => issue.severity === 'error');
  if (error.message === 'Manifest validation failed.' && errors) {
    console.error(`SDK BUILD BLOCKED: Manifest validation failed. errors=${errors.length}`);
    for (const issue of errors) console.error(`${issue.code}: ${issue.location}`);
    console.error('HPOP source preparation skipped: SDK rejected the manifest before compiler selection.');
  } else {
    console.error(`SDK preflight stopped: ${error.message}`);
    console.error('HPOP SDK build remains unverified; this probe contains no implementation source.');
  }
  process.exitCode = 1;
} finally {
  if (compilation) await cleanupCompilation(compilation);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
