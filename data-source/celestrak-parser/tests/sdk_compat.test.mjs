// data-source/celestrak-parser SDK-compat tests (loop C.8a): the pure
// provider-parser nodes run in the SDK browser harness against the SAME
// fixture payloads sdn-server's internal/ingest tests use, and their
// outputs are asserted structurally: ingest metas carry full attribution
// (batch = sha256 of the payload), record streams are size-prefixed
// FlatBuffers with the right file identifiers, and the runner's failure
// gates (duplicate SATCAT NORAD, SPW staleness, non-200 fetch) reproduce.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import {
  CelestialFrame,
  CelestialFrameWrapper,
  OMM,
  RFMUnion,
} from "spacedatastandards.org/lib/js/OMM/main.js";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
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

// SDS PIV/TAB aligned typeRefs REQUIRE requiredAlignment and byteLength: the
// SDK invoke codec (src/invoke/codec.js normalizeFrameTypeRef) rejects a frame
// without them and the invoke throws before the wasm is ever entered. This
// suite omitted both, so every behavioural test in it was dead — failing
// identically against old and new artifacts, which reads as "the harness is
// broken" rather than "these fixtures are". Repaired under graph task
// modules-guest-nodes-drop-batched-frames.
function jsonInput(portId, value) {
  const payload = encoder.encode(JSON.stringify(value));
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  const map = new Map();
  for (const frame of response.outputs) {
    map.set(frame.portId, frame);
  }
  return map;
}

function jsonFrame(map, portId) {
  const frame = map.get(portId);
  assert.ok(frame, `missing output frame ${portId}`);
  return JSON.parse(decoder.decode(frame.payload));
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

function httpResponse(bodyBytes, headers = {}) {
  return {
    status: 200,
    headers,
    bodyB64: Buffer.from(bodyBytes).toString("base64"),
  };
}

const GP_JOB = {
  source_url: "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv",
  source_name: "celestrak-gp",
  archive_source: "celestrak",
  archive_name: "catalog.csv",
};

// What the request-builder node puts on every job besides attribution: the
// upstream origin and its usage terms.
const ORIGIN_JOB = {
  origin_id: "celestrak.org",
  origin_name: "CelesTrak",
  license: "Only download the data you need, when you are going to use it, and only download data once per update.",
  license_url: "https://celestrak.org/usage-policy.php",
  citation: "CelesTrak Usage Policy, by Dr. T.S. Kelso, https://celestrak.org/usage-policy.php",
};

test("celestrak-parser artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("celestrak-parser artifact is pure: canonical ABI, WASI-only imports", async () => {
  const inspection = await inspectModule(readWasm());
  // No hostcall bridge import at all -> the inspector classifies the module
  // as "standalone" (pure compute node); the canonical ABI exports must
  // still be present.
  assert.equal(inspection.profile, "standalone");
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  for (const required of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("parse_gp produces OMM + MPE streams with full attribution", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp",
    inputs: [jsonInput("job", GP_JOB), jsonInput("response", httpResponse(GP_CSV))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const ommMeta = jsonFrame(outputs, "omm_meta");
  assert.equal(ommMeta.schema, "OMM.fbs");
  assert.equal(ommMeta.provider_id, "space-data-network-02");
  assert.equal(ommMeta.source_name, "celestrak-gp");
  assert.equal(ommMeta.source_url, GP_JOB.source_url);
  assert.equal(ommMeta.batch_id, sha256Hex(GP_CSV));
  assert.equal(ommMeta.content_key_id, "public");
  assert.equal(ommMeta.source_peer, "source:celestrak");
  assert.equal(ommMeta.reconcile, "duplicates");
  assert.deepEqual(ommMeta.archive, { source: "celestrak", name: "catalog.csv" });
  assert.equal(ommMeta.provenance.source, "celestrak-gp");
  const provenance = JSON.parse(Buffer.from(ommMeta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.source_sha256, sha256Hex(GP_CSV));
  assert.equal(provenance.parser_version, "celestrak-gp-wasm/v2");
  assert.equal(provenance.schema_counts["OMM.fbs"], 2);
  assert.equal(provenance.schema_counts["MPE.fbs"], 2);

  const mpeMeta = jsonFrame(outputs, "mpe_meta");
  assert.equal(mpeMeta.schema, "MPE.fbs");
  assert.equal(mpeMeta.batch_id, sha256Hex(GP_CSV));
  assert.equal(mpeMeta.archive, undefined, "raw payload is archived once (OMM meta only)");

  const ommRecords = splitStream(outputs.get("omm_records").payload);
  assert.equal(ommRecords.length, 2);
  for (const record of ommRecords) {
    assert.equal(fileIdentifier(record), "$OMM");
  }
  const mpeRecords = splitStream(outputs.get("mpe_records").payload);
  assert.equal(mpeRecords.length, 2);
  for (const record of mpeRecords) {
    assert.equal(fileIdentifier(record), "$MPE");
  }

  const raw = outputs.get("raw");
  assert.deepEqual(Buffer.from(raw.payload), Buffer.from(GP_CSV), "raw payload passthrough");
});

// CelesTrak GP data are SGP4 mean elements in TEME of date: the GP product
// defines them that way and CelesTrak's own OMM KVN/XML for the same records
// states REF_FRAME = TEME. Every GP OMM therefore declares Earth + TEME of
// date, read here through the published SDS JavaScript bindings (SDS RFM
// CelestialFrame.TEMEOFDATE, SANA OID 1.3.112.4.57.2.25). An OMM without a
// frame is refused by SGP4 consumers such as conjunction-assessment.
test("parse_gp declares CENTER_NAME EARTH and REFERENCE_FRAME TEME of date on every OMM", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp",
    inputs: [jsonInput("job", GP_JOB), jsonInput("response", httpResponse(GP_CSV))],
  });
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

test("parse_gp forwards the job's licence and origin into the ingest meta", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp",
    inputs: [
      jsonInput("job", { ...GP_JOB, ...ORIGIN_JOB, dataset_id: "gp-full-catalog" }),
      jsonInput("response", httpResponse(GP_CSV)),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  for (const port of ["omm_meta", "mpe_meta"]) {
    const meta = jsonFrame(outputs, port);
    assert.equal(meta.license, ORIGIN_JOB.license, `${port} licence`);
    assert.equal(meta.license_url, ORIGIN_JOB.license_url, `${port} licence url`);
    assert.equal(meta.citation, ORIGIN_JOB.citation, `${port} citation`);
    assert.equal(meta.origin_id, "celestrak.org", `${port} origin`);
    assert.equal(meta.origin_name, "CelesTrak", `${port} origin name`);
    assert.equal(meta.dataset_id, "gp-full-catalog", `${port} dataset`);
  }
});

test("parse_gp emits no licence or origin keys the job did not declare", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp",
    inputs: [jsonInput("job", GP_JOB), jsonInput("response", httpResponse(GP_CSV))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const meta = jsonFrame(outputsByPort(response), "omm_meta");
  for (const key of ["license", "license_url", "citation", "origin_id", "origin_name", "dataset_id"]) {
    assert.equal(key in meta, false, `${key} must not be invented`);
  }
});

// The Go host hands headers back under net/http canonical keys ("Etag", not
// "ETag"/"etag"); the provenance record must capture the validator under
// every host spelling so the connector ledger can gate the next pull.
for (const [label, headers] of [
  ["Go canonical Etag", { Etag: 'W/"x"', "Last-Modified": "Fri, 02 Jan 2026 12:00:00 GMT" }],
  ["fetch lower-case etag", { etag: 'W/"x"', "last-modified": "Fri, 02 Jan 2026 12:00:00 GMT" }],
  ["mixed-case ETag", { ETag: 'W/"x"', "Last-Modified": "Fri, 02 Jan 2026 12:00:00 GMT" }],
]) {
  test(`parse_gp captures the response validators under ${label}`, async (t) => {
    const harness = await createHarness(t);
    const response = await harness.invoke({
      methodId: "parse_gp",
      inputs: [jsonInput("job", GP_JOB), jsonInput("response", httpResponse(GP_CSV, headers))],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const meta = jsonFrame(outputsByPort(response), "omm_meta");
    const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
    assert.equal(provenance.etag, 'W/"x"');
    assert.equal(provenance.last_modified, "Fri, 02 Jan 2026 12:00:00 GMT");
  });
}

// HTTP 304 Not Modified: the host sent the recorded validators and the origin
// confirmed the document is current. No batch exists, so no record port may
// fire — only the single "unchanged" notice, and the invocation succeeds.
for (const [methodId, job, recordPorts] of [
  ["parse_gp", { ...GP_JOB, dataset_id: "gp-full-catalog" }, ["omm_meta", "omm_records", "mpe_meta", "mpe_records", "raw"]],
  [
    "parse_satcat",
    { source_url: "https://celestrak.org/pub/satcat.csv", source_name: "celestrak-satcat-csv", dataset_id: "satcat-csv" },
    ["cat_meta", "cat_records", "raw"],
  ],
  [
    "parse_spw",
    { source_url: "https://celestrak.org/SpaceData/SW-All.csv", source_name: "celestrak-space-weather", dataset_id: "sw-all" },
    ["spw_meta", "spw_records", "raw"],
  ],
]) {
  test(`${methodId} answers HTTP 304 with one unchanged notice and zero record frames`, async (t) => {
    const harness = await createHarness(t);
    const response = await harness.invoke({
      methodId,
      inputs: [
        jsonInput("job", job),
        jsonInput("response", { status: 304, headers: { Etag: 'W/"x"' }, bodyB64: "" }),
      ],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1, "exactly one frame");
    const outputs = outputsByPort(response);
    for (const port of recordPorts) assert.equal(outputs.has(port), false, `${port} must stay silent`);
    const notice = jsonFrame(outputs, "unchanged");
    assert.deepEqual(notice, {
      status: 304,
      unchanged: true,
      source_name: job.source_name,
      source_url: job.source_url,
      dataset_id: job.dataset_id,
    });
  });
}

test("parse_gp rejects non-200 fetches", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp",
    inputs: [
      jsonInput("job", GP_JOB),
      jsonInput("response", { status: 503, headers: {}, bodyB64: "" }),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /503/);
});

for (const [label, payload] of [
  ["fixed-width txt", SATCAT_TXT],
  ["csv", SATCAT_CSV],
]) {
  test(`parse_satcat handles the ${label} format`, async (t) => {
    const harness = await createHarness(t);
    const response = await harness.invoke({
      methodId: "parse_satcat",
      inputs: [
        jsonInput("job", {
          source_url: "https://celestrak.org/pub/satcat.txt",
          source_name: label === "csv" ? "celestrak-satcat-csv" : "celestrak-satcat",
          archive_source: "celestrak",
          archive_name: label === "csv" ? "satcat.csv" : "satcat.txt",
        }),
        jsonInput("response", httpResponse(payload)),
      ],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const outputs = outputsByPort(response);
    const catMeta = jsonFrame(outputs, "cat_meta");
    assert.equal(catMeta.schema, "CAT.fbs");
    assert.equal(catMeta.reconcile, "current", "SATCAT is a snapshot source");
    assert.equal(catMeta.batch_id, sha256Hex(payload));
    const catRecords = splitStream(outputs.get("cat_records").payload);
    assert.equal(catRecords.length, 2);
    for (const record of catRecords) {
      assert.equal(fileIdentifier(record), "$CAT");
    }
    if (label === "fixed-width txt") {
      assert.deepEqual(
        catRecords.map(catOwner),
        [118, 118],
        "fixed-width SATCAT lacks OWNER and must encode explicit legacyCountryCode UNK",
      );
      assert.deepEqual(
        catRecords.map(catLaunchSite),
        ["TTM", "AFET"],
        "fixed-width LAUNCH_SITE comes from columns 69-73 of the row",
      );
    } else {
      assert.deepEqual(
        catRecords.map(catLaunchSite),
        ["TYMSC", "AFETR"],
        "CSV LAUNCH_SITE comes from the LAUNCH_SITE column",
      );
      const ownersByNorad = new Map(catRecords.map((record) => [catNoradID(record), catOwner(record)]));
      assert.equal(ownersByNorad.get(40909), 120, "STARLINK-1001 OWNER US from the OWNER column");
    }
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
      inputs: [
        jsonInput("job", { source_url: "https://celestrak.org/pub/satcat.csv", source_name: "celestrak-satcat-csv" }),
        jsonInput("response", httpResponse(payload)),
      ],
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
    inputs: [
      jsonInput("job", {
        source_url: "https://celestrak.org/pub/satcat.csv",
        source_name: "celestrak-satcat-csv",
      }),
      jsonInput("response", httpResponse(ownerCSV)),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);

  const records = splitStream(outputsByPort(response).get("cat_records").payload);
  const ownersByNorad = new Map(records.map((record) => [catNoradID(record), catOwner(record)]));
  assert.equal(ownersByNorad.get(27559), 3, "ALSAT-1 OWNER must decode as legacyCountryCode ALG");
  assert.equal(ownersByNorad.get(25544), 120, "ISS OWNER must decode as legacyCountryCode US");
  assert.equal(ownersByNorad.get(90001), 118, "unknown OWNER must decode as explicit legacyCountryCode UNK");
  assert.equal(ownersByNorad.get(90002), 118, "absent OWNER must decode as explicit legacyCountryCode UNK");
  assert.equal(ownersByNorad.get(90003), 0, "explicit OWNER=AB must remain legacyCountryCode AB");
});

test("parse_satcat rejects duplicate NORAD ids (runner parity)", async (t) => {
  const harness = await createHarness(t);
  const dup = Buffer.concat([SATCAT_TXT, Buffer.from("\n"), SATCAT_TXT]);
  const response = await harness.invoke({
    methodId: "parse_satcat",
    inputs: [
      jsonInput("job", { source_url: "https://x.test", source_name: "celestrak-satcat" }),
      jsonInput("response", httpResponse(dup)),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /duplicate SATCAT NORAD_CAT_ID/);
});

test("parse_spw builds SPW records when the source is fresh", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_spw",
    inputs: [
      jsonInput("job", {
        source_url: "https://celestrak.org/SpaceData/SW-All.csv",
        source_name: "celestrak-space-weather",
        archive_source: "celestrak",
        archive_name: "SW-All.csv",
      }),
      jsonInput(
        "response",
        // Fixture rows end 2026-01-02: a Last-Modified in the same window
        // keeps the 7-day staleness gate green (the reference time).
        httpResponse(SW_CSV, { "last-modified": "Fri, 02 Jan 2026 12:00:00 GMT" }),
      ),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  const spwMeta = jsonFrame(outputs, "spw_meta");
  assert.equal(spwMeta.schema, "SPW.fbs");
  assert.equal(spwMeta.batch_id, sha256Hex(SW_CSV));
  // SW-All.csv is a whole-history snapshot: each batch supersedes the older
  // ones, so the lane converges on one row per DATE (a reconciliation of
  // duplicate snapshots, not a loss).
  assert.equal(spwMeta.reconcile, "current", "SPW snapshot supersedes older batches");
  const spwRecords = splitStream(outputs.get("spw_records").payload);
  assert.equal(spwRecords.length, 2);
  for (const record of spwRecords) {
    assert.equal(fileIdentifier(record), "$SPW");
  }
});

test("parse_spw enforces the 7-day stale-source gate", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_spw",
    inputs: [
      jsonInput("job", {
        source_url: "https://celestrak.org/SpaceData/SW-All.csv",
        source_name: "celestrak-space-weather",
      }),
      // No Last-Modified: the reference falls back to NOW, far past the
      // fixture's 2026-01-02 latest DATE.
      jsonInput("response", httpResponse(SW_CSV)),
    ],
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
  archive_source: "celestrak",
  archive_name: "EOP-All.csv",
  dataset_id: "eop-all",
  ...ORIGIN_JOB,
};
// Fixture rows are 2026-08-30/31 observed + 2026-09-01 predicted: a
// Last-Modified in the same window keeps the 7-day gate green.
const EOP_HEADERS = { "Last-Modified": "Tue, 01 Sep 2026 12:00:00 GMT", Etag: '"154cec7daf3bdd1:0"' };
const ARCSEC_TO_RAD = Math.PI / 648000;

test("parse_eop builds $EOP records with radians in the _HP fields and float32 copies", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_eop",
    inputs: [jsonInput("job", EOP_JOB), jsonInput("response", httpResponse(EOP_CSV, EOP_HEADERS))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const meta = jsonFrame(outputs, "eop_meta");
  assert.equal(meta.schema, "EOP.fbs");
  assert.equal(meta.source_name, "celestrak-eop");
  assert.equal(meta.batch_id, sha256Hex(EOP_CSV), "batch id = sha256 of the fetched payload");
  assert.equal(meta.reconcile, "current", "whole-history snapshot supersedes the previous one");
  assert.equal(meta.origin_id, "celestrak.org");
  assert.equal(meta.dataset_id, "eop-all");
  assert.equal(meta.license, ORIGIN_JOB.license);
  assert.deepEqual(meta.archive, { source: "celestrak", name: "EOP-All.csv" });
  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.parser_version, "celestrak-eop-wasm/v1");
  assert.equal(provenance.schema_counts["EOP.fbs"], 3);
  assert.equal(provenance.etag, '"154cec7daf3bdd1:0"');

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

  assert.deepEqual(Buffer.from(outputs.get("raw").payload), Buffer.from(EOP_CSV));
});

test("parse_eop gates staleness on the newest OBSERVED row", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_eop",
    inputs: [
      jsonInput("job", EOP_JOB),
      // A reference a month past the newest observed DATE (2026-08-31).
      jsonInput("response", httpResponse(EOP_CSV, { "Last-Modified": "Fri, 02 Oct 2026 00:00:00 GMT" })),
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
      jsonInput("job", EOP_JOB),
      jsonInput("response", { status: 304, headers: { Etag: '"154cec7daf3bdd1:0"' }, bodyB64: "" }),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const outputs = outputsByPort(response);
  for (const port of ["eop_meta", "eop_records", "raw"]) assert.equal(outputs.has(port), false, port);
  assert.deepEqual(jsonFrame(outputs, "unchanged"), {
    status: 304,
    unchanged: true,
    source_name: "celestrak-eop",
    source_url: EOP_JOB.source_url,
    dataset_id: "eop-all",
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
  archive_source: "celestrak",
  archive_name: "sort-minRange.csv",
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
  const response = await harness.invoke({
    methodId: "parse_socrates",
    inputs: [jsonInput("job", SOCRATES_JOB), jsonInput("response", httpResponse(SOCRATES_CSV))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const meta = jsonFrame(outputs, "csm_meta");
  assert.equal(meta.schema, "CSM.fbs");
  assert.equal(meta.source_name, "celestrak-socrates-minrange");
  assert.equal(meta.batch_id, sha256Hex(SOCRATES_CSV));
  assert.equal(meta.reconcile, "current", "each sort file is a snapshot of the current list");
  assert.equal(meta.origin_id, "celestrak.org");
  assert.equal(meta.dataset_id, "socrates-minrange");
  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.parser_version, "celestrak-socrates-wasm/v1");
  assert.equal(provenance.schema_counts["CSM.fbs"], 2);

  const records = splitStream(outputs.get("csm_records").payload);
  assert.equal(records.length, 2);
  for (const record of records) assert.equal(fileIdentifier(record), "$CSM");

  const [first, second] = records;
  const object1 = subTable(first, 0);
  const object2 = subTable(first, 2);
  assert.notEqual(object1, 0, "OBJECT_1 present");
  assert.notEqual(object2, 0, "OBJECT_2 present");
  assert.equal(readScalar(first, 2, "u32", object1), 49107, "OBJECT_1.NORAD_CAT_ID");
  assert.equal(readScalar(first, 2, "u32", object2), 47079, "OBJECT_2.NORAD_CAT_ID");
  assert.equal(readString(first, 0, object1), "ONEWEB-0329", "status suffix split off the name");
  assert.equal(readString(first, 0, object2), "SL-14 DEB");
  assert.notEqual(tableField(first, 4, object1), 0, "OPS_STATUS_CODE written explicitly for [+]");
  assert.equal(readScalar(first, 4, "i8", object1), OPS_OPERATIONAL, "[+] -> OPERATIONAL");
  assert.equal(readScalar(first, 4, "i8", object2), OPS_NONOPERATIONAL, "[-] -> NONOPERATIONAL");
  assert.equal(readScalar(first, 1, "f64"), 6.058, "DSE_1");
  assert.equal(readScalar(first, 3, "f64"), 7.833, "DSE_2");
  assert.equal(readScalar(first, 4, "f64"), socratesTca("2026-05-12 04:07:04.871"), "TCA unix seconds, exact");
  assert.ok(Math.abs(readScalar(first, 4, "f64") - Date.parse("2026-05-12T04:07:04.871Z") / 1000) < 1e-6);
  assert.equal(readScalar(first, 5, "f64"), 0.018, "TCA_RANGE km");
  assert.equal(readScalar(first, 6, "f64"), 13.179, "TCA_RELATIVE_SPEED km/s");
  assert.equal(readScalar(first, 7, "f64"), Number("2.170E-02"), "MAX_PROB");
  assert.equal(readScalar(first, 8, "f64"), 0.008, "DILUTION");

  assert.equal(readScalar(second, 2, "u32", subTable(second, 0)), 56963);
  assert.equal(readScalar(second, 2, "u32", subTable(second, 2)), 65204);
  assert.equal(readScalar(second, 4, "f64"), socratesTca("2026-05-11 12:09:59.834"));

  assert.deepEqual(Buffer.from(outputs.get("raw").payload), Buffer.from(SOCRATES_CSV));
});

test("parse_socrates answers HTTP 304 with one unchanged notice and zero record frames", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_socrates",
    inputs: [
      jsonInput("job", SOCRATES_JOB),
      jsonInput("response", { status: 304, headers: {}, bodyB64: "" }),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const outputs = outputsByPort(response);
  for (const port of ["csm_meta", "csm_records", "raw"]) assert.equal(outputs.has(port), false, port);
  assert.equal(jsonFrame(outputs, "unchanged").dataset_id, "socrates-minrange");
});
