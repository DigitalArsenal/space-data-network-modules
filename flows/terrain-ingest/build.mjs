// Compile the flow with the SDS standards root the module manifests are
// written against.
//
// The compiler re-validates every dependency manifest's declared SDS types,
// and $DTT only exists from spacedatastandards.org 1.196.0 — newer than the
// 1.178.0 the transitive npm install pulls in. Without the root pointed at the
// 1.196.0 checkout the compile fails with
// `unresolved-standards-type ... tile.records` and the flow silently keeps
// serving a STALE dist, which is how an encoder fix can land in the module and
// never reach the compiled runtime. Resolved exactly the way
// data-source/terrain-source/source.mjs resolves it: the sibling checkout,
// overridable by SPACE_DATA_STANDARDS_ROOT.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

const cli = path.join(packageRoot, "node_modules", "space-data-module-sdk", "bin", "space-data-module.js");
const result = spawnSync(
  process.execPath,
  [cli, "flow", process.argv[2] ?? "compile", "../terrain-ingest.flow.json", "--deps", "./deps.json", "--out", "./dist"],
  { cwd: packageRoot, stdio: "inherit", env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: standardsRoot } },
);
process.exit(result.status ?? 1);
