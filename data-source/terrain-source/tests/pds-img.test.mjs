// THE PDS PRODUCTS ARE READ WHERE THEIR LABELS AND CATALOGS SAY (moon-terrain-lane-20261013).
//
// Each check reads the raw LOLA image here, independently of the module, with the projection the PDS documents state:
//   SIMPLE CYLINDRICAL (the product label): pixel-registered, line = (90 - lat) * ppd - 0.5, sample = lon_E * ppd - 0.5;
//   POLAR STEREOGRAPHIC (catalog/dsmap_polar.cat): r = 2 R tan((90 - |lat|)/2), sample = c + r sin(lon)/s, line =
//   c - r cos(lon)/s in the south (c = N/2 - 0.5, s = MAP_SCALE), "longitude 0 straight up, 90 E to the right".
// and compares the module's mesh posts to it; and the two products are compared with EACH OTHER where they overlap,
// which is the check a mirrored or rotated polar convention cannot pass.
//
// Needs LOLA_DIR (ldem_64, ldem_75s_60m, ldem_75s_240m, ldem_75n_240m *.img + *.lbl); skipped without.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import zlib from "node:zlib";

import { decodeQuantizedMesh } from "./helpers.mjs";
import { cylindrical, polar, product } from "./lola-reference.mjs";
import { createMoonLane, dttOf } from "../tools/moon-lane.mjs";

const LOLA_DIR = process.env.LOLA_DIR;
const skip = !(LOLA_DIR && fs.existsSync(`${LOLA_DIR}/ldem_75s_240m_float.img`)) && "LOLA_DIR unset";

// The mesh's posts (exact positions on the plan's 321-post lattice, which every vertex of a body mesh sits on)
// against the independent reading.
function compareMesh(sized, reference) {
  const t = dttOf(sized.subarray(4)).unpack();
  const mesh = decodeQuantizedMesh(zlib.gunzipSync(Buffer.from(t.PAYLOAD.BYTES)));
  const grid = 321;
  const q = (mesh.header.maxHeight - mesh.header.minHeight) / 32767;
  let worst = 0;
  for (let k = 0; k < mesh.vertexCount; k++) {
    const i = Math.round((mesh.u[k] / 32767) * (grid - 1)), j = Math.round((mesh.v[k] / 32767) * (grid - 1));
    const lon = t.WEST_DEG + (i * (t.EAST_DEG - t.WEST_DEG)) / (grid - 1);
    const lat = t.SOUTH_DEG + (j * (t.NORTH_DEG - t.SOUTH_DEG)) / (grid - 1);
    if (Math.abs(lat) >= 89.99) continue;  // the pole posts are the edge line's mean (moon-body.test.mjs)
    const h = mesh.header.minHeight + mesh.h[k] * q;
    worst = Math.max(worst, Math.abs(h - reference(lat, lon)) - q);
  }
  return worst;
}

let lane;
test.before(async () => { if (!skip) lane = await createMoonLane({ lolaDir: LOLA_DIR }); });
test.after(() => lane?.destroy());

test("simple cylindrical: the mesh posts are LDEM_64 where its label puts them, across the antimeridian", { skip }, async () => {
  const p = product("ldem_64_float", 23040, 11520);
  const unit = await lane.planUnit(1 + 2 + 4 + 8 + 16 + 15);
  const want = ["7/100/60", "7/0/62", "7/255/62"];
  const { byKey } = await lane.encode(unit, (k) => want.includes(k));
  for (const key of want) {
    const worst = compareMesh(byKey.get(key), cylindrical(p, 64));
    assert.ok(worst < 0.01, `${key}: a post is ${worst} m from the label's position`);
  }
  p.close();
});

test("polar stereographic: the mesh posts are LDEM_75S_60M where DSMAP_POLAR puts them", { skip }, async () => {
  const p = product("ldem_75s_60m_float", 15248, 15248);
  const unit = await lane.unitFor(10, 1000, 0, 143, 199);
  const want = ["10/1000/0", "10/1001/0", "10/1000/1"];
  const { byKey } = await lane.encode(unit, (k) => want.includes(k));
  for (const key of want) {
    const worst = compareMesh(byKey.get(key), polar(p, 60, true));
    assert.ok(worst < 0.01, `${key}: a post is ${worst} m from DSMAP_POLAR's position`);
  }
  p.close();
});

test("the polar and global products agree where they overlap (76-88 degrees), which no mirrored convention does", { skip }, () => {
  const g = product("ldem_64_float", 23040, 11520);
  for (const [name, south] of [["ldem_75s_240m_float", true], ["ldem_75n_240m_float", false]]) {
    const p = product(name, 3812, 3812);
    const read = polar(p, 240, south), mirrored = (lat, lon) => read(lat, -lon);
    const errors = [], mirroredErrors = [];
    for (const latAbs of [76, 80, 84, 88]) {
      for (let lon = 0; lon < 360; lon += 15) {
        const lat = south ? -latAbs : latAbs, truth = cylindrical(g, 64)(lat, lon);
        errors.push(read(lat, lon) - truth);
        mirroredErrors.push(mirrored(lat, lon) - truth);
      }
    }
    const rms = (e) => Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length);
    // The two are different editions (LDEM_64 V3.1 2019, polar V2.1 2016/2017): tens of metres apart, kilometres if
    // the convention were wrong.
    assert.ok(rms(errors) < 40, `${name}: RMS ${rms(errors)} m`);
    assert.ok(rms(mirroredErrors) > 500, `${name}: a mirrored reading must not agree (${rms(mirroredErrors)} m)`);
    p.close();
  }
  g.close();
});
