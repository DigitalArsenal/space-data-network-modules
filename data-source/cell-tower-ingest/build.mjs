import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "cell_tower_ingest_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

// THE STANDARDS ROOT IS ONE DECISION, NOT TWO: SPACE_DATA_STANDARDS_ROOT wins (a per-task worktree), else the sibling
// spacedatastandards.org checkout. The compiler and the headers inlined below read the same tree.
process.env.SPACE_DATA_STANDARDS_ROOT ??= fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT;

// SDK-owned HTTP envelope ABI header (schemas/HttpRequestAbi.fbs -> $HTQ), resolved through the SDK package itself.
const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("space-data-module-sdk/compiler"))), "..", "..");
const sdkHttpCppRoot = path.join(sdkRoot, "src", "generated", "http", "cpp");

// Typed contracts 1.0: every frame this plugin reads or writes is a FlatBuffer. The SDK compiler stages the runtime
// headers (HttpRequest/HttpResponse/IngestRequest/IngestResult/FlowNotice/TimerTick, typedHostcall.hpp); the SDS
// standards are inlined here, each guard renamed per code (every SDS header is "main_generated.h") and its flatc
// version static_assert relaxed, as foundation/http-route does:
//   APR (run contracts and refusals), DAV (the cache lane's dataset availability), QRP (tile pages), IRM (the resume
//   mark), FSO / FSB (the FlatSQL query frames out, the result chunks in).
const SDS = ["APR", "DAV", "QRP", "IRM", "FSO", "FSB"];
async function sdsHeader(code) {
  const header = await generateSdsHeader(code, import.meta.url);
  return header
    .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_SDS_${code}_MAIN_H_`)
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "")
    .replace(/#include "main_generated\.h"\n/g, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = [
  await fs.readFile(path.join(sdkHttpCppRoot, "HttpRequestAbi_generated.h"), "utf8"),
  ...(await Promise.all(SDS.map(sdsHeader))),
  await fs.readFile(sourcePath, "utf8"),
].join("\n\n");

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
  // Imports the sync space_data_module_host hostcall bridge (typedHostcall.hpp, sdm_piv) for plugin.getConfig.
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

console.log(`cell-tower-ingest compiled -> ${outputPath}`);
