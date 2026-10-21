import { fileURLToPath } from "node:url";

import { buildStorageModule } from "../tools/build-module.mjs";

await buildStorageModule({
  packageRoot: fileURLToPath(new URL(".", import.meta.url)),
  sourceFile: "object_s3_module.cpp",
  standards: ["APR", "FIL"], // tasks and results are $APR, listings $FIL; HREQ / HRSP are the SDK runtime types
  httpAbi: true, // serve reads the $HTQ envelope
  label: "storage/object-s3",
});
