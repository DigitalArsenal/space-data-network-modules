// Build the glonass-source data-source module on the SDK compiler (typed contracts 1.0: FlatBuffers only). The SDS $OEM
// headers are generated for this build, the shared $OEM builder (common/oem_fb_builder.hpp) is inlined, and the runtime
// types (TimerTick, HttpRequest, HttpResponse, ModuleConfig) and typedHostcall.hpp are staged by the SDK compiler.
// Output: dist/isomorphic/module.wasm, dist/guest-link/{module-link.o, metadata.json}, dist/plugin-manifest.json.
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { buildSourceModule } from "../../scripts/lib/build-source-module.mjs";

await buildSourceModule({
  root: fileURLToPath(new URL(".", import.meta.url)),
  importMeta: import.meta.url,
  // plugin.getConfig is a typed hostcall (sdm_piv): its space_data_module_host imports are resolved by the host.
  compileModuleFromSource: (options) => compileModuleFromSource({ ...options, allowUndefinedImports: true }),
  createFlatc,
  families: ["OEM"],
  common: ["oem_fb_builder.hpp"],
  sources: ["src/glonass_source.cpp"],
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs). The guest never spawns a
  // thread (manifest sequentialJustification); clang wasm32-wasip1-threads is the repo's one guest object format, so
  // every flow links its modules' guest-link objects together (graph/checks/flow-link-models.mjs).
  threadModel: "wasi-sequential",
});
