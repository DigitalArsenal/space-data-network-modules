import { fileURLToPath } from "node:url";

import { buildStorageModule } from "../tools/build-module.mjs";

await buildStorageModule({
  packageRoot: fileURLToPath(new URL(".", import.meta.url)),
  sourceFile: "storage_credentials_module.cpp",
  standards: ["APR", "QRP"], // the task arrives as an $APR, the answer leaves as a $QRP decision + page
  httpAbi: true, // serve reads the $HTQ envelope
  label: "storage/credentials",
});
