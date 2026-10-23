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
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs). The guest never spawns a
  // thread (manifest sequentialJustification); clang wasm32-wasip1-threads is the repo's one guest object format, so
  // every flow links its modules' guest-link objects together (graph/checks/flow-link-models.mjs).
  threadModel: "wasi-sequential",
});
