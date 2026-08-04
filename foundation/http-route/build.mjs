import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "http_route_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
// SDK-owned HTTP envelope ABI headers (schemas/HttpRequestAbi.fbs -> $HTQ);
// generated flatbuffers-25.x-compatible and inline-able next to SDS headers.
const sdkHttpCppRoot = fileURLToPath(
  new URL("../../node_modules/space-data-module-sdk/src/generated/http/cpp/", import.meta.url),
);

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// Per-schema bulk-route parsing (src/bulk_route.h). The compiler takes ONE
// translation unit, so this is prepended exactly like the SDK ABI header above.
// It is a separate file so the routing rule can be compiled and tested natively
// (tests/bulk_route.test.mjs) without the wasm toolchain.
const bulkRoutePath = path.join(packageRoot, "src", "bulk_route.h");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const [httpRequestHeader, bulkRouteHeader, implementationSource] = await Promise.all([
  fs.readFile(path.join(sdkHttpCppRoot, "HttpRequestAbi_generated.h"), "utf8"),
  fs.readFile(bulkRoutePath, "utf8"),
  fs.readFile(sourcePath, "utf8"),
]);
const sourceCode = [httpRequestHeader, bulkRouteHeader, implementationSource].join("\n\n");

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
