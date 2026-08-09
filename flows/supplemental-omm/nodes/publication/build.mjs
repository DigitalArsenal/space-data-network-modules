import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSignedNode } from "../build-signed-node.mjs";

await buildSignedNode({
  nodeRoot: path.dirname(fileURLToPath(import.meta.url)),
  // THREAD MODEL — declared here, not inherited from build-signed-node.mjs.
  // Shipped artifact 80d1b976cc5a…: SHARED linear memory (the clang
  // wasm32-wasip1-threads lane) but NO `wasi.thread-spawn` import and no
  // `wasi_thread_start` export — it provably never spawns, which is the
  // wasi-sequential contract, justified in plugin-manifest.json's
  // sequentialJustification. This node publishes the assembled catalog on the calling thread.
  threadModel: "wasi-sequential",
  catalogSchemas: ["FSB"],
  headerSchemas: ["FSB"],
  alignedSchemas: ["FSB"],
  signingEnvironmentPrefix: "SUPPLEMENTAL_PUBLICATION",
  defaultSigningByte: "45",
  defaultSigningKeyId: "supplemental-omm-publication-development",
});
