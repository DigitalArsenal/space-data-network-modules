import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  signCdmOutput,
  verifySignedCdmOutput,
} from "../index.js";

test("signed CDM output binds CDM bytes and publication metadata", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const cdmPayload = Buffer.from("fixture-cdm-output");

  const signed = signCdmOutput(cdmPayload, {
    privateKey,
    providerId: "celestrak.eth",
    sourcePnmCid: "bafybeicelestrakpnm",
    moduleArtifactHash: "sha256:" + "a".repeat(64),
    moduleVersion: "0.2.0",
    cdmOutputId: "CDM-61721-67298",
  });

  assert.equal(signed.schemaVersion, 1);
  assert.equal(signed.artifactKind, "signed-cdm");
  assert.equal(signed.schemaName, "CDM/main.fbs");
  assert.equal(signed.fileIdentifier, "$CDM");
  assert.match(signed.cdmHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(signed.signedPayload.cdmHash, signed.cdmHash);
  assert.equal(signed.signedPayload.providerId, "celestrak.eth");
  assert.equal(signed.signedPayload.sourcePnmCid, "bafybeicelestrakpnm");
  assert.equal(signed.signature.algorithm, "Ed25519");
  assert.equal(
    verifySignedCdmOutput(cdmPayload, signed, publicKey),
    true,
    "signature verifies for the original CDM bytes",
  );

  assert.equal(
    verifySignedCdmOutput(Buffer.from("tampered-cdm-output"), signed, publicKey),
    false,
    "signature fails when CDM bytes are changed",
  );
});
