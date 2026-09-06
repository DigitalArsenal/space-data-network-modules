/**
 * Build maneuver-planner through the SDK compiler lane.
 *
 * WHY THIS REPLACED build.sh + emcc.
 *
 * 0.1.0 was linked by a repo-local emsdk 6.0.1 through the `EMSCRIPTEN` branch
 * of src/cpp/CMakeLists.txt. The artifact it produced happened to be clean
 * (pure wasi imports, single-threaded, runs under all three runtimes) but the
 * LANE was outside the sanctioned toolchain, and the link line is what caused
 * this module's worst defect: no `-fexceptions`, so every `throw` — including
 * every `j.at()` in the JSON bridge and every validator the authors wrote —
 * lowered to a trap that poisoned the instance. A build lane that can silently
 * delete a module's entire error path is not a lane to keep.
 *
 * `compileModuleFromSource` takes ONE translation unit, so the C++ sources are
 * AMALGAMATED here: headers first in dependency order, then the sources, with
 * the intra-module `#include "maneuver/..."` lines removed (each header appears
 * exactly once, so the guards would have suppressed the duplicates anyway).
 * The amalgamation is mechanical and one-directional — nothing is edited, the
 * files on disk stay the real sources, and `src/cpp/CMakeLists.txt` still
 * builds the same files natively for the C++ unit tests.
 *
 * Thread model: `wasi-sequential`, declared in the manifest AND passed
 * explicitly here. `resolveThreadModel` reads the compile OPTION, not
 * `manifest.threadModel`, and infers from `runtimeTargets` when neither is
 * given — where "wasmedge" infers pthreads. A manifest that declares sequential
 * and does not pass it here is compiled under the other model and then rejected
 * by the post-link artifact guard (filed upstream as
 * `sdk-manifest-threadmodel-silently-ignored`).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const cppRoot = path.join(packageRoot, "src", "cpp");
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const lambertSolverPath = path.join(
  packageRoot,
  "..",
  "lambert-izzo",
  "include",
  "lambert_izzo",
  "solver.hpp",
);

/**
 * Header order is DEPENDENCY order, not alphabetical: a single translation unit
 * has no include machinery left to sort this out. `types.h` and `constants.h`
 * first because everything names them; `approach.h` after `classical.h` because
 * it returns a `HohmannResult`.
 */
const HEADERS = [
  "types.h",
  "constants.h",
  "fault.h",
  "json_lite.h",
  "math.h",
  "transforms.h",
  "stm.h",
  "propagation.h",
  "targeting.h",
  "classical.h",
  "approach.h",
  "rendezvous.h",
  "sixdof_core.h",
  "maneuver_plugin.h",
  "plugin_runtime.h",
  "orbit_geometry.h",
];

/** Sources, in the same order the static library lists them. */
const SOURCES = [
  "fault.cpp",
  "json_lite.cpp",
  "math.cpp",
  "stm.cpp",
  "transforms.cpp",
  "propagation.cpp",
  "targeting.cpp",
  "classical.cpp",
  "approach.cpp",
  "rendezvous.cpp",
  "maneuver_plugin.cpp",
  "plugin_runtime.cpp",
  "orbit_geometry.cpp",
  // The invoke entry point last: it is the only file that reaches for the
  // SDK-generated `space_data_module_invoke.h`, which the compiler writes
  // beside the amalgamated source.
  "plugin_entrypoints.cpp",
];

const LOCAL_INCLUDE = /^\s*#\s*include\s+"(?:maneuver\/)?[A-Za-z0-9_./]+\.h"\s*$/;

async function readStripped(file) {
  const text = await fs.readFile(file, "utf8");
  const kept = [];
  for (const line of text.split("\n")) {
    if (LOCAL_INCLUDE.test(line) || line.trim() === '#include "state_representations.hpp"') {
      // The one local include that must SURVIVE: the SDK writes this header
      // into the compile directory, so it is resolved by -I, not amalgamated.
      if (line.includes("space_data_module_invoke.h")) {
        kept.push(line);
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

const parts = [
  "// ===========================================================================",
  "// GENERATED AMALGAMATION — do not edit.",
  "// Assembled by analysis/maneuver/build.js from src/cpp/{include,src}.",
  "// The files under src/cpp are the sources of record.",
  "// ===========================================================================",
  "",
];

parts.push("// ---- shared lambert-izzo/include/lambert_izzo/solver.hpp ----");
parts.push(await fs.readFile(lambertSolverPath, "utf8"));
parts.push(await fs.readFile(path.join(packageRoot, "../../foundation/orbits/src/state_representations.hpp"), "utf8"));

for (const header of HEADERS) {
  const file = path.join(cppRoot, "include", "maneuver", header);
  parts.push(`// ---- include/maneuver/${header} ----`);
  parts.push(await readStripped(file));
}
for (const source of SOURCES) {
  const file = path.join(cppRoot, "src", source);
  parts.push(`// ---- src/${source} ----`);
  parts.push(await readStripped(file));
}

const sourceCode = parts.join("\n");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: manifest.threadModel,
});

if (compilation.threadModel !== manifest.threadModel) {
  throw new Error(
    `threadModel drift: the manifest declares ${manifest.threadModel} but the ` +
      `compiler resolved ${compilation.threadModel}.`,
  );
}

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled maneuver-planner failed SDK validation:\n${issues}`);
}

const bytes = await fs.readFile(outputPath);
const { createHash } = await import("node:crypto");
const digest = createHash("sha256").update(bytes).digest("hex");

console.log(
  `Built ${path.relative(packageRoot, outputPath)} ` +
    `(${compilation.compiler}, threadModel=${compilation.threadModel}, ` +
    `${bytes.length} bytes, sha256=${digest})`,
);
