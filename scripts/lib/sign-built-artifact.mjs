import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const signer = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "sign-module-artifact.mjs",
);

/**
 * Signs a freshly built dist/isomorphic/module.wasm in place, as the build's
 * last step (see foundation/frames/build.mjs for why signing lives in the
 * build). Consumers such as OrbPro's tmpl-parity and waypoint demos verify the
 * signature before instantiating and have no unsigned fallback off localhost.
 * The trailer is additive: every SDK loader strips it before compiling, so all
 * runtimes execute the same bytes. Fails loud when the keypair is missing.
 * @param {string} outputPath
 */
export function signBuiltArtifact(outputPath) {
  execFileSync(process.execPath, [signer, outputPath], { stdio: "inherit" });
}
