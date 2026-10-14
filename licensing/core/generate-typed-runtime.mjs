#!/usr/bin/env node
// Stages the SDK's typed module runtime (typed contracts 1.0) for this CMake / Emscripten build, the same files the
// SDK compiler (space-data-module-sdk/compiler) stages for a single-source module:
//  - the invoke glue generated from plugin-manifest.json (generateInvokeSupportSource): the $PIV invoke ABI with the
//    manifest's port types checked on every input and output frame;
//  - typedHostcall.hpp (sdm_piv) with HostOps_aligned.h and ModuleConfig_generated.h: hostcalls as $PIV invocations;
//  - the SDS PIV / TAB headers both of them include.
// This module links Crypto++, da-flatbuffers encryption and the shared EPM sources, which the SDK compiler's one-source
// compile cannot take, so it keeps its CMake build and takes the SDK's runtime from here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = fs.realpathSync(path.join(packageRoot, "node_modules", "space-data-module-sdk"));
const outDir = path.join(packageRoot, "src", "cpp", "generated", "typed");

const { generateInvokeSupportHeader, generateInvokeSupportSource } = await import(
  pathToFileURL(path.join(sdkRoot, "src", "compiler", "invokeGlue.js")).href
);
const { getInvokeCppSchemaHeaders } = await import(
  pathToFileURL(path.join(sdkRoot, "src", "compiler", "flatcSupport.js")).href
);

// The generated headers pin the flatc version they came from; this build compiles against da-flatbuffers' own
// runtime, so the pin is relaxed as the SDK does for its runtime headers.
const relax = (source) => source.replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "");

function write(relative, content) {
  const target = path.join(outDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8"));
fs.rmSync(outDir, { recursive: true, force: true });

write("space_data_module_invoke.h", generateInvokeSupportHeader());
write("plugin_invoke_glue.cpp", generateInvokeSupportSource({ manifest, includeCommandMain: true }));
for (const [relative, content] of Object.entries(await getInvokeCppSchemaHeaders())) {
  write(relative, relax(content));
}
for (const name of ["HostOps_aligned.h", "ModuleConfig_generated.h", "RuntimeCommon_generated.h"]) {
  write(name, relax(fs.readFileSync(path.join(sdkRoot, "src", "generated", "runtime", "cpp", name), "utf8")));
}
write("typedHostcall.hpp", fs.readFileSync(path.join(sdkRoot, "src", "host", "cpp", "typedHostcall.hpp"), "utf8"));

console.log(`staged the SDK typed runtime (${path.basename(sdkRoot)}) into ${path.relative(packageRoot, outDir)}`);
