#!/usr/bin/env node
// Sign the compiled data-retrieval flow bundle per the module publication
// standard (space-data-module-sdk docs/module-publication-standard.md):
//
//   wasm payload || $REC trailer carrying MBL (bundle metadata incl. the
//   embedded manifest + ed25519 sds.signature entry) + PNM (publication
//   notice, secp256k1 HD-wallet signer). No ENC — this artifact class is a
//   public, signed-only flow module; transport protection (ENC) is applied
//   by the module-delivery catalog when the provider stores it.
//
// Identity: SDN_MODULE_SIGNING_WALLET_ENV must point at a wallet env file
// exporting SDN_TRACKED_DEV_ADMIN_MNEMONIC (never committed, never logged).
// The PNM publication notice is signed by the wallet's secp256k1 signing key
// (m/44'/0'/0'/0/0) and the MBL signature entry by the ed25519 key seeded
// from the same derived signing key — the publisher's canonical identity.
//
// Usage: node scripts/publish-sign.mjs   (from flows/data-retrieval)
// Writes: dist/isomorphic/module.wasm + dist/runtime.wasm (signed, identical)
// Prints: hashes + public keys only. Fails closed if verification fails.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  protectModuleArtifact,
} from "space-data-module-sdk/compiler";
import {
  signModuleArtifact,
  verifyModuleArtifact,
} from "space-data-module-sdk/bundle";
import { getWasmWallet } from "space-data-module-sdk/utils/wasm-crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const distDir = path.join(pkgRoot, "dist");

const walletEnvPath = process.env.SDN_MODULE_SIGNING_WALLET_ENV;
if (!walletEnvPath) {
  console.error("SDN_MODULE_SIGNING_WALLET_ENV must point at the wallet env file");
  process.exit(1);
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=("?)(.*)\2\s*$/);
    if (m) out[m[1]] = m[3];
  }
  return out;
}

const env = parseEnvFile(await readFile(walletEnvPath, "utf8"));
const mnemonic = env.SDN_TRACKED_DEV_ADMIN_MNEMONIC;
if (!mnemonic) {
  console.error("wallet env file has no SDN_TRACKED_DEV_ADMIN_MNEMONIC");
  process.exit(1);
}

const manifest = JSON.parse(
  await readFile(path.join(distDir, "plugin-manifest.json"), "utf8"),
);
const rawWasm = new Uint8Array(
  await readFile(path.join(distDir, "isomorphic", "module.wasm")),
);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
console.log(`input wasm: ${rawWasm.length} bytes sha256=${sha256(rawWasm)}`);

// 1. $REC trailer with MBL (single-file bundle) + PNM (publication notice).
const protection = await protectModuleArtifact({
  manifest,
  wasmBytes: rawWasm,
  artifactId: `${manifest.pluginId}@${manifest.version}`,
  mnemonic,
  singleFileBundle: true,
});
if (protection.encrypted) {
  console.error("unexpected ENC on a signed-only artifact");
  process.exit(1);
}

// 2. ed25519 module signature (MBL sds.signature entry), seeded from the
// wallet's canonical signing key. PNM/MBL records in the trailer are
// preserved by signModuleArtifact.
const wallet = await getWasmWallet();
const seed = wallet.mnemonic.toSeed(mnemonic);
const root = wallet.hdkey.fromSeed(seed);
const signingKey = wallet.getSigningKey(root, 0, 0, 0);
const privateKeySeedHex = Buffer.from(signingKey.privateKey).toString("hex");

const signed = await signModuleArtifact(protection.bundledWasmBytes, {
  privateKeySeedHex,
  keyId: `sdn-admin ${signingKey.path}`,
});

// 3. Verify before writing anything.
const verification = await verifyModuleArtifact(signed.wasmBytes, {
  trustedPublicKeys: signed.signature.publicKeyHex,
  requireSignature: true,
});
if (!verification.verified) {
  console.error("post-sign verification failed", verification);
  process.exit(1);
}

await writeFile(path.join(distDir, "isomorphic", "module.wasm"), signed.wasmBytes);
await writeFile(path.join(distDir, "runtime.wasm"), signed.wasmBytes);

console.log(`signed artifact: ${signed.wasmBytes.length} bytes sha256=${sha256(signed.wasmBytes)}`);
console.log(`canonicalModuleHash=${signed.canonicalModuleHashHex}`);
console.log(`pnm signer (secp256k1) publicKeyHex=${protection.signingPublicKeyHex} path=${protection.signingPath}`);
console.log(`mbl signer (ed25519) publicKeyHex=${signed.signature.publicKeyHex} keyId=${signed.signature.keyId}`);
console.log("verified=true");
