import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { loadKnownTypeCatalog } from "space-data-module-sdk/standards";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "dop_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = await fs.readFile(sourcePath, "utf8");

// DopRequest (DOPQ) and DopResult (DOPR) are this module's own aligned-binary
// structs (src/dop_module.cpp), not SDS records, so the SDK's compile-time
// manifest check cannot resolve them from the standards catalog. Register
// exactly those two identities as module-local, as analysis/estimation does
// for $EST; the manifest and the wire contract are unchanged.
async function moduleTypeCatalog() {
  const catalog = [...(await loadKnownTypeCatalog({ standardsRoot: process.env.SPACE_DATA_STANDARDS_ROOT }))];
  for (const entry of [
    { schemaCode: "DOPQ", schemaName: "orbpro.analysis.DopRequest", fileIdentifier: "DOPQ", rootTypeName: "DopRequest", source: "module-local-aligned-binary" },
    { schemaCode: "DOPR", schemaName: "orbpro.analysis.DopResult", fileIdentifier: "DOPR", rootTypeName: "DopResult", source: "module-local-aligned-binary" },
  ]) {
    if (!catalog.some((known) => known.schemaName === entry.schemaName && known.fileIdentifier === entry.fileIdentifier)) catalog.push(entry);
  }
  return catalog;
}

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

// The lane is DECLARED, never inferred: without it, SDK 0.8.25 infers
// "emscripten-pthreads" from runtimeTargets [browser, wasmedge] and its
// artifact guard refuses this never-threading guest. "single-thread" is the
// Emscripten STANDALONE_WASM lane the 1.0.0 artifact was built on.
const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: "single-thread",
  catalog: await moduleTypeCatalog(),
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled DOP artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
