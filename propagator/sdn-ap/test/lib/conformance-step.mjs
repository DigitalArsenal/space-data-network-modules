// The conformance step that E2Es end with (default FORCES keeps SGP4XP bit for bit, SPEC 16.8): conformance.e2e.mjs
// --digest-only --reproduce test/results/conformance.json, the module's side of the stored run (the SGP4XP corpus's and
// the SGP4 control's output digests and order independence), about 9 s. The comparison against the SGP4-XP oracle is
// conformance.e2e.mjs's own E2E (--reproduce without --digest-only, 84 s); a test that changes no default reaches the
// same verdict from the digests, since the stored run's digests are the ones the oracle comparison accepted.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Runs the digest reproduction; throws when the module's output differs from the stored run. */
export function reproduceConformance() {
  const script = fileURLToPath(new URL("../conformance.e2e.mjs", import.meta.url));
  const stored = fileURLToPath(new URL("../results/conformance.json", import.meta.url));
  execFileSync(process.execPath, [script, "--digest-only", "--reproduce", stored], { stdio: "inherit" });
}
