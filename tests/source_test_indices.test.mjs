import { spawnSync } from "node:child_process";
import test from "node:test";

test("Orekit and Basilisk source-test indices are generated and enforceable", () => {
  const result = spawnSync(process.execPath, ["scripts/check-source-test-indices.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
});
