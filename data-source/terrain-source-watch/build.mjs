import { fileURLToPath } from "node:url";

import { buildModule } from "../../scripts/lib/build-module.mjs";

await buildModule({
  packageRoot: fileURLToPath(new URL(".", import.meta.url)),
  sourceFile: "terrain_source_watch_module.cpp",
  standards: ["APR", "FIL", "QRP"], // list / put tasks are $APR, the mirror listing a $FIL, the report a $QRP page
  inlineHeaders: ["watch_sources.hpp"], // the walk's source table, generated from terrain-ingest's body_plan.hpp
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs). The guest never spawns a
  // thread (manifest sequentialJustification); clang wasm32-wasip1-threads is the repo's one guest object format.
  threadModel: "wasi-sequential",
  label: "data-source/terrain-source-watch",
});
