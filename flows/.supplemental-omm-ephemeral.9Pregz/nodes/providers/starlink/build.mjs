import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProviderNode } from "../build-provider.mjs";

await buildProviderNode({
  nodeRoot: path.dirname(fileURLToPath(import.meta.url)),
  defaultSigningByte: "51",
  defaultSigningKeyId: "supplemental-omm-starlink-provider-development",
  threadModel: "emscripten-pthreads",
  schemaCodes: ["FSB", "DSS", "FSO"],
  alignedSchemaCodes: ["FSB", "FSO"],
});
