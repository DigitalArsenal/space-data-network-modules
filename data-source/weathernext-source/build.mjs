import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "weathernext_source_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// No SDS header is inlined: this node carries no record. Its frames are the
// flow's own control JSON (http request descriptors, per-chunk parse jobs,
// status frames); the parser sibling builds the $WXF/$TCT records.
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = await fs.readFile(sourcePath, "utf8");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared explicitly, never inferred. One control frame in,
  // a handful of synchronous hostcalls (plugin.getConfig, secrets.get) in a
  // fixed order, request/job frames out; no shared state, provably no thread.
  // Same single-thread STANDALONE_WASM lane as celestrak-request and
  // cell-tower-credentials.
  threadModel: "single-thread",
  // Imports the sync space_data_module_host hostcall bridge for the builtin
  // plugin.getConfig and the secrets.get capability op; symbols resolve at
  // instantiation.
  allowUndefinedImports: true,
});

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

console.log(`weathernext-source compiled -> ${outputPath}`);
