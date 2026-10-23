// THE MOON'S MID-LATITUDE RELIEF COMES FROM SLDEM2015 (moon-terrain-wall-banding-20261023; owner 2026-10-23 chose
// SLDEM2015). Inside +/-60 degrees LDEM_128/256/512 are LOLA ground tracks (0.3-2 km apart at 22N) linearly
// interpolated across the gaps: north-south ruled facets that render as banded crater walls. SLDEM2015 (LOLA
// co-registered with SELENE Terrain Camera stereo, Barker et al. 2016; PDS LOLA RDR bundle, data/sldem2015/) has
// none. SLDEM_LADDER is LADDER with L8-L10 inside the band taken from SLDEM2015 and LDEM kept from the band edge to
// the polar caps. Band edges sit on 4x4 block rows (L8 and L9 +-59.0625, L10 +-59.765625), so no block file is
// written by two caps and every tile keeps its parent.
//
// The last test runs the BUILT module: every planned tile lies in a row of SLDEM_LADDER, and every SLDEM tile's
// ranges are asked of the sldem2015 files (and every LDEM tile's of the ldem files), sampled over the whole walk.

import assert from "node:assert/strict";
import test from "node:test";

import { createHarness, decodeHttpRequest, irmRecord, jobIdOf, markFrames, outputs, tickFrame, decodePlan } from "./typed.mjs";

const cap = (product, lo, hi, a, b) => ({ product, min_level: lo, max_level: hi, lat_min: a, lat_max: b });
const L8 = 59.0625, L9 = 59.0625, L10 = 59.765625;

// ladder-reachable.e2e.mjs LADDER plus the north twins: the ladder terrain/301 is published from (MANIFEST caps).
const LADDER = [
  cap("ldem_4", 0, 3, -90, 90), cap("ldem_16", 4, 5, -90, 90), cap("ldem_64", 6, 7, -90, 90),
  cap("ldem_75s_240m", 8, 8, -90, -75.9375), cap("ldem_128", 8, 8, -75.9375, 75.9375), cap("ldem_75n_240m", 8, 8, 75.9375, 90),
  cap("ldem_75s_120m", 9, 9, -90, -78.75), cap("ldem_256", 9, 9, -78.75, 78.75), cap("ldem_75n_120m", 9, 9, 78.75, 90),
  cap("ldem_75s_60m", 10, 10, -90, -84.375), cap("ldem_512", 10, 10, -84.375, 84.375), cap("ldem_75n_60m", 10, 10, 84.375, 90),
  cap("ldem_80s_20m", 11, 11, -90, -80.15625), cap("ldem_875s_5m", 12, 12, -90, -87.5390625),
  cap("ldem_80n_20m", 11, 11, 80.15625, 90), cap("ldem_875n_5m", 12, 12, 87.5390625, 90),
];

export const SLDEM_LADDER = LADDER.flatMap((c) => {
  if (c.product === "ldem_128") return [cap("ldem_128", 8, 8, -75.9375, -L8), cap("sldem2015_128", 8, 8, -L8, L8), cap("ldem_128", 8, 8, L8, 75.9375)];
  if (c.product === "ldem_256") return [cap("ldem_256", 9, 9, -78.75, -L9), cap("sldem2015_256", 9, 9, -L9, L9), cap("ldem_256", 9, 9, L9, 78.75)];
  if (c.product === "ldem_512") return [cap("ldem_512", 10, 10, -84.375, -L10), cap("sldem2015_512", 10, 10, -L10, L10), cap("ldem_512", 10, 10, L10, 84.375)];
  return [c];
});

const tileSize = (level) => 180 / 2 ** level;
const inside = (c, level, y) => {
  const south = -90 + y * tileSize(level), north = south + tileSize(level);
  return south >= c.lat_min && north <= c.lat_max;
};
/** The cap that builds row y of a level (levels 0-2 are the root's). */
const capOf = (level, y) => SLDEM_LADDER.find((c) => level >= Math.max(c.min_level, 3) && level <= c.max_level && inside(c, level, y));

test("SLDEM_LADDER: band edges on block rows, levels 0-10 cover the body, no orphans, no block written twice", () => {
  for (const [level, edge] of [[8, L8], [9, L9], [10, L10]]) {
    const rows = (90 + edge) / tileSize(level);
    assert.equal(rows % 4, 0, `L${level} edge ${edge} is a block-row edge`);
  }
  const rows = new Map(), writers = new Map();
  for (let level = 0; level <= 2; level++) rows.set(level, new Set(Array.from({ length: 2 ** level }, (_, y) => y)));
  for (const c of SLDEM_LADDER) {
    for (let level = Math.max(c.min_level, 3); level <= c.max_level; level++) {
      const set = rows.get(level) ?? new Set();
      for (let y = 0; y < 2 ** level; y++) if (inside(c, level, y)) {
        set.add(y);
        writers.set(`${level}/${y >> 2}`, (writers.get(`${level}/${y >> 2}`) ?? new Set()).add(SLDEM_LADDER.indexOf(c)));
      }
      rows.set(level, set);
    }
  }
  for (let level = 0; level <= 10; level++) assert.equal(rows.get(level).size, 2 ** level, `L${level} covers every row`);
  for (const [level, set] of rows) if (level > 2) for (const y of set) assert.ok(rows.get(level - 1).has(y >> 1), `L${level} row ${y} has its parent`);
  assert.deepEqual([...writers].filter(([, s]) => s.size > 1).map(([k]) => k), []);
  // SLDEM2015 covers +/-60: every SLDEM tile lies inside it.
  for (const c of SLDEM_LADDER.filter((c) => c.product.startsWith("sldem2015"))) assert.ok(c.lat_min >= -60 && c.lat_max <= 60);
});

const CONFIG = { tileset_id: "nasa-lola-moon", dataset_epoch: "2019-03-15T00:00:00.000Z" };
const JOB = jobIdOf("nasa-lola-gdr", CONFIG.tileset_id, CONFIG.dataset_epoch);

test("the built body_plan walks SLDEM_LADDER: SLDEM rows read sldem2015 files, LDEM rows ldem files", { timeout: 30 * 60 * 1000 }, async () => {
  const harness = await createHarness(null, { ...CONFIG, caps: SLDEM_LADDER });
  const plan = async (index) => {
    const inputs = [tickFrame("2026-10-23T00:00:00Z")];
    if (index > 0) inputs.push(...markFrames([irmRecord({ jobId: JOB, next: index, provider: "nasa-lola" })]));
    const out = outputs(await harness.invoke({ methodId: "body_plan", inputs }));
    if (!out.has("plan")) return null;
    const requests = Array.from({ length: 16 }, (_, k) => out.get(`dem_${k}`)?.[0]).filter(Boolean).map(decodeHttpRequest);
    return { tiles: decodePlan(out.get("plan")[0]), urls: requests.map((r) => r.url) };
  };
  // The walk's length, by bisection on the first unplanned unit.
  let lo = 1, hi = 1;
  while (await plan(hi)) { lo = hi; hi *= 2; }
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await plan(mid)) lo = mid; else hi = mid; }
  const units = hi;
  const seen = new Map();
  for (let index = 0; index < units; index += index < 20 ? 1 : 97) {
    const unit = await plan(index);
    assert.ok(unit, `unit ${index} is planned`);
    const files = unit.urls.filter((u) => u.endsWith(".img")).map((u) => u.split("/").at(-1));
    for (const t of unit.tiles) {
      if (t.level <= 2) continue;
      const c = capOf(t.level, t.y);
      assert.ok(c, `unit ${index}: tile ${t.level}/${t.x}/${t.y} lies in no planned row`);
      const want = `${c.product}_`;
      assert.ok(files.some((f) => f.startsWith(want)), `unit ${index}: ${c.product} tile ${t.level}/${t.x}/${t.y} reads ${files.join(",")}`);
      if (c.product.startsWith("sldem2015")) assert.ok(unit.urls.every((u) => u.includes("/data/sldem2015/")), `unit ${index}: SLDEM unit reads only sldem2015 files`);
      seen.set(c.product, (seen.get(c.product) ?? 0) + 1);
    }
  }
  for (const p of ["sldem2015_128", "sldem2015_256", "sldem2015_512", "ldem_128", "ldem_256", "ldem_512"]) assert.ok(seen.get(p) > 0, `the sample reaches ${p}`);
  harness.destroy?.();
});
