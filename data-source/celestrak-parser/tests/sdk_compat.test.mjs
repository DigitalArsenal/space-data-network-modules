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

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const GP_CSV = fs.readFileSync(new URL("./fixtures/celestrak-gp-omm.csv", import.meta.url));
const SATCAT_TXT = fs.readFileSync(new URL("./fixtures/celestrak-satcat.txt", import.meta.url));
const SATCAT_CSV = fs.readFileSync(new URL("./fixtures/celestrak-satcat.csv", import.meta.url));
const SW_CSV = fs.readFileSync(new URL("./fixtures/celestrak-sw-all.csv", import.meta.url));

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
function tableField(record, index) {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const table = view.getUint32(0, true);
  const vtable = table - view.getInt32(table, true);
  const vtableLen = view.getUint16(vtable, true);
  const slot = 4 + index * 2;
  if (slot + 2 > vtableLen) return 0;
  const fieldOffset = view.getUint16(vtable + slot, true);
  return fieldOffset === 0 ? 0 : table + fieldOffset;
}

function readString(record, index) {
  const at = tableField(record, index);
  if (at === 0) return null;
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const str = at + view.getUint32(at, true);
  const len = view.getUint32(str, true);
  return decoder.decode(record.subarray(str + 4, str + 4 + len));
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
