// Shared harness for the cell-tower-source tests on the typed contracts (1.0).
//
// Every frame is a FlatBuffer: the $HTQ request envelope the host pumps in, the
// HttpRequest (HREQ) / HttpResponse (HRSP) runtime types the hostcap/http-request
// connector speaks (CONTEXT echoed, body verbatim), and the SDS records this
// module reads and writes ($APR run contract, $TBS reports and records, $DAV,
// $QRP catalog page, $IRM resume mark). SDS records are read through each
// standard's generated TypeScript (lib/ts, bundled with esbuild), never through
// this module's own builder.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeHttpRequest as encodeHtq } from "space-data-module-sdk/http";
import { decodeHttpRequest, encodeHttpResponse, identifierOf } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

export const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
export const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function loadStandard(code) {
  const esbuild = await import(pathToFileURL(path.join(STANDARDS_ROOT, "node_modules", "esbuild", "lib", "main.js")).href);
  const flatbuffersEntry = fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"));
  const out = await esbuild.build({ entryPoints: [path.join(STANDARDS_ROOT, "lib", "ts", code, "main.ts")], bundle: true, format: "esm", write: false, platform: "neutral", alias: { flatbuffers: flatbuffersEntry }, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
export const flatbuffers = await import(pathToFileURL(fs.realpathSync(path.join(STANDARDS_ROOT, "node_modules", "flatbuffers", "mjs", "flatbuffers.js"))).href);
export const sds = Object.fromEntries(await Promise.all(["APR", "DAV", "QRP", "TBS", "IRM"].map(async (c) => [c, await loadStandard(c)])));

export const typeRef = (schemaName, fileIdentifier, rootTypeName) => ({ schemaName, fileIdentifier, rootTypeName, wireFormat: "flatbuffer" });
export const TYPE = {
  HTQ: typeRef("HttpRequestAbi.fbs", "$HTQ", "HttpRequest"),
  HRSP: typeRef("HttpResponse.fbs", "HRSP", "HttpResponse"),
  APR: typeRef("APR.fbs", "$APR", "APR"),
  TBS: typeRef("TBS.fbs", "$TBS", "TBS"),
  IRM: typeRef("IRM.fbs", "$IRM", "IRM"),
};

export async function harnessFor(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(WASM_PATH),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

/** A real $HTQ envelope, exactly what the host pumps at the flow ingress. */
export function htqRequest({ method = "POST", path: requestPath = "/api/v1/cellular/aggregate", query = "", body = "", headers } = {}) {
  const bodyBytes = typeof body === "string" ? encoder.encode(body) : body;
  return { portId: "request", typeRef: TYPE.HTQ, payload: encodeHtq({ method, path: requestPath, query, headers, body: bodyBytes.length ? bodyBytes : undefined }) };
}

export const byPort = (response) => {
  const map = new Map();
  for (const frame of response.outputs) map.set(frame.portId, frame);
  return map;
};
export const framesFor = (response, portId) => response.outputs.filter((f) => f.portId === portId);

/** Size-prefixed frames of a stream; zero-length prefixes are padding. */
export function splitStream(payload) {
  const bytes = Uint8Array.from(payload);
  const view = new DataView(bytes.buffer);
  const out = [];
  let off = 0;
  while (off < bytes.byteLength) {
    assert.ok(off + 4 <= bytes.byteLength, "truncated size prefix");
    const len = view.getUint32(off, true);
    off += 4;
    if (len === 0) continue;
    assert.ok(off + len <= bytes.byteLength, "invalid record length");
    out.push(bytes.slice(off, off + len));
    off += len;
  }
  return out;
}

export function joinStream(records) {
  const parts = [];
  for (const r of records) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(r.length, 0);
    parts.push(prefix, Buffer.from(r));
    const pad = (8 - ((parts.reduce((n, p) => n + p.length, 0)) % 8)) % 8;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  return new Uint8Array(Buffer.concat(parts));
}

const bbOf = (bytes) => new flatbuffers.ByteBuffer(Uint8Array.from(bytes));
const str = (v) => (v === null || v === undefined ? "" : typeof v === "string" ? v : decoder.decode(v));

/** An $APR as a plain object: params and response headers as maps. */
export function decodeApr(bytes) {
  const bb = bbOf(bytes);
  assert.ok(sds.APR.APR.bufferHasIdentifier(bb), `not an $APR (${identifierOf(bytes)})`);
  const a = sds.APR.APR.getRootAsAPR(bb).unpack();
  const params = {};
  for (const p of a.PARAMETERS) params[str(p.NAME)] = str(p.VALUE);
  const headers = {};
  for (const h of a.RESPONSE_HEADERS) headers[str(h.NAME)] = str(h.VALUE);
  return { ...a, ROUTE: str(a.ROUTE), PATH: str(a.PATH), ERROR_CODE: str(a.ERROR_CODE), ERROR_MESSAGE: str(a.ERROR_MESSAGE), params, headers, raw: a };
}

export function decodeDav(bytes) {
  const bb = bbOf(bytes);
  assert.ok(sds.DAV.DAV.bufferHasIdentifier(bb), `not a $DAV (${identifierOf(bytes)})`);
  return sds.DAV.DAV.getRootAsDAV(bb).unpack();
}

export function decodeIrm(bytes) {
  const bb = bbOf(bytes);
  assert.ok(sds.IRM.IRM.bufferHasIdentifier(bb), `not an $IRM (${identifierOf(bytes)})`);
  return sds.IRM.IRM.getRootAsIRM(bb).unpack();
}

/** A $QRP projection page stream: its header and its rows as {COLUMN: value} objects. */
export function decodeQrpPage(payload) {
  const [first] = splitStream(payload);
  const bb = bbOf(first);
  assert.ok(sds.QRP.QRP.bufferHasIdentifier(bb), "the page is not headed by a $QRP frame");
  const header = sds.QRP.QRP.getRootAsQRP(bb).unpack();
  const K = sds.QRP.qrpValueKind;
  const names = header.COLUMNS.map((c) => str(c.NAME));
  const rows = header.ROWS.map((row) => Object.fromEntries(names.map((n, i) => {
    const v = row.CELLS[i];
    if (!v || v.KIND === K.Null) return [n, null];
    if (v.KIND === K.Bool) return [n, v.BOOL_VALUE];
    if (v.KIND === K.Int) return [n, Number(v.INT_VALUE)];
    if (v.KIND === K.Float) return [n, v.FLOAT_VALUE];
    if (v.KIND === K.Text) return [n, str(v.TEXT_VALUE)];
    return [n, Uint8Array.from(v.BYTES_VALUE)];
  })));
  return { header, columns: header.COLUMNS.map((c) => ({ name: str(c.NAME), type: str(c.TYPE) })), rows };
}

/** The CONTEXT stream of an HttpRequest/HttpResponse: its $APR and optional $IRM. */
export function contextOf(context) {
  const out = { apr: undefined, irm: undefined, aprBytes: undefined, irmBytes: undefined };
  for (const rec of splitStream(context)) {
    const id = identifierOf(rec);
    if (id === "$APR") { out.aprBytes = rec; out.apr = decodeApr(rec); }
    if (id === "$IRM") { out.irmBytes = rec; out.irm = decodeIrm(rec); }
  }
  return out;
}

/** An emitted HttpRequest frame, with its CONTEXT decoded. */
export function descriptorOf(frame) {
  const r = decodeHttpRequest(frame.payload);
  const ctx = contextOf(r.context);
  return { ...r, provider_id: ctx.apr?.params.provider, ctx };
}

/** The HttpResponse hostcap/http-request answers for one request: CONTEXT echoed, body verbatim. */
export function responseFor(descriptor, { status = 200, body = new Uint8Array(), headers = {}, retrievedMs = Date.UTC(2026, 9, 13), context } = {}) {
  return {
    portId: "responses",
    typeRef: TYPE.HRSP,
    payload: encodeHttpResponse({ url: descriptor.url, status, headers, body: Uint8Array.from(body), context: context ?? descriptor.context, retrievedMs }),
  };
}
/** A fetch the host could not perform: STATUS 0, the CONTEXT still echoed. */
export const failedFetch = (descriptor) => ({
  portId: "responses",
  typeRef: TYPE.HRSP,
  payload: encodeHttpResponse({ url: descriptor.url, status: 0, error: "timeout: no answer", context: descriptor.context }),
});

// Presence-aware $TBS reader through the generated TypeScript: a scalar the
// source did not report is ABSENT (undefined), never 0.
const TBS_SLOT = { MCC: 3, MNC: 4, LAC: 5, TAC: 6, RANGE_M: 10, SAMPLES: 11, AVERAGE_SIGNAL_DBM: 12 };
export function readTbs(record) {
  const t = sds.TBS.TBS.getRootAsTBS(bbOf(record));
  const present = (slot) => t.bb.__offset(t.bb_pos, 4 + 2 * slot) !== 0;
  const o = t.unpack();
  const out = { fileIdentifier: identifierOf(record), ...o };
  for (const [k, slot] of Object.entries(TBS_SLOT)) if (!present(slot)) out[k] = undefined;
  out.ID = str(o.ID);
  for (const k of ["NATIVE_ID", "CELL_ID", "LAST_OBSERVED", "OPERATOR", "SITE_NAME", "COUNTRY_CODE"]) out[k] = o[k] === null ? undefined : str(o[k]);
  out.SOURCES = o.SOURCES.map((s) => ({ ...s, PROVIDER_ID: str(s.PROVIDER_ID), LICENSE: str(s.LICENSE), ATTRIBUTION: str(s.ATTRIBUTION), RETRIEVED_AT: str(s.RETRIEVED_AT), NATIVE_ID: s.NATIVE_ID === null ? undefined : str(s.NATIVE_ID) }));
  out.sourcesLength = o.SOURCES.length;
  out.CONSENSUS = o.CONSENSUS ? { ...o.CONSENSUS, WINNING_PROVIDER_ID: str(o.CONSENSUS.WINNING_PROVIDER_ID) } : null;
  return out;
}

/**
 * The reports stream as the normalized reports parse decoded, under the names
 * the old JSON frame used, so the adapter assertions read the same: a field the
 * source did not report is absent.
 */
export function reportsOf(payload) {
  return splitStream(payload).map((rec) => {
    const t = readTbs(rec);
    assert.equal(t.CONSENSUS?.METHOD, sds.TBS.tbsMergeMethod.SINGLE_SOURCE, "a report is a SINGLE_SOURCE $TBS");
    assert.equal(t.SOURCES.length, 1, "a report names exactly its one provider");
    const r = { provider_id: t.SOURCES[0].PROVIDER_ID, radio: t.RADIO, latitude: t.LATITUDE, longitude: t.LONGITUDE, retrieved_at: t.SOURCES[0].RETRIEVED_AT };
    if (t.NATIVE_ID !== undefined) r.native_id = t.NATIVE_ID;
    if (t.MCC !== undefined) r.mcc = t.MCC;
    if (t.MNC !== undefined) r.mnc = t.MNC;
    if (t.LAC !== undefined) r.lac = t.LAC;
    if (t.TAC !== undefined) r.tac = t.TAC;
    if (t.CELL_ID !== undefined) r.cell_id = t.CELL_ID;
    if (t.RANGE_M !== undefined) r.range_m = t.RANGE_M;
    if (t.SAMPLES !== undefined) r.samples = t.SAMPLES;
    if (t.AVERAGE_SIGNAL_DBM !== undefined) r.average_signal_dbm = t.AVERAGE_SIGNAL_DBM;
    if (t.LAST_OBSERVED !== undefined) r.observed_at = Number(t.LAST_OBSERVED);
    if (t.SITE_NAME !== undefined) r.site_name = t.SITE_NAME;
    if (t.OPERATOR !== undefined) r.operator = t.OPERATOR;
    if (t.COUNTRY_CODE !== undefined) r.country_code = t.COUNTRY_CODE;
    return r;
  });
}

/** route for an aggregation body: the HttpRequests it emits, its refusal/answer, its contract. */
export async function routeFor(harness, body, extra = {}) {
  const response = await harness.invoke({ methodId: "route", inputs: [htqRequest({ body: JSON.stringify(body), ...extra })] });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const ports = byPort(response);
  const descriptors = framesFor(response, "requests").map(descriptorOf);
  const decision = ports.get("decision") ? decodeApr(ports.get("decision").payload) : undefined;
  const contract = descriptors[0]?.ctx.apr ?? decision;
  return { response, ports, descriptors, decision, contract };
}

// parse is a FAN-IN node: it accumulates across invocations and emits once, when
// every fetch is in or on the quiet tick after the last response. Drive it the
// way the scheduler does.
export async function drainParse(harness, inputs, maxTicks = 8) {
  let response = await harness.invoke({ methodId: "parse", inputs });
  for (let tick = 0; tick < maxTicks; tick += 1) {
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    const map = byPort(response);
    if (map.get("reports")) return map;
    response = await harness.invoke({ methodId: "parse", inputs: [] });
  }
  throw new Error("parse never emitted reports");
}

export async function deconflict(harness, parsed) {
  const response = await harness.invoke({
    methodId: "deconflict",
    inputs: [
      { portId: "job", typeRef: TYPE.APR, payload: parsed.get("job").payload },
      { portId: "reports", typeRef: TYPE.TBS, payload: parsed.get("reports").payload },
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const map = byPort(response);
  const decision = decodeApr(map.get("decision").payload);
  const h = decision.headers;
  return {
    map,
    decision,
    availability: decodeDav(map.get("availability").payload),
    records: splitStream(map.get("records").payload),
    // The run's counters, as the answer carries them.
    summary: {
      reportsIn: Number(h["x-sdn-reports-in"]),
      sitesOut: Number(h["x-sdn-sites-out"]),
      collapsed: Number(h["x-sdn-collapsed"]),
      multiProviderSites: Number(h["x-sdn-multi-provider-sites"]),
      method: h["x-sdn-merge-method"],
      fullPopulation: h["x-sdn-full-population"] === "true",
      truncated: h["x-sdn-truncated"] === "true",
    },
  };
}

/** Parse the skipped ledger header ("id=code,id=code") into [{provider_id, code}]. */
export const skippedOf = (apr) => (apr?.headers["x-sdn-providers-skipped"] ?? "").split(",").filter(Boolean).map((e) => {
  const [provider_id, code] = e.split("=");
  return { provider_id, code };
});
export const consultedOf = (apr) => (apr?.headers["x-sdn-providers-consulted"] ?? "").split(",").filter(Boolean);

/** Build an $APR (object API) as a plain finished buffer. */
export function buildApr(fields) {
  const { params = {}, headers = {}, ...rest } = fields;
  const a = new sds.APR.APRT();
  Object.assign(a, rest);
  a.PARAMETERS = Object.entries(params).map(([NAME, VALUE]) => new sds.APR.APRParameterT(NAME, VALUE));
  a.RESPONSE_HEADERS = Object.entries(headers).map(([NAME, VALUE]) => new sds.APR.APRParameterT(NAME, VALUE));
  const b = new flatbuffers.Builder(512);
  b.finish(a.pack(b), "$APR");
  return b.asUint8Array().slice();
}

/** Re-pack an unpacked $IRM (object API) after edits. */
export function packIrm(irmT) {
  const b = new flatbuffers.Builder(1024);
  b.finish(irmT.pack(b), "$IRM");
  return b.asUint8Array().slice();
}

/**
 * The CONTEXT cell-tower-ingest's `ingest_plan` writes for one ranged chunk: the
 * ingest run contract ($APR: one provider, full population, fetches 1) and the
 * $IRM the chunk continues. `irm` overrides fields of the mark (object API);
 * pass `irm: null` for a contract alone.
 */
export function ingestContext(providerId, { sourceUrl = `https://example.invalid/${providerId}.csv.gz`, irm = {}, method = "HIGHEST_SAMPLE_COUNT" } = {}) {
  const apr = buildApr({
    ROUTE: "ingest",
    SCHEMA_NAME: "TBS.fbs",
    params: { PROVIDERS: providerId, METHOD: method, LIMIT: "1000000", FULL_POPULATION: "true", provider: providerId, fetches: "1" },
    headers: { "x-sdn-providers-consulted": providerId },
  });
  if (irm === null) return joinStream([apr]);
  const I = sds.IRM;
  const mark = new I.IRMT();
  mark.JOB_ID = `${providerId}@${sourceUrl}`;
  mark.PROVIDER_ID = providerId;
  mark.INGESTOR_ID = "cell-tower-ingest-wasm/v1";
  mark.SOURCE = Object.assign(new I.IRMSourceT(), { SOURCE_URL: sourceUrl });
  mark.STATE = I.irmJobState.IN_PROGRESS;
  mark.RANGE_MODE = I.irmRangeMode.INCLUSIVE_BYTE_RANGE;
  mark.CHUNK_BYTE_BUDGET = 3145728n;
  mark.TARGET_STANDARD = "$TBS";
  mark.RECONCILE_MODE = "none";
  mark.MERGE_POLICY = method;
  mark.UPDATED_AT = "2026-10-13T00:00:00.000Z";
  Object.assign(mark, irm);
  return joinStream([apr, packIrm(mark)]);
}
