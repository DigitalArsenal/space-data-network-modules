/*
 * Flow-level test for the compiled nwp-field-ingest flow - BRIDGE mode: the SAME runtime.wasm the Go host serves from
 * its cron timer, in the JS flow runtime host (WasmEdge leg). A timer tick enters plan and the whole inventory -> select
 * -> range fetch -> parse -> ingest chain runs linked-direct inside the artifact's linear memory; the only host
 * crossings are the declared hostcalls, stubbed in the Go host's dialect: plugin.getConfig, http.request (.idx
 * inventories, GRIB2 byte ranges answered 206) and storage.ingest_with_source.
 *
 * Data: the parser's real NOAA messages (data-source/nwp-grib2-parser/tests/fixtures), served as each product's lead-24
 * file with an inventory in the real .idx format listing them; the lead-0 files are absent (404). Every ingested
 * record's codes must equal ecCodes' packing integers (the parser fixtures' expected SHA-256 per field).
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RUNTIME = new URL("../dist/runtime.wasm", import.meta.url);
const FIX = new URL("../../../data-source/nwp-grib2-parser/tests/fixtures/", import.meta.url);
const SET = new URL("./noaa-2026100600-f024/", FIX);
const EXPECTED = JSON.parse(fs.readFileSync(new URL("expected.json", SET), "utf8"));
const INVENTORY = JSON.parse(fs.readFileSync(new URL("inventory.json", SET), "utf8"));
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/WXF/main.js"));
const flatbuffers = createRequire(WXF_LIB)("flatbuffers");
const wxfLib = await import(WXF_LIB.href);
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
const GFS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261006/00/atmos";

// each fixture file served as its product's lead-24 file, with an .idx listing its messages (offsets in that file); fixtures
// cut from one NOAA file (the 0.25 deg surface and air messages) are served as that one file, their messages in a row
const SERVED = {};
for (const [file, inv] of Object.entries(INVENTORY)) {
  const body = fs.readFileSync(new URL(file, SET));
  const s = SERVED[inv.url] ?? (SERVED[inv.url] = { files: [], body: Buffer.alloc(0), lines: [] });
  for (let at = 0, n = 1; at < body.length; n++) {
    const len = Number(body.readBigUInt64BE(at + 8));
    const [, , date, variable, level, fcst] = inv.idx[n - 1].split(":");
    s.lines.push(`${s.lines.length + 1}:${s.body.length + at}:${date}:${variable}:${level}:${fcst}:`);
    at += len;
  }
  s.files.push(file);
  s.body = Buffer.concat([s.body, body]);
}
for (const s of Object.values(SERVED)) { s.file = s.files.join("+"); s.idx = s.lines.join("\n") + "\n"; }
// the default products' fixtures (the sea product, gfs-0p25-sea, is asked for by name)
const DEFAULT_FILES = Object.keys(EXPECTED).filter((f) => f !== "gfs-0p25-air.grib2");

function encodeEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + metaBytes.length + 4 + segments.reduce((n, s) => n + 4 + s.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, metaBytes.length, true); out.set(metaBytes, 4);
  let off = 4 + metaBytes.length;
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
  const http = (status, body) => answer({ status, headers: {}, body: Buffer.from(body).toString("base64"), body_encoding: "base64" });
  const imports = { space_data_module_host: {
    call(opPtr, opLen, payloadPtr, payloadLen) {
      const heap = new Uint8Array(memoryRef.memory.buffer);
      const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
      const { meta, segments } = decodeEnvelope(Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen)));
      calls.push({ operation, meta, segments });
      if (operation === "plugin.getConfig") return answer(config);
      if (operation === "http.request") {
        if (meta.url === PUBLISH_URL) return http(202, "{}");
        if (meta.url.endsWith(".idx")) { const s = SERVED[meta.url.slice(0, -4)]; return s ? http(200, s.idx) : http(404, "<Error/>"); }
        const s = SERVED[meta.url];
        if (!s) return http(404, "");
        const range = meta.headers?.Range?.match(/^bytes=(\d+)-(\d*)$/);
        assert.ok(range, `a GRIB fetch must be a byte range: ${JSON.stringify(meta.headers)}`);
        return http(206, s.body.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : s.body.length));
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
  const b = Uint8Array.from(r.QUANTIZED_U8), n = b.length / 2, c = new Uint16Array(n);
  for (let i = 0; i < n; i++) c[i] = b[i] | (b[n + i] << 8);
  for (let i = 0; i < n; i++) c[i] = ((c[i] >>> 1) ^ -(c[i] & 1)) & 0xffff;
  for (let i = 1; i < n; i++) c[i] = (c[i] + c[i - 1]) & 0xffff;
  return c;
}

test("timer tick -> inventories -> one lead-file at a time by byte range -> records equal to ecCodes' integers, one ingest per batch", async () => {
  const config = { nwp_run: "20261006T00", nwp_max_lead: 24, nwp_lead_step: 24, nwp_motion_heights_to: 24, nwp_physics_leads: "24", nwp_publish_url: PUBLISH_URL };
  const stub = createHostStub(config);
  const host = await createFlowRuntimeHost({ wasmSource: new Uint8Array(fs.readFileSync(RUNTIME)), extraImports: stub.imports, runtimeTarget: "wasmedge" });
  stub.memoryRef.memory = host.memory;
  const egress = [];
  host.enqueueTriggerFrame(0, { portId: "tick", bytes: encoder.encode(JSON.stringify({ firedAt: "2026-10-06T05:00:00Z" })) });
  await host.drain({ "sdn.flow.egress:emit": ({ frames }) => { for (const f of frames) egress.push(JSON.parse(decoder.decode(f.bytes))); return { statusCode: 0 }; } });

  const http = stub.calls.filter((c) => c.operation === "http.request");
  const idx = http.filter((c) => c.meta.url.endsWith(".idx")).map((c) => c.meta.url);
  // motion, spread and clouds at leads 0 and 24, physics at 24: seven inventories
  assert.equal(idx.length, 7, idx.join("\n"));
  assert.ok(idx.includes(`${GFS}/gfs.t00z.pgrb2.1p00.f000.idx`) && idx.includes(`${GFS}/gfs.t00z.pgrb2.0p25.f024.idx`));
  for (const c of http) if (c.meta.url !== PUBLISH_URL) assert.equal(c.meta.headers["If-Modified-Since"], "Thu, 01 Jan 1970 00:00:00 GMT");

  // the sequence after the inventories: each lead-file's ranges, then its ingest and publication
  const sequence = stub.calls.filter((c) => c.operation !== "plugin.getConfig" && !(c.operation === "http.request" && c.meta.url.endsWith(".idx")))
    .map((c) => c.operation === "storage.ingest_with_source" ? "ingest" : c.meta.url === PUBLISH_URL ? "publish" : `get:${SERVED[c.meta.url].file}`);
  let at = 0, batches = 0;
  while (at < sequence.length) {
    const get = sequence[at];
    assert.match(get, /^get:/, sequence.join(" "));
    while (sequence[at] === get) at++;
    assert.equal(sequence[at], "ingest", sequence.join(" "));
    assert.equal(sequence[at + 1], "publish", sequence.join(" "));
    at += 2; batches++;
  }
  assert.equal(batches, DEFAULT_FILES.length);

  // every ingest: one lead-file's fields, each field's codes equal to ecCodes' packing integers
  for (const ingest of stub.calls.filter((c) => c.operation === "storage.ingest_with_source")) {
    assert.equal(ingest.meta.provider_id, "noaa-ncep");
    const records = Buffer.from(ingest.segments[ingest.meta.records?.$bin ?? 0]);
    const fields = new Map();
    for (let off = 0; off < records.length;) {
      const len = records.readUInt32LE(off);
      const r = wxfLib.WXF.getRootAsWXF(new flatbuffers.ByteBuffer(Uint8Array.from(records.subarray(off + 4, off + 4 + len)))).unpack();
      off += 4 + len;
      if (!fields.has(r.VARIABLE_NAME)) fields.set(r.VARIABLE_NAME, []);
      fields.get(r.VARIABLE_NAME).push(recordCodes(r));
    }
    const file = DEFAULT_FILES.find((f) => EXPECTED[f].some((e) => fields.has(e.name)) && EXPECTED[f].length === fields.size);
    assert.ok(file, `an ingest matches no product: ${[...fields.keys()].join(", ")}`);
    for (const e of EXPECTED[file]) {
      const parts = fields.get(e.name);
      const all = new Uint16Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      assert.equal(createHash("sha256").update(Buffer.from(all.buffer)).digest("hex"), e.sha256, `${file} ${e.name}`);
    }
  }
  // the lead-0 files the run lacks are reported, not invented
  const missing = egress.filter((r) => r.missing).flatMap((r) => r.missing);
  assert.equal(missing.length, 3);
  assert.ok(missing.every((m) => m.http_status === 404 && m.inventory.includes(".f000.idx")));
  assert.equal(egress.filter((r) => r.schema === "WXF.fbs").length, DEFAULT_FILES.length);
  console.log(`runtime linear memory after the cycle: ${(host.memory.buffer.byteLength / 1048576).toFixed(0)} MiB`);
});

// The sea product (owner 2026-10-12, the world-clouds demo on the weather node): the surface fields and the air of one
// lead-file in one byte-range fetch, cut by the parser into 11.25 deg tiles - one ingest a tile, 512, each batch named
// gfs:<run>:f<LLL>:s4:<x>:<y> - and every field, put back together from its tiles, ecCodes' packing integers exactly.
test("gfs-0p25-sea: one lead-file fetched by range -> 512 tile batches through the backlog -> the fields equal ecCodes'", async () => {
  const config = { nwp_run: "20261006T00", nwp_products: "gfs-0p25-sea", nwp_max_lead: 24, nwp_lead_step: 24 };
  const stub = createHostStub(config);
  const host = await createFlowRuntimeHost({ wasmSource: new Uint8Array(fs.readFileSync(RUNTIME)), extraImports: stub.imports, runtimeTarget: "wasmedge" });
  stub.memoryRef.memory = host.memory;
  host.enqueueTriggerFrame(0, { portId: "tick", bytes: encoder.encode(JSON.stringify({ firedAt: "2026-10-06T05:00:00Z" })) });
  await host.drain({ "sdn.flow.egress:emit": () => ({ statusCode: 0 }) });

  const http = stub.calls.filter((c) => c.operation === "http.request");
  assert.deepEqual(http.filter((c) => c.meta.url.endsWith(".idx")).map((c) => c.meta.url).sort(), [`${GFS}/gfs.t00z.pgrb2.0p25.f000.idx`, `${GFS}/gfs.t00z.pgrb2.0p25.f024.idx`]);
  const ingests = stub.calls.filter((c) => c.operation === "storage.ingest_with_source");
  assert.equal(ingests.length, 512, "32 x 16 tiles");
  const names = ["air_temperature_2m", "visibility_surface", "precipitation_rate_surface", "geopotential_height_cloud_ceiling"];
  const want = Object.fromEntries(["gfs-0p25-surface.grib2", "gfs-0p25-air.grib2"].flatMap((f) => EXPECTED[f]).map((e) => [e.name, e]));
  const all = Object.fromEntries(names.map((n) => [n, new Int32Array(want[n].nlat * want[n].nlon).fill(-1)]));
  const batches = new Set();
  for (const ingest of ingests) {
    assert.equal(ingest.meta.provider_id, "noaa-ncep");
    assert.equal(ingest.meta.source_name, "gfs-0p25-sea");
    const [, x, y] = ingest.meta.batch_id.match(/^gfs:20261006T00:f024:s4:(\d+):(\d+)$/) ?? [];
    assert.ok(x !== undefined, ingest.meta.batch_id);
    batches.add(ingest.meta.batch_id);
    const records = Buffer.from(ingest.segments[ingest.meta.records?.$bin ?? 0]);
    let n = 0;
    for (let off = 0; off < records.length; n++) {
      const len = records.readUInt32LE(off);
      const r = wxfLib.WXF.getRootAsWXF(new flatbuffers.ByteBuffer(Uint8Array.from(records.subarray(off + 4, off + 4 + len)))).unpack();
      off += 4 + len;
      assert.equal(r.FIELD_ID, `gfs:20261006T00:f24:${r.VARIABLE_NAME}:s4:${x}:${y}`);
      const c = recordCodes(r), e = want[r.VARIABLE_NAME], i0 = Math.round((r.GRID.LAT0 + 90) / 0.25), j0 = Math.round((((r.GRID.LON0 % 360) + 360) % 360) / 0.25);
      for (let i = 0; i < r.GRID.NLAT; i++) for (let j = 0; j < r.GRID.NLON; j++) all[r.VARIABLE_NAME][(i0 + i) * e.nlon + ((j0 + j) % e.nlon)] = c[i * r.GRID.NLON + j];
    }
    assert.equal(n, names.length, `${ingest.meta.batch_id}: the four fields the fixtures carry`);
  }
  assert.equal(batches.size, 512, "every tile its own batch");
  for (const name of names) {
    assert.ok(all[name].every((v) => v >= 0), `${name}: every point in some tile`);
    assert.equal(createHash("sha256").update(Buffer.from(Uint16Array.from(all[name]).buffer)).digest("hex"), want[name].sha256, `${name}: equal to ecCodes`);
  }
});
