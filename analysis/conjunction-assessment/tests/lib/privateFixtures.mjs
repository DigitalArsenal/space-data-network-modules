// CelesTrak GP element sets and SOCRATES conjunction data (tests/fixtures/decaying
// and tests/fixtures/socrates) are not redistributable: GP data come from
// Space-Track, and SOCRATES is CelesTrak's own product with no licence. They live
// under $SDN_MODULES_PRIVATE_FIXTURES, mirroring this repository's paths, and the
// tests that screen them skip with a message when they are absent.
import fs from 'node:fs';
import { privatePath, privateSkip } from '../../../../tests/lib/privateFixtures.mjs';

const BASE = 'analysis/conjunction-assessment/tests/fixtures/';

// The path of a private fixture ('socrates/reference.top3.json'), or null.
export const privateFixturePath = (name) => privatePath(BASE + name);

// For node:test's `skip`: false when every named fixture is present.
export function privateFixtureSkip(...names) {
  for (const name of names) {
    const reason = privateSkip(BASE + name);
    if (reason) return reason;
  }
  return false;
}

// Parsed JSON of a private fixture, or `fallback` when it is absent (the tests
// that need it are skipped, so the fallback only keeps the module loadable).
export function readPrivateFixtureJson(name, fallback = []) {
  const file = privateFixturePath(name);
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}
