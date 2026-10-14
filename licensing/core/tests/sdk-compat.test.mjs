import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signWithNodeKey,
  verify as verifyWithNodeKey,
} from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";

import {
  createSdkBrowserShimHarness,
  createSdkBrowserShimSyncHarness,
} from "./lib/sdkBrowserShimHarness.mjs";
import { loadStandard } from "./lib/sds_bindings.mjs";
import {
  decodeLicensingGrant,
  encryptBytesForRecipient,
  generateX25519Keypair,
} from "space-data-module-sdk";
import {
  decodeLicensingChallengeMessage,
  encodeLicensingProof,
  validateLicensingGrant,
} from "space-data-module-sdk/licensing";
import { getWasmWallet } from "space-data-module-sdk/utils/wasm-crypto";
import { ChainProofT } from "spacedatastandards.org/lib/js/EPM/ChainProof.js";
import { CryptoKeyT } from "spacedatastandards.org/lib/js/EPM/CryptoKey.js";
import { EPMT } from "spacedatastandards.org/lib/js/EPM/EPM.js";
import { EntityType } from "spacedatastandards.org/lib/js/EPM/EntityType.js";
import { KeyType } from "spacedatastandards.org/lib/js/EPM/KeyType.js";
import { PLG } from "spacedatastandards.org/lib/js/PLG/PLG.js";
import { pluginCategory } from "spacedatastandards.org/lib/js/PLG/pluginCategory.js";
import { KMF } from "spacedatastandards.org/lib/js/REC/KMF.js";
import { REC } from "spacedatastandards.org/lib/js/REC/REC.js";
import { Record } from "spacedatastandards.org/lib/js/REC/Record.js";
import { keyMaterialAlgorithm } from "spacedatastandards.org/lib/js/REC/keyMaterialAlgorithm.js";
import { keyMaterialEncoding } from "spacedatastandards.org/lib/js/REC/keyMaterialEncoding.js";
import { keyMaterialRole } from "spacedatastandards.org/lib/js/REC/keyMaterialRole.js";
import { KRF } from "spacedatastandards.org/lib/js/REC/KRF.js";
import { keyReferenceAlgorithm } from "spacedatastandards.org/lib/js/REC/keyReferenceAlgorithm.js";
import { keyReferenceRole } from "spacedatastandards.org/lib/js/REC/keyReferenceRole.js";
import { LCH } from "spacedatastandards.org/lib/js/REC/LCH.js";
import { LCF } from "spacedatastandards.org/lib/js/REC/LCF.js";
import { licensingChallengeMessageType } from "spacedatastandards.org/lib/js/REC/licensingChallengeMessageType.js";
import { licensingChallengeRole } from "spacedatastandards.org/lib/js/REC/licensingChallengeRole.js";
import { licensingConfigMessageType } from "spacedatastandards.org/lib/js/REC/licensingConfigMessageType.js";
import { licensingConfigRole } from "spacedatastandards.org/lib/js/REC/licensingConfigRole.js";
import { LGR } from "spacedatastandards.org/lib/js/REC/LGR.js";
import { licensingGrantMessageType } from "spacedatastandards.org/lib/js/REC/licensingGrantMessageType.js";
import { KeyExchange } from "spacedatastandards.org/lib/js/REC/KeyExchange.js";
import { SymmetricAlgo } from "spacedatastandards.org/lib/js/REC/SymmetricAlgo.js";
import { KDF } from "spacedatastandards.org/lib/js/REC/KDF.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MODULE_DELIVERY_PROTOCOL_ID = "/space-data-network/module-delivery/1.0.0";

const { FIL } = await loadStandard("FIL");

// A $FIL carrying `content` verbatim: the typed form of the ciphertext / plaintext ports.
function encodeFile(content) {
  const builder = new flatbuffers.Builder(content.length + 64);
  const contentOffset = FIL.createContentVector(builder, content);
  FIL.startFIL(builder);
  FIL.addContent(builder, contentOffset);
  FIL.finishFILBuffer(builder, FIL.endFIL(builder));
  return builder.asUint8Array();
}
function decodeFileContent(bytes) {
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.ok(FIL.bufferHasIdentifier(bb), "the frame is a $FIL");
  const file = FIL.getRootAsFIL(bb);
  assert.equal(Number(file.SIZE()), file.contentLength());
  return file.contentArray();
}

// The requester's signing seed reaches client_request_grant only through secrets.get, by the ID its config names.
const REQUESTER_SIGNING_SECRET_ID = "licensing/requester-signing";
function requesterSecrets(seed = randomBytes(32)) {
  return {
    config: { requester_signing_secret_id: REQUESTER_SIGNING_SECRET_ID },
    secrets: new Map([[REQUESTER_SIGNING_SECRET_ID, seed]]),
  };
}

const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
// The requester-side decrypt module the console unwraps grants with.
const CLIENT_DECRYPT_WASM_PATH = new URL(
  "../../client-decrypt/dist/isomorphic/module.wasm",
  import.meta.url,
);

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

function createDefaultHostDispatch(wallet = null) {
  return (operation, params) => {
    if (operation.startsWith("crypto.ed25519.")) {
      return handleEd25519HostOperation(wallet, operation, params);
    }
    if (operation === "clock.now") {
      return Date.now();
    }
    if (operation === "random.bytes") {
      return randomBytes(params?.length ?? 32);
    }
    throw new Error(`Unsupported operation: ${operation}`);
  };
}

// SEC1 point -> SubjectPublicKeyInfo DER prefix for secp256k1, by point length.
const SECP256K1_SPKI_PREFIX = {
  33: "3036301006072a8648ce3d020106052b8104000a032200",
  65: "3056301006072a8648ce3d020106052b8104000a034200",
};

// Host op as the SDN node serves it (sdn-server/internal/modulert/caps/crypto.go):
// ECDSA-DER over sha256(message), SEC1 public key.
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

// `clock` is the host's clock.now: the key server reads time only through it.
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
      const cid = `bafy-lic-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
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

function buildKeyMaterialFrame({
  keyId,
  role,
  algorithm,
  encoding,
  keyBytes,
}) {
  const builder = new flatbuffers.Builder(256);
  const keyIdOffset = builder.createString(keyId);
  const keyBytesOffset = KMF.createKeyBytesVector(builder, keyBytes);
  const root = KMF.createKMF(
    builder,
    keyIdOffset,
    role,
    algorithm,
    encoding,
    keyBytesOffset,
    0,
    0n,
  );
  KMF.finishKMFBuffer(builder, root);
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

function createProtocolDispatch(serverHarness, contentStore = new Map(), wallet = null) {
  return (operation, params) => {
    if (operation.startsWith("crypto.ed25519.")) {
      return handleEd25519HostOperation(wallet, operation, params);
    }
    if (operation === "clock.now") {
      return Date.now();
    }
    if (operation === "random.bytes") {
      return randomBytes(params?.length ?? 32);
    }
    if (operation === "ipfs.cat") {
      const cid = params?.cid ?? "";
      const content = contentStore.get(cid);
      if (!content) {
        throw new Error(`CID not found: ${cid}`);
      }
      return new Uint8Array(content);
    }
    if (operation !== "protocol.request") {
      throw new Error(`Unsupported operation: ${operation}`);
    }

    const payload =
      params?.payload instanceof Uint8Array ? params.payload : new Uint8Array();

    if (params?.protocolId === MODULE_DELIVERY_PROTOCOL_ID) {
      const fileIdentifier = detectFlatbufferFileIdentifier(payload);
      const response = handleServerMessage(serverHarness, fileIdentifier, payload);
      if (response.statusCode !== 0 || response.outputs.length === 0) {
        throw new Error(`server_handle_message failed with status ${response.statusCode}`);
      }
      return response.outputs[0].payload;
    }

    throw new Error(`Unsupported protocol: ${params?.protocolId}`);
  };
}

function buildGrantRequest({
  requestId,
  moduleId,
  moduleVersion,
  requesterPeerId,
  requesterXpub,
  requesterDomain,
  requestedTimeoutMs = 30_000n,
  requestedAtMs = BigInt(Date.now()),
  providerPeerId = "provider.orbpro.test",
}) {
  const builder = new flatbuffers.Builder(512);
  const requestIdOffset = builder.createString(requestId);
  const moduleIdOffset = builder.createString(moduleId);
  const moduleVersionOffset = builder.createString(moduleVersion);
  const requesterPeerIdOffset = builder.createString(requesterPeerId);
  const requesterXpubOffset = builder.createString(requesterXpub);
  const requesterDomainOffset = builder.createString(requesterDomain);
  const providerPeerIdOffset = builder.createString(providerPeerId);
  const root = LCH.createLCH(
    builder,
    licensingChallengeMessageType.Request,
    licensingChallengeRole.Requester,
    requestIdOffset,
    moduleIdOffset,
    moduleVersionOffset,
    requesterPeerIdOffset,
    requesterXpubOffset,
    0,
    0,
    requesterDomainOffset,
    requestedTimeoutMs,
    requestedAtMs,
    0,
    0n,
    providerPeerIdOffset,
    0,
    0,
    0,
  );
  LCH.finishLCHBuffer(builder, root);
  return builder.asUint8Array();
}

function decodeGrantResponse(bytes) {
  const buffer = new flatbuffers.ByteBuffer(bytes);
  return LGR.getRootAsLGR(buffer);
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

function encryptProtectedContent(plaintext, contentKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

// The content key reaches the key server only through secrets.get: config content_keys maps the descriptor's KEY_ID
// to the secret's ID and the key's algorithm.
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

test("server publishes REC-protected artifacts using X25519 decrypt-key material in the grant metadata", async (t) => {
  const contentStore = new Map();
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore, runtimeConfig.keySlots, wallet),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  configureServerSync(serverHarness, runtimeConfig);

  const recipient = await generateX25519Keypair();
  const protectedEnvelope = await encryptBytesForRecipient({
    plaintext: textEncoder.encode("sdk rec protected module"),
    recipientPublicKey: recipient.publicKey,
    context: "space-data-module-sdk/package",
    rootType: "WASM",
  });
  const protectedContent = Uint8Array.from(
    Buffer.from(protectedEnvelope.protectedBlobBase64, "base64"),
  );
  const descriptorBytes = buildModuleDescriptor({
    moduleId: "orbpro.rec.protected.module",
    version: "2.0.0",
    keyId: "orbpro.rec.protected.module:2.0.0",
  });

  publishModuleSync(
    serverHarness,
    descriptorBytes,
    protectedContent,
    recipient.privateKey,
    { algorithm: "x25519" },
  );

  const clientHarness = await createSdkBrowserShimHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createProtocolDispatch(serverHarness, contentStore, wallet),
    surface: "direct",
    ...requesterSecrets(),
  });
  t.after(async () => {
    await clientHarness.destroy();
  });

  const response = await clientHarness.invoke({
    methodId: "client_request_grant",
    inputs: [
      {
        portId: "request",
        fileIdentifier: "$LCH",
        payload: buildGrantRequest({
          requestId: "grant-req-rec-protected",
          moduleId: "orbpro.rec.protected.module",
          moduleVersion: "2.0.0",
          requesterPeerId: "requester.orbpro.test",
          requesterXpub: "xpub-test-requester",
          requesterDomain: "app.orbpro.test",
          providerPeerId: "provider.orbpro.test",
        }),
      },
    ],
  });

  assert.equal(response.statusCode, 0);
  const grant = decodeGrantResponse(response.outputs[0].payload);
  const wrappedPayload = grant.wrappedContentKeyPayloadArray();
  assert.ok(wrappedPayload?.length > 0);
  const wrappedRec = REC.getRootAsREC(new flatbuffers.ByteBuffer(wrappedPayload));
  const wrappedRecord = wrappedRec.RECORDS(0, new Record());
  const wrappedKmf = wrappedRecord?.value(new KMF());
  assert.ok(wrappedKmf);
  assert.equal(wrappedKmf.ROLE(), keyMaterialRole.DecryptKey);
  assert.equal(wrappedKmf.ALGORITHM(), keyMaterialAlgorithm.X25519Private);
});

test("server_publish_module publishes encrypted content and returns an updated PLG descriptor", async (t) => {
  const contentStore = new Map();
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore, runtimeConfig.keySlots, wallet),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  configureServerSync(serverHarness, runtimeConfig);

  const moduleDescriptor = buildModuleDescriptor({
    moduleId: "orbpro.test.module",
    version: "1.2.3",
  });
  const protectedContent = textEncoder.encode("encrypted module bytes");
  const contentKey = randomBytes(32);

  const responseBytes = publishModuleSync(
    serverHarness,
    moduleDescriptor,
    protectedContent,
    contentKey,
  );
  const descriptor = decodeModuleDescriptor(responseBytes);

  assert.equal(descriptor.PLUGIN_ID(), "orbpro.test.module");
  assert.equal(descriptor.VERSION(), "1.2.3");
  assert.ok(descriptor.WASM_CID());
  assert.equal(descriptor.ENCRYPTED_WASM_SIZE(), BigInt(protectedContent.length));
  assert.equal(descriptor.encryptedWasmHashLength(), 32);
  assert.equal(contentStore.has(descriptor.WASM_CID()), true);
});

test("republishing a module preserves WASM_CID in the granted descriptor", async (t) => {
  const contentStore = new Map();
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore, runtimeConfig.keySlots, wallet),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  configureServerSync(serverHarness, runtimeConfig);

  const moduleId = "orbpro.republish.module";
  const moduleVersion = "4.2.0";
  const firstDescriptorBytes = buildModuleDescriptor({
    moduleId,
    version: moduleVersion,
  });
  const firstCid = decodeModuleDescriptor(
    publishModuleSync(
      serverHarness,
      firstDescriptorBytes,
      textEncoder.encode("first encrypted bundle"),
      randomBytes(32),
    ),
  ).WASM_CID();
  assert.ok(firstCid);

  const secondDescriptorBytes = buildModuleDescriptor({
    moduleId,
    version: moduleVersion,
  });
  const secondPublishedDescriptor = decodeModuleDescriptor(
    publishModuleSync(
      serverHarness,
      secondDescriptorBytes,
      textEncoder.encode("second encrypted bundle"),
      randomBytes(32),
    ),
  );
  assert.ok(secondPublishedDescriptor.WASM_CID());

  const clientHarness = await createSdkBrowserShimHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createProtocolDispatch(serverHarness, contentStore, wallet),
    surface: "direct",
    ...requesterSecrets(),
  });
  t.after(async () => {
    await clientHarness.destroy();
  });

  const grantResponse = await clientHarness.invoke({
    methodId: "client_request_grant",
    inputs: [
      {
        portId: "request",
        fileIdentifier: "$LCH",
        payload: buildGrantRequest({
          requestId: "grant-req-republish",
          moduleId,
          moduleVersion,
          requesterPeerId: "requester.orbpro.test",
          requesterXpub: "xpub-test-requester",
          requesterDomain: "app.orbpro.test",
          providerPeerId: "provider.orbpro.test",
        }),
      },
    ],
  });

  assert.equal(grantResponse.statusCode, 0);
  const grant = decodeGrantResponse(grantResponse.outputs[0].payload);
  const grantedDescriptor = grant.MODULE_DESCRIPTOR();
  assert.ok(grantedDescriptor);
  assert.ok(grantedDescriptor.WASM_CID());
  assert.equal(grantedDescriptor.WASM_CID(), secondPublishedDescriptor.WASM_CID());
});

test("client and server role entrypoints interoperate inside the unified licensing module", async (t) => {
  const contentStore = new Map();
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore, runtimeConfig.keySlots, wallet),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  configureServerSync(serverHarness, runtimeConfig);
  const moduleDek = randomBytes(32);
  const descriptorBytes = buildModuleDescriptor({
    moduleId: "orbpro.test.module",
    version: "1.2.3",
    keyId: "orbpro.test.module:1.2.3",
  });
  publishModuleSync(
    serverHarness,
    descriptorBytes,
    textEncoder.encode("encrypted bundle"),
    moduleDek,
  );

  const clientHarness = await createSdkBrowserShimHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createProtocolDispatch(serverHarness, new Map(), wallet),
    surface: "direct",
    ...requesterSecrets(),
  });
  t.after(async () => {
    await clientHarness.destroy();
  });

  const response = await clientHarness.invoke({
    methodId: "client_request_grant",
    inputs: [
      {
        portId: "request",
        fileIdentifier: "$LCH",
        payload: buildGrantRequest({
          requestId: "grant-req-001",
          moduleId: "orbpro.test.module",
          moduleVersion: "1.2.3",
          requesterPeerId: "requester.orbpro.test",
          requesterXpub: "xpub-test-requester",
          requesterDomain: "app.orbpro.test",
          providerPeerId: "provider.orbpro.test",
        }),
      },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "response");
  const grant = decodeGrantResponse(response.outputs[0].payload);
  assert.equal(grant.MESSAGE_TYPE(), licensingGrantMessageType.Granted);
  assert.equal(grant.REQUEST_ID(), "grant-req-001");
  assert.equal(grant.MODULE_ID(), "orbpro.test.module");
  assert.equal(grant.MODULE_VERSION(), "1.2.3");
  assert.equal(grant.GRANTED_DOMAIN(), "app.orbpro.test");
  assert.equal(grant.GRANTED_TIMEOUT_MS(), 30_000n);
  assert.ok(grant.EXPIRES_AT() > BigInt(Date.now()));
  const wrappedHeader = grant.WRAPPED_CONTENT_KEY_HEADER();
  assert.ok(wrappedHeader);
  assert.equal(wrappedHeader.KEY_EXCHANGE(), KeyExchange.X25519);
  assert.equal(wrappedHeader.SYMMETRIC(), SymmetricAlgo.AES_256_CTR);
  assert.equal(wrappedHeader.KEY_DERIVATION(), KDF.HKDF_SHA256);
  assert.equal(wrappedHeader.ROOT_TYPE(), "REC");
  assert.equal(wrappedHeader.nonceStartLength(), 12);
  assert.ok(grant.wrappedContentKeyPayloadLength() > 0);
  assert.ok(grant.MODULE_DESCRIPTOR());
});

test("client_fetch_and_decrypt resolves the published CID through ipfs.cat", async (t) => {
  const contentStore = new Map();
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore, runtimeConfig.keySlots, wallet),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  configureServerSync(serverHarness, runtimeConfig);

  const moduleDek = randomBytes(32);
  const plaintext = textEncoder.encode("hello protected module");
  const encryptedContent = encryptProtectedContent(plaintext, moduleDek);
  const descriptorBytes = buildModuleDescriptor({
    moduleId: "orbpro.fetch.module",
    version: "9.1.0",
  });
  const publishedDescriptor = publishModuleSync(
    serverHarness,
    descriptorBytes,
    encryptedContent,
    moduleDek,
  );

  const clientHarness = await createSdkBrowserShimHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createProtocolDispatch(serverHarness, contentStore, wallet),
    surface: "direct",
    ...requesterSecrets(),
  });
  t.after(async () => {
    await clientHarness.destroy();
  });

  const grantResponse = await clientHarness.invoke({
    methodId: "client_request_grant",
    inputs: [
      {
        portId: "request",
        fileIdentifier: "$LCH",
        payload: buildGrantRequest({
          requestId: "grant-req-002",
          moduleId: "orbpro.fetch.module",
          moduleVersion: "9.1.0",
          requesterPeerId: "requester.orbpro.test",
          requesterXpub: "xpub-test-requester",
          requesterDomain: "app.orbpro.test",
          providerPeerId: "provider.orbpro.test",
        }),
      },
    ],
  });
  assert.equal(grantResponse.statusCode, 0);

  const decryptResponse = await clientHarness.invoke({
    methodId: "client_fetch_and_decrypt",
    inputs: [
      {
        portId: "grant_response",
        fileIdentifier: "$LGR",
        payload: grantResponse.outputs[0].payload,
      },
    ],
  });

  assert.equal(decryptResponse.statusCode, 0);
  assert.equal(decryptResponse.outputs[0].portId, "plaintext");
  assert.deepEqual(decodeFileContent(decryptResponse.outputs[0].payload), plaintext);
});

// ---------------------------------------------------------------------------
// Account-gated leases. A module whose ALLOWED_XPUBS is ["*"] is granted to any
// signed-in account: the requester re-sends an $EPM signed by its session key,
// naming its account xpub and carrying the account key's own proof
// ("sdn-module-delivery-key/1") for that session key and origin. The grant is
// wrapped to the session's X25519 key. These run the requester side exactly as
// sdn-js does (module-delivery.ts + module-delivery-epm.ts) against the built
// key server, and unwrap through the built client-decrypt module.
// ---------------------------------------------------------------------------

const ACCOUNT_KEY_PATH = "m/44'/0'/0'";
const LEASE_DOMAIN = "app.orbpro.test";
const LEASE_ORIGIN = `https://${LEASE_DOMAIN}`;
const LEASE_PROVIDER = "provider.orbpro.test";
const LEASE_TIMEOUT_MS = 30_000;
const KEY_SERVER_UNAUTHORIZED = 15; // key_server.cpp kServerUnauthorized
const EPM_MAX_AGE_SECONDS = 300; // key_server.cpp kEpmMaxAgeSeconds

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

// A fresh random wallet account: BIP-32 m/44'/0'/0' from a random seed.
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

// The signed-in session: an Ed25519 key that answers challenges and an X25519
// key the grant is wrapped to.
async function createSession(wallet) {
  const seed = randomBytes(32);
  return {
    seed,
    signingPublicKey: new Uint8Array(wallet.curves.ed25519.publicKeyFromSeed(seed)),
    encryption: await generateX25519Keypair(),
  };
}

// What the wallet signs at sign-in (hd-wallet signModuleDeliveryKey): the
// account key authorises the session key for an origin until an expiry. The
// console signs for its 24-hour session (SpaceAware-UI SESSION_KEY_PROOF_SECONDS).
const CONSOLE_PROOF_SECONDS = 24 * 3600;
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

// sdn-js buildModuleDeliveryRequesterEpm: the requester $EPM, signed by
// `signerSeed` (the session key unless a test substitutes another).
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

// The module-delivery stream carries $LCH requests and $LPF proofs; each has its own typed port, and the answer
// comes back on "challenge" ($LCH) or "grant" ($LGR).
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

// The requester's two round trips (challenge, then proof), as sdn-js runs them.
// Returns { challengeError } when the challenge is refused, else
// { statusCode, grantBytes } from the proof step.
// The requester's first round trip: the challenge request. Returns
// { challengeError } when it is refused, else what the proof step needs.
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

// The second round trip: the session key's answer to the challenge.
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

// Both round trips, as sdn-js runs them.
function requestLease(serverHarness, wallet, request) {
  const opened = openLease(serverHarness, request);
  return opened.challengeError !== undefined ? opened : proveLease(serverHarness, wallet, opened, request.nowMs);
}

// A signed-in account: fresh wallet account, session, the account's proof for
// that session, and the EPM the session re-sends.
async function signIn(wallet, epmOptions = {}, proofOptions = {}) {
  const account = createWalletAccount(wallet);
  const session = await createSession(wallet);
  const proof = signModuleDeliveryKey(account, session, proofOptions);
  const epm = buildRequesterEpm(wallet, { signerSeed: session.seed, proof, ...epmOptions });
  return { account, session, proof, epm };
}

async function startLeaseServer(t, { clock = Date.now } = {}) {
  const contentStore = new Map();
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore, runtimeConfig.keySlots, wallet, clock),
  });
  t.after(() => {
    serverHarness.destroy();
  });
  configureServerSync(serverHarness, runtimeConfig);
  return { serverHarness, wallet };
}

function publishLeaseModule(serverHarness, { moduleId, allowedXpubs, plaintext }) {
  const contentKey = randomBytes(32);
  const encryptedBundle = encryptProtectedContent(plaintext, contentKey);
  publishModuleSync(
    serverHarness,
    buildModuleDescriptor({ moduleId, version: "1.0.0", allowedXpubs }),
    encryptedBundle,
    contentKey,
  );
  return { moduleId, moduleVersion: "1.0.0", encryptedBundle };
}

async function decryptLease(t, grantBytes, privateKey, encryptedBundle) {
  const clientDecrypt = await createSdkBrowserShimHarness({
    wasmSource: fileURLToPath(CLIENT_DECRYPT_WASM_PATH),
    dispatch: () => {
      throw new Error("client-decrypt needs no host call when the bundle is supplied");
    },
    surface: "direct",
  });
  t.after(async () => {
    await clientDecrypt.destroy();
  });
  return clientDecrypt.invoke({
    methodId: "decrypt_artifact",
    inputs: [{ payload: grantBytes }, { payload: privateKey }, { payload: encryptedBundle }],
  });
}

test('allowed_xpubs ["*"] leases the module to a fresh wallet account, encrypted to its session key', async (t) => {
  const { serverHarness, wallet } = await startLeaseServer(t);
  const plaintext = textEncoder.encode("module leased to any signed-in account");
  const module = publishLeaseModule(serverHarness, {
    moduleId: "orbpro.lease.any-account",
    allowedXpubs: ["*"],
    plaintext,
  });
  const { account, session, epm } = await signIn(wallet);

  const result = requestLease(serverHarness, wallet, {
    ...module,
    requesterXpub: account.xpub,
    session,
    epm,
  });
  assert.equal(result.challengeError, undefined);
  assert.equal(result.statusCode, 0);
  const grant = decodeGrantResponse(result.grantBytes);
  assert.equal(grant.MESSAGE_TYPE(), licensingGrantMessageType.Granted);
  assert.equal(grant.REQUESTER_XPUB(), account.xpub);
  assert.equal(grant.GRANTED_DOMAIN(), LEASE_DOMAIN);

  // The session's own X25519 key unwraps the content key and opens the module.
  const opened = await decryptLease(
    t,
    result.grantBytes,
    session.encryption.privateKey,
    module.encryptedBundle,
  );
  assert.equal(opened.statusCode, 0);
  assert.deepEqual(opened.outputs[0].payload, plaintext);

  // Any other key cannot: the lease is encrypted for this session only.
  const other = await generateX25519Keypair();
  const refused = await decryptLease(t, result.grantBytes, other.privateKey, module.encryptedBundle);
  assert.notEqual(refused.statusCode, 0);
});

test('allowed_xpubs ["*"] still refuses a request that does not prove an account', async (t) => {
  const { serverHarness, wallet } = await startLeaseServer(t);
  const module = publishLeaseModule(serverHarness, {
    moduleId: "orbpro.lease.any-account.refusals",
    allowedXpubs: ["*"],
    plaintext: textEncoder.encode("never delivered"),
  });

  // No account named at all: refused at the challenge.
  {
    const session = await createSession(wallet);
    const result = requestLease(serverHarness, wallet, { ...module, requesterXpub: "", session });
    assert.equal(result.challengeError, "xpub_not_allowed");
  }
  // An account named but no EPM re-sent.
  {
    const { account, session } = await signIn(wallet);
    const result = requestLease(serverHarness, wallet, {
      ...module,
      requesterXpub: account.xpub,
      session,
    });
    assert.equal(result.statusCode, KEY_SERVER_UNAUTHORIZED);
  }
  // The EPM's Ed25519 signer is not the key that answered the challenge.
  {
    const { account, session, proof } = await signIn(wallet);
    const epm = buildRequesterEpm(wallet, { signerSeed: randomBytes(32), proof });
    const result = requestLease(serverHarness, wallet, {
      ...module,
      requesterXpub: account.xpub,
      session,
      epm,
    });
    assert.equal(result.statusCode, KEY_SERVER_UNAUTHORIZED);
  }
  // The EPM names an account but carries no proof from that account's key.
  {
    const { account, session, epm } = await signIn(wallet, { withAccountProof: false });
    const result = requestLease(serverHarness, wallet, {
      ...module,
      requesterXpub: account.xpub,
      session,
      epm,
    });
    assert.equal(result.statusCode, KEY_SERVER_UNAUTHORIZED);
  }
  // A stale EPM (older than the key server's freshness window).
  {
    const { account, session, epm } = await signIn(wallet, {
      timestampSeconds: Math.floor(Date.now() / 1000) - EPM_MAX_AGE_SECONDS - 60,
    });
    const result = requestLease(serverHarness, wallet, {
      ...module,
      requesterXpub: account.xpub,
      session,
      epm,
    });
    assert.equal(result.statusCode, KEY_SERVER_UNAUTHORIZED);
  }
  // The request claims another account than the one the EPM binds.
  {
    const { session, epm } = await signIn(wallet);
    const claimed = createWalletAccount(wallet);
    const result = requestLease(serverHarness, wallet, {
      ...module,
      requesterXpub: claimed.xpub,
      session,
      epm,
    });
    assert.equal(result.statusCode, KEY_SERVER_UNAUTHORIZED);
  }
});

test("an explicit allowed_xpubs list grants only its accounts; adding \"*\" opens it to any account", async (t) => {
  const { serverHarness, wallet } = await startLeaseServer(t);
  const listed = await signIn(wallet);
  const unlisted = await signIn(wallet);

  const listedOnly = publishLeaseModule(serverHarness, {
    moduleId: "orbpro.lease.listed",
    allowedXpubs: [listed.account.xpub],
    plaintext: textEncoder.encode("listed account only"),
  });
  const granted = requestLease(serverHarness, wallet, {
    ...listedOnly,
    requesterXpub: listed.account.xpub,
    session: listed.session,
    epm: listed.epm,
  });
  assert.equal(granted.statusCode, 0);
  assert.equal(decodeGrantResponse(granted.grantBytes).REQUESTER_XPUB(), listed.account.xpub);
  const refused = requestLease(serverHarness, wallet, {
    ...listedOnly,
    requesterXpub: unlisted.account.xpub,
    session: unlisted.session,
    epm: unlisted.epm,
  });
  assert.equal(refused.challengeError, "xpub_not_allowed");

  const listedOrAny = publishLeaseModule(serverHarness, {
    moduleId: "orbpro.lease.listed-or-any",
    allowedXpubs: [listed.account.xpub, "*"],
    plaintext: textEncoder.encode("any account"),
  });
  const fresh = await signIn(wallet);
  const anyAccount = requestLease(serverHarness, wallet, {
    ...listedOrAny,
    requesterXpub: fresh.account.xpub,
    session: fresh.session,
    epm: fresh.epm,
  });
  assert.equal(anyAccount.statusCode, 0);
  assert.equal(decodeGrantResponse(anyAccount.grantBytes).REQUESTER_XPUB(), fresh.account.xpub);
});

// ---------------------------------------------------------------------------
// Per-account grant quotas (src/cpp/include/grant_quota.h). A lease goes to
// any account that proves its key, so a script holding one account could ask
// without end. The key server counts the grants of each PROVEN account, per
// module and overall, in a rolling hour and per UTC day, and refuses past them
// with an $LGR denial whose DENIAL_REASON is "rate_limited". The host's
// clock.now is the key server's only clock, so these tests set it.
// ---------------------------------------------------------------------------

const GRANTS_PER_MODULE_PER_HOUR = 30; // grant_quota.h kGrantsPerModulePerHour
const GRANTS_PER_MODULE_PER_UTC_DAY = 300; // kGrantsPerModulePerUtcDay
const GRANTS_PER_ACCOUNT_PER_HOUR = 500; // kGrantsPerAccountPerHour
const GRANTS_PER_ACCOUNT_PER_UTC_DAY = 3000; // kGrantsPerAccountPerUtcDay
const RATE_LIMITED = "rate_limited"; // kGrantRateLimitedReason
const PROOF_SKEW_SECONDS = 5 * 60; // epm_key_proof.cpp kMaxValiditySeconds - 24 h
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function hostClock(startMs) {
  const clock = () => clock.ms;
  clock.ms = startMs;
  return clock;
}

// A session of `account` (a new account unless given) whose proof the wallet
// signs now, as the console does at sign-in.
async function signInAt(wallet, clock, { account = createWalletAccount(wallet), lifetimeSeconds } = {}) {
  const session = await createSession(wallet);
  const proof = signModuleDeliveryKey(account, session, { signedAtMs: clock.ms, lifetimeSeconds });
  return { account, session, proof };
}

// One grant request at the clock's time, with the EPM sdn-js signs per request.
function leaseAt(serverHarness, wallet, clock, user, module, { requesterPeerId } = {}) {
  const epm = buildRequesterEpm(wallet, {
    signerSeed: user.session.seed,
    proof: user.proof,
    timestampSeconds: Math.floor(clock.ms / 1000),
  });
  return requestLease(serverHarness, wallet, {
    ...module,
    requesterXpub: user.account.xpub,
    session: user.session,
    epm,
    requesterPeerId,
    nowMs: clock.ms,
  });
}

// The challenge half of leaseAt, for a handshake the test finishes later.
function openLeaseAt(serverHarness, wallet, clock, user, module) {
  const epm = buildRequesterEpm(wallet, {
    signerSeed: user.session.seed,
    proof: user.proof,
    timestampSeconds: Math.floor(clock.ms / 1000),
  });
  return openLease(serverHarness, {
    ...module,
    requesterXpub: user.account.xpub,
    session: user.session,
    epm,
    nowMs: clock.ms,
  });
}

// "granted", the denial reason, or how the request failed before a grant.
function outcome(result) {
  if (result.challengeError !== undefined) return `challenge:${result.challengeError}`;
  if (result.statusCode !== 0) return `status:${result.statusCode}`;
  const grant = decodeGrantResponse(result.grantBytes);
  return grant.MESSAGE_TYPE() === licensingGrantMessageType.Granted ? "granted" : grant.DENIAL_REASON();
}

function publishQuotaModules(serverHarness, count, prefix) {
  return Array.from({ length: count }, (_, i) =>
    publishLeaseModule(serverHarness, {
      moduleId: `${prefix}.${String(i).padStart(2, "0")}`,
      allowedXpubs: ["*"],
      plaintext: textEncoder.encode(`${prefix} ${i}`),
    }),
  );
}

test("an account past its hourly burst for one module is refused rate_limited, and other accounts are not", async (t) => {
  const clock = hostClock(Date.UTC(2026, 9, 12, 9, 0, 0));
  const { serverHarness, wallet } = await startLeaseServer(t, { clock });
  const [module] = publishQuotaModules(serverHarness, 1, "orbpro.quota.burst");
  const user = await signInAt(wallet, clock);

  for (let i = 1; i < GRANTS_PER_MODULE_PER_HOUR; i += 1) {
    assert.equal(outcome(leaseAt(serverHarness, wallet, clock, user, module)), "granted", `grant ${i}`);
  }
  // Requests that name the account without proving it spend none of its quota.
  const impostor = await signInAt(wallet, clock);
  for (let i = 0; i < 3; i += 1) {
    const result = leaseAt(serverHarness, wallet, clock, { ...impostor, account: user.account }, module);
    assert.equal(result.statusCode, KEY_SERVER_UNAUTHORIZED);
  }
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, user, module)), "granted");

  // One more is refused with an $LGR denial carrying the stable reason, which
  // the requester's SDK raises as the error the console shows.
  const refused = leaseAt(serverHarness, wallet, clock, user, module);
  assert.equal(refused.statusCode, 0);
  const denial = decodeGrantResponse(refused.grantBytes);
  assert.equal(denial.MESSAGE_TYPE(), licensingGrantMessageType.Denied);
  assert.equal(denial.GRANT_STATUS(), "denied");
  assert.equal(denial.DENIAL_REASON(), RATE_LIMITED);
  assert.equal(denial.MODULE_ID(), module.moduleId);
  assert.equal(denial.REQUESTER_XPUB(), user.account.xpub);
  assert.equal(denial.wrappedContentKeyPayloadLength(), 0);
  assert.throws(() => validateLicensingGrant(decodeLicensingGrant(refused.grantBytes)), {
    message: RATE_LIMITED,
  });

  // The count follows the proven account: a new session under another peer id
  // is refused the same way.
  const resignedIn = await signInAt(wallet, clock, { account: user.account });
  assert.equal(
    outcome(leaseAt(serverHarness, wallet, clock, resignedIn, module, { requesterPeerId: "another.peer.test" })),
    RATE_LIMITED,
  );
  // Another account is granted the same module.
  const other = await signInAt(wallet, clock);
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, other, module)), "granted");
  // The window rolls: an hour on, the account is granted again.
  clock.ms += HOUR_MS;
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, user, module)), "granted");
});

test("an account past its hourly burst across modules is refused rate_limited on a module it never asked for", async (t) => {
  const clock = hostClock(Date.UTC(2026, 9, 12, 9, 0, 0));
  const { serverHarness, wallet } = await startLeaseServer(t, { clock });
  const modules = publishQuotaModules(
    serverHarness,
    Math.ceil(GRANTS_PER_ACCOUNT_PER_HOUR / GRANTS_PER_MODULE_PER_HOUR) + 1,
    "orbpro.quota.account-hour",
  );
  const user = await signInAt(wallet, clock);

  let granted = 0;
  for (const module of modules.slice(0, -1)) {
    for (let i = 0; i < GRANTS_PER_MODULE_PER_HOUR && granted < GRANTS_PER_ACCOUNT_PER_HOUR; i += 1) {
      assert.equal(outcome(leaseAt(serverHarness, wallet, clock, user, module)), "granted");
      granted += 1;
    }
  }
  assert.equal(granted, GRANTS_PER_ACCOUNT_PER_HOUR);
  const untouched = modules.at(-1);
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, user, untouched)), RATE_LIMITED);
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, await signInAt(wallet, clock), untouched)), "granted");
});

test("daily caps hold after the hourly window clears and reset at the next UTC day", async (t) => {
  const dayStart = Date.UTC(2026, 9, 12, 0, 1, 0);
  const clock = hostClock(dayStart);
  const { serverHarness, wallet } = await startLeaseServer(t, { clock });
  const [module] = publishQuotaModules(serverHarness, 1, "orbpro.quota.module-day");
  const modules = publishQuotaModules(
    serverHarness,
    Math.ceil(GRANTS_PER_ACCOUNT_PER_HOUR / GRANTS_PER_MODULE_PER_HOUR),
    "orbpro.quota.account-day",
  );
  const user = await signInAt(wallet, clock);
  const busy = await signInAt(wallet, clock);

  // One module, one account: a full hourly burst every hour up to the daily cap.
  const hours = GRANTS_PER_MODULE_PER_UTC_DAY / GRANTS_PER_MODULE_PER_HOUR;
  for (let hour = 0; hour < hours; hour += 1) {
    clock.ms = dayStart + hour * HOUR_MS;
    for (let i = 0; i < GRANTS_PER_MODULE_PER_HOUR; i += 1) {
      assert.equal(outcome(leaseAt(serverHarness, wallet, clock, user, module)), "granted");
    }
  }
  clock.ms = dayStart + hours * HOUR_MS;
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, user, module)), RATE_LIMITED);

  // All modules, one account: a full account burst every hour up to the daily cap.
  const accountHours = GRANTS_PER_ACCOUNT_PER_UTC_DAY / GRANTS_PER_ACCOUNT_PER_HOUR;
  for (let hour = 0; hour < accountHours; hour += 1) {
    clock.ms = dayStart + hour * HOUR_MS;
    let granted = 0;
    for (const each of modules) {
      for (let i = 0; i < GRANTS_PER_MODULE_PER_HOUR && granted < GRANTS_PER_ACCOUNT_PER_HOUR; i += 1) {
        assert.equal(outcome(leaseAt(serverHarness, wallet, clock, busy, each)), "granted");
        granted += 1;
      }
    }
  }
  clock.ms = dayStart + accountHours * HOUR_MS;
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, busy, modules[0])), RATE_LIMITED);

  // The next UTC day both are granted again (signed in again: the console's
  // lease lasts a day).
  clock.ms = Date.UTC(2026, 9, 13, 0, 1, 0);
  const nextDay = await signInAt(wallet, clock, { account: user.account });
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, nextDay, module)), "granted");
  const busyNextDay = await signInAt(wallet, clock, { account: busy.account });
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, busyNextDay, modules[0])), "granted");
});

test("a lease proof that outlives the console's 24-hour session is refused", async (t) => {
  const clock = hostClock(Date.UTC(2026, 9, 12, 9, 0, 0));
  const { serverHarness, wallet } = await startLeaseServer(t, { clock });
  const [module] = publishQuotaModules(serverHarness, 1, "orbpro.quota.proof-lifetime");
  const leaseFor = async (lifetimeSeconds) =>
    leaseAt(serverHarness, wallet, clock, await signInAt(wallet, clock, { lifetimeSeconds }), module);

  assert.equal(outcome(await leaseFor(CONSOLE_PROOF_SECONDS)), "granted");
  assert.equal(outcome(await leaseFor(CONSOLE_PROOF_SECONDS + PROOF_SKEW_SECONDS)), "granted");
  assert.equal((await leaseFor(CONSOLE_PROOF_SECONDS + PROOF_SKEW_SECONDS + 1)).statusCode, KEY_SERVER_UNAUTHORIZED);
  assert.equal((await leaseFor(31 * 24 * 3600)).statusCode, KEY_SERVER_UNAUTHORIZED);
});

test("an honest console session, 25 modules when it opens and again on each reload, is granted every one", async (t) => {
  const opened = Date.UTC(2026, 9, 12, 9, 0, 0);
  const clock = hostClock(opened);
  const { serverHarness, wallet } = await startLeaseServer(t, { clock });
  const modules = publishQuotaModules(serverHarness, 25, "orbpro.quota.console");
  const user = await signInAt(wallet, clock);

  for (let load = 0; load < 4; load += 1) {
    clock.ms = opened + load * 5 * MINUTE_MS;
    for (const module of modules) {
      assert.equal(outcome(leaseAt(serverHarness, wallet, clock, user, module)), "granted", `${module.moduleId} load ${load}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Unanswered grant handshakes (key_server.cpp kMaxPendingGrants). Anyone can ask
// for a challenge without proving anything, and the key server keeps each one,
// with its re-sent $EPM, until the proof arrives. They expire with the
// challenge, and past the cap a NEW request is refused, never a live handshake.
// ---------------------------------------------------------------------------

const MAX_PENDING_GRANTS = 512; // key_server.cpp kMaxPendingGrants
const PROVIDER_BUSY = "provider_busy"; // kProviderBusyReason
const CHALLENGE_TTL_MS = makeRuntimeConfig().challengeTtlMs;

test("a flood of unanswered grant requests stays bounded, strands no live handshake, and a later grant succeeds", async (t) => {
  const clock = hostClock(Date.UTC(2026, 9, 12, 9, 0, 0));
  const { serverHarness, wallet } = await startLeaseServer(t, { clock });
  const [module] = publishQuotaModules(serverHarness, 1, "orbpro.pending.flood");

  // A requester whose challenge is out when the flood starts.
  const honest = await signInAt(wallet, clock);
  const inFlight = openLeaseAt(serverHarness, wallet, clock, honest, module);
  assert.equal(inFlight.challengeError, undefined);

  // Requests that never send a proof, each carrying a 12 KiB $EPM blob (the node
  // admits requests up to 16 KiB). Kept without a bound, ten rounds of them
  // (about 70 MiB) would exhaust the module's fixed 32 MiB.
  const flooder = await createSession(wallet);
  const blob = randomBytes(12 * 1024);
  const floodRound = () => {
    const outcomes = new Map();
    for (let i = 0; i < MAX_PENDING_GRANTS + 64; i += 1) {
      const opened = openLease(serverHarness, {
        ...module,
        requesterXpub: "xpub-flood",
        session: flooder,
        epm: blob,
        nowMs: clock.ms,
      });
      const outcome = opened.challengeError ?? "challenge";
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    }
    return Object.fromEntries(outcomes);
  };
  // The live handshake holds its place: the new requests past the cap are refused.
  assert.deepEqual(floodRound(), { challenge: MAX_PENDING_GRANTS - 1, [PROVIDER_BUSY]: 65 });
  assert.equal(outcome(proveLease(serverHarness, wallet, inFlight, clock.ms)), "granted");

  // Unanswered handshakes expire with their challenge, so each round finds room.
  for (let round = 0; round < 10; round += 1) {
    clock.ms += CHALLENGE_TTL_MS;
    assert.deepEqual(floodRound(), { challenge: MAX_PENDING_GRANTS, [PROVIDER_BUSY]: 64 }, `round ${round}`);
  }
  clock.ms += CHALLENGE_TTL_MS;
  assert.equal(outcome(leaseAt(serverHarness, wallet, clock, await signInAt(wallet, clock), module)), "granted");
});

// ---------------------------------------------------------------------------
// Typed contracts 1.0: the wire itself.
// ---------------------------------------------------------------------------

test("every hostcall is an SDS $PIV invocation, and keys reach the module only through secrets.get", async (t) => {
  const contentStore = new Map();
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore, runtimeConfig.keySlots, wallet),
  });
  t.after(() => serverHarness.destroy());
  configureServerSync(serverHarness, runtimeConfig);

  const moduleDek = randomBytes(32);
  const plaintext = textEncoder.encode("typed hostcalls end to end");
  publishModuleSync(
    serverHarness,
    buildModuleDescriptor({ moduleId: "orbpro.typed.module", version: "1.0.0" }),
    encryptProtectedContent(plaintext, moduleDek),
    moduleDek,
  );
  const clientHarness = await createSdkBrowserShimHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createProtocolDispatch(serverHarness, contentStore, wallet),
    surface: "direct",
    ...requesterSecrets(),
  });
  t.after(async () => clientHarness.destroy());

  const grantResponse = await clientHarness.invoke({
    methodId: "client_request_grant",
    inputs: [{
      portId: "request",
      fileIdentifier: "$LCH",
      payload: buildGrantRequest({
        requestId: "grant-req-typed",
        moduleId: "orbpro.typed.module",
        moduleVersion: "1.0.0",
        requesterPeerId: "requester.orbpro.test",
        requesterXpub: "xpub-test-requester",
        requesterDomain: "app.orbpro.test",
      }),
    }],
  });
  assert.equal(grantResponse.statusCode, 0, grantResponse.errorMessage);
  const decrypted = await clientHarness.invoke({
    methodId: "client_fetch_and_decrypt",
    inputs: [{ portId: "grant_response", fileIdentifier: "$LGR", payload: grantResponse.outputs[0].payload }],
  });
  assert.equal(decrypted.statusCode, 0, decrypted.errorMessage);
  assert.deepEqual(decodeFileContent(decrypted.outputs[0].payload), plaintext);

  const serverCalls = serverHarness.hostcalls;
  const clientCalls = clientHarness.hostcalls;
  assert.ok(serverCalls.length > 0 && clientCalls.length > 0);
  assert.ok([...serverCalls, ...clientCalls].every((call) => call.typed), "no JSON-envelope hostcall");
  const ops = (calls) => new Set(calls.map((call) => call.op));
  for (const op of ["plugin.getConfig", "secrets.get", "ipfs.add", "clock.now", "random.bytes", "keyslot.sign", "crypto.ed25519.verify"]) {
    assert.ok(ops(serverCalls).has(op), `server calls ${op}`);
  }
  for (const op of ["plugin.getConfig", "secrets.get", "protocol.request", "crypto.ed25519.sign", "ipfs.cat"]) {
    assert.ok(ops(clientCalls).has(op), `client calls ${op}`);
  }
  // The secrets asked for are exactly the IDs the configs name.
  assert.deepEqual(
    serverCalls.filter((call) => call.op === "secrets.get").map((call) => call.params.ID),
    ["licensing/content/orbpro.typed.module:1.0.0"],
  );
  assert.deepEqual(
    [...new Set(clientCalls.filter((call) => call.op === "secrets.get").map((call) => call.params.ID))],
    [REQUESTER_SIGNING_SECRET_ID],
  );
  // The provider's key stays host-side: keyslot.sign names the slot, never the key.
  const keyslotCall = serverCalls.find((call) => call.op === "keyslot.sign");
  assert.equal(keyslotCall.params.SLOT_ID, runtimeConfig.signingSlotId);
  assert.deepEqual(keyslotCall.raw, ["payload"]);
});

test("server_publish_module refuses a descriptor whose KEY_ID the config maps to no 32-byte secret", async (t) => {
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(new Map(), runtimeConfig.keySlots, wallet),
  });
  t.after(() => serverHarness.destroy());
  configureServerSync(serverHarness, runtimeConfig);

  const publish = () => serverHarness.invokeSync({
    methodId: "server_publish_module",
    inputs: [
      { portId: "module_descriptor", fileIdentifier: "$PLG", payload: buildModuleDescriptor({ moduleId: "orbpro.nokey", version: "1.0.0" }) },
      { portId: "protected_content", fileIdentifier: "$FIL", payload: encodeFile(textEncoder.encode("ciphertext")) },
    ],
  });
  let response = publish();
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "invalid-content-key");
  assert.equal(response.outputs.length, 0);

  serverHarness.config.content_keys = [{ key_id: "orbpro.nokey:1.0.0", secret_id: "short", algorithm: "aes-256-gcm" }];
  serverHarness.secrets.set("short", randomBytes(16));
  response = publish();
  assert.equal(response.errorCode, "invalid-content-key");

  serverHarness.secrets.set("short", randomBytes(32));
  response = publish();
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs[0].portId, "response");
});

test("typed ports refuse a record on the wrong port and a frame without its type", async (t) => {
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(new Map(), runtimeConfig.keySlots, wallet),
  });
  t.after(() => serverHarness.destroy());
  configureServerSync(serverHarness, runtimeConfig);
  const request = buildGrantRequest({
    requestId: "typed-port",
    moduleId: "orbpro.any",
    moduleVersion: "1.0.0",
    requesterPeerId: "requester.orbpro.test",
    requesterXpub: "xpub",
    requesterDomain: "app.orbpro.test",
  });

  const wrongPort = serverHarness.invokeSync({
    methodId: "server_handle_message",
    inputs: [{ portId: "proof", fileIdentifier: "$LCH", payload: request }],
  });
  assert.notEqual(wrongPort.statusCode, 0);
  assert.equal(wrongPort.outputs.length, 0);

  const untyped = serverHarness.invokeSync({
    methodId: "server_handle_message",
    inputs: [{ portId: "request", payload: request }],
  });
  assert.notEqual(untyped.statusCode, 0);
  assert.equal(untyped.outputs.length, 0);

  const both = serverHarness.invokeSync({
    methodId: "server_handle_message",
    inputs: [{ portId: "request", fileIdentifier: "$LCH", payload: request }, { portId: "proof", fileIdentifier: "$LPF", payload: request }],
  });
  assert.notEqual(both.statusCode, 0);
});

// decrypt_and_verify's input is AES-256-GCM(iv | ciphertext | tag) of content | Ed25519 signature | u32le length.
function signAndEncrypt(wallet, content, seed, dek) {
  const signature = wallet.curves.ed25519.sign(content, seed);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(content.length);
  return encryptProtectedContent(Buffer.concat([Buffer.from(content), Buffer.from(signature), length]), dek);
}

test("decrypt_and_verify decrypts with the DEK from secrets.get and verifies the signer", async (t) => {
  const wallet = await getWasmWallet();
  const dek = randomBytes(32);
  const signerSeed = randomBytes(32);
  const signerPublic = wallet.curves.ed25519.publicKeyFromSeed(signerSeed);
  const harness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createDefaultHostDispatch(wallet),
    config: { dek_secret_id: "licensing/dek" },
    secrets: new Map([["licensing/dek", dek]]),
  });
  t.after(() => harness.destroy());
  const content = textEncoder.encode("signed module bytes");
  const signerKey = (publicKey) => buildKeyMaterialFrame({
    keyId: "module-signer",
    role: keyMaterialRole.VerificationKey,
    algorithm: keyMaterialAlgorithm.Ed25519Public,
    encoding: keyMaterialEncoding.PublicKey32,
    keyBytes: publicKey,
  });
  const run = (protectedContent, publicKey) => harness.invokeSync({
    methodId: "decrypt_and_verify",
    inputs: [
      { portId: "protected_content", fileIdentifier: "$FIL", payload: encodeFile(protectedContent) },
      { portId: "signer_key", fileIdentifier: "$KMF", payload: signerKey(publicKey) },
    ],
  });

  const ok = run(signAndEncrypt(wallet, content, signerSeed, dek), signerPublic);
  assert.equal(ok.statusCode, 0, ok.errorMessage);
  assert.equal(ok.outputs[0].portId, "plaintext");
  assert.deepEqual(decodeFileContent(ok.outputs[0].payload), content);
  assert.ok(harness.hostcalls.every((call) => call.typed));
  assert.deepEqual(harness.hostcalls.filter((call) => call.op === "secrets.get").map((call) => call.params.ID), ["licensing/dek"]);

  const otherSigner = wallet.curves.ed25519.publicKeyFromSeed(randomBytes(32));
  const forged = run(signAndEncrypt(wallet, content, signerSeed, dek), otherSigner);
  assert.notEqual(forged.statusCode, 0);
  assert.equal(forged.outputs.length, 0);

  const wrongDek = run(signAndEncrypt(wallet, content, signerSeed, randomBytes(32)), signerPublic);
  assert.notEqual(wrongDek.statusCode, 0);
});
