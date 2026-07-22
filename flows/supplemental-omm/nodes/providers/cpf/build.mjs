import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProviderNode } from "../build-provider.mjs";

await buildProviderNode({
  nodeRoot: path.dirname(fileURLToPath(import.meta.url)),
  defaultSigningByte: "54",
  defaultSigningKeyId: "supplemental-omm-cpf-provider-development",
});
