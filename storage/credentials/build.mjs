import { fileURLToPath } from "node:url";

import { buildModule } from "../../scripts/lib/build-module.mjs";

await buildModule({
  packageRoot: fileURLToPath(new URL(".", import.meta.url)),
  sourceFile: "storage_credentials_module.cpp",
  standards: ["APR", "QRP"], // the task arrives as an $APR, the answer leaves as a $QRP decision + page
  httpAbi: true, // serve reads the $HTQ envelope
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs). The guest never spawns a
  // thread (manifest sequentialJustification); clang wasm32-wasip1-threads is the repo's one guest object format.
  threadModel: "wasi-sequential",
  label: "storage/credentials",
});
