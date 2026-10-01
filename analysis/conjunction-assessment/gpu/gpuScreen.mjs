// Runs gpu/screen_kernel.wgsl over coarse_grid blocks on a WebGPU device.
// Physics stays in the kernel and in the module's f64 recheck; this file only
// moves buffers and sizes the grid. Works in a window or a worker, in any
// WebGPU host.

const WG = 256;
const SLACK_KM = 0.01;          // covers f32 rounding of positions near 7000 km (0.5 m)
const MARGIN_KM = 0.01;         // the kernel's box margin
const BIG_CAPACITY = 4096;      // big boxes per step
const ENTRIES_PER_OBJECT = 12;  // cell entries budgeted per object and step (about 7 at the 99th-percentile edge)

/** Parses a coarse_grid "grid" frame (CAG1). */
export function parseGridFrame(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (view.getUint32(0, true) !== 0x31474143) throw new Error('Not a coarse_grid CAG1 frame.');
  const firstStep = view.getUint32(4, true), stepCount = view.getUint32(8, true), objects = view.getUint32(12, true);
  const stateBytes = stepCount * objects * 32, bandBytes = objects * 8;
  if (u8.byteLength !== 16 + stateBytes + bandBytes) throw new Error('coarse_grid frame length does not match its header.');
  return { firstStep, stepCount, objects, states: u8.subarray(16, 16 + stateBytes), bands: u8.subarray(16 + stateBytes) };
}

// The cell edge: the 99th percentile box edge over a sample of the block's
// first step, as screening_tight.cpp sizes its grid. Any edge is correct; this
// one keeps most boxes within two cells per axis.
function cellEdgeKm(g, thresholdKm, halfStepSec) {
  const f = new Float32Array(g.states.buffer, g.states.byteOffset, g.objects * 8);
  const stride = Math.max(1, Math.floor(g.objects / 4096)), edges = [];
  for (let i = 0; i < g.objects; i += stride) {
    const q = i * 8, w = 0.5 * (thresholdKm + SLACK_KM) + f[q + 3] + MARGIN_KM;
    const edge = 2 * (Math.max(Math.abs(f[q + 4]), Math.abs(f[q + 5]), Math.abs(f[q + 6])) * halfStepSec + w);
    if (Number.isFinite(edge)) edges.push(edge);
  }
  edges.sort((a, b) => a - b);
  return Math.max(1, edges.length ? edges[Math.floor(0.99 * (edges.length - 1))] : 1);
}

/**
 * @param {{ device: GPUDevice, kernelSource: string, capacity?: number, stepsPerDispatch?: number }} options
 * capacity: candidate slots per dispatch (16 bytes each).
 */
export function createGpuScreener({ device, kernelSource, capacity = 1 << 22, stepsPerDispatch = 8 }) {
  const module = device.createShaderModule({ code: kernelSource });
  const pipeline = (entryPoint) => device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
  // The bindings each entry point uses (layout 'auto' keeps only those).
  const passes = [
    { pipeline: pipeline('insert'), bindings: [0, 1, 2, 3, 4, 6] },
    { pipeline: pipeline('pairs'), bindings: [0, 1, 2, 3, 5, 6] },
    { pipeline: pipeline('bigs_against_all'), bindings: [0, 3, 4, 5, 6] },
  ];
  const U = GPUBufferUsage;
  const candidates = device.createBuffer({ size: capacity * 16, usage: U.STORAGE | U.COPY_SRC });
  const params = device.createBuffer({ size: 48, usage: U.UNIFORM | U.COPY_DST });
  const readCandidates = device.createBuffer({ size: capacity * 16, usage: U.MAP_READ | U.COPY_DST });
  const buffers = { states: null, heads: null, entries: null, counters: null, bigs: null, readCounters: null };
  const sizes = {};
  const ensure = (name, size, usage) => {
    if (buffers[name] && sizes[name] >= size) return;
    buffers[name]?.destroy();
    buffers[name] = device.createBuffer({ size, usage });
    sizes[name] = size;
  };

  // One dispatch of `steps` steps from `offset`; null if its cell entries overflowed.
  async function dispatch(g, offset, steps, table, cell, thresholdKm, halfStepSec) {
    const entryCapacity = steps * g.objects * ENTRIES_PER_OBJECT;
    ensure('heads', steps * table * 4, U.STORAGE | U.COPY_DST);
    ensure('entries', entryCapacity * 16, U.STORAGE);
    ensure('counters', (2 + steps) * 4, U.STORAGE | U.COPY_SRC | U.COPY_DST);
    ensure('bigs', steps * BIG_CAPACITY * 4, U.STORAGE);
    ensure('readCounters', (2 + steps) * 4, U.MAP_READ | U.COPY_DST);
    const p = new ArrayBuffer(48), pu = new Uint32Array(p), pf = new Float32Array(p);
    pu[0] = g.objects; pu[1] = g.firstStep; pu[2] = offset; pu[3] = table;
    pu[4] = capacity; pu[5] = entryCapacity; pu[6] = BIG_CAPACITY;
    pf[8] = thresholdKm; pf[9] = halfStepSec; pf[10] = SLACK_KM; pf[11] = cell;
    device.queue.writeBuffer(params, 0, p);
    const resources = [buffers.states, buffers.heads, buffers.entries, buffers.counters, buffers.bigs, candidates, params];
    const enc = device.createCommandEncoder();
    enc.clearBuffer(buffers.heads, 0, steps * table * 4);
    enc.clearBuffer(buffers.counters, 0, (2 + steps) * 4);
    const pass = enc.beginComputePass();
    for (const { pipeline: pl, bindings } of passes) {
      pass.setPipeline(pl);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pl.getBindGroupLayout(0),
        entries: bindings.map((binding) => ({ binding, resource: { buffer: resources[binding] } })),
      }));
      pass.dispatchWorkgroups(Math.ceil(g.objects / WG), 1, steps);
    }
    pass.end();
    enc.copyBufferToBuffer(buffers.counters, 0, buffers.readCounters, 0, (2 + steps) * 4);
    device.queue.submit([enc.finish()]);
    await buffers.readCounters.mapAsync(GPUMapMode.READ, 0, (2 + steps) * 4);
    const counts = new Uint32Array(buffers.readCounters.getMappedRange(0, (2 + steps) * 4).slice(0));
    buffers.readCounters.unmap();
    if (counts[0] > entryCapacity) return null;
    for (let s = 0; s < steps; s++) {
      if (counts[2 + s] > BIG_CAPACITY) throw new Error(`GPU screen: ${counts[2 + s]} big boxes at one step; capacity is ${BIG_CAPACITY}.`);
    }
    const total = counts[1];
    if (total > capacity) throw new Error(`GPU screen proposed ${total} candidates for one dispatch; capacity is ${capacity}. Use smaller blocks.`);
    const triples = new Uint32Array(total * 3);
    if (total) {
      const e2 = device.createCommandEncoder();
      e2.copyBufferToBuffer(candidates, 0, readCandidates, 0, total * 16);
      device.queue.submit([e2.finish()]);
      await readCandidates.mapAsync(GPUMapMode.READ, 0, total * 16);
      const raw = new Uint32Array(readCandidates.getMappedRange(0, total * 16));
      for (let q = 0; q < total; q++) { triples[3 * q] = raw[4 * q]; triples[3 * q + 1] = raw[4 * q + 1]; triples[3 * q + 2] = raw[4 * q + 2]; }
      readCandidates.unmap();
    }
    return triples;
  }

  /**
   * Screens one block. Returns { triples: Uint32Array (obj1, obj2, step)...,
   * gpuMs }.
   */
  async function screenBlock(gridFrame, { thresholdKm, halfStepSec }) {
    const g = parseGridFrame(gridFrame);
    ensure('states', g.states.byteLength, U.STORAGE | U.COPY_DST);
    device.queue.writeBuffer(buffers.states, 0, g.states);
    const cell = cellEdgeKm(g, thresholdKm, halfStepSec);
    const table = 1 << Math.ceil(Math.log2(Math.max(1024, 4 * g.objects)));
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    const parts = [];
    for (let offset = 0, steps = Math.min(stepsPerDispatch, g.stepCount); offset < g.stepCount;) {
      steps = Math.min(steps, g.stepCount - offset);
      const triples = await dispatch(g, offset, steps, table, cell, thresholdKm, halfStepSec);
      if (!triples) {
        if (steps === 1) throw new Error('GPU screen: one step needs more cell entries than budgeted.');
        steps = Math.ceil(steps / 2);
        continue;
      }
      parts.push(triples);
      offset += steps;
    }
    const triples = new Uint32Array(parts.reduce((n, t) => n + t.length, 0));
    let at = 0;
    for (const t of parts) { triples.set(t, at); at += t.length; }
    return { triples, gpuMs: performance.now() - t0, objects: g.objects, firstStep: g.firstStep, stepCount: g.stepCount };
  }

  function destroy() {
    for (const b of [candidates, params, readCandidates, ...Object.values(buffers)]) b?.destroy();
  }
  return { screenBlock, destroy };
}
