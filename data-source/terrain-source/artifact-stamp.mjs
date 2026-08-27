// PIN THE DEPLOYED BYTES BY A COMMIT, EVEN WHEN THE BYTES ARE NOT COMMITTED.
//
// Both terrain flows gitignore `dist/*.wasm` — the reason is written out in
// each flow's own .gitignore, and it is a good one: scripts/artifact-provenance
// .json is held under another lane's review-state claim, and committing a
// binary that breaks the very contract whose purpose is auditing binaries is
// the wrong half of the trade.
//
// What that costs is auditability of the ONE artifact that ships. From a clean
// clone the flow directory an operator installs under
// /mnt/volume_nyc3_01/data/flows/<programId>/ contains artifact.json,
// flow.json, flow.plg and plugin-manifest.json — and no runtime.wasm. The
// capability_policy.json approval on host-01 is keyed to the serving bundle's
// hash, and that hash was derivable from nothing in git: it had to be
// recomputed from a local rebuild whose determinism nothing in the repo
// asserted. The only committed record of it was a prose table in a pyramid
// run's REPRODUCE.md — a run record, not a deploy manifest.
//
// The compiler already writes the sha256 of every DEPENDENCY into
// dist/artifact.json. It does not write the sha256 of the artifact it just
// produced, so the composition record described a runtime it could not
// identify. This adds exactly that: the runtime's own digest and byte length,
// stamped into the tracked record after the link step, so `sha256sum
// dist/runtime.wasm` against `artifact.json` is a check anyone with the repo
// can run on the bytes an operator is about to install.
//
// Stamped by the flow's own build.mjs rather than by the SDK, so running the
// SDK CLI directly leaves the record unstamped rather than stale — an absent
// `artifact` block means "nobody vouched for these bytes", which is the honest
// reading. Graph follow-up to put the binaries themselves back under the
// ledger once that claim clears: modules-terrain-artifact-provenance-ledger.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Stamp a compiled flow's own sha256 + byte length into its dist/artifact.json,
 * and refuse a compile that came out on a lane the flow did not declare.
 *
 * @param {string} distDir             the flow's dist directory
 * @param {object} [options]
 * @param {string} [options.runtimeFile]        the linked artifact's filename
 * @param {string} [options.expectThreadModel]  the lane build.mjs declares
 * @returns {{sha256: string, bytes: number, threadModel: string}} what was stamped
 */
export function stampArtifactRecord(distDir, { runtimeFile = "runtime.wasm", expectThreadModel } = {}) {
  const runtimePath = path.join(distDir, runtimeFile);
  const recordPath = path.join(distDir, "artifact.json");
  const bytes = readFileSync(runtimePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  // THE DECLARED LANE IS CHECKED, NOT DECORATIVE. scripts/lib/thread-model.mjs
  // exists because SDK thread-model INFERENCE has already moved once under
  // modules that never said what they needed, leaving artifacts that could not
  // be rebuilt at the current pin. These two flows do not compile a guest
  // themselves — they invoke the flow compiler — so the only way for them to
  // declare a lane and mean it is to declare it and then REFUSE a compile that
  // disagreed. That is what this is: build.mjs states the lane, and a compiler
  // that produces another one stops the build instead of shipping quietly.
  if (expectThreadModel && record.threadModel !== expectThreadModel) {
    throw new Error(
      `${recordPath}: the flow compiled on threadModel ${JSON.stringify(record.threadModel)}, ` +
        `but this build declares ${JSON.stringify(expectThreadModel)}. ` +
        "Either the SDK's inference moved or the declaration is wrong — do not ship until you know which.",
    );
  }
  // Rebuilt key-by-key so the stamp lands in a STABLE position (immediately
  // after the identity fields) rather than at the end of whatever order the
  // compiler happened to emit — a moving key is a diff every rebuild.
  const stamped = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "artifact") continue; // re-stamped below, never appended twice
    stamped[key] = value;
    if (key === "version") {
      stamped.artifact = { file: runtimeFile, sha256, bytes: bytes.byteLength };
    }
  }
  if (!stamped.artifact) stamped.artifact = { file: runtimeFile, sha256, bytes: bytes.byteLength };

  writeFileSync(recordPath, `${JSON.stringify(stamped, null, 2)}\n`);
  return { sha256, bytes: bytes.byteLength, threadModel: record.threadModel };
}
