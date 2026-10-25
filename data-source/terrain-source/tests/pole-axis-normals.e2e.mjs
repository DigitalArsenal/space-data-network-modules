// A post on the body's axis takes the axis as its normal (body-terrain-pole-normals-encoder-20261023). A pole is one
// point but a whole lattice row, and the halo row past it folds back across the pole, so the summed cell normal there
// cancelled its radial part: before the fix, the Moon's L7 pole posts sat 90.3 deg from the axis (the record measured
// 90-101 deg on six bodies). The built module, on the real lane (terrain-ingest:body_plan, NASA PDS LOLA LDEM_64),
// encodes every tile of both L7 pole rows of the Moon (2 x 256 tiles) and:
//   1. every pole post's decoded normal is the axis (+z north, -z south) to within the normals' own quantization:
//      the module writes oct normals at 8 bits a component (Cesium octEncodeInRange 255), and the axis lies between
//      four codes, so the decoded axis is off by at most the angle of the nearest of them, computed below (0.3203 deg);
//   2. the next row of posts is untouched: the median angle of its normals from the radial direction is the value the
//      build without the pole rule gives, per pole (the pole rule writes only on-axis posts; on these 512 tiles every
//      other post's normal bytes are identical with and without it).
// Needs LOLA_DIR with ldem_4/16/64 (*.img + *.lbl) from
// https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/; skipped without.
//   LOLA_DIR=<dir> node --test tests/pole-axis-normals.e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { decodeEdgeMatchedPlanes, EDGE_MATCHED_PLANES } from "../tools/edge-matched-planes.mjs";
import { decodeQuantizedMesh } from "./helpers.mjs";
import { createBodyLane, dttOf } from "../tools/body-lane.mjs";

const LOLA_DIR = process.env.LOLA_DIR;
const skip = !(LOLA_DIR && fs.existsSync(`${LOLA_DIR}/ldem_64_float.img`)) && "LOLA_DIR unset";
const L7_FIRST_UNIT = 1 + 2 + 4 + 8 + 16;  // root, then block rows of L3 (LDEM_4), L4-5 (LDEM_16), L6 (LDEM_64)
const rad = Math.PI / 180;
const degBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / rad;
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
// The axis's exact oct coordinate is (127.5, 127.5): the nearest codes are the four around it, and the encoder writes
// one of them. The tolerance is the largest angle any of them decodes to from the axis.
const AXIS_TOLERANCE_DEG = Math.max(...[[127, 127], [127, 128], [128, 127], [128, 128]].map(([x, y]) => degBetween(octDecode(x, y), [0, 0, 1])));
// The median angle from the radial direction of the posts in the row next to each pole, from the build without the
// pole rule (measured 2026-10-25 on this lane: identical normal bytes away from the poles in both builds).
const NEXT_ROW_MEDIAN_DEG = { north: 83.50479954777018, south: 89.06870708869508 };

let lane;
test.before(async () => { if (!skip) lane = await createBodyLane({ dataDir: LOLA_DIR }); });
test.after(() => lane?.destroy());

test("every on-axis pole post of the Moon's L7 pole rows takes the axis as its normal; the next row is unchanged", { skip }, async () => {
  assert.ok(Math.abs(AXIS_TOLERANCE_DEG - 0.3203) < 1e-3, `oct quantization at the axis ${AXIS_TOLERANCE_DEG} deg`);
  const tiles = [];
  for (const [unit, row] of [[L7_FIRST_UNIT, 0], [L7_FIRST_UNIT + 1, 0], [L7_FIRST_UNIT + 62, 127], [L7_FIRST_UNIT + 63, 127]]) {
    const { response, byKey } = await lane.encode(await lane.planUnit(unit), (k) => Number(k.split("/")[2]) === row);
    assert.equal(response.statusCode, 0, response.errorMessage);
    for (const [key, sized] of byKey) {
      const t = dttOf(sized.subarray(4)).unpack();
      assert.equal(t.PAYLOAD.CONTENT_ENCODING, EDGE_MATCHED_PLANES);
      tiles.push({ key, t, mesh: decodeQuantizedMesh(decodeEdgeMatchedPlanes(Buffer.from(t.PAYLOAD.BYTES))) });
    }
  }
  assert.equal(tiles.length, 512, "both pole rows, 256 tiles each");
  let worst = 0, poles = 0;
  const next = { north: [], south: [] };
  for (const { key, t, mesh } of tiles) {
    const north = t.NORTH_DEG === 90;
    assert.ok(north || t.SOUTH_DEG === -90, `${key} touches a pole`);
    const axis = [0, 0, north ? 1 : -1], poleV = north ? 32767 : 0;
    const rows = [...new Set(mesh.v)].sort((p, q) => (north ? q - p : p - q));
    assert.equal(rows[0], poleV, `${key}: its pole row is a lattice row`);
    const normal = (i) => octDecode(mesh.extensions[0].bytes[2 * i], mesh.extensions[0].bytes[2 * i + 1]);
    for (let i = 0; i < mesh.vertexCount; i++) {
      if (mesh.v[i] === poleV) {
        const a = degBetween(normal(i), axis);
        assert.ok(a <= AXIS_TOLERANCE_DEG + 1e-9, `${key}: pole post ${i} is ${a} deg from the axis (quantization ${AXIS_TOLERANCE_DEG} deg)`);
        worst = Math.max(worst, a);
        poles++;
      } else if (mesh.v[i] === rows[1]) {
        const lon = (t.WEST_DEG + (mesh.u[i] / 32767) * (t.EAST_DEG - t.WEST_DEG)) * rad;
        const lat = (t.SOUTH_DEG + (mesh.v[i] / 32767) * (t.NORTH_DEG - t.SOUTH_DEG)) * rad;
        next[north ? "north" : "south"].push(degBetween(normal(i), [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]));
      }
    }
  }
  assert.equal(poles, 2560, "five pole posts a tile");
  for (const side of ["north", "south"]) {
    const a = next[side].sort((p, q) => p - q), median = a[a.length >> 1];
    assert.equal(median, NEXT_ROW_MEDIAN_DEG[side], `${side}: the next row's median normal angle from radial moved (${median} deg)`);
  }
  console.log(`PASS ${poles} pole posts on 512 Moon L7 tiles, worst ${worst.toFixed(4)} deg from the axis (quantization ${AXIS_TOLERANCE_DEG.toFixed(4)} deg); ` +
    `next-row medians ${NEXT_ROW_MEDIAN_DEG.north} / ${NEXT_ROW_MEDIAN_DEG.south} deg from radial, unchanged`);
});
