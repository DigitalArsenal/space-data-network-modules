import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProviderNode } from "../build-provider.mjs";

await buildProviderNode({
  nodeRoot: path.dirname(fileURLToPath(import.meta.url)),
  // THREAD MODEL — declared here, not inherited from build-provider.mjs.
  // Shipped artifact 8559c2ae5ca7…: unshared linear memory, no `wasi.thread-spawn`
  // import, no `wasi_thread_start` export. This provider fetches and parses one
  // catalog per invocation on the calling thread; it spawns nothing.
  // (nodes/providers/starlink is the one that genuinely threads.)
  threadModel: "single-thread",
  defaultSigningByte: "53",
  defaultSigningKeyId: "supplemental-omm-intelsat-provider-development",
});
