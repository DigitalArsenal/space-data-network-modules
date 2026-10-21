// PDS LOLA north twins: built planner -> range frames -> built lossless encoder -> independent PDS bilinear.
// Heights are metres above the 1737.4 km LOLA sphere, MOON_ME; polar V2.1 products, 2016-09-15.
// The tolerance is one mesh quantum + 0.5 m (float32 DEM/interpolation/mesh rounding).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createHarness, irmRecord, jobIdOf, markFrames, outputs, tickFrame } from "./typed.mjs";
import { createBodyLane, dttOf, MOON_CONFIG } from "../../terrain-source/tools/body-lane.mjs";
import { decodeEdgeMatchedPlanes } from "../../terrain-source/tools/edge-matched-planes.mjs";
import { decodeQuantizedMesh } from "../../terrain-source/tests/helpers.mjs";
import { polar } from "../../terrain-source/tests/lola-reference.mjs";

const cap = (product, lo, hi, a, b) => ({ product, min_level: lo, max_level: hi, lat_min: a, lat_max: b });
// Copy of ladder-reachable.e2e.mjs LADDER; importing a test would run its unrelated checks.
const LADDER = [
  cap("ldem_4", 0, 3, -90, 90), cap("ldem_16", 4, 5, -90, 90), cap("ldem_64", 6, 7, -90, 90),
  cap("ldem_75s_240m", 8, 8, -90, -75.9375), cap("ldem_128", 8, 8, -75.9375, 75.9375), cap("ldem_75n_240m", 8, 8, 75.9375, 90),
  cap("ldem_75s_120m", 9, 9, -90, -78.75), cap("ldem_256", 9, 9, -78.75, 78.75), cap("ldem_75n_120m", 9, 9, 78.75, 90),
  cap("ldem_75s_60m", 10, 10, -90, -84.375), cap("ldem_512", 10, 10, -84.375, 84.375), cap("ldem_75n_60m", 10, 10, 84.375, 90),
  cap("ldem_80s_20m", 11, 11, -90, -80.15625), cap("ldem_875s_5m", 12, 12, -90, -87.5390625),
];
const caps = [...LADDER, cap("ldem_80n_20m", 11, 11, 80.15625, 90), cap("ldem_875n_5m", 12, 12, 87.5390625, 90)];
const CAP_FIRST_UNIT = [1, 3, 15, 95, 115, 331, 351, 415, 1311, 1375, 1503, 5343, 5471, 6389];
const dataDir = process.env.LOLA_HD_DIR;
const skip = !dataDir && "LOLA_HD_DIR unset";
const jobId = jobIdOf("nasa-lola-gdr", MOON_CONFIG.tileset_id, MOON_CONFIG.dataset_epoch);

// Same independent polar() oracle as pds-img.test.mjs, with the HD directory and a bounded line cache.
function product(name, n) {
  const fd = fs.openSync(`${dataDir}/${name}_float.img`, "r");
  const cache = new Map();
  return { n, lines: n, close: () => fs.closeSync(fd), at(j, i) {
    if (!cache.has(j)) {
      const line = Buffer.alloc(n * 4);
      assert.equal(fs.readSync(fd, line, 0, line.length, j * n * 4), line.length);
      if (cache.size >= 512) cache.delete(cache.keys().next().value);
      cache.set(j, line);
    }
    return cache.get(j).readFloatLE(i * 4) * 1000;
  } };
}

test("north twins append without moving a LADDER unit and encode the authoritative north polar surfaces", { skip, timeout: 20 * 60 * 1000 }, async (t) => {
  const prefix = await createHarness(t, { ...MOON_CONFIG, caps: LADDER });
  const extended = await createHarness(t, { ...MOON_CONFIG, caps });
  async function plan(harness, index) {
    const inputs = [tickFrame("2026-10-21T00:00:00Z")];
    if (index) inputs.push(...markFrames([irmRecord({ jobId, next: index, provider: "nasa-lola" })]));
    const response = await harness.invoke({ methodId: "body_plan", inputs });
    assert.equal(response.statusCode, 0, response.errorMessage);
    return outputs(response);
  }
  const sampled = new Set([0, 26579]);
  for (const first of CAP_FIRST_UNIT) { sampled.add(first); sampled.add(first - 1); }
  for (let i = 1999; i < 26580; i += 1999) sampled.add(i);
  for (const index of [...sampled].sort((a, b) => a - b)) {
    const a = await plan(prefix, index), b = await plan(extended, index);
    assert.ok(a.has("plan"), `prefix unit ${index}`);
    for (const port of ["plan", "options", "pack", ...Array.from({ length: 16 }, (_, i) => `dem_${i}`)]) {
      assert.deepEqual(b.get(port), a.get(port), `unit ${index} ${port} byte-identical`);
    }
  }
  assert.ok(!(await plan(extended, 47688)).has("plan"), "unit 47688 is past the end");
  assert.ok((await plan(extended, 47687)).has("plan"), "last twin unit exists");
  const lane = await createBodyLane({ dataDir, config: { ...MOON_CONFIG, caps } });
  t.after(() => lane.destroy());
  for (const [index, name, n, scale, etag] of [
    [26580, "ldem_80n_20m", 30400, 20, '\"a5a6f46154d21:0\"'],
    [27498, "ldem_875n_5m", 30336, 5, '\"70325a4f154d21:0\"'],
  ]) {
    const unit = await lane.planUnit(index);
    assert.equal(unit.requests.length, 4);
    for (const r of unit.requests) {
      assert.ok(r.url.includes(`/polar/float_img/${name}_float.`), r.url);
      if (r.url.endsWith(".img")) assert.equal(r.headers["if-match"], etag);
    }
    const encoded = await lane.encode(unit);
    assert.equal(encoded.response.statusCode, 0, encoded.response.errorMessage);
    assert.equal(encoded.byKey.size, unit.headers.length);
    const p = product(name, n), reference = polar(p, scale, false);
    let vertices = 0, worst = 0;
    try {
      for (const [key, sized] of encoded.byKey) {
        const tile = dttOf(sized.subarray(4)).unpack();
        const mesh = decodeQuantizedMesh(decodeEdgeMatchedPlanes(tile.PAYLOAD.BYTES));
        const quantum = (mesh.header.maxHeight - mesh.header.minHeight) / 32767;
        for (let k = 0; k < mesh.vertexCount; k++) {
          const i = Math.round(mesh.u[k] / 32767 * 320), j = Math.round(mesh.v[k] / 32767 * 320);
          const lon = tile.WEST_DEG + i * (tile.EAST_DEG - tile.WEST_DEG) / 320;
          const lat = tile.SOUTH_DEG + j * (tile.NORTH_DEG - tile.SOUTH_DEG) / 320;
          if (Math.abs(lat) >= 89.99) continue; // pole-edge means, as in pds-img.test.mjs
          const delta = Math.abs(mesh.header.minHeight + mesh.h[k] * quantum - reference(lat, lon));
          assert.ok(Number.isFinite(delta) && delta <= quantum + 0.5, `${key} vertex ${k}: ${delta} > ${quantum + 0.5} m`);
          worst = Math.max(worst, delta); vertices++;
        }
      }
    } finally { p.close(); }
    t.diagnostic(`${name}: unit ${index}, ${encoded.byKey.size} tiles, ${vertices} vertices, max error ${worst.toFixed(6)} m`);
  }
  t.diagnostic(`${sampled.size} prefix units byte-identical; end 47688`);
});
