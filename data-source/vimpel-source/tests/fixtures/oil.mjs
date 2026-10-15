// $OIL readers for the tests. The standards checkout has the OIL bindings in TypeScript only (lib/ts/OIL), so they are
// bundled once with esbuild, with the flatbuffers runtime they were generated for, and imported from a temporary file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const standards = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vimpel-oil-'));
const entry = path.join(dir, 'entry.ts');
fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(standards, 'lib/ts/OIL/main.ts'))};\nexport { ByteBuffer } from 'flatbuffers';\n`);
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'oil.mjs'), nodePaths: [path.join(path.dirname(new URL(import.meta.url).pathname), '../../node_modules')], logLevel: 'error' });
const oil = await import(pathToFileURL(path.join(dir, 'oil.mjs')).href);
fs.rmSync(dir, { recursive: true, force: true });

export const { oilLinkStatus, oilConflictShape } = oil;
export const unpackOil = (bytes) => oil.OIL.getRootAsOIL(new oil.ByteBuffer(bytes)).unpack();
