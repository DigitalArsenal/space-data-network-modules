import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders } from "./generate-sds-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const srcRoot = path.join(packageRoot, "src");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

// SDS comes from the PUBLISHED package this module pins (published-deps law).
process.env.SPACE_DATA_STANDARDS_ROOT = path.join(packageRoot, "node_modules", "spacedatastandards.org");
const { families, headers } = await generateSdsHeaders();

// One translation unit: generated SDS headers in dependency order (their
// cross-includes stripped), the dependency-free element-set conversions, then
// the module with its local includes stripped.
const stripIncludes = (source) => source
  .replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, "")
  .replace(/^#include "state_representations\.hpp"\n/gm, "");
const pieces = [
  ...families.map((family) => stripIncludes(headers[family])),
  await fs.readFile(path.join(srcRoot, "state_representations.hpp"), "utf8"),
  stripIncludes(await fs.readFile(path.join(srcRoot, "orbits_module.cpp"), "utf8")),
];

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode: pieces.join("\n\n"),
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred (scripts/lib/thread-model.mjs
  // holds the full rationale; graph task modules-undeclared-threadmodel-artifacts).
  // The module spawns nothing and holds no state between invocations.
  threadModel: "single-thread",
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
