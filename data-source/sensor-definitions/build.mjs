import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { buildSourceModule } from "../../scripts/lib/build-source-module.mjs";

await buildSourceModule({
  root: fileURLToPath(new URL(".", import.meta.url)),
  importMeta: import.meta.url,
  compileModuleFromSource,
  createFlatc,
  families: ["SNR", "PVN"],
  common: ["civil_time.hpp"],
  sources: ["../../files/orbit-products/src/sha256.hpp", "src/roster.hpp", "src/text.hpp", "src/sensor_definitions.cpp"],
  allowUndefinedImports: true, // plugin.getConfig through the typed $PIV bridge,
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs): the guest never spawns a thread.
  threadModel: "wasi-sequential",
});
