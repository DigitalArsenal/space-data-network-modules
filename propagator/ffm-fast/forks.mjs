import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { packageRoot, standardRoot } from './standard.mjs';

// Build and verification use the same inventory of deliberately forked sources.
export const FORK_PATHS = Object.freeze([
  'lib/force_models.cpp',
  'src/cpp/src/resident_dynamics.cpp',
  'src/cpp/include/ffm/resident_dynamics.h',
  'src/ffm_plugin.cpp',
]);

export function inspectForkBases() {
  return Object.fromEntries(FORK_PATHS.map(relative => {
    const source = fs.readFileSync(path.join(packageRoot, relative), 'utf8');
    const base = source.match(/^\/\/\s*FFM Fast fork base:\s*(.+)$/m)?.[1]?.trim();
    const recorded = source.match(/^\/\/\s*Fork base sha256:\s*([a-f0-9]{64})$/mi)?.[1];
    const actual = createHash('sha256').update(fs.readFileSync(path.join(standardRoot, relative))).digest('hex');
    if (!base || recorded !== actual)
      throw new Error(`Standard ${relative} changed; merge it into the Fast fork and update its base SHA-256.`);
    return [relative, { path: base, sha256: recorded }];
  }));
}
