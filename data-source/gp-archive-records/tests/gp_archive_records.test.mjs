import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { CAT } from "spacedatastandards.org/lib/js/CAT/main.js";
import { MPE, meanElementSource } from "spacedatastandards.org/lib/js/MPE/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { CAT_FIELDS, MPE_FIELDS, encodeFieldBatch } from "./field-batch.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../node_modules/spacedatastandards.org/", import.meta.url));

// Archive encoding v1 vectors (tests/archive-v1-vectors.json; doubles as
// IEEE-754 bit patterns, non-UTF-8 strings as <FIELD>_BASE64). Every expected
// byte string was written by the GP
// archive importer's original Go builders (buildGPArchiveMPE and
// buildGPArchiveCAT at space-data-network 70c9d4884) for the same input, not by
// this module: synthetic edge cases (defaults, negative zero, extreme doubles,
// every entity-id length that moves the alignment, escaped and non-UTF-8
// strings, NORAD_CAT_ID 0 and 2^32-1) plus records sampled from each source of
// the archive (1959-2022 zip CSVs, gp_history windows, daily gp snapshots,
// SATCAT). Byte equality is the whole contract: a content ID is sha256 over
// these bytes, so any difference re-keys the archive.
const VECTORS = JSON.parse(fs.readFileSync(new URL("./archive-v1-vectors.json", import.meta.url), "utf8"));

const manifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const wasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));

// A vector's field values as the field batch encoder takes them.
function fieldValues(vector, fields) {
  const values = {};
  for (const [name, kind] of fields) {
    if (kind === "string") {
      values[name] =
        vector[`${name}_BASE64`] !== undefined
          ? new Uint8Array(Buffer.from(vector[`${name}_BASE64`], "base64"))
          : vector[name];
    } else {
      values[name] = vector[name];
    }
  }
  return values;
}

const mpeBatch = (vectors) => encodeFieldBatch(MPE_FIELDS, vectors.map((v) => fieldValues(v, MPE_FIELDS)));
const catBatch = (vectors) => encodeFieldBatch(CAT_FIELDS, vectors.map((v) => fieldValues(v, CAT_FIELDS)));

function splitStream(bytes) {
  const frames = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const size = view.getUint32(offset, true);
    if (size === 0) {
      offset += 4;
      continue;
    }
    frames.push(Buffer.from(bytes.subarray(offset, offset + 4 + size)));
    offset += 4 + size;
    while (offset % 8 !== 0 && offset < bytes.length) {
      assert.equal(bytes[offset], 0, "alignment padding is zero");
      offset++;
    }
  }
  return frames;
}

async function harness(t) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm(), manifest: manifest(), surface: "direct" });
  t.after(() => h.destroy());
  return h;
}

async function invoke(h, methodId, payload) {
  return h.invoke({
    methodId,
    inputs: [
      {
        portId: "records",
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
        payload,
      },
    ],
  });
}

async function build(h, methodId, payload) {
  const response = await invoke(h, methodId, payload);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const frame = response.outputs.find((output) => output.portId === "records");
  assert.ok(frame, "records output");
  return splitStream(frame.payload);
}

// Field offsets from the vtable of a size-prefixed buffer, by slot.
function fieldOffsets(frame) {
  const root = 4 + frame.readUInt32LE(4);
  const vtable = root - frame.readInt32LE(root);
  const vtableSize = frame.readUInt16LE(vtable);
  const offsets = [];
  for (let slot = 0; 4 + 2 * slot < vtableSize; slot++) offsets.push(frame.readUInt16LE(vtable + 4 + 2 * slot));
  return offsets;
}

test("artifact passes SDK compliance and is standalone WASI", async () => {
  const report = await validateArtifactWithStandards({
    manifest: manifest(),
    wasmPath: fileURLToPath(WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const inspection = await inspectModule(wasm());
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual([...new Set(inspection.imports.map((entry) => entry.module))], ["wasi_snapshot_preview1"]);
});

test("build_mpe reproduces the importer's bytes for every archive-v1 vector", async (t) => {
  const h = await harness(t);
  const frames = await build(h, "build_mpe", mpeBatch(VECTORS.mpe));
  assert.equal(frames.length, VECTORS.mpe.length);
  VECTORS.mpe.forEach((vector, i) => {
    assert.equal(frames[i].toString("hex"), vector.expected, `${vector.id} (${vector.source})`);
  });
});

test("build_cat reproduces the importer's bytes for every archive-v1 vector", async (t) => {
  const h = await harness(t);
  const frames = await build(h, "build_cat", catBatch(VECTORS.cat));
  assert.equal(frames.length, VECTORS.cat.length);
  VECTORS.cat.forEach((vector, i) => {
    assert.equal(frames[i].toString("hex"), vector.expected, `${vector.id} (${vector.source})`);
  });
});

test("a record's bytes do not depend on the rest of its batch", async (t) => {
  const h = await harness(t);
  for (const vector of [...VECTORS.mpe.slice(0, 8), ...VECTORS.mpe.slice(-4)]) {
    const [frame] = await build(h, "build_mpe", mpeBatch([vector]));
    assert.equal(frame.toString("hex"), vector.expected, vector.id);
  }
  for (const vector of [...VECTORS.cat.slice(0, 8), ...VECTORS.cat.slice(-4)]) {
    const [frame] = await build(h, "build_cat", catBatch([vector]));
    assert.equal(frame.toString("hex"), vector.expected, vector.id);
  }
});

test("archive encoding v1 layout: every MPE field present, in the importer's order", async (t) => {
  const h = await harness(t);
  const input = {
    ENTITY_ID: "1998-067A",
    EPOCH: 1727395200.123456,
    MEAN_MOTION: 15.50103472,
    ECCENTRICITY: 0,
    INCLINATION: 51.6416,
    RA_OF_ASC_NODE: 247.4627,
    ARG_OF_PERICENTER: 130.536,
    MEAN_ANOMALY: 325.0288,
    BSTAR: 0,
  };
  const [frame] = await build(h, "build_mpe", encodeFieldBatch(MPE_FIELDS, [input]));
  // Every key lands in the schema field of the same name (read back through the
  // generated SDS JavaScript bindings).
  const mpe = MPE.getSizePrefixedRootAsMPE(new flatbuffers.ByteBuffer(new Uint8Array(frame))).unpack();
  for (const [key, value] of Object.entries(input)) assert.equal(mpe[key], value, key);
  assert.equal(mpe.MEAN_ELEMENT_THEORY, meanElementSource.SGP4);
  // Slots 0..9 (ENTITY_ID..MEAN_ELEMENT_THEORY) are all written, zero-valued
  // defaults included, and the later a field is added the lower its offset:
  // ENTITY_ID first (highest), MEAN_ELEMENT_THEORY last (lowest).
  const offsets = fieldOffsets(frame);
  assert.equal(offsets.length, 10);
  for (const offset of offsets) assert.ok(offset > 0);
  for (let slot = 1; slot < offsets.length; slot++) assert.ok(offsets[slot] < offsets[slot - 1], `slot ${slot}`);
});

test("archive encoding v1 layout: CAT adds OBJECT_ID, NORAD_CAT_ID, OBJECT_NAME and omits a zero NORAD_CAT_ID", async (t) => {
  const h = await harness(t);
  const rows = [
    { OBJECT_ID: "1998-067A", NORAD_CAT_ID: 25544, OBJECT_NAME: "ISS (ZARYA)" },
    { OBJECT_ID: "NORAD:0", NORAD_CAT_ID: 0, OBJECT_NAME: "UNKNOWN" },
  ];
  const [present, absent] = await build(h, "build_cat", encodeFieldBatch(CAT_FIELDS, rows));
  const cat = CAT.getSizePrefixedRootAsCAT(new flatbuffers.ByteBuffer(new Uint8Array(present))).unpack();
  assert.equal(cat.OBJECT_ID, "1998-067A");
  assert.equal(cat.NORAD_CAT_ID, 25544);
  assert.equal(cat.OBJECT_NAME, "ISS (ZARYA)");
  // Schema slots: OBJECT_NAME 0, OBJECT_ID 1, NORAD_CAT_ID 2. Added in the
  // order OBJECT_ID, NORAD_CAT_ID, OBJECT_NAME.
  const [name, id, norad] = fieldOffsets(present);
  assert.ok(id > norad && norad > name);
  assert.equal(fieldOffsets(absent)[2] ?? 0, 0, "NORAD_CAT_ID 0 is not written");
});

test("header fields may come in any order", async (t) => {
  const h = await harness(t);
  const reversed = [...MPE_FIELDS].reverse();
  const [frame] = await build(h, "build_mpe", encodeFieldBatch(reversed, [fieldValues(VECTORS.mpe[0], MPE_FIELDS)]));
  assert.equal(frame.toString("hex"), VECTORS.mpe[0].expected);
});

test("an empty batch builds an empty stream", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await build(h, "build_mpe", encodeFieldBatch(MPE_FIELDS, [])), []);
  assert.deepEqual(await build(h, "build_cat", encodeFieldBatch(CAT_FIELDS, [])), []);
});

test("malformed batches are refused whole", async (t) => {
  const h = await harness(t);
  const good = fieldValues(VECTORS.mpe[0], MPE_FIELDS);
  const valid = encodeFieldBatch(MPE_FIELDS, [good, good]);
  const withHeader = (fields) => encodeFieldBatch(fields, [good]);
  const cases = [
    ["build_mpe", withHeader(MPE_FIELDS.filter(([name]) => name !== "BSTAR")), /missing field BSTAR/],
    ["build_mpe", withHeader([...MPE_FIELDS, ["MEAN_ELEMENT_THEORY", "uint32"]]), /unknown field MEAN_ELEMENT_THEORY/],
    ["build_mpe", withHeader([...MPE_FIELDS, ["EPOCH", "double"]]), /duplicate field EPOCH/],
    ["build_mpe", valid.subarray(0, valid.length - 1), /record 1 is truncated/],
    ["build_mpe", Buffer.concat([valid, Buffer.from([0])]), /Trailing bytes/],
    ["build_mpe", Buffer.from("[]"), /not a GPAF field batch/],
    ["build_cat", withHeader(MPE_FIELDS), /unknown field ENTITY_ID/],
  ];
  for (const [methodId, payload, message] of cases) {
    const response = await invoke(h, methodId, new Uint8Array(payload));
    assert.equal(response.statusCode, 400, String(message));
    assert.match(response.errorMessage, message);
  }
});
