// The ONE place the terrain-source translation unit is composed. build.mjs
// (the shipped artifact) and build-parity.mjs (the tri-runtime measurement
// artifact) both call this, so the two can never drift apart.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { minizSourceFragments } from "./miniz-source.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "terrain_source_module.cpp");

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



export { packageRoot, standardsRoot };

export async function composeTerrainSource() {
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


  return { manifest, sourceCode };
}
