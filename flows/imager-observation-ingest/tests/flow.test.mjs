/*
 * Flow-level test for the compiled imager-observation-ingest flow - BRIDGE mode: the SAME runtime.wasm the Go host
 * serves from its cron timer, instantiated in the JS flow runtime host (WasmEdge leg). A timer tick enters plan and the
 * whole listing -> select -> fetch -> parse -> ingest chain runs linked-direct inside the artifact's linear memory; the
 * only host crossings are the declared hostcalls, stubbed here in the Go host's dialect: plugin.getConfig,
 * http.request (S3 listings and NetCDF4 GETs, byte ranges answered 206) and storage.ingest_with_source.
 *
 * Data: the parser's real GOES-19 mesoscale files (data-source/imager-observation-parser/tests/fixtures), listed and
 * served under the full-disk product folders the source fetches; their world codes must equal the reference
 * producer's exactly (the same expected codes the parser's own test holds it to).
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RUNTIME = new URL("../dist/runtime.wasm", import.meta.url);
const SET = new URL("../../../data-source/imager-observation-parser/tests/fixtures/goes19-m1-2026280-0600/", import.meta.url);
const EXPECTED = JSON.parse(fs.readFileSync(new URL("expected.json", SET), "utf8"));
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/WXF/main.js"));
const flatbuffers = createRequire(WXF_LIB)("flatbuffers");
const wxfLib = await import(WXF_LIB.href);

const FRAME_MS = Date.UTC(2026, 9, 7, 6);
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
// field -> the full-disk product folder the source lists for it (and the band token for imagery)
const PRODUCT = { cloud_top_height: ["ABI-L2-ACHA2KMF", ""], reflectance_064um: ["ABI-L2-CMIPF", "C02"], brightness_temperature_10um: ["ABI-L2-CMIPF", "C13"],
  cloud_mask: ["ABI-L2-ACMF", ""], cloud_phase: ["ABI-L2-ACTPF", ""] };
const FIELDS = ["cloud_top_height", "reflectance_064um", "brightness_temperature_10um", "cloud_mask", "cloud_phase"];

// Each fixture file listed under its full-disk folder with a full-disk style name; a decoy later scan of the hour and a
// decoy band sit beside it, as in a real listing.
const FILES = {};
const LISTINGS = {};
for (const field of FIELDS) {
  const [product, band] = PRODUCT[field];
  const mode = band ? `M6${band}` : "M6";
  const key = `${product}/2026/280/06/OR_${product}-${mode}_G19_s20262800600212_e20262800609520_c20262800610000.nc`;
  const body = fs.readFileSync(new URL(EXPECTED[field].file, SET));
  FILES[`https://noaa-goes19.s3.amazonaws.com/${key}`] = { field, key, body };
  const listingUrl = `https://noaa-goes19.s3.amazonaws.com/?list-type=2&max-keys=1000&prefix=${product}/2026/280/06/`;
  LISTINGS[listingUrl] ??= [];
  LISTINGS[listingUrl].push({ key, size: body.length },
    { key: key.replace("s20262800600212", "s20262800610212"), size: 999 },
    ...(band ? [{ key: key.replace(`M6${band}_`, "M6C07_"), size: 999 }] : []));
}
const listingXml = (entries) => `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>noaa-goes19</Name>` +
  `<KeyCount>${entries.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>` +
  entries.map((e) => `<Contents><Key>${e.key}</Key><LastModified>2026-10-07T06:10:00.000Z</LastModified><ETag>"x"</ETag><Size>${e.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("") +
  "</ListBucketResult>";

function encodeEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + metaBytes.length + 4 + segments.reduce((n, s) => n + 4 + s.length, 0));
  const view = new DataView(out.buffer);
  let off = 0;
  view.setUint32(off, metaBytes.length, true); out.set(metaBytes, 4); off = 4 + metaBytes.length;
  view.setUint32(off, segments.length, true); off += 4;
  for (const s of segments) { view.setUint32(off, s.length, true); out.set(s, off + 4); off += 4 + s.length; }
  return out;
}
function decodeEnvelope(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  const meta = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metaLen)));
  let off = 4 + metaLen;
  const count = view.getUint32(off, true); off += 4;
  const segments = [];
  for (let i = 0; i < count; i++) { const n = view.getUint32(off, true); segments.push(Uint8Array.from(bytes.subarray(off + 4, off + 4 + n))); off += 4 + n; }
  return { meta, segments };
}

function createHostStub(config) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const answer = (result) => { response = encodeEnvelope({ ok: true, result }); return 0; };
  const imports = { space_data_module_host: {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const heap = new Uint8Array(memoryRef.memory.buffer);
      const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
      const { meta, segments } = decodeEnvelope(Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen)));
      calls.push({ operation, meta, segments });
      if (operation === "plugin.getConfig") return answer(config);
      if (operation === "http.request") {
        if (meta.url === PUBLISH_URL) return answer({ status: 202, headers: {}, body: Buffer.from("{}").toString("base64"), body_encoding: "base64" });
        if (LISTINGS[meta.url]) return answer({ status: 200, headers: { "content-type": "application/xml" }, body: Buffer.from(listingXml(LISTINGS[meta.url])).toString("base64"), body_encoding: "base64" });
        const file = FILES[meta.url];
        if (!file) return answer({ status: 404, headers: {}, body: "", body_encoding: "base64" });
        const range = meta.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
        const body = range ? file.body.subarray(Number(range[1]), Number(range[2]) + 1) : file.body;
        return answer({ status: range ? 206 : 200, headers: { "content-type": "application/x-netcdf" }, body: Buffer.from(body).toString("base64"), body_encoding: "base64" });
      }
      if (operation === "storage.ingest_with_source") {
        const records = Buffer.from(segments[meta.records?.$bin ?? 0]);
        let count = 0;
        for (let off = 0; off < records.length;) { off += 4 + records.readUInt32LE(off); count++; }
        return answer({ schema: meta.schema, inserted: count, batch_id: meta.batch_id });
      }
      response = encodeEnvelope({ ok: false, message: `unexpected op ${operation}` });
      return 1;
    },
    response_len() { return response.length; },
    read_response(dst, len) { const n = Math.min(len, response.length); new Uint8Array(memoryRef.memory.buffer).set(response.subarray(0, n), dst); return n; },
  } };
  return { calls, imports, memoryRef };
}

function recordCodes(r) {
  const E = wxfLib.wxfValuesEncoding;
  if (r.VALUES_ENCODING === E.InlineQuantizedUint16) return Uint16Array.from(r.QUANTIZED_U16);
  if (r.VALUES_ENCODING === E.InlineQuantizedUint8) return Uint8Array.from(r.QUANTIZED_U8);
  const b = Uint8Array.from(r.QUANTIZED_U8), wide = r.CHUNK_DTYPE === "uint16", n = wide ? b.length / 2 : b.length, mask = wide ? 0xffff : 0xff;
  const c = wide ? new Uint16Array(n) : new Uint8Array(n);
  for (let i = 0; i < n; i++) c[i] = wide ? b[i] | (b[n + i] << 8) : b[i];
  for (let i = 0; i < n; i++) c[i] = ((c[i] >>> 1) ^ -(c[i] & 1)) & mask;
  for (let i = 1; i < n; i++) c[i] = (c[i] + c[i - 1]) & mask;
  return c;
}

test("timer tick -> listings -> one file at a time (byte ranges joined) -> world bands equal to the reference, one ingest per file", async () => {
  const config = { imager_frame_time: "2026-10-07T06:00:00Z", imager_satellites: "goes-east", imager_fields: FIELDS.join(","),
    imager_max_part_bytes: 1048576, imager_publish_url: PUBLISH_URL };
  const stub = createHostStub(config);
  const host = await createFlowRuntimeHost({ wasmSource: new Uint8Array(fs.readFileSync(RUNTIME)), extraImports: stub.imports, runtimeTarget: "wasmedge" });
  stub.memoryRef.memory = host.memory;
  const egress = [];
  host.enqueueTriggerFrame(0, { portId: "tick", bytes: encoder.encode(JSON.stringify({ firedAt: "2026-10-07T06:20:00Z" })) });
  await host.drain({ "sdn.flow.egress:emit": ({ frames }) => { for (const f of frames) egress.push(JSON.parse(decoder.decode(f.bytes))); return { statusCode: 0 }; } });

  // the listings first, then each file's GETs followed by its ingest: one file at a time
  const sequence = stub.calls.filter((c) => c.operation !== "plugin.getConfig").map((c) =>
    c.operation === "storage.ingest_with_source" ? "ingest" : c.meta.url === PUBLISH_URL ? "publish" : LISTINGS[c.meta.url] ? "list" : FILES[c.meta.url] ? `get:${FILES[c.meta.url].field}` : `?${c.meta.url}`);
  const listings = Object.keys(LISTINGS).length;
  assert.deepEqual(sequence.slice(0, listings), Array(listings).fill("list"), sequence.join(" "));
  const afterListings = sequence.slice(listings);
  const files = afterListings.filter((s) => s.startsWith("get:"));
  assert.equal(new Set(files).size, FIELDS.length, "every field's file fetched");
  // each file's parts back to back, then its ingest and its publication, before the next file is fetched
  let at = 0;
  for (const get of new Set(files)) {
    const field = get.slice(4);
    while (afterListings[at] === get) at++;
    assert.equal(afterListings[at], "ingest", `${field}: ingested before the next file (${afterListings.join(" ")})`);
    assert.equal(afterListings[at + 1], "publish", `${field}: published after its ingest`);
    at += 2;
  }
  assert.equal(at, afterListings.length);
  for (const c of stub.calls.filter((c) => c.operation === "http.request" && c.meta.url !== PUBLISH_URL)) {
    assert.equal(c.meta.headers["If-Modified-Since"], "Thu, 01 Jan 1970 00:00:00 GMT");
  }
  const reflectanceGets = stub.calls.filter((c) => FILES[c.meta.url]?.field === "reflectance_064um");
  assert.equal(reflectanceGets.length, 2, "the 1.47 MB band in two 1 MiB-bounded ranges");

  // every ingest: one file's field, its world codes equal to the reference at every width
  const ingests = stub.calls.filter((c) => c.operation === "storage.ingest_with_source");
  assert.equal(ingests.length, FIELDS.length);
  for (const ingest of ingests) {
    assert.equal(ingest.meta.schema, "WXF.fbs");
    assert.equal(ingest.meta.provider_id, "noaa-goes");
    assert.equal(ingest.meta.source_name, "noaa-goes19-world");
    const records = Buffer.from(ingest.segments[ingest.meta.records?.$bin ?? 0]);
    const byWidth = {};
    let field = null;
    for (let off = 0; off < records.length;) {
      const len = records.readUInt32LE(off);
      const r = wxfLib.WXF.getRootAsWXF(new flatbuffers.ByteBuffer(Uint8Array.from(records.subarray(off + 4, off + 4 + len)))).unpack();
      off += 4 + len;
      field ??= r.VARIABLE_NAME;
      assert.equal(r.VARIABLE_NAME, field, "one field per ingest");
      (byWidth[r.GRID.NLON] ??= []).push(recordCodes(r));
    }
    const e = EXPECTED[field];
    for (const [width, w] of Object.entries(e.widths)) {
      const raw = gunzipSync(fs.readFileSync(new URL(w.codes, SET)));
      const want = e.encoding === "InlineQuantizedUint8" ? new Uint8Array(raw) : new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      const parts = byWidth[width] ?? [];
      assert.equal(parts.length, w.bands, `${field} ${width}: bands`);
      const got = new want.constructor(want.length);
      let o = 0;
      for (const p of parts) { got.set(p, o); o += p.length; }
      assert.equal(o, want.length);
      let differ = 0;
      for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) differ++;
      assert.equal(differ, 0, `${field} ${width}: ${differ} codes differ from the reference`);
    }
  }
  const results = egress.filter((r) => r.schema === "WXF.fbs");
  assert.equal(results.length, FIELDS.length, "one ingest result per file reached the egress");
  assert.equal(egress.filter((r) => r.missing || r.skipped).length, 0, JSON.stringify(egress));
  console.log(`runtime linear memory after the cycle: ${(host.memory.buffer.byteLength / 1048576).toFixed(0)} MiB`);
});
