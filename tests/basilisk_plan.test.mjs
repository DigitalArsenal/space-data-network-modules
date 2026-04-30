import { spawnSync } from "node:child_process";
import test from "node:test";

test("Basilisk module plan and message standards map are exhaustive and enforceable", () => {
  const result = spawnSync(process.execPath, ["scripts/check-basilisk-plan.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
});
