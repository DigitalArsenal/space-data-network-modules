import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders } from "./generate-sds-headers.mjs";
import { composeErfaTranslationUnit } from "./erfa-amalgamation.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "frames_module.cpp");
const axisEnginePath = path.join(packageRoot, "src", "axis_engine.hpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

// SDS comes from the PUBLISHED package this repo pins, never a sibling
// checkout — see generate-sds-headers.mjs for why.
const { version: sdsVersion, headers } = await generateSdsHeaders();

// $FRM includes ../RFM/main.fbs. In a single translation unit the generated
// FRM header's `#include "RFM_generated.h"` cannot resolve, so RFM is placed
// ahead of it and the include line removed.
const rfmHeader = headers.RFM;
const frmHeader = headers.FRM.replace(/^#include "RFM_generated\.h"\n/m, "");
const eopHeader = headers.EOP;

// ONE state-representation implementation, not two. `foundation/orbits` owns
// the 14 element sets and measures them; $FRM operation 7
// (STATE_REPRESENTATION_CONVERT) and the element-set legs of operation 5 use
// that same header rather than a second copy inside this package.
const stateRepresentations = await fs.readFile(
  path.join(packageRoot, "..", "orbits", "src", "state_representations.hpp"),
  "utf8",
);

// ONE chain, not two. The axis engine delegates every precession/nutation
// series to the vendored ERFA that higherpop/frames.hpp already uses, which is
// what makes the "agrees with higherpop to 1e-14" acceptance true by
// construction rather than by a second implementation racing the first. The
// SDK compiles a single translation unit, so ERFA is amalgamated into it here
// from those same vendored sources; nothing is re-derived or re-tabulated.
const erfa = await composeErfaTranslationUnit();

const axisEngine = (await fs.readFile(axisEnginePath, "utf8")).replace(
  /extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/,
  "// ERFA declarations are amalgamated ahead of this header by build.mjs.\n",
);
const implementationSource = (await fs.readFile(sourcePath, "utf8")).replace('#include "eop_table.hpp"', await fs.readFile(path.join(packageRoot, "src/eop_table.hpp"), "utf8"));
process.env.SPACE_DATA_STANDARDS_ROOT ??= path.join(packageRoot, "node_modules/spacedatastandards.org");

const sourceCode = [
  rfmHeader,
  frmHeader,
  eopHeader,
  erfa.source,
  axisEngine,
  stateRepresentations,
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred (scripts/lib/thread-model.mjs
  // holds the full rationale; graph task modules-undeclared-threadmodel-artifacts).
  //
  // Unchanged by the gmat-08 extension. This module is a pure closed-form
  // evaluator: it spawns nothing, shares nothing, and has no concurrency to
  // declare. Adding the $FRM state/rotation operations and the ERFA series does
  // not change that, and flipping the declared model would change the artifact's
  // runtime contract for reasons unrelated to the change being made.
  threadModel: "single-thread",
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
fsSync.writeFileSync(
  path.join(distRoot, "build-provenance.json"),
  `${JSON.stringify(
    {
      spacedatastandards: sdsVersion,
      erfaSourceFiles: erfa.fileCount,
      erfaRoot: erfa.relativeRoot,
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

// SIGN, in the build, always — never as a separate step someone can forget.
//
// This module's declared consumer verifies before it instantiates and has no
// unsigned fallback (OrbPro `coordinate-systems-and-state-reps`), so an
// unsigned artifact is not a weaker artifact, it is an UNLOADABLE one. That is
// exactly how it shipped once: `4f3e925` rebuilt this artifact and dropped the
// signature the rebuild never re-applied, and the demo died on Pages.
//
// Signing is purely additive to the executable payload: it appends a `$REC`
// publication trailer, and every loader in the SDK strips the trailer and the
// `sds.manifest` section through `toLoadableWasmBytes` before compiling. The
// browser, native WasmEdge and Docker WasmEdge lanes therefore execute the
// same bytes signed or unsigned — verified section-by-section, so nothing here
// can move a numeric result.
//
// It fails LOUD when the keypair is unreachable. A build that quietly emits an
// unsigned artifact is the defect this exists to prevent.
execFileSync(
  process.execPath,
  [path.join(packageRoot, "..", "..", "scripts", "sign-module-artifact.mjs"), outputPath],
  { stdio: "inherit" },
);

console.log(
  `Built ${path.relative(packageRoot, outputPath)} against spacedatastandards.org@${sdsVersion} with ${erfa.fileCount} vendored ERFA sources`,
);
