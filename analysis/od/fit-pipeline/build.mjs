#!/usr/bin/env node
/**
 * Build the OD Fit Pipeline (typed contracts 1.0) through the SDK compiler.
 *
 * One translation unit: src/fit_pipeline.cpp and the analysis/od fit library it calls, read in place from
 * ../src/cpp (never copied): the $OEM reader, the SGP4 fitter, the $OMM / $OBD builders, the frame and time
 * transforms and the SGP4 base (foundation/sgp4-str3). Their SDS headers are analysis/od's (licensing/core/src/cpp/generated/sds), the same
 * ones analysis/od's `fit` compiles, so the records are byte-for-byte that module's for the same fit. The SDK
 * compiler stages the PIV bridge, the runtime types (TimerTick, FlowNotice, HostOps) and typedHostcall.hpp.
 *
 *   SDN_OD_EIGEN_DIR=<dir holding Eigen/Dense> node build.mjs
 *
 * build-driver.mjs is the SDK's compiler hook: it adds the Eigen include to the module's compile, and nothing to the
 * numerics (analysis/od compiles the fitter without -ffast-math).
 *
 * Output: dist/isomorphic/module.wasm (browser and wasmedge; storage_query, timers) and dist/guest-link/. The tests
 * load that artifact itself in the SDK's in-process harness with a stub host (test/module.test.mjs).
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { assertArtifactThreadModel } from "../../../scripts/lib/thread-model.mjs";

// THREAD MODEL - declared, never inferred (scripts/lib/thread-model.mjs): one pass fits object after object on the
// calling thread and spawns nothing; the SDK's wasm32-wasip1-threads toolchain builds it without threads, as it
// builds analysis/od. The manifest's sequentialJustification says why.
const THREAD_MODEL = "wasi-sequential";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../../..");
const odCpp = path.resolve(root, "../src/cpp");
const sdsDir = path.join(repo, "licensing/core/src/cpp/generated/sds");
const includeRoots = [path.join(odCpp, "include"), path.join(odCpp, "include/od"), path.join(repo, "foundation/sgp4-str3/include"), sdsDir];
// Headers the SDK compiler stages itself.
const staged = new Set(["space_data_module_invoke.h", "typedHostcall.hpp", "FlowNotice_generated.h", "TimerTick_generated.h"]);

function resolveEigen() {
  const candidates = [process.env.SDN_OD_EIGEN_DIR, process.env.EIGEN3_INCLUDE_DIR, "/opt/homebrew/include/eigen3",
    "/opt/homebrew/opt/eigen/include/eigen3", "/usr/local/include/eigen3", "/usr/include/eigen3"].filter(Boolean);
  const found = candidates.find((dir) => fsSync.existsSync(path.join(dir, "Eigen/Dense")));
  if (!found) throw new Error("Eigen headers not found: set SDN_OD_EIGEN_DIR to the directory holding Eigen/Dense.");
  return found;
}

// Inline a source's local includes (each once), so the SDK compiler gets one translation unit. The SDS headers lose
// the flatc version static_assert (the SDK stages its own flatbuffers runtime), as hostcap/clock does.
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
    const candidate = [path.dirname(file), ...includeRoots].map((dir) => path.resolve(dir, match[1])).find((p) => fsSync.existsSync(p));
    if (!candidate) throw new Error(`Unresolved include "${match[1]}" in ${path.relative(repo, file)}`);
    lines.push(await inline(candidate));
  }
  return `\n// Source: ${path.relative(repo, file)}\n${lines.join("\n")}\n`;
}

const odSources = ["meme_parser", "frame_transform", "oem_fb_reader", "omm_fb_builder", "obd_fb_builder", "sgp4_fitter"]
  .map((name) => path.join(odCpp, "src", `${name}.cpp`));
const pieces = [];
for (const file of [path.join(root, "src/fit_pipeline.cpp"), ...odSources]) {
  pieces.push(await inline(file));
}
// The fit library's defines (analysis/od: -DNDEBUG -DEIGEN_DONT_PARALLELIZE; -O3 is the SDK's).
const sourceCode = ["#define NDEBUG 1", "#define EIGEN_DONT_PARALLELIZE 1", ...pieces].join("\n");

// The SDK compiler hook (build-driver.mjs) adds the Eigen headers to the module's compile; it runs the clang the SDK
// would have run.
process.env.FIT_PIPELINE_EIGEN_DIR = resolveEigen();
process.env.FIT_PIPELINE_CLANGXX = process.env.SDN_WASI_CLANGXX || "wasm32-wasi-clang++";
process.env.SDN_WASI_CLANGXX = path.join(root, "build-driver.mjs");

const manifestPath = path.join(root, "plugin-manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const distRoot = path.join(root, "dist");
await fs.rm(distRoot, { recursive: true, force: true });
const outputPath = path.join(distRoot, "isomorphic/module.wasm");
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compile = (m, out) => compileModuleFromSource({ manifest: m, sourceCode, language: "c++", outputPath: out, threadModel: THREAD_MODEL, allowUndefinedImports: true });
const compilation = await compile(manifest, outputPath);
if (!compilation.report?.ok) throw new Error(`SDK validation failed:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`);
assertArtifactThreadModel(outputPath, THREAD_MODEL, "analysis/od/fit-pipeline");

const guestLinkDir = path.join(distRoot, "guest-link");
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
await fs.writeFile(path.join(guestLinkDir, "metadata.json"), `${JSON.stringify({
  version: 1, format: compilation.guestLink.format, language: compilation.guestLink.language,
  threadModel: compilation.guestLink.threadModel, symbolPrefix: compilation.guestLink.symbolPrefix,
  methodSymbols: compilation.guestLink.methodSymbols, capabilities: manifest.capabilities,
}, null, 2)}\n`);
await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

const wasm = await fs.readFile(outputPath);
console.log(`Built ${path.relative(root, outputPath)} (${wasm.length} bytes) sha256 ${createHash("sha256").update(wasm).digest("hex")}`);
