import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { buildSourceModule } from "../../scripts/lib/build-source-module.mjs";

await buildSourceModule({
  root: fileURLToPath(new URL(".", import.meta.url)),
  importMeta: import.meta.url,
  compileModuleFromSource,
  createFlatc,
  families: ["GST", "PVN"],
  common: ["civil_time.hpp"],
  sources: ["src/ilrs_station_coordinates.cpp"],
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs): the guest never spawns a thread.
  threadModel: "wasi-sequential",
});
