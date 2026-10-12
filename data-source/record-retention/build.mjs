import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "record_retention_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = await fs.readFile(sourcePath, "utf8");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred (scripts/lib/thread-model.mjs): the
  // module spawns nothing; it reads and deletes through the sync hostcall bridge.
  threadModel: "single-thread",
  // The sync space_data_module_host hostcall bridge resolves at instantiation
  // (SDK harness bridge / Go node bridge).
  allowUndefinedImports: true,
});

// The prefixed guest-link object + metadata for the flow compiler
// (space-data-module flow compile links these into linked-direct flow artifacts).
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

// A test build of the same source for the SDK's in-process harness, which is
// the browser leg only (tests/sdk_compat.test.mjs): declared for browser and
// wasmedge with the read capability alone, so the harness loads it and its
// stubbed host answers storage.delete. Never shipped - the artifact the node
// runs is dist/isomorphic/module.wasm above (wasmedge, storage_write).
const testManifest = {
  ...manifest,
  runtimeTargets: ["browser", "wasmedge"],
  capabilities: ["storage_query"],
  buildArtifacts: [{ ...manifest.buildArtifacts[0], path: "dist/test-browser/module.wasm", target: "browser,wasmedge" }],
};
await fs.mkdir(path.join(distRoot, "test-browser"), { recursive: true });
await fs.writeFile(path.join(distRoot, "test-browser", "plugin-manifest.json"), `${JSON.stringify(testManifest, null, 2)}\n`);
const testCompilation = await compileModuleFromSource({
  manifest: testManifest,
  sourceCode,
  language: "c++",
  outputPath: path.join(distRoot, "test-browser", "module.wasm"),
  threadModel: "single-thread",
  allowUndefinedImports: true,
});
if (!testCompilation.report?.ok) {
  throw new Error(`Test build failed SDK validation:\n${JSON.stringify(testCompilation.report?.issues ?? [], null, 2)}`);
}

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
