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
  // The one SP3 reader of the repository (files/orbit-products), over the ephemeris spine and the SHA-256 it shares:
  // headers all, compiled into this module's one translation unit.
  extraHeaders: ["files/orbit-products/src/sha256.hpp", "files/orbit-products/src/ephemeris_series.hpp", "files/orbit-products/src/sp3.hpp"],
  common: ["civil_time.hpp"],
  sources: ["src/sp3_precise_source.cpp"],
  // THREAD MODEL: declared, never inferred (scripts/lib/thread-model.mjs). The parser spawns nothing and shares nothing.
  // single-thread, as the source parsers and the source-products flow's nodes are: a flow links one thread model.
  threadModel: "single-thread",
});
