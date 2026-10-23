import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "celestrak_request_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
// The SDS checkout that supplies the generated C++ headers: the sibling of this repository by default, or
// SPACE_DATA_STANDARDS_ROOT when set.
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

// Typed contracts: the frames are module-sdk runtime types (TimerTick in, HttpRequest out, IngestResult / IngestRequest
// in; the SDK compiler stages their headers), the job in HttpRequest.CONTEXT is an SDS $ICN record and cache_warm's
// output an SDS $FSO control frame - so those two standards' generated headers are inlined ahead of the module, with
// their shared include guard renamed (every SDS header is "main_generated.h").
async function sdsHeader(code) {
  const header = await generateSdsHeader(code, import.meta.url);
  return header
    .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_SDS_${code}_MAIN_H_`)
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "")
    .replace(/#include "main_generated\.h"\n/g, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = [await sdsHeader("ICN"), await sdsHeader("FSO"), await fs.readFile(sourcePath, "utf8")].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs). The guest never spawns a
  // thread (manifest sequentialJustification); clang wasm32-wasip1-threads is the repo's one guest object format, so
  // every flow links its modules' guest-link objects together (graph/checks/flow-link-models.mjs).
  threadModel: "wasi-sequential",
  // Imports the sync space_data_module_host hostcall bridge for the builtin
  // plugin.getConfig (typedHostcall.hpp, SDS $PIV); symbols resolve at instantiation.
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

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`celestrak-request compiled -> ${outputPath}`);
