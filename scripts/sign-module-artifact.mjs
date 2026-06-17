#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const artifactPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : null;

if (!artifactPath) {
  throw new Error("Usage: sign-module-artifact.mjs <dist/isomorphic/module.wasm>");
}

const packageDir = path.resolve(path.dirname(artifactPath), "../..");
const repoRoot = path.resolve(packageDir, "../..");
const packageRequire = createRequire(path.join(packageDir, "package.json"));
const bundle = await import(
  pathToFileURL(packageRequire.resolve("space-data-module-sdk/bundle")).href
);

const moduleSigningKeypairCandidates = [
  process.env.SDM_MODULE_SIGNING_KEYPAIR_PATH,
  path.resolve(
    repoRoot,
    "../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json",
  ),
  path.resolve(
    repoRoot,
    "../../../../ancillary-packages/space-data-module-sdk/test/support/dev-module-signing-keypair.json",
  ),
  path.resolve(
    repoRoot,
    "../space-data-module-sdk/test/support/dev-module-signing-keypair.json",
  ),
].filter(Boolean);

async function fileExists(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function resolveModuleSigningKeypairPath() {
  for (const candidate of moduleSigningKeypairCandidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Module signing keypair not found. Set SDM_MODULE_SIGNING_KEYPAIR_PATH " +
      `or provide one of: ${moduleSigningKeypairCandidates.join(", ")}`,
  );
}

const keypairPath = await resolveModuleSigningKeypairPath();
const keypair = JSON.parse(await readFile(keypairPath, "utf8"));
const wasmBytes = await readFile(artifactPath);
const signed = await bundle.signModuleArtifact(wasmBytes, {
  privateKeySeedHex: keypair.privateKeySeedHex,
  keyId: keypair.keyId ?? null,
});

await bundle.verifyModuleArtifact(signed.wasmBytes, {
  trustedPublicKeys: [keypair.publicKeyHex],
  requireSignature: true,
});
await writeFile(artifactPath, signed.wasmBytes);

console.log(
  JSON.stringify(
    {
      artifactPath,
      keyId: signed.signature.keyId,
      publicKeyHex: signed.signature.publicKeyHex,
      canonicalModuleHashHex: signed.canonicalModuleHashHex,
    },
    null,
    2,
  ),
);
