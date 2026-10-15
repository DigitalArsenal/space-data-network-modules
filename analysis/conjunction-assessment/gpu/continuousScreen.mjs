// Continuous screening: the catalog's coarse grid is kept as its index, the
// rows of the objects whose orbit data changed are refreshed, and only the
// pairs that involve them are screened again (search_grid with roles, then
// refine_candidates). The same pieces cut any screen into work units, object
// blocks x time windows, whose outputs depend only on their inputs.
//
//   sampleWindowGrid   coarse_grid over a window: the window's part of the index
//   spliceGridRows     another index's rows (the updated objects) into the grid
//   screenStoredWindow search_grid per block with roles, then refine_candidates
//   unitRoles          the roles of one unit of a partitioned screen
//
// This file builds frames and moves bytes; all geometry is in the module.
import { blockFrame, refineCandidates, sds, sortTriples } from './allVsAll.mjs';
import { candidateTriples, gridFrame, gridOf, rolesFrame, searchReport } from './scrFrames.mjs';

export { rolesFrame };

export const ROLE = Object.freeze({ SECONDARY: 0, PRIMARY: 1, SKIP: 2 });
const ROW_FLOATS = 8;    // f32 (x, y, z, D, vx, vy, vz, 0)
const BAND_FLOATS = 2;   // f32 (lo, hi)

const port = (outputs, id) => outputs.find((x) => x.portId === id)?.payload;
const floats = (bytes) => new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);

/**
 * The coarse grid of one window, as coarse_grid returns it in blocks: the
 * window's part of the catalog index.
 * @param {object} o
 * @param {Function} o.invoke  (methodId, inputs) => module response.
 * @param {Uint8Array} o.request  $CQR WINDOW_REQUEST on the resident index.
 * @param {number} [o.blockSteps=32]  Coarse steps per call (at most 256).
 * @returns {Promise<{blocks: Uint8Array[], excluded: Map<number, number>, objects: number, lastStep: number}>}
 *   $SCR GRID records in step order, and index -> first failing JD for the objects
 *   the window cannot evaluate.
 */
export async function sampleWindowGrid(o) {
  const blockSteps = o.blockSteps ?? 32;
  const blocks = [], excluded = new Map();
  let lastStep = null, objects = 0;
  for (let first = 0; lastStep === null || first <= lastStep;) {
    const count = lastStep === null ? 1 : Math.min(blockSteps, lastStep - first + 1);
    const response = await o.invoke('coarse_grid', [sds('request', 'CQR', o.request),
      sds('block', 'SCR', blockFrame(first, count))]);
    if (response.statusCode !== 0) throw new Error(`coarse_grid: ${response.errorCode}: ${response.errorMessage}`);
    const report = searchReport(port(response.outputs, 'report'));
    lastStep = report.last_step;
    objects = report.objects;
    for (const x of report.excluded) {
      if (!excluded.has(x.index) || x.first_failure_jd < excluded.get(x.index)) excluded.set(x.index, x.first_failure_jd);
    }
    blocks.push(port(response.outputs, 'grid').slice());
    first += count;
  }
  return { blocks, excluded, objects, lastStep };
}

/**
 * Writes another index's rows into a stored window grid, in place: the rows
 * of objects whose data changed, sampled by coarse_grid on an index of just
 * those objects over the same window and blocks. rows[k] is the grid row of
 * the other index's source k; a row at or past the grid's objects appends
 * (rows between are not evaluable until written).
 * @param {{blocks: Uint8Array[], excluded: Map<number, number>, objects: number}} grid
 * @param {{blocks: Uint8Array[], excluded: Map<number, number>, objects: number}} part
 * @param {ArrayLike<number>} rows
 */
export function spliceGridRows(grid, part, rows) {
  if (part.blocks.length !== grid.blocks.length) throw new Error('The grids cover different blocks of the window.');
  let objects = grid.objects;
  for (const r of rows) objects = Math.max(objects, r + 1);
  grid.blocks = grid.blocks.map((frame, b) => {
    const g = gridOf(frame), p = gridOf(part.blocks[b]);
    if (g.firstStep !== p.firstStep || g.stepCount !== p.stepCount || p.objects !== rows.length) throw new Error(`Block ${b} differs between the grids.`);
    // Rows of the grown grid not yet written are NaN.
    const states = new Float32Array(g.stepCount * objects * ROW_FLOATS).fill(Number.NaN);
    const bands = new Float32Array(objects * BAND_FLOATS).fill(Number.NaN);
    const gs = floats(g.states), gb = floats(g.bands), ps = floats(p.states), pb = floats(p.bands);
    for (let s = 0; s < g.stepCount; s++) {
      states.set(gs.subarray(s * g.objects * ROW_FLOATS, (s + 1) * g.objects * ROW_FLOATS), s * objects * ROW_FLOATS);
      for (let k = 0; k < rows.length; k++) {
        const at = (s * p.objects + k) * ROW_FLOATS;
        states.set(ps.subarray(at, at + ROW_FLOATS), (s * objects + rows[k]) * ROW_FLOATS);
      }
    }
    bands.set(gb);
    for (let k = 0; k < rows.length; k++) bands.set(pb.subarray(k * BAND_FLOATS, (k + 1) * BAND_FLOATS), rows[k] * BAND_FLOATS);
    return gridFrame({ firstStep: g.firstStep, stepCount: g.stepCount, objects, stepS: g.stepS, states, bands });
  });
  grid.objects = objects;
  for (const row of rows) grid.excluded.delete(row);
  for (const [k, jd] of part.excluded) grid.excluded.set(rows[k], jd);
  return grid;
}

/** A window grid of `objects` unwritten (NaN) rows over the blocks of `like`. */
export function emptyGrid(like, objects) {
  return { excluded: new Map(), objects, blocks: like.blocks.map((frame) => {
    const g = gridOf(frame);
    return gridFrame({ firstStep: g.firstStep, stepCount: g.stepCount, objects, stepS: g.stepS,
      states: new Float32Array(g.stepCount * objects * ROW_FLOATS).fill(Number.NaN), bands: new Float32Array(objects * BAND_FLOATS).fill(Number.NaN) });
  }) };
}

/**
 * Screens a stored window grid: search_grid on each block with the roles,
 * then refine_candidates on an index of only the objects the candidates name,
 * in grid order (so each pair is refined as on the whole catalog's index).
 * The events are those of the pairs the roles allow, equal to the same pairs'
 * events in a full screen of the same sources.
 * @param {object} o
 * @param {Function} o.invoke
 * @param {Function} o.decodeCatalogResult
 * @param {Uint8Array} o.request  $CQR WINDOW_REQUEST of the window (search_grid reads its controls only).
 * @param {{blocks: Uint8Array[], excluded: Map<number, number>, objects: number}} o.grid
 * @param {ArrayLike<number>} [o.roles]  A role per object (ROLE); absent: all-vs-all.
 * @param {(rows: number[]) => Promise<{request: Uint8Array, release?: () => Promise<void>}>} o.refineIndex
 *   A resident index whose sources are those grid rows, in that order, and its window's WINDOW_REQUEST.
 * @param {(payload: Uint8Array) => void} [o.onResult]  Each refine result frame, in order.
 */
export async function screenStoredWindow(o) {
  const { invoke, grid } = o;
  const scope = o.roles ? [sds('roles', 'SCR', rolesFrame(o.roles))] : [];
  const timings = { searchMs: 0, refineMs: 0 };
  const parts = [];
  let candidates = 0;
  for (const frame of grid.blocks) {
    const t = performance.now();
    const response = await invoke('search_grid', [sds('request', 'CQR', o.request), sds('grid', 'SCR', frame), ...scope]);
    if (response.statusCode !== 0) throw new Error(`search_grid: ${response.errorCode}: ${response.errorMessage}`);
    const found = candidateTriples(port(response.outputs, 'candidates'));
    parts.push(found);
    candidates += found.length / 3;
    timings.searchMs += performance.now() - t;
  }
  const all = new Uint32Array(candidates * 3);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  if (!candidates) return { events: [], rows: [], candidates, refineCalls: 0, timings };
  // The objects the candidates name, in grid order; candidates and exclusions renumbered to them.
  const position = new Int32Array(grid.objects).fill(-1), rows = [];
  for (let q = 0; q < all.length; q += 3) { position[all[q]] = 0; position[all[q + 1]] = 0; }
  for (let r = 0; r < grid.objects; r++) if (position[r] === 0) { position[r] = rows.length; rows.push(r); }
  for (let q = 0; q < all.length; q += 3) { all[q] = position[all[q]]; all[q + 1] = position[all[q + 1]]; }
  const excluded = new Map();
  for (const [row, jd] of grid.excluded) if (position[row] >= 0) excluded.set(position[row], jd);
  const index = await o.refineIndex(rows);
  try {
    const refined = await refineCandidates({ ...o, request: index.request, sorted: sortTriples(all, rows.length), excluded });
    timings.refineMs = refined.refineMs;
    return { events: refined.events, statistics: refined.statistics, rows, candidates, refineCalls: refined.refineCalls, timings };
  } finally {
    await index.release?.();
  }
}

/**
 * Roles of unit `unit` of a screen whose primaries (`scope`, object indices
 * in index order; all objects when absent) are cut into consecutive blocks:
 * the unit's block is primary, earlier blocks are skipped, everything else is
 * secondary. Every pair with a primary of the screen is in exactly one unit:
 * the unit of its lower-block primary.
 * @param {number} objects
 * @param {number[][]} blocks  The screen's primaries, cut into blocks.
 * @param {number} unit
 */
export function unitRoles(objects, blocks, unit) {
  const roles = new Uint8Array(objects);   // SECONDARY
  for (let b = 0; b < unit; b++) for (const i of blocks[b]) roles[i] = ROLE.SKIP;
  for (const i of blocks[unit]) roles[i] = ROLE.PRIMARY;
  return roles;
}

/** Consecutive blocks of the screen's primaries, each about `size` objects. */
export function cutBlocks(primaries, size) {
  const blocks = [];
  for (let i = 0; i < primaries.length; i += size) blocks.push(primaries.slice(i, i + size));
  return blocks;
}
