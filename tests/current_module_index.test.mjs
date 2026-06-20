import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCurrentModuleIndex } from "../scripts/lib/current-module-index.mjs";

test("current module parity index records SDK and implementation readiness", () => {
  const result = spawnSync(process.execPath, ["scripts/check-current-module-index.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
});

test("current module parity index ignores generated build output directories", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "module-index-"));
  try {
    const moduleRoot = path.join(repoRoot, "analysis", "example");
    fs.mkdirSync(path.join(moduleRoot, "src", "cpp"), { recursive: true });
    fs.mkdirSync(path.join(moduleRoot, "src", "cpp", "build-native", "CMakeFiles"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(moduleRoot, "tests"), { recursive: true });
    fs.mkdirSync(path.join(moduleRoot, "dist", "isomorphic"), { recursive: true });
    fs.writeFileSync(
      path.join(moduleRoot, "plugin-manifest.json"),
      JSON.stringify({
        pluginId: "example",
        name: "Example",
        version: "0.1.0",
        pluginFamily: "analysis",
        runtimeTargets: ["browser", "wasmedge"],
        methods: [{ methodId: "run" }],
      }),
    );
    fs.writeFileSync(path.join(moduleRoot, "src", "cpp", "module.cpp"), "int run() { return 0; }\n");
    fs.writeFileSync(
      path.join(moduleRoot, "src", "cpp", "build-native", "CMakeFiles", "CompilerIdC.c"),
      "int main(void) { return 0; }\n",
    );
    fs.writeFileSync(path.join(moduleRoot, "tests", "behavior.test.mjs"), "import 'node:test';\n");
    fs.writeFileSync(path.join(moduleRoot, "dist", "isomorphic", "module.wasm"), "");

    const index = createCurrentModuleIndex(repoRoot);
    const module = index.modules.find((entry) => entry.modulePath === "analysis/example");
    assert.ok(module, "temporary module should be inventoried");
    assert.deepEqual(module.sourceFiles, ["src/cpp/module.cpp"]);
    assert.deepEqual(module.testFiles, ["tests/behavior.test.mjs"]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
