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
import { blockFrame, control, refineCandidates, sds, sortTriples } from './allVsAll.mjs';

export const ROLE = Object.freeze({ SECONDARY: 0, PRIMARY: 1, SKIP: 2 });
const GRID = 'application/vnd.sdn.ca-coarse-grid';
const ROW_BYTES = 32;   // f32 (x, y, z, D, vx, vy, vz, 0)
const BAND_BYTES = 8;   // f32 (lo, hi)

const port = (outputs, id) => outputs.find((x) => x.portId === id)?.payload;
const header = (frame) => {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { first: view.getUint32(4, true), count: view.getUint32(8, true), objects: view.getUint32(12, true) };
};

/** The CAR1 frame of a role per object (ROLE values). */
export function rolesFrame(roles) {
  const bytes = new Uint8Array(8 + roles.length);
  bytes.set([0x43, 0x41, 0x52, 0x31]);   // "CAR1"
  new DataView(bytes.buffer).setUint32(4, roles.length, true);
  bytes.set(roles, 8);
  return bytes;
}

/**
 * The coarse grid of one window, as coarse_grid returns it in blocks: the
 * window's part of the catalog index.
 * @param {object} o
 * @param {Function} o.invoke  (methodId, inputs) => module response.
 * @param {Uint8Array} o.request  $CQR WINDOW_REQUEST on the resident index.
 * @param {number} [o.blockSteps=32]  Coarse steps per call (at most 256).
 * @returns {Promise<{blocks: Uint8Array[], excluded: Map<number, number>, objects: number, lastStep: number}>}
 *   CAG1 frames in step order, and index -> first failing JD for the objects
 *   the window cannot evaluate.
 */
export async function sampleWindowGrid(o) {
  const blockSteps = o.blockSteps ?? 32;
  const blocks = [], excluded = new Map();
  let lastStep = null, objects = 0;
  for (let first = 0; lastStep === null || first <= lastStep;) {
    const count = lastStep === null ? 1 : Math.min(blockSteps, lastStep - first + 1);
    const response = await o.invoke('coarse_grid', [sds('request', 'CQR', o.request),
      control('block', 'application/vnd.sdn.ca-grid-block', blockFrame(first, count))]);
    if (response.statusCode !== 0) throw new Error(`coarse_grid: ${response.errorCode}: ${response.errorMessage}`);
    const report = JSON.parse(new TextDecoder().decode(port(response.outputs, 'report')));
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
    const g = header(frame), p = header(part.blocks[b]);
    if (g.first !== p.first || g.count !== p.count || p.objects !== rows.length) throw new Error(`Block ${b} differs between the grids.`);
    let out = frame;
    if (objects !== g.objects) {
      // Grow: copy each step's rows and the bands; new rows are NaN.
      out = new Uint8Array(16 + g.count * objects * ROW_BYTES + objects * BAND_BYTES);
      new Float32Array(out.buffer, 16).fill(Number.NaN);
      out.set(frame.subarray(0, 16));
      new DataView(out.buffer).setUint32(12, objects, true);
      for (let s = 0; s < g.count; s++) {
        out.set(frame.subarray(16 + s * g.objects * ROW_BYTES, 16 + (s + 1) * g.objects * ROW_BYTES), 16 + s * objects * ROW_BYTES);
      }
      out.set(frame.subarray(16 + g.count * g.objects * ROW_BYTES), 16 + g.count * objects * ROW_BYTES);
    }
    const from = part.blocks[b];
    for (let s = 0; s < g.count; s++) {
      for (let k = 0; k < rows.length; k++) {
        const at = 16 + (s * p.objects + k) * ROW_BYTES;
        out.set(from.subarray(at, at + ROW_BYTES), 16 + (s * objects + rows[k]) * ROW_BYTES);
      }
    }
    for (let k = 0; k < rows.length; k++) {
      const at = 16 + g.count * p.objects * ROW_BYTES + k * BAND_BYTES;
      out.set(from.subarray(at, at + BAND_BYTES), 16 + g.count * objects * ROW_BYTES + rows[k] * BAND_BYTES);
    }
    return out;
  });
  grid.objects = objects;
  for (const row of rows) grid.excluded.delete(row);
  for (const [k, jd] of part.excluded) grid.excluded.set(rows[k], jd);
  return grid;
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
 * @param {Uint8Array} [o.roles]  A role per object (ROLE); absent: all-vs-all.
 * @param {(rows: number[]) => Promise<{request: Uint8Array, release?: () => Promise<void>}>} o.refineIndex
 *   A resident index whose sources are those grid rows, in that order, and its window's WINDOW_REQUEST.
 * @param {(payload: Uint8Array) => void} [o.onResult]  Each refine result frame, in order.
 */
export async function screenStoredWindow(o) {
  const { invoke, grid } = o;
  const scope = o.roles ? [control('roles', 'application/vnd.sdn.ca-roles', rolesFrame(o.roles))] : [];
  const timings = { searchMs: 0, refineMs: 0 };
  const parts = [];
  let candidates = 0;
  for (const frame of grid.blocks) {
    const t = performance.now();
    const response = await invoke('search_grid', [sds('request', 'CQR', o.request), control('grid', GRID, frame), ...scope]);
    if (response.statusCode !== 0) throw new Error(`search_grid: ${response.errorCode}: ${response.errorMessage}`);
    const out = port(response.outputs, 'candidates');
    const n = new DataView(out.buffer, out.byteOffset, out.byteLength).getUint32(4, true);
    parts.push(new Uint32Array(out.slice(8, 8 + n * 12).buffer));
    candidates += n;
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
