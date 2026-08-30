import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { generateSdsHeaders } from "./generate-sds-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");

/* The format engines live in `files/orbit-products` and are reached the same
 * way `foundation/frames` reaches `foundation/orbits`' state representations:
 * ONE implementation, included by whoever needs it. A copy here would be a
 * second SPK reader, and two SPK readers is exactly one more than the number
 * that can be right. */
const productsSrc = path.join(packageRoot, "..", "..", "files", "orbit-products", "src");
const ccsdsSrc = path.join(packageRoot, "..", "..", "files", "ccsds-messages", "src");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

/*
 * THE PROPAGATOR ABI HEADER — generated, never mirrored.
 *
 * `OrbProStateVector`, the `ReferenceFrame` roster, `OrbProEphemerisFormat` and
 * the `ORBPRO_PROP_*` error codes are all generated from
 * `schemas/orbpro/Propagator.fbs` in the module SDK. This build reads that
 * generated header rather than restating any of it, because five hand-vendored
 * copies of `StateVector` is the drift the ABI's own generator exists to end —
 * and one of those copies was off by a factor of 1000 on units.
 *
 * The resolution order is deliberate. Normally the header comes from the SDK
 * this package installs. `SPACE_DATA_MODULE_SDK_ABI_ROOT` overrides it for the
 * window in which an ABI change has landed in a task worktree but not yet in
 * the checkout npm resolves to — a real state, not a convenience: the
 * `plugin_init_ephemeris` verb this module is built on was added in exactly
 * that window. The build FAILS LOUDLY naming the missing symbol rather than
 * compiling a module whose entry point the installed ABI does not define.
 */
async function readPropagatorAbiHeader() {
  const candidates = [];
  if (process.env.SPACE_DATA_MODULE_SDK_ABI_ROOT) {
    candidates.push(
      path.join(
        process.env.SPACE_DATA_MODULE_SDK_ABI_ROOT,
        "include",
        "orbpro",
        "orbpro_propagator_abi.h",
      ),
    );
  }
  candidates.push(
    path.join(
      packageRoot,
      "node_modules",
      "space-data-module-sdk",
      "include",
      "orbpro",
      "orbpro_propagator_abi.h",
    ),
  );

  for (const candidate of candidates) {
    if (!fsSync.existsSync(candidate)) continue;
    const header = await fs.readFile(candidate, "utf8");
    if (!header.includes("ORBPRO_EPHEM_FORMAT_AUTO")) {
      throw new Error(
        `${candidate} predates the ephemeris ingest verb: it declares no ` +
          `OrbProEphemerisFormat. This module's entry point is ` +
          `plugin_init_ephemeris, which that ABI does not define. Point ` +
          `SPACE_DATA_MODULE_SDK_ABI_ROOT at an SDK checkout that carries it, ` +
          `or update the installed SDK.`,
      );
    }
    if (!header.includes("ORBPRO_PROP_EPOCH_OUT_OF_RANGE")) {
      throw new Error(
        `${candidate} declares no ORBPRO_PROP_* error codes. This module ` +
          `returns them by name rather than as literals; regenerate the ABI ` +
          `header from schemas/orbpro/Propagator.fbs.`,
      );
    }
    return { header, source: candidate };
  }
  throw new Error(
    `orbpro_propagator_abi.h not found. Tried:\n  ${candidates.join("\n  ")}`,
  );
}

const abi = await readPropagatorAbiHeader();

// SDS comes from the PUBLISHED package this repo pins, never a sibling
// checkout (published-deps law, owner 2026-08-21).
const { version: sdsVersion, headers } = await generateSdsHeaders();

async function read(file) {
  return fs.readFile(file, "utf8");
}

/*
 * ONE TRANSLATION UNIT, ASSEMBLED IN DEPENDENCY ORDER. The SDK compiles a
 * single unit, so every `#include` of a sibling header in this set would fail
 * to resolve — the headers are concatenated instead, and their own include
 * guards make the duplicate-inclusion question moot. Order is not cosmetic:
 * a header that references a type defined below it does not compile.
 */
/*
 * The generated SDS headers cross-reference each other by family
 * (`#include "RFM_generated.h"`). Concatenated into one unit those paths do not
 * exist, and the compiler reports the GENERATED file rather than the schema
 * that wanted it — which is how a missing family reads as a mysterious
 * `PLD_generated.h not found`. Strip them; the concatenation order above is
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

const pieces = [
  abi.header,
  // Dependency order, computed from the schemas' own include graph rather
  // than guessed: $OEM pulls RFM, TIM, CAT, PPE, and CAT in turn pulls IDM,
  // PLD and LCC. In one translation unit a header that references a type
  // declared below it does not compile, and the failure names a generated file
  // rather than the schema that wanted it.
  stripSdsCrossIncludes(headers.RFM),
  stripSdsCrossIncludes(headers.TIM),
  stripSdsCrossIncludes(headers.IDM),
  stripSdsCrossIncludes(headers.PLD),
  stripSdsCrossIncludes(headers.LCC),
  stripSdsCrossIncludes(headers.CAT),
  stripSdsCrossIncludes(headers.PPE),
  stripSdsCrossIncludes(headers.OEM),
  stripLocalIncludes(await read(path.join(productsSrc, "ephemeris_series.hpp"))),
  stripLocalIncludes(await read(path.join(ccsdsSrc, "kvn.hpp"))),
  stripLocalIncludes(await read(path.join(productsSrc, "daf.hpp"))),
  stripLocalIncludes(await read(path.join(productsSrc, "spk_read.hpp"))),
  stripLocalIncludes(await read(path.join(productsSrc, "code500.hpp"))),
  stripLocalIncludes(await read(path.join(productsSrc, "stk_ephemeris.hpp"))),
  stripLocalIncludes(await read(path.join(productsSrc, "sp3.hpp"))),
  stripLocalIncludes(await read(path.join(productsSrc, "oem_projection.hpp"))),
  stripLocalIncludes(await read(path.join(productsSrc, "containers.hpp"))),
  stripLocalIncludes(
    await read(path.join(packageRoot, "src", "ephemeris_propagator_module.cpp")),
  ),
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
  // toolchain; emcc is not the lane for new work). This module genuinely
  // cannot spawn: ingest is one pass over a buffer and every propagate call is
  // a bounded interpolation over a resident window. Declaring it is a
  // permanent claim the SDK's artifact assertion holds us to, so a future edit
  // that adds a thread fails loudly instead of silently re-shaping the
  // artifact.
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
      propagatorAbiHeader: path.relative(packageRoot, abi.source),
      threadModel: "wasi-sequential",
      formats: ["CCSDS_OEM_KVN", "SPK_DAF", "CODE500", "STK_EPHEMERIS", "SP3_D"],
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
    `spacedatastandards.org@${sdsVersion} and ${path.relative(packageRoot, abi.source)}`,
);
