import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("current module parity index excludes retired local coverage and swath modules", () => {
  const index = createCurrentModuleIndex(fileURLToPath(new URL("..", import.meta.url)));
  const modulePaths = new Set(index.modules.map((entry) => entry.modulePath));
  assert.equal(modulePaths.has("analysis/coverage"), false);
  assert.equal(modulePaths.has("analysis/swath"), false);
  assert.equal(modulePaths.has("analysis/sensor-coverage"), true);
});

test("current module parity index does not count browser-only shared direct modules as WasmEdge-ready", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "module-index-shared-browser-"));
  try {
    const moduleRoot = path.join(repoRoot, "analysis", "sensor-coverage");
    fs.mkdirSync(path.join(moduleRoot, "src", "cpp"), { recursive: true });
    fs.mkdirSync(path.join(moduleRoot, "tests"), { recursive: true });
    fs.mkdirSync(path.join(moduleRoot, "dist", "isomorphic"), { recursive: true });
    fs.writeFileSync(
      path.join(moduleRoot, "plugin-manifest.json"),
      JSON.stringify({
        pluginId: "sensor-coverage-analysis",
        name: "Sensor Coverage Analysis",
        version: "0.1.0",
        pluginFamily: "analysis",
        runtimeTargets: ["browser"],
        invokeSurfaces: ["direct"],
        methods: [{ methodId: "compute_sensor_coverage" }],
      }),
    );
    fs.writeFileSync(
      path.join(moduleRoot, "package.json"),
      JSON.stringify({
        sdnModuleCompile: {
          importedMemory: true,
          sharedMemory: true,
        },
      }),
    );
    fs.writeFileSync(path.join(moduleRoot, "src", "cpp", "module.cpp"), "int run() { return 0; }\n");
    fs.writeFileSync(path.join(moduleRoot, "tests", "behavior.test.mjs"), "import 'node:test';\n");
    fs.writeFileSync(path.join(moduleRoot, "dist", "isomorphic", "module.wasm"), "");

    const index = createCurrentModuleIndex(repoRoot);
    const module = index.modules.find((entry) => entry.modulePath === "analysis/sensor-coverage");
    assert.ok(module, "temporary module should be inventoried");
    assert.equal(module.isSharedBrowserDirectModule, true);
    assert.equal(module.hasBrowserWasmEdgeTargets, false);
    assert.deepEqual(index.parityScopeTargetGaps, ["analysis/sensor-coverage"]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
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
      path.join(moduleRoot, "src", "cpp", "model.cpp.inc"),
      "int helper() { return 1; }\n",
    );
    fs.writeFileSync(
      path.join(moduleRoot, "src", "cpp", "build-native", "CMakeFiles", "CompilerIdC.c"),
      "int main(void) { return 0; }\n",
    );
    fs.writeFileSync(path.join(moduleRoot, "tests", "behavior.test.mjs"), "import 'node:test';\n");
    fs.writeFileSync(path.join(moduleRoot, "dist", "isomorphic", "module.wasm"), "");

    const index = createCurrentModuleIndex(repoRoot);
    const module = index.modules.find((entry) => entry.modulePath === "analysis/example");
    assert.ok(module, "temporary module should be inventoried");
    assert.deepEqual(module.sourceFiles, ["src/cpp/model.cpp.inc", "src/cpp/module.cpp"]);
    assert.equal(module.cxxSourceFileCount, 2);
    assert.deepEqual(module.testFiles, ["tests/behavior.test.mjs"]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
