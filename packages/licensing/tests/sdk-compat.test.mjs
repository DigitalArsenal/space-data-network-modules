import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";

import {
  createSdkBrowserShimHarness,
  createSdkBrowserShimSyncHarness,
} from "../../../tests/lib/sdkBrowserShimHarness.mjs";
import { PLG } from "../../../../spacedatastandards.org/lib/js/PLG/PLG.js";
import { pluginType } from "../../../../spacedatastandards.org/lib/js/PLG/pluginType.js";
import { LCH } from "../../../../spacedatastandards.org/lib/js/REC/LCH.js";
import { licensingChallengeMessageType } from "../../../../spacedatastandards.org/lib/js/REC/licensingChallengeMessageType.js";
import { licensingChallengeRole } from "../../../../spacedatastandards.org/lib/js/REC/licensingChallengeRole.js";
import { LGR } from "../../../../spacedatastandards.org/lib/js/REC/LGR.js";
import { licensingGrantMessageType } from "../../../../spacedatastandards.org/lib/js/REC/licensingGrantMessageType.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MODULE_DELIVERY_PROTOCOL_ID = "/space-data-network/module-delivery/1.0.0";

const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

function makeRuntimeConfig() {
  const signingSeed = randomBytes(32);
  return {
    json: {
      privateKeyHex: randomBytes(32).toString("hex"),
      dekHex: randomBytes(32).toString("hex"),
      providerSigningSeedHex: signingSeed.toString("hex"),
      providerPeerId: "provider.orbpro.test",
      activeKeyVersion: 9,
      expiresAtMs: Date.now() + 60_000,
      challengeTtlMs: 30_000,
      maxClockSkewMs: 5_000,
    },
  };
}

function createDefaultHostDispatch() {
  return (operation, params) => {
    if (operation === "clock.now") {
      return Date.now();
    }
    if (operation === "random.bytes") {
      return randomBytes(params?.length ?? 32);
    }
    throw new Error(`Unsupported operation: ${operation}`);
  };
}

function createServerHostDispatch(contentStore) {
  return (operation, params) => {
    if (operation === "clock.now") {
      return Date.now();
    }
    if (operation === "random.bytes") {
      return randomBytes(params?.length ?? 32);
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

function configureServerSync(harness, config) {
  const response = harness.invokeSync({
    methodId: "server_configure_runtime",
    inputs: [
      {
        portId: "config",
        payload: textEncoder.encode(JSON.stringify(config.json)),
      },
    ],
  });
  assert.equal(response.statusCode, 0);
}

function createProtocolDispatch(serverHarness, contentStore = new Map()) {
  return (operation, params) => {
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
      const response = serverHarness.invokeSync({
        methodId: "server_handle_message",
        inputs: [{ portId: "request", payload }],
      });
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
        payload: contentKey,
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
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  configureServerSync(serverHarness, makeRuntimeConfig());

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
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  const runtimeConfig = makeRuntimeConfig();
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
    dispatch: createProtocolDispatch(serverHarness),
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
        portId: "requester_signing_seed",
        payload: randomBytes(32),
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
  assert.ok(grant.WRAPPED_CONTENT_KEY());
  assert.ok(grant.MODULE_DESCRIPTOR());
});

test("client_fetch_and_decrypt resolves the published CID through ipfs.cat", async (t) => {
  const contentStore = new Map();
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createServerHostDispatch(contentStore),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  configureServerSync(serverHarness, makeRuntimeConfig());

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
    dispatch: createProtocolDispatch(serverHarness, contentStore),
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
        portId: "requester_signing_seed",
        payload: randomBytes(32),
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
