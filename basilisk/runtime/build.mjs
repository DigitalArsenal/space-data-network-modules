import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signModuleArtifact, verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { cleanupCompilation, compileModuleFromSource } from "space-data-module-sdk/compiler";
import { loadModuleSigningKeypair, signModuleArtifactWithConfiguredKey } from "../../scripts/lib/module-signing-key.mjs";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "module.cpp");
const outputPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");

// Signed with the key SDM_MODULE_SIGNING_KEYPAIR_PATH names, and only that key
// (scripts/lib/module-signing-key.mjs). There is no default: the SDK's dev
// fixture (sdm-dev-test-2026) has a public seed and is refused (SEC-005). The
// build refuses before compiling when no key is configured.
loadModuleSigningKeypair(process.env);

const standardsRoot =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../spacedatastandards.org/", import.meta.url));
process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;

// run_pointing_power_scenario carries the SDS standard PPS ($PPS). Its generated C++ header and those of the
// standards it includes (schema/<CODE>/main.fbs `include` lines, depth first: ACM, BUS, OEM and theirs) are inlined
// in place of `#include "PPS_generated.h"`. flatc gives each the same include guard and a self-named
// `#include "main_generated.h"` per dependency, so both are stripped, and the flatc version static_assert relaxed,
// as hostcap/clock does.
async function includeOrder(codes) {
  const order = [];
  const seen = new Set();
  async function visit(code) {
    if (seen.has(code)) return;
    seen.add(code);
    const schema = await fs.readFile(path.join(standardsRoot, "schema", code, "main.fbs"), "utf8");
    for (const match of schema.matchAll(/^include "\.\.\/([A-Z0-9]+)\/main\.fbs";/gm)) await visit(match[1]);
    order.push(code);
  }
  for (const code of codes) await visit(code);
  return order;
}
const inlineHeader = (source) =>
  source
    .replace(/#ifndef FLATBUFFERS_GENERATED_MAIN_H_\s*\n#define FLATBUFFERS_GENERATED_MAIN_H_\s*\n/, "")
    .replace(/#include "main_generated\.h"\s*\n/g, "")
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, "")
    .replace(/#endif\s*\/\/ FLATBUFFERS_GENERATED_MAIN_H_\s*$/, "");
const standards = await includeOrder(["PPS"]);
const sdsHeaders = (
  await Promise.all(standards.map((code) => generateSdsHeader(code, import.meta.url)))
).map(inlineHeader);

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = (await fs.readFile(sourcePath, "utf8")).replace(/^#include "PPS_generated\.h".*$/m, () => sdsHeaders.join("\n\n"));

// No outputPath: the SDK compiles into its own temp dir, so a refused build
// never leaves a partial artifact in dist/.
const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c++",
  // THREAD MODEL, declared (scripts/lib/thread-model.mjs). The guest is a
  // single-shot pure transform that never spawns a thread, and the artifact it
  // replaces (c4d392e1, 2026-06-12) was this lane: unshared memory, no
  // wasi.thread-spawn import. Left to inference, runtimeTargets [wasmedge]
  // selects the wasi-threads model, whose artifact guard refuses such a guest.
  threadModel: "single-thread",
});

try {
  if (!compilation.report?.ok) {
    throw new Error(
      `Compiled artifact failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`,
    );
  }
  const signed = await signModuleArtifactWithConfiguredKey(
    { signModuleArtifact, verifyModuleArtifact },
    compilation.wasmBytes,
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, signed.wasmBytes);
  console.log(
    `Built ${path.relative(packageRoot, outputPath)} (${signed.wasmBytes.length} bytes, ` +
      `${compilation.compiler}, signed by ${signed.signature.publicKeyHex.slice(0, 8)})`,
  );
} finally {
  await cleanupCompilation(compilation);
}
