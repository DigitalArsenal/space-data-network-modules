import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders, SCHEMA_FAMILIES } from "./generate-sds-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const { version: sdsVersion, headers } = await generateSdsHeaders();

// One translation unit: the family headers go in dependency order, so their
// cross-family includes are dropped rather than resolved.
const sdsHeaders = SCHEMA_FAMILIES.map((family) =>
  headers[family].replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, ""),
);

const implementationSource = await fs.readFile(
  path.join(packageRoot, "src", "gp_archive_records_module.cpp"),
  "utf8",
);

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode: [...sdsHeaders, implementationSource].join("\n\n"),
  language: "c++",
  outputPath,
  // wasi-sequential: the sanctioned clang wasm32-wasip1-threads toolchain
  // without the wasi-threads contract (new modules compile on it, not emcc).
  // The guest never spawns: each record is encoded in one bounded pass. The
  // SDK holds the artifact to that claim. (On the emcc single-thread lane the
  // SDK 0.8.21 compiles its invoke bridge without -O, which costs ~500
  // interpreted instructions per payload byte: ~40x slower for this module.)
  threadModel: "wasi-sequential",
});

if (compilation.threadModel !== "wasi-sequential") {
  throw new Error(`Compiler resolved threadModel "${compilation.threadModel}", not wasi-sequential.`);
}

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
await fs.writeFile(
  path.join(distRoot, "build-provenance.json"),
  `${JSON.stringify(
    {
      spacedatastandards: sdsVersion,
      sdsFamilies: SCHEMA_FAMILIES,
      encoding: "gp-archive-v1",
      threadModel: "wasi-sequential",
    },
    null,
    2,
  )}\n`,
);

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

// Signed in the build, always: consumers verify before they instantiate.
execFileSync(
  process.execPath,
  [path.join(packageRoot, "..", "..", "scripts", "sign-module-artifact.mjs"), outputPath],
  { stdio: "inherit" },
);

console.log(`Built ${path.relative(packageRoot, outputPath)} against spacedatastandards.org@${sdsVersion}`);
