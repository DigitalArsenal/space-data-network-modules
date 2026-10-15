import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "http_route_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// SDK-owned HTTP envelope ABI header (schemas/HttpRequestAbi.fbs -> $HTQ), resolved through the SDK package itself.
const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("space-data-module-sdk/compiler"))), "..", "..");
const sdkHttpCppRoot = path.join(sdkRoot, "src", "generated", "http", "cpp");

// The decisions are SDS standards: APR ($APR, API Request) for the non-query routes and QRP ($QRP, Query Page) for the
// query/data routes. The SDK compiler stages only its runtime headers, so each standard's own generated C++ header
// (scripts/lib/sds-cpp-headers.mjs, with the object API) is inlined: its include guard renamed (every SDS header is
// "main_generated.h") and its flatc version static_assert relaxed, as hostcap/clock does.
async function sdsHeader(code) {
  const header = await generateSdsHeader(code, import.meta.url);
  return header
    .replaceAll("FLATBUFFERS_GENERATED_MAIN_H_", `FLATBUFFERS_GENERATED_SDS_${code}_MAIN_H_`)
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "")
    .replace(/#include "main_generated\.h"\n/g, "");
}

// Per-schema bulk-route parsing (src/bulk_route.h): a separate file so the routing rule compiles and tests natively
// (tests/bulk_route.test.mjs) without the wasm toolchain; the compiler takes ONE translation unit, so it is prepended.
const bulkRoutePath = path.join(packageRoot, "src", "bulk_route.h");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = [
  await fs.readFile(path.join(sdkHttpCppRoot, "HttpRequestAbi_generated.h"), "utf8"),
  await sdsHeader("APR"),
  await sdsHeader("QRP"),
  await fs.readFile(bulkRoutePath, "utf8"),
  await fs.readFile(sourcePath, "utf8"),
].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

// THREAD MODEL IS DECLARED, NEVER INFERRED.
//
// Omitting it made the SDK deduce one from `runtimeTargets`, and when that rule
// changed (targeting wasmedge now selects the wasi-threads model) this build
// started claiming a pthreads contract the emitted wasm cannot honour — a pure
// string router spawns nothing, so the link emits no `thread-spawn` import and
// no `wasi_thread_start`, and the isomorphic-pthreads artifact guard correctly
// refused it. Pinning the model states what the SHIPPED guest-link object has
// always been (dist/guest-link/metadata.json: "single-thread"), so a future SDK
// inference change cannot silently reshape a deployed artifact.
//
// Migrating this family off legacy Emscripten onto clang wasi-sequential is
// tracked separately (graph: mod-foundation-family-wasi-sequential): every node
// in a flow must move in the same wave or the link fails
// `mixed-guest-thread-models`.
const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  threadModel: "single-thread",
});

// Persist the prefixed guest-link object + metadata for the flow compiler
// (space-data-module flow compile links these into monolithic linked-direct
// flow artifacts; see SDK src/flow/flowCompiler.js).
const guestLinkDir = path.join(distRoot, "guest-link");
await fs.mkdir(guestLinkDir, { recursive: true });
await fs.writeFile(path.join(guestLinkDir, "module-link.o"), compilation.guestLink.objectBytes);
await fs.writeFile(
  path.join(guestLinkDir, "metadata.json"),
  `${JSON.stringify(
    {
      version: 1,
      format: compilation.guestLink.format,
      language: compilation.guestLink.language,
      threadModel: compilation.guestLink.threadModel,
      symbolPrefix: compilation.guestLink.symbolPrefix,
      methodSymbols: compilation.guestLink.methodSymbols,
    },
    null,
    2,
  )}\n`,
);

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
