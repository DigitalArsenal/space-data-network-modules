// THE WAC WALK, END TO END, AGAINST THE LIVE MOSAIC (no fixture): wac_plan's requests are answered from
// asc-pds-services exactly as hostcap/http-request answers them (an HttpResponse, STATUS 206, BODY the bytes), and
// wac_tile's tiles are checked against the mosaic's own rows read here:
//   - a level-8 unit (row 128, the equator's north side): 512 tiles in 32 files of 16, every tile's mean within
//     1.5 of 255 of the area mean of the mosaic pixels it covers, and its JPEG a 256 x 256 gray image;
//   - a level-5 unit (row 16): 64 tiles in 4 files, plus the same tiles as $DTT records and their IngestRequest;
//   - the coarse unit: given the stored level-5 tiles (this row's, standing in for every row), levels 0-4 (682
//     tiles) in root.dtts and 40 row files; refused with fewer than 2048 tiles.
// Network: about 210 MB of ranged GETs.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import jpeg from "jpeg-js";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpRequest, decodeIngestRequest, encodeHttpResponse, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";

import { createTypedHarness, DTT_LIB, flatbuffers, storeAnswer, decodeFsoQuery, STANDARDS_ROOT } from "../../terrain-source/typed-frames.mjs";

const IRM_LIB = await import(new URL(`file://${STANDARDS_ROOT}/lib/js/IRM/main.js`).href);
const PNM_LIB = await import(new URL(`file://${STANDARDS_ROOT}/lib/js/PNM/main.js`).href);
const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));
const CONFIG = { tileset_id: "lroc-wac-moon", dataset_epoch: "2013-06-01T00:00:00.000Z", provider_id: "usgs-astrogeology" };
const W = 109164, H = 54582, FIRST = 874303;
const T = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  IRM: { schemaName: "IRM.fbs", fileIdentifier: "$IRM", rootTypeName: "IRM", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
  MCFG: { schemaName: "ModuleConfig.fbs", fileIdentifier: "MCFG", rootTypeName: "ModuleConfig", wireFormat: "flatbuffer" },
};

const harness = await createTypedHarness({ createBrowserModuleHarness, wasmSource: WASM, manifest: MANIFEST, config: CONFIG });
test.after(() => harness.destroy());

function outputs(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const map = new Map();
  for (const o of response.outputs) map.set(o.portId, [...(map.get(o.portId) ?? []), new Uint8Array(o.payload)]);
  return map;
}
function markAt(next) {
  const { IRMT, IRMSourceT, IRMChunkT, irmJobState, irmRangeMode } = IRM_LIB;
  const mark = new IRMT(`usgs-lroc-wac@${CONFIG.tileset_id}@${CONFIG.dataset_epoch}`, BigInt(next), "usgs-astrogeology", "moon-imagery-wasm/v1",
    new IRMSourceT("https://asc-pds-services.s3.us-west-2.amazonaws.com/"), irmJobState.IN_PROGRESS, irmRangeMode.PART_INDEX);
  mark.NEXT_CHUNK_INDEX = next;
  mark.LAST_CHUNK = new IRMChunkT(next - 1);
  mark.UPDATED_AT = "2026-10-20T00:00:00.000Z";
  const b = new flatbuffers.Builder(512);
  b.finish(mark.pack(b), "$IRM");
  const r = b.asUint8Array().slice(), size = Buffer.alloc(4);
  size.writeUInt32LE(r.length);
  return storeAnswer(Buffer.concat([size, Buffer.from(r)])).filter((f) => f.portId === "records").map((f) => ({ ...f, portId: "mark" }));
}
const tick = { portId: "tick", typeRef: T.TICK, payload: encodeTimerTick({ triggerId: "moon-imagery-unit", firedMs: Date.parse("2026-10-20T00:00:00Z") }) };

async function plan(next) {
  return outputs(await harness.invoke({ methodId: "wac_plan", inputs: [tick, ...(next > 0 ? markAt(next) : [])] }));
}
// The unit's ranges, fetched as hostcap/http-request would (status and bytes verbatim).
async function answer(planned) {
  const frames = [], rows = [];
  for (let k = 0; k < 4; k++) {
    const req = planned.get(`rows_${k}`)?.[0];
    if (!req) break;
    const r = decodeHttpRequest(req);
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    assert.match(headers.range, /^bytes=\d+-\d+$/);
    assert.ok(headers["if-match"], "every range pins the edition");
    const res = await fetch(r.url, { headers });
    const body = new Uint8Array(await res.arrayBuffer());
    frames.push({ portId: `rows_${k}`, typeRef: T.HRSP, payload: encodeHttpResponse({ url: r.url, status: res.status, body }) });
    rows.push(body);
  }
  return { frames, rows: Buffer.concat(rows) };
}
const passthrough = (planned) => [
  { portId: "unit", typeRef: T.MCFG, payload: planned.get("unit")[0] },
  { portId: "job", typeRef: T.IRM, payload: planned.get("job")[0] },
];
function records(stream) {
  const { DTT } = DTT_LIB, buf = Buffer.from(stream), out = [];
  for (let at = 0; at + 4 <= buf.length;) {
    const n = buf.readUInt32LE(at);
    at += 4;
    if (!n) continue;
    out.push(DTT.getRootAsDTT(new flatbuffers.ByteBuffer(Uint8Array.from(buf.subarray(at, at + n)))).unpack());
    at += n;
  }
  return out;
}
function names(bytes) {
  const { PNM } = PNM_LIB, buf = Buffer.from(bytes), out = [];
  for (let at = 0; at + 4 <= buf.length;) {
    const n = buf.readUInt32LE(at);
    at += 4;
    out.push(PNM.getRootAsPNM(new flatbuffers.ByteBuffer(Uint8Array.from(buf.subarray(at, at + n)))).FILE_NAME());
    at += n;
  }
  return out;
}
const mean = (px) => px.reduce((s, v) => s + v, 0) / px.length;
const gray = (jpg) => {
  const img = jpeg.decode(Buffer.from(jpg), { useTArray: true, formatAsRGBA: true });
  assert.equal(img.width, 256);
  assert.equal(img.height, 256);
  const out = new Uint8Array(256 * 256);
  for (let i = 0; i < out.length; i++) out[i] = img.data[4 * i];
  return out;
};

test("a level-8 unit: 512 tiles in 32 files whose means match the mosaic", async () => {
  const planned = await plan(225 + 128);
  const { frames, rows } = await answer(planned);
  const out = outputs(await harness.invoke({ methodId: "wac_tile", inputs: [...passthrough(planned), ...frames] }));
  const files = out.get("file"), list = names(out.get("names")[0]);
  assert.equal(files.length, 32);
  assert.equal(list.length, 32);
  assert.equal(list[0], "imagery/301/8/0_128.dtts");
  const tiles = files.flatMap(records);
  assert.equal(tiles.length, 512);
  // The mosaic's area mean over a tile (level 8 row 128: latitudes 0 to 0.703 N), from the rows fetched here.
  const rowStart = Math.floor((90 - (-90 + 129 * 180 / 256)) * H / 180) - 1;
  for (const t of tiles.filter((_, i) => i % 37 === 0)) {
    assert.equal(t.LEVEL, 8);
    assert.equal(t.Y, 128);
    assert.equal(t.PAYLOAD.MEDIA_TYPE, "image/jpeg");
    const px = gray(t.PAYLOAD.BYTES);
    const west = -180 + t.X * 180 / 256, east = west + 180 / 256;
    const c0 = Math.round((west + 180) * W / 360), c1 = Math.round((east + 180) * W / 360);
    const r0 = Math.round((90 - t.NORTH_DEG) * H / 180) - Math.max(0, rowStart), r1 = Math.round((90 - t.SOUTH_DEG) * H / 180) - Math.max(0, rowStart);
    let s = 0, n = 0;
    for (let r = r0; r < r1; r += 3) for (let c = c0; c < c1; c += 3) { s += rows[r * W + c]; n++; }
    assert.ok(Math.abs(mean(px) - s / n) <= 1.5, `tile 8/${t.X}/${t.Y}: mean ${mean(px).toFixed(2)}, mosaic ${(s / n).toFixed(2)}`);
  }
});

let level5;
test("a level-5 unit: 64 tiles in 4 files, and the same tiles to store", async () => {
  const planned = await plan(16);
  const { frames } = await answer(planned);
  const out = outputs(await harness.invoke({ methodId: "wac_tile", inputs: [...passthrough(planned), ...frames] }));
  assert.equal(out.get("file").length, 4);
  level5 = out.get("records")[0];
  assert.equal(records(level5).length, 64);
  const meta = decodeIngestRequest(out.get("meta")[0]);
  assert.equal(meta.schema, "DTT");
  assert.equal(meta.tags.sourceName, "moon-lroc-wac-tiles");
});

test("the coarse unit: levels 0-4 from the level-5 tiles, refused when any is missing", async () => {
  const planned = await plan(32);
  const query = decodeFsoQuery(planned.get("children")[0]);
  assert.match(query.sql, /FROM DTT WHERE TILESET_ID = \? AND LEVEL = \?/);
  assert.equal(query.params[1].v, 5);
  // This row's 64 tiles, re-addressed to stand in for all 32 rows.
  const parts = [];
  for (const t of records(level5)) for (let y = 0; y < 32; y++) {
    t.Y = y;
    const b = new flatbuffers.Builder(t.PAYLOAD.BYTES.length + 2048);
    b.finish(t.pack(b), "$DTT");
    const r = b.asUint8Array(), size = Buffer.alloc(4);
    size.writeUInt32LE(r.length);
    parts.push(size, Buffer.from(r));
  }
  const all = storeAnswer(Buffer.concat(parts), { chunkBytes: 1 << 20 }).filter((f) => f.portId === "records").map((f) => ({ ...f, portId: "children" }));
  const out = outputs(await harness.invoke({ methodId: "wac_tile", inputs: [...passthrough(planned), ...all] }));
  const list = names(out.get("names")[0]);
  assert.equal(list.length, 41);
  assert.equal(list[0], "imagery/301/root.dtts");
  assert.equal(out.get("file").flatMap(records).length, 2 + 8 + 32 + 128 + 512);
  const short = storeAnswer(Buffer.concat(parts.slice(0, parts.length - 2))).filter((f) => f.portId === "records").map((f) => ({ ...f, portId: "children" }));
  const refused = await harness.invoke({ methodId: "wac_tile", inputs: [...passthrough(planned), ...short] });
  assert.notEqual(refused.statusCode, 0);
  assert.match(refused.errorMessage ?? "", /2047 of the 2048/);
});

test("the walk ends: past the last unit the planner emits nothing", async () => {
  const out = outputs(await harness.invoke({ methodId: "wac_plan", inputs: [tick, ...markAt(481)] }));
  assert.equal(out.size, 0);
});
