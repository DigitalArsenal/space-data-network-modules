// The event-locator module's package entry point.

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
