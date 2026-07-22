import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProviderNode } from "../build-provider.mjs";

await buildProviderNode({
  nodeRoot: path.dirname(fileURLToPath(import.meta.url)),
  defaultSigningByte: "52",
  defaultSigningKeyId: "supplemental-omm-glonass-provider-development",
});
