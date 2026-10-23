// Build data-source/celestrak-supgp on the SDK compiler (typed contracts 1.0: FlatBuffers only).
// The SDS headers the module reads and writes are inlined from the spacedatastandards.org tree (SPACE_DATA_STANDARDS_ROOT,
// else the package this module pins); the runtime types (TimerTick, HttpRequest, HttpResponse, IngestRequest, FlowNotice,
// ModuleConfig) and typedHostcall.hpp are staged by the SDK compiler.
// Output: dist/isomorphic/module.wasm, dist/guest-link/{module-link.o, metadata.json}, dist/plugin-manifest.json.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "celestrak_supgp.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = path.resolve(
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("./node_modules/spacedatastandards.org/", import.meta.url)),
);
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

// flatc emits every SDS header with the same include guard and a self-named include; inlining several standards into
// one translation unit strips both, and the flatc version static_assert is relaxed as the SDK does for its runtime
// headers (hostcap/clock).
function inlineGeneratedHeader(source) {
  return source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

// Topological order over the flatc include graph: RFM, TIM, MET, CVR, PVN feed OMM; ICN (the parse job) stands alone.
const standards = ["RFM", "TIM", "MET", "CVR", "PVN", "OMM", "ICN"];
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const headers = await Promise.all(
  standards.map((code) => generateSdsHeader(code, import.meta.url)),
);
const sourceCode = [...headers.map(inlineGeneratedHeader), await fs.readFile(sourcePath, "utf8")].join("\n\n");

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
  // plugin.getConfig is a typed hostcall (sdm_piv): its space_data_module_host imports are resolved by the host.
  allowUndefinedImports: true,
});

const guestLinkDir = path.join(distRoot, "guest-link");
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
const { format, language, threadModel, symbolPrefix, methodSymbols } = compilation.guestLink;
await fs.writeFile(
  path.join(guestLinkDir, "metadata.json"),
  `${JSON.stringify({ version: 1, format, language, threadModel, symbolPrefix, methodSymbols }, null, 2)}\n`,
);
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  throw new Error(`Compiled artifact failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`);
}
console.log(`celestrak-supgp compiled -> ${outputPath}`);
