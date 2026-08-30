import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the $OEM epoch formatter agrees with the parser that reads it back", () => {
  const out = mkdtempSync(path.join(tmpdir(), "oem-epoch-"));
  const binary = path.join(out, "oem_epoch_native");

  execFileSync(
    "clang++",
    [
      "-std=c++17",
      "-O2",
      "-I",
      path.join(here, "..", "src"),
      path.join(here, "oem_epoch_native.cpp"),
      "-o",
      binary,
    ],
    { stdio: "inherit" },
  );

  const report = execFileSync(binary, { encoding: "utf8" });
  process.stdout.write(report);
  assert.match(report, /0 failures/, "the epoch formatter reported a failure");
  assert.doesNotMatch(report, /\bFAIL\b/, "an epoch assertion failed");
});
