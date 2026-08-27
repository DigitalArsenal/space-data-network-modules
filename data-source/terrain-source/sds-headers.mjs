// ── THE SDS C++ HEADERS COME FROM THE PUBLISHED PACKAGE ────────────────────
//
// Builds consume PUBLISHED packages (owner law 2026-08-21), and until now this
// lane's SDS half did not: both build scripts resolved the generated headers
// from `../../../spacedatastandards.org/lib/cpp/<CODE>/main_generated.h`, a
// SIBLING GIT CHECKOUT outside both repositories. `lib/cpp` is a build output
// of that repo and is not in the npm tarball at all, so the artifact could not
// be rebuilt by anyone who did not also have that checkout at that commit —
// and the artifact sha the report quoted depended on a directory no third
// party could obtain. The claim "built from published pins" was true of the
// SDK half and not of the SDS half.
//
// The published package DOES carry the same headers: spacedatastandards.org
// ships `dist/<CODE>/<CODE>.cpp.tar.gz`, one gzipped tar per standard holding
// `<CODE>/main_generated.h`. Verified byte-identical to the checkout's
// lib/cpp copy for both standards this lane inlines (DTT, IRM) at 1.196.0.
//
// So the package is the source, resolved through node's own resolver at the
// version package.json pins. SPACE_DATA_STANDARDS_ROOT still wins when it is
// set explicitly — that is how the standards repo itself builds against an
// unpublished change — and taking it is stated out loud rather than silently
// preferred, because a build that quietly used a local checkout is exactly how
// the provenance claim went wrong.

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

// Minimal gzipped-tar reader. One header block per entry, 512-byte blocks,
// name in the first 100 bytes and size as octal at offset 124 — enough for a
// flatc output tarball and nothing more, so there is no dependency to audit.
function readTarEntry(buffer, wanted) {
  for (let at = 0; at + 512 <= buffer.length; ) {
    const name = buffer.subarray(at, at + 100).toString("utf8").replace(/\0.*$/, "");
    if (name === "") break;
    const size = parseInt(buffer.subarray(at + 124, at + 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
    const body = at + 512;
    if (name === wanted || name.endsWith(`/${wanted}`)) {
      return buffer.subarray(body, body + size).toString("utf8");
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

// TWO LAYOUTS, ONE ROOT. A published tarball carries the generated header
// inside `dist/<CODE>/<CODE>.cpp.tar.gz`; a git checkout of the standards repo
// carries the same bytes unpacked at `lib/cpp/<CODE>/main_generated.h`, which
// is a build output and is NOT in the tarball. Verified byte-identical for the
// standards this lane inlines at 1.196.0. Whichever the root has is used, so
// SPACE_DATA_STANDARDS_ROOT works for a checkout and for a package alike.
async function headerFromRoot(root, code) {
  const unpacked = path.join(root, "lib", "cpp", code, "main_generated.h");
  try {
    return await fs.readFile(unpacked, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const archive = path.join(root, "dist", code, `${code}.cpp.tar.gz`);
  const packed = await fs.readFile(archive).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!packed) return null;
  return readTarEntry(zlib.gunzipSync(packed), "main_generated.h");
}

// `from` is the module URL of the caller, so the package resolves against the
// caller's own node_modules rather than this file's.
export async function readSdsHeader(code, from) {
  const override = process.env.SPACE_DATA_STANDARDS_ROOT;
  const require = createRequire(from);
  const packageJson = require.resolve("spacedatastandards.org/package.json");
  const root = override ? path.resolve(override) : path.dirname(packageJson);
  const version = JSON.parse(await fs.readFile(packageJson, "utf8")).version;
  const header = await headerFromRoot(root, code);
  if (!header) {
    throw new Error(
      `no generated C++ header for $${code} under ${root} (looked for ` +
        `lib/cpp/${code}/main_generated.h and dist/${code}/${code}.cpp.tar.gz); ` +
        `the pin is wrong or the standard is not in this release`,
    );
  }
  const provenance =
    override && path.resolve(override) !== path.dirname(packageJson)
      ? `SPACE_DATA_STANDARDS_ROOT override -> ${root}`
      : `spacedatastandards.org@${version} (published)`;
  console.log(`[sds] ${code}: ${provenance}`);
  return header;
}

export async function sdsPackageVersion(from) {
  if (process.env.SPACE_DATA_STANDARDS_ROOT) return "SPACE_DATA_STANDARDS_ROOT override";
  const require = createRequire(from);
  return JSON.parse(
    await fs.readFile(require.resolve("spacedatastandards.org/package.json"), "utf8"),
  ).version;
}

// ── THE VALIDATOR HAS TO SEE THE SAME PACKAGE THE HEADERS CAME FROM ────────
//
// The SDK validates a manifest's type references against a standards catalog
// it loads from `spacedatastandards.org/dist/manifest.json`, resolved from the
// SDK's OWN module location — and the SDK carries its own pinned copy of the
// standards package as a nested dependency (a GitHub tarball pin, 1.178.0 at
// SDK 0.8.15). npm therefore nests it under
// node_modules/space-data-module-sdk/node_modules/, and the validator reads
// THAT one, not the version this package pins. $DTT and $IRM do not exist in
// 1.178.0, so a manifest naming them fails validation with
// `unresolved-standards-type` even though the headers compiled fine.
//
// The lane's previous build hid this by pointing SPACE_DATA_STANDARDS_ROOT at
// a local git checkout, which made the build depend on a directory outside
// both repositories. Pointing it at the PUBLISHED package this package.json
// pins keeps the validator and the inlined headers on the same bytes, and
// those bytes are ones a third party can install.
export function publishedStandardsRoot(from) {
  const require = createRequire(from);
  return path.dirname(require.resolve("spacedatastandards.org/package.json"));
}
