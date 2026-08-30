// Runs tests/environment_conformance.cpp — the gmat-07 environment gate.
//
// The physics lives in C++ (owner law: no JS physics). This driver only
// compiles and runs it, and reports the harness numbers it prints.
//
// Nine bands: gravity-mode routing, spherical-harmonic gates, the generic
// potential-file loader, polyhedron gravity, Harris-Priester, atmosphere label
// honesty, SPAD area tables, predicted solar activity, and the force-model
// contribution port. See the header comment of the .cpp for what each band
// measures and against which authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hpop = resolve(here, "..");            // propagator/hpop
const repo = resolve(hpop, "..", "..");      // module repo root
const nrl = join(repo, "third_party", "nrlmsise00");

function haveCompiler() {
  return spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;
}

test("hpop environment models conform to their stated authorities", (t) => {
  // A missing toolchain means the check cannot RUN. That is not a failure of
  // the code under test — say so and skip, rather than voting on evidence that
  // does not exist.
  if (!haveCompiler()) return t.skip("no C++ compiler on PATH");
  if (!existsSync(nrl)) return t.skip("third_party/nrlmsise00 not present");

  const out = mkdtempSync(join(tmpdir(), "hpop-env-"));
  const objs = [];
  for (const c of ["nrlmsise-00.c", "nrlmsise-00_data.c"]) {
    const o = join(out, `${c}.o`);
    execFileSync("cc", ["-std=c11", "-O2", "-c", join(nrl, c), "-o", o], { stdio: "pipe" });
    objs.push(o);
  }
  const bin = join(out, "envconf");
  execFileSync("c++", [
    "-std=c++17", "-O2",
    "-I", join(hpop, "lib"),
    "-I", nrl,
    join(here, "environment_conformance.cpp"),
    ...["astrodynamics", "coords", "ephemeris", "environment_models",
        "force_models", "integrators", "nrlmsise00", "time_convert", "us76",
        "atmosphere_plugin"].map((f) => join(hpop, "lib", `${f}.cpp`)),
    ...objs,
    "-o", bin,
  ], { stdio: "pipe" });

  const run = spawnSync(bin, { encoding: "utf8" });
  process.stdout.write(run.stdout ?? "");
  assert.equal(run.status, 0, `environment conformance failed:\n${run.stdout}\n${run.stderr}`);
});
