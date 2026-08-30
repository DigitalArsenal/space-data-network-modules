import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "frames_module.cpp");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT
  ? path.resolve(process.env.SPACE_DATA_STANDARDS_ROOT) + path.sep
  : fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const [frmHeader, implementationSource] = await Promise.all([
  fs.readFile(path.join(standardsRoot, "lib", "cpp", "FRM", "main_generated.h"), "utf8"),
  fs.readFile(sourcePath, "utf8"),
]);
const sourceCode = [frmHeader, implementationSource].join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  outputPath,
  // THREAD MODEL — declared, never inferred (scripts/lib/thread-model.mjs
  // holds the full rationale; graph task modules-undeclared-threadmodel-artifacts).
  //
  // Truth of the SHIPPED artifact a014091d1837… (107138 B, landed 2026-06-17 at
  // SDK pin b06faf5c): unshared linear memory, no `wasi.thread-spawn` import, no
  // `wasi_thread_start` export. It carries no wasi-threads contract and never did.
  // Those bytes were produced by INFERENCE: at that era pin the resolver matched
  // `browser` FIRST and returned single-thread. Today `wasmedge` wins and returns
  // emscripten-pthreads, so this build stopped producing bytes at all — the SDK's
  // artifact guard correctly refuses a guest with no thread-spawn import. Declaring
  // the truth makes the lane a property of THIS SOURCE instead of the SDK version.
  threadModel: "single-thread",
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(`Built ${path.relative(packageRoot, outputPath)}`);
