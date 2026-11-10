// The one place the module's tests write (caches, test builds, copies of earlier releases): SDN_AP_TEST_SCRATCH, or
// sdn-ap-test-scratch under the operating system's temporary directory. A test builds or computes everything it reads
// there; nothing it needs is expected to be there before it runs. Never a home directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const scratchRoot = path.resolve(process.env.SDN_AP_TEST_SCRATCH || path.join(os.tmpdir(), "sdn-ap-test-scratch"));
{
  const home = path.resolve(os.homedir()), rel = path.relative(home, scratchRoot);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
    throw new Error(`test scratch ${scratchRoot} is under the home directory ${home}: set SDN_AP_TEST_SCRATCH to a folder outside it`);
}

/** The folder scratchRoot/...parts, created. */
export function scratchDir(...parts) {
  const dir = path.join(scratchRoot, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A new empty folder under scratchRoot whose name starts with `prefix` (for a test that removes its own). */
export function scratchTemp(prefix) {
  fs.mkdirSync(scratchRoot, { recursive: true });
  return fs.mkdtempSync(path.join(scratchRoot, prefix));
}
