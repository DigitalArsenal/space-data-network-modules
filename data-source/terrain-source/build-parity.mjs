// Builds dist/parity/module.wasm: THE SAME SOURCE as the shipped artifact,
// compiled with TERRAIN_SOURCE_NO_HOST_BRIDGE so the three
// space_data_module_host imports are absent.
//
// WHY IT EXISTS. The SDK's tri-runtime parity lane cannot execute a module
// that imports space_data_module_host: the wasmedge and docker-wasmedge lanes
// run `wasmedge module.wasm` with no host module to link (instantiation fails
// with "unknown import ... space_data_module_host / call"), and the browser
// lane's harness, on seeing that import, constructs a host whose wallet is a
// dynamic import("hd-wallet-wasm") that the served runner bundle externalizes
// out ("Failed to resolve module specifier"). That is ONE cause with three
// symptoms, it is a property of the lane runner rather than of this module,
// and it applies to every production module built on the sanctioned
// plugin.getConfig bridge (cell-tower-ingest, geonames-ingest, cpf-source …).
//
// The SHIPPED artifact keeps the bridge — Hermes's serving lane reads
// terrain_tileset_id / terrain_available / terrain_attribution out of the
// sidecar config through it. This artifact is measured, never deployed, and
// exercises only the ENCODER methods (tile, layer_json), which never touch the
// bridge. It is regenerated from the same sourceCode string the real build
// composes, so a divergence between them is impossible by construction.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { composeTerrainSource, packageRoot, standardsRoot } from "./source.mjs";

process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

const { manifest, sourceCode } = await composeTerrainSource();
const outputPath = path.join(packageRoot, "dist", "parity", "module.wasm");
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const { compileModuleFromSource } = await import("space-data-module-sdk/compiler");
const compilation = await compileModuleFromSource({
  manifest,
  sourceCode: `#define TERRAIN_SOURCE_NO_HOST_BRIDGE 1\n${sourceCode}`,
  language: "c++",
  outputPath,
  threadModel: "single-thread",
  allowUndefinedImports: true,
});
if (!compilation.report?.ok) {
  throw new Error(
    `parity artifact failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`,
  );
}
console.log(`terrain-source parity artifact -> ${outputPath}`);
