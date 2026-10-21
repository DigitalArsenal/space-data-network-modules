import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "storage_credentials_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
// The sibling spacedatastandards.org checkout; SPACE_DATA_STANDARDS_ROOT wins when set.
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

// Typed contracts: the task arrives as an SDS $APR (put/clear/status), the answer leaves
// as a $QRP decision + page for foundation/http-respond respond_query. Both standards' generated C++ headers are inlined
// with their include guards renamed (every SDS header is "main_generated.h") and the flatc version assert relaxed, as
// foundation/http-route does. typedHostcall.hpp is staged by the
// SDK compiler.
async function sdsHeader(code) {
  const header = await generateSdsHeader(code, import.meta.url);
  return header
    .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_SDS_${code}_MAIN_H_`)
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "")
    .replace(/#include "main_generated\.h"\n/g, "");
}

// SDK-owned HTTP envelope ABI header (schemas/HttpRequestAbi.fbs -> $HTQ), resolved through the SDK package itself.
const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("space-data-module-sdk/compiler"))), "..", "..");
const httpAbiHeader = await fs.readFile(path.join(sdkRoot, "src", "generated", "http", "cpp", "HttpRequestAbi_generated.h"), "utf8");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = [httpAbiHeader, await sdsHeader("APR"), await sdsHeader("QRP"), await fs.readFile(sourcePath, "utf8")].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // Same single-thread STANDALONE_WASM lane as every other node in this flow: one hostcall at a time, no shared state.
  threadModel: "single-thread",
  // Imports the sync space_data_module_host bridge (typedHostcall.hpp, sdm_piv); symbols resolve at instantiation.
  allowUndefinedImports: true,
});

const guestLinkDir = path.join(distRoot, "guest-link");
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
await fs.writeFile(
  path.join(guestLinkDir, "metadata.json"),
  `${JSON.stringify(
    {
      version: 1,
      format: compilation.guestLink.format,
      language: compilation.guestLink.language,
      threadModel: compilation.guestLink.threadModel,
      symbolPrefix: compilation.guestLink.symbolPrefix,
      methodSymbols: compilation.guestLink.methodSymbols,
    },
    null,
    2,
  )}\n`,
);
await fs.copyFile(manifestPath, path.join(guestLinkDir, "plugin-manifest.json"));
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`storage/credentials compiled -> ${outputPath}`);
