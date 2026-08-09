import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSignedNode } from "../build-signed-node.mjs";

await buildSignedNode({
  nodeRoot: path.dirname(fileURLToPath(import.meta.url)),
  // THREAD MODEL — declared here, not inherited from build-signed-node.mjs.
  // Shipped artifact 7b9a4daa95c1…: SHARED linear memory (the clang
  // wasm32-wasip1-threads lane) but NO `wasi.thread-spawn` import and no
  // `wasi_thread_start` export — it provably never spawns, which is the
  // wasi-sequential contract, justified in plugin-manifest.json's
  // sequentialJustification. This node emits run status records on the calling thread.
  threadModel: "wasi-sequential",
  catalogSchemas: ["FSB", "FSO", "DSS"],
  headerSchemas: ["FSB", "FSO", "DSS"],
  alignedSchemas: ["FSB", "FSO"],
  signingEnvironmentPrefix: "SUPPLEMENTAL_STATUS",
  defaultSigningByte: "44",
  defaultSigningKeyId: "supplemental-omm-status-development",
});
