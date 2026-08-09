import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "http_request_module.cpp");
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
  // THREAD MODEL — declared explicitly, never inferred.
  //
  // The artifact this repo has been SHIPPING since 018bc91 already carries
  // `threadModel: single-thread` (dist/guest-link/metadata.json), as does every
  // other node in the cellular flow (foundation/http-respond,
  // data-source/cell-tower-source). It was never declared here, so it depended
  // on the SDK's inference — and when that inference moved, this build started
  // claiming the pthreads contract and the SDK's isomorphic-pthreads artifact
  // guard REFUSED it ("does not import wasi thread-spawn ... must not ship").
  // The guard was right: the emitted wasm has no wasi-threads contract and
  // never did. Declaring the truth makes the build reproducible against the
  // artifact on host-01 instead of against whatever the SDK last guessed —
  // verified by rebuilding the UNMODIFIED source and reproducing the shipped
  // sha 574ad19601b2cd7954d34d60a7551a2b22e69f65f63279d935da1e7943aa6316.
  //
  // Justified: this node's single method is one blocking hostcall per input
  // frame. It spawns nothing, shares nothing, and holds only the frame it is
  // fetching, so it carries no pthreads contract. Same single-thread
  // STANDALONE_WASM lane (clang wasi, growable linear memory, NEVER
  // `emcc -pthread`) the rest of this producer uses.
  threadModel: "single-thread",
  // The module imports the sync space_data_module_host hostcall bridge; those
  // symbols resolve at instantiation (SDK harness bridge / Go node bridge).
  allowUndefinedImports: true,
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
