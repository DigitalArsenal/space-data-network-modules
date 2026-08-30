// ccsds_module.test.mjs — the compiled artifact, INVOKED.
//
// WHY THIS EXISTS SEPARATELY FROM THE COMPLIANCE CHECK
//
// A manifest that validates and an artifact that inspects clean prove the
// module is well-formed, not that a single one of its methods works. The
// specific failure this test is written against: `plugin_push_output_ex` takes
// `(…, root_type, fixed_string_length, required_alignment, ptr, len)`, and
// transposing the two uint16s compiles, links, validates and inspects
// perfectly — then refuses every invocation with `unsupported-output-type`. The
// only thing that catches it is calling the method. So every method is invoked
// here, and the two write methods are invoked on the output of the two read
// methods so the frame shape is proven by consumption rather than by assertion.
//
// The $NCD frame is built with the canonical spacedatastandards.org JS bindings
// and the SHA-256 with node:crypto — a second, independent implementation of
// the pairing the guest checks. If the guest's SOURCE_SHA256 check and this
// one ever disagree, one of them is wrong and the test says so.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
// NOTE: the generated JS getters are the IDL field names VERBATIM
// (NCD.FORMAT(), NCD.SOURCE_SHA256()) while the builder setters are camelCased.
// That asymmetry is the schema-capitalization law showing through the bindings,
// and reading a descriptor with a camelCase getter silently returns undefined.
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { ncdContainerFormat } from "spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const MANIFEST_PATH = path.join(packageRoot, "plugin-manifest.json");
const WASM_PATH = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const STANDARDS_ROOT = path.join(packageRoot, "node_modules", "spacedatastandards.org");
const FIXTURES = path.join(packageRoot, "fixtures");

const AEM_FIXTURE = "ccsds-504.0-B-2-figure-G-4-aem.txt";
const TDM_FIXTURE = "ccsds-503.0-B-2-figure-E-17-tdm-radar.txt";

const built = fs.existsSync(WASM_PATH);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// [u32le n][ $NCD flatbuffer, n bytes ][ the message's exact bytes ] — a
// size-prefixed $NCD with the described file appended, which is exactly what
// the module's header comment specifies and what files/orbit-products reads.
function buildMessageFrame(messageBytes, { format, declareHash = true, declareLength = true } = {}) {
  const builder = new flatbuffers.Builder(1024);
  const sha = declareHash ? builder.createString(sha256Hex(messageBytes)) : null;
  NCD.startNCD(builder);
  if (format !== undefined) NCD.addFormat(builder, format);
  if (declareLength) NCD.addSourceByteLength(builder, BigInt(messageBytes.byteLength));
  if (sha !== null) NCD.addSourceSha256(builder, sha);
  NCD.finishSizePrefixedNCDBuffer(builder, NCD.endNCD(builder));
  const descriptor = builder.asUint8Array();

  const frame = new Uint8Array(descriptor.byteLength + messageBytes.byteLength);
  frame.set(descriptor, 0);
  frame.set(messageBytes, descriptor.byteLength);
  return frame;
}

// The inverse, so a write method's output can be fed straight back to a read
// method. Reading the boundary out of the frame is the point of the prefix.
function splitMessageFrame(frame) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const descriptorLength = view.getUint32(0, true);
  const prefixed = 4 + descriptorLength;
  const descriptorBytes = frame.subarray(0, prefixed);
  const bb = new flatbuffers.ByteBuffer(descriptorBytes);
  bb.setPosition(4);
  return {
    descriptor: NCD.getRootAsNCD(bb),
    body: frame.subarray(prefixed),
  };
}

function readDescriptorFrame(payload) {
  const bb = new flatbuffers.ByteBuffer(payload);
  bb.setPosition(4); // aligned-binary $NCD outputs are size-prefixed
  return NCD.getRootAsNCD(bb);
}

async function harness(t) {
  const instance = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(WASM_PATH),
    manifest: readManifest(),
    surface: "direct",
  });
  t.after(() => instance.destroy());
  return instance;
}

function ncdInput(portId, frame) {
  return {
    portId,
    typeRef: {
      schemaName: "NCD.fbs",
      fileIdentifier: "$NCD",
      rootTypeName: "NCD",
      wireFormat: "aligned-binary",
      requiredAlignment: 8,
      // REQUIRED: the SDK invoke codec rejects an aligned typeRef without a
      // byteLength and throws before the wasm is entered.
      byteLength: frame.byteLength,
    },
    payload: frame,
  };
}

function recordInput(portId, family, payload) {
  return {
    portId,
    typeRef: {
      schemaName: `${family}.fbs`,
      fileIdentifier: `$${family}`,
      rootTypeName: family,
      wireFormat: "aligned-binary",
      requiredAlignment: 8,
      byteLength: payload.byteLength,
    },
    payload,
  };
}

function outputByPort(response, portId) {
  const frame = response.outputs.find((f) => f.portId === portId);
  assert.ok(frame, `no output on port ${portId}; got ${response.outputs.map((f) => f.portId)}`);
  return frame;
}

test("files/ccsds-messages artifact passes SDK compliance", { skip: !built && "run `npm run build` first" }, async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: WASM_PATH,
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("files/ccsds-messages artifact is standalone WASI and exports every method", { skip: !built && "run `npm run build` first" }, async () => {
  const inspection = await inspectModule(fs.readFileSync(WASM_PATH));
  const importedModules = [...new Set(inspection.imports.map((e) => e.module))].sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModules, ["wasi_snapshot_preview1"], "pure compute: WASI imports only");
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
    // Every method the manifest declares. A manifest method with no export is
    // an invoke that fails at call time, not at build time.
    "read_aem",
    "read_tdm",
    "write_aem",
    "write_tdm",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("read_aem projects published Figure G-4 and describes the file it read", { skip: !built && "run `npm run build` first" }, async (t) => {
  const bytes = fs.readFileSync(path.join(FIXTURES, AEM_FIXTURE));
  const frame = buildMessageFrame(bytes, { format: ncdContainerFormat.CCSDS_AEM_KVN });
  const response = await (await harness(t)).invoke({
    methodId: "read_aem",
    inputs: [ncdInput("message", frame)],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 2);

  const attitude = outputByPort(response, "attitude");
  assert.equal(attitude.wireFormat, "aligned-binary");
  assert.ok(attitude.payload.byteLength > 0);

  const descriptor = readDescriptorFrame(outputByPort(response, "descriptor").payload);
  assert.equal(descriptor.FORMAT(), ncdContainerFormat.CCSDS_AEM_KVN);
  assert.equal(descriptor.FORMAT_VERSION(), "2.0");
  assert.equal(descriptor.ORIGINATOR(), "NASA/JPL");
  assert.equal(descriptor.CREATION_DATE(), "2002-11-04T17:22:31");
  assert.equal(descriptor.NATIVE_TIME_SYSTEM(), "UTC");
  assert.equal(descriptor.START_TIME(), "1996-11-28T21:29:07.2555");
  assert.equal(descriptor.STOP_TIME(), "1996-12-28T21:28:00.5555");
  // The guest hashed the bytes it actually read; node:crypto hashed the bytes
  // we actually sent. Two implementations, one answer.
  assert.equal(descriptor.SOURCE_SHA256(), sha256Hex(bytes));
  assert.equal(descriptor.SOURCE_BYTE_LENGTH(), BigInt(bytes.byteLength));
});

test("read_tdm projects published Figure E-17", { skip: !built && "run `npm run build` first" }, async (t) => {
  const bytes = fs.readFileSync(path.join(FIXTURES, TDM_FIXTURE));
  const frame = buildMessageFrame(bytes, { format: ncdContainerFormat.CCSDS_TDM_KVN });
  const response = await (await harness(t)).invoke({
    methodId: "read_tdm",
    inputs: [ncdInput("message", frame)],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 2);
  assert.ok(outputByPort(response, "tracking").payload.byteLength > 0);

  const descriptor = readDescriptorFrame(outputByPort(response, "descriptor").payload);
  assert.equal(descriptor.FORMAT(), ncdContainerFormat.CCSDS_TDM_KVN);
  assert.equal(descriptor.ORIGINATOR(), "ESA");
  assert.equal(descriptor.NATIVE_TIME_SYSTEM(), "UTC");
  // E-17 declares no START_TIME/STOP_TIME. Absent stays absent — the module
  // does not synthesise a span from the observations.
  assert.equal(descriptor.START_TIME(), null);
  assert.equal(descriptor.STOP_TIME(), null);
  // Figure E-17's only frame keyword is ANGLE_TYPE; REFERENCE_FRAME is absent,
  // so NATIVE_FRAME_NAME must stay empty rather than borrow it.
  assert.equal(descriptor.NATIVE_FRAME_NAME(), null);
});

// The round trip through the ABI: read a published message, write the record
// back out, then read THAT frame. The two $AEM payloads must be identical
// bytes — which also proves the emitted frame is one a read method accepts,
// rather than a shape only this test knows how to build.
for (const [method, family, port, fixture, writeMethod] of [
  ["read_aem", "AEM", "attitude", AEM_FIXTURE, "write_aem"],
  ["read_tdm", "TDM", "tracking", TDM_FIXTURE, "write_tdm"],
]) {
  test(`${writeMethod} emits a frame ${method} reads back to the same record`, { skip: !built && "run `npm run build` first" }, async (t) => {
    const instance = await harness(t);
    const bytes = fs.readFileSync(path.join(FIXTURES, fixture));
    const format = family === "AEM"
      ? ncdContainerFormat.CCSDS_AEM_KVN
      : ncdContainerFormat.CCSDS_TDM_KVN;

    const first = await instance.invoke({
      methodId: method,
      inputs: [ncdInput("message", buildMessageFrame(bytes, { format }))],
    });
    assert.equal(first.statusCode, 0, first.errorMessage);
    const record = outputByPort(first, port).payload;

    const written = await instance.invoke({
      methodId: writeMethod,
      inputs: [recordInput(port, family, record)],
    });
    assert.equal(written.statusCode, 0, written.errorMessage);
    assert.equal(written.outputs.length, 1);
    const emitted = outputByPort(written, "message").payload;

    // The emitted frame is self-describing: the descriptor's declared hash and
    // length must match the text that follows it in the SAME frame.
    const { descriptor, body } = splitMessageFrame(emitted);
    assert.equal(descriptor.FORMAT(), format);
    assert.equal(descriptor.SOURCE_BYTE_LENGTH(), BigInt(body.byteLength));
    assert.equal(descriptor.SOURCE_SHA256(), sha256Hex(body));
    const text = new TextDecoder().decode(body);
    assert.match(text, new RegExp(`^CCSDS_${family}_VERS = 2\\.0`));
    // No SDS extension may reach a CCSDS body.
    for (const forbidden of ["TRANSMIT_RAMPS", "FREQUENCY_RATE_HZ_PER_S", "SIGNAL_TO_NOISE",
                             "SPECTRAL_MAX", "DOPPLER_NOISE_HZ"]) {
      assert.ok(!text.includes(forbidden), `${forbidden} leaked into the emitted ${family} body`);
    }

    const second = await instance.invoke({
      methodId: method,
      inputs: [ncdInput("message", emitted)],
    });
    assert.equal(second.statusCode, 0, second.errorMessage);
    assert.deepEqual(
      Buffer.from(outputByPort(second, port).payload),
      Buffer.from(record),
      `${family} record changed on the second read`,
    );
  });
}

test("a descriptor that does not describe the frame is refused", { skip: !built && "run `npm run build` first" }, async (t) => {
  const instance = await harness(t);
  const bytes = fs.readFileSync(path.join(FIXTURES, AEM_FIXTURE));

  // Wrong format member: the caller asked the wrong method. Reinterpreting it
  // would read a TDM as an AEM.
  const mislabelled = buildMessageFrame(bytes, { format: ncdContainerFormat.CCSDS_TDM_KVN });
  const wrongFormat = await instance.invoke({
    methodId: "read_aem",
    inputs: [ncdInput("message", mislabelled)],
  });
  assert.notEqual(wrongFormat.statusCode, 0);
  assert.match(wrongFormat.errorMessage ?? "", /FORMAT/);

  // Declared hash over different bytes: the descriptor belongs to another file.
  const otherBytes = fs.readFileSync(path.join(FIXTURES, TDM_FIXTURE));
  const builder = new flatbuffers.Builder(1024);
  const sha = builder.createString(sha256Hex(otherBytes));
  NCD.startNCD(builder);
  NCD.addFormat(builder, ncdContainerFormat.CCSDS_AEM_KVN);
  NCD.addSourceSha256(builder, sha);
  NCD.finishSizePrefixedNCDBuffer(builder, NCD.endNCD(builder));
  const descriptor = builder.asUint8Array();
  const lying = new Uint8Array(descriptor.byteLength + bytes.byteLength);
  lying.set(descriptor, 0);
  lying.set(bytes, descriptor.byteLength);
  const badHash = await instance.invoke({
    methodId: "read_aem",
    inputs: [ncdInput("message", lying)],
  });
  assert.notEqual(badHash.statusCode, 0);
  assert.match(badHash.errorMessage ?? "", /SOURCE_SHA256/);

  // A descriptor with no file behind it. $NCD describes; it does not carry.
  const empty = buildMessageFrame(new Uint8Array(0), {
    format: ncdContainerFormat.CCSDS_AEM_KVN,
    declareHash: false,
    declareLength: false,
  });
  const noBody = await instance.invoke({
    methodId: "read_aem",
    inputs: [ncdInput("message", empty)],
  });
  assert.notEqual(noBody.statusCode, 0);
});
