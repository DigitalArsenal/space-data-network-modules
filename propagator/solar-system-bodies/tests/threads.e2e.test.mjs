/**
 * The pthreads build (owner 2026-10-13): binary kernels read on the loader
 * thread with their bytes adopted give the states of a synchronous load, bit
 * for bit, and the per-frame scene surface places each body exactly where
 * ssb_states and ssb_orientations put it.
 *
 *   SSB_KERNELS_DIR=<dataset>/kernels node --test tests/threads.e2e.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "dist", "isomorphic", "module.wasm");
const kernelsDir = process.env.SSB_KERNELS_DIR;
const TEXT = ["pck00011.tpc", "gm_de440.tpc", "moon_de440_250416.tf"];
const DAF = ["core-2020.bsp", "moon-pa-2020.bpc", "jupiter-2020.bsp"];
const IDS = [10, 399, 301, 499, 599, 501, 699];

const harnesses = [];
// The loader thread waits for work for good: its worker ends with the harness.
test.after(async () => {
  for (const h of harnesses) await h.destroy();
});

async function open() {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), surface: "direct", maxThreads: 1, wasiThreadPoolSize: 1 });
  harnesses.push(harness);
  const x = harness.instance.exports;
  const mem = () => harness.memory.buffer;
  const put = (bytes) => {
    const p = x.plugin_alloc(bytes.length);
    new Uint8Array(mem(), p, bytes.length).set(bytes);
    return p;
  };
  return { x, mem, put };
}

async function load(m, threaded) {
  for (const name of TEXT) {
    const bytes = fs.readFileSync(path.join(kernelsDir, name));
    const p = m.put(bytes);
    assert.ok(m.x.ssb_load_kernel(p, bytes.length) >= 0);
    m.x.plugin_free(p, bytes.length);
  }
  for (const name of DAF) {
    const bytes = fs.readFileSync(path.join(kernelsDir, name));
    const p = m.put(bytes);
    if (!threaded) {
      assert.ok(m.x.ssb_load_kernel(p, bytes.length) >= 0);
      m.x.plugin_free(p, bytes.length);
      continue;
    }
    const seq = m.x.ssb_kernel_job_begin(p, bytes.length);
    assert.ok(seq > 0);
    const control = new Int32Array(m.mem(), m.x.ssb_kernel_job_control(), 4);
    while (Atomics.load(control, 1) - seq < 0) await new Promise((r) => setTimeout(r, 1));
    assert.ok(m.x.ssb_kernel_job_commit() > 0, `${name} committed`);
    assert.equal(control[3], 1, "the loader thread ran");
  }
}

function states(m, et) {
  const ids = m.put(new Uint8Array(Int32Array.from(IDS).buffer));
  const out = m.x.plugin_alloc(48 * IDS.length);
  const status = m.x.plugin_alloc(4 * IDS.length);
  m.x.ssb_states(et, ids, IDS.length, 0, out, status);
  return Array.from(new Float64Array(m.mem(), out, 6 * IDS.length));
}

test("kernels read on the loader thread give the states of a synchronous load", { skip: !kernelsDir && "SSB_KERNELS_DIR not set" }, async () => {
  const sync = await open();
  await load(sync, false);
  const threaded = await open();
  await load(threaded, true);
  const et = 844107069.18;
  assert.deepEqual(states(threaded, et), states(sync, et));
});

test("the scene surface places every body as ssb_states rotated into the central frame", { skip: !kernelsDir && "SSB_KERNELS_DIR not set" }, async () => {
  const m = await open();
  await load(m, true);
  const x = m.x;
  const table = new Uint32Array(m.mem(), x.ssb_scene_resize(IDS.length, 0), 33);
  const v = (Type, slot, n) => new Type(m.mem(), table[slot], n);
  const params = v(Float64Array, 2, 128);
  const out = v(Float64Array, 3, 256);
  v(Int32Array, 4, IDS.length).set(IDS);
  v(Int32Array, 5, IDS.length).fill(2); // shown
  // central: the Moon (index 2); the TAI date of et 844107069.18
  params[2] = 2;
  params[0] = 2461314.5;
  params[1] = 21600.0 + 37.0;
  params.set([3.0e7, 1.0e7, 5.0e6], 11);
  assert.equal(x.ssb_scene_frame(), 1);
  const et = out[4];
  // the Moon's rotation from ssb_orientations, applied to ssb_states
  const one = m.put(new Uint8Array(Int32Array.of(301).buffer));
  const rot = x.plugin_alloc(80);
  const st = x.plugin_alloc(4);
  x.ssb_orientations(et, one, 1, rot, st);
  const r = Array.from(new Float64Array(m.mem(), rot, 9));
  const ids = m.put(new Uint8Array(Int32Array.from(IDS).buffer));
  const s = x.plugin_alloc(48 * IDS.length);
  const status = x.plugin_alloc(4 * IDS.length);
  x.ssb_states(et, ids, IDS.length, 301, s, status);
  const geo = new Float64Array(m.mem(), s, 6 * IDS.length);
  const fixed = v(Float64Array, 17, 3 * IDS.length);
  for (let i = 0; i < IDS.length; ++i) {
    for (let k = 0; k < 3; ++k) {
      const expected = r[3 * k] * geo[6 * i] + r[3 * k + 1] * geo[6 * i + 1] + r[3 * k + 2] * geo[6 * i + 2];
      assert.equal(fixed[3 * i + k], expected, `body ${IDS[i]} axis ${k}`);
    }
  }
});
