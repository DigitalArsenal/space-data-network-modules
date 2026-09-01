import fs from "node:fs/promises";
import path from "node:path";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { composeTerrainSource, packageRoot } from "./source.mjs";
import { publishedStandardsRoot } from "./sds-headers.mjs";

// The manifest validator and the inlined headers read the SAME package; see
// sds-headers.mjs (publishedStandardsRoot) for why this has to be said out loud.
process.env.SPACE_DATA_STANDARDS_ROOT ??= publishedStandardsRoot(import.meta.url);


const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

const { manifest, sourceCode } = await composeTerrainSource();

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // Single-thread pending the fleet migration off legacy Emscripten; blocked
  // by flowCompiler mixed-guest-thread-models against hostcap/* (Janus
  // 2026-08-26). A pure transform is INSIDE the threads law — threads are
  // forbidden here, not merely unused — and the standalone single-thread lane
  // is the compliant form until the cutover task
  // modules-wasi-sequential-cutover-off-legacy-emscripten lands.
  threadModel: "single-thread",
  allowUndefinedImports: true,
});

// Persist the prefixed guest-link object + metadata for the flow compiler
// (linked-direct nodes are statically linked into the composed runtime).
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
await fs.copyFile(manifestPath, path.join(guestLinkDir, "plugin-manifest.json"));
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`terrain-source compiled -> ${outputPath}`);
