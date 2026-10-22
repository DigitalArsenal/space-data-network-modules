// Test-side protocol builders adapted from licensing/core/tests/sdk-compat.test.mjs.
// Authority: the real key-server WASM; this file supplies host capabilities and requester messages only.
import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signWithNodeKey,
  verify as verifyWithNodeKey,
} from "node:crypto";
import * as flatbuffers from "flatbuffers";

import { FIL } from "spacedatastandards.org/lib/js/FIL/FIL.js";
import {
  generateX25519Keypair,
} from "space-data-module-sdk";
import {
  decodeLicensingChallengeMessage,
  encodeLicensingProof,
} from "space-data-module-sdk/licensing";
import { ChainProofT } from "spacedatastandards.org/lib/js/EPM/ChainProof.js";
import { CryptoKeyT } from "spacedatastandards.org/lib/js/EPM/CryptoKey.js";
import { EPMT } from "spacedatastandards.org/lib/js/EPM/EPM.js";
import { EntityType } from "spacedatastandards.org/lib/js/EPM/EntityType.js";
import { KeyType } from "spacedatastandards.org/lib/js/EPM/KeyType.js";
import { PLG } from "spacedatastandards.org/lib/js/PLG/PLG.js";
import { pluginCategory } from "spacedatastandards.org/lib/js/PLG/pluginCategory.js";
import { KRF } from "spacedatastandards.org/lib/js/REC/KRF.js";
import { keyReferenceAlgorithm } from "spacedatastandards.org/lib/js/REC/keyReferenceAlgorithm.js";
import { keyReferenceRole } from "spacedatastandards.org/lib/js/REC/keyReferenceRole.js";
import { LCH } from "spacedatastandards.org/lib/js/REC/LCH.js";
import { LCF } from "spacedatastandards.org/lib/js/REC/LCF.js";
import { licensingChallengeMessageType } from "spacedatastandards.org/lib/js/REC/licensingChallengeMessageType.js";
import { licensingChallengeRole } from "spacedatastandards.org/lib/js/REC/licensingChallengeRole.js";
import { licensingConfigMessageType } from "spacedatastandards.org/lib/js/REC/licensingConfigMessageType.js";
import { licensingConfigRole } from "spacedatastandards.org/lib/js/REC/licensingConfigRole.js";

const textEncoder = new TextEncoder();
const ACCOUNT_KEY_PATH = "m/44'/0'/0'";
const LEASE_DOMAIN = "app.orbpro.test";
const LEASE_ORIGIN = `https://${LEASE_DOMAIN}`;
const LEASE_PROVIDER = "provider.orbpro.test";
const LEASE_TIMEOUT_MS = 30_000;
const CONSOLE_PROOF_SECONDS = 24 * 3600;
const SECP256K1_SPKI_PREFIX = {
  33: "3036301006072a8648ce3d020106052b8104000a032200",
  65: "3056301006072a8648ce3d020106052b8104000a034200",
};
function encodeFile(content) {
  const builder = new flatbuffers.Builder(content.length + 64);
  const contentOffset = FIL.createContentVector(builder, content);
  FIL.startFIL(builder);
  FIL.addContent(builder, contentOffset);
  FIL.finishFILBuffer(builder, FIL.endFIL(builder));
  return builder.asUint8Array();
}
function makeRuntimeConfig() {
  const signingSlotId = "provider-signing";
  const wrappingSlotId = "provider-wrapping";
  return {
    providerPeerId: "provider.orbpro.test",
    activeKeyVersion: 9,
    expiresAtMs: Date.now() + 60_000,
    challengeTtlMs: 30_000,
    maxClockSkewMs: 5_000,
    capabilityToken: textEncoder.encode("capability-token"),
    signingSlotId,
    wrappingSlotId,
    keySlots: new Map([
      [signingSlotId, randomBytes(32)],
      [wrappingSlotId, randomBytes(32)],
    ]),
  };
}

function requireBytesParam(params, field) {
  const value = params?.[field];
  if (!(value instanceof Uint8Array)) {
    throw new Error(`Missing bytes field: ${field}`);
  }
  return value;
}

function handleEd25519HostOperation(wallet, operation, params) {
  if (!wallet) {
    throw new Error(`Wallet not initialized for operation: ${operation}`);
  }
  if (operation === "crypto.ed25519.publicKeyFromSeed") {
    return new Uint8Array(
      wallet.curves.ed25519.publicKeyFromSeed(requireBytesParam(params, "seed")),
    );
  }
  if (operation === "crypto.ed25519.sign") {
    return new Uint8Array(
      wallet.curves.ed25519.sign(
        requireBytesParam(params, "message"),
        requireBytesParam(params, "seed"),
      ),
    );
  }
  if (operation === "crypto.ed25519.verify") {
    return wallet.curves.ed25519.verify(
      requireBytesParam(params, "message"),
      requireBytesParam(params, "signature"),
      requireBytesParam(params, "publicKey"),
    );
  }
  return undefined;
}

function verifySecp256k1Der(message, signature, publicKey) {
  const prefix = SECP256K1_SPKI_PREFIX[publicKey.length];
  if (!prefix) {
    return false;
  }
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from(prefix, "hex"), Buffer.from(publicKey)]),
    format: "der",
    type: "spki",
  });
  try {
    return verifyWithNodeKey(
      "sha256",
      Buffer.from(message),
      { key, dsaEncoding: "der" },
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

function createServerHostDispatch(contentStore, keySlots = new Map(), wallet = null, clock = Date.now) {
  return (operation, params) => {
    if (operation.startsWith("crypto.ed25519.")) {
      return handleEd25519HostOperation(wallet, operation, params);
    }
    if (operation === "crypto.secp256k1.verify") {
      return verifySecp256k1Der(
        requireBytesParam(params, "message"),
        requireBytesParam(params, "signature"),
        requireBytesParam(params, "publicKey"),
      );
    }
    if (operation === "clock.now") {
      return clock();
    }
    if (operation === "random.bytes") {
      return randomBytes(params?.length ?? 32);
    }
    if (operation === "keyslot.sign") {
      // Host-side crypto oracle, matching sdn-server/internal/modulert/caps/keyslot.go (handleKeyslotSign): the
      // slot's raw key material never leaves this dispatch function; only the signature crosses back, on the typed
      // answer's raw "data" frame. ALGORITHM is HostOps cryptoAlgorithm (Ed25519 = 1).
      const slotId = String(params?.slotId ?? "");
      const keyBytes = keySlots.get(slotId);
      if (!keyBytes) {
        throw new Error(`keyslot.sign missing slot: ${slotId}`);
      }
      if (params?.algorithm !== 1) {
        throw new Error(`Unsupported keyslot.sign algorithm: ${params?.algorithm}`);
      }
      const payload =
        params?.payload instanceof Uint8Array
          ? params.payload
          : new Uint8Array();
      return wallet.curves.ed25519.sign(payload, keyBytes);
    }
    if (operation === "ipfs.add") {
      // typed: raw "data" in, IpfsResult {CID, SIZE} out. Copy: hostcall frames are views into wasm memory.
      const raw = params?.data instanceof Uint8Array ? Buffer.from(params.data) : null;
      if (!raw) {
        throw new Error("ipfs.add requires data bytes");
      }
      const cid = publicationCids.get(createHash("sha256").update(raw).digest("hex"));
      assert.ok(cid, "publication must have a real precomputed CID");
      contentStore.set(cid, raw);
      return { cid, size: raw.length };
    }
    throw new Error(`Unsupported operation: ${operation}`);
  };
}

function buildRuntimeConfigFrame(config) {
  const builder = new flatbuffers.Builder(512);
  const providerPeerIdOffset = builder.createString(config.providerPeerId);
  const signingKeyIdOffset = builder.createString("licensing.provider.signing");
  const signingSlotIdOffset = builder.createString(config.signingSlotId);
  const wrappingKeyIdOffset = builder.createString("licensing.provider.wrapping");
  const wrappingSlotIdOffset = builder.createString(config.wrappingSlotId);
  const capabilityTokenOffset =
    config.capabilityToken?.length > 0
      ? LCF.createCapabilityTokenVector(builder, config.capabilityToken)
      : 0;
  const signingKeyOffset = KRF.createKRF(
    builder,
    signingKeyIdOffset,
    signingSlotIdOffset,
    keyReferenceRole.ProviderSigning,
    keyReferenceAlgorithm.Ed25519Seed,
    0,
    config.activeKeyVersion,
    0n,
    true,
  );
  const wrappingKeyOffset = KRF.createKRF(
    builder,
    wrappingKeyIdOffset,
    wrappingSlotIdOffset,
    keyReferenceRole.ProviderWrapping,
    keyReferenceAlgorithm.X25519Private,
    0,
    config.activeKeyVersion,
    0n,
    true,
  );
  LCF.startLCF(builder);
  LCF.addMessageType(builder, licensingConfigMessageType.Configure);
  LCF.addRole(builder, licensingConfigRole.Provider);
  LCF.addProviderPeerId(builder, providerPeerIdOffset);
  LCF.addProviderSigningKey(builder, signingKeyOffset);
  LCF.addProviderWrappingKey(builder, wrappingKeyOffset);
  LCF.addActiveKeyVersion(builder, config.activeKeyVersion);
  LCF.addExpiresAt(builder, BigInt(config.expiresAtMs));
  LCF.addMaxClockSkewMs(builder, BigInt(config.maxClockSkewMs));
  LCF.addChallengeTtlMs(builder, BigInt(config.challengeTtlMs));
  if (capabilityTokenOffset !== 0) {
    LCF.addCapabilityToken(builder, capabilityTokenOffset);
  }
  const root = LCF.endLCF(builder);
  LCF.finishLCFBuffer(builder, root);
  return builder.asUint8Array();
}

function configureServerSync(harness, config) {
  const response = harness.invokeSync({
    methodId: "server_configure_runtime",
    inputs: [
      {
        portId: "config",
        fileIdentifier: "$LCF",
        payload: buildRuntimeConfigFrame(config),
      },
    ],
  });
  assert.equal(response.statusCode, 0);
}

function buildModuleDescriptor({
  moduleId,
  version,
  keyId = `${moduleId}:${version}`,
  requiredScope = "orbpro.default",
  allowedXpubs = [],
  maxGrantTimeoutMs = 30_000n,
}) {
  const builder = new flatbuffers.Builder(512);
  const pluginIdOffset = builder.createString(moduleId);
  const nameOffset = builder.createString(moduleId);
  const versionOffset = builder.createString(version);
  const descriptionOffset = builder.createString("Protected module fixture");
  const requiredScopeOffset = builder.createString(requiredScope);
  const keyIdOffset = builder.createString(keyId);
  const allowedXpubOffsets = allowedXpubs.map((xpub) => builder.createString(xpub));
  const allowedXpubsOffset = allowedXpubOffsets.length
    ? PLG.createAllowedXpubsVector(builder, allowedXpubOffsets)
    : 0;

  PLG.startPLG(builder);
  PLG.addPluginId(builder, pluginIdOffset);
  PLG.addName(builder, nameOffset);
  PLG.addVersion(builder, versionOffset);
  PLG.addDescription(builder, descriptionOffset);
  PLG.addPluginType(builder, pluginCategory.Analysis);
  PLG.addAbiVersion(builder, 1);
  PLG.addEncrypted(builder, true);
  PLG.addRequiredScope(builder, requiredScopeOffset);
  PLG.addKeyId(builder, keyIdOffset);
  if (allowedXpubsOffset) PLG.addAllowedXpubs(builder, allowedXpubsOffset);
  PLG.addMaxGrantTimeoutMs(builder, maxGrantTimeoutMs);
  PLG.addCreatedAt(builder, BigInt(Date.now()));
  PLG.addUpdatedAt(builder, BigInt(Date.now()));
  const root = PLG.endPLG(builder);
  PLG.finishPLGBuffer(builder, root);
  return builder.asUint8Array();
}

function decodeModuleDescriptor(bytes) {
  const buffer = new flatbuffers.ByteBuffer(bytes);
  return PLG.getRootAsPLG(buffer);
}

function detectFlatbufferFileIdentifier(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) {
    return null;
  }
  return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
}

function publishModuleSync(
  serverHarness,
  descriptorBytes,
  protectedContent,
  contentKey,
  { algorithm = "aes-256-gcm" } = {},
) {
  const descriptor = decodeModuleDescriptor(descriptorBytes);
  const keyId = descriptor.KEY_ID() || `${descriptor.PLUGIN_ID()}:${descriptor.VERSION()}`;
  const secretId = `licensing/content/${keyId}`;
  serverHarness.secrets.set(secretId, contentKey);
  const entries = (serverHarness.config.content_keys ?? []).filter((entry) => entry.key_id !== keyId);
  entries.push({ key_id: keyId, secret_id: secretId, algorithm });
  serverHarness.config.content_keys = entries;
  const response = serverHarness.invokeSync({
    methodId: "server_publish_module",
    inputs: [
      {
        portId: "module_descriptor",
        fileIdentifier: "$PLG",
        payload: descriptorBytes,
      },
      {
        portId: "protected_content",
        fileIdentifier: "$FIL",
        payload: encodeFile(protectedContent),
      },
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "response");
  return response.outputs[0].payload;
}

function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function createWalletAccount(wallet) {
  const master = wallet.hdkey.fromSeed(randomBytes(64));
  const account = master.derivePath(ACCOUNT_KEY_PATH);
  const point = account.publicKeyUncompressed();
  const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
  const signingKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "secp256k1",
      d: b64u(account.privateKey()),
      x: b64u(point.slice(1, 33)),
      y: b64u(point.slice(33, 65)),
    },
    format: "jwk",
  });
  const result = {
    xpub: account.toXpub(),
    publicKeyHex: toHex(account.publicKey()),
    signingKey,
  };
  account.wipe();
  master.wipe();
  return result;
}

async function createSession(wallet) {
  const seed = randomBytes(32);
  return {
    seed,
    signingPublicKey: new Uint8Array(wallet.curves.ed25519.publicKeyFromSeed(seed)),
    encryption: await generateX25519Keypair(),
  };
}

function signModuleDeliveryKey(
  account,
  session,
  { origin = LEASE_ORIGIN, signedAtMs = Date.now(), lifetimeSeconds = CONSOLE_PROOF_SECONDS } = {},
) {
  const expires = Math.floor(signedAtMs / 1000) + lifetimeSeconds;
  const statement = Buffer.from(
    "sdn-module-delivery-key/1\n" +
      `ed25519:${toHex(session.signingPublicKey)}\n` +
      `xpub:${account.xpub}\n` +
      `origin:${origin}\n` +
      `expires:${expires}\n`,
    "utf8",
  );
  return {
    keyPath: ACCOUNT_KEY_PATH,
    accountXpub: account.xpub,
    publicKeyHex: account.publicKeyHex,
    signedPayloadHex: statement.toString("hex"),
    signatureHex: signWithNodeKey("sha256", statement, {
      key: account.signingKey,
      dsaEncoding: "der",
    }).toString("hex"),
    algorithm: "secp256k1",
    encoding: "der",
  };
}

function buildRequesterEpm(
  wallet,
  { signerSeed, proof, withAccountProof = true, timestampSeconds = Math.floor(Date.now() / 1000) },
) {
  const signerPublicKey = wallet.curves.ed25519.publicKeyFromSeed(signerSeed);
  const sessionKey = { PUBLIC_KEY: toHex(signerPublicKey), KEY_TYPE: "Signing", ALGORITHM: "ed25519" };
  const accountKey = {
    PUBLIC_KEY: proof.publicKeyHex,
    XPUB: proof.accountXpub,
    KEY_TYPE: "Signing",
    KEY_PATH: proof.keyPath,
    ALGORITHM: "secp256k1",
  };
  const chainProofs = withAccountProof
    ? [
        {
          PUBLIC_KEY: proof.publicKeyHex,
          KEY_PATH: proof.keyPath,
          SIGNATURE: proof.signatureHex,
          SIGNED_PAYLOAD: proof.signedPayloadHex,
          ALGORITHM: proof.algorithm,
          ENCODING: proof.encoding,
        },
      ]
    : [];
  const content = {
    KEYS: [sessionKey, accountKey],
    ENTITY_TYPE: "User",
    SIGNATURE_TIMESTAMP: timestampSeconds,
    SIGNATURE_ALGORITHM: "ed25519",
  };
  if (chainProofs.length > 0) {
    content.CHAIN_PROOFS = chainProofs;
  }
  const signature = wallet.curves.ed25519.sign(
    textEncoder.encode(canonicalJson(content)),
    signerSeed,
  );

  const epm = new EPMT();
  epm.KEYS = [sessionKey, accountKey].map(
    (key) =>
      new CryptoKeyT(
        key.PUBLIC_KEY,
        key.XPUB ?? null,
        null,
        null,
        null,
        null,
        KeyType.Signing,
        key.KEY_PATH ?? null,
        key.ALGORITHM,
        null,
      ),
  );
  epm.ENTITY_TYPE = EntityType.User;
  epm.SIGNATURE_TIMESTAMP = BigInt(timestampSeconds);
  epm.SIGNATURE_ALGORITHM = "ed25519";
  epm.SIGNATURE = toHex(signature);
  epm.CHAIN_PROOFS = chainProofs.map(
    (entry) =>
      new ChainProofT(
        null,
        null,
        entry.PUBLIC_KEY,
        entry.KEY_PATH,
        entry.SIGNATURE,
        entry.SIGNED_PAYLOAD,
        entry.ALGORITHM,
        entry.ENCODING,
      ),
  );
  const builder = new flatbuffers.Builder(1024);
  builder.finish(epm.pack(builder), "$EPM");
  return builder.asUint8Array().slice();
}

function buildLeaseChallengeRequest({
  reqId,
  moduleId,
  moduleVersion,
  requesterXpub,
  session,
  epm,
  requesterPeerId,
  requestedAtMs,
}) {
  const builder = new flatbuffers.Builder(1024);
  const reqIdOffset = builder.createString(reqId);
  const moduleIdOffset = builder.createString(moduleId);
  const moduleVersionOffset = builder.createString(moduleVersion);
  const peerIdOffset = builder.createString(requesterPeerId);
  const xpubOffset = requesterXpub ? builder.createString(requesterXpub) : 0;
  const signingOffset = LCH.createRequesterSigningPubkeyVector(builder, session.signingPublicKey);
  const ephemeralOffset = LCH.createRequesterEphemeralPubkeyVector(
    builder,
    session.encryption.publicKey,
  );
  const domainOffset = builder.createString(LEASE_DOMAIN);
  const providerOffset = builder.createString(LEASE_PROVIDER);
  const epmOffset = epm ? LCH.createRequesterEpmVector(builder, epm) : 0;
  const root = LCH.createLCH(
    builder,
    licensingChallengeMessageType.Request,
    licensingChallengeRole.Requester,
    reqIdOffset,
    moduleIdOffset,
    moduleVersionOffset,
    peerIdOffset,
    xpubOffset,
    signingOffset,
    ephemeralOffset,
    domainOffset,
    BigInt(LEASE_TIMEOUT_MS),
    BigInt(requestedAtMs),
    0,
    0n,
    providerOffset,
    0,
    0,
    epmOffset,
  );
  LCH.finishLCHBuffer(builder, root);
  return builder.asUint8Array();
}

function handleServerMessage(serverHarness, fileIdentifier, payload) {
  const portId = fileIdentifier === "$LPF" ? "proof" : "request";
  const response = serverHarness.invokeSync({
    methodId: "server_handle_message",
    inputs: [{ portId, fileIdentifier, payload }],
  });
  for (const output of response.outputs ?? []) {
    assert.equal(output.portId, detectFlatbufferFileIdentifier(output.payload) === "$LGR" ? "grant" : "challenge");
  }
  return response;
}

function openLease(
  serverHarness,
  {
    moduleId,
    moduleVersion,
    requesterXpub,
    session,
    epm,
    requesterPeerId = "requester.orbpro.test",
    nowMs = Date.now(),
  },
) {
  const reqId = `lease-${randomBytes(6).toString("hex")}`;
  const challengeResponse = handleServerMessage(
    serverHarness,
    "$LCH",
    buildLeaseChallengeRequest({
      reqId,
      moduleId,
      moduleVersion,
      requesterXpub,
      session,
      epm,
      requesterPeerId,
      requestedAtMs: nowMs,
    }),
  );
  assert.equal(challengeResponse.statusCode, 0);
  const challenge = decodeLicensingChallengeMessage(challengeResponse.outputs[0].payload);
  if (challenge.messageType === "error") {
    return { challengeError: challenge.errorCode };
  }
  return { reqId, moduleId, moduleVersion, requesterXpub, session, requesterPeerId, challenge };
}

function proveLease(serverHarness, wallet, opened, nowMs = Date.now()) {
  const { reqId, moduleId, moduleVersion, requesterXpub, session, requesterPeerId, challenge } = opened;
  const proof = encodeLicensingProof({
    reqId,
    moduleId,
    moduleVersion,
    requesterPeerId,
    requesterXpub,
    requesterDomain: LEASE_DOMAIN,
    requestedTimeoutMs: LEASE_TIMEOUT_MS,
    requesterEphemeralPublicKey: session.encryption.publicKey,
    challengeNonce: challenge.challengeNonce,
    challengeExpiresAtMs: challenge.expiresAtMs,
    providerPeerId: challenge.providerPeerId,
    signature: wallet.curves.ed25519.sign(challenge.rawBytes, session.seed),
    requesterSigningPublicKey: session.signingPublicKey,
    timestampMs: nowMs,
  });
  const grantResponse = handleServerMessage(serverHarness, "$LPF", proof);
  return {
    statusCode: grantResponse.statusCode,
    grantBytes: grantResponse.statusCode === 0 ? grantResponse.outputs[0].payload : null,
  };
}

function requestLease(serverHarness, wallet, request) {
  const opened = openLease(serverHarness, request);
  return opened.challengeError !== undefined ? opened : proveLease(serverHarness, wallet, opened, request.nowMs);
}

export const publicationCids = new Map();
export { createServerHostDispatch, makeRuntimeConfig, configureServerSync, buildModuleDescriptor,
  publishModuleSync, createSession, createWalletAccount, signModuleDeliveryKey, buildRequesterEpm,
  requestLease, decodeModuleDescriptor };
