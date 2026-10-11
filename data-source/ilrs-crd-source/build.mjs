import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { buildSourceModule } from "../../scripts/lib/build-source-module.mjs";

await buildSourceModule({
  root: fileURLToPath(new URL(".", import.meta.url)),
  importMeta: import.meta.url,
  compileModuleFromSource,
  createFlatc,
  families: ["TDM"],
  common: ["alpha5.hpp", "civil_time.hpp"],
  sources: ["src/ilrs_crd_source.cpp"],
  // THREAD MODEL: declared, never inferred (scripts/lib/thread-model.mjs). The parser spawns nothing and shares nothing.
  threadModel: "single-thread",
});
