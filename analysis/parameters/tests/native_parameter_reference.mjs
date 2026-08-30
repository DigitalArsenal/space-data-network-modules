// Builds and runs the NATIVE parameter-catalog parity harness once per process.
//
// The harness compiles the SAME headers the WASM module compiles — the axis
// engine, the element-set library, the generated roster and the evaluator —
// against the vendored ERFA, so "the module agrees with the reference vectors"
// is a statement about one implementation rather than two.
//
// Compiling the vendored ERFA takes about ten seconds, so it is done once and
// cached, exactly as foundation/frames does for its own harness.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "parameter_catalog_parity.cpp");
const parametersInclude = path.join(here, "..", "src");
const framesInclude = path.join(here, "..", "..", "..", "foundation", "frames", "src");
const orbitsInclude = path.join(here, "..", "..", "..", "foundation", "orbits", "src");
export const ERFA_ROOT = path.join(
  here, "..", "..", "..", "higherpop", "third_party", "erfa",
);

// ERFA ships its own test drivers beside the library; they define main().
const ERFA_EXCLUDED = new Set(["t_erfa_c.c", "t_erfa_c_extra.c", "erfaversion.c"]);

let cached;

export function hasNativeToolchain() {
  return (
    spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("cc", ["--version"], { stdio: "ignore" }).status === 0 &&
    existsSync(ERFA_ROOT)
  );
}

/// Returns null when the toolchain or the vendored ERFA is absent — a
/// PROVISIONING gap, reported as a skip rather than as a physics failure.
export function runNativeParameterHarness() {
  if (cached !== undefined) return cached;
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

  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-parameters-"));
  const binaryPath = path.join(workDir, "parameters");
  try {
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
      [
        "-std=c++17", "-O2",
        "-I", parametersInclude, "-I", framesInclude, "-I", orbitsInclude, "-I", ERFA_ROOT,
        "-o", binaryPath, sourcePath, ...objects,
      ],
      { stdio: "pipe" },
    );
    const run = spawnSync(binaryPath, [], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    cached = { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
  } catch (error) {
    cached = { status: 1, stdout: "", stderr: String(error), error };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return cached;
}
