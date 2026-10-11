// Builds dist/isomorphic/module.wasm: the SDN module, compiled by the SDK, joined to the US Space Force Sgp4Prop
// build with binaryen's wasm-merge.
//
//   adapter  src/*.cpp through compileModuleFromSource (threadModel wasi-sequential, the clang wasm32-wasip1-threads
//            toolchain). The Space Force functions are imports of the module "ussf", and the copies between
//            memories are imports of the module "a"; both are answered by the merge, so the compiled adapter alone
//            is not loadable.
//   ussf     third_party/ussf-sgp4/Sgp4Prop.xp.wasm, as released. It imports nine Emscripten functions from the
//            module "a"; it keeps its own linear memory.
//   a        src/shim.wat: the nine imports, in WebAssembly, and the copies.
//
// join-ussf.mjs merges the three: what results imports only WASI and has two memories, the adapter's (memory 0, the
// one the hosts use) and the library's (memory 1). The merge keeps every export of every module; the Space Force
// module's minified exports and the shim's are removed again, leaving the adapter's exports exactly. The SDK's manifest
// section survives the merge; the Space Force notice is added as the custom section `ussf-sgp4-notice` (copyright
// notice, Agreement and checksum of the library), as its Agreement asks of a redistribution in binary form.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { appendWasmCustomSection } from "space-data-module-sdk/bundle";

import { composeEngineSource, localHeader } from "./engine-source.mjs";
import { generateSdsHeaders, schemaFamilies } from "./generate-sds-headers.mjs";
import { joinUssf, USSF_SHA256, ussfNotice } from "./join-ussf.mjs";
import { exportNames } from "./wasm-sections.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL(".", import.meta.url));
const distRoot = path.join(root, "dist");
const outputPath = path.join(distRoot, "isomorphic/module.wasm");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (file) => fs.readFile(file, "utf8");

const manifest = JSON.parse(await text(path.join(root, "plugin-manifest.json")));
const sdkVersion = JSON.parse(await text(path.join(root, "node_modules/space-data-module-sdk/package.json"))).version;

// SDS headers from the published package this directory installed, and the manifest checked against the same pin.
const standardsRoot = path.join(root, "node_modules", "spacedatastandards.org");
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;
const sds = await generateSdsHeaders();
const sdsSource = schemaFamilies()
  .map((family) => sds.headers[family].replace(/^#include "[A-Z0-9_]+_generated\.h"\n/gm, ""))
  .join("\n");

// One translation unit, in dependency order (the SDK compiles one): the invoke API, the propagator ABI, the SDS
// records, the fit engine (ERFA, foundation/frames' axis engine and src/'s engine headers: engine-source.mjs), this
// module's SDS readers and writers and its source. SGP4_XP_DEFINES (`NAME=value;...`) and SGP4_XP_TRACE are experiments.
const abiHeader = await text(require.resolve("space-data-module-sdk/include/orbpro/orbpro_propagator_abi.h"));
const engine = await composeEngineSource({ defines: (process.env.SGP4_XP_DEFINES ?? "").split(";") });
const sourceCode = [
  '#include "space_data_module_invoke.h"',
  `// --- BEGIN INLINED orbpro_propagator_abi.h (space-data-module-sdk ${sdkVersion}) ---`,
  abiHeader,
  "// --- END INLINED orbpro_propagator_abi.h ---",
  ...(process.env.SGP4_XP_TRACE ? ["#define SGP4XP_TRACE 1"] : []),
  "#define FLATBUFFERS_NAN_DEFAULTS",
  sdsSource,
  engine.source,
  await localHeader("sds.hpp"),
  await localHeader("records.hpp"),
  await localHeader("module.cpp"),
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

  // 2. The merge: only the adapter's exports stay; the Space Force notice.
  const keep = new Set(exportNames(adapter).map((e) => e.name));
  const joined = await joinUssf({ adapterPath, workDir: work, keepExports: keep });
  const merged = appendWasmCustomSection(joined.bytes, "ussf-sgp4-notice", new TextEncoder().encode(await ussfNotice()));

  if (!WebAssembly.validate(merged)) throw new Error("The merged module is not valid WebAssembly.");
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(merged));
  const foreign = imports.filter((i) => i.module !== "wasi_snapshot_preview1");
  if (foreign.length) throw new Error(`The merged module imports ${foreign.map((i) => `${i.module}.${i.name}`).join(", ")}; only WASI may remain.`);

  await fs.rm(distRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, merged);
  if (process.env.SGP4_XP_VARIANT_OUT) await fs.copyFile(outputPath, process.env.SGP4_XP_VARIANT_OUT);
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
        erfaSourceFiles: engine.erfaFileCount,
        foundationFrames: "foundation/frames/src/axis_engine.hpp",
        library: { file: "third_party/ussf-sgp4/Sgp4Prop.xp.wasm", sha256: USSF_SHA256, version: "Astro Standards v9.1, Sgp4Prop WebAssembly 9.1.1.0 (XP)" },
        adapterSha256: sha256(adapter),
        shimSha256: joined.shimSha256,
        join: joined.toolchain,
        moduleSha256: sha256(merged),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Built ${path.relative(root, outputPath)} (${merged.length} bytes; adapter ${adapter.length}, library ${joined.ussf.length})`);
} finally {
  if (!process.env.SGP4_XP_KEEP_WORK) await fs.rm(work, { recursive: true, force: true });
  else console.log(`work kept at ${work}`);
}
