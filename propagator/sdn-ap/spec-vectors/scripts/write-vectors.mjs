#!/usr/bin/env node
// Test-fixture writer: rebuilds ../vectors.json from fresh black-box oracle calls (build() in ../generate.mjs).
// Usage (from the modules repository root): SDN_AP_ORACLE_ROOT=<closed-modules>/packages/sgp4-xp-oracle node propagator/sdn-ap/spec-vectors/scripts/write-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const v = await build();
fs.writeFileSync(path.join(here, '..', 'vectors.json'), `${JSON.stringify(v)}\n`);
console.log('wrote vectors.json', Object.fromEntries(Object.entries(v.sections).map(([k, a]) => [k, a.length])));
