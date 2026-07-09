import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";

import {
  createSdkBrowserShimHarness,
  createSdkBrowserShimSyncHarness,
} from "./lib/sdkBrowserShimHarness.mjs";
import {
  decodeLicensingGrant,
  encryptBytesForRecipient,
  generateX25519Keypair,
} from "space-data-module-sdk";
import { getWasmWallet } from "space-data-module-sdk/utils/wasm-crypto";
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

const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

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

function createServerHostDispatch(contentStore, keySlots = new Map(), wallet = null) {
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
    if (operation === "keyslot.sign") {
      // Host-side crypto oracle mock, matching
      // sdn-server/internal/modulert/caps/keyslot.go (handleKeyslotSign):
      // the slot's raw key material never leaves this dispatch function —
      // only the resulting signature, base64-encoded, crosses back to the
      // wasm guest as a plain JSON string field.
      const slotId = String(params?.slotId ?? "");
      const keyBytes = keySlots.get(slotId);
      if (!keyBytes) {
        throw new Error(`keyslot.sign missing slot: ${slotId}`);
      }
      const algorithm = params?.algorithm || "ed25519";
      if (algorithm !== "ed25519") {
        throw new Error(`Unsupported keyslot.sign algorithm: ${algorithm}`);
      }
      const payload =
        params?.payload instanceof Uint8Array
          ? params.payload
          : new Uint8Array();
      const signature = wallet.curves.ed25519.sign(payload, keyBytes);
      return {
        signature: Buffer.from(signature).toString("base64"),
        algorithm: "ed25519",
      };
    }
    if (operation === "ipfs.add") {
      // Copy: hostcall segments are views into wasm guest memory.
      const raw =
        params?.content instanceof Uint8Array
          ? Buffer.from(params.content)
          : null;
      if (!raw) {
        throw new Error("ipfs.add requires content bytes");
      }
      const cid = `bafy-lic-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
      contentStore.set(cid, raw);
      return {
        Hash: cid,
        Size: raw.length,
      };
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
      const response = serverHarness.invokeSync({
        methodId: "server_handle_message",
        inputs: [{ portId: "request", fileIdentifier, payload }],
      });
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

function publishModuleSync(
  serverHarness,
  descriptorBytes,
  protectedContent,
  contentKey,
  {
    role = keyMaterialRole.PublicationContent,
    algorithm = keyMaterialAlgorithm.Aes256Gcm,
  } = {},
) {
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
        payload: protectedContent,
      },
      {
        portId: "content_key",
        fileIdentifier: "$KMF",
        payload: buildKeyMaterialFrame({
          keyId: "publication-content-key",
          role,
          algorithm,
          encoding: keyMaterialEncoding.RawBytes,
          keyBytes: contentKey,
        }),
      },
    ],
  });
  assert.equal(response.statusCode, 0);
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
    {
      role: keyMaterialRole.DecryptKey,
      algorithm: keyMaterialAlgorithm.X25519Private,
    },
  );

  const clientHarness = await createSdkBrowserShimHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createProtocolDispatch(serverHarness, contentStore, wallet),
    surface: "direct",
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
      {
        portId: "requester_signing_key",
        fileIdentifier: "$KMF",
        payload: buildKeyMaterialFrame({
          keyId: "requester-signing-key",
          role: keyMaterialRole.RequesterSigning,
          algorithm: keyMaterialAlgorithm.Ed25519Seed,
          encoding: keyMaterialEncoding.Seed32,
          keyBytes: randomBytes(32),
        }),
      }
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
      {
        portId: "requester_signing_key",
        fileIdentifier: "$KMF",
        payload: buildKeyMaterialFrame({
          keyId: "requester-signing-key",
          role: keyMaterialRole.RequesterSigning,
          algorithm: keyMaterialAlgorithm.Ed25519Seed,
          encoding: keyMaterialEncoding.Seed32,
          keyBytes: randomBytes(32),
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
      {
        portId: "requester_signing_key",
        fileIdentifier: "$KMF",
        payload: buildKeyMaterialFrame({
          keyId: "requester-signing-key",
          role: keyMaterialRole.RequesterSigning,
          algorithm: keyMaterialAlgorithm.Ed25519Seed,
          encoding: keyMaterialEncoding.Seed32,
          keyBytes: randomBytes(32),
        }),
      }
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
      {
        portId: "requester_signing_key",
        fileIdentifier: "$KMF",
        payload: buildKeyMaterialFrame({
          keyId: "requester-signing-key",
          role: keyMaterialRole.RequesterSigning,
          algorithm: keyMaterialAlgorithm.Ed25519Seed,
          encoding: keyMaterialEncoding.Seed32,
          keyBytes: randomBytes(32),
        }),
      }
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
  assert.deepEqual(decryptResponse.outputs[0].payload, plaintext);
});
