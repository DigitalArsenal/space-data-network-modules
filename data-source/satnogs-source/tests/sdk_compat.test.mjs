// data-source/satnogs-source SDK-compat tests.
//
// The two pure flow nodes run in the SDK browser harness against a fixture cut
// from the LIVE SatNOGS DB transmitters table (see fixtures/PROVENANCE.md), and
// their outputs are asserted against the three Themis rulings the parser has to
// encode:
//
//   1. Hz -> MHz is normative. A 136,658,500 Hz downlink MUST decode as
//      136.6585 MHz, never as 136658500.
//   2. One RFB record = one LINK_DIRECTION. A Transceiver/Transponder produces
//      TWO records sharing ID_TRANSMITTER.
//   3. Licence carriage. Every record carries the CC-BY-SA-4.0 attribution in
//      CITATION, and the batch provenance carries license/license_url/citation.
//
// Plus the invariants that would silently corrupt the catalogue if they broke:
// POLARIZATION is explicitly UNKNOWN (never the LHCP zero-default), JSON keys
// are IDL-capitalized, and a non-200 fetch fails closed.

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

const TRANSMITTERS_JSON = fs.readFileSync(
  new URL("./fixtures/satnogs-transmitters.sample.json", import.meta.url),
);

const SOURCE_URL = "https://db.satnogs.org/api/transmitters/?format=json";
const CITATION = "SatNOGS DB, Libre Space Foundation, https://db.satnogs.org/ (CC BY-SA 4.0)";

const JOB = {
  source_url: SOURCE_URL,
  source_name: "satnogs-db",
  archive_source: "satnogs",
  archive_name: "transmitters.json",
};

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function jsonInput(portId, value) {
  const payload = encoder.encode(JSON.stringify(value));
  return {
    portId,
    // Control frames are variable-length UTF-8 JSON. An `acceptsAnyFlatbuffer`
    // port only matches the flatbuffer wire format (an aligned-binary accepted
    // type would have to pin a FIXED byteLength, which a JSON frame has not),
    // so control frames ride the opaque flatbuffer lane — exactly what the
    // flow runtime does on an `opaque: true` edge.
    typeRef: { wireFormat: "flatbuffer" },
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
  for (const frame of response.outputs) map.set(frame.portId, frame);
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

function httpResponse(bodyBytes, headers = {}) {
  return { status: 200, headers, bodyB64: Buffer.from(bodyBytes).toString("base64") };
}

// ---------------------------------------------------------------------------
// Minimal $RFB FlatBuffer reader. Deliberately hand-rolled rather than reusing
// a generated decoder: the point of these assertions is that the BYTES on the
// wire say what the standard says they should, so the test must not share a
// codepath with the builder under test.
// ---------------------------------------------------------------------------

function rfbReader(record) {
  const dv = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const rootOff = dv.getUint32(0, true);
  const vtableOff = rootOff - dv.getInt32(rootOff, true);
  const vtableLen = dv.getUint16(vtableOff, true);

  const fieldOffset = (vtSlot) => {
    if (vtSlot >= vtableLen) return 0;
    return dv.getUint16(vtableOff + vtSlot, true);
  };
  const present = (vtSlot) => fieldOffset(vtSlot) !== 0;
  const abs = (vtSlot) => rootOff + fieldOffset(vtSlot);

  const readString = (vtSlot) => {
    if (!present(vtSlot)) return null;
    const at = abs(vtSlot);
    const strOff = at + dv.getUint32(at, true);
    const len = dv.getUint32(strOff, true);
    return decoder.decode(record.subarray(strOff + 4, strOff + 4 + len));
  };
  const readDouble = (vtSlot, fallback = 0) =>
    present(vtSlot) ? dv.getFloat64(abs(vtSlot), true) : fallback;
  const readInt8 = (vtSlot, fallback = 0) =>
    present(vtSlot) ? dv.getInt8(abs(vtSlot)) : fallback;
  const readUint32 = (vtSlot, fallback = 0) =>
    present(vtSlot) ? dv.getUint32(abs(vtSlot), true) : fallback;
  const readBool = (vtSlot, fallback = false) =>
    present(vtSlot) ? dv.getUint8(abs(vtSlot)) !== 0 : fallback;

  // vtable slots from schema/RFB/main.fbs field order (VT_* / 2 * 2 + 4).
  return {
    ID: readString(4),
    ID_ENTITY: readString(6),
    NAME: readString(8),
    BAND: readInt8(10),
    MODE: readString(12),
    PURPOSE: readString(14),
    FREQ_MIN: readDouble(16),
    FREQ_MAX: readDouble(18),
    CENTER_FREQ: readDouble(20),
    BANDWIDTH: readDouble(22),
    PEAK_GAIN: readDouble(24),
    EDGE_GAIN: readDouble(26),
    BEAMWIDTH: readDouble(28),
    POLARIZATION: readInt8(30),
    POLARIZATION_PRESENT: present(30),
    ERP_PRESENT: present(32),
    EIRP_PRESENT: present(34),
    NORAD_CAT_ID: readUint32(36),
    ID_TRANSMITTER: readString(38),
    LINK_DIRECTION: readInt8(40),
    BAUD: readDouble(42),
    BAUD_PRESENT: present(42),
    SERVICE: readString(44),
    XMT_STATUS: readInt8(46),
    INVERT: readBool(48),
    IARU_COORDINATION: readString(50),
    CITATION: readString(52),
  };
}

const BAND = { UHF: 0, L: 1, S: 2, C: 3, X: 4, KU: 5, K: 6, KA: 7, V: 8, W: 9, Q: 10, EHF: 11, OTHER: 12 };
const LINK = { UPLINK: 0, DOWNLINK: 1 };
const POLARIZATION_UNKNOWN = 6;
const XMT = { UNKNOWN: 0, ACTIVE: 1, INACTIVE: 2, INVALID: 3 };

async function runParse(t, body, headers = {}, job = JOB) {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse",
    inputs: [jsonInput("job", job), jsonInput("response", httpResponse(body, headers))],
  });
  return response;
}

// ---------------------------------------------------------------------------

test("satnogs-source artifact passes SDK compliance against the standards tree", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("satnogs-source is a pure node: canonical ABI, WASI-only imports besides the config bridge", async () => {
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
  const importedModuleNames = Array.from(new Set(inspection.imports.map((e) => e.module))).sort();
  // plugin.getConfig rides the space_data_module_host bridge; nothing else.
  for (const name of importedModuleNames) {
    assert.ok(
      name === "wasi_snapshot_preview1" || name === "space_data_module_host",
      `unexpected import module ${name}`,
    );
  }
});

test("manifest declares zero host capabilities (http + storage are the hostcap connectors)", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.capabilities, []);
  assert.equal(manifest.pluginFamily, "data_source");
  const methodIds = manifest.methods.map((m) => m.methodId);
  assert.deepEqual(methodIds, ["request", "parse"]);
});

test("request: timer tick -> ONE bulk fetch request + attribution job", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "request",
    inputs: [jsonInput("tick", {})],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const request = jsonFrame(outputs, "request");
  assert.equal(request.method, "GET");
  assert.equal(request.url, SOURCE_URL, "whole-table bulk URL, no pagination cursor");
  assert.ok(!/[?&](page|offset|limit)=/.test(request.url), "must not walk pages");
  // source-policy.json fetchDiscipline: identify yourself, never anonymously.
  assert.match(request.headers["user-agent"], /^SDN-CatalogEnrichmentBot\/0\.1 \(\+https:\/\//);
  assert.match(request.headers["user-agent"], /contact /);
  assert.equal(typeof request.timeoutMs, "number");

  const job = jsonFrame(outputs, "job");
  assert.equal(job.source_name, "satnogs-db");
  assert.equal(job.source_url, SOURCE_URL);
  assert.equal(job.archive_source, "satnogs");
  assert.equal(job.archive_name, "transmitters.json");
  assert.ok(job.provider_id.length > 0);
});

test("parse: RFB stream + ingest meta carry full attribution and the CC-BY-SA licence", async (t) => {
  const response = await runParse(t, TRANSMITTERS_JSON, {
    "last-modified": "Sun, 03 Aug 2026 00:00:00 GMT",
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const meta = jsonFrame(outputs, "rfb_meta");
  assert.equal(meta.schema, "RFB.fbs");
  assert.equal(meta.source_name, "satnogs-db");
  assert.equal(meta.source_url, SOURCE_URL);
  assert.equal(meta.batch_id, sha256Hex(TRANSMITTERS_JSON));
  assert.equal(meta.content_key_id, "public");
  assert.equal(meta.source_peer, "source:satnogs");
  assert.equal(meta.reconcile, "none");
  assert.deepEqual(meta.archive, { source: "satnogs", name: "transmitters.json" });

  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.source_sha256, sha256Hex(TRANSMITTERS_JSON));
  assert.equal(provenance.parser_version, "satnogs-rfb-wasm/v1");
  // Themis ruling 3: the share-alike obligation is machine-readable per batch.
  assert.equal(provenance.license, "CC-BY-SA-4.0");
  assert.equal(provenance.license_url, "https://creativecommons.org/licenses/by-sa/4.0/");
  assert.equal(provenance.citation, CITATION);
  assert.equal(provenance.share_alike, true);
  // The Hz/MHz conversion is declared, not implied.
  assert.deepEqual(provenance.units, { frequency: "MHz", baud: "baud" });
  assert.deepEqual(provenance.source_units, { frequency: "Hz" });

  const records = splitStream(outputs.get("rfb_records").payload);
  assert.equal(records.length, provenance.normalized_count);
  assert.equal(provenance.schema_counts["RFB.fbs"], records.length);
  assert.equal(provenance.downlink_records + provenance.uplink_records, records.length);
  for (const record of records) {
    assert.equal(fileIdentifier(record), "$RFB", "record carries the $RFB file identifier");
  }

  // raw payload is the fetched bytes verbatim.
  assert.deepEqual(Buffer.from(outputs.get("raw").payload), Buffer.from(TRANSMITTERS_JSON));
});

test("parse: Hz -> MHz is applied to EVERY frequency field (Themis ruling 1)", async (t) => {
  const response = await runParse(t, TRANSMITTERS_JSON);
  const records = splitStream(outputsByPort(response).get("rfb_records").payload);
  const rows = JSON.parse(TRANSMITTERS_JSON.toString("utf8"));

  const byId = new Map(records.map((r) => [rfbReader(r).ID, rfbReader(r)]));
  for (const row of rows) {
    if (row.downlink_low) {
      const rfb = byId.get(`satnogs:${row.uuid}:DOWNLINK`);
      assert.ok(rfb, `missing downlink record for ${row.uuid}`);
      assert.equal(rfb.FREQ_MIN, row.downlink_low / 1e6);
      assert.equal(rfb.FREQ_MAX, (row.downlink_high ?? row.downlink_low) / 1e6);
      assert.equal(rfb.CENTER_FREQ, (rfb.FREQ_MIN + rfb.FREQ_MAX) / 2);
      // A Hz value smuggled into a MHz field is the 10^6 defect this guards.
      assert.ok(rfb.CENTER_FREQ < 1e6, `${rfb.ID} center freq looks like Hz: ${rfb.CENTER_FREQ}`);
    }
    if (row.uplink_low) {
      const rfb = byId.get(`satnogs:${row.uuid}:UPLINK`);
      assert.ok(rfb, `missing uplink record for ${row.uuid}`);
      assert.equal(rfb.FREQ_MIN, row.uplink_low / 1e6);
    }
  }
});

test("parse: a Transceiver becomes UPLINK + DOWNLINK sharing ID_TRANSMITTER (Themis ruling 2)", async (t) => {
  const response = await runParse(t, TRANSMITTERS_JSON);
  const records = splitStream(outputsByPort(response).get("rfb_records").payload).map(rfbReader);
  const rows = JSON.parse(TRANSMITTERS_JSON.toString("utf8"));

  const twoWay = rows.filter((r) => r.uplink_low && r.downlink_low);
  assert.ok(twoWay.length > 0, "fixture must contain at least one two-way device");
  for (const row of twoWay) {
    const pair = records.filter((r) => r.ID_TRANSMITTER === row.uuid);
    assert.equal(pair.length, 2, `${row.uuid} (${row.type}) must produce exactly two records`);
    const directions = pair.map((r) => r.LINK_DIRECTION).sort();
    assert.deepEqual(directions, [LINK.UPLINK, LINK.DOWNLINK].sort());
    // BAUD/INVERT are single per-device values: they bind to ONE record, never
    // both, so neither direction claims a measurement the source never made.
    assert.equal(pair.filter((r) => r.BAUD_PRESENT).length <= 1, true);
  }

  const oneWay = rows.filter((r) => r.downlink_low && !r.uplink_low);
  for (const row of oneWay) {
    const only = records.filter((r) => r.ID_TRANSMITTER === row.uuid);
    assert.equal(only.length, 1);
    assert.equal(only[0].LINK_DIRECTION, LINK.DOWNLINK);
  }
});

test("parse: POLARIZATION is written EXPLICITLY as UNKNOWN, never the LHCP zero-default", async (t) => {
  const response = await runParse(t, TRANSMITTERS_JSON);
  const records = splitStream(outputsByPort(response).get("rfb_records").payload).map(rfbReader);
  for (const rfb of records) {
    assert.equal(rfb.POLARIZATION_PRESENT, true, `${rfb.ID} leaves POLARIZATION unset`);
    assert.equal(rfb.POLARIZATION, POLARIZATION_UNKNOWN);
  }
  // SatNOGS publishes no ERP/EIRP: absent, not a fabricated 0 dBW.
  for (const rfb of records) {
    assert.equal(rfb.ERP_PRESENT, false);
    assert.equal(rfb.EIRP_PRESENT, false);
    assert.equal(rfb.PURPOSE, null);
  }
});

test("parse: BAND is the honest IEEE projection and NAME keeps the full designation", async (t) => {
  const response = await runParse(t, TRANSMITTERS_JSON);
  const records = splitStream(outputsByPort(response).get("rfb_records").payload).map(rfbReader);
  for (const rfb of records) {
    const mhz = rfb.CENTER_FREQ;
    if (mhz >= 2000 && mhz < 4000) {
      assert.equal(rfb.BAND, BAND.S, `${rfb.ID} at ${mhz} MHz must be S band`);
      assert.equal(rfb.NAME, "S");
    } else if (mhz >= 300 && mhz < 1000) {
      assert.equal(rfb.BAND, BAND.UHF);
      assert.equal(rfb.NAME, "UHF");
    } else if (mhz >= 30 && mhz < 300) {
      // rfBandDesignation has no VHF member: BAND takes OTHER and NAME keeps
      // the real designation. Asserting UHF here would be the mislabel.
      assert.equal(rfb.BAND, BAND.OTHER, `${rfb.ID} at ${mhz} MHz must not claim UHF`);
      assert.equal(rfb.NAME, "VHF");
    }
  }
});

test("parse: every record carries the licence CITATION and NORAD binding verbatim", async (t) => {
  const response = await runParse(t, TRANSMITTERS_JSON);
  const records = splitStream(outputsByPort(response).get("rfb_records").payload).map(rfbReader);
  const rows = new Map(JSON.parse(TRANSMITTERS_JSON.toString("utf8")).map((r) => [r.uuid, r]));
  for (const rfb of records) {
    assert.equal(rfb.CITATION, CITATION, `${rfb.ID} lost the CC-BY-SA attribution`);
    const row = rows.get(rfb.ID_TRANSMITTER);
    assert.equal(rfb.NORAD_CAT_ID, row.norad_cat_id ?? 0);
    assert.equal(rfb.ID_ENTITY, row.sat_id);
    assert.equal(rfb.SERVICE, row.service ?? null);
    assert.equal(rfb.IARU_COORDINATION, row.iaru_coordination ?? null);
    const expectStatus =
      row.status === "active" ? XMT.ACTIVE : row.status === "inactive" ? XMT.INACTIVE : XMT.UNKNOWN;
    assert.equal(rfb.XMT_STATUS, expectStatus);
  }
});

test("parse: an uplink with no uplink_mode leaves MODE absent rather than copying the downlink", async (t) => {
  const body = Buffer.from(
    JSON.stringify([
      {
        uuid: "TESTuplinkNoMode00000",
        description: "test",
        type: "Transceiver",
        mode: "FM",
        uplink_mode: null,
        sat_id: "TEST-0000-0000-0000-0000",
        norad_cat_id: 99999,
        status: "active",
        service: "Amateur",
        iaru_coordination: "N/A",
        invert: false,
        baud: null,
        downlink_low: 435000000,
        uplink_low: 145900000,
      },
    ]),
  );
  const response = await runParse(t, body);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const records = splitStream(outputsByPort(response).get("rfb_records").payload).map(rfbReader);
  const uplink = records.find((r) => r.LINK_DIRECTION === LINK.UPLINK);
  const downlink = records.find((r) => r.LINK_DIRECTION === LINK.DOWNLINK);
  assert.equal(downlink.MODE, "FM");
  assert.equal(uplink.MODE, null, "uplink modulation is unknown; copying `mode` would be a guess");
  assert.equal(uplink.FREQ_MIN, 145.9);
  assert.equal(downlink.FREQ_MIN, 435);
  assert.equal(downlink.BAND, BAND.UHF);
  assert.equal(uplink.BAND, BAND.OTHER); // 145.9 MHz is VHF
  assert.equal(uplink.NAME, "VHF");
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

test("parse: a 304 / empty table fails closed rather than storing an empty batch", async (t) => {
  const response = await runParse(t, Buffer.from("[]"));
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.outputs.length, 0);
});
