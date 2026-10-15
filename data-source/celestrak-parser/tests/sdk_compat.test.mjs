// data-source/celestrak-parser SDK-compat tests on the typed contracts (1.0): the pure provider-parser nodes run in
// the SDK browser harness against the SAME fixture payloads sdn-server's internal/ingest tests use, each fed as the
// HttpResponse (HRSP) hostcap/http-request answers - its CONTEXT the job celestrak-request sends, one size-prefixed
// $ICN record - and their outputs are asserted structurally: IngestRequests (INGQ) carry full attribution (batch =
// sha256 of the payload), record streams are size-prefixed FlatBuffers with the right file identifiers, the raw
// document is the HttpResponse itself, 304 is one FlowNotice, and the runner's failure gates (duplicate SATCAT NORAD,
// SPW/EOP staleness, non-200 fetch) reproduce.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeFlowNotice, decodeHttpResponse, decodeIngestRequest, encodeTimerTick, identifierOf } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { STANDARDS_ROOT, flatbuffers, rawCaseResponseInput, responseInput, sdsLib } from "./frames.mjs";

const { CelestialFrame, CelestialFrameWrapper, OMM, RFMUnion } = await sdsLib("OMM");

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const decoder = new TextDecoder();

const GP_CSV = fs.readFileSync(new URL("./fixtures/celestrak-gp-omm.csv", import.meta.url));
const SATCAT_TXT = fs.readFileSync(new URL("./fixtures/celestrak-satcat.txt", import.meta.url));
const SATCAT_CSV = fs.readFileSync(new URL("./fixtures/celestrak-satcat.csv", import.meta.url));
const SW_CSV = fs.readFileSync(new URL("./fixtures/celestrak-sw-all.csv", import.meta.url));
const EOP_CSV = fs.readFileSync(new URL("./fixtures/celestrak-eop-all.csv", import.meta.url));
const SOCRATES_CSV = fs.readFileSync(new URL("./fixtures/celestrak-socrates-minrange.csv", import.meta.url));

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct" });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  const map = new Map();
  for (const frame of response.outputs) map.set(frame.portId, frame);
  return map;
}

function metaFrame(map, portId) {
  const frame = map.get(portId);
  assert.ok(frame, `missing output frame ${portId}`);
  return decodeIngestRequest(frame.payload);
}

function noticeFrame(map) {
  const frame = map.get("unchanged");
  assert.ok(frame, "missing output frame unchanged");
  return decodeFlowNotice(frame.payload);
}

// The raw output is the HttpResponse the batch was made from, forwarded byte for byte.
function assertRaw(outputs, input, body) {
  const raw = outputs.get("raw");
  assert.ok(raw, "missing raw frame");
  assert.deepEqual(Buffer.from(raw.payload), Buffer.from(input.payload), "the input HttpResponse, verbatim");
  assert.deepEqual(Buffer.from(decodeHttpResponse(raw.payload).body), Buffer.from(body), "its BODY is the payload");
}

// Splits a size-prefixed record stream into unprefixed record buffers.
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

function catFieldOffset(record, fieldIndex) {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const table = view.getUint32(0, true);
  const vtable = table - view.getInt32(table, true);
  return view.getUint16(vtable + 4 + fieldIndex * 2, true);
}

function catNoradID(record) {
  const fieldOffset = catFieldOffset(record, 2);
  assert.notEqual(fieldOffset, 0, "CAT record is missing NORAD_CAT_ID");
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const table = view.getUint32(0, true);
  return view.getUint32(table + fieldOffset, true);
}

// Generic table-field access over an unprefixed FlatBuffer record: the
// absolute offset of field `index` inside the root table, or 0 when absent.
function tableField(record, index, table = null) {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  if (table === null) table = view.getUint32(0, true);
  const vtable = table - view.getInt32(table, true);
  const vtableLen = view.getUint16(vtable, true);
  const slot = 4 + index * 2;
  if (slot + 2 > vtableLen) return 0;
  const fieldOffset = view.getUint16(vtable + slot, true);
  return fieldOffset === 0 ? 0 : table + fieldOffset;
}

function readString(record, index, table = null) {
  const at = tableField(record, index, table);
  if (at === 0) return null;
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const str = at + view.getUint32(at, true);
  const len = view.getUint32(str, true);
  return decoder.decode(record.subarray(str + 4, str + 4 + len));
}

function readScalar(record, index, kind, table = null) {
  const at = tableField(record, index, table);
  if (at === 0) return 0; // absent == schema default (0)
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  switch (kind) {
    case "f64": return view.getFloat64(at, true);
    case "f32": return view.getFloat32(at, true);
    case "u32": return view.getUint32(at, true);
    case "u16": return view.getUint16(at, true);
    case "u8": return view.getUint8(at);
    case "i8": return view.getInt8(at);
    default: throw new Error(`unknown scalar kind ${kind}`);
  }
}

// Absolute position of a nested table stored at field `index`, or 0.
function subTable(record, index) {
  const at = tableField(record, index);
  if (at === 0) return 0;
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  return at + view.getUint32(at, true);
}

// CAT LAUNCH_SITE is field 7 (VT_LAUNCH_SITE = 18).
function catLaunchSite(record) {
  return readString(record, 7);
}

// CAT OWNER is legacyCountryCode field 5. The records emitted by parse_satcat
// are framed with a size prefix; splitStream validates and removes that prefix
// before this FlatBuffer field decode.
function catOwner(record) {
  const fieldOffset = catFieldOffset(record, 5);
  if (fieldOffset === 0) return 0;
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const table = view.getUint32(0, true);
  return view.getInt8(table + fieldOffset);
}


const GP_JOB = {
  source_url: "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv",
  source_name: "celestrak-gp",
  dataset_id: "gp-full-catalog",
};

// What the request-builder node puts on every job besides attribution: the upstream origin and its usage terms.
const ORIGIN_JOB = {
  origin_id: "celestrak.org",
  origin_name: "CelesTrak",
  license: "Only download the data you need, when you are going to use it, and only download data once per update.",
  license_url: "https://celestrak.org/usage-policy.php",
  citation: "CelesTrak Usage Policy, by Dr. T.S. Kelso, https://celestrak.org/usage-policy.php",
};

test("celestrak-parser artifact passes SDK compliance with typed ports only", async () => {
  const manifest = readManifest();
  const report = await validateArtifactWithStandards({ manifest, wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined);
      assert.equal(type.wireFormat, "flatbuffer");
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  const lane = (m, code) => ({ [`${m}.response`]: "HRSP", [`${m}.${code.toLowerCase()}_meta`]: "INGQ", [`${m}.${code.toLowerCase()}_records`]: `$${code}`, [`${m}.raw`]: "HRSP", [`${m}.unchanged`]: "FNTC" });
  assert.deepEqual(ids, { ...lane("parse_gp", "OMM"), "parse_gp.mpe_meta": "INGQ", "parse_gp.mpe_records": "$MPE", ...lane("parse_satcat", "CAT"),
    ...lane("parse_spw", "SPW"), ...lane("parse_eop", "EOP"), ...lane("parse_socrates", "CSM") });
});

test("celestrak-parser artifact is pure: canonical ABI, WASI-only imports", async () => {
  const inspection = await inspectModule(readWasm());
  // No hostcall bridge import at all -> the inspector classifies the module as "standalone" (pure compute node); the
  // canonical ABI exports must still be present.
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["wasi_snapshot_preview1"]);
  for (const required of ["plugin_alloc", "plugin_free", "plugin_invoke_stream", "plugin_get_manifest_flatbuffer", "plugin_get_manifest_flatbuffer_size"]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("parse_gp produces OMM + MPE streams with full attribution", async (t) => {
  const harness = await createHarness(t);
  const input = responseInput(GP_JOB, GP_CSV, { date: "Fri, 02 Jan 2026 12:00:00 GMT" });
  const response = await harness.invoke({ methodId: "parse_gp", inputs: [input] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  assert.deepEqual([...outputs.keys()], ["omm_meta", "omm_records", "raw", "mpe_meta", "mpe_records"]);

  const ommMeta = metaFrame(outputs, "omm_meta");
  assert.equal(ommMeta.schema, "OMM.fbs");
  assert.equal(ommMeta.tags.providerId, "space-data-network-02", "the default provider when the job names none");
  assert.equal(ommMeta.tags.sourceName, "celestrak-gp");
  assert.equal(ommMeta.tags.sourceUrl, GP_JOB.source_url);
  assert.equal(ommMeta.tags.batchId, sha256Hex(GP_CSV));
  assert.equal(ommMeta.tags.contentKeyId, "public");
  assert.equal(ommMeta.tags.sourcePeer, "source:celestrak");
  assert.equal(ommMeta.reconcile, "duplicates");
  assert.deepEqual(ommMeta.archive, { source: "celestrak", name: "catalog.csv" }, "archive naming keyed by the job's dataset");
  const provenance = ommMeta.provenance;
  assert.equal(provenance.sourceUrl, GP_JOB.source_url);
  assert.equal(provenance.httpStatus, 200);
  assert.equal(provenance.sourceSha256, sha256Hex(GP_CSV));
  assert.equal(provenance.retrievedMs, Date.UTC(2026, 0, 2, 12), "retrieved at the response Date, whole seconds");
  assert.deepEqual([provenance.parser, provenance.parserVersion], ["celestrak-gp-wasm", "v2"]);
  assert.deepEqual(provenance.schemaCounts, { "OMM.fbs": 2, "MPE.fbs": 2 });
  assert.equal(provenance.normalizedCount, 4);
  assert.match(provenance.normalizedSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(provenance.warnings, []);
  assert.equal(provenance.fromCache, false);

  const mpeMeta = metaFrame(outputs, "mpe_meta");
  assert.equal(mpeMeta.schema, "MPE.fbs");
  assert.equal(mpeMeta.tags.batchId, sha256Hex(GP_CSV));
  assert.equal(mpeMeta.reconcile, "duplicates");
  assert.equal(mpeMeta.archive, null, "raw payload is archived once (OMM meta only)");
  assert.equal(mpeMeta.provenance, null);

  const ommRecords = splitStream(outputs.get("omm_records").payload);
  assert.equal(ommRecords.length, 2);
  for (const record of ommRecords) assert.equal(fileIdentifier(record), "$OMM");
  const mpeRecords = splitStream(outputs.get("mpe_records").payload);
  assert.equal(mpeRecords.length, 2);
  for (const record of mpeRecords) assert.equal(fileIdentifier(record), "$MPE");

  assertRaw(outputs, input, GP_CSV);
});

// CelesTrak GP data are SGP4 mean elements in TEME of date: the GP product defines them that way and CelesTrak's own
// OMM KVN/XML for the same records states REF_FRAME = TEME. Every GP OMM therefore declares Earth + TEME of date, read
// here through the SDS JavaScript bindings (SDS RFM CelestialFrame.TEMEOFDATE, SANA OID 1.3.112.4.57.2.25). An OMM
// without a frame is refused by SGP4 consumers such as conjunction-assessment.
test("parse_gp declares CENTER_NAME EARTH and REFERENCE_FRAME TEME of date on every OMM", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "parse_gp", inputs: [responseInput(GP_JOB, GP_CSV)] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const ommRecords = splitStream(outputsByPort(response).get("omm_records").payload);
  assert.equal(ommRecords.length, 2);
  const expected = [
    { norad: 25544, name: "ISS (ZARYA)" },
    { norad: 40909, name: "STARLINK-1001" },
  ];
  ommRecords.forEach((record, index) => {
    const omm = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(Uint8Array.from(record)));
    assert.equal(omm.NORAD_CAT_ID(), expected[index].norad);
    assert.equal(omm.OBJECT_NAME(), expected[index].name);
    assert.equal(omm.CENTER_NAME(), "EARTH");
    const frame = omm.REFERENCE_FRAME();
    assert.ok(frame, `NORAD ${expected[index].norad}: REFERENCE_FRAME must be present`);
    assert.equal(frame.REFERENCE_FRAME_type(), RFMUnion.CelestialFrameWrapper);
    const celestial = frame.REFERENCE_FRAME(new CelestialFrameWrapper());
    assert.equal(celestial.frame(), CelestialFrame.TEMEOFDATE);
    assert.equal(CelestialFrame[celestial.frame()], "TEMEOFDATE");
  });
});

// The job's usage terms reach the ingest request's source tags. TAGS.LICENSE is an SPDX identifier the storage-ingest
// record bounds to 64 bytes: the usage-policy SENTENCE is not one, so it is named by reference and its text stays in the
// job; an identifier an operator configured travels as is.
test("parse_gp forwards the job's licence terms into the ingest requests", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "parse_gp", inputs: [responseInput({ ...GP_JOB, ...ORIGIN_JOB }, GP_CSV)] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  for (const port of ["omm_meta", "mpe_meta"]) {
    const meta = metaFrame(outputs, port);
    assert.equal(meta.tags.license, "LicenseRef-CelesTrak-Usage-Policy", `${port} licence identifier`);
    assert.equal(meta.tags.licenseUrl, ORIGIN_JOB.license_url, `${port} licence url`);
    assert.equal(meta.tags.citation, ORIGIN_JOB.citation, `${port} citation`);
  }
  const spdx = await harness.invoke({ methodId: "parse_gp", inputs: [responseInput({ ...GP_JOB, ...ORIGIN_JOB, license: "CC0-1.0" }, GP_CSV)] });
  assert.equal(metaFrame(outputsByPort(spdx), "omm_meta").tags.license, "CC0-1.0", "an identifier travels as is");
});

test("parse_gp emits no licence terms the job did not declare", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "parse_gp", inputs: [responseInput(GP_JOB, GP_CSV)] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const meta = metaFrame(outputsByPort(response), "omm_meta");
  assert.deepEqual([meta.tags.license, meta.tags.licenseUrl, meta.tags.citation], ["", "", ""], "never invented");
});

// HttpResponse header NAMEs are lower-cased by contract; a host that does not normalize them is still read: the
// provenance record captures the validators under every spelling so the connector ledger can gate the next pull.
for (const [label, headers] of [
  ["Go canonical Etag", { Etag: 'W/"x"', "Last-Modified": "Fri, 02 Jan 2026 12:00:00 GMT" }],
  ["fetch lower-case etag", { etag: 'W/"x"', "last-modified": "Fri, 02 Jan 2026 12:00:00 GMT" }],
  ["mixed-case ETag", { ETag: 'W/"x"', "Last-Modified": "Fri, 02 Jan 2026 12:00:00 GMT" }],
]) {
  test(`parse_gp captures the response validators under ${label}`, async (t) => {
    const harness = await createHarness(t);
    for (const input of [responseInput(GP_JOB, GP_CSV, headers), rawCaseResponseInput(GP_JOB, GP_CSV, headers)]) {
      const response = await harness.invoke({ methodId: "parse_gp", inputs: [input] });
      assert.equal(response.statusCode, 0, response.errorMessage);
      const { provenance } = metaFrame(outputsByPort(response), "omm_meta");
      assert.equal(provenance.etag, 'W/"x"');
      assert.equal(provenance.lastModified, "Fri, 02 Jan 2026 12:00:00 GMT");
    }
  });
}

// HTTP 304 Not Modified: the host sent the recorded validators and the origin confirmed the document is current. No
// batch exists, so no record port may fire - only the single "unchanged" FlowNotice, and the invocation succeeds.
for (const [methodId, job, schema, recordPorts] of [
  ["parse_gp", GP_JOB, "OMM.fbs", ["omm_meta", "omm_records", "mpe_meta", "mpe_records", "raw"]],
  ["parse_satcat", { source_url: "https://celestrak.org/pub/satcat.csv", source_name: "celestrak-satcat-csv", dataset_id: "satcat-csv" }, "CAT.fbs", ["cat_meta", "cat_records", "raw"]],
  ["parse_spw", { source_url: "https://celestrak.org/SpaceData/SW-All.csv", source_name: "celestrak-space-weather", dataset_id: "sw-all" }, "SPW.fbs", ["spw_meta", "spw_records", "raw"]],
]) {
  test(`${methodId} answers HTTP 304 with one unchanged notice and zero record frames`, async (t) => {
    const harness = await createHarness(t);
    const response = await harness.invoke({ methodId, inputs: [responseInput(job, new Uint8Array(0), { etag: 'W/"x"' }, 304)] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1, "exactly one frame");
    const outputs = outputsByPort(response);
    for (const port of recordPorts) assert.equal(outputs.has(port), false, `${port} must stay silent`);
    assert.deepEqual(noticeFrame(outputs), {
      kind: "unchanged", schema, providerId: "space-data-network-02", sourceName: job.source_name, batchId: "",
      count: 1, reason: "not-modified", items: [job.source_url], atMs: 0,
    });
  });
}

test("parse_gp rejects non-200 fetches", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "parse_gp", inputs: [responseInput(GP_JOB, new Uint8Array(0), {}, 503)] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "fetch-failed");
  assert.match(response.errorMessage ?? "", /503/);
});

// Pairing is by CONTEXT: a response that carries no $ICN job cannot be attributed and is refused, never guessed.
test("parse_gp refuses a response without its $ICN job, and a frame that is no HttpResponse", async (t) => {
  const harness = await createHarness(t);
  for (const context of [new Uint8Array(0), encodeTimerTick({})]) {
    const response = await harness.invoke({ methodId: "parse_gp", inputs: [responseInput(GP_JOB, GP_CSV, {}, 200, context)] });
    assert.equal(response.errorCode, "missing-context");
    assert.equal(response.outputs.length, 0);
  }
  const notResponse = await harness.invoke({ methodId: "parse_gp", inputs: [{ ...responseInput(GP_JOB, GP_CSV), payload: encodeTimerTick({}) }] });
  assert.equal(notResponse.errorCode, "invalid-response-frame");
});

for (const [label, payload] of [
  ["fixed-width txt", SATCAT_TXT],
  ["csv", SATCAT_CSV],
]) {
  test(`parse_satcat handles the ${label} format`, async (t) => {
    const harness = await createHarness(t);
    const job = {
      source_url: label === "csv" ? "https://celestrak.org/pub/satcat.csv" : "https://celestrak.org/pub/satcat.txt",
      source_name: label === "csv" ? "celestrak-satcat-csv" : "celestrak-satcat",
      dataset_id: label === "csv" ? "satcat-csv" : "satcat",
    };
    const input = responseInput(job, payload);
    const response = await harness.invoke({ methodId: "parse_satcat", inputs: [input] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const outputs = outputsByPort(response);
    const catMeta = metaFrame(outputs, "cat_meta");
    assert.equal(catMeta.schema, "CAT.fbs");
    assert.equal(catMeta.reconcile, "current", "SATCAT is a snapshot source");
    assert.equal(catMeta.tags.batchId, sha256Hex(payload));
    assert.deepEqual(catMeta.archive, { source: "celestrak", name: label === "csv" ? "satcat.csv" : "satcat.txt" });
    assert.deepEqual([catMeta.provenance.parser, catMeta.provenance.parserVersion], ["celestrak-satcat-wasm", "v1"]);
    assert.deepEqual(catMeta.provenance.schemaCounts, { "CAT.fbs": 2 });
    const catRecords = splitStream(outputs.get("cat_records").payload);
    assert.equal(catRecords.length, 2);
    for (const record of catRecords) assert.equal(fileIdentifier(record), "$CAT");
    if (label === "fixed-width txt") {
      assert.deepEqual(catRecords.map(catOwner), [118, 118], "fixed-width SATCAT lacks OWNER and must encode explicit legacyCountryCode UNK");
      assert.deepEqual(catRecords.map(catLaunchSite), ["TTM", "AFET"], "fixed-width LAUNCH_SITE comes from columns 69-73 of the row");
    } else {
      assert.deepEqual(catRecords.map(catLaunchSite), ["TYMSC", "AFETR"], "CSV LAUNCH_SITE comes from the LAUNCH_SITE column");
      const ownersByNorad = new Map(catRecords.map((record) => [catNoradID(record), catOwner(record)]));
      assert.equal(ownersByNorad.get(40909), 120, "STARLINK-1001 OWNER US from the OWNER column");
    }
    assertRaw(outputs, input, payload);
  });
}

test("parse_satcat keeps the builder's TYMSC launch site ONLY when the source has no LAUNCH_SITE column", async (t) => {
  const noSiteCSV = Buffer.from(
    [
      "NORAD_CAT_ID,OBJECT_NAME,OBJECT_ID,OBJECT_TYPE,OPS_STATUS_CODE,LAUNCH_DATE",
      "25544,ISS (ZARYA),1998-067A,PAYLOAD,+,1998-11-20",
    ].join("\n"),
  );
  const emptySiteCSV = Buffer.from(
    [
      "NORAD_CAT_ID,OBJECT_NAME,OBJECT_ID,OBJECT_TYPE,OPS_STATUS_CODE,LAUNCH_DATE,LAUNCH_SITE",
      "25544,ISS (ZARYA),1998-067A,PAYLOAD,+,1998-11-20,",
    ].join("\n"),
  );
  const harness = await createHarness(t);
  for (const [payload, expected, why] of [
    [noSiteCSV, "TYMSC", "no LAUNCH_SITE column -> builder default"],
    [emptySiteCSV, "", "present-but-empty LAUNCH_SITE cell -> empty, never invented"],
  ]) {
    const response = await harness.invoke({
      methodId: "parse_satcat",
      inputs: [responseInput({ source_url: "https://celestrak.org/pub/satcat.csv", source_name: "celestrak-satcat-csv" }, payload)],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const [record] = splitStream(outputsByPort(response).get("cat_records").payload);
    assert.equal(catLaunchSite(record), expected, why);
  }
});

test("parse_satcat maps CSV OWNER codes only from the canonical legacy enum", async (t) => {
  const ownerCSV = Buffer.from(
    [
      "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE",
      "ALSAT-1,2002-054A,27559,PAY,,ALG,2002-11-28,PLMSC,,97.41,98.25,649,620,0.3270,,EA,ORB",
      "ISS (ZARYA),1998-067A,25544,PAY,+,US,1998-11-20,TYMSC,,92.68,51.6,423,417,0.0,,EA,ORB",
      "UNKNOWN-OWNER,2026-001A,90001,PAY,+,NOT_A_COUNTRY,2026-01-01,TYMSC,,90,51,500,490,0.0,,EA,ORB",
      "ABSENT-OWNER,2026-001B,90002,PAY,+,,2026-01-01,TYMSC,,90,51,500,490,0.0,,EA,ORB",
      "EXPLICIT-AB,2026-001C,90003,PAY,+,AB,2026-01-01,TYMSC,,90,51,500,490,0.0,,EA,ORB",
    ].join("\n"),
  );
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_satcat",
    inputs: [responseInput({ source_url: "https://celestrak.org/pub/satcat.csv", source_name: "celestrak-satcat-csv" }, ownerCSV)],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const records = splitStream(outputsByPort(response).get("cat_records").payload);
  const ownersByNorad = new Map(records.map((record) => [catNoradID(record), catOwner(record)]));
  assert.equal(ownersByNorad.get(27559), 3, "ALSAT-1 OWNER must decode as legacyCountryCode ALG");
  assert.equal(ownersByNorad.get(25544), 120, "ISS OWNER must decode as legacyCountryCode US");
  assert.equal(ownersByNorad.get(90001), 118, "unknown OWNER must decode as explicit legacyCountryCode UNK");
  assert.equal(ownersByNorad.get(90002), 118, "absent OWNER must decode as explicit legacyCountryCode UNK");
  assert.equal(ownersByNorad.get(90003), 0, "explicit OWNER=AB must remain legacyCountryCode AB");
  assert.equal(metaFrame(outputsByPort(response), "cat_meta").archive, null, "a job without a known dataset names no archive");
});

test("parse_satcat rejects duplicate NORAD ids (runner parity)", async (t) => {
  const harness = await createHarness(t);
  const dup = Buffer.concat([SATCAT_TXT, Buffer.from("\n"), SATCAT_TXT]);
  const response = await harness.invoke({ methodId: "parse_satcat", inputs: [responseInput({ source_url: "https://x.test", source_name: "celestrak-satcat" }, dup)] });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /duplicate SATCAT NORAD_CAT_ID/);
});

test("parse_spw builds SPW records when the source is fresh", async (t) => {
  const harness = await createHarness(t);
  const job = { source_url: "https://celestrak.org/SpaceData/SW-All.csv", source_name: "celestrak-space-weather", dataset_id: "sw-all" };
  // Fixture rows end 2026-01-02: a Last-Modified in the same window keeps the 7-day staleness gate green.
  const input = responseInput(job, SW_CSV, { "last-modified": "Fri, 02 Jan 2026 12:00:00 GMT" });
  const response = await harness.invoke({ methodId: "parse_spw", inputs: [input] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  const spwMeta = metaFrame(outputs, "spw_meta");
  assert.equal(spwMeta.schema, "SPW.fbs");
  assert.equal(spwMeta.tags.batchId, sha256Hex(SW_CSV));
  // SW-All.csv is a whole-history snapshot: each batch supersedes the older ones, so the lane converges on one row
  // per DATE (a reconciliation of duplicate snapshots, not a loss).
  assert.equal(spwMeta.reconcile, "current", "SPW snapshot supersedes older batches");
  assert.deepEqual(spwMeta.archive, { source: "celestrak", name: "SW-All.csv" });
  assert.deepEqual([spwMeta.provenance.parser, spwMeta.provenance.parserVersion], ["celestrak-space-weather-wasm", "v1"]);
  const spwRecords = splitStream(outputs.get("spw_records").payload);
  assert.equal(spwRecords.length, 2);
  for (const record of spwRecords) assert.equal(fileIdentifier(record), "$SPW");
  assertRaw(outputs, input, SW_CSV);
});

test("parse_spw enforces the 7-day stale-source gate", async (t) => {
  const harness = await createHarness(t);
  // No Last-Modified: the reference falls back to NOW, far past the fixture's 2026-01-02 latest DATE.
  const response = await harness.invoke({
    methodId: "parse_spw",
    inputs: [responseInput({ source_url: "https://celestrak.org/SpaceData/SW-All.csv", source_name: "celestrak-space-weather" }, SW_CSV)],
  });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /stale source timestamp/);
});

// --------------------------------------------------------------------------
// parse_eop — EOP-All.csv -> $EOP. Field indices follow the EOP schema
// (VT_x = 4 + 2*index): DATE 0, MJD 1, X_POLE_WANDER_RADIANS 2,
// UT1_MINUS_UTC_SECONDS 6, TAI_MINUS_UTC_SECONDS 7, DATA_TYPE 9, SERIES 10,
// IAU_CONVENTION 11, X_POLE_WANDER_RADIANS_HP 18, UT1_..._HP 22, LOD_HP 23,
// DATA_SET_EPOCH 24, NUTATION_DPSI_RADIANS 26, NUTATION_DEPS_RADIANS 27.
// --------------------------------------------------------------------------

const EOP_JOB = {
  source_url: "https://celestrak.org/SpaceData/EOP-All.csv",
  source_name: "celestrak-eop",
  dataset_id: "eop-all",
  ...ORIGIN_JOB,
};
// Fixture rows are 2026-08-30/31 observed + 2026-09-01 predicted: a
// Last-Modified in the same window keeps the 7-day gate green.
const EOP_HEADERS = { "Last-Modified": "Tue, 01 Sep 2026 12:00:00 GMT", Etag: '"154cec7daf3bdd1:0"' };
const ARCSEC_TO_RAD = Math.PI / 648000;

test("parse_eop builds $EOP records with radians in the _HP fields and float32 copies", async (t) => {
  const harness = await createHarness(t);
  const input = responseInput(EOP_JOB, EOP_CSV, EOP_HEADERS);
  const response = await harness.invoke({
    methodId: "parse_eop",
    inputs: [input],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const meta = metaFrame(outputs, "eop_meta");
  assert.equal(meta.schema, "EOP.fbs");
  assert.equal(meta.tags.sourceName, "celestrak-eop");
  assert.equal(meta.tags.batchId, sha256Hex(EOP_CSV), "batch id = sha256 of the fetched payload");
  assert.equal(meta.reconcile, "current", "whole-history snapshot supersedes the previous one");
  assert.equal(meta.tags.license, "LicenseRef-CelesTrak-Usage-Policy");
  assert.equal(meta.tags.licenseUrl, ORIGIN_JOB.license_url);
  assert.deepEqual(meta.archive, { source: "celestrak", name: "EOP-All.csv" });
  const provenance = meta.provenance;
  assert.deepEqual([provenance.parser, provenance.parserVersion], ["celestrak-eop-wasm", "v1"]);
  assert.deepEqual(provenance.schemaCounts, { "EOP.fbs": 3 });
  assert.equal(provenance.etag, '"154cec7daf3bdd1:0"');
  assert.equal(provenance.lastModified, "Tue, 01 Sep 2026 12:00:00 GMT");

  const records = splitStream(outputs.get("eop_records").payload);
  assert.equal(records.length, 3);
  for (const record of records) assert.equal(fileIdentifier(record), "$EOP");

  const [first, , predicted] = records;
  assert.equal(readString(first, 0), "2026-08-30T00:00:00Z", "DATE is RFC3339 midnight UTC");
  assert.equal(readScalar(first, 1, "u32"), 61282, "MJD");

  // X = 0.1 arcsec -> 4.84813681109536e-7 rad, authoritative in _HP.
  const xHp = readScalar(first, 18, "f64");
  assert.ok(Math.abs(xHp - 4.84813681109536e-7) < 1e-20, `X_HP=${xHp}`);
  assert.equal(xHp, 0.1 * ARCSEC_TO_RAD, "same arithmetic as the guest, bit-exact");
  assert.equal(readScalar(first, 2, "f32"), Math.fround(xHp), "float32 copy rounds from the _HP value");
  assert.equal(readScalar(first, 19, "f64"), 0.25 * ARCSEC_TO_RAD, "Y_HP");
  assert.equal(readScalar(first, 22, "f64"), 0.0123456, "UT1-UTC seconds (_HP)");
  assert.equal(readScalar(first, 6, "f32"), Math.fround(0.0123456), "UT1-UTC float32 copy");
  assert.equal(readScalar(first, 23, "f64"), 0.000789, "LOD seconds (_HP)");
  assert.equal(readScalar(first, 26, "f64"), -0.105432 * ARCSEC_TO_RAD, "NUTATION_DPSI radians");
  assert.equal(readScalar(first, 27, "f64"), -0.011234 * ARCSEC_TO_RAD, "NUTATION_DEPS radians");
  assert.equal(readScalar(first, 20, "f64"), 0.000321 * ARCSEC_TO_RAD, "DX -> X celestial pole offset");
  assert.equal(readScalar(first, 7, "u16"), 37, "DAT -> TAI_MINUS_UTC_SECONDS");
  assert.equal(readScalar(first, 10, "u8"), 5, "SERIES FINALS2000A");
  assert.equal(readScalar(first, 11, "u8"), 1, "IAU_CONVENTION IAU_2000A");
  assert.equal(readScalar(first, 9, "i8"), 0, "DATA_TYPE O -> OBSERVED");
  assert.equal(readScalar(predicted, 9, "i8"), 1, "DATA_TYPE P -> PREDICTED");
  assert.equal(readString(first, 24), "2026-09-01T12:00:00Z", "DATA_SET_EPOCH = Last-Modified as RFC3339");

  assertRaw(outputs, input, EOP_CSV);
});

test("parse_eop gates staleness on the newest OBSERVED row", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_eop",
    inputs: [
      // A reference a month past the newest observed DATE (2026-08-31).
      responseInput(EOP_JOB, EOP_CSV, { "Last-Modified": "Fri, 02 Oct 2026 00:00:00 GMT" }),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /stale source timestamp/);
});

test("parse_eop answers HTTP 304 with one unchanged notice and zero record frames", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_eop",
    inputs: [
      responseInput(EOP_JOB, new Uint8Array(0), { Etag: '"154cec7daf3bdd1:0"' }, 304),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const outputs = outputsByPort(response);
  for (const port of ["eop_meta", "eop_records", "raw"]) assert.equal(outputs.has(port), false, port);
  assert.deepEqual(noticeFrame(outputs), {
    kind: "unchanged", schema: "EOP.fbs", providerId: "space-data-network-02", sourceName: "celestrak-eop", batchId: "",
    count: 1, reason: "not-modified", items: [EOP_JOB.source_url], atMs: 0,
  });
});

// --------------------------------------------------------------------------
// parse_socrates — SOCRATES sort CSV -> $CSM. CSM fields: OBJECT_1 0, DSE_1 1,
// OBJECT_2 2, DSE_2 3, TCA 4, TCA_RANGE 5, TCA_RELATIVE_SPEED 6, MAX_PROB 7,
// DILUTION 8. Nested CAT: OBJECT_NAME 0, NORAD_CAT_ID 2, OPS_STATUS_CODE 4.
// --------------------------------------------------------------------------

// CAT operationalState: OPERATIONAL = 0, NONOPERATIONAL = 1 (UNKNOWN = 7 is
// the schema default, so a present OPERATIONAL is distinguishable from an
// absent field only by checking presence — which the test does).
const OPS_OPERATIONAL = 0;
const OPS_NONOPERATIONAL = 1;

const SOCRATES_JOB = {
  source_url: "https://celestrak.org/SOCRATES/sort-minRange.csv",
  source_name: "celestrak-socrates-minrange",
  dataset_id: "socrates-minrange",
  ...ORIGIN_JOB,
};

// The guest computes TCA as (whole unix seconds) + (published seconds field
// minus its integer part); the same two operations here make the expected
// value bit-exact rather than "close".
function socratesTca(tcaText) {
  const iso = tcaText.replace(" ", "T") + "Z";
  const whole = Math.floor(Date.parse(iso) / 1000);
  const seconds = Number(tcaText.slice(17));
  return whole + (seconds - Math.floor(seconds));
}

test("parse_socrates builds $CSM records with nested CAT identities and an exact TCA", async (t) => {
  const harness = await createHarness(t);
  const input = responseInput(SOCRATES_JOB, SOCRATES_CSV);
  const response = await harness.invoke({ methodId: "parse_socrates", inputs: [input] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const meta = metaFrame(outputs, "csm_meta");
  assert.equal(meta.schema, "CSM.fbs");
  assert.equal(meta.tags.sourceName, "celestrak-socrates-minrange");
  assert.equal(meta.tags.batchId, sha256Hex(SOCRATES_CSV));
  assert.equal(meta.reconcile, "current", "each sort file is a snapshot of the current list");
  assert.deepEqual(meta.archive, { source: "celestrak", name: "sort-minRange.csv" });
  assert.deepEqual([meta.provenance.parser, meta.provenance.parserVersion], ["celestrak-socrates-wasm", "v1"]);
  assert.deepEqual(meta.provenance.schemaCounts, { "CSM.fbs": 2 });

  const records = splitStream(outputs.get("csm_records").payload);
  assert.equal(records.length, 2);
  for (const record of records) assert.equal(fileIdentifier(record), "$CSM");

  const [first, second] = records;
  const object1 = subTable(first, 0);
  const object2 = subTable(first, 2);
  assert.notEqual(object1, 0, "OBJECT_1 present");
  assert.notEqual(object2, 0, "OBJECT_2 present");
  assert.equal(readScalar(first, 2, "u32", object1), 91001, "OBJECT_1.NORAD_CAT_ID");
  assert.equal(readScalar(first, 2, "u32", object2), 91002, "OBJECT_2.NORAD_CAT_ID");
  assert.equal(readString(first, 0, object1), "SYN-SAT-A", "status suffix split off the name");
  assert.equal(readString(first, 0, object2), "SYN-DEB-B");
  assert.notEqual(tableField(first, 4, object1), 0, "OPS_STATUS_CODE written explicitly for [+]");
  assert.equal(readScalar(first, 4, "i8", object1), OPS_OPERATIONAL, "[+] -> OPERATIONAL");
  assert.equal(readScalar(first, 4, "i8", object2), OPS_NONOPERATIONAL, "[-] -> NONOPERATIONAL");
  assert.equal(readScalar(first, 1, "f64"), 6.058, "DSE_1");
  assert.equal(readScalar(first, 3, "f64"), 7.833, "DSE_2");
  assert.equal(readScalar(first, 4, "f64"), socratesTca("2026-05-12 04:07:04.871"), "TCA unix seconds, exact");
  assert.ok(Math.abs(readScalar(first, 4, "f64") - Date.parse("2026-05-12T04:07:04.871Z") / 1000) < 1e-6);
  assert.equal(readScalar(first, 5, "f64"), 0.021, "TCA_RANGE km");
  assert.equal(readScalar(first, 6, "f64"), 12.87, "TCA_RELATIVE_SPEED km/s");
  assert.equal(readScalar(first, 7, "f64"), Number("3.140E-02"), "MAX_PROB");
  assert.equal(readScalar(first, 8, "f64"), 0.009, "DILUTION");

  assert.equal(readScalar(second, 2, "u32", subTable(second, 0)), 91003);
  assert.equal(readScalar(second, 2, "u32", subTable(second, 2)), 91004);
  assert.equal(readScalar(second, 4, "f64"), socratesTca("2026-05-11 12:09:59.834"));

  assertRaw(outputs, input, SOCRATES_CSV);
});

test("parse_socrates answers HTTP 304 with one unchanged notice and zero record frames", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_socrates",
    inputs: [
      responseInput(SOCRATES_JOB, new Uint8Array(0), {}, 304),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const outputs = outputsByPort(response);
  for (const port of ["csm_meta", "csm_records", "raw"]) assert.equal(outputs.has(port), false, port);
  const notice = noticeFrame(outputs);
  assert.deepEqual([notice.kind, notice.schema, notice.sourceName, notice.items], ["unchanged", "CSM.fbs", "celestrak-socrates-minrange", [SOCRATES_JOB.source_url]]);
});
