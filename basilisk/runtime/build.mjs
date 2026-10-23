import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signModuleArtifact, verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { cleanupCompilation, compileModuleFromSource } from "space-data-module-sdk/compiler";
import { generateSdsHeader } from "../../scripts/lib/sds-cpp-headers.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "module.cpp");
const outputPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");

// The shipped artifact is signed with the development module signing key
// (sdm-dev-test-2026), which Sandcastle trusts by default. Rebuilds keep that.
const signingKeypairCandidates = [
  process.env.SDM_MODULE_SIGNING_KEYPAIR_PATH,
  path.resolve(repoRoot, "../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json"),
  path.resolve(repoRoot, "../space-data-module-sdk/test/support/dev-module-signing-keypair.json"),
].filter(Boolean);

async function resolveSigningKeypairPath() {
  for (const candidate of signingKeypairCandidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "Module signing keypair not found. Set SDM_MODULE_SIGNING_KEYPAIR_PATH " +
      `or provide one of: ${signingKeypairCandidates.join(", ")}`,
  );
}

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
  // THREAD MODEL: wasi-sequential, declared, never inferred (scripts/lib/thread-model.mjs). The guest never spawns a
  // thread (manifest sequentialJustification); clang wasm32-wasip1-threads is the repo's one guest object format, so
  // every flow links its modules' guest-link objects together (graph/checks/flow-link-models.mjs).
  threadModel: "wasi-sequential",
});

try {
  if (!compilation.report?.ok) {
    throw new Error(
      `Compiled artifact failed SDK validation:\n${JSON.stringify(compilation.report?.issues ?? [], null, 2)}`,
    );
  }
  const keypair = JSON.parse(await fs.readFile(await resolveSigningKeypairPath(), "utf8"));
  const signed = await signModuleArtifact(compilation.wasmBytes, {
    privateKeySeedHex: keypair.privateKeySeedHex,
    keyId: keypair.keyId ?? null,
  });
  await verifyModuleArtifact(signed.wasmBytes, {
    trustedPublicKeys: [keypair.publicKeyHex],
    requireSignature: true,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, signed.wasmBytes);
  console.log(
    `Built ${path.relative(packageRoot, outputPath)} (${signed.wasmBytes.length} bytes, ` +
      `${compilation.compiler}, signed by ${signed.signature.publicKeyHex.slice(0, 8)})`,
  );
} finally {
  await cleanupCompilation(compilation);
}
