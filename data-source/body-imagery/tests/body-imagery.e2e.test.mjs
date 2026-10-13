// E2E for data-source/body-imagery: synthetic global GeoTIFFs served in place
// of two real sources (Titan, a near-sphere centred on 180 E, uncompressed
// strips; Ceres, oblate a/c = 1.093, LZW tiles with the horizontal predictor),
// driven through plan_imagery, advance_imagery and build_imagery exactly as
// the flow drives them (one response per request, in order). Each source
// pixel is a known function of IAU planetocentric longitude and latitude, and
// the output is checked against it at planetodetic latitude on the body's
// PCK ellipsoid, so the georeference (central meridian), the latitude
// conversion, the decoders and the tiling are all under test. Then
// announce_imagery: one $PNM per file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

const require = createRequire(import.meta.url);
const jpeg = require("jpeg-js");
const { ByteBuffer } = require("flatbuffers");
const sds = path.dirname(require.resolve("spacedatastandards.org/package.json"));
const { PNM } = await import(pathToFileURL(path.join(sds, "lib/js/PNM/main.js")));
const root = fileURLToPath(new URL("..", import.meta.url));
const wasm = fs.readFileSync(path.join(root, "dist/isomorphic/module.wasm"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin-manifest.json")));

import { CERES, DEG, H, TITAN, W, geotiff, truth } from "./synthetic.mjs";

const input = (portId, value) => {
  const payload = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
  return { portId, payload, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length } };
};
const outs = (r, port) => r.outputs.filter((f) => f.portId === port).map((f) => Buffer.from(f.payload));

function serve(files, request) {
  const r = JSON.parse(request.toString());
  const file = files.get(r.url.replace(/\?sdn-range=.*$/, ""));
  const head = Buffer.alloc(8);
  head.write("$HRB");
  if (!file) { head.writeInt32LE(404, 4); return head; }
  const [first, last] = r.headers.Range.replace("bytes=", "").split("-").map(Number);
  if (first >= file.length) { head.writeInt32LE(416, 4); return head; }
  head.writeInt32LE(206, 4);
  return Buffer.concat([head, file.subarray(first, Math.min(last + 1, file.length))]);
}

async function run(t, files, bodies) {
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: "direct" });
  t.after(() => h.destroy());
  let r = await h.invoke({ methodId: "plan_imagery", inputs: [input("config", { access: "anonymous", bodies })] });
  assert.equal(r.statusCode, 0, r.errorMessage);
  let state = outs(r, "state")[0], requests = outs(r, "request"), stages = 0;
  for (;;) {
    const keepAlive = requests.length === 1 && JSON.parse(requests[0]).headers.Range === "bytes=0-0" && stages > 0;
    const responses = requests.map((q) => serve(files, q));
    r = await h.invoke({ methodId: keepAlive ? "build_imagery" : "advance_imagery", inputs: [input("state", state), ...responses.map((b) => input("response", b))] });
    assert.equal(r.statusCode, 0, r.errorMessage);
    if (keepAlive) return { r, stages, h };
    state = outs(r, "state")[0];
    requests = outs(r, "request");
    assert.ok(++stages < 20, "the run ends");
  }
}

const decoded = (files, name) => jpeg.decode(files.get(name), { useTArray: true });
function filesOf(r) {
  const files = new Map();
  for (const f of outs(r, "file")) { const n = f.readUInt32LE(0); files.set(f.subarray(4, 4 + n).toString(), f.subarray(4 + n)); }
  return files;
}
// The expected output pixel: planetodetic latitude back to planetocentric.
function expected(body, lon, detic) {
  const k = (body.c / body.a) ** 2;
  const centric = Math.atan(k * Math.tan(detic * DEG)) / DEG;
  return truth(lon, centric);
}

test("a centred-on-180 strip mosaic and an oblate LZW-tiled mosaic come out on the planetodetic grid", async (t) => {
  const files = new Map([[TITAN.url, geotiff(TITAN, { tiled: false })], [CERES.url, geotiff(CERES, { tiled: true })]]);
  const { r } = await run(t, files, [TITAN.naif, CERES.naif]);
  const out = filesOf(r);
  const job = JSON.parse(outs(r, "job")[0]);
  assert.equal(job.failed["2000001"], undefined, JSON.stringify(job.failed["2000001"]));
  assert.deepEqual([...out.keys()].sort(), ["imagery/2000001/texture.jpg", "imagery/2000001/tiles.pack", "imagery/606/texture.jpg", "imagery/606/tiles.pack", "imagery/index.json"]);
  assert.equal(job.files.length, 5);
  const index = JSON.parse(out.get("imagery/index.json"));
  assert.equal(index.bodies["606"].maximumLevel, 2);
  assert.match(index.bodies["2000001"].credit, /Dawn/);
  for (const body of [TITAN, CERES]) {
    const img = decoded(out, `imagery/${body.naif}/texture.jpg`);
    assert.equal(img.width, 2048);
    assert.equal(img.height, 1024);
    let worst = 0, sum = 0, n = 0, worstNaive = 0;
    for (const lat of [-60, -45, -20, 0, 20, 45, 60]) for (const lon of [-150, -90, -30, 0, 45, 120, 170]) {
      const x = Math.floor((lon + 180) / 360 * 2048), y = Math.floor((90 - lat) / 180 * 1024);
      const got = img.data[4 * (y * 2048 + x)];
      const want = expected(body, lon + 180 / 2048, 90 - (y + 0.5) * 180 / 1024);
      worst = Math.max(worst, Math.abs(got - want)); sum += Math.abs(got - want); n++;
      worstNaive = Math.max(worstNaive, Math.abs(got - truth(lon, 90 - (y + 0.5) * 180 / 1024)));
    }
    console.log(`${body.naif}: |output - source at the planetodetic place| mean ${(sum / n).toFixed(2)}, worst ${worst} (without the latitude conversion: worst ${worstNaive})`);
    assert.ok(worst <= 6, `${body.naif}: worst ${worst}`);
  }
  // The pack: level 0..2 tiles of 256 px, every tile a JPEG of the right size.
  const pack = out.get("imagery/2000001/tiles.pack");
  assert.equal(pack.subarray(0, 8).toString(), "SDNTILE1");
  assert.equal(pack.readUInt32LE(12), 2 + 8 + 32);
  const first = pack.readUInt32LE(20 + 8), length = pack.readUInt32LE(20 + 12);
  const tile = jpeg.decode(pack.subarray(first, first + length), { useTArray: true });
  assert.equal(tile.width, 256);
  assert.equal(tile.height, 256);
});

test("a source that fails is left out and named; the others are published; announce_imagery emits one $PNM per file", async (t) => {
  const files = new Map([[TITAN.url, geotiff(TITAN, { tiled: false })]]);  // Ceres answers 404
  const { r, h } = await run(t, files, [TITAN.naif, CERES.naif]);
  const out = filesOf(r);
  const job = JSON.parse(outs(r, "job")[0]);
  assert.match(job.failed["2000001"], /HTTP 404/);
  assert.equal(job.files.length, 3);
  const added = job.files.map((f, i) => input("added", { name: f.file, cid: `bafkreitest${i}`, bytes: f.bytes }));
  const a = await h.invoke({ methodId: "announce_imagery", inputs: [input("job", job), input("receipt", { retrieved_at_ms: 1791800000000, producer_peer_id: "16Uiu2HAm1LbvwjEHW2GDP2ZQZvwHLZrz2jbYoRLQmJEQ3wZ5Fm45" }), ...added] });
  assert.equal(a.statusCode, 0, a.errorMessage);
  const stream = outs(a, "records")[0];
  const names = [];
  for (let at = 0; at < stream.length;) { const size = stream.readUInt32LE(at); names.push(PNM.getSizePrefixedRootAsPNM(new ByteBuffer(new Uint8Array(stream.subarray(at, at + 4 + size)))).FILE_NAME()); at += 4 + size; }
  assert.deepEqual(names.sort(), [...out.keys()].sort());
  const meta = JSON.parse(outs(a, "meta")[0]);
  assert.equal(meta.provider_id, "usgs-astrogeology");
  assert.equal(meta.source_name, "body-imagery");
  assert.equal(meta.schema, "PNM.fbs");
});

// The giant planets' cloud maps are JPEGs (Solar System Scope, CC BY 4.0), read
// whole from the first range and decoded in the module: a synthetic 2048 x 1024
// JPEG of the same known function, Saturn's PCK flattening (a/c = 1.109), comes
// out on the planetodetic grid with the north at the top of tile row 0.
const SATURN = { naif: 699, url: "https://www.solarsystemscope.com/textures/download/2k_saturn.jpg", a: 60268.0, c: 54364.0 };
test("a JPEG cloud map (the giant planets) is decoded whole and comes out on the planetodetic grid, north up", async (t) => {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = truth(-180 + (x + 0.5) * 360 / W, 90 - (y + 0.5) * 180 / H);
    rgba.set([v, v, v, 255], 4 * (y * W + x));
  }
  const source = Buffer.from(jpeg.encode({ data: rgba, width: W, height: H }, 95).data);
  assert.ok(source.length < 1 << 20, "the cloud map fits the first range");
  const { r } = await run(t, new Map([[SATURN.url, source]]), [SATURN.naif]);
  const out = filesOf(r);
  const job = JSON.parse(outs(r, "job")[0]);
  assert.equal(job.failed["699"], undefined, JSON.stringify(job.failed["699"]));
  const index = JSON.parse(out.get("imagery/index.json"));
  assert.equal(index.bodies["699"].maximumLevel, 2);
  assert.match(index.bodies["699"].licence, /CC BY 4\.0/);
  const img = decoded(out, "imagery/699/texture.jpg");
  let worst = 0;
  for (const lat of [-60, -30, 0, 30, 60]) for (const lon of [-150, -60, 0, 90, 170]) {
    const x = Math.floor((lon + 180) / 360 * 2048), y = Math.floor((90 - lat) / 180 * 1024);
    worst = Math.max(worst, Math.abs(img.data[4 * (y * 2048 + x)] - expected(SATURN, lon + 180 / 2048, 90 - (y + 0.5) * 180 / 1024)));
  }
  assert.ok(worst <= 8, `worst ${worst}`);
  // Tile 1/0/0 is the north-west quarter: its top row is the north pole's row.
  const pack = out.get("imagery/699/tiles.pack");
  for (let i = 0; i < pack.readUInt32LE(12); i++) {
    const at = 20 + 16 * i;
    if (pack[at] !== 1 || pack.readUInt16LE(at + 2) !== 0 || pack.readUInt16LE(at + 4) !== 0) continue;
    const tile = jpeg.decode(pack.subarray(pack.readUInt32LE(at + 8), pack.readUInt32LE(at + 8) + pack.readUInt32LE(at + 12)), { useTArray: true });
    const top = tile.data[4 * (2 * 256 + 128)], bottom = tile.data[4 * (253 * 256 + 128)];
    // lon -135, near 90 N against near 0 N.
    assert.ok(Math.abs(top - truth(-135, 89)) <= 10 && Math.abs(bottom - truth(-135, 1)) <= 10, `top ${top}, bottom ${bottom}`);
  }
});
