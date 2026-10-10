// Fixtures that this repository may not redistribute.
//
// Data whose terms do not allow a public copy (no licence stated, or terms that
// exclude redistribution) is kept outside the repository, in a directory that
// mirrors the repository's own paths:
//
//   $SDN_MODULES_PRIVATE_FIXTURES/<path of the file inside this repository>
//
// The archive host keeps it at
// /opt/data/sdn-archive/private-fixtures/space-data-network-modules. A test
// that needs such a file asks for it here and skips, with the reason, when the
// variable is not set or the file is not there. Nothing in the tree depends on
// a private file being present.
import fs from 'node:fs';
import path from 'node:path';

export const PRIVATE_FIXTURES_ENV = 'SDN_MODULES_PRIVATE_FIXTURES';

// The private root, or null when the variable is not set.
export function privateFixturesRoot() {
  const root = process.env[PRIVATE_FIXTURES_ENV];
  return root ? path.resolve(root) : null;
}

// The private copy of a repository-relative path, or null when it is absent.
export function privatePath(relativePath) {
  const root = privateFixturesRoot();
  if (!root) return null;
  const candidate = path.join(root, relativePath);
  return fs.existsSync(candidate) ? candidate : null;
}

// For node:test's `skip` option: false when the private path is present, else
// the message that says what to set.
export function privateSkip(relativePath) {
  if (!privateFixturesRoot()) return `${PRIVATE_FIXTURES_ENV} is not set (private fixture ${relativePath})`;
  if (!privatePath(relativePath)) return `private fixture ${relativePath} is not under ${PRIVATE_FIXTURES_ENV}`;
  return false;
}
