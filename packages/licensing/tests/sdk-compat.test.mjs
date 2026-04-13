import assert from "node:assert/strict";
import { createECDH, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";

import {
  createSdkBrowserShimHarness,
  createSdkBrowserShimSyncHarness,
} from "../../../tests/lib/sdkBrowserShimHarness.mjs";
import { PLG } from "../../../../spacedatastandards.org/lib/js/PLG/PLG.js";
import { pluginType } from "../../../../spacedatastandards.org/lib/js/PLG/pluginType.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

function makeRuntimeConfig() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const privateKey = ecdh.getPrivateKey();
  const dek = randomBytes(32);
  return {
    dek,
    json: {
      privateKeyHex: privateKey.toString("hex"),
      dekHex: dek.toString("hex"),
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

function createProtocolDispatch(serverHarness) {
  return (operation, params) => {
    if (operation === "clock.now") {
      return Date.now();
    }
    if (operation === "random.bytes") {
      return randomBytes(params?.length ?? 32);
    }
    if (operation !== "protocol.request") {
      throw new Error(`Unsupported operation: ${operation}`);
    }

    const payload = params?.payloadBase64
      ? Buffer.from(params.payloadBase64, "base64")
      : new Uint8Array();

    if (params?.protocolId === "/orbpro/public-key/1.0.0") {
      const response = serverHarness.invokeSync({
        methodId: "server_get_public_key",
        inputs: [],
      });
      return response.outputs[0].payload;
    }
    if (params?.protocolId === "/orbpro/challenge/1.0.0") {
      const response = serverHarness.invokeSync({
        methodId: "server_issue_challenge",
        inputs: [{ portId: "request", payload }],
      });
      return response.outputs[0].payload;
    }
    if (params?.protocolId === "/orbpro/key-broker/1.0.0") {
      const response = serverHarness.invokeSync({
        methodId: "server_complete_grant",
        inputs: [{ portId: "request", payload }],
      });
      return response.outputs[0].payload;
    }

    throw new Error(`Unsupported protocol: ${params?.protocolId}`);
  };
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
        payload: textEncoder.encode(
          JSON.stringify({
            target: "ipfs://local-test",
            moduleId: "orbpro.test.module",
            moduleVersion: "1.2.3",
            keyVersion: 9,
          }),
        ),
      },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "response");

  const result = JSON.parse(textDecoder.decode(response.outputs[0].payload));
  assert.equal(result.keyVersion, 9);
  assert.deepEqual(Buffer.from(result.dekBase64, "base64"), moduleDek);
  assert.ok(result.expiresAtMs > Date.now());
});
