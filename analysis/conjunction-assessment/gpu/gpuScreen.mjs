// Runs gpu/screen_kernel.wgsl over coarse_grid blocks on a WebGPU device.
// Physics stays in the kernel and in the module's f64 recheck; this file only
// moves buffers. Works in a window or a worker, in any WebGPU host.

const WG = 256;
const SLACK_KM = 0.01;          // covers f32 rounding of positions near 7000 km (0.5 m)

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

/**
 * @param {{ device: GPUDevice, kernelSource: string, capacity?: number }} options
 * capacity: candidate slots per block (16 bytes each).
 */
export function createGpuScreener({ device, kernelSource, capacity = 1 << 22 }) {
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: kernelSource }), entryPoint: 'main' },
  });
  const U = GPUBufferUsage;
  const candidates = device.createBuffer({ size: capacity * 16, usage: U.STORAGE | U.COPY_SRC });
  const count = device.createBuffer({ size: 4, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST });
  const params = device.createBuffer({ size: 32, usage: U.UNIFORM | U.COPY_DST });
  const readCount = device.createBuffer({ size: 4, usage: U.MAP_READ | U.COPY_DST });
  const readCandidates = device.createBuffer({ size: capacity * 16, usage: U.MAP_READ | U.COPY_DST });
  let states = null, bands = null;

  /**
   * Screens one block. Returns { triples: Uint32Array (obj1, obj2, step)...,
   * gpuMs } and throws if more than `capacity` candidates were proposed.
   */
  async function screenBlock(gridFrame, { thresholdKm, halfStepSec }) {
    const g = parseGridFrame(gridFrame);
    if (!states || states.size < g.states.byteLength) {
      states?.destroy();
      states = device.createBuffer({ size: g.states.byteLength, usage: U.STORAGE | U.COPY_DST });
    }
    if (!bands || bands.size < g.bands.byteLength) {
      bands?.destroy();
      bands = device.createBuffer({ size: g.bands.byteLength, usage: U.STORAGE | U.COPY_DST });
    }
    device.queue.writeBuffer(states, 0, g.states);
    device.queue.writeBuffer(bands, 0, g.bands);
    device.queue.writeBuffer(count, 0, new Uint32Array([0]));
    const p = new ArrayBuffer(32), pu = new Uint32Array(p), pf = new Float32Array(p);
    pu[0] = g.objects; pu[1] = g.firstStep; pu[2] = capacity;
    pf[4] = thresholdKm; pf[5] = halfStepSec; pf[6] = SLACK_KM;
    device.queue.writeBuffer(params, 0, p);
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [states, bands, candidates, count, params].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    const tiles = Math.ceil(g.objects / WG);
    pass.dispatchWorkgroups(tiles, tiles, g.stepCount);
    pass.end();
    enc.copyBufferToBuffer(count, 0, readCount, 0, 4);
    device.queue.submit([enc.finish()]);
    await readCount.mapAsync(GPUMapMode.READ);
    const total = new Uint32Array(readCount.getMappedRange().slice(0))[0];
    readCount.unmap();
    const gpuMs = performance.now() - t0;
    if (total > capacity) throw new Error(`GPU screen proposed ${total} candidates for one block; capacity is ${capacity}. Use smaller blocks.`);
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
    return { triples, gpuMs, objects: g.objects, firstStep: g.firstStep, stepCount: g.stepCount };
  }

  function destroy() {
    for (const b of [states, bands, candidates, count, params, readCount, readCandidates]) b?.destroy();
  }
  return { screenBlock, destroy };
}
