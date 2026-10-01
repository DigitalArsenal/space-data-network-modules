// All-vs-all conjunction screening with the pair search on a GPU, for
// trajectories from any propagator.
//
//   prepare_screening_index (caller: OMM for SGP4, PPE from HPOP or any
//     propagator, loaded once)
//   coarse_grid (module, WASM: every source sampled at every coarse step)
//     -> GPU screen (gpu/screen_kernel.wgsl: candidate pair-steps)
//     -> refine_candidates (module, WASM: f64 re-test, encounters, TCA, Pc)
//
// The result is screen_catalog's result for the same request: the GPU only
// proposes candidates, and every reported number comes from the module.
// This file moves frames between the module and the GPU; it has no physics.

const tagged = (tag, byteLength) => {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < 4; i++) bytes[i] = tag.charCodeAt(i);
  return { bytes, view: new DataView(bytes.buffer) };
};

function blockFrame(firstStep, stepCount) {
  const { bytes, view } = tagged('CAB1', 12);
  view.setUint32(4, firstStep, true);
  view.setUint32(8, stepCount, true);
  return bytes;
}

function excludedFrame(excluded) {
  const { bytes, view } = tagged('CAX1', 8 + excluded.size * 12);
  view.setUint32(4, excluded.size, true);
  let at = 8;
  for (const [index, jd] of excluded) {
    view.setUint32(at, index, true);
    view.setFloat64(at + 4, jd, true);
    at += 12;
  }
  return bytes;
}

function candidatesFrame(triples, from, to) {
  const count = (to - from) / 3;
  const { bytes, view } = tagged('CAC1', 8 + count * 12);
  view.setUint32(4, count, true);
  new Uint32Array(bytes.buffer, 8, count * 3).set(triples.subarray(from, to));
  return bytes;
}

// Orders candidate triples by pair, then step, so a pair's steps stay in one
// refine call and make whole encounters.
// The request carries its SDS type; the control frames their media type.
const sds = (portId, code, payload) => ({ portId, payload,
  typeRef: { schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' } });
const control = (portId, mediaType, payload) => ({ portId, payload, typeRef: { wireFormat: 'flatbuffer', mediaType } });

function sortTriples(triples, objects) {
  const n = triples.length / 3;
  const keys = new Float64Array(n);
  for (let q = 0; q < n; q++) keys[q] = (triples[3 * q] * objects + triples[3 * q + 1]) * 1e5 + triples[3 * q + 2];
  const order = Array.from({ length: n }, (_, q) => q).sort((a, b) => keys[a] - keys[b]);
  const sorted = new Uint32Array(triples.length);
  order.forEach((q, r) => sorted.set(triples.subarray(3 * q, 3 * q + 3), 3 * r));
  return sorted;
}

/**
 * @param {object} o
 * @param {(methodId: string, inputs: object[]) => Promise<{statusCode: number, errorCode?: string, errorMessage?: string, outputs: {portId: string, payload: Uint8Array}[]}>} o.invoke
 *   Calls the conjunction-assessment module (an SDK harness's invoke response).
 * @param {(bytes: Uint8Array) => {EVENTS: object[], FINAL_CHUNK: boolean, STATISTICS: object}} o.decodeCatalogResult
 * @param {Uint8Array} o.request  $CQR WINDOW_REQUEST on a resident index with no
 *   primaries (ALFANO_MAXIMUM controls).
 * @param {{screenBlock: Function}} o.screener  From gpu/gpuScreen.mjs.
 * @param {number} o.thresholdKm @param {number} o.coarseStepSec  As in the request.
 * @param {number} [o.blockSteps=32]  Coarse steps per coarse_grid call.
 * @param {number} [o.candidatesPerRefine=150000]  Candidates per refine call (halved where its events overflow staging).
 * @param {(stage: string, done: number, total: number) => void} [o.onProgress]
 */
export async function screenAllVsAllOnGpu(o) {
  const { invoke, decodeCatalogResult, request, screener, thresholdKm, coarseStepSec } = o;
  const blockSteps = o.blockSteps ?? 32, perRefine = o.candidatesPerRefine ?? 150000;
  const progress = o.onProgress ?? (() => {});
  const requestInput = [sds('request', 'CQR', request)];
  const port = (outputs, id) => outputs.find((x) => x.portId === id)?.payload;
  const timings = { gridMs: 0, gpuMs: 0, refineMs: 0 };
  const excluded = new Map();
  const blocks = [];
  let lastStep = null, objects = 0, candidateCount = 0;

  // The first call grids step 0 alone and reports the window's last step.
  for (let first = 0; lastStep === null || first <= lastStep;) {
    const count = lastStep === null ? 1 : Math.min(blockSteps, lastStep - first + 1);
    let t = performance.now();
    const response = await invoke('coarse_grid', [...requestInput,
      control('block', 'application/vnd.sdn.ca-grid-block', blockFrame(first, count))]);
    if (response.statusCode !== 0) throw new Error(`coarse_grid: ${response.errorCode}: ${response.errorMessage}`);
    const out = response.outputs;
    timings.gridMs += performance.now() - t;
    const report = JSON.parse(new TextDecoder().decode(port(out, 'report')));
    lastStep = report.last_step;
    objects = report.objects;
    for (const x of report.excluded) {
      if (!excluded.has(x.index) || x.first_failure_jd < excluded.get(x.index)) excluded.set(x.index, x.first_failure_jd);
    }
    t = performance.now();
    const screened = await screener.screenBlock(port(out, 'grid'), { thresholdKm, halfStepSec: coarseStepSec / 2 });
    timings.gpuMs += screened.gpuMs;
    blocks.push(screened.triples);
    candidateCount += screened.triples.length / 3;
    first += count;
    progress('screen', first, lastStep + 1);
  }

  const all = new Uint32Array(candidateCount * 3);
  let at = 0;
  for (const b of blocks) { all.set(b, at); at += b.length; }
  const sorted = sortTriples(all, objects);

  const events = [], excludedRecords = [];
  const totals = { KD_TREE_CANDIDATES: 0, TCA_REFINED: 0, CONJUNCTIONS_FOUND: 0, PROPAGATIONS: 0, FAILED_PAIRS: 0 };
  let statistics = null;
  const excludedBytes = excludedFrame(excluded);
  // Refine calls hold whole pairs. A call whose conjunctions exceed the
  // module's output staging is split in two and retried.
  const samePair = (a, b) => sorted[a] === sorted[b] && sorted[a + 1] === sorted[b + 1];
  const pairEnd = (at) => { while (at < sorted.length && at > 0 && samePair(at, at - 3)) at += 3; return at; };
  const pairStart = (at) => { while (at > 0 && at < sorted.length && samePair(at, at - 3)) at -= 3; return at; };
  const queue = [];
  for (let from = 0; ;) {
    const to = pairEnd(Math.min(sorted.length, from + perRefine * 3));
    queue.push([from, to]);
    if ((from = to) >= sorted.length) break;
  }
  let refineCalls = 0, refined = 0, firstCall = true;
  while (queue.length) {
    const [from, to] = queue.shift();
    const t = performance.now();
    const inputs = [...requestInput,
      control('candidates', 'application/vnd.sdn.ca-candidates', candidatesFrame(sorted, from, to)),
      control('excluded', 'application/vnd.sdn.ca-excluded', excludedBytes)];
    let response = await invoke('refine_candidates', inputs);
    refineCalls++;
    if (response.statusCode !== 0 && response.errorCode === 'output-staging-limit') {
      let mid = pairEnd(from + Math.floor((to - from) / 6) * 3);
      if (mid >= to) mid = pairStart(to - 3);
      if (mid > from && mid < to) {
        queue.unshift([from, mid], [mid, to]);
        timings.refineMs += performance.now() - t;
        continue;
      }
    }
    for (;;) {
      if (response.statusCode !== 0) throw new Error(`refine_candidates: ${response.errorCode}: ${response.errorMessage}`);
      const result = decodeCatalogResult(port(response.outputs, 'result'));
      events.push(...(result.EVENTS ?? []));   // an empty window may omit the vector
      if (firstCall) excludedRecords.push(...response.outputs.filter((x) => x.portId === 'excluded').map((x) => x.payload));
      if (result.FINAL_CHUNK) {
        statistics = result.STATISTICS;
        for (const k of Object.keys(totals)) totals[k] += Number(statistics[k] ?? 0);
        break;
      }
      response = await invoke('refine_candidates', inputs);
    }
    firstCall = false;
    timings.refineMs += performance.now() - t;
    refined += (to - from) / 3;
    progress('refine', refined, candidateCount);
  }
  return {
    events,
    excludedRecords,
    statistics: { ...statistics, ...totals, TOTAL_OBJECTS: objects - excluded.size, PAIRS_SCREENED: objects * (objects - 1) / 2 },
    excluded: [...excluded],
    objects, lastStep, candidates: candidateCount, refineCalls, timings,
  };
}

/**
 * A long screen as consecutive time windows (one propagator's output per
 * run). Each window's sources cover it with a margin, so window k can be
 * loaded and screened alone: a trajectory propagator exports one window at a
 * time and the module holds one window's trajectories.
 *
 * Merging follows a single screen of the whole span: a conjunction belongs to
 * the window holding its TCA (one at a shared edge is kept once), and an
 * object excluded in any window has no conjunctions anywhere.
 *
 * @param {object} o  As screenAllVsAllOnGpu, without `request`, plus:
 * @param {{startJd: number, durationDays: number}[]} o.windows  Consecutive.
 * @param {(window: object, k: number) => Promise<{request: Uint8Array, sourceIds: string[], excluded?: [string, number][], release?: () => Promise<void>}>} o.prepareWindow
 *   The window's WINDOW_REQUEST, its source object ids by index, and objects
 *   the propagator could not cover there ([id, first failing JD]).
 */
export async function screenWindowsOnGpu(o) {
  const progress = o.onProgress ?? (() => {});
  const events = [], excludedIds = new Map(), windows = [];
  const timings = { prepareMs: 0, gridMs: 0, gpuMs: 0, refineMs: 0 };
  let candidates = 0;
  for (let k = 0; k < o.windows.length; k++) {
    let t = performance.now();
    const prepared = await o.prepareWindow(o.windows[k], k);
    timings.prepareMs += performance.now() - t;
    const run = await screenAllVsAllOnGpu({ ...o, request: prepared.request,
      onProgress: (stage, done, total) => progress(`window ${k + 1}/${o.windows.length} ${stage}`, done, total) });
    await prepared.release?.();
    for (const [id, jd] of [...run.excluded.map(([i, d]) => [prepared.sourceIds[i], d]), ...(prepared.excluded ?? [])]) {
      if (!excludedIds.has(id) || jd < excludedIds.get(id)) excludedIds.set(id, jd);
    }
    for (const key of ['gridMs', 'gpuMs', 'refineMs']) timings[key] += run.timings[key];
    candidates += run.candidates;
    events.push(...run.events);
    windows.push({ ...o.windows[k], conjunctions: run.events.length, candidates: run.candidates });
  }
  // A TCA within the refinement tolerance of a shared edge is in both windows.
  const toleranceDays = 2 * Math.max(0.001, o.fineTolSec ?? 0.001) / 86400;
  const key = (e) => [e.PRIMARY_ID, e.SECONDARY_ID].sort().join('\u0000');
  const kept = [];
  for (const e of [...events].sort((a, b) => a.TCA.JULIAN_DATE - b.TCA.JULIAN_DATE)) {
    if (excludedIds.has(e.PRIMARY_ID) || excludedIds.has(e.SECONDARY_ID)) continue;
    let same = false;
    for (let i = kept.length - 1; i >= 0 && e.TCA.JULIAN_DATE - kept[i].TCA.JULIAN_DATE <= toleranceDays; i--) {
      if (key(kept[i]) === key(e)) { same = true; break; }
    }
    if (!same) kept.push(e);
  }
  return { events: kept, excluded: [...excludedIds], windows, candidates, timings };
}
