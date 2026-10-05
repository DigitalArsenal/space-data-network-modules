import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { FlatcRunner } from "flatc-wasm";

const root = fileURLToPath(new URL(".", import.meta.url));
const standardsPackage = path.join(root, "node_modules", "spacedatastandards.org");
const schemaRoot = path.join(standardsPackage, "schema");
const manifestPath = path.join(root, "plugin-manifest.json");
const outputPath = path.join(root, "dist", "isomorphic", "module.wasm");

async function schemaFiles(directory, prefix = "/schema") {
  const files = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const virtual = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(files, await schemaFiles(absolute, virtual));
    } else if (entry.name.endsWith(".fbs")) {
      files[virtual] = await fs.readFile(absolute, "utf8");
    }
  }
  return files;
}

function generatedHeader(flatc, files, schemaName) {
  const outputs = flatc.generateCode(
    { entry: `/schema/${schemaName}/main.fbs`, files },
    "cpp",
    { noIncludes: false },
  );
  const name = Object.keys(outputs).find((candidate) => candidate.endsWith("main_generated.h"));
  if (!name) throw new Error(`flatc produced no C++ header for ${schemaName}`);
  return outputs[name];
}

function stripGeneratedHeader(source) {
  return source
    .replace(/^#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*$/gm, "")
    .replace(/^#define FLATBUFFERS_GENERATED_MAIN_H_\s*$/gm, "")
    .replace(/^#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/gm, "")
    .replace(/^#include "main_generated\.h"\s*$/gm, "");
}

const [files, implementation, manifestText] = await Promise.all([
  schemaFiles(schemaRoot),
  fs.readFile(path.join(root, "src", "phased_array.cpp"), "utf8"),
  fs.readFile(manifestPath, "utf8"),
]);
const flatc = await FlatcRunner.init();
const generated = ["LKS", "RFB", "TIM", "RFL", "PAP", "BEM", "CVP"].map((name) =>
  generatedHeader(flatc, files, name),
);

const sourceCode = generated
  .map(stripGeneratedHeader)
  .concat(implementation)
  .join("\n\n");
const manifest = JSON.parse(manifestText);

await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: manifest.threadModel,
  stackSize: 2 * 1024 * 1024,
  // Resolve the catalog from this package's npm-pinned SDS dependency. The
  // SDK's own older nested dependency predates $PAP; using it would validate
  // against a different release than the schemas compiled above.
  standardsRoot: standardsPackage,
});

if (compilation.threadModel !== manifest.threadModel) {
  throw new Error(`thread model drift: ${compilation.threadModel}`);
}
if (!compilation.report?.ok) {
  throw new Error(`SDK validation failed:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`);
}

await fs.copyFile(manifestPath, path.join(root, "dist", "plugin-manifest.json"));
console.log(`Built ${path.relative(root, outputPath)} (${compilation.compiler}, ${compilation.threadModel})`);
