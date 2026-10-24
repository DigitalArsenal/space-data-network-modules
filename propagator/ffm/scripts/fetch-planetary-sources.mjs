#!/usr/bin/env node
// Downloads the public planetary sources listed in scripts/planetary-sources.json into
// <dir>/<source directory>/ and verifies each against its pinned SHA-256 (and byte length). Nothing it
// fetches is executed; each source gets its own directory.
//
//   node scripts/fetch-planetary-sources.mjs <dir> [source ...]      all sources, or the named ones
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'planetary-sources.json'), 'utf8'));
const [dir, ...names] = process.argv.slice(2);
if (!dir) throw new Error('usage: fetch-planetary-sources.mjs <dir> [source ...]');
const wanted = names.length ? names : Object.keys(manifest.sources);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
for (const name of wanted) {
  const spec = manifest.sources[name];
  if (!spec) throw new Error(`Unknown source ${name}`);
  const target = path.join(dir, spec.directory, spec.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let bytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (!bytes || sha(bytes) !== spec.sha256) {
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`${spec.url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(target, bytes);
  }
  if (bytes.length !== spec.bytes || sha(bytes) !== spec.sha256) throw new Error(`${spec.file}: expected ${spec.bytes} bytes with SHA-256 ${spec.sha256}, got ${bytes.length} with ${sha(bytes)}`);
  if (spec.labelUrl) {
    const label = path.join(dir, spec.directory, spec.labelFile);
    let text = fs.existsSync(label) ? fs.readFileSync(label) : null;
    if (!text || sha(text) !== spec.labelSha256) {
      const response = await fetch(spec.labelUrl);
      if (!response.ok) throw new Error(`${spec.labelUrl}: HTTP ${response.status}`);
      text = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(label, text);
    }
    if (sha(text) !== spec.labelSha256) throw new Error(`${spec.labelFile}: SHA-256 differs from the pinned ${spec.labelSha256}`);
  }
  console.log(`${name}: ${spec.file} ${bytes.length} bytes verified`);
}
