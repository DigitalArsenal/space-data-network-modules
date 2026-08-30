import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "lambert_module.cpp");
const solverPath = path.join(packageRoot, "include", "lambert_izzo", "solver.hpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(
  new URL("../../../spacedatastandards.org/", import.meta.url),
);

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const [lmsHeader, lmoHeader, solverSource, implementationSource] = await Promise.all([
  fs.readFile(path.join(standardsRoot, "lib", "cpp", "LMS", "main_generated.h"), "utf8"),
  fs.readFile(path.join(standardsRoot, "lib", "cpp", "LMO", "main_generated.h"), "utf8"),
  fs.readFile(solverPath, "utf8"),
  fs.readFile(sourcePath, "utf8"),
]);
const sourceCode = [
  lmsHeader,
  "#undef FLATBUFFERS_GENERATED_MAIN_H_",
  lmoHeader,
  solverSource,
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // One boundary-value solve is sequential. The SDK still compiles this
  // isomorphic guest with the stack's clang WASI toolchain; caller-level
  // concurrency owns sweeps of independent geometries.
  threadModel: "wasi-sequential",
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
