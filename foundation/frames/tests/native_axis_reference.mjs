// Builds and runs the NATIVE axis-engine parity harness once per process, and
// exposes both its full report and the machine-readable reference block it
// prints.
//
// Two suites need this: axis_engine_parity.test.mjs asserts the report has zero
// failures, and coordinate_systems.test.mjs compares the SHIPPED WASM artifact
// against the reference values. Compiling the vendored ERFA takes about nine
// seconds, so it is done once and cached.
//
// Compiles the vendored ERFA (higherpop/third_party/erfa — BSD-3, derived with
// permission from IAU SOFA) alongside the engine, because the acceptance's
// "one chain" criterion is precisely that this engine and higherpop/frames.hpp
// reach the SAME series evaluation. Building against a second copy of the
// series would defeat the thing being measured.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "axis_engine_parity.cpp");
const includePath = path.join(here, "..", "src");
export const ERFA_ROOT = path.join(here, "..", "..", "..", "higherpop", "third_party", "erfa");

// ERFA ships its own test drivers in the same directory; they define their own
// main() and must not be linked into ours.
const ERFA_EXCLUDED = new Set(["t_erfa_c.c", "t_erfa_c_extra.c", "erfaversion.c"]);

let cached;

export function hasNativeToolchain() {
  return (
    spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("cc", ["--version"], { stdio: "ignore" }).status === 0 &&
    existsSync(ERFA_ROOT)
  );
}

/// Runs the harness. Returns null when the toolchain or the vendored ERFA is
/// absent — a PROVISIONING gap, which callers report as a skip rather than as
/// a physics failure.
export function runNativeAxisHarness() {
  if (cached !== undefined) {
    return cached;
  }
  if (!hasNativeToolchain()) {
    cached = null;
    return cached;
  }

  const erfaSources = readdirSync(ERFA_ROOT)
    .filter((name) => name.endsWith(".c") && !ERFA_EXCLUDED.has(name))
    .map((name) => path.join(ERFA_ROOT, name));
  if (erfaSources.length <= 100) {
    throw new Error(`vendored ERFA looks incomplete at ${ERFA_ROOT}`);
  }

  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-frames-axis-"));
  const binaryPath = path.join(workDir, "axis");
  try {
    // Compile ERFA as C (it is C, and building it as C++ changes linkage).
    const objects = [];
    for (const source of erfaSources) {
      const objectPath = path.join(workDir, `${path.basename(source, ".c")}.o`);
      execFileSync("cc", ["-O2", "-I", ERFA_ROOT, "-c", source, "-o", objectPath], {
        stdio: "pipe",
      });
      objects.push(objectPath);
    }

    execFileSync(
      "c++",
      ["-std=c++17", "-O2", "-I", includePath, "-I", ERFA_ROOT, "-o", binaryPath, sourcePath,
        ...objects],
      { stdio: "pipe" },
    );

    const run = spawnSync(binaryPath, [], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    cached = { stdout: run.stdout ?? "", status: run.status, error: run.error };
    return cached;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/// The reference block the harness prints, parsed. Null when the harness could
/// not run.
export function buildNativeAxisReference() {
  const run = runNativeAxisHarness();
  if (!run) {
    return null;
  }
  const match = run.stdout.match(/REFERENCE_JSON_BEGIN\n([\s\S]*?)\nREFERENCE_JSON_END/);
  if (!match) {
    throw new Error("the native axis harness printed no REFERENCE_JSON block");
  }
  return JSON.parse(match[1]);
}
