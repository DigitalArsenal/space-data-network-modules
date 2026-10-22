// Build data-source/body-imagery-tiles through the repository's shared source-module build (scripts/lib/
// build-source-module.mjs): the $DTT and $PNM headers generated from the spacedatastandards.org package this module
// pins, then body-imagery's baseline JPEG encoder and its vendored stb_image 2.30 (JPEG decode, for the reductions),
// then the module. Single-thread; the typed hostcall bridge (plugin.getConfig) resolves at instantiation.
import { fileURLToPath } from "node:url";

import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { buildSourceModule } from "../../scripts/lib/build-source-module.mjs";

await buildSourceModule({
  root: fileURLToPath(new URL(".", import.meta.url)),
  importMeta: import.meta.url,
  compileModuleFromSource,
  createFlatc,
  families: ["DTT", "PNM"],
  extraHeaders: ["data-source/body-imagery/src/jpeg_encoder.hpp", "data-source/body-imagery-tiles/src/stb_config.hpp",
    "data-source/body-imagery/vendor/stb_image-2.30/stb_image.h", "data-source/body-imagery-tiles/src/source.hpp",
    "data-source/body-imagery-tiles/src/pyramid.hpp", "data-source/body-imagery-tiles/src/sources_small.hpp"],
  sources: ["src/body_imagery_tiles.cpp"],
  threadModel: "single-thread",
  allowUndefinedImports: true,
});
