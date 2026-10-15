// The module-signing key a build signs with, and the refusals around it.
//
// There is exactly ONE source for the key: the file SDM_MODULE_SIGNING_KEYPAIR_PATH
// names ({ keyId, publicKeyHex, privateKeySeedHex }). There is no default and no
// candidate search. The builds used to fall back, silently, to the SDK's test
// fixture (space-data-module-sdk/test/support/dev-module-signing-keypair.json,
// keyId sdm-dev-test-2026). That seed is published in a public repository, so
// anything it signs can be forged by anyone (security audit SEC-005). A build
// that forgets the variable now stops instead of shipping a dev-signed artifact.
//
// The revoked signers below are refused even when named explicitly: the public
// key is DERIVED from the seed and checked, so renaming the keyId or editing
// publicKeyHex in the file does not get the dev key past this.
//
// Builds that must sign but publish nothing (CI, tests) generate a throwaway key
// (writeEphemeralModuleSigningKeypair) and point the variable at it.
//
// Nothing here ever prints or returns the seed in an error message.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MODULE_SIGNING_KEYPAIR_ENV = "SDM_MODULE_SIGNING_KEYPAIR_PATH";

// The owner's release module-signing key (owner 2026-10-14, keyId
// module-owner-2026-10-15). Committed artifacts may carry this signer.
export const OWNER_MODULE_SIGNER_PUBLIC_KEY_HEX =
  "c04e832f741859a36d6f50909668cfad836700da3dfd23cb737f4ef033265c34";

// Signers whose private key is public. A build refuses to sign with them.
export const REVOKED_MODULE_SIGNERS = Object.freeze({
  "cf4625795484d8efe18860141cfdeaaaed7bbee9209488405b6ddeac7543fe78":
    "sdm-dev-test-2026, the space-data-module-sdk test fixture whose private seed is committed to a public repository",
  "0b56dbd9b3b6c8698550753b1867765831b3000454369ad23b690aa21a613c5c":
    "the leaked SDN dev-admin wallet's Ed25519 signing key (its mnemonic is in public space-data-network history, security audit SEC-007)",
});
// Compared trimmed and case-folded.
export const REVOKED_MODULE_SIGNER_KEY_IDS = Object.freeze(["sdm-dev-test-2026"]);

// Publisher (PNM, secp256k1 HD-wallet) identities whose mnemonic is public. The
// SDN dev-admin wallet's 24 words were committed to the public
// space-data-network repository (config/dev-wallet.env, removed from HEAD in
// f0338079b but still in history: security audit SEC-007). Both values below are
// PUBLIC: the account xpub at m/44'/0'/0' was committed beside the mnemonic, and
// the signing key at m/44'/0'/0'/0/0 is derived from that xpub alone. A
// publisher mnemonic is refused when it derives either one.
export const REVOKED_PUBLISHER_IDENTITIES = Object.freeze([
  Object.freeze({
    accountXpub:
      "xpub6DHm9a1bDz4qPHGMQqQ386E76KFhxsx4ZmVjm1K9HfiCVh2jNc77AgFtWtEScGRKNqArC7gEjRW8iPFJSgroCAB8tdZpkoXQj2hkZgRiENw",
    signingPublicKeyHex: "0239ac5ff81fd6a1d58ab0558bfe63349eaf8533231298b70ea49eb16e1b31a1fe",
    reason: "the leaked SDN dev-admin wallet (SDN_TRACKED_DEV_ADMIN_MNEMONIC, security audit SEC-007)",
  }),
]);
export const PUBLISHER_ACCOUNT_PATH = "m/44'/0'/0'";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const HEX_32 = /^[0-9a-fA-F]{64}$/;

export class ModuleSigningKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModuleSigningKeyError";
    this.code = code;
  }
}

export function ed25519PublicKeyHexFromSeed(seedHex) {
  if (!HEX_32.test(String(seedHex ?? ""))) {
    throw new ModuleSigningKeyError(
      "invalid_seed",
      "the module-signing keypair's privateKeySeedHex must be a 32-byte Ed25519 seed in hex",
    );
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seedHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

export function assertModuleSignerNotRevoked(publicKeyHex, keyId = null) {
  const key = String(publicKeyHex ?? "").trim().toLowerCase();
  if (Object.hasOwn(REVOKED_MODULE_SIGNERS, key)) {
    throw new ModuleSigningKeyError(
      "revoked_signer",
      `refusing to sign with revoked module signer ${key} (${REVOKED_MODULE_SIGNERS[key]})`,
    );
  }
  if (keyId != null && REVOKED_MODULE_SIGNER_KEY_IDS.includes(String(keyId).trim().toLowerCase())) {
    throw new ModuleSigningKeyError(
      "revoked_signer",
      `refusing to sign with revoked module signer keyId ${String(keyId).trim()}`,
    );
  }
}

// Reads and checks the keypair. Throws, without echoing the seed, when the
// variable is unset, the file is missing or malformed, the declared public key
// is not the seed's, or the signer is revoked.
export function loadModuleSigningKeypair(environment = process.env) {
  const configured = String(environment?.[MODULE_SIGNING_KEYPAIR_ENV] ?? "").trim();
  if (!configured) {
    throw new ModuleSigningKeyError(
      "signing_key_not_configured",
      `refusing to sign: ${MODULE_SIGNING_KEYPAIR_ENV} is not set. There is no default module-signing key. ` +
        "Point it at the release keypair, or, for a build that publishes nothing, at a throwaway key " +
        "(writeEphemeralModuleSigningKeypair in scripts/lib/module-signing-key.mjs).",
    );
  }
  const keypairPath = path.resolve(configured);
  let text;
  try {
    text = fs.readFileSync(keypairPath, "utf8");
  } catch (error) {
    throw new ModuleSigningKeyError(
      "signing_key_unreadable",
      `refusing to sign: cannot read the module-signing keypair at ${keypairPath} (${error.code ?? "read failed"})`,
    );
  }
  let keypair;
  try {
    keypair = JSON.parse(text);
  } catch {
    throw new ModuleSigningKeyError(
      "signing_key_malformed",
      `refusing to sign: ${keypairPath} is not a JSON module-signing keypair`,
    );
  }
  if (keypair === null || typeof keypair !== "object" || Array.isArray(keypair)) {
    throw new ModuleSigningKeyError(
      "signing_key_malformed",
      `refusing to sign: ${keypairPath} is not a JSON module-signing keypair`,
    );
  }
  const keyId = keypair.keyId == null ? null : String(keypair.keyId);
  const declaredPublicKeyHex = String(keypair.publicKeyHex ?? "").trim().toLowerCase();
  // Checked before the seed is even parsed, so a file that only CLAIMS the
  // revoked identity is refused for that reason.
  assertModuleSignerNotRevoked(declaredPublicKeyHex, keyId);
  const publicKeyHex = ed25519PublicKeyHexFromSeed(keypair.privateKeySeedHex);
  assertModuleSignerNotRevoked(publicKeyHex, keyId);
  if (!declaredPublicKeyHex) {
    throw new ModuleSigningKeyError(
      "signing_key_malformed",
      `refusing to sign: ${keypairPath} has no publicKeyHex`,
    );
  }
  if (declaredPublicKeyHex !== publicKeyHex) {
    throw new ModuleSigningKeyError(
      "signing_key_mismatch",
      `refusing to sign: ${keypairPath} declares public key ${declaredPublicKeyHex} but its seed is the key ${publicKeyHex}`,
    );
  }
  return Object.freeze({
    keypairPath,
    keyId,
    publicKeyHex,
    privateKeySeedHex: String(keypair.privateKeySeedHex).toLowerCase(),
  });
}

// Signs with the configured key and verifies what it is about to hand back:
// the signer in the artifact must be the configured key, and the artifact must
// verify against that key alone.
export async function signModuleArtifactWithConfiguredKey(bundle, wasmBytes, options = {}) {
  const { environment = process.env, signatureScope } = options;
  const keypair = loadModuleSigningKeypair(environment);
  const signed = await bundle.signModuleArtifact(wasmBytes, {
    privateKeySeedHex: keypair.privateKeySeedHex,
    keyId: keypair.keyId,
    ...(signatureScope ? { signatureScope } : {}),
  });
  const signer = String(signed?.signature?.publicKeyHex ?? "").toLowerCase();
  if (signer !== keypair.publicKeyHex) {
    throw new ModuleSigningKeyError(
      "signer_mismatch",
      `the signed artifact names signer ${signer || "(none)"}, not the configured key ${keypair.publicKeyHex}`,
    );
  }
  const verification = await bundle.verifyModuleArtifact(signed.wasmBytes, {
    trustedPublicKeys: [keypair.publicKeyHex],
    requireSignature: true,
  });
  if (!verification?.verified) {
    throw new ModuleSigningKeyError("verification_failed", "the freshly signed artifact does not verify");
  }
  return { ...signed, keypair: { keyId: keypair.keyId, publicKeyHex: keypair.publicKeyHex } };
}

// A throwaway Ed25519 keypair for builds and tests that sign but publish
// nothing. Created exclusively, mode 0600. Returns the public half only.
export function writeEphemeralModuleSigningKeypair(outputPath, keyId = "ephemeral-build") {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const seedHex = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString("hex");
  const publicKeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({ keyId, publicKeyHex, privateKeySeedHex: seedHex })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return { keyId, publicKeyHex, keypairPath: outputPath };
}

// ---- the secp256k1 publisher identity (PNM) -------------------------------
//
// protectModuleArtifact (space-data-module-sdk <= 0.9.7) signs with a FRESH
// RANDOM mnemonic when the one it is given is missing or fails BIP-39
// validation, and says nothing (security audit SEC-035). A build that means to
// sign as the publisher must therefore check the mnemonic itself, derive the
// identity it expects, and refuse a result signed by anyone else.
// `wallet` is the SDK's getWasmWallet() (space-data-module-sdk/utils/wasm-crypto),
// passed in so this file resolves no SDK of its own.

export async function resolvePublisherIdentity(wallet, mnemonic, label = "the publisher mnemonic") {
  const words = String(mnemonic ?? "").trim().split(/\s+/).filter(Boolean).join(" ");
  if (!words) {
    throw new ModuleSigningKeyError(
      "publisher_mnemonic_not_configured",
      `refusing to sign: ${label} is not set. There is no default publisher identity.`,
    );
  }
  if (!wallet.mnemonic.validate(words)) {
    // The words are never echoed.
    throw new ModuleSigningKeyError(
      "publisher_mnemonic_invalid",
      `refusing to sign: ${label} is not a valid BIP-39 mnemonic`,
    );
  }
  const root = wallet.hdkey.fromSeed(wallet.mnemonic.toSeed(words));
  let accountXpub;
  let signingKey;
  try {
    const account = root.derivePath(PUBLISHER_ACCOUNT_PATH);
    try {
      accountXpub = account.toXpub();
    } finally {
      account.wipe();
    }
    signingKey = wallet.getSigningKey(root, 0, 0, 0);
  } finally {
    root.wipe();
  }
  const identity = {
    mnemonic: words,
    signingKey,
    accountXpub,
    signingPublicKeyHex: Buffer.from(signingKey.publicKey).toString("hex"),
  };
  assertPublisherNotRevoked(identity, label);
  return identity;
}

// Refuses a publisher identity whose mnemonic is public (REVOKED_PUBLISHER_IDENTITIES),
// matched by its account xpub or its PNM signing key. Neither value is secret.
export function assertPublisherNotRevoked(identity, label = "the publisher mnemonic") {
  const xpub = String(identity?.accountXpub ?? "").trim();
  const signer = String(identity?.signingPublicKeyHex ?? "").trim().toLowerCase();
  for (const revoked of REVOKED_PUBLISHER_IDENTITIES) {
    if ((xpub && xpub === revoked.accountXpub) || (signer && signer === revoked.signingPublicKeyHex)) {
      throw new ModuleSigningKeyError(
        "revoked_publisher",
        `refusing to sign: ${label} is a revoked publisher identity (signing key ${revoked.signingPublicKeyHex}, ${revoked.reason})`,
      );
    }
  }
}

export function assertProtectedByPublisher(protection, identity) {
  const signer = String(protection?.signingPublicKeyHex ?? "").toLowerCase();
  assertPublisherNotRevoked({ signingPublicKeyHex: signer });
  if (!signer || signer !== identity.signingPublicKeyHex.toLowerCase()) {
    throw new ModuleSigningKeyError(
      "publisher_mismatch",
      `the protected artifact is signed by ${signer || "(none)"}, not the configured publisher ${identity.signingPublicKeyHex}`,
    );
  }
}
