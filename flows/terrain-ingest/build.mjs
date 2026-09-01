// Compile the flow with the SDS standards root the module manifests are
// written against.
//
// The compiler re-validates every dependency manifest's declared SDS types,
// and $DTT only exists from spacedatastandards.org 1.196.0 — newer than the
// 1.178.0 the SDK carries as its own nested pin, which is what the SDK's own
// resolution finds. Without the root pointed at 1.196.0 the compile fails with
// `unresolved-standards-type ... tile.records` and the flow silently keeps
// serving a STALE dist, which is how an encoder fix can land in the module and
// never reach the compiled runtime.
//
// It used to be resolved as a SIBLING GIT CHECKOUT outside both repositories,
// which made the compiled runtime unreproducible for anyone without that
// checkout at that commit. It is the PUBLISHED package now — the same one the
// modules inline their headers from — resolved through node from this
// package's own dependencies. SPACE_DATA_STANDARDS_ROOT still overrides.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { stampArtifactRecord } from "../../data-source/terrain-source/artifact-stamp.mjs";
import { publishedStandardsRoot } from "../../data-source/terrain-source/sds-headers.mjs";

// THE LANE THIS FLOW SHIPS ON, DECLARED HERE rather than inferred from a
// deployment target. scripts/check-artifact-reproducibility.mjs requires every
// module that owns a build.mjs to state its thread model as a string literal,
// and scripts/lib/thread-model.mjs says why: SDK inference has already moved
// under modules that never declared, and the artifact guard then refuses to
// rebuild them at all. This flow composes guests rather than compiling one, so
// the declaration is checked against what the compiler actually produced —
// stampArtifactRecord refuses a dist whose artifact.json disagrees. Measured on
// both runtimes: non-shared memory with a maximum set, no tag section, no
// pthread or wasi-thread import.
const THREAD_MODEL = "single-thread";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : publishedStandardsRoot(import.meta.url);

const cli = path.join(packageRoot, "node_modules", "space-data-module-sdk", "bin", "space-data-module.js");
const result = spawnSync(
  process.execPath,
  [cli, "flow", process.argv[2] ?? "compile", "../terrain-ingest.flow.json", "--deps", "./deps.json", "--out", "./dist"],
  { cwd: packageRoot, stdio: "inherit", env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: standardsRoot } },
);
if (result.status !== 0) process.exit(result.status ?? 1);

// The compiled runtime is gitignored, so the TRACKED composition record beside
// it is the only thing a commit can pin the deployed bytes with. Stamped only
// after a compile that actually succeeded: a stamp over a stale runtime would
// be worse than no stamp at all.
if ((process.argv[2] ?? "compile") === "compile") {
  const stamp = stampArtifactRecord(path.join(packageRoot, "dist"), { expectThreadModel: THREAD_MODEL });
  process.stdout.write(
    `artifact.json pins ${stamp.sha256} (${stamp.bytes} bytes, ${stamp.threadModel})\n`,
  );
}
