// Flow-level test for the compiled osm-serving flow in BRIDGE mode: the same
// artifact the Go host mounts at /api/v1/osm/ is instantiated in the JS flow
// runtime host, a $HTQ enters route, the route -> egress chain runs inside
// the artifact, and the ONLY host crossing is plugin.getConfig - an SDS $PIV
// invocation, answered as the Go node answers it (one ModuleConfig on raw
// "config", nulls left out; same stub shape as flows/terrain-serving).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeHttpResponse, encodeHttpRequest } from "space-data-module-sdk/http";
import { decodeHostCall, encodeHostCallResult, encodeModuleConfig } from "space-data-module-sdk/runtime-contracts";

const decoder = new TextDecoder();
const RUNTIME_WASM = new URL("../dist/runtime.wasm", import.meta.url);

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const RECORD = {
  FORMAT: "osm-context-fgb/1",
  TILESET_ID: "osm-context-hessen-20260902T202051Z-fgb",
  REGION: "hessen",
  CRS: "EPSG:4326",
  PAYLOAD: { CID: "", SIZE_BYTES: 10, MEDIA_TYPE: "application/vnd.ipld.dag-pb" },
  FILES: [{ NAME: "building.fgb", CATEGORY: "building", KIND: "polygon", MEDIA_TYPE: "application/x-flatgeobuf", BYTES: 10, SHA256: "a".repeat(64), FEATURE_COUNT: 1, LAYER: "multipolygons", WHERE: null }],
  DATASET_EPOCH: "2026-09-02T20:20:51Z",
  PROVENANCE: { SOURCE: "OpenStreetMap", SOURCE_URL: "https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf", RETRIEVED_AT: "2026-09-03T18:56:15Z", PROCESSOR: "osmium-tool", LICENSE: "ODbL-1.0", SHARE_ALIKE: true, ATTRIBUTION: "© OpenStreetMap contributors", OCEAN: null },
};
const CONFIG = { osm_epoch_cid: CID, osm_epoch_record: RECORD };

const withoutNulls = (v) =>
  Array.isArray(v) ? v.map(withoutNulls)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, withoutNulls(x)]))
      : v;

function createStub(config) {
  const calls = [];
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const call = decodeHostCall(Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen)));
        assert.equal(call.op, operation);
        calls.push({ operation, payloadLen });
        if (operation === "plugin.getConfig") {
          response = encodeHostCallResult({ ok: true, op: operation, raw: { config: encodeModuleConfig(withoutNulls(config)) } });
          return 0;
        }
        response = encodeHostCallResult({ ok: false, error: { code: "unsupported", message: `unexpected op ${operation}` } });
        return 0;
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
  const http = responses[0];
  const headers = {};
  for (const h of http.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  return { status: http.status, headers, body: http.body ? decoder.decode(http.body) : "" };
}

const compiled = fs.existsSync(fileURLToPath(RUNTIME_WASM));

test("the compiled flow answers the epoch record through the bridge, and the only host crossing is plugin.getConfig", { skip: !compiled && "dist/runtime.wasm not compiled" }, async () => {
  const stub = createStub(CONFIG);
  const record = await pumpRequest(stub, { method: "GET", path: "/api/v1/osm/tileset.json", query: "", headers: {} });
  assert.equal(record.status, 200);
  assert.equal(record.headers["cache-control"], "public, max-age=60");
  assert.equal(record.headers["access-control-allow-origin"], "*");
  const body = JSON.parse(record.body);
  assert.equal(body.PAYLOAD.CID, CID);
  assert.equal(body.EPOCH_BASE_PATH, `/ipfs/${CID}/`);
  assert.deepEqual(body.FILES, RECORD.FILES);
  assert.deepEqual(body.PROVENANCE, RECORD.PROVENANCE);
  const { FORMAT, TILESET_ID, REGION, CRS, PAYLOAD, FILES, DATASET_EPOCH, PROVENANCE } = RECORD;
  assert.equal(record.body, JSON.stringify({ FORMAT, TILESET_ID, REGION, CRS, PAYLOAD: { ...PAYLOAD, CID }, EPOCH_BASE_PATH: `/ipfs/${CID}/`, FILES, DATASET_EPOCH, PROVENANCE }), "the builder's record, byte for byte");
  assert.deepEqual(new Set(stub.calls.map((c) => c.operation)), new Set(["plugin.getConfig"]));

  const again = await pumpRequest(createStub(CONFIG), { method: "GET", path: "/api/v1/osm/tileset.json", query: "", headers: { "if-none-match": record.headers.etag } });
  assert.equal(again.status, 304);
});

test("discovery document, the unconfigured 503, and the 404 outside the mount", { skip: !compiled && "dist/runtime.wasm not compiled" }, async () => {
  const catalogue = await pumpRequest(createStub(CONFIG), { method: "GET", path: "/api/v1/osm/", query: "", headers: {} });
  assert.equal(catalogue.status, 200);
  assert.equal(JSON.parse(catalogue.body).delivery, "ipfs");
  assert.equal(JSON.parse(catalogue.body).epochBasePath, `/ipfs/${CID}/`);
  const bare = await pumpRequest(createStub({}), { method: "GET", path: "/api/v1/osm/tileset.json", query: "", headers: {} });
  assert.equal(bare.status, 503);
  assert.deepEqual(JSON.parse(bare.body).missingConfigKeys, ["osm_epoch_record", "osm_epoch_cid"]);
  const outside = await pumpRequest(createStub(CONFIG), { method: "GET", path: "/api/v1/terrain/tileset.json", query: "", headers: {} });
  assert.equal(outside.status, 404);
  assert.equal(outside.headers["cache-control"], "no-store");
});
