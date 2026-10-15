/**
 * The module's contract with the ecosystem, as opposed to its physics:
 * the exported ABI surface, the embedded manifest, the typed port discipline,
 * and the vectors corpus being reproducible.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { artifactPath } from "./harness.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8"),
);

async function moduleExports() {
  const module = await WebAssembly.compile(fs.readFileSync(artifactPath));
  return {
    exports: WebAssembly.Module.exports(module).map((e) => e.name),
    imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`),
  };
}

test("the propagator ABI surface is exported in full", async () => {
  const { exports } = await moduleExports();
  // Each of these is cited to a section of docs/propagator-abi.md in the
  // module source. The ABI's REQUIRED set plus the typed-ingest and batch
  // exports the reference is expected to demonstrate.
  for (const name of [
    "plugin_init",
    "plugin_init_omm",
    "plugin_ingest_omm_one",
    "plugin_propagate",
    "plugin_propagate_batch",
    "plugin_entity_count",
    "plugin_destroy",
  ]) {
    assert.ok(exports.includes(name), `missing propagator ABI export ${name}`);
  }
});

test("the SDN module surface is exported alongside it", async () => {
  const { exports } = await moduleExports();
  for (const name of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
    "ingest_omm",
  ]) {
    assert.ok(exports.includes(name), `missing SDN module export ${name}`);
  }
});

test("imports are WASI, the shared memory and wasi-threads' thread-spawn only — no emscripten glue", async () => {
  const { imports } = await moduleExports();
  const forbidden = imports.filter(
    (name) =>
      /^invoke_|__cxa_|__resumeException|llvm_eh_typeid_for|__syscall_|emscripten_/.test(
        name.split(".")[1] ?? "",
      ) || /^emscripten/.test(name),
  );
  assert.deepEqual(forbidden, [], `forbidden import class present: ${forbidden}`);
  for (const name of imports) {
    assert.match(
      name,
      /^(wasi_snapshot_preview1\.|wasi\.thread-spawn$|env\.memory$)/,
      `unexpected import ${name}; a new host capability is an owner decision`,
    );
  }
  assert.ok(imports.includes("wasi.thread-spawn"), "a pthreads module imports wasi.thread-spawn");
});

test("the manifest declares family propagator and the pthreads model (owner 2026-10-13)", () => {
  assert.equal(manifest.pluginFamily, "propagator");
  assert.equal(manifest.threadModel, "emscripten-pthreads");
  assert.equal(manifest.sequentialJustification, undefined);
});

test("every port is TYPED to a ratified $ identifier, with no wildcard", () => {
  for (const method of manifest.methods) {
    for (const port of [...(method.inputPorts ?? []), ...(method.outputPorts ?? [])]) {
      for (const set of port.acceptedTypeSets ?? []) {
        assert.ok(set.allowedTypes?.length > 0, `${port.portId} declares no types`);
        for (const allowed of set.allowedTypes) {
          assert.notEqual(
            allowed.acceptsAnyFlatbuffer,
            true,
            `${port.portId} declares acceptsAnyFlatbuffer — a wildcard port is ` +
              `unconformable and is not admissible on a harnessed family`,
          );
          assert.ok(
            String(allowed.fileIdentifier ?? "").startsWith("$"),
            `${port.portId} declares "${allowed.fileIdentifier}", a bare four-byte ` +
              `identifier. A bare identifier is a vendor invention; a harness MUST ` +
              `refuse it. Only $-prefixed ratified SDS types are admissible.`,
          );
        }
      }
    }
  }
});

test("the vectors corpus is reproducible from its generator", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(packageRoot, "vectors", "tools", "build-vectors.mjs"), "--check"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.match(output, /vectors:check PASS/);
});
