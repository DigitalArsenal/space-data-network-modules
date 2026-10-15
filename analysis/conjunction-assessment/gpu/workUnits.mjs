// Work units of a distributed screen. A screen is cut into
//   grid units:   one block of catalog rows x one window -> those rows' coarse grid
//   screen units: one block of primaries x one window   -> the events of its pairs
// A unit record names every input by its SHA-256 (the module, the sources, the
// window's grid blocks, the roles) plus the controls, and the unit's id is the
// SHA-256 of that record. Any machine holding those bytes reproduces the
// output byte for byte (the module's outputs do not depend on runtime or
// thread count), so replicating a unit on two machines and comparing output
// hashes verifies it. The unit's module threads are the machine's own choice:
// they are not an input. This file builds records, hashes and moves bytes;
// all geometry is in the module.
import { decodeCatalogResult, indexInputs, releaseIndex, screenWindows, sgp4Sources, splitCatalog, windowRequest } from './catalogScreen.mjs';
import { sampleWindowGrid, screenStoredWindow, spliceGridRows } from './continuousScreen.mjs';
import { excludedFrame, exclusionsOf, gridFrame, gridOf, rolesOf } from './scrFrames.mjs';
import * as flatbuffers from 'flatbuffers';
import { CQR, PRWInstanceT } from 'spacedatastandards.org/lib/js/CQR/main.js';

const UNIT_INSTANCE = () => new PRWInstanceT('conjunction-assessment', 'work-unit', 1n);

export async function sha256(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** JSON with keys sorted at every level: the canonical form of a unit record. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const unitId = (record) => sha256(new TextEncoder().encode(canonicalJson(record)));

/** Frames as one blob: each prefixed by its u32 big-endian length (the catalog file's layout). */
export function packFrames(frames) {
  const out = new Uint8Array(frames.reduce((s, f) => s + 4 + f.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of frames) { view.setUint32(at, f.length, false); out.set(f, at + 4); at += 4 + f.length; }
  return out;
}
export const unpackFrames = splitCatalog;

/** A window's exclusions as bytes: a $SCR EXCLUSIONS of the rows in order with their first failing JD. */
export const exclusionsBytes = (excluded) => excludedFrame(new Map([...excluded].sort((a, b) => a[0] - b[0])));
export { exclusionsOf };

/**
 * Runs one unit through the module.
 * @param {object} record  The unit record.
 * @param {object} o
 * @param {Function} o.invoke  (methodId, inputs) => module response.
 * @param {(hash: string) => Promise<Uint8Array>} o.fetch  Content by SHA-256 (verified by the caller's store).
 * @param {number} o.threads  Module threads on this machine.
 * @returns {Promise<Uint8Array>}  The output: grid units, the window's $SCR GRID blocks for the rows and the
 *   exclusions; screen units, every refine_candidates result frame in order.
 */
export async function runUnit(record, o) {
  const controls = { ...record.controls, workers: o.threads };
  const [window] = screenWindows(record.window.startJd, record.window.durationDays, record.window.durationDays * 24);
  const catalog = unpackFrames(await o.fetch(record.sources));
  const sources = sgp4Sources(catalog);
  const instance = UNIT_INSTANCE();
  const prepare = async (subset) => {
    const response = await o.invoke('prepare_screening_index', indexInputs(subset, [], instance));
    if (response.statusCode !== 0) throw new Error(`prepare_screening_index: ${response.errorCode}: ${response.errorMessage}`);
    return CQR.getRootAsCQR(new flatbuffers.ByteBuffer(response.outputs[0].payload)).unpack().INDEX_RESULT.SCREENING_INDEX_HANDLE;
  };
  if (record.kind === 'ca.grid/1') {
    const [first, count] = record.rows;
    const handle = await prepare(sources.slice(first, first + count));
    try {
      const grid = await sampleWindowGrid({ invoke: o.invoke, request: windowRequest(handle, 'TEME', window, controls, instance), blockSteps: record.blockSteps });
      return packFrames([...grid.blocks, exclusionsBytes(grid.excluded)]);
    } finally { await releaseIndex(o.invoke, handle, instance); }
  }
  if (record.kind === 'ca.screen/1') {
    const blocks = await Promise.all(record.grid.map((h) => o.fetch(h)));
    const objects = gridOf(blocks[0]).objects;
    const grid = { blocks, objects, excluded: exclusionsOf(await o.fetch(record.excluded)) };
    const rolesBytes = await o.fetch(record.roles);
    const results = [];
    await screenStoredWindow({ invoke: o.invoke, decodeCatalogResult, grid, roles: rolesOf(rolesBytes),
      request: windowRequest(0, 'TEME', window, controls, instance), onResult: (payload) => results.push(payload.slice()),
      refineIndex: async (rows) => {
        const handle = await prepare(rows.map((r) => sources[r]));
        return { request: windowRequest(handle, 'TEME', window, controls, instance), release: () => releaseIndex(o.invoke, handle, instance) };
      } });
    return packFrames(results);
  }
  throw new Error(`Unknown unit kind ${record.kind}`);
}

/** The events of a screen unit's output. */
export const unitEvents = (output) => unpackFrames(output).flatMap((frame) => decodeCatalogResult(frame).EVENTS ?? []);

/** A grid unit's output: { blocks, excluded (row in the unit -> JD) }. */
export function gridOutput(output) {
  const frames = unpackFrames(output);
  return { blocks: frames.slice(0, -1), excluded: exclusionsOf(frames.at(-1)), objects: gridOf(frames[0]).objects };
}

/**
 * A window's grid from the outputs of its grid units, each with the catalog
 * rows it sampled, in row order: { blocks ($SCR GRID), excluded (row -> JD), objects }.
 */
export function assembleWindowGrid(parts) {
  let grid = null;
  for (const { output, rows } of parts) {
    const part = gridOutput(output);
    grid ??= { blocks: part.blocks.map((b) => {
      const g = gridOf(b);
      return gridFrame({ firstStep: g.firstStep, stepCount: g.stepCount, objects: 0, stepS: g.stepS, states: new Float32Array(0), bands: new Float32Array(0) });
    }), excluded: new Map(), objects: 0 };
    spliceGridRows(grid, part, rows);
  }
  return grid;
}
