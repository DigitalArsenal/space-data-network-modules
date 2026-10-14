import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "imager_observation_source_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
// The sibling spacedatastandards.org checkout ($WXF 1.238.0). SPACE_DATA_STANDARDS_ROOT wins when set.
const defaultStandardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : defaultStandardsRoot;
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

function inlineGeneratedHeader(source) {
  return source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

// The generated $WXF header is inlined: the list and file jobs ride in HttpRequest.CONTEXT as size-prefixed $WXF header
// records (the runtime types - HttpRequest, HttpResponse, IngestRequest, IngestResult, FlowNotice - and
// typedHostcall.hpp are staged by the SDK compiler).
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const wxf = await generateSdsHeader("WXF", import.meta.url);
if (!/add_SENSOR_ID/.test(wxf)) {
  throw new Error(`${standardsRoot} predates SDS 1.238.0 ($WXF imager fields): set SPACE_DATA_STANDARDS_ROOT`);
}
const sourceCode = [inlineGeneratedHeader(wxf), await fs.readFile(sourcePath, "utf8")].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared explicitly, never inferred. Typed frames in, one plugin.getConfig hostcall, HttpRequest
  // frames out; select_files keeps its backlog between invocations (the runtime resumes a yielded node), still one
  // thread. Same single-thread STANDALONE_WASM lane as celestrak-request and weathernext-source.
  threadModel: "single-thread",
  // Imports the sync space_data_module_host hostcall bridge for the builtin plugin.getConfig; symbols resolve at
  // instantiation.
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

console.log(`imager-observation-source compiled -> ${outputPath}`);
