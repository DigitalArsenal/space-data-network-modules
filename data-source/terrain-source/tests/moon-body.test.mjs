// THE MOON, ON THE REAL LANE (moon-terrain-lane-20261013). terrain-ingest:lola_plan plans real units of the walk,
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

import { decodeQuantizedMesh } from "./helpers.mjs";
import { granuleFrame, planInputs } from "../typed-frames.mjs";
import { lolaFrames, moonPlan, MOON_RADIUS_M } from "../lola-frames.mjs";
import { createMoonLane, dttOf } from "../tools/moon-lane.mjs";

const LOLA_DIR = process.env.LOLA_DIR;
const skip = !(LOLA_DIR && fs.existsSync(`${LOLA_DIR}/ldem_64_float.img`)) && "LOLA_DIR unset";
const R = MOON_RADIUS_M;
const L7_FIRST_UNIT = 1 + 2 + 4 + 8 + 16;  // root, then block rows of L3 (LDEM_4), L4-5 (LDEM_16), L6 (LDEM_64)

const rad = (d) => (d * Math.PI) / 180;
function tileOf(sized) {
  const t = dttOf(sized.subarray(4)).unpack();
  const payload = Buffer.from(t.PAYLOAD.BYTES);
  return { t, payload, mesh: decodeQuantizedMesh(zlib.gunzipSync(payload)) };
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
test.before(async () => { if (!skip) lane = await createMoonLane({ lolaDir: LOLA_DIR }); });
test.after(() => lane?.destroy());

test("a level-7 Moon tile is a body record with normals, on the 1737.4 km sphere, under the 32 KiB ceiling", { skip }, async () => {
  const unit = await lane.planUnit(L7_FIRST_UNIT + 15);  // tile rows 60-63, the equatorial band
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
    assert.ok(payload.length <= 32768, `${key}: ${payload.length} bytes`);
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

// Shared posts of two adjacent tiles: same place, same height to within both tiles' height quantization, same normal.
function compareEdge(a, b, edgeOfA, edgeOfB, along) {
  const all = [vertices(a), vertices(b)];
  const normal = (tile, i) => `${tile.mesh.extensions[0].bytes[2 * i]},${tile.mesh.extensions[0].bytes[2 * i + 1]}`;
  const byPos = new Map();
  all[1].forEach((w, j) => { if (edgeOfB(w)) byPos.set(along(w).toFixed(9), j); });
  let shared = 0, sameNormal = 0;
  all[0].forEach((v, i) => {
    if (!edgeOfA(v)) return;
    const j = byPos.get(along(v).toFixed(9));
    if (j === undefined) return;
    shared++;
    const w = all[1][j];
    assert.ok(Math.abs(v.h - w.h) <= quantum(a.mesh) + quantum(b.mesh) + 1e-6, `height ${v.h} vs ${w.h}`);
    if (normal(a, i) === normal(b, j)) sameNormal++;
  });
  return { shared, sameNormal };
}

test("adjacent Moon tiles agree on every shared post: east-west, north-south, across the antimeridian, at both poles and on the polar product (0 cracks)", { skip }, async () => {
  const equator = await lane.planUnit(L7_FIRST_UNIT + 15);
  const pole = await lane.planUnit(L7_FIRST_UNIT + 31);  // rows 124-127: the north pole row
  const eq = await lane.encode(equator, (k) => ["7/100/60", "7/101/60", "7/100/61", "7/0/62", "7/255/62"].includes(k));
  const np = await lane.encode(pole, (k) => ["7/10/127", "7/11/127", "7/140/127"].includes(k));
  const polarUnit = await lane.unitFor(10, 1000, 0, 143, 199);
  const sp = await lane.encode(polarUnit, (k) => ["10/1000/0", "10/1001/0", "10/1000/1"].includes(k));
  const T = (r, k) => tileOf(r.byKey.get(k));
  const pairs = [
    ["polar east-west", T(sp, "10/1000/0"), T(sp, "10/1001/0"), (v) => v.u === 32767, (v) => v.u === 0, (v) => v.lat],
    ["polar north-south", T(sp, "10/1000/0"), T(sp, "10/1000/1"), (v) => v.v === 32767, (v) => v.v === 0, (v) => v.lon],
    ["east-west", T(eq, "7/100/60"), T(eq, "7/101/60"), (v) => v.u === 32767, (v) => v.u === 0, (v) => v.lat],
    ["north-south", T(eq, "7/100/60"), T(eq, "7/100/61"), (v) => v.v === 32767, (v) => v.v === 0, (v) => v.lon],
    ["antimeridian", T(eq, "7/255/62"), T(eq, "7/0/62"), (v) => v.u === 32767, (v) => v.u === 0, (v) => v.lat],
    ["pole east-west", T(np, "7/10/127"), T(np, "7/11/127"), (v) => v.u === 32767, (v) => v.u === 0, (v) => v.lat],
  ];
  for (const [name, a, b, ea, eb, along] of pairs) {
    const { shared, sameNormal } = compareEdge(a, b, ea, eb, along);
    assert.ok(shared >= 5, `${name}: ${shared} shared posts`);
    assert.ok(sameNormal >= shared - 1, `${name}: ${sameNormal} of ${shared} shared normals identical`);
  }
  // Every pole post of every tile touching the pole is one height: the mean of LDEM_64's first line.
  const poleHeights = ["7/10/127", "7/11/127", "7/140/127"].flatMap((k) => vertices(T(np, k)).filter((v) => v.v === 32767).map((v) => v.h));
  const spread = Math.max(...poleHeights) - Math.min(...poleHeights);
  const southPole = ["10/1000/0", "10/1001/0"].flatMap((k) => vertices(T(sp, k)).filter((v) => v.v === 0).map((v) => v.h));
  assert.ok(Math.max(...southPole) - Math.min(...southPole) <= 2 * Math.max(quantum(T(sp, "10/1000/0").mesh), quantum(T(sp, "10/1001/0").mesh)) + 1e-6);
  assert.ok(spread <= 2 * Math.max(...["7/10/127", "7/11/127", "7/140/127"].map((k) => quantum(T(np, k).mesh))) + 1e-6, `pole spread ${spread} m`);
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
  const label = Buffer.from(fs.readFileSync(`${LOLA_DIR}/ldem_64_float.lbl`, "utf8").replace("PC_REAL", "MSB_INTEGER"));
  assert.equal((await run(moonPlan(tile), [granuleFrame("dem", label), ...frames.slice(1)])).errorCode, "pds-label-unsupported");
  // And the frames that are right encode.
  assert.equal((await run(moonPlan(tile))).statusCode, 0);
});

test("pack writes the root file and whole 4x4 block files, each a size-prefixed $DTT stream in (level, y, x) order", { skip }, async () => {
  for (const [index, expect] of [[0, { files: ["terrain/301/root.dtts"], tiles: 42 }], [1, { files: 4, tiles: 64 }]]) {
    const unit = await lane.planUnit(index);
    const { response, records } = await lane.encode(unit);
    assert.equal(response.statusCode, 0, response.errorMessage);
    const files = await lane.pack(unit, records);
    if (Array.isArray(expect.files)) assert.deepEqual(files.map((f) => f.name), expect.files);
    else assert.equal(files.length, expect.files);
    let tiles = 0;
    for (const f of files) {
      const addresses = [];
      for (let at = 0; at < f.bytes.length;) {
        const len = f.bytes.readUInt32LE(at);
        const t = dttOf(f.bytes.subarray(at + 4, at + 4 + len));
        addresses.push([t.LEVEL(), t.Y(), t.X()]);
        at += 4 + len;
      }
      tiles += addresses.length;
      const sorted = [...addresses].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      assert.deepEqual(addresses, sorted, `${f.name} is in (level, y, x) order`);
      if (f.name !== "terrain/301/root.dtts") {
        assert.equal(addresses.length, 16, `${f.name} is a whole block`);
        const [, level, bx, by] = f.name.match(/^terrain\/301\/(\d+)\/(\d+)_(\d+)\.dtts$/).map(Number);
        for (const [l, y, x] of addresses) assert.deepEqual([l, x >> 2, y >> 2], [level, bx, by]);
      }
    }
    assert.equal(tiles, expect.tiles);
  }
});
