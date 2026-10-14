import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

// propagator/cislunar on the typed contracts (1.0): a $TBP request in, a $TBP answer out.
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const cppRoot = path.join(packageRoot, "src", "cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

// The SDS standards TBP needs, in flatc include order (schema/<CODE>/main.fbs `include` lines, depth first).
async function includeOrder(codes) {
  const order = [];
  const seen = new Set();
  async function visit(code) {
    if (seen.has(code)) return;
    seen.add(code);
    const schema = await fs.readFile(path.join(standardsRoot, "schema", code, "main.fbs"), "utf8");
    for (const match of schema.matchAll(/^include "\.\.\/([A-Z0-9]+)\/main\.fbs";/gm)) await visit(match[1]);
    order.push(code);
  }
  for (const code of codes) await visit(code);
  return order;
}
// flatc gives every SDS header the same include guard and a self-named `#include "main_generated.h"` per
// dependency; one translation unit holding several needs both stripped, and the flatc version static_assert relaxed
// (as hostcap/clock does).
const inlineHeader = (source) =>
  source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
const standards = await includeOrder(["TBP"]);
const sdsHeaders = (
  await Promise.all(standards.map((code) => fs.readFile(path.join(standardsRoot, "lib", "cpp", code, "main_generated.h"), "utf8")))
).map(inlineHeader);

// The CR3BP core, unchanged, ahead of the module (its own includes resolved by this concatenation).
const stripLocalIncludes = (source) => source.replace(/^#include "(types\.h|cislunar\/[a-z0-9_]+\.h)"\s*$/gm, "");
const core = await Promise.all(
  ["include/cislunar/types.h", "include/cislunar/constants.h", "include/cislunar/cr3bp.h", "src/cr3bp.cpp"].map(
    async (file) => stripLocalIncludes(await fs.readFile(path.join(cppRoot, file), "utf8")),
  ),
);
const moduleSource = (await fs.readFile(path.join(cppRoot, "src", "tbp_module.cpp"), "utf8")).replace(
  /^#include "TBP_generated\.h".*$/m,
  () => sdsHeaders.join("\n\n"),
);
const sourceCode = [...core, moduleSource].join("\n\n");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred: one request answered per invoke, no threads, no shared state.
  threadModel: "single-thread",
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
console.log(`Built ${path.relative(packageRoot, outputPath)} (SDS ${standards.join(", ")})`);
