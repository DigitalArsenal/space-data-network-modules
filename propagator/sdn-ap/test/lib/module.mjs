// The module through the SDK's isomorphic harness (the browser host, run in
// Node), its exports called directly. JS only moves bytes: every number a
// test compares comes out of the module.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";

export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const wasmPath = process.env.SDNAP_WASM ? process.env.SDNAP_WASM : fileURLToPath(new URL("../../dist/isomorphic/module.wasm", import.meta.url));

export const THEORY = Object.freeze({ SGP4: 0, SGP4XP: 4, SDNAP: 16 });
export const FRAME = Object.freeze({ TEME: 0, ECEF: 3 });
export const ROW_BYTES = 168;

/** Builds dist/isomorphic/module.wasm unless it exists (or `force`). */
export function ensureBuilt({ force = false } = {}) {
  if (!force && fs.existsSync(wasmPath)) return;
  execFileSync(process.execPath, ["build.mjs"], { cwd: packageRoot, stdio: "inherit" });
}

/** ElementRow bytes (src/store.inc) of element objects. */
export function elementRows(sets) {
  const buffer = new ArrayBuffer(ROW_BYTES * sets.length);
  const view = new DataView(buffer);
  sets.forEach((e, i) => {
    const at = ROW_BYTES * i;
    const doubles = [e.epochWhole, e.epochFrac, e.meanMotion, e.ecc, e.inc, e.raan, e.argp, e.ma,
      e.bstar ?? 0, e.ndot ?? 0, e.nddot ?? 0, e.bterm ?? 0, e.agom ?? 0];
    doubles.forEach((value, k) => view.setFloat64(at + 8 * k, value, true));
    view.setUint32(at + 104, e.norad >>> 0, true);
    view.setInt32(at + 108, e.theory, true);
    [e.kappa ?? 0, e.tau0 ?? 0, e.tauc ?? 0, e.taus ?? 0, e.arcEnd ?? 0, e.rhoArc ?? 0].forEach((value, k) => view.setFloat64(at + 112 + 8 * k, value, true));
    view.setUint32(at + 160, e.flags ?? 0, true);
  });
  return new Uint8Array(buffer);
}

export async function openModule({ threads = 0 } = {}) {
  ensureBuilt();
  const harness = await createStandaloneHarness("browser", wasmPath, {
    surface: "direct",
    maxThreads: Math.max(1, threads),
    enableBrowserWasiThreads: threads > 0,
  });
  const x = harness.instance.exports;
  const running = threads > 0 ? x.sdnap_threads(threads) : 0;
  const mem = () => harness.memory.buffer;
  let count = 0;
  let scratch = { out: 0, status: 0, minutes: 0, n: 0 };
  const reserve = (n) => {
    if (scratch.n >= n) return;
    if (scratch.out) { x.sdnap_free(scratch.out); x.sdnap_free(scratch.status); x.sdnap_free(scratch.minutes); }
    scratch = { out: x.sdnap_alloc(48 * n), status: x.sdnap_alloc(4 * n), minutes: x.sdnap_alloc(8 * n), n };
  };
  const planes = (n) => {
    const all = new Float64Array(mem(), scratch.out, 6 * n).slice();
    const status = new Int32Array(mem(), scratch.status, n).slice();
    return { x: all.subarray(0, n), y: all.subarray(n, 2 * n), z: all.subarray(2 * n, 3 * n),
      vx: all.subarray(3 * n, 4 * n), vy: all.subarray(4 * n, 5 * n), vz: all.subarray(5 * n, 6 * n), status };
  };
  return {
    x,
    harness,
    threads: running,
    /** Replaces the element set; returns the count held. */
    init(sets) {
      const bytes = elementRows(sets);
      const p = x.sdnap_alloc(bytes.length);
      new Uint8Array(mem(), p, bytes.length).set(bytes);
      const held = x.sdnap_init_elements(p, sets.length);
      x.sdnap_free(p);
      if (held !== sets.length) throw new Error(`sdnap_init_elements held ${held} of ${sets.length}`);
      count = held;
      reserve(count);
      return held;
    },
    initError: (i) => x.sdnap_init_error(i),
    /** Every object at its own minutes from epoch (TEME km, km/s); without copying when `raw`. */
    atMinutes(minutes, { raw = false } = {}) {
      new Float64Array(mem(), scratch.minutes, count).set(minutes);
      const status = x.sdnap_propagate_minutes_soa(scratch.minutes, 0, count, scratch.out, scratch.status);
      if (status !== 0) throw new Error(`sdnap_propagate_minutes_soa returned ${status}`);
      return raw ? null : planes(count);
    },
    /** Every object at one split Julian date. */
    atJd(whole, frac, frame = FRAME.TEME, { raw = false } = {}) {
      const status = x.sdnap_propagate_soa(whole, frac, 0, count, frame, scratch.out, scratch.status);
      if (status !== 0) throw new Error(`sdnap_propagate_soa returned ${status}`);
      return raw ? null : planes(count);
    },
    /** SGP4XP mean equinoctial state and rates of row i at minutes (SPEC 1.5 units), or null. */
    xpNative(i, minutes) {
      const p = x.sdnap_alloc(96);
      const status = x.sdnap_xp_native(i, minutes, p);
      const out = status === 0 ? Array.from(new Float64Array(mem(), p, 12)) : null;
      x.sdnap_free(p);
      return out && { eqnx: out.slice(0, 6), rates: out.slice(6) };
    },
    hansen: (l, p, q, e, mode) => x.sdnap_hansen_g(l, p, q, e, mode),
    storeBytes: () => x.sdnap_store_bytes(),
    recordBytes: (theory = THEORY.SGP4XP) => x.sdnap_record_bytes(theory),
    memoryBytes: () => harness.memory.buffer.byteLength,
    destroy() { x.plugin_destroy(); count = 0; },
  };
}
