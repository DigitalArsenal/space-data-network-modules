// The shared build of the storage and terrain-source-watch modules (build tooling, not module source): compile one C++
// source on the SDK's single-thread STANDALONE_WASM lane with the SDS C++ headers it names inlined, then persist what the
// flow compiler links (dist/guest-link) beside the module and its manifest. Each package's build.mjs is a call to this.
//
// Typed contracts: the SDS standards' generated C++ headers are inlined with their include guards renamed (every SDS
// header is "main_generated.h") and the flatc version assert relaxed, as foundation/http-route does. The runtime headers
// (HttpRequest, HttpResponse) and typedHostcall.hpp are staged by the SDK compiler; the $HTQ envelope header
// (HttpRequestAbi, the SDK's schemas/HttpRequestAbi.fbs) is inlined here when the module serves the HTTP edge.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // <modules>/scripts/lib

export async function buildModule({ packageRoot, sourceFile, standards, httpAbi = false, inlineHeaders = [], label }) {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const importSdk = (name) => import(pathToFileURL(require.resolve(`space-data-module-sdk/${name}`)).href);
  const { compileModuleFromSource } = await importSdk("compiler");
  const { generateSdsHeader } = await import(pathToFileURL(path.join(here, "sds-cpp-headers.mjs")).href);

  const manifestPath = path.join(packageRoot, "plugin-manifest.json");
  const distRoot = path.join(packageRoot, "dist");
  const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
  // The sibling spacedatastandards.org checkout; SPACE_DATA_STANDARDS_ROOT wins when set.
  process.env.SPACE_DATA_STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT
    ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT)
    : path.resolve(here, "..", "..", "..", "spacedatastandards.org");
  const from = pathToFileURL(path.join(packageRoot, "build.mjs")).href;

  const sdsHeader = async (code) =>
    (await generateSdsHeader(code, from))
      .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_SDS_${code}_MAIN_H_`)
      .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "")
      .replace(/#include "main_generated\.h"\n/g, "");

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const parts = [];
  if (httpAbi) {
    const sdkRoot = path.resolve(path.dirname(require.resolve("space-data-module-sdk/compiler")), "..", "..");
    parts.push(await fs.readFile(path.join(sdkRoot, "src", "generated", "http", "cpp", "HttpRequestAbi_generated.h"), "utf8"));
  }
  for (const code of standards) parts.push(await sdsHeader(code));
  // Local headers named by `inlineHeaders` replace their #include in the source (the compiler takes one translation unit).
  let source = await fs.readFile(path.join(packageRoot, "src", sourceFile), "utf8");
  for (const name of inlineHeaders) {
    const body = (await fs.readFile(path.join(packageRoot, "src", name), "utf8")).replace(/^#pragma once\s*$/m, "");
    source = source.replace(`#include "${name}"`, () => `// ---- ${name} ----\n${body}\n// ---- end ${name} ----`);
  }
  parts.push(source);

  await fs.rm(distRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const compilation = await compileModuleFromSource({
    manifest,
    sourceCode: parts.join("\n\n"),
    language: "c++",
    outputPath,
    // One hostcall at a time, no shared state: the single-thread STANDALONE_WASM lane.
    threadModel: "single-thread",
    // Imports the sync space_data_module_host bridge (typedHostcall.hpp, sdm_piv); symbols resolve at instantiation.
    allowUndefinedImports: true,
  });

  const guestLinkDir = path.join(distRoot, "guest-link");
  await fs.mkdir(guestLinkDir, { recursive: true });
  await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
  const { format, language, threadModel, symbolPrefix, methodSymbols } = compilation.guestLink;
  await fs.writeFile(path.join(guestLinkDir, "metadata.json"), `${JSON.stringify({ version: 1, format, language, threadModel, symbolPrefix, methodSymbols }, null, 2)}\n`);
  await fs.copyFile(manifestPath, path.join(guestLinkDir, "plugin-manifest.json"));
  await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

  if (!compilation.report?.ok) {
    throw new Error(`Compiled artifact failed SDK validation:\n${(compilation.report?.issues ?? []).map((issue) => issue.message ?? String(issue)).join("\n")}`);
  }
  console.log(`${label} compiled -> ${outputPath}`);
}
