import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeaders } from "./sds-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// The SDS families the module reads and writes ($SBC request in; $OCM and $SBC diagnostics out; $OMM inside the
// request), generated from SPACE_DATA_STANDARDS_ROOT with every family they include, in dependency order, each with its
// include guard renamed and its includes dropped, in place of `#include "SDS_generated.h"`.
const sds = await generateSdsHeaders(["OCM", "OMM", "SBC"], import.meta.url);
const sourceCode = (await fs.readFile(path.join(packageRoot, "src", "cpp", "module.cpp"), "utf8"))
  .replace(/^#include "SDS_generated\.h".*$/m, () => sds.header);

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // One object's covariance per invocation, no guest threads (manifest sequentialJustification).
  threadModel: "wasi-sequential",
});

const guestLinkDir = path.join(distRoot, "guest-link");
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
await fs.writeFile(
  path.join(guestLinkDir, "metadata.json"),
  `${JSON.stringify({
    version: 1,
    format: compilation.guestLink.format,
    language: compilation.guestLink.language,
    threadModel: compilation.guestLink.threadModel,
    symbolPrefix: compilation.guestLink.symbolPrefix,
    methodSymbols: compilation.guestLink.methodSymbols,
  }, null, 2)}\n`,
);
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  throw new Error(`Compiled artifact failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`);
}
console.log(`Built ${path.relative(packageRoot, outputPath)} (SDS ${sds.version}: ${sds.families.join(", ")})`);
