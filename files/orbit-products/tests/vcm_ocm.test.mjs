// Drives the native VCM -> $OCM projection checks against the SDS headers
// generated from the pinned, published spacedatastandards.org package.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulesRoot = path.join(here, "..", "..", "..");

// The FlatBuffers C++ runtime is the stack's flatbuffers checkout, beside this
// repository; FLATBUFFERS_INCLUDE_DIR overrides it.
const runtimeCandidates = [
  process.env.FLATBUFFERS_INCLUDE_DIR,
  path.join(modulesRoot, "..", "flatbuffers", "include"),
  path.join(homedir(), "software", "main-packages", "flatbuffers", "include"),
].filter(Boolean);
const runtime = runtimeCandidates.find((dir) => existsSync(path.join(dir, "flatbuffers", "flatbuffers.h")));

test("VCM text and $VCM records project onto verified $OCM buffers", { skip: runtime ? false : "no FlatBuffers C++ runtime; set FLATBUFFERS_INCLUDE_DIR" }, () => {
  const work = mkdtempSync(path.join(tmpdir(), "orbit-products-vcm-ocm-"));
  try {
    const binary = path.join(work, "vcm-ocm-native");
    execFileSync("c++", ["-std=c++17", "-O2", "-I", path.join(here, "..", "src"),
      "-I", path.join(here, "..", "src", "generated", "sds"), "-I", runtime,
      path.join(here, "vcm_ocm_native.cpp"), "-o", binary], { stdio: "pipe" });
    const run = spawnSync(binary, [path.join(here, "..", "fixtures", "vcm_v2_sample.txt")], { encoding: "utf8" });
    process.stdout.write(run.stdout ?? "");
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /PASS vcm-ocm cases=\d+ failures=0/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
