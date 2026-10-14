import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "file_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// The ports carry the SDS standard FIL ($FIL). The SDK compiler stages only its runtime headers, so the standard's own
// generated C++ header (scripts/lib/sds-cpp-headers.mjs, with the object API) is inlined in place of
// `#include "FIL_generated.h"`: its include guard is renamed (the SDK's sds/PIV and sds/TAB headers are also
// "main_generated.h") and its flatc version static_assert relaxed, as the SDK does for its runtime headers.
const sdsHeader = (await generateSdsHeader("FIL", import.meta.url))
  .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", "FLATBUFFERS_GENERATED_SDS_FIL_MAIN_H_")
  .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "");
const sourceCode = (await fs.readFile(sourcePath, "utf8")).replace(/^#include "FIL_generated\.h".*$/m, () => sdsHeader);

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared explicitly, never inferred.
  //
  // This node is single-threaded: it spawns nothing, shares nothing, and holds
  // only the frames of the invocation it is serving. The artifact this repo has
  // been shipping already carries `threadModel: single-thread`
  // (dist/guest-link/metadata.json) — it was simply never DECLARED, so it rode
  // the SDK's inference. That inference has since moved to EMSCRIPTEN_PTHREADS
  // for runtimeTargets [browser, wasmedge], at which point the build starts
  // claiming a pthreads contract the emitted wasm does not have and the SDK's
  // isomorphic-pthreads artifact guard correctly REFUSES it ("does not import
  // the wasi thread-spawn host function ... must not ship"). Declaring the truth
  // builds against reality instead of against whatever the SDK last guessed.
  // Same fix, same reasoning as hostcap/http-request (7fefaf4), where the long
  // form of this note lives.
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
