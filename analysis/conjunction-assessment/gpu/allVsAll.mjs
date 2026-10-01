// All-vs-all conjunction screening with the pair search on a GPU.
//
//   coarse_grid (module, WASM: SGP4 at every coarse step)
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
// Records carry their SDS type; the module's frames are typed by media type.
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
 * @param {Uint8Array} o.request  $CQR CATALOG_REQUEST (ALFANO_MAXIMUM controls).
 * @param {Uint8Array[]} o.catalog  One $OMM per object.
 * @param {{screenBlock: Function}} o.screener  From gpu/gpuScreen.mjs.
 * @param {number} o.thresholdKm @param {number} o.coarseStepSec  As in the request.
 * @param {number} [o.blockSteps=32]  Coarse steps per coarse_grid call.
 * @param {number} [o.candidatesPerRefine=150000]  Candidates per refine call (halved where its events overflow staging).
 * @param {(stage: string, done: number, total: number) => void} [o.onProgress]
 */
export async function screenAllVsAllOnGpu(o) {
  const { invoke, decodeCatalogResult, request, catalog, screener, thresholdKm, coarseStepSec } = o;
  const blockSteps = o.blockSteps ?? 32, perRefine = o.candidatesPerRefine ?? 150000;
  const progress = o.onProgress ?? (() => {});
  const catalogInputs = [sds('request', 'CQR', request), ...catalog.map((payload) => sds('catalog', 'OMM', payload))];
  const port = (outputs, id) => outputs.find((x) => x.portId === id)?.payload;
  const timings = { gridMs: 0, gpuMs: 0, refineMs: 0 };
  const excluded = new Map();
  const blocks = [];
  let lastStep = null, objects = 0, candidateCount = 0;

  // The first call grids step 0 alone and reports the window's last step.
  for (let first = 0; lastStep === null || first <= lastStep;) {
    const count = lastStep === null ? 1 : Math.min(blockSteps, lastStep - first + 1);
    let t = performance.now();
    const response = await invoke('coarse_grid', [...catalogInputs,
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
    const inputs = [...catalogInputs,
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
      events.push(...result.EVENTS);
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
    objects, lastStep, candidates: candidateCount, refineCalls, timings,
  };
}
