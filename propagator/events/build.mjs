import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders } from "./generate-sds-headers.mjs";
import { createAccessEvaluatorSource } from "../../analysis/access/build-source.mjs";
import { composeErfaTranslationUnit } from "../../foundation/frames/erfa-amalgamation.mjs";
import { signBuiltArtifact } from "../../scripts/lib/sign-built-artifact.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const parametersRoot = path.join(packageRoot, "..", "..", "analysis", "parameters");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

// Built and validated against the SDS version THIS package pins, not against
// the SDK's own much older one — see analysis/parameters/build.mjs for why.
process.env.SPACE_DATA_STANDARDS_ROOT = path.join(
  packageRoot,
  "node_modules",
  "spacedatastandards.org",
);

const { version: sdsVersion, headers } = await generateSdsHeaders();

const stripIncludes = (source) =>
  source.replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, "");

// One translation unit, so cross-family includes are resolved by ORDER: RFM and
// FRM first because PCE includes both, PCE before EVL because EVL includes it.
// $OEM pulls in the catalogue, timing, payload and predicted-position families
// transitively. They are emitted in dependency order and their cross-family
// include lines removed, because a single translation unit resolves by ORDER.
const ORDERED_FAMILIES = [
  "RFM", "FRM", "PCE", "EVL", "EOP", "TIM", "IDM", "PLD", "LCC", "CAT", "PPE", "OEM", "NCD",
];
const schemaHeaders = ORDERED_FAMILIES.map((family, index) =>
  index === 0 ? headers[family] : stripIncludes(headers[family]),
);

// ONE chain, ONE element-set library and ONE parameter evaluator. A stopping
// condition on `Altitude` must be the SAME altitude the catalog module reports,
// so this module compiles those headers rather than a second copy of them. The
// generated roster and crosswalk are read from the catalog package, which owns
// them, and this build FAILS if they are absent rather than falling back to a
// smaller vocabulary.
const erfa = await composeErfaTranslationUnit();
// The shared axis engine includes the IAU body models. The SDK compiles this
// amalgamation outside the source tree, so place that dependency before its
// consumer just as foundation/frames/build.mjs does.
const bodyModels = await fs.readFile(
  path.join(packageRoot, "..", "..", "foundation", "frames", "src", "iau_body_models.hpp"),
  "utf8",
);
const axisEngine = (
  await fs.readFile(
    path.join(packageRoot, "..", "..", "foundation", "frames", "src", "axis_engine.hpp"),
    "utf8",
  )
).replace('#include "iau_body_models.hpp"', "").replace(
  /extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/,
  "// ERFA declarations are amalgamated ahead of this header by build.mjs.\n",
);
const read = (...segments) => fs.readFile(path.join(...segments), "utf8");
const stateRepresentations = await read(
  packageRoot, "..", "..", "foundation", "orbits", "src", "state_representations.hpp",
);
const rosterHeader = await read(parametersRoot, "src", "generated", "parameter_roster.hpp");
const catalogHeader = await read(parametersRoot, "src", "parameter_catalog.hpp");
const crosswalkHeader = await read(parametersRoot, "src", "generated", "pce_crosswalk.hpp");
const eventLocator = await read(packageRoot, "src", "event_locator.hpp");
const ephemerisSource = await read(packageRoot, "src", "ephemeris_source.hpp");
const implementationSource = await read(packageRoot, "src", "events_module.cpp");

const kernelHeaders = await Promise.all(
  ["sha256.hpp", "ephemeris_series.hpp", "daf.hpp", "spk_read.hpp", "spk_kernel.hpp", "kernel_frame.hpp"]
    .map(async (name) => (await read(packageRoot, "..", "..", "files", "orbit-products", "src", name))
      .replace(/^#include "(?:[^"/]+\.hpp|NCD_generated\.h)"\s*$/gm, "")),
);

const sourceCode = [
  ...schemaHeaders,
  ...kernelHeaders,
  erfa.source,
  bodyModels,
  axisEngine,
  stateRepresentations,
  rosterHeader,
  catalogHeader,
  crosswalkHeader,
  eventLocator,
  ephemerisSource,
  await createAccessEvaluatorSource({ acwHeader: headers.ACW }),
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred. `wasi-sequential` is the sanctioned
  // clang wasm32-wasip1-threads toolchain without the wasi-threads contract; the
  // declaration is a permanent claim that this guest never spawns a thread, held
  // to by the SDK's own artifact assertion.
  threadModel: "wasi-sequential",
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
const roster = JSON.parse(
  await read(parametersRoot, "src", "generated", "roster.json"),
);
fsSync.writeFileSync(
  path.join(distRoot, "build-provenance.json"),
  `${JSON.stringify(
    {
      spacedatastandards: sdsVersion,
      parameterRosterSize: roster.count,
      erfaSourceFiles: erfa.fileCount,
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

signBuiltArtifact(outputPath);
console.log(
  `Built ${path.relative(packageRoot, outputPath)} against spacedatastandards.org@${sdsVersion} ` +
  `over the ${roster.count}-parameter catalog and ${erfa.fileCount} vendored ERFA sources`,
);
