#!/usr/bin/env node
// Every module's pin of spacedatastandards.org, and the proof that the modules carrying generated SDS bindings carry
// bindings generated from the release they pin.
//
//   node scripts/check-sds-pins.mjs
//
// The report lists every package.json that names the standards package, by pin. The modules in TOUCHED are held to
// the pin: it is exact, it is one release for all of them, the lockfile and the installed package are that release, and
// what is generated from the release (the vendored C++ headers and JavaScript bindings, regenerated here in a scratch
// copy and compared byte for byte; the version a dist records; the Python bindings' lock) matches it. A module is added
// to TOUCHED when a refresh gives it bindings generated from a pin. Exit 1 on any mismatch.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'spacedatastandards.org';
const DEPENDENCY_KINDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const GENERATOR = 'generate-sds-headers.mjs';

// headers: the directories the module's generator writes, regenerated from the installed release and compared with the
// tracked files. dist: where the module's last build records the release it ran against.
const TOUCHED = {
  'licensing/core': { headers: ['src/cpp/generated/sds'] },
  'propagator/sgp4': { headers: ['src/cpp/generated/sds'] },
  'analysis/epoch-state': { headers: ['src/generated/sds'], dist: (provenance) => provenance.spacedatastandards },
  'analysis/conjunction-assessment': { headers: ['src/cpp/generated/sds', 'src/js/sds'], dist: (provenance) => provenance.standards?.version },
  'analysis/vcm-adapter': { dist: (provenance) => provenance.spacedatastandards },
  'analysis/density-calibration': { dist: (provenance) => provenance.spacedatastandards },
  'analysis/catalog-composer': { dist: (provenance) => provenance.spacedatastandards, xmt: true },
};
const PYTHON_ASTRO = 'packages/python-astro';

const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const release = (version) => String(version).split('+')[0];
const tracked = (directory) => execFileSync('git', ['-C', root, 'ls-files', '-z', '--', directory], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0').filter(Boolean);

// ---- the report: every package.json that names the standards package ----
const pins = [];
for (const file of tracked('*package.json').filter((name) => path.posix.basename(name) === 'package.json')) {
  const manifest = readJson(file);
  for (const kind of DEPENDENCY_KINDS) {
    if (manifest[kind]?.[PACKAGE] !== undefined) pins.push({ module: path.posix.dirname(file), kind, spec: manifest[kind][PACKAGE] });
  }
}
pins.sort((a, b) => a.module.localeCompare(b.module));
const touchedModules = new Set(Object.keys(TOUCHED));
console.log(`${PACKAGE} pinned by ${pins.length} package.json files:`);
for (const pin of pins) {
  console.log(`  ${pin.spec.padEnd(10)} ${pin.module}${touchedModules.has(pin.module) ? '  [touched]' : ''}${/^\d+\.\d+\.\d+$/.test(pin.spec) ? '' : '  (range)'}`);
}
const histogram = new Map();
for (const pin of pins) histogram.set(pin.spec, (histogram.get(pin.spec) ?? 0) + 1);
console.log(`by pin: ${[...histogram].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([spec, count]) => `${spec} x${count}`).join(', ')}`);

// ---- the touched modules ----
const releases = new Map();
const noteRelease = (where, version) => releases.set(where, release(version));

function files(directory) {
  const found = [];
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(next); else found.push(next.split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(directory)) visit('');
  return found.sort();
}

// The module's own generator, run in a scratch copy of the module (its package.json, the generator, its node_modules),
// so the committed tree is never written. The installed release is what it reads: no override.
function regenerate(module, outputs, scratch) {
  const work = path.join(scratch, module.replaceAll('/', '__'));
  fs.mkdirSync(work, { recursive: true });
  for (const name of ['package.json', GENERATOR]) fs.copyFileSync(path.join(root, module, name), path.join(work, name));
  fs.symlinkSync(path.join(root, module, 'node_modules'), path.join(work, 'node_modules'), 'dir');
  const env = { ...process.env };
  delete env.SPACE_DATA_STANDARDS_ROOT;
  execFileSync(process.execPath, [GENERATOR], { cwd: work, env, stdio: 'pipe' });
  for (const output of outputs) {
    const generated = files(path.join(work, output));
    const committed = tracked(`${module}/${output}`).map((name) => name.slice(`${module}/${output}/`.length));
    for (const name of generated.filter((file) => !committed.includes(file))) fail(module, `${output}/${name} is generated from ${PACKAGE} ${releases.get(module)} but not committed`);
    for (const name of committed.filter((file) => !generated.includes(file))) fail(module, `${output}/${name} is committed but the release no longer generates it`);
    for (const name of generated.filter((file) => committed.includes(file))) {
      const now = fs.readFileSync(path.join(work, output, name));
      const then = fs.readFileSync(path.join(root, module, output, name));
      if (!now.equals(then)) fail(module, `${output}/${name} differs from what ${PACKAGE} ${releases.get(module)} generates`);
    }
  }
}

// The real path: a generator that runs only as the main module compares its import.meta.url, which is real, with its argv.
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-sds-pins-'));
try {
  for (const [module, expectations] of Object.entries(TOUCHED)) {
    const pin = pins.find((entry) => entry.module === module);
    if (!pin) { fail(module, `package.json does not name ${PACKAGE}`); continue; }
    if (!/^\d+\.\d+\.\d+$/.test(pin.spec)) { fail(module, `${pin.kind} pins ${PACKAGE} ${pin.spec}, not an exact release`); continue; }
    noteRelease(module, pin.spec);

    const lockFile = `${module}/package-lock.json`;
    if (fs.existsSync(path.join(root, lockFile))) {
      const lock = readJson(lockFile);
      const wanted = lock.packages?.['']?.[pin.kind]?.[PACKAGE];
      const locked = lock.packages?.[`node_modules/${PACKAGE}`]?.version;
      if (wanted !== pin.spec) fail(module, `package-lock.json asks for ${PACKAGE} ${wanted}, package.json pins ${pin.spec}`);
      if (locked !== pin.spec) fail(module, `package-lock.json resolves ${PACKAGE} ${locked}, package.json pins ${pin.spec}`);
    } else fail(module, 'no package-lock.json to hold the pin');

    const installed = path.join(root, module, 'node_modules', PACKAGE, 'package.json');
    if (!fs.existsSync(installed)) { fail(module, `${PACKAGE} is not installed (npm ci, or node tools/deps-bundle/deps-bundle.mjs attach ${module})`); continue; }
    const installedVersion = JSON.parse(fs.readFileSync(installed, 'utf8')).version;
    if (release(installedVersion) !== pin.spec) { fail(module, `installed ${PACKAGE} is ${installedVersion}, package.json pins ${pin.spec}`); continue; }

    if (expectations.headers) {
      try { regenerate(module, expectations.headers, scratch); } catch (error) { fail(module, `the generator failed: ${String(error.stderr || error.message).trim().split('\n').slice(-3).join(' | ')}`); }
    }
    if (expectations.dist) {
      const provenanceFile = `${module}/dist/build-provenance.json`;
      if (!fs.existsSync(path.join(root, provenanceFile))) fail(module, 'dist/build-provenance.json is missing, so the dist records no release');
      else {
        const recorded = expectations.dist(readJson(provenanceFile));
        if (recorded === undefined || release(recorded) !== pin.spec) fail(module, `dist/build-provenance.json records ${PACKAGE} ${recorded}, package.json pins ${pin.spec}`);
      }
    }
    if (expectations.xmt) {
      // dist/sds/xmt.mjs is bundled from the release's TypeScript; bundle it again from the installed release.
      const { bundleXmt } = await import(pathToFileURL(path.join(root, module, 'sds-headers.mjs')).href);
      const again = path.join(scratch, 'xmt.mjs');
      await bundleXmt(path.join(root, module, 'node_modules', PACKAGE), again);
      if (!fs.readFileSync(again).equals(fs.readFileSync(path.join(root, module, 'dist/sds/xmt.mjs')))) fail(module, `dist/sds/xmt.mjs differs from what ${PACKAGE} ${pin.spec} bundles`);
    }
  }

  // ---- the Python bindings: vendored from a recorded SDS revision, hashed in bindings.lock.json ----
  const vendorScript = fs.readFileSync(path.join(root, PYTHON_ASTRO, 'scripts/vendor_sds.py'), 'utf8');
  const pinned = { version: /^SDS_VERSION = "([^"]+)"$/m.exec(vendorScript)?.[1], revision: /^SDS_REVISION = "([0-9a-f]{40})"$/m.exec(vendorScript)?.[1] };
  console.log(`  ${String(pinned.version).padEnd(10)} ${PYTHON_ASTRO}  [touched] (scripts/vendor_sds.py ${String(pinned.revision).slice(0, 12)})`);
  if (!pinned.version || !pinned.revision) fail(PYTHON_ASTRO, 'scripts/vendor_sds.py does not state SDS_VERSION and SDS_REVISION');
  else {
    noteRelease(PYTHON_ASTRO, pinned.version);
    const lockPath = `${PYTHON_ASTRO}/src/spacedatanetwork_astro/bindings.lock.json`;
    const lock = readJson(lockPath);
    if (release(lock.sds?.version) !== pinned.version) fail(PYTHON_ASTRO, `bindings.lock.json records SDS ${lock.sds?.version}, vendor_sds.py pins ${pinned.version}`);
    if (lock.sds?.revision !== pinned.revision) fail(PYTHON_ASTRO, `bindings.lock.json records revision ${lock.sds?.revision}, vendor_sds.py pins ${pinned.revision}`);
    if ((lock.unresolved_imports ?? []).length) fail(PYTHON_ASTRO, `bindings.lock.json records ${lock.unresolved_imports.length} unresolved imports`);
    const base = path.join(root, PYTHON_ASTRO, 'src/spacedatanetwork_astro');
    const recorded = Object.keys(lock.generated_sha256).filter((name) => name.startsWith('sds/'));
    const present = files(path.join(base, 'sds')).filter((name) => !name.split('/').includes('__pycache__')).map((name) => `sds/${name}`);
    for (const name of present.filter((file) => !recorded.includes(file))) fail(PYTHON_ASTRO, `${name} is not in bindings.lock.json`);
    for (const name of recorded) {
      if (!fs.existsSync(path.join(base, name))) fail(PYTHON_ASTRO, `${name} is in bindings.lock.json but missing`);
      else if (sha256(fs.readFileSync(path.join(base, name))) !== lock.generated_sha256[name]) fail(PYTHON_ASTRO, `${name} differs from its hash in bindings.lock.json`);
    }
  }

  // ---- one release for everything this refresh touched ----
  const distinct = new Set(releases.values());
  if (distinct.size > 1) fail('touched modules', `pin different releases: ${[...releases].map(([where, version]) => `${where} ${version}`).join(', ')}`);
  if (!failures.length) console.log(`PASS: ${releases.size} touched modules generate their bindings from ${PACKAGE} ${[...distinct].join('')}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (failures.length) {
  console.log(`FAIL: ${failures.length} mismatch${failures.length === 1 ? '' : 'es'}:`);
  for (const message of failures) console.log(`  ${message}`);
  process.exit(1);
}
