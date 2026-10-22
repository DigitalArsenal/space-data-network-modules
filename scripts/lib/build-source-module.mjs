// The build every pure source parser shares: the SDS C++ headers its manifest names (generated from the
// spacedatastandards.org package the module pins), the repository's JSON library, the shared headers it
// uses and its own source, compiled as ONE translation unit by the SDK the module pins.
//
// The module's build.mjs passes in its own `compileModuleFromSource` and `createFlatc`, so the module's
// package.json decides which SDK and flatc-wasm build it (published-deps law); nothing here imports either.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { generateSdsHeaders } from "./sds-cpp-headers.mjs";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

// root: the module directory. importMeta: the module's own import.meta.url (where its packages are found).
// families: the SDS families the source reads or writes. common: headers of common/ in the order they are
// included. sources: the module's own files, relative to root, in the order they are included. extraHeaders:
// repository files (relative to the repository) included before the module's own, in order.
export async function buildSourceModule({ root, importMeta, compileModuleFromSource, createFlatc, families, common = [], sources, threadModel, extraHeaders = [], allowUndefinedImports = false }) {
  if (!threadModel) throw new Error("threadModel is declared by the module's build.mjs, never inferred (scripts/lib/thread-model.mjs)");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "plugin-manifest.json"), "utf8"));
  const { header, version, families: ordered } = await generateSdsHeaders(families, importMeta, createFlatc);
  const json = await fs.readFile(path.join(repo, "propagator/sgp4/src/cpp/include/nlohmann/json.hpp"), "utf8");
  // The headers are concatenated into one translation unit: a `#pragma once` is only a warning there, and an
  // `#include "sibling.hpp"` finds nothing (the pieces are already in the unit, in the order given).
  const read = async (file) => (await fs.readFile(file, "utf8")).replace(/^#pragma once\s*$/gm, "").replace(/^#include "[^"]+"\s*$/gm, "");
  const commonSources = await Promise.all(common.map((name) => read(path.join(repo, "common", name))));
  const extra = await Promise.all(extraHeaders.map((file) => read(path.join(repo, file))));
  const own = await Promise.all(sources.map((file) => read(path.join(root, file))));
  const outputPath = path.join(root, "dist/isomorphic/module.wasm");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const result = await compileModuleFromSource({
    manifest,
    sourceCode: ['#include "space_data_module_invoke.h"', "#define JSON_NOEXCEPTION 1", json, header, ...commonSources, ...extra, ...own].join("\n\n"),
    language: "c++",
    outputPath,
    threadModel,
    // A module on the typed hostcall bridge (typedHostcall.hpp: plugin.getConfig, storage, http) imports
    // space_data_module_host symbols that resolve only at instantiation.
    allowUndefinedImports,
  });
  if (!result.report?.ok) throw new Error(JSON.stringify(result.report?.issues ?? result.report));
  await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(root, "dist/plugin-manifest.json"));
  // The flow compiler links a module as a node from its prefixed guest-link object, and a host composes a
  // parser with its HTTP and storage nodes the same way.
  const guestLinkDir = path.join(root, "dist/guest-link");
  await fs.mkdir(guestLinkDir, { recursive: true });
  await fs.writeFile(path.join(guestLinkDir, "module-link.o"), result.guestLink.objectBytes);
  const { format, language, threadModel: linkThreadModel, symbolPrefix, methodSymbols } = result.guestLink;
  await fs.writeFile(path.join(guestLinkDir, "metadata.json"), `${JSON.stringify({ version: 1, format, language, threadModel: linkThreadModel, symbolPrefix, methodSymbols }, null, 2)}\n`);
  const wasm = await fs.readFile(outputPath);
  await fs.writeFile(path.join(root, "dist/build-provenance.json"), `${JSON.stringify({
    spacedatastandards: version,
    sdsFamilies: ordered,
    commonHeaders: common,
    sources,
    threadModel,
    wasmSha256: createHash("sha256").update(wasm).digest("hex"),
  }, null, 2)}\n`);
  console.log(`Built ${outputPath} against spacedatastandards.org@${version}`);
  return result;
}
