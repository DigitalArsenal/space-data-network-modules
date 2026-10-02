import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource, cleanupCompilation } from "space-data-module-sdk/compiler";
import { createAccessPluginManifest, createLegacyBuildManifest } from "./manifest.js";
import { signBuiltArtifact } from "../../scripts/lib/sign-built-artifact.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const sdsRoot = path.dirname(require.resolve("spacedatastandards.org/package.json"));
const read = (name) => fs.readFile(path.join(root, name), "utf8");
const manifest = JSON.parse(await read("plugin-manifest.json"));
const flatc = await createFlatc();
flatc.FS.mkdir("/access");
flatc.FS.writeFile("/access/ACW.fbs", await fs.readFile(path.join(sdsRoot, "schema/ACW/main.fbs"), "utf8"));
const status = flatc.callMain(["--cpp", "--gen-object-api", "--preserve-case", "--no-warnings", "-o", "/access", "/access/ACW.fbs"]);
if (status !== 0) throw new Error(`ACW header generation failed: ${status}`);
const header = flatc.FS.readFile("/access/ACW_generated.h", { encoding: "utf8" });
await fs.mkdir(path.join(root, "src/generated"), { recursive: true });
await fs.writeFile(path.join(root, "src/generated/ACW_generated.h"), header);

// SDK accepts one translation unit. Preserve the evaluator and export the
// existing C functions for the thin browser adapter; the SDK supplies its ABI.
const implementation = (await read("src/access_plugin.cpp"))
  .replace('#include "access_abi.h"', await read("src/access_abi.h"))
  .replace('#include "ACW_generated.h"', header)
  .replace('#include "../../../propagator/events/src/event_locator.hpp"', await read("../../propagator/events/src/event_locator.hpp"))
  .replace('#include "constraint_engine.cpp.inc"', await read("src/constraint_engine.cpp.inc"))
  .replace('#include "constraint_polynomials.hpp"', await read("src/constraint_polynomials.hpp"))
  .replace(/ORBPRO_EXPORT\s+([\w:* ]+)\s+(\w+)\(/g,
    (_, type, name) => `__attribute__((export_name("${name}"))) ${type} ${name}(`);
const sourceCode = "#define ACCESS_SDK_BUILD 1\n" + implementation + "\n" + await read("src/sdk_entrypoint.cpp.inc");
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const compilation = await compileModuleFromSource({
  manifest, sourceCode, language: "c++", outputPath,
  threadModel: "wasi-sequential", standardsRoot: sdsRoot,
});
try {
  if (!compilation.report.ok) throw new Error(JSON.stringify(compilation.report.issues, null, 2));
  const bytes = await fs.readFile(outputPath);
  const adapter = await read("src/browser-adapter.mjs");
  await fs.mkdir(path.join(root, "dist/browser"), { recursive: true });
  await fs.writeFile(path.join(root, "dist/browser/module.js"), adapter);
  await fs.writeFile(path.join(root, "dist/access.mjs"), adapter);
  await fs.writeFile(path.join(root, "dist/browser/module.wasm"), bytes);
  await fs.writeFile(path.join(root, "dist/access.wasm"), bytes);
  await fs.writeFile(path.join(root, "dist/access-binary.js"), `export const wasmBase64 = "${bytes.toString("base64")}";\n`);
  await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist/plugin-manifest.json"));
  const metadata = createLegacyBuildManifest({ manifest: createAccessPluginManifest(), encrypted: false, requiresProtection: false,
    wasmHash: createHash("sha256").update(bytes).digest("hex"),
    exportedFunctions: WebAssembly.Module.exports(new WebAssembly.Module(bytes)).filter((entry) => entry.kind === "function").map((entry) => `_${entry.name}`),
    bytesSymbol: "plugin_get_manifest_flatbuffer", sizeSymbol: "plugin_get_manifest_flatbuffer_size",
  });
  metadata.embeddedManifest.file = "isomorphic/module.wasm";
  metadata.embeddedManifest.fileIdentifier = "$PLG";
  metadata.embeddedManifest.section = "sds.manifest";
  for (const name of ["manifest.json", "dist/manifest.json"]) await fs.writeFile(path.join(root, name), JSON.stringify(metadata, null, 2) + "\n");
  signBuiltArtifact(outputPath);
  console.log("Built dist/isomorphic/module.wasm through SDK; compliance PASS; isomorphic artifact signed.");
} finally {
  await cleanupCompilation(compilation);
}
