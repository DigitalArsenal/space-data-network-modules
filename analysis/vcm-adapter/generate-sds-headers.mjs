#!/usr/bin/env node
/**
 * The C++ FlatBuffer headers this module reads and writes ($OCM, $PRW with
 * $EOP), generated with the pinned flatc-wasm from the pinned
 * spacedatastandards.org package (published-deps law). Families are returned
 * in dependency order, so build.mjs can concatenate them into one
 * translation unit with their cross-family includes dropped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createFlatc from 'flatc-wasm/module';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
// SPACE_DATA_STANDARDS_ROOT wins (a per-task standards worktree), else the package's own spacedatastandards.org.
export const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.join(packageRoot, 'node_modules', 'spacedatastandards.org');
// $FIL carries the VCM text in and out (the message ports).
export const ROOTS = ['PRW', 'OCM', 'FIL'];

export async function generateSdsHeaders() {
  const version = JSON.parse(fs.readFileSync(path.join(standardsRoot, 'package.json'), 'utf8')).version;
  const has = (family, field) => fs.readFileSync(path.join(standardsRoot, 'schema', family, 'main.fbs'), 'utf8').includes(field);
  for (const [family, field] of [['OCM', 'COV_PARAMETERS'], ['OCM', 'OD_DYNAMIC_PARAMETERS'], ['PRW', 'DYNAMIC_PARAMETERS'], ['PRW', 'EARTH_ORIENTATION'], ['FIL', 'CONTENT']]) {
    if (!has(family, field)) throw new Error(`spacedatastandards.org ${version} at ${standardsRoot} lacks ${family}.${field}.`);
  }
  const flatc = await createFlatc();
  const mkdir = (p) => { try { flatc.FS.mkdir(p); } catch {} };
  for (const p of ['/schemas', '/out']) mkdir(p);
  const dependencies = new Map();
  for (const family of fs.readdirSync(path.join(standardsRoot, 'schema'))) {
    const input = path.join(standardsRoot, 'schema', family, 'main.fbs');
    if (!fs.existsSync(input)) continue;
    const schema = fs.readFileSync(input, 'utf8');
    dependencies.set(family, [...schema.matchAll(/^\s*include\s+"\.\.\/([^/]+)\/main\.fbs"/gm)].map((m) => m[1]));
    mkdir(`/schemas/${family}`);
    flatc.FS.writeFile(`/schemas/${family}/main.fbs`, schema);
  }
  const families = [];
  const visit = (family) => { if (families.includes(family)) return; for (const d of dependencies.get(family) ?? []) visit(d); families.push(family); };
  ROOTS.forEach(visit);
  const headers = {};
  for (const family of families) {
    const rc = flatc.callMain(['--cpp', '--cpp-std', 'c++17', '--gen-object-api', '--preserve-case', '--no-warnings', '-I', '/schemas', '-o', '/out', `/schemas/${family}/main.fbs`]);
    if (rc !== 0) throw new Error(`flatc C++ failed: ${family}`);
    headers[family] = flatc.FS.readFile('/out/main_generated.h', { encoding: 'utf8' })
      .replaceAll('FLATBUFFERS_GENERATED_MAIN_H_', `FLATBUFFERS_GENERATED_${family}_MAIN_H_`)
      .replace(/^#include "main_generated\.h"\n/gm, '');
  }
  return { version, families, headers };
}
