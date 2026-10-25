#!/usr/bin/env node
/**
 * Build the Supplemental OMM sdnap adapter node (typed contracts 1.0) through the SDK compiler, unsigned.
 *
 * One translation unit: src/node.cpp with the SDS headers it reads and writes ($OEM, $DSS) inlined from analysis/od's
 * generated set (licensing/core/src/cpp/generated/sds, the headers the OD node is built on), each once, their flatc
 * version static_assert dropped (the SDK stages its own FlatBuffers runtime). The SDK stages the invoke bridge and the
 * runtime types (FlowNotice, IngestResult).
 *
 * Output: dist/isomorphic/module.wasm (browser and WasmEdge, portable, UNSIGNED) and dist/plugin-manifest.json; the
 * flow's release step (scripts/release.mjs) adds the WasmEdge universal-AOT section and the signature.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const root = path.dirname(fileURLToPath(import.meta.url));
const sdsDir = path.resolve(root, "../../../../licensing/core/src/cpp/generated/sds");
const staged = new Set(["space_data_module_invoke.h", "typedHostcall.hpp", "IngestRequest_generated.h", "IngestResult_generated.h", "HttpRequest_generated.h"]);
const commonDir = path.resolve(root, "../../../../common");
// The standards the manifests are validated against: SPACE_DATA_STANDARDS_ROOT, else the spacedatastandards.org package
// this flow pins (package.json devDependencies).
process.env.SPACE_DATA_STANDARDS_ROOT ??= path.dirname(createRequire(import.meta.url).resolve("spacedatastandards.org/package.json"));

const emitted = new Set();
async function inline(file) {
  file = path.resolve(file);
  if (emitted.has(file)) return "";
  emitted.add(file);
  let text = await fs.readFile(file, "utf8");
  if (file.startsWith(sdsDir)) text = text.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "");
  const lines = [];
  for (const line of text.split("\n")) {
    const match = /^\s*#\s*include\s+"([^"]+)"/.exec(line);
    if (!match || staged.has(match[1]) || match[1].startsWith("flatbuffers/")) {
      lines.push(line);
      continue;
    }
    const candidate = [path.dirname(file), sdsDir, commonDir].map((dir) => path.resolve(dir, match[1])).find((p) => fsSync.existsSync(p));
    if (!candidate) throw new Error(`Unresolved include "${match[1]}" in ${file}`);
    lines.push(await inline(candidate));
  }
  return lines.join("\n");
}

const manifestPath = path.join(root, "plugin-manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = await inline(path.join(root, "src/node.cpp"));
const distRoot = path.join(root, "dist");
const outputPath = path.join(distRoot, "isomorphic/module.wasm");
await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs). The guest never spawns a
  // thread (manifest sequentialJustification); clang wasm32-wasip1-threads is the repo's one guest object format, so
  // every flow links its modules' guest-link objects together (graph/checks/flow-link-models.mjs).
  threadModel: "wasi-sequential",
  allowUndefinedImports: true,
});
if (!compilation.report?.ok) throw new Error(`SDK validation failed:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`);
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));
const wasm = await fs.readFile(outputPath);
console.log(`Built ${manifest.pluginId} ${manifest.version} ${createHash("sha256").update(wasm).digest("hex")} (${wasm.length} bytes, unsigned)`);
