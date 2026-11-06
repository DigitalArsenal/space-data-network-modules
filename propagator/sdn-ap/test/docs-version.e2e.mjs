#!/usr/bin/env node
// E2E (task modules-sdn-ap-docs-stale-headers-and-q-range-20261106): one version names one binary. The version headers of
// SPEC.md and README.md (the line `Version X.Y.Z (dist hhhhhhhh).` in the first five lines) name the version plugin-manifest.json
// and package.json carry and the first eight hex digits of the SHA-256 of the committed dist/isomorphic/module.wasm; no other
// `Version ...` line appears in either document. Fails on any header that names another version or another binary, and on
// the phrases "parts replaced" and "parts swapped" (AP is an advanced propagator that builds on the entire history of
// astrodynamics) in either document.
//   node test/docs-version.e2e.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(packageRoot, rel), "utf8");
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

const manifest = JSON.parse(read("plugin-manifest.json")).version;
const pkg = JSON.parse(read("package.json")).version;
check(/^\d+\.\d+\.\d+$/.test(manifest), `plugin-manifest.json version is not X.Y.Z: ${manifest}`);
check(pkg === manifest, `package.json ${pkg} != plugin-manifest.json ${manifest}`);
const wasm = fs.readFileSync(path.join(packageRoot, "dist/isomorphic/module.wasm"));
const dist = crypto.createHash("sha256").update(wasm).digest("hex").slice(0, 8);

const HEADER = /^Version (\d+\.\d+\.\d+) \(dist ([0-9a-f]{8})\)\.$/;
for (const doc of ["SPEC.md", "README.md"]) {
  const lines = read(doc).split("\n");
  const headers = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /^Version /.test(l));
  check(headers.length === 1, `${doc}: ${headers.length} 'Version' lines (${headers.map(([n]) => n).join(", ")}), expected one`);
  const head = lines.slice(0, 5).find((l) => /^Version /.test(l));
  if (!head) { failures.push(`${doc}: no version header in the first five lines`); continue; }
  const m = HEADER.exec(head);
  if (!m) { failures.push(`${doc}: header '${head}' is not 'Version X.Y.Z (dist hhhhhhhh).'`); continue; }
  check(m[1] === manifest, `${doc}: header names ${m[1]}, the manifest ${manifest}`);
  check(m[2] === dist, `${doc}: header names dist ${m[2]}, the committed module.wasm ${dist}`);
  for (const [i, l] of lines.entries()) {
    if (/parts (replaced|swapped)/i.test(l)) failures.push(`${doc}:${i + 1}: forbidden phrase '${l.match(/parts (replaced|swapped)/i)[0]}'`);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`DOCS-VERSION FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`DOCS-VERSION PASS: SPEC.md and README.md name ${manifest} (dist ${dist}) = plugin-manifest.json, package.json, dist/isomorphic/module.wasm`);
