import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createSdkBrowserShimHarness,
  createSdkBrowserShimSyncHarness,
} from "../../../tests/lib/sdkBrowserShimHarness.mjs";

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

test("client and server role entrypoints interoperate inside the unified licensing module", async (t) => {
  const serverHarness = await createSdkBrowserShimSyncHarness({
    wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
    dispatch: createDefaultHostDispatch(),
  });
  t.after(() => {
    serverHarness.destroy();
  });

  const runtimeConfig = makeRuntimeConfig();
  configureServerSync(serverHarness, runtimeConfig);

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
          JSON.stringify({ target: "ipfs://local-test", keyVersion: 9 }),
        ),
      },
    ],
  });

  assert.equal(response.statusCode, 0);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "response");

  const result = JSON.parse(textDecoder.decode(response.outputs[0].payload));
  assert.equal(result.keyVersion, 9);
  assert.deepEqual(Buffer.from(result.dekBase64, "base64"), runtimeConfig.dek);
  assert.ok(result.expiresAtMs > Date.now());
});
