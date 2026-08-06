import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileUniversalAot } from "../nodes/universal-aot.mjs";
import { listWasmCustomSections } from "space-data-module-sdk";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

// The fake compilers below must answer with THE pinned version, read from the
// SDK's wasmedgePin.json exactly like scripts/compile-universal-aot.sh does. A
// literal here would re-create the drift this pin exists to prevent.
const pinnedWasmEdgeVersion = JSON.parse(
  fs.readFileSync(
    path.join(
      packageRoot,
      "../../node_modules/space-data-module-sdk/src/testing/wasmedgePin.json",
    ),
    "utf8",
  ),
).wasmedgeVersion;

const childBuilders = [
  "nodes/providers/build-provider.mjs",
  "nodes/build-signed-node.mjs",
  "nodes/timer/build.mjs",
  "nodes/od/build.mjs",
  "nodes/flatsql/build.mjs",
];

function source(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

test("every AOT-aware build entrypoint parses as executable JavaScript", () => {
  for (const relativePath of [
    "nodes/universal-aot.mjs",
    ...childBuilders,
    "scripts/package-bundle.mjs",
  ]) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ["--check", path.join(packageRoot, relativePath)]),
      `${relativePath} failed node --check`,
    );
  }
});

test("every production child compiles universal AOT before signing", () => {
  for (const relativePath of childBuilders) {
    const build = source(relativePath);
    assert.match(build, /compileUniversalAot/,
      `${relativePath} does not stage universal AOT`);
    const compileAt = build.lastIndexOf("compileUniversalAot(");
    const signAt = build.lastIndexOf("signModuleArtifact(");
    assert.ok(compileAt >= 0 && compileAt < signAt,
      `${relativePath} must AOT-compile the unsigned child before signing`);
    assert.match(
      build.slice(compileAt, signAt),
      /mode:\s*["']child["']/,
      `${relativePath} must select the child gas-instrumented AOT profile`,
    );
  }
});

test("the production parent compiles universal AOT before bundle signing", () => {
  const build = source("scripts/package-bundle.mjs");
  const compileAt = build.lastIndexOf("compileUniversalAot(");
  const signAt = build.lastIndexOf("signModuleArtifact(");
  assert.ok(compileAt >= 0 && compileAt < signAt,
    "the parent must AOT-compile its unsigned flow runtime before signing");
  assert.match(build.slice(compileAt, signAt), /mode:\s*["']parent["']/);
});

test("every release-signed build requires AOT even when NODE_ENV is omitted", () => {
  for (const relativePath of [
    "nodes/providers/build-provider.mjs",
    "nodes/build-signed-node.mjs",
    "nodes/timer/build.mjs",
    "nodes/od/build.mjs",
    "scripts/package-bundle.mjs",
  ]) {
    assert.match(
      source(relativePath),
      /productionMode:\s*productionMode\s*\|\|\s*!developmentOnly|const productionMode\s*=\s*[\s\S]*!developmentOnly/,
      `${relativePath} could sign a release artifact without universal AOT`,
    );
  }
  assert.match(
    source("nodes/flatsql/build.mjs"),
    /productionMode:\s*buildMode\s*===\s*["']production["']/,
  );
});

test("production AOT staging preserves one isomorphic artifact path", () => {
  const combined = [
    source("nodes/universal-aot.mjs"),
    ...childBuilders.map(source),
    source("scripts/package-bundle.mjs"),
  ].join("\n");
  assert.doesNotMatch(
    combined,
    /(?:x86|amd64|native)[^\n]*(?:\.wasm|\.so|\.dylib|\.exe)|(?:\.aot\.wasm)[^\n]*(?:artifactPath|dist\/isomorphic)/i,
    "AOT staging must not publish a platform-specific substitute artifact",
  );
});

test("production staging invokes the pinned compiler profile while development stays portable", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "supplemental-aot-test-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const compiler = path.join(scratch, "wasmedgec");
  fs.writeFileSync(compiler, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') {",
    `  console.log('wasmedgec version ${pinnedWasmEdgeVersion}');`,
    "  process.exit(0);",
    "}",
    "const input = fs.readFileSync(args.at(-2));",
    "const section = Buffer.concat([",
    "  Buffer.from([0, 10, 8]),",
    "  Buffer.from('wasmedge'),",
    "  Buffer.from([1]),",
    "]);",
    "fs.writeFileSync(args.at(-1), Buffer.concat([input, section]));",
    "",
  ].join("\n"), { mode: 0o700 });
  const priorCompiler = process.env.WASMEDGEC_BIN;
  process.env.WASMEDGEC_BIN = compiler;
  t.after(() => {
    if (priorCompiler === undefined) delete process.env.WASMEDGEC_BIN;
    else process.env.WASMEDGEC_BIN = priorCompiler;
  });

  const minimalWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  await assert.rejects(
    compileUniversalAot({
      wasmBytes: minimalWasm,
      stagingDirectory: path.join(scratch, "ambiguous"),
      mode: "child",
    }),
    /productionMode must be an explicit boolean/,
  );
  const production = await compileUniversalAot({
    wasmBytes: minimalWasm,
    stagingDirectory: path.join(scratch, "production"),
    mode: "child",
    productionMode: true,
  });
  assert.notDeepEqual(production, minimalWasm);
  assert.equal(
    listWasmCustomSections(production).filter(({ name }) => name === "wasmedge")
      .length,
    1,
  );
  assert.equal(
    fs.existsSync(path.join(scratch, "production", "child-universal.wasm")),
    true,
  );

  const copyingCompiler = path.join(scratch, "copying-wasmedgec");
  fs.writeFileSync(copyingCompiler, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    `  echo 'wasmedgec version ${pinnedWasmEdgeVersion}'`,
    "  exit 0",
    "fi",
    "previous=''",
    "last=''",
    "for argument in \"$@\"; do previous=$last; last=$argument; done",
    "cp \"$previous\" \"$last\"",
    "",
  ].join("\n"), { mode: 0o700 });
  process.env.WASMEDGEC_BIN = copyingCompiler;
  await assert.rejects(
    compileUniversalAot({
      wasmBytes: minimalWasm,
      stagingDirectory: path.join(scratch, "unchanged"),
      mode: "child",
      productionMode: true,
    }),
    /unchanged portable WASM/,
  );

  process.env.WASMEDGEC_BIN = path.join(scratch, "missing-compiler");
  const development = await compileUniversalAot({
    wasmBytes: minimalWasm,
    stagingDirectory: path.join(scratch, "development"),
    mode: "parent",
    productionMode: false,
  });
  assert.equal(development, minimalWasm);
  assert.equal(fs.existsSync(path.join(scratch, "development")), false);
});
