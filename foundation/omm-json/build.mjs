import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "omm_json_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// flatc emits every SDS header with the same include guard
// (FLATBUFFERS_GENERATED_MAIN_H_) and schema includes as a self-named
// `#include "main_generated.h"`. Inlining more than one generated header into
// a single translation unit therefore requires stripping the guard and the
// schema-include line (the flatbuffers runtime include and version
// static_assert are idempotent and stay). Same pattern as data-source/retrieval.
function inlineGeneratedHeader(source) {
  return source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// OMM.fbs includes TIM (timingStandard), MET (meanElementSource), and RFM
// (reference frames), so those leaf headers must precede the OMM header.
const [timHeader, metHeader, rfmHeader, ommHeader, implementationSource] = await Promise.all([
  fs.readFile(path.join(standardsRoot, "lib", "cpp", "TIM", "main_generated.h"), "utf8"),
  fs.readFile(path.join(standardsRoot, "lib", "cpp", "MET", "main_generated.h"), "utf8"),
  fs.readFile(path.join(standardsRoot, "lib", "cpp", "RFM", "main_generated.h"), "utf8"),
  fs.readFile(path.join(standardsRoot, "lib", "cpp", "OMM", "main_generated.h"), "utf8"),
  fs.readFile(sourcePath, "utf8"),
]);
const sourceCode = [
  inlineGeneratedHeader(timHeader),
  inlineGeneratedHeader(metHeader),
  inlineGeneratedHeader(rfmHeader),
  inlineGeneratedHeader(ommHeader),
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
});

// Persist the prefixed guest-link object + metadata for the flow compiler
// (space-data-module flow compile links these into monolithic linked-direct
// flow artifacts; see SDK src/flow/flowCompiler.js).
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

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
