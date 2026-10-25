import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders } from "./generate-sds-headers.mjs";
import { composeErfaTranslationUnit } from "../../foundation/frames/erfa-amalgamation.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const framesSrc = path.join(packageRoot, "..", "..", "foundation", "frames", "src");
const sgp4Dir = path.join(packageRoot, "..", "..", "foundation", "sgp4-str3");
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const { version: sdsVersion, families, headers } = await generateSdsHeaders();

// One translation unit: the family headers go in dependency order, so their
// cross-family includes are dropped rather than resolved.
// They have internal linkage: the flow compiler links the objects of several modules into one artifact, and the linker
// keeps one copy of each equal external C++ symbol. Generated SDS code from different releases of a schema is equal in
// name and different in layout, so the copy kept could be another module's. Each module keeps its own.
const sdsHeaders = [
  '#include "flatbuffers/flatbuffers.h"\nnamespace {',
  ...families.map((family) =>
    headers[family]
      .replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, "")
      .replaceAll('#include "flatbuffers/flatbuffers.h"\n', "")
      // The SDK compiler's FlatBuffers runtime is the one linked; the generator's version pin does not apply.
      .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?"Non-compatible flatbuffers version included"\);\n/, ""),
  ),
  "}  // namespace",
];

// The same ERFA, body models and axis engine foundation/frames compiles: one
// TEME/GCRF chain, not a second implementation.
const erfa = await composeErfaTranslationUnit();
const bodyModels = await fs.readFile(path.join(framesSrc, "iau_body_models.hpp"), "utf8");
const axisEngine = (await fs.readFile(path.join(framesSrc, "axis_engine.hpp"), "utf8"))
  .replace('#include "iau_body_models.hpp"', "")
  .replace(
    /extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/,
    "// ERFA declarations are amalgamated ahead of this header by build.mjs.\n",
  );

// The SGP4/SDP4 base, foundation/sgp4-str3 (as analysis/od compiles it): its header with its two parts in place of
// their #include lines.
let sgp4 = await fs.readFile(path.join(sgp4Dir, "include", "sgp4_str3.h"), "utf8");
for (const part of ["sgp4_core.inc", "model.inc"]) {
  const line = `#include "../src/${part}"`;
  if (!sgp4.includes(line)) throw new Error(`foundation/sgp4-str3 no longer includes ${part}`);
  const text = await fs.readFile(path.join(sgp4Dir, "src", part), "utf8");
  sgp4 = sgp4.replace(line, () => text);
}

const implementationSource = await fs.readFile(
  path.join(packageRoot, "src", "epoch_state_module.cpp"),
  "utf8",
);

const sourceCode = [
  ...sdsHeaders,
  erfa.source,
  bodyModels,
  axisEngine,
  // The SGP4 base has internal linkage here: the flow compiler links this module's object with others that compile
  // their own copy (analysis/gp-error-model, analysis/maneuver-detection). The standard headers it includes come
  // first, outside the namespace.
  "#include <cmath>\n#include <cstdint>\nnamespace {",
  sgp4,
  "}  // namespace",
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // Pure closed-form evaluation: nothing spawned, nothing shared. One synchronous hostcall, plugin.getConfig
  // (typedHostcall.hpp, SDS $PIV), for the ages.
  threadModel: "wasi-sequential",
  // Imports the sync space_data_module_host hostcall bridge for plugin.getConfig; resolved at instantiation.
  allowUndefinedImports: true,
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

// The flow compiler links this module as a node from its prefixed guest-link
// object (flows/source-products).
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
await fs.writeFile(
  path.join(distRoot, "build-provenance.json"),
  `${JSON.stringify(
    {
      spacedatastandards: sdsVersion,
      sdsFamilies: families,
      erfaSourceFiles: erfa.fileCount,
      axisEngine: "foundation/frames/src/axis_engine.hpp",
      sgp4: "foundation/sgp4-str3",
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

console.log(
  `Built ${path.relative(packageRoot, outputPath)} against spacedatastandards.org@${sdsVersion} with ${erfa.fileCount} vendored ERFA sources`,
);
