import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signModuleArtifact, verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { cleanupCompilation, compileModuleFromSource } from "space-data-module-sdk/compiler";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const sourcePath = path.join(packageRoot, "src", "module.c");
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

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const sourceCode = await fs.readFile(sourcePath, "utf8");

// No outputPath: the SDK compiles into its own temp dir, so a refused build
// never leaves a partial artifact in dist/.
const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "c",
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
