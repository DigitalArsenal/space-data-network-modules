// The model truth's generator: propagator/ffm's build in this checkout (dist/isomorphic/module.wasm). A test that flies
// against the truth names, by SHA-256, the FFM build its bounds were derived on (requireTruth, at its top level so its
// worker threads declare it too); the truth libraries refuse to make or read a truth before that, or from another build.
// A new FFM build means re-deriving those bounds on its truth, then naming it.
// Measured 2026-11-10 (the same initial states, 7 days after a 72 h arc): FFM 2.0.4 (c36f1b14, the truth of the 2026-11-03
// registrations) against 2.2.1 (a9133120, from 2026-11-05): along-track / radial RMS at day 7 0.24 / 0.17 m on Molniya with
// drag, 0.22 / 0.14 m on GTO-500 with drag, 0.28 / 0.22 m half-day, 0.25 / 0.19 m 12 h at 55 deg, 2.54 / 1.91 m on GTO
// without drag; 2.2.1 against itself at tolerance 1e-13 and a 30 s step (the truth's 1e-12 and 300 s): 0.13 / 0.10 m on
// Molniya at day 7 (0.36 m at day 10). The truth is converged to well under a meter over the scored days.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ffmPath = fileURLToPath(new URL("../../../ffm/dist/isomorphic/module.wasm", import.meta.url));
const built = createHash("sha256").update(fs.readFileSync(ffmPath)).digest("hex");
let declared = null;

/** Declares the FFM build (SHA-256) this test's bounds were derived on; refuses another. */
export function requireTruth(sha256) {
  declared = sha256;
  checkTruth();
}

/** The truth libraries' check before every truth they make or read. */
export function checkTruth() {
  if (declared === null)
    throw new Error("model truth: the test names no FFM build (requireTruth): its bounds were derived on a truth nobody chose");
  if (declared !== built)
    throw new Error(`model truth: this test's bounds were derived on FFM ${declared.slice(0, 12)} and propagator/ffm/dist is ` +
      `${built.slice(0, 12)}: re-derive them on the new truth, then name it`);
}
