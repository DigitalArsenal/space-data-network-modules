// Stages the SDK 0.9.3 C++ headers the module compiles against (the same set compileModuleFromSource stages):
// the FlatBuffers runtime, the SDS invoke schema headers (sds/PIV, sds/TAB), the typed runtime
// (typedHostcall.hpp, HostOps_aligned.h, IngestRequest/IngestResult/TimerTick/ModuleConfig_generated.h),
// space_data_module_invoke.h, and the repo's common/sds_cid.hpp. Usage: node scripts/stage-headers.mjs <dir>
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFlatbuffersCppRuntimeHeaders, getInvokeCppSchemaHeaders } from "space-data-module-sdk/compiler";

const out = path.resolve(process.argv[2]);
const here = fileURLToPath(new URL("..", import.meta.url));
const sdk = path.dirname(fileURLToPath(import.meta.resolve("space-data-module-sdk/compiler")));  // <sdk>/src/compiler
const { generateInvokeSupportHeader } = await import(path.join(sdk, "invokeGlue.js"));
const files = { ...(await getFlatbuffersCppRuntimeHeaders()), ...(await getInvokeCppSchemaHeaders()) };
const runtimeDir = path.join(sdk, "..", "generated", "runtime", "cpp");
for (const name of await fs.readdir(runtimeDir)) if (name.endsWith(".h")) files[name] = await fs.readFile(path.join(runtimeDir, name), "utf8");
files["typedHostcall.hpp"] = await fs.readFile(path.join(sdk, "..", "host", "cpp", "typedHostcall.hpp"), "utf8");
files["space_data_module_invoke.h"] = generateInvokeSupportHeader();
files["sds_cid.hpp"] = await fs.readFile(path.join(here, "..", "..", "common", "sds_cid.hpp"), "utf8");
await fs.rm(out, { recursive: true, force: true });
for (const [rel, text] of Object.entries(files)) {
  await fs.mkdir(path.dirname(path.join(out, rel)), { recursive: true });
  await fs.writeFile(path.join(out, rel), text);
}
console.log(`staged ${Object.keys(files).length} headers -> ${out}`);
