import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { validateArtifactWithStandards } from "space-data-module-sdk";
const manifest = JSON.parse(fs.readFileSync(new URL("plugin-manifest.json", import.meta.url)));
const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(new URL("dist/isomorphic/module.wasm", import.meta.url)), standardsRoot: fileURLToPath(new URL("node_modules/spacedatastandards.org", import.meta.url)) });
if (!report.ok) { console.error(JSON.stringify(report.issues, null, 2)); process.exitCode = 1; }
else console.log("[compliance] PASS: events manifest and dist/isomorphic/module.wasm");
