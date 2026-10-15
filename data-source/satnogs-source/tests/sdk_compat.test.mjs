// data-source/satnogs-source SDK-compat tests on the typed contracts (1.0).
//
// The two pure flow nodes run in the SDK browser harness against a fixture cut
// from the LIVE SatNOGS DB transmitters table (see fixtures/PROVENANCE.md):
// TimerTick in -> HttpRequest out (the job, a size-prefixed IngestRequest, in
// CONTEXT); HttpResponse in (the job echoed) -> IngestRequest + $RFB stream +
// the HttpResponse verbatim, or one FlowNotice on a 304. The node config is the
// SDS $PIV plugin.getConfig answer (one ModuleConfig on raw "config").
// The outputs are asserted against the three Themis rulings the parser has to
// encode:
//
//   1. Hz -> MHz is normative. A 136,658,500 Hz downlink MUST decode as
//      136.6585 MHz, never as 136658500.
//   2. One RFB record = one LINK_DIRECTION. A Transceiver/Transponder produces
//      TWO records sharing ID_TRANSMITTER.
//   3. Licence carriage. Every record carries the CC-BY-SA-4.0 attribution in
//      CITATION, and the batch's source tags carry LICENSE / LICENSE_URL /
//      CITATION / SHARE_ALIKE.
//
// Plus the invariants that would silently corrupt the catalogue if they broke:
// POLARIZATION is explicitly UNKNOWN (never the LHCP zero-default), and a
// non-200 fetch fails closed.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import {
  decodeFlowNotice,
  decodeHostCall,
  decodeHttpRequest,
  decodeHttpResponse,
  decodeIngestRequest,
  encodeHttpResponse,
  encodeIngestRequest,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const decoder = new TextDecoder();

const TRANSMITTERS_JSON = fs.readFileSync(
  new URL("./fixtures/satnogs-transmitters.sample.json", import.meta.url),
);

const SOURCE_URL = "https://db.satnogs.org/api/transmitters/?format=json";
const CITATION = "SatNOGS DB, Libre Space Foundation, https://db.satnogs.org/ (CC BY-SA 4.0)";
const RETRIEVED_MS = Date.UTC(2026, 7, 3, 12, 0, 0);

const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
};

// The job as request builds it: one size-prefixed IngestRequest skeleton.
function sizePrefixed(bytes) {
  const out = new Uint8Array(bytes.length + 4);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}
const JOB = sizePrefixed(encodeIngestRequest({
  schema: "RFB.fbs",
  tags: { providerId: "space-data-network-02", sourceName: "satnogs-db", sourceUrl: SOURCE_URL },
  reconcile: "none",
  archive: { source: "satnogs", name: "transmitters.json" },
}));
function readJob(context) {
  assert.equal(new DataView(context.buffer, context.byteOffset).getUint32(0, true), context.length - 4, "CONTEXT is size-prefixed");
  assert.equal(identifierOf(context.subarray(4)), "INGQ", "CONTEXT is one IngestRequest");
  return decodeIngestRequest(context.slice(4));
}

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The SDK harness's BrowserHost answers plugin.getConfig from `config` (one ModuleConfig on raw "config", as the Go node
// answers it). The hostcall import is wrapped only to record the module's calls.
async function createHarness(t, config = {}) {
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    let memory;
    const host = imports.space_data_module_host;
    if (!host) return instantiate(module, imports);
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (opPtr, opLen, ptr, len) => {
        calls.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()));
        return host.call(opPtr, opLen, ptr, len);
      },
    } };
    const result = await instantiate(module, wrapped);
    memory = (result.instance ?? result).exports.memory;
    return result;
  };
  let harness;
  try {
    harness = await createBrowserModuleHarness({
      wasmSource: new Uint8Array(readWasm()),
      manifest: readManifest(),
      surface: "direct",
      hostOptions: { config },
    });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  harness.calls = calls;
  return harness;
}

function outputsByPort(response) {
  const map = new Map();
  for (const frame of response.outputs) map.set(frame.portId, frame);
  return map;
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

const tick = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "timer-satnogs-rf", firedMs: RETRIEVED_MS }) });
function responseInput({ status = 200, body = new Uint8Array(0), headers = {}, context = JOB, error = "" } = {}) {
  return { portId: "response", typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url: SOURCE_URL, status, headers, body, context, error, retrievedMs: RETRIEVED_MS }) };
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

async function runParse(t, body, headers = {}, config = {}) {
  const harness = await createHarness(t, config);
  return harness.invoke({ methodId: "parse", inputs: [responseInput({ body, headers })] });
}

// ---------------------------------------------------------------------------

test("satnogs-source artifact passes SDK compliance with typed ports only", async () => {
  const manifest = readManifest();
  const report = await validateArtifactWithStandards({
    manifest,
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const ids = {};
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      assert.equal(port.acceptedTypeSets.length, 1, port.portId);
      assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
      const [type] = port.acceptedTypeSets[0].allowedTypes;
      assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
      assert.equal(type.wireFormat, "flatbuffer", port.portId);
      ids[`${method.methodId}.${port.portId}`] = type.fileIdentifier;
    }
  }
  assert.deepEqual(ids, {
    "request.tick": "TICK", "request.request": "HREQ",
    "parse.response": "HRSP", "parse.rfb_meta": "INGQ", "parse.rfb_records": "$RFB", "parse.raw": "HRSP", "parse.unchanged": "FNTC",
  });
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
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("manifest declares zero host capabilities (http + storage are the hostcap connectors)", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.capabilities, []);
  assert.equal(manifest.pluginFamily, "data_source");
  assert.deepEqual(manifest.methods.map((m) => m.methodId), ["request", "parse"]);
});

test("request: TimerTick -> ONE bulk HttpRequest with its job (an IngestRequest) in CONTEXT", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "request", inputs: [tick()] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(response.outputs.map((f) => f.portId), ["request"]);
  const request = decodeHttpRequest(response.outputs[0].payload);
  assert.equal(request.method, "GET");
  assert.equal(request.url, SOURCE_URL, "whole-table bulk URL, no pagination cursor");
  assert.ok(!/[?&](page|offset|limit)=/.test(request.url), "must not walk pages");
  // source-policy.json fetchDiscipline: identify yourself, never anonymously.
  assert.match(request.headers["user-agent"], /^SDN-CatalogEnrichmentBot\/0\.1 \(\+https:\/\//);
  assert.match(request.headers["user-agent"], /contact /);
  assert.equal(request.headers.accept, "application/json");
  assert.equal(request.headers["if-none-match"], undefined, "no validators unless CONFIG sets them");
  assert.equal(request.timeoutMs, 120000);
  assert.deepEqual(readJob(request.context), decodeIngestRequest(JOB.slice(4)));
  assert.deepEqual(harness.calls.map((c) => c.op), ["plugin.getConfig"]);
});

test("request: node CONFIG (ModuleConfig) sets the URL, timeout, provider and validators", async (t) => {
  const url = "https://db.satnogs.org/api/transmitters/?format=json&satellite__norad_cat_id=25544";
  const harness = await createHarness(t, {
    satnogs_transmitters_url: url, satnogs_http_timeout_ms: 30000, satnogs_provider_id: "node-x",
    satnogs_if_none_match: 'W/"abc"', satnogs_if_modified_since: "Sun, 03 Aug 2026 00:00:00 GMT",
  });
  const response = await harness.invoke({ methodId: "request", inputs: [tick()] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const request = decodeHttpRequest(response.outputs[0].payload);
  assert.equal(request.url, url);
  assert.equal(request.timeoutMs, 30000);
  assert.equal(request.headers["if-none-match"], 'W/"abc"');
  assert.equal(request.headers["if-modified-since"], "Sun, 03 Aug 2026 00:00:00 GMT");
  const job = readJob(request.context);
  assert.equal(job.tags.providerId, "node-x");
  assert.equal(job.tags.sourceUrl, url);
});

test("parse: RFB stream + IngestRequest carry full attribution and the CC-BY-SA licence", async (t) => {
  const response = await runParse(t, TRANSMITTERS_JSON, {
    "last-modified": "Sun, 03 Aug 2026 00:00:00 GMT",
    etag: 'W/"t1"',
    "content-type": "application/json",
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  assert.deepEqual(response.outputs.map((f) => f.portId), ["rfb_meta", "rfb_records", "raw"]);

  const meta = decodeIngestRequest(outputs.get("rfb_meta").payload);
  assert.equal(meta.schema, "RFB.fbs");
  // Themis ruling 3: the share-alike obligation is machine-readable per batch.
  assert.deepEqual(meta.tags, {
    providerId: "space-data-network-02", sourceName: "satnogs-db", batchId: sha256Hex(TRANSMITTERS_JSON), sourceUrl: SOURCE_URL,
    contentKeyId: "public", sourcePeer: "source:satnogs", license: "CC-BY-SA-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", citation: CITATION, shareAlike: true,
  });
  assert.equal(meta.reconcile, "none");
  assert.deepEqual(meta.archive, { source: "satnogs", name: "transmitters.json" });

  const records = splitStream(outputs.get("rfb_records").payload);
  const p = meta.provenance;
  assert.equal(p.sourceUrl, SOURCE_URL);
  assert.equal(p.httpStatus, 200);
  assert.equal(p.etag, 'W/"t1"');
  assert.equal(p.lastModified, "Sun, 03 Aug 2026 00:00:00 GMT");
  assert.equal(p.contentType, "application/json");
  assert.equal(p.retrievedMs, RETRIEVED_MS, "no Date header: the host's receive time");
  assert.equal(p.parser, "satnogs-source");
  assert.equal(p.parserVersion, "satnogs-rfb-wasm/v1");
  assert.equal(p.sourceSha256, sha256Hex(TRANSMITTERS_JSON));
  // the normalized hash: sha256 over (schema \0 record \0) per record, the runner's writeNormalizedHashRecord
  const h = createHash("sha256");
  for (const r of records) h.update("RFB.fbs").update(Buffer.from([0])).update(r).update(Buffer.from([0]));
  assert.equal(p.normalizedSha256, h.digest("hex"));
  assert.equal(p.normalizedCount, records.length);
  assert.deepEqual(p.schemaCounts, { "RFB.fbs": records.length });
  assert.deepEqual(p.warnings, []);
  assert.equal(p.fromCache, false);
  for (const record of records) {
    assert.equal(fileIdentifier(record), "$RFB", "record carries the $RFB file identifier");
  }
  // the downlink + uplink split the legacy provenance counted, re-derived from the records
  const rows = JSON.parse(TRANSMITTERS_JSON.toString("utf8"));
  assert.equal(records.length, rows.filter((r) => r.downlink_low).length + rows.filter((r) => r.uplink_low).length);

  // raw: the HttpResponse verbatim (its BODY the fetched bytes).
  const raw = decodeHttpResponse(outputs.get("raw").payload);
  assert.deepEqual(Buffer.from(raw.body), Buffer.from(TRANSMITTERS_JSON));
  assert.deepEqual(Buffer.from(outputs.get("raw").payload), Buffer.from(responseInput({ body: TRANSMITTERS_JSON, headers: {
    "last-modified": "Sun, 03 Aug 2026 00:00:00 GMT", etag: 'W/"t1"', "content-type": "application/json" } }).payload));
});

test("parse: the publisher's Date header is the retrieval time when present", async (t) => {
  const response = await runParse(t, TRANSMITTERS_JSON, { date: "Mon, 04 Aug 2026 06:30:00 GMT" });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const meta = decodeIngestRequest(outputsByPort(response).get("rfb_meta").payload);
  assert.equal(meta.provenance.retrievedMs, Date.UTC(2026, 7, 4, 6, 30, 0));
});

test("parse: satnogs_record_cap (a ModuleConfig Number) caps the emitted records", async (t) => {
  const response = await runParse(t, TRANSMITTERS_JSON, {}, { satnogs_record_cap: 3 });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  assert.equal(splitStream(outputs.get("rfb_records").payload).length, 3);
  assert.equal(decodeIngestRequest(outputs.get("rfb_meta").payload).provenance.normalizedCount, 3);
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
  const response = await harness.invoke({ methodId: "parse", inputs: [responseInput({ status: 503 })] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "fetch-failed");
  assert.equal(response.outputs.length, 0);
});

test("parse: a failed exchange (STATUS 0 with ERROR) fails closed, naming the error", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "parse", inputs: [responseInput({ status: 0, error: "timeout" })] });
  assert.equal(response.errorCode, "fetch-failed");
  assert.match(response.errorMessage, /HTTP status 0 \(timeout\)/);
  assert.equal(response.outputs.length, 0);
});

test("parse: a response without its job in CONTEXT is refused", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "parse", inputs: [responseInput({ body: TRANSMITTERS_JSON, context: new Uint8Array(0) })] });
  assert.equal(response.errorCode, "missing-job");
  assert.equal(response.outputs.length, 0);
});

// HTTP 304 Not Modified: the host presented the ETag / Last-Modified it
// recorded from the last 2xx for this URL (sdn-server
// internal/modulert/caps/http_validators.go) and the origin confirmed the
// document is current. No batch exists, so no record port may fire — only the
// single "unchanged" FlowNotice, and the invocation SUCCEEDS.
test("parse answers HTTP 304 with one Unchanged FlowNotice and zero record frames", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "parse", inputs: [responseInput({ status: 304, headers: { etag: 'W/"x"' } })] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1, "exactly one frame");
  assert.equal(response.outputs[0].portId, "unchanged");
  assert.deepEqual(decodeFlowNotice(response.outputs[0].payload), {
    kind: "unchanged", schema: "RFB.fbs", providerId: "space-data-network-02", sourceName: "satnogs-db", batchId: "",
    count: 0, reason: "not-modified", items: [SOURCE_URL], atMs: RETRIEVED_MS,
  });
});

test("parse: an empty table fails closed rather than storing an empty batch", async (t) => {
  const response = await runParse(t, Buffer.from("[]"));
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.outputs.length, 0);
});
