/**
 * @orbpro/plugin-fastest-path
 * OrbPro Fastest Path Solver Plugin
 *
 * Delivered via SDN ecies-x25519-hkdf-sha256-aes-256-gcm artifact envelope,
 * or loads raw Emscripten module from dist/ for local development.
 *
 * Implements Lambert's problem solutions and Hohmann/bi-elliptic transfer
 * optimization for spacecraft trajectory planning.
 * Exports the OrbPro plugin_stream_invoke ABI.
 */

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadPackageModuleBytes(filename) {
  const modulePath = path.join(__dirname, "dist", filename);
  return readFileSync(modulePath);
}

/**
 * Create a Fastest Path Solver instance.
 *
 * @param {object}    options
 * @param {Uint8Array} [options.wasmBytes]  Decrypted module bytes from SDN ecies delivery.
 *                                           If omitted, loads from package dist/.
 * @returns {Promise<object>} Solver instance
 */
export async function createFastestPathSolver(options = {}) {
  let wasmBytes = options.wasmBytes;

  if (!wasmBytes) {
    wasmBytes = loadPackageModuleBytes("fastest-path.mjs");
  }

  // Delegate to OrbPro's internal loader when installed in the OrbPro workspace
  const loader = await import("./loader.js").catch(() => null);
  if (loader?.createFastestPathSolver) {
    return loader.createFastestPathSolver({ ...options, wasmBytes });
  }

  throw new Error(
    "createFastestPathSolver requires the OrbPro engine. Install via the OrbPro workspace.",
  );
}
