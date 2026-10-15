import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "spacex_starlink_source.cpp");
const memeOemPath = path.join(packageRoot, "src", "meme_oem.hpp");
// The shared $OEM builder (common/, read only: oneweb-source and iss-source use it too).
const oemBuilderPath = path.resolve(packageRoot, "../../common/oem_fb_builder.hpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
  : fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
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

// Typed contracts: the frames are module-sdk runtime types (TimerTick, HttpRequest, HttpResponse, FlowNotice; staged by
// the SDK compiler) and SDS $OEM, whose header and its includes go in topological order: RFM, TIM, IDM -> PLD, LCC ->
// CAT, PPE, OEM. Then the shared $OEM builder and the MEME parser, then the module.
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const standards = ["RFM", "TIM", "IDM", "PLD", "LCC", "CAT", "PPE", "OEM"];
const headers = await Promise.all(
  standards.map((code) => generateSdsHeader(code, import.meta.url)),
);
const stripPragma = (s) => s.replace(/^#pragma once\s*$/m, "");
const oemBuilder = stripPragma(await fs.readFile(oemBuilderPath, "utf8"));
const memeOem = stripPragma(await fs.readFile(memeOemPath, "utf8"));
const module = (await fs.readFile(sourcePath, "utf8")).replace(/^#include "meme_oem\.hpp".*$/m, () => memeOem);
const sourceCode = [...headers.map(inlineGeneratedHeader), oemBuilder, module].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred: typed frames in, one plugin.getConfig hostcall, typed frames out;
  // select_objects keeps its request queue between invocations (the runtime resumes the yielded node). One thread.
  threadModel: "single-thread",
  // The sync space_data_module_host hostcall bridge for plugin.getConfig (typedHostcall.hpp); resolved at instantiation.
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
  throw new Error(`Compiled artifact failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`);
}
console.log(`spacex-starlink-source compiled -> ${outputPath}`);
