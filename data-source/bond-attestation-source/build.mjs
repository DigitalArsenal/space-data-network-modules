// Builds the bond attestation module through the SDK compiler (typed contracts 1.0): WHA in, WHA out, the http and
// clock reads as sdm_piv hostcalls. The WHA header (scripts/lib/sds-cpp-headers.mjs, with the object API) is inlined
// in place of `#include "WHA_generated.h"`, its include guard renamed and its flatc version static_assert relaxed,
// as hostcap/clock/build.mjs does for TIM.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
process.env.SPACE_DATA_STANDARDS_ROOT ??= fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const whaHeader = (await generateSdsHeader("WHA", import.meta.url))
  .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", "FLATBUFFERS_GENERATED_SDS_WHA_MAIN_H_")
  .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "");
const jsonHeader = await fs.readFile(path.resolve(packageRoot, "../../propagator/sgp4/src/cpp/include/nlohmann/json.hpp"), "utf8");
const sourceCode = (await fs.readFile(path.join(packageRoot, "src", "bond_attestation.cpp"), "utf8"))
  .replace(/^#include "WHA_generated\.h".*$/m, () => whaHeader)
  // nlohmann/json (single header) parses the providers' own JSON answers; the compiler sees one source, so it is inlined.
  .replace(/^#include "\.\.\/\.\.\/\.\.\/propagator\/.*$/m, () => jsonHeader);

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
  // The sync space_data_module_host hostcall bridge resolves at instantiation (SDK harness / Go node bridge).
  allowUndefinedImports: true,
});
const guestLinkDir = path.join(distRoot, "guest-link");
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
const { format, language, threadModel, symbolPrefix, methodSymbols } = compilation.guestLink;
await fs.writeFile(path.join(guestLinkDir, "metadata.json"), `${JSON.stringify({ version: 1, format, language, threadModel, symbolPrefix, methodSymbols }, null, 2)}\n`);
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
if (!compilation.report?.ok) throw new Error(`Compiled artifact failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`);
console.log(`Bond attestation compiled: ${outputPath}`);
