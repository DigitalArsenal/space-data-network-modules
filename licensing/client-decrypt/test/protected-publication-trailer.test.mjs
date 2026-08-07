// Guardrail for the defect that shipped 42 unopenable plugins to the delivery
// node (graph: sdn-protected-plugin-hmac-decrypt-failure).
//
// The compiled client-decrypt WASM verifies the SDS $REC publication trailer
// with flatc's generated VerifyRECBuffer, which dispatches each Record through
// the RecordType UNION ORDINAL. Those ordinals are not wire-stable: SDS commit
// c1580d4700 (2026-07-08, "add peer registry SDS records") inserted $PGM into
// the middle of the union and shifted PNM 113 -> 114 (and PIV/PLD/PLG/PLK/PPE/
// PRG/PRW with it). A binary compiled before that shift reads a PNM record as
// PPE, PPE::Verify fails, and the whole trailer is rejected with "protected
// publication REC trailer is invalid" — even though the bytes are perfectly
// valid. ENC (39) and MBL (80) sit below the insertion point and were never
// affected, which is exactly why ENC-only trailers kept working and only
// PNM-bearing ones (every SDK-published module) broke.
//
// The old e2e only ever fed this module the legacy `iv || ct || tag` bundle, so
// it never exercised a real publication trailer at all and the drift shipped
// silently. These tests feed the module the SAME shape the SDK actually
// publishes — payload || REC(MBL+ENC+PNM) || uint32le(len) || "$REC" — so a
// stale-vs-schema binary fails the build instead of the browser.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import {
  encryptBytesForRecipient,
  generateX25519Keypair,
} from "space-data-module-sdk/transport";
import { randomBytes, x25519SharedSecret } from "space-data-module-sdk/utils/wasm-crypto";
import {
  buildRecWrappedKmfContentKeyFrame,
  encodeGrantResponse,
} from "../../../delivery/plugin-delivery/lib/module-delivery-codec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "..", "dist", "isomorphic", "module.wasm");

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`${PASS} ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`${FAIL} ${name}\n      ${error?.message ?? error}`);
  }
}

const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());

// A publication trailer carries provenance records ($MBL bundle listing, $PNM
// publication notification) alongside the $ENC delivery header. The module only
// consumes $ENC, but it must VERIFY the whole collection, so every record type
// the publisher can emit has to be represented here.
function sampleMbl() {
  return {
    bundleVersion: "1.0.0",
    moduleFormat: "wasm",
    canonicalization: "sds/module-publication/1",
    canonicalModuleHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    manifestExportSymbol: "plugin_get_manifest_flatbuffer",
    manifestSizeSymbol: "plugin_get_manifest_flatbuffer_size",
    entries: [],
  };
}

function samplePnm() {
  return {
    multiformatAddress: "/ipfs/bafkreiguardrailguardrailguardrailguardrailguardrailguardra",
    publishTimestamp: new Date(0).toISOString(),
    cid: "bafkreiguardrailguardrailguardrailguardrailguardrailguardra",
    fileName: "guardrail.wasm",
    fileId: "com.spaceaware.test.trailer-guardrail",
    signature: "c".repeat(128),
    timestampSignature: "d".repeat(128),
    signatureType: "secp256k1-sha256",
    timestampSignatureType: "secp256k1-sha256",
  };
}

// Re-wrap an SDK-protected blob's trailer with the requested record set. The
// payload and the ENC record are untouched, so any behaviour change between
// cases is attributable to the record set alone.
async function protectedBundleWithRecords(plaintext, contentPublicKey, records) {
  const { encodePublicationRecordCollection, decodePublicationRecordCollection } =
    await import("space-data-module-sdk/transport");
  const envelope = await encryptBytesForRecipient({
    plaintext,
    recipientPublicKey: contentPublicKey,
  });
  const blob = Buffer.from(envelope.protectedBlobBase64, "base64");
  const trailerLength = blob.readUInt32LE(blob.length - 8);
  const trailerOffset = blob.length - 8 - trailerLength;
  const payload = new Uint8Array(blob.subarray(0, trailerOffset));
  const parsed = decodePublicationRecordCollection(
    new Uint8Array(blob.subarray(trailerOffset, trailerOffset + trailerLength)),
  );
  const trailer = encodePublicationRecordCollection({
    ...(records.mbl ? { mbl: sampleMbl() } : {}),
    enc: parsed.enc,
    ...(records.pnm ? { pnm: samplePnm() } : {}),
  });
  const out = new Uint8Array(payload.length + trailer.length + 8);
  out.set(payload, 0);
  out.set(trailer, payload.length);
  new DataView(out.buffer).setUint32(payload.length + trailer.length, trailer.length, true);
  out.set([0x24, 0x52, 0x45, 0x43], payload.length + trailer.length + 4);
  return out;
}

async function grantFor(bundle, contentKey, moduleId) {
  const { publicKey, privateKey } = await generateX25519Keypair();
  const ephemeral = await generateX25519Keypair();
  const shared = await x25519SharedSecret(ephemeral.privateKey, publicKey);
  const wrapped = await buildRecWrappedKmfContentKeyFrame(contentKey, shared);
  const grant = encodeGrantResponse({
    reqId: "trailer-guardrail",
    grantedDomain: "localhost",
    grantedTimeoutMs: 30_000,
    expiresAtMs: Date.now() + 60_000,
    grantVerifierPublicKey: publicKey,
    bundleDescriptor: {
      cid: "bafy-trailer-guardrail",
      contentHash: sha256(bundle),
      sizeBytes: bundle.length,
      moduleId,
      moduleVersion: "1.0.0",
      runtime: "browser",
      abi: "space-data-module-abi",
      entrypoint: "plugin_invoke_stream",
      publicationCid: "bafy-trailer-guardrail-pub",
      contentCodec: "application/wasm+encrypted",
      encryptionCodec: "hkdf-sha256-aes-256-gcm",
    },
    wrappedContentKey: {
      wrappingAlgorithm: "x25519-hkdf-sha256-aes-256-ctr-rec",
      recipientPublicKey: publicKey,
      ephemeralPublicKey: ephemeral.publicKey,
      nonce: await randomBytes(12),
      ciphertext: wrapped,
      tag: new Uint8Array(),
      keyMaterialRootType: "REC",
    },
  });
  return { grant, privateKey };
}

if (!fs.existsSync(WASM_PATH)) {
  console.error(`client-decrypt WASM not found: ${WASM_PATH}\nBuild first: npm run build`);
  process.exit(1);
}

const harness = await createBrowserModuleHarness({
  wasmSource: fs.readFileSync(WASM_PATH),
  surface: "direct",
});

// A recognisable WASM preamble so a successful decrypt is unmistakable.
const plaintext = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...crypto.getRandomValues(new Uint8Array(512)),
]);

for (const [label, records] of [
  ["ENC only", {}],
  ["MBL + ENC", { mbl: true }],
  ["ENC + PNM", { pnm: true }],
  ["MBL + ENC + PNM (what the SDK publishes)", { mbl: true, pnm: true }],
]) {
  await test(`protected publication trailer decrypts: ${label}`, async () => {
    const contentKeyPair = await generateX25519Keypair();
    const bundle = await protectedBundleWithRecords(
      plaintext,
      contentKeyPair.publicKey,
      records,
    );
    const { grant, privateKey } = await grantFor(
      bundle,
      contentKeyPair.privateKey,
      "com.spaceaware.test.trailer-guardrail",
    );
    const result = await harness.invoke({
      methodId: "decrypt_artifact",
      inputs: [{ payload: grant }, { payload: privateKey }, { payload: bundle }],
    });
    assert.equal(
      result.errorMessage ?? "",
      "",
      // The exact string the delivery node and the browser both reported.
      `trailer rejected (${label}) — if this says "REC trailer is invalid" the ` +
        `compiled WASM's RecordType union ordinals no longer match the SDS pin ` +
        `the SDK publishes with; regenerate licensing/core headers and rebuild`,
    );
    assert.equal(result.statusCode, 0);
    assert.deepEqual(result.outputs[0].payload, plaintext);
  });
}

console.log();
if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("All protected-publication trailer tests passed");
