import { spawnSync } from "node:child_process";
import test from "node:test";

test("current module parity index records SDK and implementation readiness", () => {
  const result = spawnSync(process.execPath, ["scripts/check-current-module-index.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
});
