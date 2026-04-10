/**
 * @orbpro/plugin-sensor-shaders
 * OrbPro Sensor Volume Shader Plugin
 *
 * Shader source: shaders/SensorVolumeVS.glsl + shaders/SensorVolumeFS.glsl
 * Delivered via SDN ecies-x25519-hkdf-sha256-aes-256-gcm artifact envelope,
 * or loads raw Emscripten module from dist/ for local development.
 *
 * The plugin wraps sensor volume GLSL shaders in an Emscripten module and
 * exposes them to the OrbPro engine via plugin_stream_invoke with methods:
 *   load_shader_bundle  — accepts a JSON shader bundle (name → GLSL source)
 *   get_shader_bundle   — returns the active bundle as JSON
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
 * Load the Sensor Shaders plugin.
 *
 * @param {object}    options
 * @param {Uint8Array} [options.wasmBytes]  Decrypted module bytes from SDN ecies delivery.
 *                                           If omitted, loads from package dist/.
 * @returns {Promise<object>} Plugin instance exposing the sensor shader bundle
 */
export async function loadSensorShaders(options = {}) {
  let wasmBytes = options.wasmBytes;

  if (!wasmBytes) {
    wasmBytes = loadPackageModuleBytes("sensor-shaders.mjs");
  }

  // Delegate to OrbPro's internal loader when installed in the OrbPro workspace
  const loader = await import("./loader.js").catch(() => null);
  if (loader?.loadSensorShaders) {
    return loader.loadSensorShaders({ ...options, wasmBytes });
  }

  throw new Error(
    "loadSensorShaders requires the OrbPro engine. Install via the OrbPro workspace.",
  );
}
