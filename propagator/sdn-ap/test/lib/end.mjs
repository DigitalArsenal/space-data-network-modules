// The ending of a test that starts pool threads (SPEC 9): the pool's threads wait for batches for the life of the instance and the module has no
// export that stops them, so a Node process that started a pool ends only when the host destroys the instance's harness (which terminates the
// wasi-thread workers) or ends the process. A test registers every harness it opens with ownHarness (test/lib/module.mjs and
// test/lib/frame-cells.mjs do it for theirs) and ends with `await endTest(status)`: the harnesses are destroyed, the exit code is set, and a process
// that is still alive after DEADLINE_MS says so and ends with the test's status. test/pool-end.e2e.mjs shows the destroy ends a pool by itself.
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";

const DEADLINE_MS = 20000;
const owned = new Set();

export const ownHarness = (h) => { owned.add(h); return h; };
export const createOwnedHarness = async (...args) => ownHarness(await createStandaloneHarness(...args));

export async function endTest(status = 0) {
  const timer = setTimeout(() => {
    console.error(`endTest: the process was still alive ${DEADLINE_MS / 1000} s after the harnesses were destroyed; ending it with status ${status}`);
    process.exit(status);
  }, DEADLINE_MS);
  timer.unref();
  for (const h of owned) { try { await h.destroy?.(); } catch (e) { console.error(`endTest: destroy failed: ${e.message}`); } }
  owned.clear();
  process.exitCode = status;
}
