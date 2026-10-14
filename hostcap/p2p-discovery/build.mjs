import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "p2p_discovery_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// The ports carry SDS standards (APR, NST, PNV, DAV, and the stored $EPM profiles read from p2p.peers_snapshot). The SDK
// compiler stages only its runtime headers, so each standard's generated C++ header (spacedatastandards.org
// lib/cpp/<CODE>/main_generated.h) is inlined in place of `#include "<CODE>_generated.h"`: its include guard is renamed
// (every SDS header and the SDK's sds/PIV header share "main_generated.h"), its flatc version static_assert relaxed, as
// the SDK does for its runtime headers. None of these schemas include another.
const SDS_CODES = ["APR", "NST", "PNV", "DAV", "EPM"];
const headers = Object.fromEntries(
  await Promise.all(
    SDS_CODES.map(async (code) => [
      code,
      (await fs.readFile(path.join(process.env.SPACE_DATA_STANDARDS_ROOT, "lib", "cpp", code, "main_generated.h"), "utf8"))
        .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_SDS_${code}_MAIN_H_`)
        .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, ""),
    ]),
  ),
);
const sourceCode = (await fs.readFile(sourcePath, "utf8")).replace(/^#include "([A-Z]{3})_generated\.h".*$/gm, (line, code) => {
  if (!headers[code]) throw new Error(`no inlined SDS header for ${line}`);
  return headers[code];
});

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: "single-thread",
  // The module imports the sync space_data_module_host hostcall bridge; those
  // symbols resolve at instantiation (SDK harness bridge / Go node bridge).
  allowUndefinedImports: true,
});

// Persist the prefixed guest-link object + metadata for the flow compiler
// (space-data-module flow compile links these into monolithic linked-direct
// flow artifacts; see SDK src/flow/flowCompiler.js).
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
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
