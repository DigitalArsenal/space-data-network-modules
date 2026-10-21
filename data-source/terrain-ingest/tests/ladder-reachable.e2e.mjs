// THE MOON LADDER REACHES EVERY TILE IT PLANS (moon-terrain-ring-gaps-20261021). The console fetches a tile's
// children only when they are published, and upsamples the parent everywhere else, so a planned tile whose parent is
// never planned is never shown. The shipped ladder (stack deployment/solar-system-provider-node/deploy/host-config.py
// MOON_IMPORT_CAPS, origin/main 2026-10-21) misses three rings, because its cap bands end off 4x4 block boundaries:
//   L8  73.125-75.234375 N and S (the 240 m caps start at row 75.234375, LDEM_128 ends at 73.125),
//   L9  78.75-80.15625 N and S, L10 -85.078125..-84.375,
// so the L9-L11 tiles under them are orphans.
//
// LADDER is the ladder the lossless republish encodes (one fresh edition, so no unit or file is re-issued): per
// level the cylindrical band and the polar caps meet ON a 4x4 block-row edge (L8 +-75.9375, L9 +-78.75, L10
// +-84.375, L11 +-80.15625, L12 +-87.5390625), so no block file is written by two caps, levels 0-10 cover the whole
// body, and every tile at L >= 3 has its parent. 47,688 units (walk port, 2026-10-21): files per level L7 2,048,
// L8 8,192, L9 32,768, L10 131,072, L11 57,344, L12 57,344 (+ the root).
//
// Every cap writes whole tile rows (all longitudes): which tiles a ladder plans is, per level, which ROWS its caps
// take - the rule in body_plan.hpp body_tile_inside: a row is a cap's when its whole extent lies inside the cap's
// band. The last test reads that rule off the BUILT module at sampled units of LADDER (the first and last unit of
// every cap, every 1,999th) and checks the ladder's length.

import assert from "node:assert/strict";
import test from "node:test";

import { createHarness, irmRecord, jobIdOf, markFrames, outputs, tickFrame, decodePlan } from "./typed.mjs";

const cap = (product, lo, hi, a, b) => ({ product, min_level: lo, max_level: hi, lat_min: a, lat_max: b });

// host-config.py MOON_IMPORT_CAPS (= MOON_CAPS + the import's caps), as on stack origin/main 2026-10-21.
export const SHIPPED_CAPS = [
  cap("ldem_4", 0, 3, -90, 90), cap("ldem_16", 4, 5, -90, 90), cap("ldem_64", 6, 7, -90, 90),
  cap("ldem_75s_240m", 8, 8, -90, -75), cap("ldem_75n_240m", 8, 8, 75, 90),
  cap("ldem_75s_120m", 9, 9, -90, -80), cap("ldem_75n_120m", 9, 9, 80, 90),
  cap("ldem_75s_60m", 10, 10, -90, -85),
  cap("ldem_128", 8, 8, -73.125, 73.125),
  cap("ldem_256", 9, 9, -78.75, 78.75), cap("ldem_75n_60m", 10, 10, 84.375, 90),
  cap("ldem_80s_20m", 11, 11, -90, -80.15625), cap("ldem_512", 10, 10, -84.375, 84.375),
  cap("ldem_875s_5m", 12, 12, -90, -87.5390625),
];

// The republish ladder, in unit order. The north twins (moon-terrain-north-twins-20261021) come last, so this
// prefix plans the same units with or without them.
export const LADDER = [
  cap("ldem_4", 0, 3, -90, 90), cap("ldem_16", 4, 5, -90, 90), cap("ldem_64", 6, 7, -90, 90),
  cap("ldem_75s_240m", 8, 8, -90, -75.9375), cap("ldem_128", 8, 8, -75.9375, 75.9375), cap("ldem_75n_240m", 8, 8, 75.9375, 90),
  cap("ldem_75s_120m", 9, 9, -90, -78.75), cap("ldem_256", 9, 9, -78.75, 78.75), cap("ldem_75n_120m", 9, 9, 78.75, 90),
  cap("ldem_75s_60m", 10, 10, -90, -84.375), cap("ldem_512", 10, 10, -84.375, 84.375), cap("ldem_75n_60m", 10, 10, 84.375, 90),
  cap("ldem_80s_20m", 11, 11, -90, -80.15625), cap("ldem_875s_5m", 12, 12, -90, -87.5390625),
];
// First unit of each cap (walk port of body_units_in, 2026-10-21); LADDER plans units 0..26579.
const CAP_FIRST_UNIT = [1, 3, 15, 95, 115, 331, 351, 415, 1311, 1375, 1503, 5343, 5471, 6389];
const LADDER_UNITS = 26580;
const FULL_LEVELS = 10;  // levels 0..10 cover the whole body

const ROOT_MAX_LEVEL = 2;
const tileSize = (level) => 180 / 2 ** level;
// body_plan.hpp body_tile_inside, in the same double arithmetic.
const inside = (c, level, y) => {
  const south = -90 + y * tileSize(level), north = south + tileSize(level);
  return south >= c.lat_min && north <= c.lat_max;
};

/** level -> Set of planned rows; and "level/blockRow" -> number of caps that plan a row in that block row. */
function rowsOf(caps) {
  const rows = new Map(), writers = new Map();
  for (let level = 0; level <= ROOT_MAX_LEVEL; level++) rows.set(level, new Set(Array.from({ length: 2 ** level }, (_, y) => y)));
  for (const c of caps) {
    for (let level = Math.max(c.min_level, ROOT_MAX_LEVEL + 1); level <= c.max_level; level++) {
      const set = rows.get(level) ?? new Set();
      const blocks = new Set();
      for (let y = 0; y < 2 ** level; y++) if (inside(c, level, y)) { set.add(y); blocks.add(y >> 2); }
      rows.set(level, set);
      for (const by of blocks) writers.set(`${level}/${by}`, (writers.get(`${level}/${by}`) ?? 0) + 1);
    }
  }
  return { rows, writers };
}

/** Planned rows at level >= 3 whose parent row is not planned, as "L y" strings. */
function orphans(rows) {
  const out = [];
  for (const [level, set] of rows) {
    if (level <= ROOT_MAX_LEVEL) continue;
    const parent = rows.get(level - 1) ?? new Set();
    for (const y of set) if (!parent.has(y >> 1)) out.push(`${level} ${y}`);
  }
  return out;
}

/** The latitude bands (deg) the orphan rows cover, merged, per level. */
function orphanBands(list) {
  const bands = [];
  for (const entry of list.map((s) => s.split(" ").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const [level, y] = entry;
    const s = -90 + y * tileSize(level), n = s + tileSize(level);
    const last = bands.at(-1);
    if (last && last.level === level && Math.abs(last.n - s) < 1e-9) last.n = n;
    else bands.push({ level, s, n });
  }
  return bands.map((b) => `L${b.level} ${b.s}..${b.n}`);
}

const CONFIG = { tileset_id: "nasa-lola-moon", dataset_epoch: "2019-03-15T00:00:00.000Z" };
const JOB = jobIdOf("nasa-lola-gdr", CONFIG.tileset_id, CONFIG.dataset_epoch);

async function planner(caps) {
  const harness = await createHarness(null, { ...CONFIG, caps });
  return async (index) => {
    const inputs = [tickFrame("2026-10-21T00:00:00Z")];
    if (index > 0) inputs.push(...markFrames([irmRecord({ jobId: JOB, next: index, provider: "nasa-lola" })]));
    const out = outputs(await harness.invoke({ methodId: "body_plan", inputs }));
    if (!out.has("plan")) return null;
    return { plan: Buffer.from(out.get("plan")[0]), tiles: decodePlan(out.get("plan")[0]) };
  };
}

test("the shipped Moon ladder leaves three rings unplanned, so the tiles under them are orphans", () => {
  const { rows } = rowsOf(SHIPPED_CAPS);
  assert.deepEqual(orphanBands(orphans(rows)), [
    "L9 -75.234375..-73.125", "L9 73.125..75.234375",
    "L10 -80.15625..-78.75", "L10 78.75..80.15625",
    "L11 -85.078125..-84.375",
  ]);
});

test("LADDER: levels 0-10 cover the body, every tile at L >= 3 has its parent, and no block file is written by two caps", () => {
  const { rows, writers } = rowsOf(LADDER);
  assert.deepEqual(orphans(rows), []);
  for (let level = 0; level <= FULL_LEVELS; level++) assert.equal(rows.get(level).size, 2 ** level, `L${level} covers every row`);
  assert.deepEqual([...writers].filter(([, n]) => n > 1), []);
  // and the ladder adds the north twins without an orphan (moon-terrain-north-twins-20261021)
  const twins = [cap("ldem_80n_20m", 11, 11, 80.15625, 90), cap("ldem_875n_5m", 12, 12, 87.5390625, 90)];
  assert.deepEqual(orphans(rowsOf([...LADDER, ...twins]).rows), []);
});

test("the built body_plan plans LADDER's rows and nothing else, unit 0..26579", { timeout: 20 * 60 * 1000 }, async () => {
  const plan = await planner(LADDER);
  const { rows } = rowsOf(LADDER);
  assert.ok(await plan(LADDER_UNITS - 1));
  assert.equal(await plan(LADDER_UNITS), null);
  const sampled = new Set([0, LADDER_UNITS - 1]);
  for (const first of CAP_FIRST_UNIT) { sampled.add(first); sampled.add(first - 1); }
  for (let i = 1999; i < LADDER_UNITS; i += 1999) sampled.add(i);
  const levelsSeen = new Set();
  for (const index of [...sampled].sort((a, b) => a - b)) {
    const unit = await plan(index);
    assert.ok(unit, `unit ${index} is planned`);
    for (const t of unit.tiles) {
      levelsSeen.add(t.level);
      assert.ok(rows.get(t.level)?.has(t.y), `unit ${index}: tile ${t.level}/${t.x}/${t.y} lies in no planned row`);
    }
  }
  assert.deepEqual([...levelsSeen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});
