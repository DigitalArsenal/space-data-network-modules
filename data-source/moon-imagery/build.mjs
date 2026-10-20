// Build data-source/moon-imagery through the repository's shared source-module build (scripts/lib/
// build-source-module.mjs): the $IRM, $DTT, $FSO, $FSB and $PNM headers generated from the spacedatastandards.org
// package this module pins, then body-imagery's baseline JPEG encoder and its vendored stb_image 2.30 (JPEG decode,
// for the coarse unit), then the module. Single-thread like the flow's other guests; the typed hostcall bridge
// (plugin.getConfig) resolves at instantiation.
import { fileURLToPath } from "node:url";

import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { buildSourceModule } from "../../scripts/lib/build-source-module.mjs";

await buildSourceModule({
  root: fileURLToPath(new URL(".", import.meta.url)),
  importMeta: import.meta.url,
  compileModuleFromSource,
  createFlatc,
  families: ["IRM", "DTT", "FSO", "FSB", "PNM"],
  extraHeaders: ["data-source/body-imagery/src/jpeg_encoder.hpp", "data-source/moon-imagery/src/stb_config.hpp",
    "data-source/body-imagery/vendor/stb_image-2.30/stb_image.h"],
  sources: ["src/moon_imagery_module.cpp"],
  threadModel: "single-thread",
  allowUndefinedImports: true,
});
