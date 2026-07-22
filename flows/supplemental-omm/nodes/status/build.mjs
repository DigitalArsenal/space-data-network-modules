import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSignedNode } from "../build-signed-node.mjs";

await buildSignedNode({
  nodeRoot: path.dirname(fileURLToPath(import.meta.url)),
  catalogSchemas: ["FSB", "FSO", "DSS"],
  headerSchemas: ["FSB", "FSO", "DSS"],
  alignedSchemas: ["FSB", "FSO"],
  signingEnvironmentPrefix: "SUPPLEMENTAL_STATUS",
  defaultSigningByte: "44",
  defaultSigningKeyId: "supplemental-omm-status-development",
});
