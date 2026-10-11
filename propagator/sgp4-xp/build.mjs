// Builds dist/isomorphic/module.wasm: the SDN module, compiled by the SDK, joined to the US Space Force Sgp4Prop
// build with binaryen's wasm-merge.
//
//   adapter  src/*.cpp through compileModuleFromSource (threadModel wasi-sequential, the clang wasm32-wasip1-threads
//            toolchain). The Space Force functions are imports of the module "ussf", and the two copies between
//            memories are imports of the module "a"; both are answered by the merge, so the compiled adapter alone
//            is not loadable.
//   ussf     third_party/ussf-sgp4/Sgp4Prop.xp.wasm, as released. It imports nine Emscripten functions from the
//            module "a"; it keeps its own linear memory.
//   a        src/shim.wat: the nine imports, in WebAssembly, and the two copies.
//
// wasm-merge resolves every import between the three, which leaves a module that imports only WASI and has two
// memories: the adapter's (memory 0, the one the hosts use) and the library's (memory 1). The merge keeps every
// export of every module; the Space Force module's minified exports and the shim's are removed again, leaving the
// adapter's exports exactly. The SDK's manifest section survives the merge; the Space Force notice is added as the
// custom section `ussf-sgp4-notice` (copyright notice, Agreement and checksum of the library), as its Agreement
// asks of a redistribution in binary form.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { appendWasmCustomSection } from "space-data-module-sdk/bundle";

import { generateSdsHeaders, schemaFamilies } from "./generate-sds-headers.mjs";
import { composeErfaTranslationUnit } from "../../foundation/frames/erfa-amalgamation.mjs";
import { exportNames, filterExports } from "./wasm-sections.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL(".", import.meta.url));
const frames = path.resolve(root, "../../foundation/frames/src");
const ussfDir = path.join(root, "third_party/ussf-sgp4");
const distRoot = path.join(root, "dist");
const outputPath = path.join(distRoot, "isomorphic/module.wasm");

// The library this module is built around. Its exports have minified names that src/ussf.hpp lists; a different
// build has different names, so the build refuses one.
const USSF_SHA256 = "9f061110f12ac85a76ad80dc76cdb8a33ddad64e54d8dab3b6778602e16cbeb7";
const USSF_EXPORTS = { memory: "j", start: "k", malloc: "s", free: "q", tleAdd: "t", sgp4Init: "u", sgp4Remove: "v", propagate: "A", tleRemove: "E", logLevel: "F" };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (file) => fs.readFile(file, "utf8");

const manifest = JSON.parse(await text(path.join(root, "plugin-manifest.json")));
const sdkVersion = JSON.parse(await text(path.join(root, "node_modules/space-data-module-sdk/package.json"))).version;
const ussf = await fs.readFile(path.join(ussfDir, "Sgp4Prop.xp.wasm"));
if (sha256(ussf) !== USSF_SHA256) {
  throw new Error(`third_party/ussf-sgp4/Sgp4Prop.xp.wasm is ${sha256(ussf)}, not the build this module is written for (${USSF_SHA256}).`);
}
const ussfExported = new Set(exportNames(ussf).map((e) => e.name));
for (const [what, name] of Object.entries(USSF_EXPORTS)) {
  if (!ussfExported.has(name)) throw new Error(`The Space Force build exports no "${name}" (${what}).`);
}

async function tool(command, args = ["--version"]) {
  const { stdout, stderr } = await run(command, args);
  return `${stdout}${stderr}`.trim().split("\n")[0];
}
const toolchain = { wasmMerge: await tool("wasm-merge"), wat2wasm: await tool("wat2wasm") };

// SDS headers from the published package this directory installed, and the manifest checked against the same pin.
const standardsRoot = path.join(root, "node_modules", "spacedatastandards.org");
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;
const sds = await generateSdsHeaders();
const sdsSource = schemaFamilies()
  .map((family) => sds.headers[family].replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, ""))
  .join("\n");

// One translation unit, in dependency order (the SDK compiles one): the invoke API, the propagator ABI, the SDS
// records, ERFA, foundation/frames' axis engine, this module's headers and its source.
const abiHeader = await text(require.resolve("space-data-module-sdk/include/orbpro/orbpro_propagator_abi.h"));
const erfa = await composeErfaTranslationUnit();
const bodyModels = await text(path.join(frames, "iau_body_models.hpp"));
const axisEngine = (await text(path.join(frames, "axis_engine.hpp")))
  .replace('#include "iau_body_models.hpp"', "")
  .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, "// ERFA declarations are amalgamated ahead of this header.\n");
if (axisEngine.includes('#include "erfa.h"')) throw new Error("foundation/frames/axis_engine.hpp includes ERFA in a form this build does not strip.");

const local = async (name) =>
  (await text(path.join(root, "src", name))).replace(/^#pragma once\n/m, "").replace(/^#include "(ussf|frames|fit|sds)\.hpp"\n/gm, "");
const sourceCode = [
  '#include "space_data_module_invoke.h"',
  `// --- BEGIN INLINED orbpro_propagator_abi.h (space-data-module-sdk ${sdkVersion}) ---`,
  abiHeader,
  "// --- END INLINED orbpro_propagator_abi.h ---",
  ...(process.env.SGP4_XP_TRACE ? ["#define SGP4XP_TRACE 1"] : []),
  "#define FLATBUFFERS_NAN_DEFAULTS",
  sdsSource,
  erfa.source,
  bodyModels,
  axisEngine,
  await local("ussf.hpp"),
  await local("frames.hpp"),
  await local("fit.hpp"),
  await local("sds.hpp"),
  await local("module.cpp"),
].join("\n\n");

const work = await fs.mkdtemp(path.join(os.tmpdir(), "sgp4-xp-build-"));
try {
  // 1. The adapter.
  const adapterPath = path.join(work, "adapter.wasm");
  const compilation = await compileModuleFromSource({
    manifest,
    sourceCode,
    language: "c++",
    outputPath: adapterPath,
    // Passed on purpose: the compiler reads the option, not manifest.threadModel, and otherwise infers the model
    // from runtimeTargets.
    threadModel: manifest.threadModel,
    // The imports of the modules "ussf" and "a" are resolved by the merge below.
    allowUndefinedImports: true,
  });
  if (compilation.threadModel !== manifest.threadModel) {
    throw new Error(`threadModel drift: the manifest declares ${manifest.threadModel} and the compiler used ${compilation.threadModel}.`);
  }
  if (!compilation.report?.ok) throw new Error(`The adapter failed SDK validation:\n${JSON.stringify(compilation.report?.issues, null, 2)}`);
  const adapter = new Uint8Array(await fs.readFile(adapterPath));

  // 2. The shim.
  const shimPath = path.join(work, "shim.wasm");
  await run("wat2wasm", ["--enable-multi-memory", "--enable-threads", path.join(root, "src/shim.wat"), "-o", shimPath]);

  // 3. The merge.
  const ussfPath = path.join(work, "ussf.wasm");
  await fs.writeFile(ussfPath, ussf);
  const mergedPath = path.join(work, "merged.wasm");
  await run("wasm-merge", ["-all", adapterPath, "adapter", ussfPath, "ussf", shimPath, "a", "-o", mergedPath]);

  // 4. Only the adapter's exports; the Space Force notice.
  const keep = new Set(exportNames(adapter).map((e) => e.name));
  let merged = filterExports(new Uint8Array(await fs.readFile(mergedPath)), keep);
  const agreement = await text(path.join(ussfDir, "AGREEMENT.txt"));
  const notice = [
    "Copyright 2015 United States Government as represented by the Administrator of US Space Force. All Rights Reserved.",
    "",
    "This module contains the US Space Force SGP4 (Sgp4Prop WebAssembly v9.1.1.0, XP build), unchanged, joined to SDN code",
    `by wasm-merge. Library SHA-256 ${USSF_SHA256}. The US Space Force does not endorse this module or anything derived from it.`,
    "Export of any goods or technical data from the United States may require an export license from the U.S. Government.",
    "The Agreement it is distributed under follows.",
    "",
    agreement,
  ].join("\n");
  merged = appendWasmCustomSection(merged, "ussf-sgp4-notice", new TextEncoder().encode(notice));

  if (!WebAssembly.validate(merged)) throw new Error("The merged module is not valid WebAssembly.");
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(merged));
  const foreign = imports.filter((i) => i.module !== "wasi_snapshot_preview1");
  if (foreign.length) throw new Error(`The merged module imports ${foreign.map((i) => `${i.module}.${i.name}`).join(", ")}; only WASI may remain.`);

  await fs.rm(distRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, merged);
  const report = await validateArtifactWithStandards({ manifest, wasmPath: outputPath });
  if (!report.ok) throw new Error(`The merged artifact failed SDK validation:\n${JSON.stringify(report.issues, null, 2)}`);

  await fs.copyFile(path.join(root, "plugin-manifest.json"), path.join(distRoot, "plugin-manifest.json"));
  await fs.writeFile(
    path.join(distRoot, "build-provenance.json"),
    `${JSON.stringify(
      {
        spacedatastandards: sds.version,
        spaceDataModuleSdk: sdkVersion,
        threadModel: manifest.threadModel,
        compiler: compilation.compiler,
        erfaSourceFiles: erfa.fileCount,
        foundationFrames: "foundation/frames/src/axis_engine.hpp",
        library: { file: "third_party/ussf-sgp4/Sgp4Prop.xp.wasm", sha256: USSF_SHA256, version: "Astro Standards v9.1, Sgp4Prop WebAssembly 9.1.1.0 (XP)" },
        adapterSha256: sha256(adapter),
        shimSha256: sha256(await fs.readFile(path.join(root, "src/shim.wat"))),
        join: toolchain,
        moduleSha256: sha256(merged),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Built ${path.relative(root, outputPath)} (${merged.length} bytes; adapter ${adapter.length}, library ${ussf.length})`);
} finally {
  if (!process.env.SGP4_XP_KEEP_WORK) await fs.rm(work, { recursive: true, force: true });
  else console.log(`work kept at ${work}`);
}
