// The build must compile the physics library that the tests measure.
//
// Until gmat-07 it did not. `src/cpp/` carried its own copy of nine of the ten
// `lib/*.cpp` translation units and fourteen of the fifteen `lib/*.h` headers,
// and `src/cpp/CMakeLists.txt` compiled the COPIES. They had drifted: at
// modules `44d146b8` the copies still held the pre-fix `mu/r^3` spherical
// harmonics scaling and the pre-fix J3 sign and J4 prefactor that
// `gmat-01-defect-burn-down` had already corrected in `lib/`. So the fix was
// green in every test and absent from every shipped byte, and the plugin read
// -1.07e-6 rad/orbit for a nodal regression whose true value is -5.157e-3.
//
// A duplicate that is byte-identical today is not safe either: it is the state
// the drifted copies were in the day they were made. The gate is therefore
// existence, not equality.
//
// This is a structural check with a computable outcome (a file set), not a
// source-pattern test: it asserts the build graph reaches exactly one copy of
// each translation unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hpop = resolve(here, "..");
const lib = join(hpop, "lib");
const cppDir = join(hpop, "src", "cpp");

/** Every basename the canonical physics library owns. */
function libOwnedNames() {
  return new Set(
    readdirSync(lib).filter((f) => f.endsWith(".cpp") || f.endsWith(".h")),
  );
}

/** Every source/header file anywhere under src/cpp, excluding generated code. */
function cppTreeFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // `generated/` is flatc output and `nlohmann/` is a vendored
        // third-party header-only library. Neither shadows lib/.
        if (e.name === "generated" || e.name === "nlohmann") continue;
        walk(p);
        continue;
      }
      if (e.name.endsWith(".cpp") || e.name.endsWith(".h")) out.push(p);
    }
  };
  walk(cppDir);
  return out;
}

test("src/cpp holds no copy of a lib/ translation unit or header", () => {
  const owned = libOwnedNames();
  const shadows = cppTreeFiles()
    .filter((p) => owned.has(basename(p)))
    .map((p) => p.slice(hpop.length + 1));

  assert.deepEqual(
    shadows,
    [],
    `these files shadow propagator/hpop/lib and the build would compile them ` +
      `instead: ${shadows.join(", ")}. Compile lib/ directly; do not copy it.`,
  );
});

test("the CMake library target compiles lib/ sources, not local copies", () => {
  const cmake = readFileSync(join(cppDir, "CMakeLists.txt"), "utf8");
  const target = cmake.slice(
    cmake.indexOf("add_library("),
    cmake.indexOf(")", cmake.indexOf("add_library(")),
  );
  assert.notEqual(target.length, 0, "add_library() block not found");

  // Every .cpp the physics library target names must resolve to a file that
  // exists, and every lib/ translation unit must be named exactly once.
  const named = [...target.matchAll(/([\w./$\{\}"-]+\.cpp)/g)].map((m) =>
    m[1].replaceAll('"', "").replace("${HPOP_LIB_DIR}", lib),
  );
  const fromLib = named
    .filter((p) => p.startsWith(lib))
    .map((p) => basename(p))
    .sort();

  const expected = readdirSync(lib).filter((f) => f.endsWith(".cpp")).sort();
  assert.deepEqual(
    fromLib,
    expected,
    "the CMake target and lib/ disagree about which translation units exist",
  );
  for (const p of named) {
    const abs = p.startsWith("/") ? p : join(cppDir, p);
    assert.ok(existsSync(abs), `CMake names a source that does not exist: ${p}`);
  }
});
