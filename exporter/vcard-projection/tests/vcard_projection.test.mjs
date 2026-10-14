import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// exporter/vcard-projection on the typed contracts (1.0), end to end on the built artifact: the real $EPM fixture in,
// one $VCF out whose CARD is byte-identical to what the legacy (text-frame) artifact emitted on the same fixture
// (tests/fixtures/legacy-card-*.vcf, captured from the 0.1.0 module.wasm); and a $VCF back in, one $EPM out.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT
  ?? "/Users/tj/software/worktrees/spacedatastandards--sds-node-api-standards-20261013";
const { VCF, vcfCardForm, vcfLineEnding } = await import(pathToFileURL(path.join(STANDARDS_ROOT, "lib", "js", "VCF", "main.js")).href);
const { EPM, KeyType } = await import(pathToFileURL(path.join(STANDARDS_ROOT, "lib", "js", "EPM", "main.js")).href);
const flatbuffers = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js")).href);

const EPM_TYPE = { schemaName: "EPM.fbs", fileIdentifier: "$EPM", rootTypeName: "EPM", wireFormat: "flatbuffer" };
const VCF_TYPE = { schemaName: "VCF.fbs", fileIdentifier: "$VCF", rootTypeName: "VCF", wireFormat: "flatbuffer" };
const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const epmBytes = () => fs.readFileSync(path.join(FIXTURES, "epm-literal-key.bin"));

async function harness(t) {
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM_PATH), manifest: readManifest(), surface: "direct" });
  t.after(() => h.destroy());
  return h;
}
function sizePrefixedRoot(payload, ident) {
  const bb = new flatbuffers.ByteBuffer(new Uint8Array(payload));
  bb.setPosition(4);
  assert.equal(bb.getBufferIdentifier(), ident);
  bb.setPosition(0); // getSizePrefixedRootAs* skips the size prefix itself
  return bb;
}
const decodeVcf = (payload) => VCF.getSizePrefixedRootAsVCF(sizePrefixedRoot(payload, "$VCF"));
const decodeEpm = (payload) => EPM.getSizePrefixedRootAsEPM(sizePrefixedRoot(payload, "$EPM"));

function vcfFrame(card) {
  const b = new flatbuffers.Builder(1024);
  const cardOffset = b.createString(card);
  VCF.startVCF(b);
  VCF.addCard(b, cardOffset);
  b.finishSizePrefixed(VCF.endVCF(b), "$VCF");
  return { portId: "vcard", typeRef: VCF_TYPE, payload: b.asUint8Array() };
}

test("vcard-projection passes SDK compliance with one concrete SDS type per port", async () => {
  const manifest = readManifest();
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      const types = port.acceptedTypeSets.flatMap((set) => set.allowedTypes);
      assert.equal(types.length, 1, `${method.methodId}.${port.portId}`);
      assert.equal(types[0].wireFormat, "flatbuffer");
      assert.ok(!types[0].acceptsAnyFlatbuffer);
    }
  }
});

for (const [methodId, form, legacy] of [
  ["card_full", vcfCardForm.FULL, "legacy-card-full.vcf"],
  ["card_compact", vcfCardForm.COMPACT, "legacy-card-compact.vcf"],
]) {
  test(`${methodId}: $EPM in, one $VCF out, CARD byte-identical to the legacy artifact`, async (t) => {
    const h = await harness(t);
    const result = await h.invoke({ methodId, inputs: [{ portId: "epm", typeRef: EPM_TYPE, payload: epmBytes() }] });
    assert.equal(result.statusCode, 0, result.errorMessage);
    assert.equal(result.outputs.length, 1);
    const [frame] = result.outputs;
    assert.equal(frame.portId, "vcard");
    const vcf = decodeVcf(frame.payload);
    const expected = fs.readFileSync(path.join(FIXTURES, legacy), "utf8");
    assert.equal(vcf.CARD(), expected);
    assert.equal(vcf.FORM(), form);
    assert.equal(vcf.MEDIA_TYPE(), "text/vcard");
    const conformance = vcf.CONFORMANCE();
    assert.equal(conformance.VERSION(), "3.0");
    assert.equal(conformance.LINE_ENDING(), vcfLineEnding.CRLF);
    assert.equal(conformance.FOLD_OCTET_WIDTH(), 75);
    assert.equal(conformance.BYTE_LENGTH(), Buffer.byteLength(expected));
    if (form === vcfCardForm.COMPACT) {
      assert.equal(conformance.BYTE_BUDGET(), 1200);
      assert.equal(conformance.WITHIN_BYTE_BUDGET(), true);
    }
  });
}

test("card_full refuses a frame that is not a $EPM", async (t) => {
  const h = await harness(t);
  const result = await h.invoke({ methodId: "card_full", inputs: [{ portId: "epm", typeRef: EPM_TYPE, payload: new Uint8Array(16) }] });
  assert.notEqual(result.statusCode, 0);
  assert.equal(result.outputs.length, 0);
});

test("card_parse: the projected $VCF back in, one $EPM with the recovered fields out", async (t) => {
  const h = await harness(t);
  const card = fs.readFileSync(path.join(FIXTURES, "legacy-card-full.vcf"), "utf8");
  const result = await h.invoke({ methodId: "card_parse", inputs: [vcfFrame(card)] });
  assert.equal(result.statusCode, 0, result.errorMessage);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].portId, "epm_fields");
  const epm = decodeEpm(result.outputs[0].payload);
  // The legacy JSON on the same card: {"dn":"Literal Key Node","signing_public_key":"obLD...obI","encryption_public_key":"ssPU...ssM"}
  assert.equal(epm.DN(), "Literal Key Node");
  assert.equal(epm.FAMILY_NAME(), null);
  assert.equal(epm.EMAIL(), null);
  assert.equal(epm.keysLength(), 2);
  const b64urlToHex = (s) => Buffer.from(s, "base64url").toString("hex");
  assert.equal(epm.KEYS(0).KEY_TYPE(), KeyType.Signing);
  assert.equal(epm.KEYS(0).PUBLIC_KEY(), b64urlToHex("obLD1OX2obLD1OX2obLD1OX2obLD1OX2obLD1OX2obI"));
  assert.equal(epm.KEYS(1).KEY_TYPE(), KeyType.Encryption);
  assert.equal(epm.KEYS(1).PUBLIC_KEY(), b64urlToHex("ssPU5fahssPU5fahssPU5fahssPU5fahssPU5fahssM"));
  // Round trip: the recovered keys are the fixture's own literal public keys.
  const source = decodeEpm(epmBytes());
  const sourceKeys = Array.from({ length: source.keysLength() }, (_, i) => source.KEYS(i));
  const sign = sourceKeys.find((k) => k.KEY_TYPE() === KeyType.Signing).PUBLIC_KEY().replace(/^0x/i, "").toLowerCase();
  assert.equal(epm.KEYS(0).PUBLIC_KEY(), sign);
});

test("card_parse refuses a frame that is not a $VCF", async (t) => {
  const h = await harness(t);
  const result = await h.invoke({ methodId: "card_parse", inputs: [{ portId: "vcard", typeRef: VCF_TYPE, payload: new TextEncoder().encode("BEGIN:VCARD\r\nFN:x\r\n") }] });
  assert.notEqual(result.statusCode, 0);
  assert.equal(result.outputs.length, 0);
});
