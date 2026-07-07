// TEMP diagnostic — configure + publish + LCH challenge against the freshly
// built licensing module.wasm. DELETE AFTER USE.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";

import { createSdkBrowserShimSyncHarness } from "./lib/sdkBrowserShimHarness.mjs";
import { getWasmWallet } from "space-data-module-sdk/utils/wasm-crypto";
import { encodeLicensingChallengeRequest } from "space-data-module-sdk/licensing";
import { PLG } from "spacedatastandards.org/lib/js/PLG/PLG.js";
import { pluginCategory } from "spacedatastandards.org/lib/js/PLG/pluginCategory.js";
import { KMF } from "spacedatastandards.org/lib/js/REC/KMF.js";
import { keyMaterialAlgorithm } from "spacedatastandards.org/lib/js/REC/keyMaterialAlgorithm.js";
import { keyMaterialEncoding } from "spacedatastandards.org/lib/js/REC/keyMaterialEncoding.js";
import { keyMaterialRole } from "spacedatastandards.org/lib/js/REC/keyMaterialRole.js";
import { KRF } from "spacedatastandards.org/lib/js/REC/KRF.js";
import { keyReferenceAlgorithm } from "spacedatastandards.org/lib/js/REC/keyReferenceAlgorithm.js";
import { keyReferenceRole } from "spacedatastandards.org/lib/js/REC/keyReferenceRole.js";
import { LCF } from "spacedatastandards.org/lib/js/REC/LCF.js";
import { licensingConfigMessageType } from "spacedatastandards.org/lib/js/REC/licensingConfigMessageType.js";
import { licensingConfigRole } from "spacedatastandards.org/lib/js/REC/licensingConfigRole.js";

const textEncoder = new TextEncoder();
const ISOMORPHIC_WASM_PATH = new URL(
  "../dist/isomorphic/module.wasm",
  import.meta.url,
);

const wallet = await getWasmWallet();
const contentStore = new Map();
const signingSlotId = "provider-signing";
const wrappingSlotId = "provider-wrapping";
const keySlots = new Map([
  [signingSlotId, randomBytes(32)],
  [wrappingSlotId, randomBytes(32)],
]);

function dispatch(operation, params) {
  if (operation.startsWith("crypto.ed25519.")) {
    if (operation === "crypto.ed25519.publicKeyFromSeed") {
      return new Uint8Array(
        wallet.curves.ed25519.publicKeyFromSeed(params.seed),
      );
    }
    if (operation === "crypto.ed25519.sign") {
      return new Uint8Array(
        wallet.curves.ed25519.sign(params.message, params.seed),
      );
    }
    if (operation === "crypto.ed25519.verify") {
      return wallet.curves.ed25519.verify(
        params.message,
        params.signature,
        params.publicKey,
      );
    }
  }
  if (operation === "clock.now") return Date.now();
  if (operation === "random.bytes") return randomBytes(params?.length ?? 32);
  if (operation === "keyslot.get") {
    const keyBytes = keySlots.get(String(params?.slotId ?? ""));
    if (!keyBytes) throw new Error(`keyslot.get missing slot ${params?.slotId}`);
    return new Uint8Array(keyBytes);
  }
  if (operation === "ipfs.add") {
    const raw = Buffer.from(params.content);
    const cid = `bafy-lic-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
    contentStore.set(cid, raw);
    return { Hash: cid, Size: raw.length };
  }
  throw new Error(`Unsupported operation: ${operation}`);
}

const harness = await createSdkBrowserShimSyncHarness({
  wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
  dispatch,
  logOutput: true,
});

function show(label, response) {
  console.log(`--- ${label}`);
  console.log(JSON.stringify(
    {
      statusCode: response.statusCode,
      errorCode: response.errorCode,
      errorMessage: response.errorMessage,
      outputs: (response.outputs ?? []).map((o) => ({
        portId: o.portId,
        len: o.payload?.length,
        first16: Buffer.from(o.payload?.slice(0, 16) ?? []).toString("hex"),
        ident: Buffer.from(o.payload?.slice(4, 8) ?? []).toString(),
      })),
      raw: Object.keys(response),
    },
    null,
    1,
  ));
}

// --- configure
const providerPeerId = "provider.orbpro.test";
function buildRuntimeConfigFrame() {
  const builder = new flatbuffers.Builder(512);
  const providerPeerIdOffset = builder.createString(providerPeerId);
  const signingKeyIdOffset = builder.createString("licensing.provider.signing");
  const signingSlotIdOffset = builder.createString(signingSlotId);
  const wrappingKeyIdOffset = builder.createString("licensing.provider.wrapping");
  const wrappingSlotIdOffset = builder.createString(wrappingSlotId);
  const capabilityTokenOffset = LCF.createCapabilityTokenVector(
    builder,
    textEncoder.encode("capability-token"),
  );
  const signingKeyOffset = KRF.createKRF(
    builder, signingKeyIdOffset, signingSlotIdOffset,
    keyReferenceRole.ProviderSigning, keyReferenceAlgorithm.Ed25519Seed,
    0, 9, 0n, true,
  );
  const wrappingKeyOffset = KRF.createKRF(
    builder, wrappingKeyIdOffset, wrappingSlotIdOffset,
    keyReferenceRole.ProviderWrapping, keyReferenceAlgorithm.X25519Private,
    0, 9, 0n, true,
  );
  LCF.startLCF(builder);
  LCF.addMessageType(builder, licensingConfigMessageType.Configure);
  LCF.addRole(builder, licensingConfigRole.Provider);
  LCF.addProviderPeerId(builder, providerPeerIdOffset);
  LCF.addProviderSigningKey(builder, signingKeyOffset);
  LCF.addProviderWrappingKey(builder, wrappingKeyOffset);
  LCF.addActiveKeyVersion(builder, 9);
  LCF.addExpiresAt(builder, BigInt(Date.now() + 60_000));
  LCF.addMaxClockSkewMs(builder, 5_000n);
  LCF.addChallengeTtlMs(builder, 30_000n);
  LCF.addCapabilityToken(builder, capabilityTokenOffset);
  const root = LCF.endLCF(builder);
  LCF.finishLCFBuffer(builder, root);
  return builder.asUint8Array();
}

show(
  "server_configure_runtime",
  harness.invokeSync({
    methodId: "server_configure_runtime",
    inputs: [
      { portId: "config", fileIdentifier: "$LCF", payload: buildRuntimeConfigFrame() },
    ],
  }),
);

// --- publish (AES publication content key)
function buildModuleDescriptor({ moduleId, version, keyId }) {
  const builder = new flatbuffers.Builder(512);
  const pluginIdOffset = builder.createString(moduleId);
  const nameOffset = builder.createString(moduleId);
  const versionOffset = builder.createString(version);
  const requiredScopeOffset = builder.createString("orbpro.default");
  const keyIdOffset = builder.createString(keyId);
  PLG.startPLG(builder);
  PLG.addPluginId(builder, pluginIdOffset);
  PLG.addName(builder, nameOffset);
  PLG.addVersion(builder, versionOffset);
  PLG.addPluginType(builder, pluginCategory.Analysis);
  PLG.addAbiVersion(builder, 1);
  PLG.addEncrypted(builder, true);
  PLG.addRequiredScope(builder, requiredScopeOffset);
  PLG.addKeyId(builder, keyIdOffset);
  PLG.addMaxGrantTimeoutMs(builder, 30_000n);
  PLG.addCreatedAt(builder, BigInt(Date.now()));
  PLG.addUpdatedAt(builder, BigInt(Date.now()));
  const root = PLG.endPLG(builder);
  PLG.finishPLGBuffer(builder, root);
  return builder.asUint8Array();
}

function buildKeyMaterialFrame({ keyId, role, algorithm, encoding, keyBytes }) {
  const builder = new flatbuffers.Builder(256);
  const keyIdOffset = builder.createString(keyId);
  const keyBytesOffset = KMF.createKeyBytesVector(builder, keyBytes);
  const root = KMF.createKMF(
    builder, keyIdOffset, role, algorithm, encoding, keyBytesOffset, 0, 0n,
  );
  KMF.finishKMFBuffer(builder, root);
  return builder.asUint8Array();
}

const moduleDek = randomBytes(32);
show(
  "server_publish_module",
  harness.invokeSync({
    methodId: "server_publish_module",
    inputs: [
      {
        portId: "module_descriptor",
        fileIdentifier: "$PLG",
        payload: buildModuleDescriptor({
          moduleId: "orbpro.test.module",
          version: "1.2.3",
          keyId: "orbpro.test.module:1.2.3",
        }),
      },
      { portId: "protected_content", payload: textEncoder.encode("encrypted bundle") },
      {
        portId: "content_key",
        fileIdentifier: "$KMF",
        payload: buildKeyMaterialFrame({
          keyId: "orbpro.test.module:1.2.3",
          role: keyMaterialRole.PublicationContent,
          algorithm: keyMaterialAlgorithm.Aes256Gcm,
          encoding: keyMaterialEncoding.Raw,
          keyBytes: moduleDek,
        }),
      },
    ],
  }),
);

// --- challenge via SDK encoder (exactly what sdn-js sends)
const challengeBytes = encodeLicensingChallengeRequest({
  reqId: "probe-req-1",
  moduleId: "orbpro.test.module",
  moduleVersion: "1.2.3",
  requesterPeerId: "requester.orbpro.test",
  requesterXpub: "xpub-test",
  requesterSigningPublicKey: randomBytes(32),
  requesterEphemeralPublicKey: randomBytes(32),
  requesterDomain: "app.orbpro.test",
  requestedTimeoutMs: 30_000,
  requestedAtMs: Date.now(),
  providerPeerId,
});
console.log(
  "challenge request first16:",
  Buffer.from(challengeBytes.slice(0, 16)).toString("hex"),
  "ident:",
  Buffer.from(challengeBytes.slice(4, 8)).toString(),
);
show(
  "server_handle_message (SDK-encoded LCH)",
  harness.invokeSync({
    methodId: "server_handle_message",
    inputs: [
      { portId: "request", fileIdentifier: "$LCH", payload: challengeBytes },
    ],
  }),
);

// --- challenge built manually WITHOUT touching REQUESTER_EPM slot
import("spacedatastandards.org/lib/js/REC/LCH.js").then(() => {});
const { LCH } = await import("spacedatastandards.org/lib/js/REC/LCH.js");
const { licensingChallengeMessageType } = await import(
  "spacedatastandards.org/lib/js/REC/licensingChallengeMessageType.js"
);
const { licensingChallengeRole } = await import(
  "spacedatastandards.org/lib/js/REC/licensingChallengeRole.js"
);

function buildCleanChallenge() {
  const builder = new flatbuffers.Builder(512);
  const requestIdOffset = builder.createString("probe-req-2");
  const moduleIdOffset = builder.createString("orbpro.test.module");
  const moduleVersionOffset = builder.createString("1.2.3");
  const requesterPeerIdOffset = builder.createString("requester.orbpro.test");
  const requesterXpubOffset = builder.createString("xpub-test");
  const requesterDomainOffset = builder.createString("app.orbpro.test");
  const providerPeerIdOffset = builder.createString(providerPeerId);
  const signingOffset = LCH.createRequesterSigningPubkeyVector(
    builder,
    randomBytes(32),
  );
  const ephemeralOffset = LCH.createRequesterEphemeralPubkeyVector(
    builder,
    randomBytes(32),
  );
  LCH.startLCH(builder);
  LCH.addMessageType(builder, licensingChallengeMessageType.Request);
  LCH.addRole(builder, licensingChallengeRole.Requester);
  LCH.addRequestId(builder, requestIdOffset);
  LCH.addModuleId(builder, moduleIdOffset);
  LCH.addModuleVersion(builder, moduleVersionOffset);
  LCH.addRequesterPeerId(builder, requesterPeerIdOffset);
  LCH.addRequesterXpub(builder, requesterXpubOffset);
  LCH.addRequesterSigningPubkey(builder, signingOffset);
  LCH.addRequesterEphemeralPubkey(builder, ephemeralOffset);
  LCH.addRequestedDomain(builder, requesterDomainOffset);
  LCH.addRequestedTimeoutMs(builder, 30_000n);
  LCH.addRequestedAt(builder, BigInt(Date.now()));
  LCH.addProviderPeerId(builder, providerPeerIdOffset);
  // NOTE: deliberately NOT calling addChallengeNonce/addExpiresAt/addErrorCode/
  // addErrorMessage/addRequesterEpm — matches a well-formed sparse table.
  const root = LCH.endLCH(builder);
  LCH.finishLCHBuffer(builder, root);
  return builder.asUint8Array();
}

show(
  "server_handle_message (clean manual LCH, no REQUESTER_EPM slot)",
  harness.invokeSync({
    methodId: "server_handle_message",
    inputs: [
      { portId: "request", fileIdentifier: "$LCH", payload: buildCleanChallenge() },
    ],
  }),
);

harness.destroy();
