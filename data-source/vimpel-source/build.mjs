// Typed contracts 1.0 build: the SDK compiler stages the runtime headers (HttpResponse, IngestRequest, FlowNotice);
// the SDS standards ($OEM, $OIL and the families they include) are generated with the object API from the
// spacedatastandards checkout's schemas (SPACE_DATA_STANDARDS_ROOT) by scripts/lib/sds-cpp-headers.mjs. No JSON library:
// nothing between modules is JSON.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import createFlatc from "flatc-wasm/module";
import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeaders } from "../../scripts/lib/sds-cpp-headers.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = path.resolve(root, "../..");
const { header, version, families } = await generateSdsHeaders(["OEM", "OIL"], import.meta.url, createFlatc);
// Pieces are one translation unit: drop `#pragma once` and sibling includes (already in the unit, in order).
const read = async (file) => (await fs.readFile(file, "utf8")).replace(/^#pragma once\s*$/gm, "").replace(/^#include "[^"]+"\s*$/gm, "");

const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
const sourceCode = [
  '#include "space_data_module_invoke.h"',
  '#include "HttpResponse_generated.h"',
  '#include "IngestRequest_generated.h"',
  '#include "FlowNotice_generated.h"',
  header,
  await read(path.join(repo, "common/civil_time.hpp")),
  // The one reader of the public format (files/orbit-products), foundation/orbits' conversion and the SHA-256 the
  // orbit products share.
  ...(await Promise.all(["foundation/orbits/src/state_representations.hpp", "files/orbit-products/src/sha256.hpp", "files/orbit-products/src/vimpel.hpp"].map((f) => read(path.join(repo, f))))),
  await read(path.join(root, "src/vimpel_source.cpp")),
].join("\n\n");
const outputPath = path.join(root, "dist/isomorphic/module.wasm");
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
// THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs). The guest never spawns a
// thread (manifest sequentialJustification); clang wasm32-wasip1-threads is the repo's one guest object format, so
// every flow links its modules' guest-link objects together (graph/checks/flow-link-models.mjs).
const result = await compileModuleFromSource({ manifest, sourceCode, language: "c++", outputPath, threadModel: "wasi-sequential" });
if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues ?? result.report));
await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist/plugin-manifest.json"));
const guest = path.join(root, "dist/guest-link");
await fs.mkdir(guest, { recursive: true });
await fs.writeFile(path.join(guest, "module-link.o"), result.guestLink.objectBytes);
const { format, language, threadModel, symbolPrefix, methodSymbols } = result.guestLink;
await fs.writeFile(path.join(guest, "metadata.json"), `${JSON.stringify({ version: 1, format, language, threadModel, symbolPrefix, methodSymbols }, null, 2)}\n`);
const wasm = await fs.readFile(outputPath);
await fs.writeFile(path.join(root, "dist/build-provenance.json"), `${JSON.stringify({ spacedatastandards: version, standardsRoot: process.env.SPACE_DATA_STANDARDS_ROOT, sdsFamilies: families, threadModel: "wasi-sequential", wasmSha256: createHash("sha256").update(wasm).digest("hex") }, null, 2)}\n`);
console.log(`PASS SDK build ${manifest.pluginId} -> dist/isomorphic/module.wasm`);
