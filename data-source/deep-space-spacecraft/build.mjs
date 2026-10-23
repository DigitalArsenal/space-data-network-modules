// One portable SDK artifact; runtime contract headers are staged by the SDK.
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { buildSourceModule } from "../../scripts/lib/build-source-module.mjs";

await buildSourceModule({
  root: fileURLToPath(new URL(".", import.meta.url)),
  importMeta: import.meta.url,
  compileModuleFromSource,
  createFlatc,
  families: ["OEM", "EGP"],
  common: ["civil_time.hpp", "horizons_vectors.hpp"],
  // Keep dependency order, including ephemeris_series after the planning headers.
  sources: [
    "src/notables.hpp", "src/trajectory_plan.hpp", "src/packed_rows.hpp",
    "../../files/orbit-products/src/ephemeris_series.hpp",
    "src/trajectory_rows.hpp", "src/regime.hpp", "src/oem_blocks.hpp",
    "../../files/orbit-products/src/sha256.hpp",
    "src/runtime_contracts.hpp", "src/deep_space_spacecraft.cpp",
  ],
  threadModel: "wasi-sequential",
  allowUndefinedImports: true, // plugin.getConfig through the typed $PIV bridge
});
