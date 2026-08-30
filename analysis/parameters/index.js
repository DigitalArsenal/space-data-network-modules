// The parameter-catalog module's package entry point.
//
// The artifact is the deliverable; this file only names it, the way every other
// module package in this repository does.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export const MODULE_PATH = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
export const MANIFEST_PATH = path.join(packageRoot, "plugin-manifest.json");

export function readManifest() {
  return require("./plugin-manifest.json");
}

/// The generated roster, for a consumer that wants the vocabulary without
/// instantiating the artifact.
export function readRoster() {
  return require("./src/generated/roster.json");
}

/// The published-parameter crosswalk, for a consumer resolving codes to names.
export function readCrosswalk() {
  return require("./src/generated/pce-crosswalk.json");
}
