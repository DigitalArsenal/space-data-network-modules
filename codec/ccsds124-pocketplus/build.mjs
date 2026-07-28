/*
 * Build the CCSDS 124.0-B-1 POCKET+ codec module.
 *
 * The SDK's compileModuleFromSource() compiles exactly ONE guest translation
 * unit from a source STRING, so the vendored reference library is amalgamated
 * here by concatenation rather than by -I include paths. The vendored bytes are
 * never edited: the only transform applied is stripping each file's
 * `#include "ccsds124.h"` line, because the header text is prepended instead
 * (the include would otherwise fail to resolve inside the SDK's temp dir).
 *
 * Toolchain is the SDK's enforced clang wasm32-wasip1-threads path, selected by
 * threadModel "emscripten-pthreads" (the SDK's name for wasi-threads). emcc
 * -pthread is a browser-only trap and is never used.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { verifyVendor } from "./scripts/verify-vendor.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const vendorRoot = path.join(packageRoot, "vendor", "ccsds124");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(
  new URL("../../../spacedatastandards.org/", import.meta.url),
);

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// Dependency order: leaf data structures first, codec last, glue last of all.
const VENDOR_SOURCES = [
  "src/bitvector.c",
  "src/bitbuffer.c",
  "src/mask.c",
  "src/encode.c",
  "src/compress.c",
  "src/decompress.c",
];

// Strip only the vendored header self-include; everything else is verbatim.
const LOCAL_INCLUDE = /^\s*#\s*include\s+"ccsds124\.h"\s*$/gm;

function stripLocalInclude(source, label) {
  return [
    `/* ==== BEGIN vendored verbatim: ${label} ==== */`,
    source.replace(LOCAL_INCLUDE, `/* (header inlined above) */`),
    `/* ==== END vendored verbatim: ${label} ==== */`,
  ].join("\n");
}

// The vendored bytes must match PROVENANCE.md before they are compiled, and the
// single-TU preconditions must still hold. A failure here stops the build.
await verifyVendor({ quiet: false });

const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

const header = await fs.readFile(path.join(vendorRoot, "include", "ccsds124.h"), "utf8");
const vendorParts = await Promise.all(
  VENDOR_SOURCES.map(async (relative) => {
    const source = await fs.readFile(path.join(vendorRoot, relative), "utf8");
    return stripLocalInclude(source, `ccsds124/${relative}`);
  }),
);
const glue = await fs.readFile(path.join(packageRoot, "src", "module.c"), "utf8");

const sourceCode = [
  stripLocalInclude(header, "ccsds124/include/ccsds124.h"),
  ...vendorParts,
  stripLocalInclude(glue, "src/module.c (SDN invoke glue)"),
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c",
  threadModel: "emscripten-pthreads",
  outputPath,
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(
  `Built ${path.relative(packageRoot, outputPath)} via ${compilation.compiler} ` +
    `(threadModel=${compilation.threadModel}, shared-memory=${Boolean(
      compilation.threadFeatures?.sharedMemory,
    )})`,
);
