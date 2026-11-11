// The one place the module's tests write (caches, test builds, copies of earlier releases): SDN_AP_TEST_SCRATCH, or
// sdn-ap-test-scratch-<tag> under the operating system's temporary directory, the tag a hash of this checkout's real path
// (and of nothing else), so two clones never share a folder and reruns in one clone reuse their caches. A test builds or
// computes everything it reads there; nothing it needs is expected to be there before it runs. Never a home directory.
// sharedRoot holds only caches whose file names are the SHA-256 of everything that made them (the model truths of
// test/lib/heo-model-truth.mjs and test/lib/synthetic-truth.mjs: FFM's build and every byte of its request), written
// whole or not at all (writeWhole), so any clone may read what another wrote.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** The default scratch root of the checkout at `repo` (its real path when it exists). */
export function scratchRootFor(repo) {
  const real = fs.existsSync(repo) ? fs.realpathSync(repo) : path.resolve(repo);
  return path.join(os.tmpdir(), `sdn-ap-test-scratch-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`);
}

export const scratchRoot = path.resolve(process.env.SDN_AP_TEST_SCRATCH || scratchRootFor(repoRoot));
export const sharedRoot = path.resolve(process.env.SDN_AP_TEST_SCRATCH ? path.join(process.env.SDN_AP_TEST_SCRATCH, "shared")
  : path.join(os.tmpdir(), "sdn-ap-test-scratch-shared"));
for (const root of [scratchRoot, sharedRoot]) {
  const home = path.resolve(os.homedir()), rel = path.relative(home, root);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
    throw new Error(`test scratch ${root} is under the home directory ${home}: set SDN_AP_TEST_SCRATCH to a folder outside it`);
}

/** The folder scratchRoot/...parts, created. */
export function scratchDir(...parts) {
  const dir = path.join(scratchRoot, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The folder sharedRoot/...parts, created: only for content-named caches written by writeWhole. */
export function sharedDir(...parts) {
  const dir = path.join(sharedRoot, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes `file` whole or not at all (a temporary file renamed over it), so a reader never sees part of it. */
export function writeWhole(file, data) {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

/** A new empty folder under scratchRoot whose name starts with `prefix` (for a test that removes its own). */
export function scratchTemp(prefix) {
  fs.mkdirSync(scratchRoot, { recursive: true });
  return fs.mkdtempSync(path.join(scratchRoot, prefix));
}
