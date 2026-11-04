#!/usr/bin/env node
// One spacedatastandards.org release for the repository root and every module under the module roots.
//
//   node scripts/sds-pin-check.mjs --expect <version> [--headers]
//
// Exit 1 naming every tracked package.json under ROOTS whose pin of spacedatastandards.org (any dependency kind) is
// not exactly <version>. With --headers, also every tracked *_generated.h under ROOTS that defines the MET enum
// (meanElementSource) without `AP = 5`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'spacedatastandards.org';
const ROOTS = ['analysis', 'data-source', 'propagator', 'files', 'flows'];
const DEPENDENCY_KINDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const args = process.argv.slice(2);
const expectAt = args.indexOf('--expect');
const expected = expectAt >= 0 ? args[expectAt + 1] : undefined;
if (!expected || !/^\d+\.\d+\.\d+$/.test(expected)) {
  console.error('usage: node scripts/sds-pin-check.mjs --expect <major.minor.patch> [--headers]');
  process.exit(2);
}
const headers = args.includes('--headers');

const tracked = (patterns) => execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...patterns], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0').filter(Boolean);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const failures = [];
const manifests = ['package.json', ...tracked(ROOTS.map((dir) => `${dir}/**/package.json`))];
let pinned = 0;
for (const file of manifests) {
  const manifest = JSON.parse(read(file));
  for (const kind of DEPENDENCY_KINDS) {
    const spec = manifest[kind]?.[PACKAGE];
    if (spec === undefined) continue;
    pinned += 1;
    if (spec !== expected) failures.push(`${file}: ${kind} ${PACKAGE} ${spec}, expected ${expected}`);
  }
}

let headerCount = 0;
if (headers) {
  for (const file of tracked(ROOTS.map((dir) => `${dir}/**/*_generated.h`))) {
    const enumBlock = read(file).match(/enum class meanElementSource\b[^{]*\{([^}]*)\}/);
    if (!enumBlock) continue;
    headerCount += 1;
    if (!/\bAP = 5\b/.test(enumBlock[1])) failures.push(`${file}: MET meanElementSource lacks AP = 5`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  console.error(`SDS PIN: ${failures.length} differ from ${expected}`);
  process.exit(1);
}
console.log(`${pinned} pins${headers ? `, ${headerCount} MET headers` : ''} checked`);
console.log(`SDS PIN: ${expected} everywhere`);
