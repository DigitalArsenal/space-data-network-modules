import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Basilisk plan checker resolves the stack-local Basilisk checkout by default", () => {
  const env = { ...process.env };
  delete env.BASILISK_ROOT;

  const result = spawnSync(process.execPath, ["scripts/check-basilisk-plan.mjs"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `expected checker to pass without BASILISK_ROOT\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});
