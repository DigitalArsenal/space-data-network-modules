import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "vcard_projection_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ?? "/Users/tj/software/spacedatanetwork-stack/repos/main-packages/spacedatastandards.org";

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// flatc emits every SDS header with the same include guard (FLATBUFFERS_GENERATED_MAIN_H_, also the guard of the
// SDK's staged sds/PIV and sds/TAB headers) and a flatc version static_assert. Each inlined standard gets its own
// guard and the assert is relaxed, as hostcap/clock/build.mjs does.
function inlineGeneratedHeader(source, standard) {
  return source
    .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_SDS_${standard}_MAIN_H_`)
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "");
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// The vCard projection inlines $EPM (the record it projects, and the record card_parse emits) and $VCF (the card
// record its projections emit and card_parse reads). Neither standard includes another.
const inlineStandards = ["EPM", "VCF"];
const headers = await Promise.all(
  inlineStandards.map((standard) =>
    fs.readFile(path.join(standardsRoot, "lib", "cpp", standard, "main_generated.h"), "utf8"),
  ),
);
const implementationSource = await fs.readFile(sourcePath, "utf8");
const sourceCode = [...headers.map((header, i) => inlineGeneratedHeader(header, inlineStandards[i])), implementationSource].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const result = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: "wasi-sequential",
});

console.log(`vcard-projection compiled: ${outputPath}`);

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
if (!result.report?.ok) {
  throw new Error(`Compiled artifact failed SDK validation:\n${JSON.stringify(result.report?.issues ?? [], null, 2)}`);
}
