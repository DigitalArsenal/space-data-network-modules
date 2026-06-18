import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function collectBuildScripts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const scripts = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scripts.push(...(await collectBuildScripts(fullPath)));
      continue;
    }

    if (/^build\.(?:js|mjs)$/.test(entry.name)) {
      scripts.push(fullPath);
    }
  }

  return scripts;
}

test("module build scripts use the public SDK package API", async () => {
  const buildScripts = await collectBuildScripts(repoRoot);
  assert.ok(buildScripts.length > 0, "expected build scripts to scan");

  for (const scriptPath of buildScripts) {
    const source = await readFile(scriptPath, "utf8");
    const relativePath = path.relative(repoRoot, scriptPath);

    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*space-data-module-sdk\/src\//,
      `${relativePath} must import SDK helpers through package exports`,
    );
  }
});
