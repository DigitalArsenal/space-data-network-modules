// THE MOON, ON THE REAL LANE (moon-terrain-lane-20261013). terrain-ingest:body_plan plans real units of the walk,
// their requests are answered from local copies of the PDS LOLA products (public domain) exactly as the PDS server
// answers them, and terrain-source:tile encodes them. Every assertion is checked against an independent reading of
// the bytes: the quantized-mesh decoder in helpers.mjs (written from the spec), the record through the SDS library,
// positions on the 1737.4 km sphere and the oct-normal decode written from Cesium's AttributeCompression.
//
// Needs LOLA_DIR with ldem_4/16/64 and ldem_75s_60m (*.img + *.lbl) from
// https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/; skipped without.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import zlib from "node:zlib";
import { decodeEdgeMatchedPlanes, EDGE_MATCHED_PLANES } from "../tools/edge-matched-planes.mjs";

import { decodeQuantizedMesh } from "./helpers.mjs";
import { granuleFrame, planInputs } from "../typed-frames.mjs";
import { lolaFrames, moonPlan, MOON_RADIUS_M } from "../lola-frames.mjs";
import { createBodyLane, dttOf } from "../tools/body-lane.mjs";

const LOLA_DIR = process.env.LOLA_DIR;
const skip = !(LOLA_DIR && fs.existsSync(`${LOLA_DIR}/ldem_64_float.img`)) && "LOLA_DIR unset";
const R = MOON_RADIUS_M;
const L7_FIRST_UNIT = 1 + 2 + 4 + 8 + 16;  // root, then block rows of L3 (LDEM_4), L4-5 (LDEM_16), L6 (LDEM_64)

const rad = (d) => (d * Math.PI) / 180;
function tileOf(sized) {
  const t = dttOf(sized.subarray(4)).unpack();
  const payload = Buffer.from(t.PAYLOAD.BYTES);
  assert.equal(t.PAYLOAD.CONTENT_ENCODING, EDGE_MATCHED_PLANES);
  return { t, payload, mesh: decodeQuantizedMesh(decodeEdgeMatchedPlanes(payload)) };
}
// A decoded vertex: its lon/lat on the tile's own lattice, height, body-fixed position.
function vertices({ t, mesh }) {
  const out = [];
  for (let i = 0; i < mesh.vertexCount; i++) {
    const lon = t.WEST_DEG + (mesh.u[i] / 32767) * (t.EAST_DEG - t.WEST_DEG);
    const lat = t.SOUTH_DEG + (mesh.v[i] / 32767) * (t.NORTH_DEG - t.SOUTH_DEG);
    const h = mesh.header.minHeight + (mesh.h[i] / 32767) * (mesh.header.maxHeight - mesh.header.minHeight);
    const r = R + h;
    out.push({ u: mesh.u[i], v: mesh.v[i], lon, lat, h, p: [r * Math.cos(rad(lat)) * Math.cos(rad(lon)), r * Math.cos(rad(lat)) * Math.sin(rad(lon)), r * Math.sin(rad(lat))] });
  }
  return out;
}
// Cesium AttributeCompression.octDecodeInRange(x, y, 255).
function octDecode(x, y) {
  let nx = (x / 255) * 2 - 1, ny = (y / 255) * 2 - 1;
  const nz = 1 - (Math.abs(nx) + Math.abs(ny));
  if (nz < 0) {
    const ox = nx;
    nx = (1 - Math.abs(ny)) * (ox < 0 ? -1 : 1);
    ny = (1 - Math.abs(ox)) * (ny < 0 ? -1 : 1);
  }
  const len = Math.hypot(nx, ny, nz);
  return [nx / len, ny / len, nz / len];
}
const quantum = (mesh) => (mesh.header.maxHeight - mesh.header.minHeight) / 32767;

let lane;
test.before(async () => { if (!skip) lane = await createBodyLane({ dataDir: LOLA_DIR }); });
test.after(() => lane?.destroy());

test("a level-7 Moon tile is a body record with normals, on the 1737.4 km sphere, under the 32 KiB ceiling", { skip }, async () => {
  const unit = await lane.planUnit(L7_FIRST_UNIT + 30);  // tile rows 60-63, the equatorial band
  const want = new Set(["7/100/60", "7/101/60", "7/100/61"]);
  const { response, byKey } = await lane.encode(unit, (k) => want.has(k));
  assert.equal(response.statusCode, 0, response.errorMessage);
  for (const key of want) {
    const tile = tileOf(byKey.get(key));
    const { t, payload, mesh } = tile;
    assert.equal(t.TILING_SCHEME, 5, "GEOGRAPHIC_TWO_ROOT_BODY");
    assert.equal(t.CENTER_NAME, "MOON");
    assert.deepEqual([...t.REFERENCE_RADII_M], [R]);
    assert.equal(t.VERTICAL_DATUM, 6, "REFERENCE_SPHERE");
    assert.equal(t.HORIZONTAL_DATUM_NAME, "MOON_ME (DE421 mean Earth/polar axis)");
    assert.equal(t.SOURCE_CLASS, 3, "SPACEBORNE_ALTIMETRIC");
    assert.equal(t.WATER_MASK_KIND, 0, "no water mask on the Moon");
    assert.equal(t.PROVENANCE.NATIVE_ID, "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_64_float::1.0");
    assert.equal(t.PROVENANCE.DATASET_EPOCH, "2019-03-15T00:00:00.000Z");
    // The unchanged miniz gzip(QM) ceiling is checked against the previous encoder in lossless-format.e2e.mjs.
    assert.ok(payload.length > 104, `${key}: planes header and height data`);
    assert.deepEqual(mesh.extensions.map((e) => e.id), [1], "normals and nothing else");
    assert.equal(mesh.extensions[0].bytes.length, 2 * mesh.vertexCount);

    // Header geometry from the decoded vertices on the sphere: the centre is their mean, every vertex lies inside
    // the bounding sphere, and the horizon point (scaled by 1/R) is outside the unit sphere along the centre.
    const vs = vertices(tile);
    const c = [0, 1, 2].map((k) => vs.reduce((s, v) => s + v.p[k], 0) / vs.length);
    const hdr = mesh.header;
    // Decoded u/v place a vertex to within span/32767 of its lattice post (~1.3 m here), heights to the quantum.
    const placement = (R * rad(t.EAST_DEG - t.WEST_DEG)) / 32767 + 2 * quantum(mesh);
    assert.ok(Math.hypot(hdr.centerX - c[0], hdr.centerY - c[1], hdr.centerZ - c[2]) < placement);
    for (const v of vs) assert.ok(Math.hypot(v.p[0] - hdr.sphereX, v.p[1] - hdr.sphereY, v.p[2] - hdr.sphereZ) <= hdr.sphereRadius + placement);
    const occ = [hdr.occlusionX, hdr.occlusionY, hdr.occlusionZ], occLen = Math.hypot(...occ);
    assert.ok(occLen >= 1 && occLen < 1.01, `scaled horizon point |p| = ${occLen}`);
    const cLen = Math.hypot(...c);
    assert.ok(occ.reduce((s, x, k) => s + (x / occLen) * (c[k] / cLen), 0) > 0.999999);

    // Normals: unit, outward, and within a few degrees of the decoded surface's own area-weighted normals.
    const index = new Map(vs.map((v, i) => [`${v.u}/${v.v}`, i]));
    const face = vs.map(() => [0, 0, 0]);
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const [a, b, d] = [mesh.indices[k], mesh.indices[k + 1], mesh.indices[k + 2]].map((i) => vs[i].p);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      for (const i of [mesh.indices[k], mesh.indices[k + 1], mesh.indices[k + 2]]) for (let q = 0; q < 3; q++) face[i][q] += n[q];
    }
    const angles = [];
    vs.forEach((v, i) => {
      const n = octDecode(mesh.extensions[0].bytes[2 * i], mesh.extensions[0].bytes[2 * i + 1]);
      const radial = v.p.map((x) => x / Math.hypot(...v.p));
      assert.ok(n[0] * radial[0] + n[1] * radial[1] + n[2] * radial[2] > 0.5, "outward");
      const f = face[i], fl = Math.hypot(...f);
      const interior = v.u > 0 && v.u < 32767 && v.v > 0 && v.v < 32767;
      if (interior) angles.push((Math.acos(Math.min(1, (n[0] * f[0] + n[1] * f[1] + n[2] * f[2]) / fl)) * 180) / Math.PI);
    });
    angles.sort((a, b) => a - b);
    assert.ok(angles[Math.floor(angles.length / 2)] < 3, `${key}: median normal vs face normal ${angles[Math.floor(angles.length / 2)]} deg`);
    assert.ok(index.size === vs.length, "every lattice position once");
  }
});

// THE SEAM BETWEEN TWO NEIGHBOURS, MEASURED AS THE POLYLINES THEY RENDER. Each tile's edge is its edge vertices (the
// mesh's own edge index lists) in order along the edge; the gap is the largest vertical distance between the two
// polylines, each evaluated linearly at every vertex of the other. Comparing only the posts both tiles happen to
// carry would miss exactly the case that matters - neighbours on different densities whose posts interleave.
function edgeLine(tile, side) {
  const vs = vertices(tile);
  const along = side === "east" || side === "west" ? (w) => w.v : (w) => w.u;
  return tile.mesh.edges[side].map((i) => ({ s: along(vs[i]), h: vs[i].h, n: normalOf(tile, i) })).sort((p, q) => p.s - q.s);
}
const normalOf = (tile, i) => `${tile.mesh.extensions[0].bytes[2 * i]},${tile.mesh.extensions[0].bytes[2 * i + 1]}`;
function heightAt(line, s) {
  let k = 0;
  while (k + 1 < line.length && line[k + 1].s < s) k++;
  if (k + 1 >= line.length || line[k + 1].s === line[k].s) return line[k].h;
  return line[k].h + ((s - line[k].s) / (line[k + 1].s - line[k].s)) * (line[k + 1].h - line[k].h);
}
function seam(a, b, sideOfA, sideOfB) {
  const A = edgeLine(a, sideOfA), B = edgeLine(b, sideOfB);
  const gap = Math.max(...A.map((p) => Math.abs(p.h - heightAt(B, p.s))), ...B.map((p) => Math.abs(p.h - heightAt(A, p.s))));
  const samePosts = A.length === B.length && A.every((p, k) => p.s === B[k].s);
  const sameNormals = samePosts && A.every((p, k) => p.n === B[k].n);
  return { gap, samePosts, sameNormals, tolerance: quantum(a.mesh) + quantum(b.mesh) + 1e-6 };
}
// The interior density a tile settled on: its distinct interior columns, plus the two edges.
const density = (tile) => new Set(tile.mesh.u.filter((u) => u > 0 && u < 32767)).size + 2;

test("Moon neighbours render one edge polyline whatever density each settles on: east-west, north-south, across units, the antimeridian, both poles and the polar product (0 cracks)", { skip }, async () => {
  const equator = await lane.planUnit(L7_FIRST_UNIT + 30);  // rows 60-63
  const below = await lane.planUnit(L7_FIRST_UNIT + 28);    // rows 56-59
  const pole = await lane.planUnit(L7_FIRST_UNIT + 62);     // rows 124-127: the north pole row
  // A 32 x 2 block of the equatorial band, every tile, so neighbours on different densities are measured too.
  const block = (k) => { const [l, x, y] = k.split("/").map(Number); return l === 7 && x >= 96 && x < 128 && (y === 60 || y === 61); };
  const eq = await lane.encode(equator, (k) => block(k) || ["7/0/62", "7/255/62"].includes(k));
  // Each block row now has two 32-block units. Fetch the eastern half for the antimeridian and pole checks.
  const east = await lane.encode(await lane.planUnit(L7_FIRST_UNIT + 31), (k) => k === "7/255/62");
  for (const [key, sized] of east.byKey) eq.byKey.set(key, sized);
  const south = await lane.encode(below, (k) => k === "7/100/59");
  const np = await lane.encode(pole, (k) => ["7/10/127", "7/11/127", "7/140/127"].includes(k));
  const poleEast = await lane.encode(await lane.planUnit(L7_FIRST_UNIT + 63), (k) => k === "7/140/127");
  for (const [key, sized] of poleEast.byKey) np.byKey.set(key, sized);
  const polarUnit = await lane.unitFor(10, 1000, 0, 143);
  const sp = await lane.encode(polarUnit, (k) => ["10/1000/0", "10/1001/0", "10/1000/1"].includes(k));
  const T = (r, k) => tileOf(r.byKey.get(k));
  const pairs = [
    ["polar east-west", T(sp, "10/1000/0"), T(sp, "10/1001/0"), "east", "west"],
    ["polar north-south", T(sp, "10/1000/0"), T(sp, "10/1000/1"), "north", "south"],
    ["across units", T(south, "7/100/59"), T(eq, "7/100/60"), "north", "south"],
    ["antimeridian", T(eq, "7/255/62"), T(eq, "7/0/62"), "east", "west"],
    ["pole east-west", T(np, "7/10/127"), T(np, "7/11/127"), "east", "west"],
  ];
  for (let x = 96; x < 128; x++) {
    for (const y of [60, 61]) {
      if (x < 127) pairs.push([`7/${x}/${y} east`, T(eq, `7/${x}/${y}`), T(eq, `7/${x + 1}/${y}`), "east", "west"]);
    }
    pairs.push([`7/${x}/60 north`, T(eq, `7/${x}/60`), T(eq, `7/${x}/61`), "north", "south"]);
  }
  let mixed = 0;
  for (const [name, a, b, sa, sb] of pairs) {
    const { gap, samePosts, sameNormals, tolerance } = seam(a, b, sa, sb);
    assert.ok(samePosts, `${name}: the two edges carry different posts`);
    assert.ok(sameNormals, `${name}: a shared post's normal differs`);
    assert.ok(gap <= tolerance, `${name}: edge polylines part by ${gap} m (height quantization ${tolerance} m)`);
    if (density(a) !== density(b)) mixed++;
  }
  assert.ok(mixed >= 20, `only ${mixed} of ${pairs.length} pairs settled on different densities`);
  // Every pole post of every tile touching the pole is one height: the mean of LDEM_64's first line.
  const poleHeights = ["7/10/127", "7/11/127", "7/140/127"].flatMap((k) => vertices(T(np, k)).filter((v) => v.v === 32767).map((v) => v.h));
  const spread = Math.max(...poleHeights) - Math.min(...poleHeights);
  const southPole = ["10/1000/0", "10/1001/0"].flatMap((k) => vertices(T(sp, k)).filter((v) => v.v === 0).map((v) => v.h));
  assert.ok(Math.max(...southPole) - Math.min(...southPole) <= 2 * Math.max(quantum(T(sp, "10/1000/0").mesh), quantum(T(sp, "10/1001/0").mesh)) + 1e-6);
  assert.ok(spread <= 2 * Math.max(...["7/10/127", "7/11/127", "7/140/127"].map((k) => quantum(T(np, k).mesh))) + 1e-6, `pole spread ${spread} m`);
  // Every mesh covers its tile exactly once: every triangle counter-clockwise, their areas summing to the square.
  for (const [k, sized] of eq.byKey) {
    const { mesh } = tileOf(sized);
    let area = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
      const twice = (mesh.u[b] - mesh.u[a]) * (mesh.v[c] - mesh.v[a]) - (mesh.u[c] - mesh.u[a]) * (mesh.v[b] - mesh.v[a]);
      assert.ok(twice > 0, `${k}: triangle ${i / 3} is not counter-clockwise`);
      area += twice / 2;
    }
    assert.equal(area, 32767 * 32767, `${k}: triangles cover ${area} of the tile's ${32767 * 32767}`);
  }
});

test("a body plan is refused when it is not a reference sphere, names Earth, or disagrees with the product's label", { skip }, async () => {
  // Tile 7/100/60 spans latitudes -5.625..-4.21875: LDEM_64 lines ~5995-6125 with the halo.
  const frames = lolaFrames(LOLA_DIR, "ldem_64", 5980, 160, 1);
  const run = (plan, dem = frames) => lane.source.invoke({ methodId: "tile", inputs: [...planInputs(plan), ...dem] });
  const tile = [{ level: 7, x: 100, y: 60 }];
  assert.equal((await run(moonPlan(tile, { options: { referenceRadiiM: [1738100, 1736000] } }))).errorCode, "unsupported-reference-body");
  assert.equal((await run(moonPlan(tile, { options: { centerName: "EARTH" } }))).errorCode, "bad-body-plan");
  assert.equal((await run(moonPlan(tile, { options: { referenceRadiiM: [1737000] } }))).errorCode, "pds-reference-mismatch");
  // The lines the tile needs are not all there: refused, never filled.
  const short = lolaFrames(LOLA_DIR, "ldem_64", 6040, 40, 1);
  assert.equal((await run(moonPlan(tile), short)).errorCode, "pds-band-gap");
  // A range that is not whole lines, and a label for another sample type.
  const bad = [frames[0], granuleFrame("dem", Buffer.alloc(92160 + 7), 206, { headers: { "content-range": `bytes 0-${92160 + 6}/1061683200` } })];
  assert.equal((await run(moonPlan(tile), bad)).errorCode, "pds-range-unsupported");
  const text = fs.readFileSync(`${LOLA_DIR}/ldem_64_float.lbl`, "utf8");
  const label = Buffer.from(text.replace("PC_REAL", "MSB_INTEGER"));
  assert.equal((await run(moonPlan(tile), [granuleFrame("dem", label), ...frames.slice(1)])).errorCode, "pds-label-unsupported");
  // Heights stored above an OFFSET that is not the body's A_AXIS_RADIUS.
  const offset = Buffer.from(text.replace(/^(\s*OFFSET\s*=\s*)1737\.4/m, "$11737.0"));
  assert.notEqual(offset.toString(), text);
  const refused = await run(moonPlan(tile), [granuleFrame("dem", offset), ...frames.slice(1)]);
  assert.equal(refused.errorCode, "pds-label-unsupported");
  assert.match(refused.errorMessage, /OFFSET/);
  // And the frames that are right encode.
  assert.equal((await run(moonPlan(tile))).statusCode, 0);
});

test("a cylindrical product's pole is the mean of its edge line's MEASURED posts: a non-finite post does not move it", { skip }, async () => {
  // Tile 2/0/3 (45-90 N, 180-135 W) from LDEM_4: lines 0-189 hold it with the halo. One post of line 0 - on the far
  // side of the body from this tile - is made NaN.
  const [labelFrame] = lolaFrames(LOLA_DIR, "ldem_4", 0, 1, 1);
  const recordBytes = 1440 * 4, lines = 190;
  const body = Buffer.alloc(lines * recordBytes);
  const fd = fs.openSync(`${LOLA_DIR}/ldem_4_float.img`, "r");
  try { fs.readSync(fd, body, 0, body.length, 0); } finally { fs.closeSync(fd); }
  body.writeFloatLE(NaN, 0);
  let sum = 0, measured = 0;
  for (let s = 0; s < 1440; s++) {
    const km = body.readFloatLE(s * 4);
    if (Number.isFinite(km)) { sum += km * 1000; measured++; }
  }
  assert.equal(measured, 1439);
  const range = granuleFrame("dem", body, 206, { headers: { "content-range": `bytes 0-${body.length - 1}/${720 * recordBytes}` } });
  const plan = moonPlan([{ level: 2, x: 0, y: 3 }], { product: "ldem_4" });
  const response = await lane.source.invoke({ methodId: "tile", inputs: [...planInputs(plan), labelFrame, range] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const records = Buffer.from(response.outputs.find((o) => o.portId === "records").payload);
  const tile = tileOf(records.subarray(0, 4 + records.readUInt32LE(0)));
  const pole = vertices(tile).filter((v) => v.v === 32767).map((v) => v.h);
  assert.ok(pole.length >= 2);
  for (const h of pole) assert.ok(Math.abs(h - sum / measured) <= quantum(tile.mesh) + 1e-6, `pole ${h} m against the measured mean ${sum / measured} m`);
});

test("pack writes the root file and whole 4x4 block files, each a size-prefixed $DTT stream in (level, y, x) order", { skip }, async () => {
  for (const [index, expect] of [[0, { files: ["terrain/301/root.dtts.gz"], tiles: 42 }], [1, { files: 4, tiles: 64 }]]) {
    const unit = await lane.planUnit(index);
    const { response, records } = await lane.encode(unit);
    assert.equal(response.statusCode, 0, response.errorMessage);
    const files = await lane.pack(unit, records);
    if (Array.isArray(expect.files)) assert.deepEqual(files.map((f) => f.name), expect.files);
    else assert.equal(files.length, expect.files);
    let tiles = 0;
    for (const f of files) {
      const addresses = [];
      const bytes = zlib.gunzipSync(f.bytes);
      for (let at = 0; at < bytes.length;) {
        const len = bytes.readUInt32LE(at);
        const t = dttOf(bytes.subarray(at + 4, at + 4 + len));
        addresses.push([t.LEVEL(), t.Y(), t.X()]);
        at += 4 + len;
      }
      tiles += addresses.length;
      const sorted = [...addresses].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      assert.deepEqual(addresses, sorted, `${f.name} is in (level, y, x) order`);
      if (f.name !== "terrain/301/root.dtts.gz") {
        assert.equal(addresses.length, 16, `${f.name} is a whole block`);
        const [, level, bx, by] = f.name.match(/^terrain\/301\/(\d+)\/(\d+)_(\d+)\.dtts\.gz$/).map(Number);
        for (const [l, y, x] of addresses) assert.deepEqual([l, x >> 2, y >> 2], [level, bx, by]);
      }
    }
    assert.equal(tiles, expect.tiles);
  }
});
