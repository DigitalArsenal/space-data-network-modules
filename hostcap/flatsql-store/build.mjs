import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

// hostcap/flatsql-store: the isomorphic artifact (dist/isomorphic/module.wasm) the end-to-end tests run. The
// wasi-threads guest-link the OD flow links is built from the same source by build-guest-link-threads.sh.
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "flatsql_store_module.cpp");
const isoRoot = path.join(packageRoot, "dist", "isomorphic");
const outputPath = path.join(isoRoot, "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// The SDK stages its runtime headers (typedHostcall.hpp, IngestRequest/IngestResult/TimerTick_generated.h); the
// repo's CIDv1 helper (common/sds_cid.hpp, shared with analysis/od) is inlined in place of its include.
const cidHeader = await fs.readFile(path.join(packageRoot, "..", "..", "common", "sds_cid.hpp"), "utf8");
const sourceCode = (await fs.readFile(sourcePath, "utf8")).replace(/^#include "sds_cid\.hpp".*$/m, () => cidHeader);

await fs.rm(isoRoot, { recursive: true, force: true });
await fs.mkdir(isoRoot, { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // Single-threaded: store() spawns nothing. Declared, never inferred (see hostcap/http-request).
  threadModel: "single-thread",
  // Imports the typed $PIV hostcall bridge (plugin.getConfig) and the "flatsql" arena trampolines; both resolve at
  // instantiation (the SDK harness / the Go node's flatsqlrt).
  allowUndefinedImports: true,
});

await fs.copyFile(manifestPath, path.join(packageRoot, "dist", "plugin-manifest.json"));

if (!compilation.report?.ok) {
  throw new Error(`Compiled artifact failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`);
}
console.log(`flatsql-store compiled -> ${outputPath}`);
