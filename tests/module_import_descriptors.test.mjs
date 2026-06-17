import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const REPO_ROOT = new URL("..", import.meta.url);
const DESCRIPTOR_PATH = new URL("../docs/module-import-descriptors.json", import.meta.url);

function runChecker(args = []) {
  return spawnSync(
    process.execPath,
    ["scripts/check-module-import-descriptors.mjs", ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
}

function writeMutatedDescriptor(mutate) {
  const descriptor = JSON.parse(fs.readFileSync(DESCRIPTOR_PATH, "utf8"));
  mutate(descriptor);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-module-imports-"));
  const file = path.join(dir, "module-import-descriptors.json");
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`);
  return file;
}

test("module import descriptors validate aligned-binary inter-module contracts", () => {
  const result = runChecker();
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
  assert.match(result.stdout, /validated \d+ module import descriptor/);
});

test("module import descriptors fail closed for missing imported module", () => {
  const file = writeMutatedDescriptor((descriptor) => {
    descriptor.imports[0].provider.modulePath = "propagator/does-not-exist";
  });
  const result = runChecker(["--descriptor", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing provider manifest/i);
});

test("module import descriptors fail closed for wrong schema name", () => {
  const file = writeMutatedDescriptor((descriptor) => {
    descriptor.imports[0].typeRef.schemaName = "orbpro.plugins.NotPropagatorState";
  });
  const result = runChecker(["--descriptor", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provider output.*schemaName/i);
});

test("module import descriptors fail closed for wrong file identifier", () => {
  const file = writeMutatedDescriptor((descriptor) => {
    descriptor.imports[0].typeRef.fileIdentifier = "BAD!";
  });
  const result = runChecker(["--descriptor", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provider output.*fileIdentifier/i);
});

test("module import descriptors fail closed for incompatible dependency version", () => {
  const file = writeMutatedDescriptor((descriptor) => {
    descriptor.imports[0].dependency.providerVersionRange = ">=2.0.0 <3.0.0";
  });
  const result = runChecker(["--descriptor", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provider version.*does not satisfy/i);
});
