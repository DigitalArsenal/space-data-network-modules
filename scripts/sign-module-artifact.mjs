#!/usr/bin/env node
// sign-module-artifact.mjs <artifact.wasm>
//
// Signs a module artifact in place with the key SDM_MODULE_SIGNING_KEYPAIR_PATH
// names, verifies the result against that key, then writes it. There is no
// default key: with the variable unset, or set to a revoked signer (the SDK's
// public dev fixture, sdm-dev-test-2026), this refuses and writes nothing.
// See scripts/lib/module-signing-key.mjs.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadModuleSigningKeypair, signModuleArtifactWithConfiguredKey } from "./lib/module-signing-key.mjs";

const artifactPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : null;

if (!artifactPath) {
  throw new Error("Usage: sign-module-artifact.mjs <dist/isomorphic/module.wasm>");
}

// Refuse before loading anything else, so a missing key is the error reported.
loadModuleSigningKeypair(process.env);

const packageDir = path.resolve(path.dirname(artifactPath), "../..");
const packageRequire = createRequire(path.join(packageDir, "package.json"));
const bundle = await import(
  pathToFileURL(packageRequire.resolve("space-data-module-sdk/bundle")).href
);

const wasmBytes = await readFile(artifactPath);
const signed = await signModuleArtifactWithConfiguredKey(bundle, wasmBytes);
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
