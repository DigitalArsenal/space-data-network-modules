import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { buildSourceModule } from "../../scripts/lib/build-source-module.mjs";

await buildSourceModule({
  root: fileURLToPath(new URL(".", import.meta.url)),
  importMeta: import.meta.url,
  compileModuleFromSource,
  createFlatc,
  families: ["OMM", "CAT"],
  common: ["alpha5.hpp", "civil_time.hpp", "flat_json_records.hpp"],
  sources: ["src/spacetrack_source.cpp"],
});
