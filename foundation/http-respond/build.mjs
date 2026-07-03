import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "http_respond_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
// SDK-owned HTTP envelope ABI headers ($HTQ request declares the shared
// HttpHeader table; $HTR response includes it). Both are generated
// flatbuffers-25.x-compatible and inline-able next to SDS headers.
const sdkHttpCppRoot = fileURLToPath(
  new URL("../../node_modules/space-data-module-sdk/src/generated/http/cpp/", import.meta.url),
);

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const [httpRequestHeader, httpResponseHeader, implementationSource] = await Promise.all([
  fs.readFile(path.join(sdkHttpCppRoot, "HttpRequestAbi_generated.h"), "utf8"),
  fs.readFile(path.join(sdkHttpCppRoot, "HttpResponseAbi_generated.h"), "utf8"),
  fs.readFile(sourcePath, "utf8"),
]);
// The response header pulls in the request header (shared HttpHeader table)
// by file name; both are inlined here, so drop the nested include. The two
// include guards are distinct and stay.
const sourceCode = [
  httpRequestHeader,
  httpResponseHeader.replace(/#include "HttpRequestAbi_generated\.h"\s*\n/g, ""),
  implementationSource,
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
