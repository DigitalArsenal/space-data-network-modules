import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders } from "./generate-sds-headers.mjs";
import { generateParameterRoster } from "./generate-parameter-roster.mjs";
import { generateReferenceVectors } from "./generate-reference-vectors.mjs";
import { generatePceCrosswalk } from "./generate-pce-crosswalk.mjs";
import { composeErfaTranslationUnit } from "../../foundation/frames/erfa-amalgamation.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

// Every generated artifact is regenerated from its own source of truth before
// the compile, so a stale roster or a stale crosswalk cannot be built into an
// artifact. Each generator FAILS on an unclassified entry rather than dropping it.
const roster = generateParameterRoster();
generateReferenceVectors();
generatePceCrosswalk(new Set(roster.parameters.map((row) => row.name)));

// SDS comes from the PUBLISHED package THIS PACKAGE pins, never a sibling
// checkout and never the SDK's own pin.
//
// The second half of that matters and is easy to miss. The SDK validates a
// manifest's type references against whatever `spacedatastandards.org` IT
// resolves, which is its own much older pin; against that catalog `$PCE` and
// `$EVL` simply do not exist and every port here is reported as an unresolved
// standards type. Pointing the resolver at this package's pin is what the
// published-deps law actually asks for: a module is built and validated against
// the version it declares, not against the version some dependency happens to
// carry.
process.env.SPACE_DATA_STANDARDS_ROOT = path.join(
  packageRoot,
  "node_modules",
  "spacedatastandards.org",
);

const { version: sdsVersion, headers } = await generateSdsHeaders();

// One translation unit, so the cross-family includes are resolved by ORDER and
// the `#include "<FAMILY>_generated.h"` lines are removed. RFM and FRM come
// first because PCE includes both, and EVL includes PCE.
const stripIncludes = (source) =>
  source.replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, "");

const rfmHeader = headers.RFM;
const frmHeader = stripIncludes(headers.FRM);
const pceHeader = stripIncludes(headers.PCE);
const eopHeader = headers.EOP;

// ONE chain and ONE element-set library, not copies. The parameter catalog
// evaluates over exactly the headers foundation/frames and foundation/orbits
// own, so a parameter and a coordinate-system transform cannot disagree.
const erfa = await composeErfaTranslationUnit();
const axisEngine = (
  await fs.readFile(path.join(packageRoot, "..", "..", "foundation", "frames", "src", "axis_engine.hpp"), "utf8")
).replace(
  /extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/,
  "// ERFA declarations are amalgamated ahead of this header by build.mjs.\n",
);
const stateRepresentations = await fs.readFile(
  path.join(packageRoot, "..", "..", "foundation", "orbits", "src", "state_representations.hpp"),
  "utf8",
);
const rosterHeader = await fs.readFile(
  path.join(packageRoot, "src", "generated", "parameter_roster.hpp"),
  "utf8",
);
const crosswalkHeader = await fs.readFile(
  path.join(packageRoot, "src", "generated", "pce_crosswalk.hpp"),
  "utf8",
);
const catalogHeader = await fs.readFile(
  path.join(packageRoot, "src", "parameter_catalog.hpp"),
  "utf8",
);
const implementationSource = await fs.readFile(
  path.join(packageRoot, "src", "parameters_module.cpp"),
  "utf8",
);

const sourceCode = [
  rfmHeader,
  frmHeader,
  pceHeader,
  eopHeader,
  erfa.source,
  axisEngine,
  stateRepresentations,
  rosterHeader,
  catalogHeader,
  crosswalkHeader,
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred.
  //
  // `wasi-sequential`, which is the SANCTIONED clang wasm32-wasip1-threads
  // toolchain without the wasi-threads contract (owner law: new modules compile
  // on that toolchain; emcc is not the lane for new work). The declaration is a
  // permanent claim that this guest can never spawn a thread, justified in the
  // manifest and held to by the SDK's own artifact assertion — so a future edit
  // that adds a thread fails loudly instead of silently re-shaping the artifact.
  threadModel: "wasi-sequential",
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
fsSync.writeFileSync(
  path.join(distRoot, "build-provenance.json"),
  `${JSON.stringify(
    {
      spacedatastandards: sdsVersion,
      rosterParameters: roster.count,
      rosterReference: roster.referenceCount,
      rosterLocalAdditions: roster.localCount,
      referenceRosterCommit: roster.generatedFrom.commit,
      referenceRosterSha256: roster.generatedFrom.sha256,
      erfaSourceFiles: erfa.fileCount,
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

console.log(
  `Built ${path.relative(packageRoot, outputPath)} against spacedatastandards.org@${sdsVersion} ` +
  `with ${roster.count} catalog parameters and ${erfa.fileCount} vendored ERFA sources`,
);
