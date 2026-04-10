/**
 * @orbpro/plugin-hpop
 * OrbPro High-Precision Orbital Propagator Plugin
 *
 * Delivered via SDN ecies-x25519-hkdf-sha256-aes-256-gcm artifact envelope,
 * or loads raw WASM from dist/ for local development.
 *
 * The Emscripten WASM implements a full high-precision numerical orbit propagator
 * with atmospheric drag, solar radiation pressure, and third-body perturbations.
 * Exports the OrbPro plugin_stream_invoke ABI.
 */

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadPackageWasmBytes(filename) {
  const wasmPath = path.join(__dirname, "dist", filename);
  return readFileSync(wasmPath);
}

/**
 * Create a High-Precision Orbital Propagator (HPOP) instance.
 *
 * @param {object}    options
 * @param {Uint8Array} [options.wasmBytes]  Decrypted WASM bytes from SDN ecies delivery.
 *                                           If omitted, loads from package dist/.
 * @param {boolean}   [options.lowMemory]   Use reduced memory configuration.
 * @returns {Promise<object>} Propagator instance
 */
export async function createHPOPPropagator(options = {}) {
  let wasmBytes = options.wasmBytes;

  if (!wasmBytes) {
    wasmBytes = loadPackageWasmBytes("hpop.wasm");
  }

  // Delegate to OrbPro's internal loader when installed in the OrbPro workspace
  const loader = await import("./loader.js").catch(() => null);
  if (loader?.createHPOPPropagator) {
    return loader.createHPOPPropagator({ ...options, wasmBytes });
  }

  throw new Error(
    "createHPOPPropagator requires the OrbPro engine. Install via the OrbPro workspace.",
  );
}
