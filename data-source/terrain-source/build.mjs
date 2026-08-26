import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { minizSourceFragments } from "./miniz-source.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "terrain_source_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

// The sibling spacedatastandards.org checkout. SPACE_DATA_STANDARDS_ROOT wins
// so this builds from a git worktree without editing the file.
const defaultStandardsRoot = fileURLToPath(
  new URL("../../../spacedatastandards.org/", import.meta.url),
);
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : defaultStandardsRoot;
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

// flatc emits every SDS header with the same include guard; inlining a
// standard requires stripping guard + self-include (same pattern as
// data-source/geonames-source and cell-tower-source).
function inlineGeneratedHeader(source) {
  return source
    .replace(
      /#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/,
      "",
    )
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

// DTT (Digital Terrain Tile, ratified v1.191.0) is self-contained (single
// schema file: DTT table + DTTPayloadRef + DTTProvenance + enums), no include
// graph to order. TRN remains the terrain CONFIG standard and is not emitted
// by this module.
const inlineStandards = ["DTT"];
const headers = await Promise.all(
  inlineStandards.map((standard) =>
    fs.readFile(path.join(standardsRoot, "lib", "cpp", standard, "main_generated.h"), "utf8"),
  ),
);
const implementationSource = await fs.readFile(sourcePath, "utf8");

// SDK-owned HTTP envelope ABI headers ($HTQ declares the shared HttpHeader
// table; $HTR includes it). layer_json emits the canonical $HTR HttpResponse
// envelope (Janus ruling: HTTP-response-shaped outputs are never JSON
// frames), so both generated headers are inlined next to the SDS headers,
// exactly as foundation/http-respond does. The nested include is dropped
// because both are inlined here; their distinct include guards stay.
const sdkHttpCppRoot = fileURLToPath(
  new URL("./node_modules/space-data-module-sdk/src/generated/http/cpp/", import.meta.url),
);
const [httpRequestHeader, httpResponseHeader] = await Promise.all([
  fs.readFile(path.join(sdkHttpCppRoot, "HttpRequestAbi_generated.h"), "utf8"),
  fs.readFile(path.join(sdkHttpCppRoot, "HttpResponseAbi_generated.h"), "utf8"),
]);

// DEFLATE for GeoTIFF tiles (Copernicus GLO-30 COGs are DEFLATE-compressed).
// No host inflate capability exists and none may be added, so miniz 3.1.2 is
// vendored here — SHA-256 pinned per file, same sanctioned copy as
// geonames-source / cell-tower-source. Fragments are PREPENDED so tinfl_* is
// visible at namespace scope; MINIZ_NO_ARCHIVE_APIS means no mz_zip_*.
const minizFragments = await minizSourceFragments();

const sourceCode = [
  ...headers.map(inlineGeneratedHeader),
  httpRequestHeader,
  httpResponseHeader.replace(/#include "HttpRequestAbi_generated\.h"\s*\n/g, ""),
  ...minizFragments,
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // Single-thread pending the fleet migration off legacy Emscripten; blocked
  // by flowCompiler mixed-guest-thread-models against hostcap/* (Janus
  // 2026-08-26). A pure transform is INSIDE the threads law — threads are
  // forbidden here, not merely unused — and the standalone single-thread lane
  // is the compliant form until the cutover task
  // modules-wasi-sequential-cutover-off-legacy-emscripten lands.
  threadModel: "single-thread",
  allowUndefinedImports: true,
});

// Persist the prefixed guest-link object + metadata for the flow compiler
// (linked-direct nodes are statically linked into the composed runtime).
const guestLinkDir = path.join(distRoot, "guest-link");
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
await fs.writeFile(
  path.join(guestLinkDir, "metadata.json"),
  `${JSON.stringify(
    {
      version: 1,
      format: compilation.guestLink.format,
      language: compilation.guestLink.language,
      threadModel: compilation.guestLink.threadModel,
      symbolPrefix: compilation.guestLink.symbolPrefix,
      methodSymbols: compilation.guestLink.methodSymbols,
    },
    null,
    2,
  )}\n`,
);
await fs.copyFile(manifestPath, path.join(guestLinkDir, "plugin-manifest.json"));
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`terrain-source compiled -> ${outputPath}`);
