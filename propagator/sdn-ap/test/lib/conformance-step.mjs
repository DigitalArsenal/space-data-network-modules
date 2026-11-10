// The conformance reproduction that E2Es end with (default FORCES keeps SGP4XP bit for bit, SPEC 16.8): conformance.e2e.mjs
// --reproduce test/results/conformance.json against the SGP4-XP oracle that SDN_AP_ORACLE_ROOT names (a black box this
// repository does not carry). With SDN_AP_ORACLE=skip instead, the step is the module's side alone (--digest-only: the
// SGP4XP corpus's and the SGP4 control's output digests against the stored run), and it says so. With neither, importing
// this file refuses, so a test stops at its start, not after its flights.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skip = process.env.SDN_AP_ORACLE === "skip";
if (!process.env.SDN_AP_ORACLE_ROOT && !skip) {
  throw new Error("SDN_AP_ORACLE_ROOT is not set. This E2E ends with the conformance reproduction against the SGP4-XP oracle " +
    "(closed-modules packages/sgp4-xp-oracle, the unmodified US Space Force library behind a black-box harness). Set " +
    "SDN_AP_ORACLE_ROOT to that harness directory, or SDN_AP_ORACLE=skip to reduce the step to the module's output digests.");
}

/** Runs the reproduction; throws when the run differs from the stored one. */
export function reproduceConformance() {
  const script = fileURLToPath(new URL("../conformance.e2e.mjs", import.meta.url));
  const stored = fileURLToPath(new URL("../results/conformance.json", import.meta.url));
  if (process.env.SDN_AP_ORACLE_ROOT) {
    execFileSync(process.execPath, [script, "--reproduce", stored], { stdio: "inherit" });
    return;
  }
  console.log("conformance reproduction: the oracle step is skipped (SDN_AP_ORACLE=skip); the module's output digests only");
  execFileSync(process.execPath, [script, "--digest-only", "--reproduce", stored], { stdio: "inherit" });
}
