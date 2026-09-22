import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders } from "./generate-sds-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const srcRoot = path.join(packageRoot, "src");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

/* The CCSDS keyword-value document model lives in the sibling package because
 * AEM and TDM are its primary consumers; containers.hpp reaches it the same
 * way. ONE implementation, included by whoever needs it — a second OEM parser
 * next to the first is the drift these packages are split to avoid. */
const ccsdsSrc = path.join(packageRoot, "..", "ccsds-messages", "src");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

// SDS comes from the PUBLISHED package this repo pins, never a sibling
// checkout (published-deps law, owner 2026-08-21).
const { version: sdsVersion, headers } = await generateSdsHeaders();

/*
 * $NCD is the record this module's ports are typed on, so a build against an
 * SDS pin that predates it would produce a manifest the SDK accepts and a
 * translation unit that does not compile — with the error naming a generated
 * header rather than the pin that is too old. Say it here instead.
 */
if (!headers.NCD || !headers.NCD.includes("ncdContainerFormat")) {
  throw new Error(
    `spacedatastandards.org@${sdsVersion} generated no ncdContainerFormat. ` +
      "This module's ports are typed on $NCD (minted in 1.202.0); bump the " +
      "pinned spacedatastandards.org and re-run npm ci.",
  );
}
if (!headers.OEM.includes("CLOCK_BIAS_MICROSECONDS") || !headers.OEM.includes("OBJECT_NAIF_ID")) {
  throw new Error(
    `spacedatastandards.org@${sdsVersion} carries an $OEM without the per-state ` +
      "clock columns or the NAIF body codes. This module writes both, and a " +
      "build without them would silently ship the lossy read the 1.1.4 bump " +
      "exists to end.",
  );
}

/*
 * VALIDATE THE MANIFEST AGAINST THE PIN THE HEADERS CAME FROM.
 *
 * The SDK's standards catalog resolves `spacedatastandards.org` from the SDK's
 * OWN node_modules unless SPACE_DATA_STANDARDS_ROOT says otherwise, and the
 * SDK currently carries 1.178.0. So a module typed on a record minted after
 * that — $NCD is — fails manifest validation with `unresolved-standards-type`
 * on every port, while its generated headers compile perfectly: the two halves
 * of the build were reading different pins. Pointing the catalog at this
 * package's own installed copy makes ONE pin decide both, which is what the
 * published-deps law asks for and what makes the verdict reproducible.
 */
process.env.SPACE_DATA_STANDARDS_ROOT = path.join(
  packageRoot,
  "node_modules",
  "spacedatastandards.org",
);

async function read(file) {
  return fs.readFile(file, "utf8");
}

/*
 * The generated SDS headers cross-reference each other by family
 * (`#include "RFM_generated.h"`). Concatenated into one unit those paths do not
 * exist, and the compiler reports the GENERATED file rather than the schema
 * that wanted it — which is how a missing family reads as a mysterious
 * `PLD_generated.h not found`. Strip them; the concatenation order below is
 * what satisfies the dependency, and each header's own include guard makes the
 * duplicate question moot.
 */
function stripSdsCrossIncludes(source) {
  return source.replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, "");
}

function stripLocalIncludes(source) {
  // The concatenation supplies these; leaving the directives in makes the
  // build depend on an include path that does not exist inside the compiler.
  return source
    .replace(/^#include "ephemeris_series\.hpp"\n/gm, "")
    .replace(/^#include "sha256\.hpp"\n/gm, "")
    .replace(/^#include "daf\.hpp"\n/gm, "")
    .replace(/^#include "spk_read\.hpp"\n/gm, "")
    .replace(/^#include "spk_write\.hpp"\n/gm, "")
    .replace(/^#include "code500\.hpp"\n/gm, "")
    .replace(/^#include "stk_ephemeris\.hpp"\n/gm, "")
    .replace(/^#include "sp3\.hpp"\n/gm, "")
    .replace(/^#include "containers\.hpp"\n/gm, "")
    .replace(/^#include "oem_projection\.hpp"\n/gm, "")
    .replace(/^#include "kvn\.hpp"\n/gm, "")
    .replace(/^#include "\.\.\/\.\.\/ccsds-messages\/src\/kvn\.hpp"\n/gm, "");
}

/*
 * ONE TRANSLATION UNIT, ASSEMBLED IN DEPENDENCY ORDER. The SDK compiles a
 * single unit, so every `#include` of a sibling header in this set would fail
 * to resolve — the headers are concatenated instead, and their own include
 * guards make the duplicate-inclusion question moot. Order is not cosmetic: a
 * header that references a type defined below it does not compile, and the
 * SDS order is computed from the schemas' own include graph rather than
 * guessed ($OEM pulls RFM, TIM, CAT and PPE; CAT in turn pulls IDM, PLD, LCC).
 *
 * There is NO propagator ABI header here. This module answers invoke methods
 * over SDS ports and exports no ORBPRO_* symbol, so pulling in the propagator
 * ABI would add a dependency it does not use — `data-source/spk-source` is the
 * package that speaks that ABI, over these same headers.
 */
const pieces = [
  stripSdsCrossIncludes(headers.RFM),
  stripSdsCrossIncludes(headers.TIM),
  stripSdsCrossIncludes(headers.IDM),
  stripSdsCrossIncludes(headers.PLD),
  stripSdsCrossIncludes(headers.LCC),
  stripSdsCrossIncludes(headers.CAT),
  stripSdsCrossIncludes(headers.PPE),
  stripSdsCrossIncludes(headers.OEM),
  stripSdsCrossIncludes(headers.NCD),
  stripSdsCrossIncludes(headers.OPM),
  await read(path.join(packageRoot,"../../foundation/orbits/src/state_representations.hpp")),
  await read(path.join(srcRoot,"vimpel.hpp")),
  stripLocalIncludes(await read(path.join(srcRoot, "sha256.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "ephemeris_series.hpp"))),
  stripLocalIncludes(await read(path.join(ccsdsSrc, "kvn.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "daf.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "spk_read.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "code500.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "stk_ephemeris.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "sp3.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "oem_projection.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "containers.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "orbit_products_module.cpp"))),
  await read(path.join(srcRoot, "vimpel_module.cpp")),
];

const sourceCode = pieces.join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred.
  //
  // `wasi-sequential` is the sanctioned clang wasm32-wasip1-threads toolchain
  // without the wasi-threads contract (owner law: new modules compile on that
  // toolchain; emcc is not the lane for new work). Reading a container is one
  // forward pass over one resident buffer and the projection is a second pass
  // over the series it produced, so this guest genuinely cannot spawn.
  // Declaring it is a permanent claim the SDK's artifact assertion holds us
  // to: a future edit that adds a thread fails loudly instead of silently
  // re-shaping the artifact.
  threadModel: "wasi-sequential",
});

if (compilation.threadModel !== "wasi-sequential") {
  // `resolveThreadModel` has a known defect where it reads the compile option
  // rather than the manifest and can infer pthreads from runtimeTargets. Assert
  // rather than trust until sdk-manifest-threadmodel-silently-ignored lands.
  throw new Error(
    `Compiler resolved threadModel "${compilation.threadModel}", not wasi-sequential.`,
  );
}

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
fsSync.writeFileSync(
  path.join(distRoot, "build-provenance.json"),
  `${JSON.stringify(
    {
      spacedatastandards: sdsVersion,
      threadModel: "wasi-sequential",
      records: { in: ["$NCD"], out: ["$OEM", "$NCD", "$OPM"] },
      formats: ["SPK_DAF", "SP3_C", "SP3_D", "CODE_500", "SCENARIO_EPOCH_EPHEMERIS_TEXT", "CCSDS_OEM_KVN", "vimpel-orbits-text"],
    },
    null,
    2,
  )}\n`,
);

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

/*
 * SIGN, IN THE BUILD, ALWAYS — never as a separate step someone can forget.
 *
 * The declared consumer verifies before it instantiates and has no unsigned
 * fallback, so an unsigned artifact is not a weaker artifact, it is an
 * UNLOADABLE one. That is exactly how `foundation/frames` shipped once: a
 * rebuild dropped the signature it never re-applied, and the demo died on
 * Pages. Signing is purely additive to the executable payload — every loader
 * strips the publication trailer before compiling — so signed and unsigned
 * bytes execute identically and nothing here can move a numeric result.
 */
// Explicit local validation mode requires no signing credentials. Published
// builds keep the existing mandatory signing behavior.
if (process.argv.includes("--unsigned")) {
  console.log("Unsigned local validation build (--unsigned); no signing key read.");
} else {
  execFileSync(
    process.execPath,
    [path.join(packageRoot, "..", "..", "scripts", "sign-module-artifact.mjs"), outputPath],
    { stdio: "inherit" },
  );
}

console.log(
  `Built ${path.relative(packageRoot, outputPath)} against ` +
    `spacedatastandards.org@${sdsVersion} (exports: ${(compilation.report?.exportNames ?? []).join(", ")})`,
);
