import fs from "node:fs";
import zlib from "node:zlib";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";
import { buildGeoTiff, decodeQuantizedMesh } from "/Users/tj/software/worktrees/space-data-network-modules--sdn-terrain-serving-module/data-source/terrain-source/tests/helpers.mjs";

const ROOT = "/Users/tj/software/worktrees/space-data-network-modules--sdn-terrain-serving-module/data-source/terrain-source";
const enc = new TextEncoder(); const dec = new TextDecoder();
const wasm = fs.readFileSync(`${ROOT}/dist/isomorphic/module.wasm`);
const manifest = JSON.parse(fs.readFileSync(`${ROOT}/plugin-manifest.json`, "utf8"));
const CONFIG = {
  terrain_tileset_id: "spaceaware-terrain",
  terrain_maxzoom: 5,
  terrain_available: [[{startX:0,startY:0,endX:1,endY:0}]],
  terrain_attribution: "fixture",
};
const frame = (portId, payload) => {
  const bytes = typeof payload === "string" ? enc.encode(payload) : payload;
  return { portId, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength }, payload: bytes };
};
const jsonFrame = (p, v) => frame(p, JSON.stringify(v));
async function invoke(methodId, inputs, config = CONFIG) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: "direct",
    hostcallDispatch: (op) => { if (op === "plugin.getConfig") return config; throw new Error(op); } });
  const r = await h.invoke({ methodId, inputs });
  h.destroy();
  return r;
}
// layer.json
let r = await invoke("route", [{ portId: "request", typeRef: HTTP_REQUEST_TYPE_REF, payload: encodeHttpRequest({ method: "GET", path: "/api/v1/terrain/layer.json", headers: {} }) }]);
console.log("route layer statusCode", r.statusCode, r.errorCode||"", r.errorMessage||"");
const plan = r.outputs[0].payload;
console.log("layer_plan:", dec.decode(plan));
let l = await invoke("layer_json", [frame("plan", plan)]);
const http = decodeHttpResponse(new Uint8Array(l.outputs[0].payload));
console.log("layer.json status", http.status, "headers", JSON.stringify(http.headers));
console.log("BODY:", Buffer.from(http.body).toString("utf8"));

// one tile
const tiff = buildGeoTiff({ width: 64, height: 64, originLon: -180, originLat: 90, scaleLon: 180/63, scaleLat: 180/63, heightFn: (px,py)=> 500 + 300*Math.sin(px/6)*Math.cos(py/5) });
let t = await invoke("tile", [
  jsonFrame("plan", { tilesetId: "spaceaware-terrain", level: 0, x: 0, y: 0, gridSize: 33, maxLevel: 5, childAvailability: 0,
    provenance: { datasetId: "fixture", datasetEpoch: "2026-01-01T00:00:00.000Z", retrievedAt: "2026-08-26T00:00:00.000Z", license: "fixture" } }),
  jsonFrame("dem", { status: 200, headers: {}, bodyB64: Buffer.from(tiff).toString("base64") }),
]);
console.log("tile statusCode", t.statusCode, t.errorCode||"", t.errorMessage||"");
if (t.statusCode === 0) {
  const outs = new Map(t.outputs.map(o=>[o.portId,o.payload]));
  console.log("report", dec.decode(outs.get("report")));
  const stream = Buffer.from(outs.get("records"));
  let rr = await invoke("respond", [frame("stream", new Uint8Array(stream)), jsonFrame("context", { tilesetId: "spaceaware-terrain", level: 0, x: 0, y: 0, ifNoneMatch: "" })]);
  const h2 = decodeHttpResponse(new Uint8Array(rr.outputs[0].payload));
  console.log("tile http", h2.status, JSON.stringify(h2.headers));
  const raw = zlib.gunzipSync(Buffer.from(h2.body));
  const mesh = decodeQuantizedMesh(raw);
  console.log("mesh vertices", mesh.vertexCount, "tris", mesh.triangleCount, "ext", JSON.stringify(mesh.extensions.map(e=>({id:e.id,len:e.bytes.length, first: e.bytes[0]}))), "min/max", mesh.header.minHeight, mesh.header.maxHeight, "gz", h2.body.length, "raw", raw.length);
}
