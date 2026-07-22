import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSignedNode } from "../build-signed-node.mjs";

await buildSignedNode({
  nodeRoot: path.dirname(fileURLToPath(import.meta.url)),
  catalogSchemas: ["FSB"],
  headerSchemas: ["FSB"],
  alignedSchemas: ["FSB"],
  signingEnvironmentPrefix: "SUPPLEMENTAL_PUBLICATION",
  defaultSigningByte: "45",
  defaultSigningKeyId: "supplemental-omm-publication-development",
});
