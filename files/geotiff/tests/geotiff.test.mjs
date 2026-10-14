// files/geotiff end to end through the built artifact: every fixture is
// written by GDAL (tests/make-fixtures.py) and every reference window is
// GDAL's own warp of it to EPSG:4326 (nearest neighbour, same window and
// size), so the expectations come from an independent implementation.
//
// Tolerances: lossless codecs must match GDAL's samples exactly; a pixel may
// differ only where nearest-neighbour picks the neighbouring source pixel
// (a pixel centre within float rounding of a source pixel edge), at most
// 0.5 % of the window. JPEG decodes with stb_image here and libjpeg in GDAL
// (different IDCT and chroma upsampling): channels within 12 of GDAL's.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { GDI } from "spacedatastandards.org/lib/js/GDI/GDI.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const WASM = path.join(root, "dist", "isomorphic", "module.wasm");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin-manifest.json"), "utf8"));
const skip = !fs.existsSync(WASM) && "run `npm run build` first";
const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(here, "fixtures", name)));
const cases = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "cases.json"), "utf8"));

/** Size-prefixed SDS $NCD describing the GeoTIFF. */
function descriptor(size) {
  const b = new flatbuffers.Builder(64);
  const name = b.createString("GeoTIFF");
  NCD.startNCD(b);
  NCD.addFormat(b, 255);
  NCD.addProviderDefinedFormatName(b, name);
  NCD.addSourceByteLength(b, BigInt(size));
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  return b.asUint8Array();
}

/** Raw lane: [u32le count][(u64le offset, u32le length, bytes)...] */
function rangesFrame(ranges) {
  const total = 4 + ranges.reduce((n, r) => n + 12 + r.bytes.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, ranges.length, true);
  let at = 4;
  for (const r of ranges) {
    view.setBigUint64(at, BigInt(r.offset), true);
    view.setUint32(at + 8, r.bytes.byteLength, true);
    out.set(r.bytes, at + 12);
    at += 12 + r.bytes.byteLength;
  }
  return out;
}

const ncdRef = (n) => ({ schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD", wireFormat: "flatbuffer", byteLength: n });
const rawRef = (n) => ({ acceptsAnyFlatbuffer: true, byteLength: n });
const outputs = (r, port) => r.outputs.filter((o) => o.portId === port).map((o) => new Uint8Array(o.payload));
const f64 = (bytes) => Array.from(new Float64Array(bytes.slice().buffer));

/** Call a method the way a COG reader over HTTP would: 16 KiB first, then exactly the ranges named on "need". */
async function call(harness, methodId, file, request) {
  const ranges = [{ offset: 0, bytes: file.subarray(0, 16384) }];
  let fetched = 16384;
  for (let round = 0; round < 8; round += 1) {
    const d = descriptor(file.byteLength);
    const pieces = rangesFrame(ranges);
    const inputs = [
      { portId: "descriptor", typeRef: ncdRef(d.byteLength), payload: d },
      { portId: "ranges", typeRef: rawRef(pieces.byteLength), payload: pieces },
    ];
    if (request) inputs.push({ portId: "request", typeRef: rawRef(request.byteLength), payload: request });
    const r = await harness.invoke({ methodId, inputs });
    const [need] = outputs(r, "need");
    if (!need) return { r, rounds: round + 1, fetched };
    const pairs = f64(need);
    assert.ok(pairs.length >= 2 && pairs.length % 2 === 0);
    for (let i = 0; i < pairs.length; i += 2) {
      ranges.push({ offset: pairs[i], bytes: file.subarray(pairs[i], pairs[i] + pairs[i + 1]) });
      fetched += pairs[i + 1];
    }
  }
  throw new Error("the module kept asking for ranges");
}

function requestOf(window, stretch) {
  const [west, south, east, north, w, h] = window;
  const s = stretch ?? [NaN, NaN, NaN, NaN, NaN, NaN];
  return new Uint8Array(new Float64Array([1, -1, west, south, east, north, w, h, ...s, 0, 0]).buffer);
}

test("artifact passes SDK compliance and exports both methods", { skip }, async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath: WASM, standardsRoot: path.join(root, "node_modules", "spacedatastandards.org") });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("describe: a COG's footprint and levels from its header alone", { skip }, async (t) => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest, surface: "direct" });
  t.after(() => harness.destroy());
  const file = fixture("rgb-4326-jpeg-cog.tif");
  const { r, rounds } = await call(harness, "describe", file);
  assert.equal(r.statusCode, 0, r.errorMessage);
  assert.equal(rounds, 1, "a COG's header fits the first fetch");
  const [info] = outputs(r, "info");
  const gdi = GDI.getSizePrefixedRootAsGDI(new flatbuffers.ByteBuffer(info));
  assert.equal(gdi.REGION_SRID(), 4326);
  const ring = JSON.parse(gdi.REGION_GEO_JSON()).coordinates[0];
  const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
  assert.ok(Math.abs(Math.min(...lons) + 77.3) < 1e-9 && Math.abs(Math.max(...lons) + 76.8) < 1e-9);
  assert.ok(Math.abs(Math.min(...lats) - 38.7) < 1e-9 && Math.abs(Math.max(...lats) - 39.0) < 1e-9);
  const t0 = f64(outputs(r, "levels")[0]);
  assert.equal(t0[0], 1);
  assert.equal(t0[2], 4326);
  assert.ok(t0[1] >= 2, "overviews listed");
  assert.deepEqual(t0.slice(14, 16), [512, 384]);
});

test("describe: UTM footprint matches GDAL's corner transform", { skip }, async (t) => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest, surface: "direct" });
  t.after(() => harness.destroy());
  const { r } = await call(harness, "describe", fixture("u16-32633-deflate-pred2.tif"));
  assert.equal(r.statusCode, 0, r.errorMessage);
  const gdi = GDI.getSizePrefixedRootAsGDI(new flatbuffers.ByteBuffer(outputs(r, "info")[0]));
  const ring = JSON.parse(gdi.REGION_GEO_JSON()).coordinates[0];
  // gdaltransform -s_srs EPSG:32633 -t_srs EPSG:4326 (PROJ 9), corners (420000 5308480) and (435360 5320000):
  const ll = ring[0], ur = ring[32];
  assert.ok(Math.abs(ll[0] - 13.9291015773) < 1e-8 && Math.abs(ll[1] - 47.9246463244) < 1e-7, JSON.stringify(ll));
  assert.ok(Math.abs(ur[0] - 14.1329533183) < 1e-8 && Math.abs(ur[1] - 48.0300156557) < 1e-7, JSON.stringify(ur));
});

for (const c of cases) {
  test(`render ${c.name} matches GDAL's warp`, { skip }, async (t) => {
    const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest, surface: "direct" });
    t.after(() => harness.destroy());
    const file = fixture(`${c.name}.tif`);
    const { r } = await call(harness, "render", file, requestOf(c.window, c.stretch));
    assert.equal(r.statusCode, 0, r.errorMessage);
    const [got] = outputs(r, "image");
    const want = fixture(`${c.name}.rgba`);
    assert.equal(got.byteLength, want.byteLength);
    const tol = c.name.includes("jpeg") ? 12 : 0;
    let off = 0, opaque = 0;
    for (let i = 0; i < want.length; i += 4) {
      if (want[i + 3]) opaque += 1;
      const differs = got[i + 3] !== want[i + 3] || [0, 1, 2].some((k) => Math.abs(got[i + k] - want[i + k]) > tol);
      if (differs) off += 1;
    }
    const pixels = want.length / 4;
    assert.ok(opaque > pixels * 0.2, "the window shows the image");
    assert.ok(off <= pixels * 0.005, `${off} of ${pixels} pixels differ from GDAL`);
  });
}

test("render: an unstated stretch is the window's 2-98 % and is reported", { skip }, async (t) => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest, surface: "direct" });
  t.after(() => harness.destroy());
  const c = cases.find((x) => x.name === "u16-32633-deflate-pred2");
  const { r } = await call(harness, "render", fixture(`${c.name}.tif`), requestOf(c.window));
  assert.equal(r.statusCode, 0, r.errorMessage);
  const [lo, hi, ...rest] = f64(outputs(r, "stats")[0]);
  // The fixture's samples are 1000 + 40 * (0..255) (tests/make-fixtures.py); 2-98 % lies strictly inside.
  assert.ok(lo > 1000 && hi < 1000 + 40 * 255 && hi - lo > 40 * 100, `${lo} ${hi}`);
  assert.ok(rest.every(Number.isNaN), "one band: no stretch for bands 2 and 3");
});

test("refusals name the reason: WebP compression", { skip }, async (t) => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest, surface: "direct" });
  t.after(() => harness.destroy());
  const { r } = await call(harness, "describe", fixture("rgb-webp-cog.tif"));
  assert.notEqual(r.statusCode, 0);
  assert.match(r.errorMessage, /WebP/);
});

test("ports carry what they say: a descriptor that is not $NCD is refused by name", { skip }, async (t) => {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest, surface: "direct" });
  t.after(() => harness.destroy());
  const file = fixture("rgb-4326-jpeg-cog.tif");
  const pieces = rangesFrame([{ offset: 0, bytes: file.subarray(0, 16384) }]);
  const r = await harness.invoke({ methodId: "describe", inputs: [
    { portId: "descriptor", typeRef: ncdRef(pieces.byteLength), payload: pieces },
    { portId: "ranges", typeRef: rawRef(pieces.byteLength), payload: pieces },
  ] });
  assert.notEqual(r.statusCode, 0);
  assert.match(`${r.errorCode} ${r.errorMessage}`, /descriptor|NCD|type/i);
  const ok = await call(harness, "describe", file);
  assert.equal(ok.r.statusCode, 0, ok.r.errorMessage);
  const [info] = ok.r.outputs.filter((o) => o.portId === "info");
  assert.equal(info.wireFormat, "flatbuffer", "info is a regular FlatBuffer");
  assert.equal(info.typeRef?.schemaName, "GDI.fbs");
});
