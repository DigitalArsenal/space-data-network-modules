import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource, cleanupCompilation } from "space-data-module-sdk/compiler";
import { toLoadableWasmBytes } from "space-data-module-sdk/bundle";
import { createAccessPluginManifest, createLegacyBuildManifest } from "./manifest.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const sdsRoot = path.dirname(require.resolve("spacedatastandards.org/package.json"));
const read = (name) => fs.readFile(path.join(root, name), "utf8");
const manifest = JSON.parse(await read("plugin-manifest.json"));
// $ACW and every family it includes, each generated on its own and concatenated in dependency order (every family
// after the families it includes), their cross-family includes removed: one header for one translation unit.
const flatc = await createFlatc();
const schemaOf = (family) => fs.readFile(path.join(sdsRoot, "schema", family, "main.fbs"), "utf8");
const families = [];
const visit = async (family) => {
  if (families.includes(family)) return;
  const schema = await schemaOf(family);
  for (const [, included] of schema.matchAll(/^\s*include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs";/gm)) await visit(included);
  if (!families.includes(family)) families.push(family);
};
await visit("ACW");
flatc.FS.mkdir("/schemas");
for (const family of families) {
  flatc.FS.mkdir(`/schemas/${family}`);
  flatc.FS.writeFile(`/schemas/${family}/main.fbs`, await schemaOf(family));
}
flatc.FS.mkdir("/access");
const header = families.map((family) => {
  const status = flatc.callMain(["--cpp", "--gen-object-api", "--preserve-case", "--no-warnings", "-I", "/schemas", "-o", "/access", `/schemas/${family}/main.fbs`]);
  if (status !== 0) throw new Error(`${family} header generation failed: ${status}`);
  return flatc.FS.readFile("/access/main_generated.h", { encoding: "utf8" })
    .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_${family}_MAIN_H_`)
    .replace(/^#include "main_generated\.h"\n/gm, "");
}).join("\n");
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
  // Signed in the build (SDM_MODULE_SIGNING_KEYPAIR_PATH, or SDM_MODULE_UNSIGNED_BUILD=1 for an explicitly unsigned build),
  // so every copy below carries the bytes that ship.
  execFileSync(process.execPath, [path.join(root, "..", "..", "scripts", "sign-module-artifact.mjs"), outputPath], { stdio: "inherit" });
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
    exportedFunctions: WebAssembly.Module.exports(new WebAssembly.Module(toLoadableWasmBytes(bytes))).filter((entry) => entry.kind === "function").map((entry) => `_${entry.name}`),
    bytesSymbol: "plugin_get_manifest_flatbuffer", sizeSymbol: "plugin_get_manifest_flatbuffer_size",
  });
  metadata.embeddedManifest.file = "isomorphic/module.wasm";
  metadata.embeddedManifest.fileIdentifier = "$PLG";
  metadata.embeddedManifest.section = "sds.manifest";
  for (const name of ["manifest.json", "dist/manifest.json"]) await fs.writeFile(path.join(root, name), JSON.stringify(metadata, null, 2) + "\n");
  console.log("Built dist/isomorphic/module.wasm through SDK; compliance PASS (unsigned local build).");
} finally {
  await cleanupCompilation(compilation);
}
