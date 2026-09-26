import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders, SCHEMA_FAMILIES } from "./generate-sds-headers.mjs";
import { composeErfaTranslationUnit } from "../../foundation/frames/erfa-amalgamation.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const framesSrc = path.join(packageRoot, "..", "..", "foundation", "frames", "src");
const sgp4Src = path.join(packageRoot, "..", "..", "propagator", "sgp4", "src", "cpp", "src");
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

// The same Vallado SGP4 propagator/sgp4 compiles. SGP4.cpp carries Latin-1
// bytes in comments, and defines a `pi` macro that must not leak past it.
const sgp4Header = await fs.readFile(path.join(sgp4Src, "SGP4.h"), "latin1");
const sgp4Source = (await fs.readFile(path.join(sgp4Src, "SGP4.cpp"), "latin1")).replace(
  '#include "SGP4.h"',
  "",
);

const implementationSource = await fs.readFile(
  path.join(packageRoot, "src", "epoch_state_module.cpp"),
  "utf8",
);

const sourceCode = [
  ...sdsHeaders,
  erfa.source,
  bodyModels,
  axisEngine,
  sgp4Header,
  sgp4Source,
  "#undef pi",
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // Pure closed-form evaluation: nothing spawned, nothing shared.
  threadModel: "single-thread",
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
await fs.writeFile(
  path.join(distRoot, "build-provenance.json"),
  `${JSON.stringify(
    {
      spacedatastandards: sdsVersion,
      sdsFamilies: SCHEMA_FAMILIES,
      erfaSourceFiles: erfa.fileCount,
      axisEngine: "foundation/frames/src/axis_engine.hpp",
      sgp4: "propagator/sgp4/src/cpp/src/SGP4.cpp",
      threadModel: "single-thread",
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
