import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { buildSourceModule } from "../../scripts/lib/build-source-module.mjs";

await buildSourceModule({
  root: fileURLToPath(new URL(".", import.meta.url)),
  importMeta: import.meta.url,
  compileModuleFromSource,
  createFlatc,
  families: ["OEM"],
  // The one reader of the public format (files/orbit-products), foundation/orbits' conversion and the SHA-256 the orbit
  // products share; headers all, compiled into this module's one translation unit.
  extraHeaders: ["foundation/orbits/src/state_representations.hpp", "files/orbit-products/src/sha256.hpp", "files/orbit-products/src/vimpel.hpp"],
  common: ["civil_time.hpp"],
  sources: ["src/vimpel_source.cpp"],
  // THREAD MODEL: declared, never inferred (scripts/lib/thread-model.mjs). The parser spawns nothing and shares nothing.
  threadModel: "single-thread",
});
