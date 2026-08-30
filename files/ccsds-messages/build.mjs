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

/* SHA-256 lives in the sibling package because the container reader needed it
 * first, and SOURCE_SHA256 must be computed the SAME way on both sides of the
 * $NCD pairing or a descriptor written by one and checked by the other fails
 * for no reason. ONE implementation, included by whoever needs it — the reach
 * is already mutual, since `files/orbit-products` includes this package's
 * kvn.hpp for its own OEM reader. */
const productsSrc = path.join(packageRoot, "..", "orbit-products", "src");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

// SDS comes from the PUBLISHED package this repo pins, never a sibling
// checkout (published-deps law, owner 2026-08-21).
const { version: sdsVersion, headers } = await generateSdsHeaders();

/*
 * $AEM 2.0.2 and $TDM 2.0.4 are what make this module possible at all: before
 * them the records could not carry a per-state epoch or a per-observation
 * triple, and the projection seams in aem.hpp / tdm.hpp were deliberately
 * empty. A build against an older pin would produce a manifest the SDK accepts
 * and a translation unit that does not compile, with the error naming a
 * generated header rather than the pin that is too old. Say it here instead.
 */
if (!headers.AEM.includes("ATTITUDE_DATA_LINES") || !headers.AEM.includes("ANGVEL_FRAME")) {
  throw new Error(
    `spacedatastandards.org@${sdsVersion} carries an $AEM without ATTITUDE_DATA_LINES or ` +
      "ANGVEL_FRAME. This module writes the verbose per-state-epoch form, which the " +
      "published Figure G-4 requires; bump the pinned spacedatastandards.org and re-run npm ci.",
  );
}
if (!headers.TDM.includes("TDMObservation") || !headers.TDM.includes("TDMSegment")) {
  throw new Error(
    `spacedatastandards.org@${sdsVersion} carries a $TDM without per-observation triples or ` +
      "a segment table. This module writes both, and a build without them would ship the " +
      "uniform-grid read that published Figure E-17 disproves.",
  );
}
if (!headers.NCD || !headers.NCD.includes("CCSDS_AEM_KVN") ||
    !headers.NCD.includes("CCSDS_TDM_KVN")) {
  throw new Error(
    `spacedatastandards.org@${sdsVersion} generated no CCSDS_AEM_KVN / CCSDS_TDM_KVN members. ` +
      "This module's message ports are typed on $NCD and those are the format members they " +
      "declare; bump the pinned spacedatastandards.org and re-run npm ci.",
  );
}

/*
 * VALIDATE THE MANIFEST AGAINST THE PIN THE HEADERS CAME FROM.
 *
 * The SDK's standards catalog resolves `spacedatastandards.org` from the SDK's
 * OWN node_modules unless SPACE_DATA_STANDARDS_ROOT says otherwise, and that
 * copy is older than this one. A module typed on a record minted after it then
 * fails manifest validation with `unresolved-standards-type` on every port
 * while its generated headers compile perfectly — the two halves of the build
 * reading different pins. Pointing the catalog at this package's own installed
 * copy makes ONE pin decide both, which is what the published-deps law asks for
 * and what makes the verdict reproducible.
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
    .replace(/^#include "kvn\.hpp"\n/gm, "")
    .replace(/^#include "aem\.hpp"\n/gm, "")
    .replace(/^#include "tdm\.hpp"\n/gm, "")
    .replace(/^#include "sha256\.hpp"\n/gm, "")
    .replace(/^#include "aem_projection\.hpp"\n/gm, "")
    .replace(/^#include "tdm_projection\.hpp"\n/gm, "")
    .replace(/^#include "generated\/sds\/[A-Z0-9_]+_generated\.h"\n/gm, "");
}

/*
 * ONE TRANSLATION UNIT, ASSEMBLED IN DEPENDENCY ORDER. The SDK compiles a
 * single unit, so every `#include` of a sibling header in this set would fail
 * to resolve — the headers are concatenated instead, and their own include
 * guards make the duplicate-inclusion question moot. Order is not cosmetic: a
 * header that references a type declared below it does not compile.
 *
 * $TDM includes $RFM, so RFM leads. $AEM and $NCD include nothing.
 *
 * The two projection headers each carry an identical guarded block of shared
 * helpers; whichever lands first defines it and the second is a no-op, which is
 * exactly what makes each of them standalone-includable by the native test
 * harness that measures them.
 */
const pieces = [
  stripSdsCrossIncludes(headers.RFM),
  stripSdsCrossIncludes(headers.AEM),
  stripSdsCrossIncludes(headers.TDM),
  stripSdsCrossIncludes(headers.NCD),
  stripLocalIncludes(await read(path.join(productsSrc, "sha256.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "kvn.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "aem.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "tdm.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "aem_projection.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "tdm_projection.hpp"))),
  stripLocalIncludes(await read(path.join(srcRoot, "ccsds_messages_module.cpp"))),
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
  // toolchain; emcc is not the lane for new work). Reading a message is one
  // forward pass over one resident frame and the projection is a second pass
  // over the entry list it produced, so this guest genuinely cannot spawn.
  // Declaring it is a permanent claim the SDK's artifact assertion holds us to:
  // a future edit that adds a thread fails loudly instead of silently
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
      records: { in: ["$NCD", "$AEM", "$TDM"], out: ["$AEM", "$TDM", "$NCD"] },
      formats: ["CCSDS_AEM_KVN", "CCSDS_TDM_KVN"],
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
execFileSync(
  process.execPath,
  [path.join(packageRoot, "..", "..", "scripts", "sign-module-artifact.mjs"), outputPath],
  { stdio: "inherit" },
);

console.log(
  `Built ${path.relative(packageRoot, outputPath)} against ` +
    `spacedatastandards.org@${sdsVersion} (exports: ${(compilation.report?.exportNames ?? []).join(", ")})`,
);
