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

import { publishedStandardsRoot } from "../../data-source/terrain-source/sds-headers.mjs";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : publishedStandardsRoot(import.meta.url);

const cli = path.join(packageRoot, "node_modules", "space-data-module-sdk", "bin", "space-data-module.js");
const result = spawnSync(
  process.execPath,
  [cli, "flow", process.argv[2] ?? "compile", "../terrain-serving.flow.json", "--deps", "./deps.json", "--out", "./dist"],
  { cwd: packageRoot, stdio: "inherit", env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: standardsRoot } },
);
process.exit(result.status ?? 1);
