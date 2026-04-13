import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";

import {
  createSdkBrowserShimHarness,
  createSdkBrowserShimSyncHarness,
} from "../../../tests/lib/sdkBrowserShimHarness.mjs";
import { getWasmWallet } from "../../../../space-data-module-sdk/src/utils/wasmCrypto.js";
import { PLG } from "../../../../spacedatastandards.org/lib/js/PLG/PLG.js";
import { pluginType } from "../../../../spacedatastandards.org/lib/js/PLG/pluginType.js";
import { KMF } from "../../../../spacedatastandards.org/lib/js/REC/KMF.js";
import { keyMaterialAlgorithm } from "../../../../spacedatastandards.org/lib/js/REC/keyMaterialAlgorithm.js";
import { keyMaterialEncoding } from "../../../../spacedatastandards.org/lib/js/REC/keyMaterialEncoding.js";
import { keyMaterialRole } from "../../../../spacedatastandards.org/lib/js/REC/keyMaterialRole.js";
import { KRF } from "../../../../spacedatastandards.org/lib/js/REC/KRF.js";
import { keyReferenceAlgorithm } from "../../../../spacedatastandards.org/lib/js/REC/keyReferenceAlgorithm.js";
import { keyReferenceRole } from "../../../../spacedatastandards.org/lib/js/REC/keyReferenceRole.js";
import { LCH } from "../../../../spacedatastandards.org/lib/js/REC/LCH.js";
import { LCF } from "../../../../spacedatastandards.org/lib/js/REC/LCF.js";
import { licensingChallengeMessageType } from "../../../../spacedatastandards.org/lib/js/REC/licensingChallengeMessageType.js";
import { licensingChallengeRole } from "../../../../spacedatastandards.org/lib/js/REC/licensingChallengeRole.js";
import { licensingConfigMessageType } from "../../../../spacedatastandards.org/lib/js/REC/licensingConfigMessageType.js";
import { licensingConfigRole } from "../../../../spacedatastandards.org/lib/js/REC/licensingConfigRole.js";
import { LGR } from "../../../../spacedatastandards.org/lib/js/REC/LGR.js";
import { licensingGrantMessageType } from "../../../../spacedatastandards.org/lib/js/REC/licensingGrantMessageType.js";
import { KeyExchange } from "../../../../spacedatastandards.org/lib/js/REC/KeyExchange.js";
import { SymmetricAlgo } from "../../../../spacedatastandards.org/lib/js/REC/SymmetricAlgo.js";
import { KDF } from "../../../../spacedatastandards.org/lib/js/REC/KDF.js";

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

function decodeBase64Param(params, field) {
  if (typeof params?.[field] !== "string") {
    throw new Error(`Missing base64 field: ${field}`);
  }
  return new Uint8Array(Buffer.from(params[field], "base64"));
}

function handleEd25519HostOperation(wallet, operation, params) {
  if (!wallet) {
    throw new Error(`Wallet not initialized for operation: ${operation}`);
  }
  if (operation === "crypto.ed25519.publicKeyFromSeed") {
    return new Uint8Array(
      wallet.curves.ed25519.publicKeyFromSeed(decodeBase64Param(params, "seed")),
    );
  }
  if (operation === "crypto.ed25519.sign") {
    return new Uint8Array(
      wallet.curves.ed25519.sign(
        decodeBase64Param(params, "message"),
        decodeBase64Param(params, "seed"),
      ),
    );
  }
  if (operation === "crypto.ed25519.verify") {
    return wallet.curves.ed25519.verify(
      decodeBase64Param(params, "message"),
      decodeBase64Param(params, "signature"),
      decodeBase64Param(params, "publicKey"),
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
    if (operation === "keyslot.get") {
      const slotId = String(params?.slotId ?? "");
      const keyBytes = keySlots.get(slotId);
      if (!keyBytes) {
        throw new Error(`keyslot.get missing slot: ${slotId}`);
      }
      return new Uint8Array(keyBytes);
    }
    if (operation === "ipfs.add") {
      const raw =
        typeof params?.base64 === "string"
          ? Buffer.from(params.base64, "base64")
          : typeof params?.data === "string"
            ? Buffer.from(params.data, "base64")
            : null;
      if (!raw) {
        throw new Error("ipfs.add requires base64 payload");
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

    const payload = params?.payloadBase64
      ? Buffer.from(params.payloadBase64, "base64")
      : new Uint8Array();

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
  requesterSigningPubkey,
  requesterEphemeralPubkey,
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
  const requesterSigningPubkeyOffset = requesterSigningPubkey
    ? LCH.createRequesterSigningPubkeyVector(builder, requesterSigningPubkey)
    : 0;
  const requesterEphemeralPubkeyOffset = requesterEphemeralPubkey
    ? LCH.createRequesterEphemeralPubkeyVector(builder, requesterEphemeralPubkey)
    : 0;
  const root = LCH.createLCH(
    builder,
    licensingChallengeMessageType.Request,
    licensingChallengeRole.Requester,
    requestIdOffset,
    moduleIdOffset,
    moduleVersionOffset,
    requesterPeerIdOffset,
    requesterXpubOffset,
    requesterSigningPubkeyOffset,
    requesterEphemeralPubkeyOffset,
    requesterDomainOffset,
    requestedTimeoutMs,
    requestedAtMs,
    0,
    0n,
    providerPeerIdOffset,
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

function decodeChallengeMessage(bytes) {
  const buffer = new flatbuffers.ByteBuffer(bytes);
  return LCH.getRootAsLCH(buffer);
}

function buildModuleDescriptor({
  moduleId,
  version,
  keyId = `${moduleId}:${version}`,
  requiredScope = "orbpro.default",
  allowedDomains = ["app.orbpro.test"],
  maxGrantTimeoutMs = 30_000n,
}) {
  const builder = new flatbuffers.Builder(512);
  const pluginIdOffset = builder.createString(moduleId);
  const nameOffset = builder.createString(moduleId);
  const versionOffset = builder.createString(version);
  const descriptionOffset = builder.createString("Protected module fixture");
  const requiredScopeOffset = builder.createString(requiredScope);
  const keyIdOffset = builder.createString(keyId);
  const allowedDomainOffsets = allowedDomains.map((domain) => builder.createString(domain));
  const allowedDomainsOffset = PLG.createAllowedDomainsVector(builder, allowedDomainOffsets);

  const root = PLG.createPLG(
    builder,
    pluginIdOffset,
    nameOffset,
    versionOffset,
    descriptionOffset,
    pluginType.Analysis,
    1,
    0,
    0n,
    0,
    0,
    0n,
    0,
    0,
    0,
    0,
    0,
    0,
    true,
    requiredScopeOffset,
    keyIdOffset,
    allowedDomainsOffset,
    maxGrantTimeoutMs,
    0,
    BigInt(Date.now()),
    BigInt(Date.now()),
    0,
    0,
    0,
    0,
  );
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

function publishModuleSync(serverHarness, descriptorBytes, protectedContent, contentKey) {
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
          role: keyMaterialRole.PublicationContent,
          algorithm: keyMaterialAlgorithm.Aes256Gcm,
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

test("server_handle_message rejects challenge requests for disallowed domains", async (t) => {
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(new Map(), runtimeConfig.keySlots, wallet),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  configureServerSync(serverHarness, runtimeConfig);
  publishModuleSync(
    serverHarness,
    buildModuleDescriptor({
      moduleId: "orbpro.policy.module",
      version: "1.0.0",
      allowedDomains: ["app.orbpro.test"],
    }),
    textEncoder.encode("encrypted bundle"),
    randomBytes(32),
  );

  const response = serverHarness.invokeSync({
    methodId: "server_handle_message",
    inputs: [
      {
        portId: "request",
        fileIdentifier: "$LCH",
        payload: buildGrantRequest({
          requestId: "grant-req-domain-denied",
          moduleId: "orbpro.policy.module",
          moduleVersion: "1.0.0",
          requesterPeerId: "requester.orbpro.test",
          requesterXpub: "xpub-test-requester",
          requesterDomain: "evil.orbpro.test",
          requesterSigningPubkey: new Uint8Array(32).fill(6),
          requesterEphemeralPubkey: new Uint8Array(32).fill(8),
          providerPeerId: "provider.orbpro.test",
        }),
      },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  const challenge = decodeChallengeMessage(response.outputs[0].payload);
  assert.equal(challenge.MESSAGE_TYPE(), licensingChallengeMessageType.Error);
  assert.equal(challenge.ERROR_CODE(), "domain_not_allowed");
});

test("server_handle_message rejects challenge requests that exceed timeout policy", async (t) => {
  const runtimeConfig = makeRuntimeConfig();
  const wallet = await getWasmWallet();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(new Map(), runtimeConfig.keySlots, wallet),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  configureServerSync(serverHarness, runtimeConfig);
  publishModuleSync(
    serverHarness,
    buildModuleDescriptor({
      moduleId: "orbpro.policy.module",
      version: "1.0.0",
      maxGrantTimeoutMs: 30_000n,
    }),
    textEncoder.encode("encrypted bundle"),
    randomBytes(32),
  );

  const response = serverHarness.invokeSync({
    methodId: "server_handle_message",
    inputs: [
      {
        portId: "request",
        fileIdentifier: "$LCH",
        payload: buildGrantRequest({
          requestId: "grant-req-timeout-denied",
          moduleId: "orbpro.policy.module",
          moduleVersion: "1.0.0",
          requesterPeerId: "requester.orbpro.test",
          requesterXpub: "xpub-test-requester",
          requesterDomain: "app.orbpro.test",
          requesterSigningPubkey: new Uint8Array(32).fill(6),
          requesterEphemeralPubkey: new Uint8Array(32).fill(8),
          requestedTimeoutMs: 30_001n,
          providerPeerId: "provider.orbpro.test",
        }),
      },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  const challenge = decodeChallengeMessage(response.outputs[0].payload);
  assert.equal(challenge.MESSAGE_TYPE(), licensingChallengeMessageType.Error);
  assert.equal(challenge.ERROR_CODE(), "timeout_exceeds_policy");
});
