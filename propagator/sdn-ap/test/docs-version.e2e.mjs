#!/usr/bin/env node
// E2E (task modules-sdn-ap-docs-stale-headers-and-q-range-20261106): one version names one binary. The version headers of
// SPEC.md and README.md (the line `Version X.Y.Z (dist hhhhhhhh).` in the first five lines) name the version plugin-manifest.json
// and package.json carry and the first eight hex digits of the SHA-256 that identifies the committed dist/isomorphic/module.wasm;
// no other `Version ...` line appears in either document. Fails on any header that names another version or another binary,
// and on the phrases "parts replaced" and "parts swapped" (AP is an advanced propagator that builds on the entire history of
// astrodynamics) in either document. Also fails when the vendored replay harness registers an install (its build.json
// `packages`) other than the version that folder's committed package-lock.json pins.
//
// Two identity forms, by version (ruling 2026-11-06). Through 0.6.3 the dist ships raw (its sds.manifest section embedded, no
// trailer) and the header names the whole-file SHA-256: `Version 0.6.3 (dist hhhhhhhh).` From 0.6.4 the dist ships signed: the
// SDK's trailer writer moves the sds.* sections into the publication trailer, so the header names the canonical module (the
// module section with sds.* stripped, what the signature covers) and, beside it, the whole signed file:
// `Version X.Y.Z (dist hhhhhhhh, bundle hhhhhhhh).` An unsigned dist of such a version names the canonical module alone.
//   node test/docs-version.e2e.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(packageRoot, rel), "utf8");
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

const manifest = JSON.parse(read("plugin-manifest.json")).version;
const pkg = JSON.parse(read("package.json")).version;
check(/^\d+\.\d+\.\d+$/.test(manifest), `plugin-manifest.json version is not X.Y.Z: ${manifest}`);
check(pkg === manifest, `package.json ${pkg} != plugin-manifest.json ${manifest}`);
const { toLoadableWasmBytes, computeCanonicalModuleHash } = await import(
  pathToFileURL(createRequire(path.join(packageRoot, "package.json")).resolve("space-data-module-sdk/bundle")).href
);
const file = new Uint8Array(fs.readFileSync(path.join(packageRoot, "dist/isomorphic/module.wasm")));
const section = toLoadableWasmBytes(file);
const sha8 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
const compareVersions = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const rawForm = compareVersions(manifest, "0.6.4") < 0;
const bundled = section.length !== file.length;
// what the header must say: the whole raw file through 0.6.3; the canonical module (and the signed file) from 0.6.4
const dist = rawForm ? sha8(file) : (await computeCanonicalModuleHash(section)).hashHex.slice(0, 8);
const bundle = rawForm || !bundled ? null : sha8(file);
const expectedHeader = `Version ${manifest} (dist ${dist}${bundle ? `, bundle ${bundle}` : ""}).`;

const HEADER = /^Version (\d+\.\d+\.\d+) \(dist ([0-9a-f]{8})(?:, bundle ([0-9a-f]{8}))?\)\.$/;
for (const doc of ["SPEC.md", "README.md"]) {
  const lines = read(doc).split("\n");
  const headers = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /^Version /.test(l));
  check(headers.length === 1, `${doc}: ${headers.length} 'Version' lines (${headers.map(([n]) => n).join(", ")}), expected one`);
  const head = lines.slice(0, 5).find((l) => /^Version /.test(l));
  if (!head) { failures.push(`${doc}: no version header in the first five lines`); continue; }
  const m = HEADER.exec(head);
  if (!m) { failures.push(`${doc}: header '${head}' is not 'Version X.Y.Z (dist hhhhhhhh).' or 'Version X.Y.Z (dist hhhhhhhh, bundle hhhhhhhh).'`); continue; }
  check(m[1] === manifest, `${doc}: header names ${m[1]}, the manifest ${manifest}`);
  check(m[2] === dist, `${doc}: header names dist ${m[2]}, the committed module.wasm ${dist} (${rawForm ? "whole raw file" : "canonical module"})`);
  check((m[3] ?? null) === bundle, `${doc}: header '${head}' should read '${expectedHeader}'`);
  for (const [i, l] of lines.entries()) {
    if (/parts (replaced|swapped)/i.test(l)) failures.push(`${doc}:${i + 1}: forbidden phrase '${l.match(/parts (replaced|swapped)/i)[0]}'`);
  }
}

// The vendored replay harness's registered installs (test/vendor/.../xp-atmosphere-merit/build.json `packages`, which its
// modulesRoot() guard compares with the installs) equal what each folder's committed package-lock.json pins: a pin bump
// that leaves the registration behind stops the seven archive replays at the guard (2026-11-05 to 2026-11-10).
const modulesRoot = path.resolve(packageRoot, "..", "..");
const vendored = JSON.parse(read("test/vendor/orbit-accuracy-experiments-c89f2bc/experiments/xp-atmosphere-merit/build.json"));
let registered = 0;
for (const [rel, packages] of Object.entries(vendored.packages)) {
  const lock = JSON.parse(fs.readFileSync(path.join(modulesRoot, rel, "package-lock.json"), "utf8")).packages;
  for (const [name, version] of Object.entries(packages)) {
    const pinned = lock[`node_modules/${name}`]?.version;
    check(pinned === version, `vendored build.json registers ${rel} ${name} ${version}, ${rel}/package-lock.json pins ${pinned}`);
    registered += 1;
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`DOCS-VERSION FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`DOCS-VERSION PASS: SPEC.md and README.md read '${expectedHeader}' = plugin-manifest.json, package.json, dist/isomorphic/module.wasm (${rawForm ? "raw form, whole-file sha256" : `signed form, canonical module sha256${bundle ? " and whole signed file" : ""}`}); the vendored replay harness registers ${registered} installs, each its folder's lockfile pin`);
