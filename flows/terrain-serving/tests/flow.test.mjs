/*
 * Flow-level tests for the compiled terrain-serving flow — BRIDGE mode. The
 * SAME artifact the Go host mounts at /api/v1/terrain/ is instantiated in the
 * JS flow runtime host (browser parity): a $HTQ HttpRequest enters route, the
 * route -> flatsql-query -> respond (or route -> layer_json) chain runs
 * linked-direct inside the artifact's linear memory, and the ONLY host
 * crossings are storage.flatsql_query_stream and plugin.getConfig — stubbed
 * with the Go-host response dialect.
 *
 * The stored $DTT fixture is produced by the terrain-source MODULE's own
 * `tile` encoder, so the serve path is tested against exactly the bytes the
 * ingest path stores.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse, encodeHttpRequest } from "space-data-module-sdk/http";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const RUNTIME_WASM = new URL("../dist/runtime.wasm", import.meta.url);
const MODULE_WASM = new URL(
  "../../../data-source/terrain-source/dist/isomorphic/module.wasm",
  import.meta.url,
);
const MODULE_MANIFEST = new URL(
  "../../../data-source/terrain-source/plugin-manifest.json",
  import.meta.url,
);

const CONFIG = {
  terrain_tileset_id: "spaceaware-terrain",
  terrain_maxzoom: 8,
  terrain_available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
  terrain_attribution: "test attribution",
};

// ---------------------------------------------------------------------------
// Hostcall wire helpers (Go-host dialect; keys alphabetical like json.Marshal).
// ---------------------------------------------------------------------------

function encodeHostcallEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4 + segments.reduce((sum, seg) => sum + 4 + seg.length, 0);
  const envelope = new Uint8Array(total);
  const view = new DataView(envelope.buffer);
  let offset = 0;
  view.setUint32(offset, metaBytes.length, true);
  envelope.set(metaBytes, offset + 4);
  offset += 4 + metaBytes.length;
  view.setUint32(offset, segments.length, true);
  offset += 4;
  for (const segment of segments) {
    view.setUint32(offset, segment.length, true);
    envelope.set(segment, offset + 4);
    offset += 4 + segment.length;
  }
  return envelope;
}

function decodeHostcallEnvelope(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  const meta = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metaLen)));
  return { meta };
}

// ---------------------------------------------------------------------------
// The stored record fixture: one $DTT produced by the module's own encoder,
// in the store's stream framing ([u32 len][record]).
// ---------------------------------------------------------------------------

function buildDemGeoTiff() {
  // Minimal strip-layout deflate Float32 GeoTIFF matching the module tests'
  // synthetic granule (see data-source/terrain-source/tests/helpers.mjs for
  // the annotated writer; duplicated minimally here to keep the flow package
  // self-contained).
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      raw.writeFloatLE(Math.fround(100 + px + 2 * py), (py * width + px) * 4);
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const tags = [];
  const tag = (id, type, count, value) => tags.push({ id, type, count, value });
  const entryCount = 12;
  const ifdBytes = 2 + entryCount * 12 + 4;
  let cursor = 8 + ifdBytes;
  const scaleOffset = cursor; cursor += 24;
  const tiepointOffset = cursor; cursor += 48;
  const dataOffset = cursor;
  tag(256, 3, 1, width); tag(257, 3, 1, height); tag(258, 3, 1, 32); tag(259, 3, 1, 8);
  tag(273, 4, 1, dataOffset); tag(277, 3, 1, 1); tag(278, 3, 1, height);
  tag(279, 4, 1, compressed.length); tag(317, 3, 1, 1); tag(339, 3, 1, 3);
  tag(33550, 12, 3, scaleOffset); tag(33922, 12, 6, tiepointOffset);
  tags.sort((a, b) => a.id - b.id);
  const file = Buffer.alloc(dataOffset + compressed.length);
  file.write("II", 0, "latin1");
  file.writeUInt16LE(42, 2);
  file.writeUInt32LE(8, 4);
  file.writeUInt16LE(entryCount, 8);
  tags.forEach((t, n) => {
    const at = 10 + n * 12;
    file.writeUInt16LE(t.id, at);
    file.writeUInt16LE(t.type, at + 2);
    file.writeUInt32LE(t.count, at + 4);
    if (t.type === 3) file.writeUInt16LE(t.value, at + 8);
    else file.writeUInt32LE(t.value, at + 8);
  });
  file.writeDoubleLE(0.8 / 63, scaleOffset);
  file.writeDoubleLE(0.9 / 63, scaleOffset + 8);
  file.writeDoubleLE(0, tiepointOffset + 0);
  file.writeDoubleLE(0, tiepointOffset + 8);
  file.writeDoubleLE(0, tiepointOffset + 16);
  file.writeDoubleLE(10.5, tiepointOffset + 24);
  file.writeDoubleLE(45.8, tiepointOffset + 32);
  file.writeDoubleLE(0, tiepointOffset + 40);
  compressed.copy(file, dataOffset);
  return file;
}

async function storedRecordStream() {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(MODULE_WASM)),
    manifest: JSON.parse(fs.readFileSync(fileURLToPath(MODULE_MANIFEST), "utf8")),
    surface: "direct",
  });
  try {
    const frame = (portId, value) => {
      const bytes = encoder.encode(JSON.stringify(value));
      return {
        portId,
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
        payload: bytes,
      };
    };
    const response = await harness.invoke({
      methodId: "tile",
      inputs: [
        frame("plan", {
          tilesetId: "spaceaware-terrain",
          level: 8,
          x: 271,
          y: 192,
          gridSize: 33,
          maxLevel: 8,
          childAvailability: 0,
          provenance: {
            datasetId: "cop-dem-glo-30",
            datasetEpoch: "2023-04-01T00:00:00.000Z",
            retrievedAt: "2026-08-15T12:00:00.000Z",
            license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
          },
        }),
        frame("dem", {
          status: 200,
          headers: {},
          bodyB64: buildDemGeoTiff().toString("base64"),
        }),
      ],
    });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    const records = response.outputs.find((o) => o.portId === "records");
    return Uint8Array.from(records.payload);
  } finally {
    harness.destroy();
  }
}

// ---------------------------------------------------------------------------
// Hostcall stub + request pump.
// ---------------------------------------------------------------------------

function createStub({ stream } = {}) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const payload = Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen));
        const { meta } = decodeHostcallEnvelope(payload);
        calls.push({ operation, meta });
        if (operation === "plugin.getConfig") {
          response = encodeHostcallEnvelope(CONFIG);
          return 0;
        }
        if (operation === "storage.flatsql_query_stream") {
          response = encodeHostcallEnvelope({ ok: true }, stream ? [stream] : []);
          return 0;
        }
        response = encodeHostcallEnvelope({
          error: { message: `unexpected op ${operation}` },
          ok: false,
        });
        return 1;
      },
      response_len() {
        return response.length;
      },
      read_response(dstPtr, dstLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const length = Math.min(dstLen, response.length);
        heap.set(response.subarray(0, length), dstPtr);
        return length;
      },
    },
  };
  return { calls, imports, memoryRef };
}

async function pumpRequest(stub, request) {
  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(RUNTIME_WASM))),
    extraImports: stub.imports,
    runtimeTarget: "wasmedge",
  });
  stub.memoryRef.memory = host.memory;
  const responses = [];
  host.enqueueTriggerFrame(0, { portId: "request", bytes: encodeHttpRequest(request) });
  await host.drain(
    {
      "sdn.flow.egress:emit": ({ frames }) => {
        for (const frame of frames) responses.push(decodeHttpResponse(frame.bytes));
        return { statusCode: 0 };
      },
    },
    { maxIterations: 100 },
  );
  assert.equal(responses.length, 1, "expected exactly one $HTR frame");
  return responses[0];
}

const header = (http, name) => http.headers?.find((h) => h.name === name)?.value;

// ---------------------------------------------------------------------------

test("GET layer.json serves the config-derived descriptor through the compiled flow", async () => {
  const stub = createStub();
  const http = await pumpRequest(stub, { method: "GET", path: "/api/v1/terrain/layer.json" });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/json");
  const body = JSON.parse(Buffer.from(http.body).toString("utf8"));
  assert.equal(body.tilejson, "2.1.0");
  assert.equal(body.format, "quantized-mesh-1.0");
  assert.equal(body.scheme, "tms");
  assert.equal(body.maxzoom, 8);
  assert.deepEqual(body.available, CONFIG.terrain_available);
  assert.deepEqual(body.extensions, ["watermask"]);
  assert.deepEqual(
    stub.calls.map((c) => c.operation),
    ["plugin.getConfig"],
    "layer.json touches the host for config only",
  );
});

test("GET {z}/{x}/{y}.terrain serves the stored record bytes verbatim", async () => {
  const stream = await storedRecordStream();
  const stub = createStub({ stream });
  const http = await pumpRequest(stub, {
    method: "GET",
    path: "/api/v1/terrain/8/271/192.terrain",
  });
  assert.equal(http.status, 200);
  assert.equal(header(http, "content-type"), "application/vnd.quantized-mesh");
  assert.equal(header(http, "content-encoding"), "gzip");
  assert.equal(header(http, "cache-control"), "public, max-age=86400");
  const etag = header(http, "etag");
  assert.ok(etag && etag.startsWith('W/"dtt-8-271-192-'));
  // The served body gunzips to a quantized-mesh whose vertex count matches
  // the encode plan (33x33 grid).
  const mesh = zlib.gunzipSync(Buffer.from(http.body));
  assert.equal(mesh.readUInt32LE(88), 33 * 33, "vertexCount after the 88-byte header");

  const queryCall = stub.calls.find((c) => c.operation === "storage.flatsql_query_stream");
  assert.ok(queryCall, "the tile path queries the record store");
  assert.equal(
    queryCall.meta.sql,
    "SELECT _data FROM DTT WHERE TILESET_ID = ? AND LEVEL = ? AND X = ? AND Y = ? ORDER BY rowid DESC LIMIT 1",
  );
  assert.deepEqual(queryCall.meta.params, [
    { t: "str", v: "spaceaware-terrain" },
    { t: "i64", v: 8 },
    { t: "i64", v: 271 },
    { t: "i64", v: 192 },
  ]);

  // Conditional replay: the etag comes back 304 with no body.
  const conditional = await pumpRequest(createStub({ stream }), {
    method: "GET",
    path: "/api/v1/terrain/8/271/192.terrain",
    headers: { "if-none-match": etag },
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.body.length, 0);
});

test("a tile miss and an unknown path both answer cheap cacheable 404s", async () => {
  const miss = await pumpRequest(createStub({ stream: null }), {
    method: "GET",
    path: "/api/v1/terrain/12/100/200.terrain",
  });
  assert.equal(miss.status, 404);
  assert.equal(header(miss, "cache-control"), "public, max-age=300");

  const unknown = await pumpRequest(createStub(), {
    method: "GET",
    path: "/api/v1/terrain/definitely/not/a/tile",
  });
  assert.equal(unknown.status, 404);
  assert.equal(header(unknown, "cache-control"), "public, max-age=300");
});
