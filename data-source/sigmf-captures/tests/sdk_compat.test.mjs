// data-source/sigmf-captures SDK-compat tests.
//
// The two pure flow nodes run in the SDK browser harness against a fixture cut
// from the LIVE IQEngine bulk metadata index (see fixtures/PROVENANCE.md), and
// their outputs are asserted against the Themis $IQC rulings:
//
//   1. $IQC is a POINTER RECORD. PAYLOADS point upstream, CUSTODY is
//      UPSTREAM_ONLY, and no sample byte is ever carried.
//   2. HERTZ, not MHz. SigMF values are written unconverted.
//   3. DATATYPE is the SigMF token VERBATIM.
//   4. GEOLOCATION is omitted entirely when unpublished — never 0,0 — and a
//      transposed lat/lon is refused rather than silently swapped.
//   5. Empty LICENSE means UNKNOWN TERMS; licence is per RECORDING.
//   6. SigMF fidelity: SEGMENTS, ANNOTATIONS (with GENERATOR), EXTENSIONS,
//      HARDWARE.DESCRIPTION = core:hw verbatim.
//   7. BAND is never re-derived from CENTER_FREQ_HZ.
//
// The FlatBuffer reader is hand-rolled so the assertions do not share a
// codepath with the builder under test.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const META_JSON = fs.readFileSync(new URL("./fixtures/iqengine-meta.sample.json", import.meta.url));
const META_DOCS = JSON.parse(META_JSON.toString("utf8"));

const BASE_URL = "https://www.iqengine.org";
const SOURCE_URL = `${BASE_URL}/api/datasources/local/local/meta`;

const JOB = {
  adapter: "iqengine-bulk-meta",
  source_url: SOURCE_URL,
  source_name: "IQEngine",
  base_url: BASE_URL,
  account: "local",
  container: "local",
  archive_source: "sigmf",
  archive_name: "iqengine-bulk-meta-meta.json",
};

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function jsonInput(portId, value) {
  return {
    portId,
    typeRef: { wireFormat: "flatbuffer" },
    payload: encoder.encode(JSON.stringify(value)),
  };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createHarness(t, config = null) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    ...(config
      ? { hostcallDispatch: (operation) => (operation === "plugin.getConfig" ? config : null) }
      : {}),
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  return new Map(response.outputs.map((frame) => [frame.portId, frame]));
}

function jsonFrame(map, portId) {
  const frame = map.get(portId);
  assert.ok(frame, `missing output frame ${portId}`);
  return JSON.parse(decoder.decode(frame.payload));
}

function splitStream(payload) {
  const records = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let off = 0;
  while (off < payload.byteLength) {
    assert.ok(off + 4 <= payload.byteLength, "truncated size prefix");
    const len = view.getUint32(off, true);
    off += 4;
    assert.ok(len > 0 && off + len <= payload.byteLength, "invalid record length");
    records.push(payload.subarray(off, off + len));
    off += len;
  }
  return records;
}

function fileIdentifier(record) {
  return decoder.decode(record.subarray(4, 8));
}

function httpResponse(bodyBytes, headers = {}) {
  return { status: 200, headers, bodyB64: Buffer.from(bodyBytes).toString("base64") };
}

// ---------------------------------------------------------------------------
// Generic FlatBuffer table reader; slots are the generated VT_* constants.
// ---------------------------------------------------------------------------

function makeTable(bytes, dv, pos) {
  const vtableOff = pos - dv.getInt32(pos, true);
  const vtableLen = dv.getUint16(vtableOff, true);
  const offsetOf = (slot) => (slot >= vtableLen ? 0 : dv.getUint16(vtableOff + slot, true));
  const abs = (slot) => pos + offsetOf(slot);
  return {
    present: (slot) => offsetOf(slot) !== 0,
    str(slot) {
      if (!this.present(slot)) return null;
      const at = abs(slot);
      const strOff = at + dv.getUint32(at, true);
      const len = dv.getUint32(strOff, true);
      return decoder.decode(bytes.subarray(strOff + 4, strOff + 4 + len));
    },
    f64: (slot, fallback = 0) => (offsetOf(slot) ? dv.getFloat64(abs(slot), true) : fallback),
    i8: (slot, fallback = 0) => (offsetOf(slot) ? dv.getInt8(abs(slot)) : fallback),
    u32: (slot, fallback = 0) => (offsetOf(slot) ? dv.getUint32(abs(slot), true) : fallback),
    u64: (slot, fallback = 0n) =>
      offsetOf(slot) ? dv.getBigUint64(abs(slot), true) : BigInt(fallback),
    bool: (slot, fallback = false) => (offsetOf(slot) ? dv.getUint8(abs(slot)) !== 0 : fallback),
    table(slot) {
      if (!this.present(slot)) return null;
      const at = abs(slot);
      return makeTable(bytes, dv, at + dv.getUint32(at, true));
    },
    tableVector(slot) {
      if (!this.present(slot)) return null;
      const at = abs(slot);
      const vecOff = at + dv.getUint32(at, true);
      const len = dv.getUint32(vecOff, true);
      const out = [];
      for (let i = 0; i < len; i++) {
        const elem = vecOff + 4 + 4 * i;
        out.push(makeTable(bytes, dv, elem + dv.getUint32(elem, true)));
      }
      return out;
    },
  };
}

const IQC = {
  ID: 4, CAPTURE_ID: 6, SOURCE_NAME: 8, SOURCE_URL: 10, SOURCE_RECORD_ID: 12, SOURCE_SHA256: 14,
  RETRIEVED_AT: 16, TITLE: 18, DESCRIPTION: 20, AUTHOR: 22, SIGMF_VERSION: 24, COLLECTION: 26,
  EXTENSIONS: 28, DATATYPE: 30, SAMPLE_RATE_HZ: 32, NUM_CHANNELS: 34, CENTER_FREQ_HZ: 36,
  FREQ_LOWER_EDGE_HZ: 38, FREQ_UPPER_EDGE_HZ: 40, SAMPLE_COUNT: 42, DURATION_SECONDS: 44,
  SAMPLE_OFFSET: 46, METADATA_ONLY: 48, TRAILING_BYTES: 50, CAPTURE_START: 52, CAPTURE_STOP: 54,
  SEGMENTS: 56, ANNOTATIONS: 58, LABELS: 60, GEOLOCATION: 62, HARDWARE: 64, SIGNAL_NAME: 66,
  MODULATION: 68, BAND: 70, NORAD_CAT_ID: 72, OBJECT_ID: 74, EMITTER_ID: 76, RFB_ID: 78,
  LICENSE: 80, LICENSE_URL: 82, ATTRIBUTION: 84, META_DOI: 86, DATA_DOI: 88, PAYLOADS: 90,
  CREATED_AT: 92, UPDATED_AT: 94, SUPERSEDES_IQC_CID: 96,
};
const PAYLOAD = {
  ROLE: 4, URL: 6, FILE_NAME: 8, MEDIA_TYPE: 10, BYTE_LENGTH: 12, BYTE_SHA256: 14, BYTE_SHA512: 16,
  CID: 18, MULTIFORMAT_ADDRESS: 20, CUSTODY: 22, RETRIEVED_AT: 24,
};
const GEO = { LATITUDE_DEG: 4, LONGITUDE_DEG: 6, ALTITUDE_M: 8, UNCERTAINTY_M: 10, METHOD: 12 };
const HW = { DESCRIPTION: 4, MANUFACTURER: 6, MODEL: 8, ANTENNA: 10, RECORDER: 12 };
const SEG = { SAMPLE_START: 4, GLOBAL_INDEX: 6, HEADER_BYTES: 8, CENTER_FREQ_HZ: 10, DATETIME: 12 };
const ANN = {
  SAMPLE_START: 4, SAMPLE_COUNT: 6, FREQ_LOWER_EDGE_HZ: 8, FREQ_UPPER_EDGE_HZ: 10, LABEL: 12,
  COMMENT: 14, GENERATOR: 16, UUID: 18,
};
const EXT = { NAME: 4, VERSION: 6, IS_OPTIONAL: 8 };

const ROLE = { DATA: 0, METADATA: 1, ARCHIVE: 2, PREVIEW: 3, OTHER: 4 };
const CUSTODY = { UPSTREAM_ONLY: 0, PINNED: 1, UNPINNED: 2 };
const BAND_OTHER = 12; // rfBandDesignation.OTHER — the schema default.

function readIqc(record) {
  const dv = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const t = makeTable(record, dv, dv.getUint32(0, true));
  const geo = t.table(IQC.GEOLOCATION);
  const hw = t.table(IQC.HARDWARE);
  return {
    ID: t.str(IQC.ID),
    CAPTURE_ID: t.str(IQC.CAPTURE_ID),
    SOURCE_NAME: t.str(IQC.SOURCE_NAME),
    SOURCE_URL: t.str(IQC.SOURCE_URL),
    SOURCE_RECORD_ID: t.str(IQC.SOURCE_RECORD_ID),
    SOURCE_SHA256: t.str(IQC.SOURCE_SHA256),
    RETRIEVED_AT: t.str(IQC.RETRIEVED_AT),
    TITLE: t.str(IQC.TITLE),
    DESCRIPTION: t.str(IQC.DESCRIPTION),
    AUTHOR: t.str(IQC.AUTHOR),
    SIGMF_VERSION: t.str(IQC.SIGMF_VERSION),
    COLLECTION: t.str(IQC.COLLECTION),
    DATATYPE: t.str(IQC.DATATYPE),
    SAMPLE_RATE_HZ: t.f64(IQC.SAMPLE_RATE_HZ),
    SAMPLE_RATE_PRESENT: t.present(IQC.SAMPLE_RATE_HZ),
    NUM_CHANNELS: t.u32(IQC.NUM_CHANNELS),
    NUM_CHANNELS_PRESENT: t.present(IQC.NUM_CHANNELS),
    CENTER_FREQ_HZ: t.f64(IQC.CENTER_FREQ_HZ),
    CENTER_FREQ_PRESENT: t.present(IQC.CENTER_FREQ_HZ),
    FREQ_LOWER_EDGE_HZ: t.f64(IQC.FREQ_LOWER_EDGE_HZ),
    FREQ_LOWER_PRESENT: t.present(IQC.FREQ_LOWER_EDGE_HZ),
    FREQ_UPPER_EDGE_HZ: t.f64(IQC.FREQ_UPPER_EDGE_HZ),
    FREQ_UPPER_PRESENT: t.present(IQC.FREQ_UPPER_EDGE_HZ),
    SAMPLE_COUNT: t.u64(IQC.SAMPLE_COUNT),
    SAMPLE_COUNT_PRESENT: t.present(IQC.SAMPLE_COUNT),
    DURATION_SECONDS: t.f64(IQC.DURATION_SECONDS),
    DURATION_PRESENT: t.present(IQC.DURATION_SECONDS),
    SAMPLE_OFFSET: t.u64(IQC.SAMPLE_OFFSET),
    METADATA_ONLY: t.bool(IQC.METADATA_ONLY),
    TRAILING_BYTES: t.u64(IQC.TRAILING_BYTES),
    CAPTURE_START: t.str(IQC.CAPTURE_START),
    CAPTURE_STOP: t.str(IQC.CAPTURE_STOP),
    LABELS_PRESENT: t.present(IQC.LABELS),
    GEOLOCATION_PRESENT: t.present(IQC.GEOLOCATION),
    geolocation: geo && {
      LATITUDE_DEG: geo.f64(GEO.LATITUDE_DEG),
      LONGITUDE_DEG: geo.f64(GEO.LONGITUDE_DEG),
      ALTITUDE_M: geo.f64(GEO.ALTITUDE_M),
      ALTITUDE_PRESENT: geo.present(GEO.ALTITUDE_M),
      METHOD: geo.str(GEO.METHOD),
    },
    hardware: hw && {
      DESCRIPTION: hw.str(HW.DESCRIPTION),
      MANUFACTURER: hw.str(HW.MANUFACTURER),
      MODEL: hw.str(HW.MODEL),
      ANTENNA: hw.str(HW.ANTENNA),
      RECORDER: hw.str(HW.RECORDER),
    },
    SIGNAL_NAME: t.str(IQC.SIGNAL_NAME),
    MODULATION: t.str(IQC.MODULATION),
    BAND: t.i8(IQC.BAND, BAND_OTHER),
    BAND_PRESENT: t.present(IQC.BAND),
    NORAD_CAT_ID: t.u32(IQC.NORAD_CAT_ID),
    OBJECT_ID: t.str(IQC.OBJECT_ID),
    EMITTER_ID: t.str(IQC.EMITTER_ID),
    RFB_ID: t.str(IQC.RFB_ID),
    LICENSE: t.str(IQC.LICENSE),
    LICENSE_URL: t.str(IQC.LICENSE_URL),
    ATTRIBUTION: t.str(IQC.ATTRIBUTION),
    META_DOI: t.str(IQC.META_DOI),
    DATA_DOI: t.str(IQC.DATA_DOI),
    CREATED_AT: t.str(IQC.CREATED_AT),
    UPDATED_AT: t.str(IQC.UPDATED_AT),
    segments: (t.tableVector(IQC.SEGMENTS) ?? []).map((s) => ({
      SAMPLE_START: s.u64(SEG.SAMPLE_START),
      GLOBAL_INDEX: s.u64(SEG.GLOBAL_INDEX),
      GLOBAL_INDEX_PRESENT: s.present(SEG.GLOBAL_INDEX),
      HEADER_BYTES: s.u64(SEG.HEADER_BYTES),
      HEADER_BYTES_PRESENT: s.present(SEG.HEADER_BYTES),
      CENTER_FREQ_HZ: s.f64(SEG.CENTER_FREQ_HZ),
      CENTER_FREQ_PRESENT: s.present(SEG.CENTER_FREQ_HZ),
      DATETIME: s.str(SEG.DATETIME),
    })),
    annotations: (t.tableVector(IQC.ANNOTATIONS) ?? []).map((a) => ({
      SAMPLE_START: a.u64(ANN.SAMPLE_START),
      SAMPLE_COUNT: a.u64(ANN.SAMPLE_COUNT),
      FREQ_LOWER_EDGE_HZ: a.f64(ANN.FREQ_LOWER_EDGE_HZ),
      FREQ_UPPER_EDGE_HZ: a.f64(ANN.FREQ_UPPER_EDGE_HZ),
      LABEL: a.str(ANN.LABEL),
      COMMENT: a.str(ANN.COMMENT),
      GENERATOR: a.str(ANN.GENERATOR),
      UUID: a.str(ANN.UUID),
    })),
    extensions: (t.tableVector(IQC.EXTENSIONS) ?? []).map((e) => ({
      NAME: e.str(EXT.NAME),
      VERSION: e.str(EXT.VERSION),
      IS_OPTIONAL: e.bool(EXT.IS_OPTIONAL),
    })),
    payloads: (t.tableVector(IQC.PAYLOADS) ?? []).map((p) => ({
      ROLE: p.i8(PAYLOAD.ROLE, ROLE.OTHER),
      URL: p.str(PAYLOAD.URL),
      FILE_NAME: p.str(PAYLOAD.FILE_NAME),
      MEDIA_TYPE: p.str(PAYLOAD.MEDIA_TYPE),
      BYTE_LENGTH: p.u64(PAYLOAD.BYTE_LENGTH),
      BYTE_LENGTH_PRESENT: p.present(PAYLOAD.BYTE_LENGTH),
      BYTE_SHA256: p.str(PAYLOAD.BYTE_SHA256),
      BYTE_SHA512: p.str(PAYLOAD.BYTE_SHA512),
      CID: p.str(PAYLOAD.CID),
      MULTIFORMAT_ADDRESS: p.str(PAYLOAD.MULTIFORMAT_ADDRESS),
      CUSTODY: p.i8(PAYLOAD.CUSTODY, CUSTODY.UPSTREAM_ONLY),
      RETRIEVED_AT: p.str(PAYLOAD.RETRIEVED_AT),
    })),
  };
}

async function runParse(t, body = META_JSON, headers = {}, job = JOB) {
  const harness = await createHarness(t);
  return harness.invoke({
    methodId: "parse",
    inputs: [jsonInput("job", job), jsonInput("response", httpResponse(body, headers))],
  });
}

async function parsedRecords(t, body = META_JSON, headers = {}) {
  const response = await runParse(t, body, headers);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  const raw = splitStream(outputs.get("iqc_records").payload);
  return { response, outputs, raw, records: raw.map(readIqc) };
}

function docFor(filePath) {
  const doc = META_DOCS.find(
    (d) => d.global["traceability:origin"].file_path === filePath,
  );
  assert.ok(doc, `fixture has no ${filePath}`);
  return doc;
}

function recordFor(records, filePath) {
  const record = records.find((r) => r.CAPTURE_ID === filePath);
  assert.ok(record, `no record for ${filePath}`);
  return record;
}

// ---------------------------------------------------------------------------

test("sigmf-captures artifact passes SDK compliance against the standards tree", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("is a pure node: canonical ABI, WASI-only imports besides the config bridge", async () => {
  const inspection = await inspectModule(readWasm());
  for (const required of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
  for (const name of new Set(inspection.imports.map((e) => e.module))) {
    assert.ok(
      name === "wasi_snapshot_preview1" || name === "space_data_module_host",
      `unexpected import module ${name}`,
    );
  }
});

test("manifest declares zero host capabilities and the $IQC schema", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.capabilities, []);
  assert.equal(manifest.pluginFamily, "data_source");
  assert.deepEqual(manifest.methods.map((m) => m.methodId), ["request", "parse"]);
  assert.deepEqual(manifest.schemasUsed, [
    { schemaName: "IQC.fbs", fileIdentifier: "$IQC", rootTypeName: "IQC" },
  ]);
});

test("request: ONE bulk anonymous fetch of the archive metadata index", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "request", inputs: [jsonInput("tick", {})] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const request = jsonFrame(outputs, "request");
  assert.equal(request.method, "GET");
  assert.equal(request.url, SOURCE_URL, "bulk /meta, never a per-file crawl");
  assert.ok(!/[?&](page|offset|skip)=/.test(request.url), "must not walk pages");
  assert.equal(request.headers.authorization, undefined, "the read surface is anonymous");
  assert.match(request.headers["user-agent"], /^SDN-CatalogEnrichmentBot\/0\.1 \(\+https:\/\//);

  const job = jsonFrame(outputs, "job");
  assert.equal(job.adapter, "iqengine-bulk-meta");
  assert.equal(job.source_name, "IQEngine");
  assert.equal(job.base_url, BASE_URL);
  assert.equal(job.account, "local");
  assert.equal(job.container, "local");
});

test("request: an unregistered source adapter FAILS CLOSED, naming what is registered", async (t) => {
  const harness = await createHarness(t, { sigmf_adapter: "sigidwiki-scrape" });
  const response = await harness.invoke({ methodId: "request", inputs: [jsonInput("tick", {})] });
  assert.notEqual(response.statusCode, 0, "a stub adapter must never silently produce a request");
  assert.equal(response.outputs.length, 0);
  assert.match(response.errorMessage ?? "", /sigidwiki-scrape/);
  assert.match(response.errorMessage ?? "", /iqengine-bulk-meta/);
});

test("parse: one $IQC per capture document, with the archive's own identity", async (t) => {
  const { records, raw } = await parsedRecords(t);
  assert.equal(records.length, META_DOCS.length);
  for (const record of raw) {
    assert.equal(fileIdentifier(record), "$IQC", "record carries the $IQC file identifier");
  }
  for (const doc of META_DOCS) {
    const filePath = doc.global["traceability:origin"].file_path;
    const record = recordFor(records, filePath);
    assert.equal(record.SOURCE_NAME, "IQEngine");
    assert.equal(record.ID, `iqengine:local/local/${filePath}`);
    // The landing page route the archive actually serves.
    assert.ok(record.SOURCE_URL.startsWith(`${BASE_URL}/view/api/local/local/`));
    // Path characters are percent-encoded; the separator is preserved.
    assert.ok(!/ /.test(record.SOURCE_URL), `${filePath} left a raw space in the URL`);
    // The normalization is auditable: the hash is over THIS document's bytes.
    assert.match(record.SOURCE_SHA256, /^[0-9a-f]{64}$/);
    assert.match(record.RETRIEVED_AT, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(record.CREATED_AT, record.UPDATED_AT);
  }
});

test("parse: $IQC is a POINTER RECORD — upstream URLs, UPSTREAM_ONLY custody, no bytes", async (t) => {
  const { records } = await parsedRecords(t);
  for (const record of records) {
    const roles = record.payloads.map((p) => p.ROLE);
    assert.deepEqual(roles, [ROLE.DATA, ROLE.METADATA]);
    for (const payload of record.payloads) {
      assert.ok(
        payload.URL.startsWith(`${BASE_URL}/api/datasources/local/local/`),
        `payload URL does not point upstream: ${payload.URL}`,
      );
      // Nothing is mirrored and nothing is pinned by this lane.
      assert.equal(payload.CUSTODY, CUSTODY.UPSTREAM_ONLY);
      assert.equal(payload.CID, null);
      assert.equal(payload.MULTIFORMAT_ADDRESS, null);
      // BYTE_LENGTH 0 = "the source did not publish a size". It is NOT
      // back-computed from SAMPLE_COUNT x sizeof(DATATYPE).
      assert.equal(payload.BYTE_LENGTH_PRESENT, false);
      // RETRIEVED_AT means "URL last CONFIRMED retrievable" — this module read
      // the metadata index, not the payload, so it must not claim otherwise.
      assert.equal(payload.RETRIEVED_AT, null);
      assert.equal(payload.BYTE_SHA256, null, "no SHA-256 was computed over bytes we never read");
    }
    const data = record.payloads[0];
    assert.ok(data.URL.endsWith(".sigmf-data"));
    assert.equal(data.MEDIA_TYPE, "application/octet-stream");
    const meta = record.payloads[1];
    assert.ok(meta.URL.endsWith(".sigmf-meta"));
    assert.equal(meta.MEDIA_TYPE, "application/json");
  }
});

test("parse: SigMF core:sha512 rides on the DATA payload, in its own field", async (t) => {
  const { records } = await parsedRecords(t);
  let carried = 0;
  for (const doc of META_DOCS) {
    const record = recordFor(records, doc.global["traceability:origin"].file_path);
    const expected = doc.global["core:sha512"] ?? null;
    assert.equal(record.payloads[0].BYTE_SHA512, expected);
    // SHA-512 is never squeezed into the SHA-256 field.
    assert.equal(record.payloads[0].BYTE_SHA256, null);
    if (expected) carried++;
  }
  assert.ok(carried > 0, "fixture must contain at least one core:sha512");
});

test("parse: HERTZ unconverted, and DATATYPE verbatim (Themis rulings 1+2)", async (t) => {
  const { records } = await parsedRecords(t);
  for (const doc of META_DOCS) {
    const g = doc.global;
    const record = recordFor(records, g["traceability:origin"].file_path);
    // Never rescaled to MHz: the SigMF number goes in as-is.
    assert.equal(record.SAMPLE_RATE_HZ, g["core:sample_rate"]);
    const firstFrequency = doc.captures?.[0]?.["core:frequency"];
    if (firstFrequency === undefined) {
      assert.equal(record.CENTER_FREQ_PRESENT, false);
    } else {
      assert.equal(record.CENTER_FREQ_HZ, firstFrequency);
      // A value silently divided by 1e6 would land in the sub-kHz range.
      assert.ok(record.CENTER_FREQ_HZ > 1000, "center frequency looks rescaled");
    }
    // The SigMF token, never re-spelled or normalized to another vocabulary.
    assert.equal(record.DATATYPE, g["core:datatype"]);
    assert.equal(record.SIGMF_VERSION, g["core:version"] ?? null);
  }
  // The fixture must actually exercise more than one datatype spelling.
  assert.ok(new Set(records.map((r) => r.DATATYPE)).size > 1);
});

test("parse: BAND is never re-derived from CENTER_FREQ_HZ (Themis ruling 7)", async (t) => {
  const { records } = await parsedRecords(t);
  for (const record of records) {
    // SigMF states no band designation, so this module states none. The field
    // stays at its schema default rather than being computed from frequency —
    // e.g. a 2.45 GHz capture must NOT be labelled S band here.
    assert.equal(record.BAND_PRESENT, false, `${record.ID} invented a BAND`);
    assert.equal(record.BAND, BAND_OTHER);
  }
  const microwave = recordFor(records, "consumer_microwave");
  assert.equal(microwave.CENTER_FREQ_HZ, 2450000000);
  assert.equal(microwave.BAND, BAND_OTHER);
});

test("parse: GEOLOCATION is GeoJSON [lon,lat], omitted when unpublished (ruling 3)", async (t) => {
  const { records } = await parsedRecords(t);

  // Published, well-formed: GeoJSON order is [longitude, latitude, altitude].
  const ais = recordFor(records, "AIS-Collection-Fort-Smallwood-Pt1-161M975CF-240K0FS-20260730");
  const aisCoords = docFor(ais.CAPTURE_ID).global["core:geolocation"].coordinates;
  assert.equal(ais.GEOLOCATION_PRESENT, true);
  assert.equal(ais.geolocation.LONGITUDE_DEG, aisCoords[0]);
  assert.equal(ais.geolocation.LATITUDE_DEG, aisCoords[1]);
  assert.equal(ais.geolocation.ALTITUDE_M, aisCoords[2]);
  // Positioning method is not stated by SigMF, so it is not asserted.
  assert.equal(ais.geolocation.METHOD, null);

  // Unpublished: OMITTED ENTIRELY. Writing 0,0 would name a real place.
  const noGeo = recordFor(records, "pulsed_ASK");
  assert.equal(docFor("pulsed_ASK").global["core:geolocation"], undefined);
  assert.equal(noGeo.GEOLOCATION_PRESENT, false);
});

test("parse: a transposed lat/lon is REFUSED, not silently swapped", async (t) => {
  const { records, outputs } = await parsedRecords(t);
  // iridium_cf32 publishes coordinates [35.14, -106.51]. Read as GeoJSON that
  // is latitude -106.51, which cannot exist; the contributor transposed them.
  const doc = docFor("iridium_cf32");
  assert.deepEqual(doc.global["core:geolocation"].coordinates, [35.14, -106.51]);
  const record = recordFor(records, "iridium_cf32");
  assert.equal(record.GEOLOCATION_PRESENT, false, "an impossible latitude must not be published");

  // And the refusal is counted, not swallowed.
  const provenance = JSON.parse(
    Buffer.from(jsonFrame(outputs, "iqc_meta").provenance.json, "base64").toString("utf8"),
  );
  assert.ok(provenance.geolocation_refused_out_of_range >= 1);
  assert.equal(
    provenance.records_with_geolocation,
    records.filter((r) => r.GEOLOCATION_PRESENT).length,
  );
});

test("parse: an array-wrapped GeoJSON Point is accepted (the live corpus publishes both)", async (t) => {
  const { records } = await parsedRecords(t);
  const wrapped = META_DOCS.find((d) => Array.isArray(d.global["core:geolocation"]));
  assert.ok(wrapped, "fixture must contain an array-wrapped geolocation");
  const record = recordFor(records, wrapped.global["traceability:origin"].file_path);
  const coords = wrapped.global["core:geolocation"][0].coordinates;
  assert.equal(record.GEOLOCATION_PRESENT, true);
  assert.equal(record.geolocation.LONGITUDE_DEG, coords[0]);
  assert.equal(record.geolocation.LATITUDE_DEG, coords[1]);
});

test("parse: licence is PER RECORDING and verbatim; absent means UNKNOWN TERMS (ruling 5)", async (t) => {
  const { records } = await parsedRecords(t);
  let licensed = 0;
  let unlicensed = 0;
  for (const doc of META_DOCS) {
    const record = recordFor(records, doc.global["traceability:origin"].file_path);
    const upstream = doc.global["core:license"];
    if (upstream === undefined) {
      // No site-wide licence is invented: IQEngine hosts third-party
      // recordings, so silence means UNKNOWN TERMS.
      assert.equal(record.LICENSE, null, `${record.ID} invented a licence`);
      assert.equal(record.LICENSE_URL, null);
      unlicensed++;
    } else {
      // Verbatim: "CC0" is never re-spelled to "CC0-1.0".
      assert.equal(record.LICENSE, upstream);
      assert.equal(record.LICENSE_URL, /^https?:\/\//.test(upstream) ? upstream : null);
      licensed++;
    }
    // No attribution string is fabricated from core:author.
    assert.equal(record.ATTRIBUTION, null);
  }
  assert.ok(licensed > 0 && unlicensed > 0, "fixture must exercise both cases");
  assert.equal(recordFor(records, "iridium_cf32").LICENSE, "CC0");
});

test("parse: SEGMENTS, ANNOTATIONS and EXTENSIONS keep SigMF fidelity (ruling 6)", async (t) => {
  const { records } = await parsedRecords(t);

  // Multi-capture recording -> multiple segments, in source order.
  const synthetic = recordFor(records, "synthetic");
  const syntheticCaptures = docFor("synthetic").captures;
  assert.ok(syntheticCaptures.length > 1);
  assert.equal(synthetic.segments.length, syntheticCaptures.length);
  synthetic.segments.forEach((segment, i) => {
    assert.equal(segment.CENTER_FREQ_HZ, syntheticCaptures[i]["core:frequency"]);
    assert.equal(Number(segment.SAMPLE_START), syntheticCaptures[i]["core:sample_start"]);
  });

  // Annotations, including GENERATOR — a classifier's label and a human's are
  // not interchangeable evidence.
  const annotated = META_DOCS.find((d) => (d.annotations ?? []).some((a) => a["core:generator"]));
  assert.ok(annotated, "fixture must contain a generator-tagged annotation");
  const annotatedRecord = recordFor(records, annotated.global["traceability:origin"].file_path);
  assert.equal(annotatedRecord.annotations.length, annotated.annotations.length);
  annotated.annotations.forEach((a, i) => {
    const got = annotatedRecord.annotations[i];
    assert.equal(Number(got.SAMPLE_START), a["core:sample_start"]);
    assert.equal(Number(got.SAMPLE_COUNT), a["core:sample_count"]);
    assert.equal(got.FREQ_LOWER_EDGE_HZ, a["core:freq_lower_edge"]);
    assert.equal(got.FREQ_UPPER_EDGE_HZ, a["core:freq_upper_edge"]);
    assert.equal(got.LABEL, a["core:label"] ?? null);
    assert.equal(got.GENERATOR, a["core:generator"] ?? null);
    assert.equal(got.UUID, a["core:uuid"] ?? null);
  });

  // core:comment survives as COMMENT, and an annotation that states nothing
  // else stays otherwise empty rather than being padded with zeros.
  const commented = META_DOCS.find((d) => (d.annotations ?? []).some((a) => a["core:comment"]));
  assert.ok(commented, "fixture must contain a commented annotation");
  const commentedRecord = recordFor(records, commented.global["traceability:origin"].file_path);
  const commentedAnnotation = commentedRecord.annotations.find((a) => a.COMMENT);
  assert.ok(commentedAnnotation);
  assert.equal(
    commentedAnnotation.COMMENT,
    commented.annotations.find((a) => a["core:comment"])["core:comment"],
  );
  assert.equal(commentedAnnotation.LABEL, null);
  assert.equal(commentedAnnotation.GENERATOR, null);

  // Extensions.
  const extended = META_DOCS.find((d) => (d.global["core:extensions"] ?? []).length > 0);
  assert.ok(extended);
  const extendedRecord = recordFor(records, extended.global["traceability:origin"].file_path);
  assert.deepEqual(
    extendedRecord.extensions,
    extended.global["core:extensions"].map((e) => ({
      NAME: e.name,
      VERSION: e.version ?? null,
      IS_OPTIONAL: e.optional === true,
    })),
  );
});

test("parse: HARDWARE carries core:hw verbatim and never guesses manufacturer/model", async (t) => {
  const { records } = await parsedRecords(t);
  const withHw = META_DOCS.filter((d) => d.global["core:hw"]);
  assert.ok(withHw.length > 0, "fixture must contain a core:hw");
  for (const doc of withHw) {
    const record = recordFor(records, doc.global["traceability:origin"].file_path);
    assert.equal(record.hardware.DESCRIPTION, doc.global["core:hw"]);
    // "RTL-SDR V3 with dipole antenna" is free text. Splitting it would be a
    // defect, so these stay empty.
    assert.equal(record.hardware.MANUFACTURER, null);
    assert.equal(record.hardware.MODEL, null);
    assert.equal(record.hardware.ANTENNA, null);
    assert.equal(record.hardware.RECORDER, doc.global["core:recorder"] ?? null);
  }
  // A recording with neither hw nor recorder gets NO hardware table at all.
  const bare = recordFor(records, "rfd900p");
  assert.equal(docFor("rfd900p").global["core:hw"], undefined);
  assert.equal(bare.hardware, null);
});

test("parse: SAMPLE_COUNT is stated, DURATION is exactly derived, CAPTURE_STOP is not", async (t) => {
  const { records } = await parsedRecords(t);
  for (const doc of META_DOCS) {
    const g = doc.global;
    const record = recordFor(records, g["traceability:origin"].file_path);
    assert.equal(Number(record.SAMPLE_COUNT), g["traceability:sample_length"]);
    if (record.SAMPLE_COUNT_PRESENT && record.SAMPLE_RATE_HZ > 0) {
      assert.equal(
        record.DURATION_SECONDS,
        Number(record.SAMPLE_COUNT) / record.SAMPLE_RATE_HZ,
      );
    }
    // Not stated by any of these archives, so never written.
    assert.equal(record.CAPTURE_STOP, null);
    assert.equal(record.TITLE, null);
    assert.equal(record.SIGNAL_NAME, null);
    assert.equal(record.MODULATION, null);
    assert.equal(record.LABELS_PRESENT, false);
    // Binding a capture to a catalogued spacecraft is separate evidence-bearing
    // work, never a filename guess.
    assert.equal(record.NORAD_CAT_ID, 0);
    assert.equal(record.OBJECT_ID, null);
    assert.equal(record.EMITTER_ID, null);
    assert.equal(record.RFB_ID, null);
  }
});

test("parse: a misspelled core::datetime yields NO timestamp", async (t) => {
  const { records } = await parsedRecords(t);
  // iridium_cf32's capture key is "core::datetime" (double colon) upstream.
  assert.ok("core::datetime" in docFor("iridium_cf32").captures[0]);
  assert.equal(docFor("iridium_cf32").captures[0]["core:datetime"], undefined);
  const record = recordFor(records, "iridium_cf32");
  assert.equal(record.CAPTURE_START, null, "a misspelled key must not be read as the real one");
  assert.equal(record.segments[0].DATETIME, null);
  // A correctly spelled one IS read.
  const ais = recordFor(records, "AIS-Collection-Fort-Smallwood-Pt1-161M975CF-240K0FS-20260730");
  assert.equal(ais.CAPTURE_START, docFor(ais.CAPTURE_ID).captures[0]["core:datetime"]);
});

test("parse: the occupied band is bounded by annotations, not by guesswork", async (t) => {
  const { records } = await parsedRecords(t);
  for (const doc of META_DOCS) {
    const record = recordFor(records, doc.global["traceability:origin"].file_path);
    const edges = (doc.annotations ?? []).filter(
      (a) => a["core:freq_lower_edge"] !== undefined || a["core:freq_upper_edge"] !== undefined,
    );
    if (edges.length === 0) {
      assert.equal(record.FREQ_LOWER_PRESENT, false, `${record.ID} invented a lower edge`);
      assert.equal(record.FREQ_UPPER_PRESENT, false, `${record.ID} invented an upper edge`);
      continue;
    }
    assert.equal(
      record.FREQ_LOWER_EDGE_HZ,
      Math.min(...edges.map((a) => a["core:freq_lower_edge"])),
    );
    assert.equal(
      record.FREQ_UPPER_EDGE_HZ,
      Math.max(...edges.map((a) => a["core:freq_upper_edge"])),
    );
  }
});

test("parse: ingest meta + batch provenance name the adapter and the refusals", async (t) => {
  const { outputs, records } = await parsedRecords(t, META_JSON, {
    "content-type": "application/json",
  });
  const meta = jsonFrame(outputs, "iqc_meta");
  assert.equal(meta.schema, "IQC.fbs");
  assert.equal(meta.source_name, "IQEngine");
  assert.equal(meta.batch_id, sha256Hex(META_JSON));
  assert.equal(meta.reconcile, "none");

  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.adapter, "iqengine-bulk-meta");
  assert.equal(provenance.registered_adapters, "iqengine-bulk-meta");
  assert.equal(provenance.parser_version, "sigmf-iqc-wasm/v1");
  assert.equal(provenance.source_rows, META_DOCS.length);
  assert.equal(provenance.normalized_count, records.length);
  assert.equal(provenance.custody, "UPSTREAM_ONLY");
  assert.equal(provenance.license_model, "per-recording");
  assert.deepEqual(provenance.units, { frequency: "Hz", sample_rate: "Hz" });
  assert.deepEqual(provenance.source_units, provenance.units);

  assert.deepEqual(Buffer.from(outputs.get("raw").payload), Buffer.from(META_JSON));
});

test("parse: a document with no archive identity is skipped, never given a minted id", async (t) => {
  const body = Buffer.from(
    JSON.stringify([
      { global: { "core:datatype": "cf32_le", "core:sample_rate": 1000000 }, captures: [], annotations: [] },
      META_DOCS[0],
    ]),
  );
  const response = await runParse(t, body);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  const records = splitStream(outputs.get("iqc_records").payload);
  assert.equal(records.length, 1);
  const provenance = JSON.parse(
    Buffer.from(jsonFrame(outputs, "iqc_meta").provenance.json, "base64").toString("utf8"),
  );
  assert.equal(provenance.skipped_no_identity, 1);
  assert.equal(provenance.source_rows, 2);
});

test("parse: an unregistered adapter in the job FAILS CLOSED", async (t) => {
  const response = await runParse(t, META_JSON, {}, { ...JOB, adapter: "zenodo-records" });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.outputs.length, 0);
  assert.match(response.errorMessage ?? "", /zenodo-records/);
});

test("parse: non-200 upstream fails closed (nothing emitted)", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse",
    inputs: [
      jsonInput("job", JOB),
      jsonInput("response", { status: 503, headers: {}, bodyB64: "" }),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.outputs.length, 0);
});

// HTTP 304 Not Modified: the host presented the ETag / Last-Modified it
// recorded from the last 2xx for this URL (sdn-server
// internal/modulert/caps/http_validators.go) and the origin confirmed the
// document is current. No batch exists, so no record port may fire — only the
// single "unchanged" notice, and the invocation SUCCEEDS. Same contract as
// data-source/celestrak-parser.
test("parse answers HTTP 304 with one unchanged notice and zero record frames", async (t) => {
  const job = { ...JOB, dataset_id: "iqengine-bulk-meta" };
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse",
    inputs: [
      jsonInput("job", job),
      jsonInput("response", { status: 304, headers: { Etag: 'W/"x"' }, bodyB64: "" }),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1, "exactly one frame");
  const outputs = outputsByPort(response);
  for (const port of ["iqc_meta", "iqc_records", "raw"]) {
    assert.equal(outputs.has(port), false, `${port} must stay silent`);
  }
  assert.deepEqual(jsonFrame(outputs, "unchanged"), {
    status: 304,
    unchanged: true,
    source_name: job.source_name,
    source_url: job.source_url,
    dataset_id: job.dataset_id,
  });
});

test("parse: an empty index fails closed rather than storing an empty batch", async (t) => {
  const response = await runParse(t, Buffer.from("[]"));
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.outputs.length, 0);
});
