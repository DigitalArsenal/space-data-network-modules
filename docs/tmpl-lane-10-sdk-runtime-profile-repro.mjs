// SDK 0.8.18 false-positive compliance reproduction using the exact base commit.
// Read-only: no build, signing, SDK patch, or fabricated WASM.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../analysis/access/package.json", import.meta.url));
const { validateArtifactWithStandards } = await import(pathToFileURL(require.resolve("space-data-module-sdk")));
const { createBrowserModuleHarness } = await import(pathToFileURL(require.resolve("space-data-module-sdk/host/browser-module")));
const base = "12ea8023a097bf68b8ad183dc99f0597d4fa311d";
const read = (file) => execFileSync("git", ["show", `${base}:analysis/access/${file}`], { cwd: root });
const manifest = JSON.parse(read("plugin-manifest.json"));
const wasmBytes = new Uint8Array(read("dist/isomorphic/module.wasm"));
const report = await validateArtifactWithStandards({ manifest, wasmBytes });
assert.equal(report.ok, true, JSON.stringify(report.issues));
let runtimeError;
try {
  const harness = await createBrowserModuleHarness({ manifest, wasmSource: wasmBytes, surface: "direct" });
  await harness.destroy();
} catch (error) { runtimeError = error.message; }
assert.match(runtimeError ?? "", /Import #0 "env": module is not an object or function/);
console.log(`REPRODUCED SDK compliance false positive: report.ok=${report.ok}; browser=${runtimeError}`);
process.exitCode = 1;
