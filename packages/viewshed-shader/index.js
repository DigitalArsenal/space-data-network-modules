/**
 * @orbpro/plugin-viewshed-shader
 * OrbPro Viewshed Analysis Shader Plugin
 *
 * Shader source: shaders/viewshed.vs.glsl + shaders/viewshed.fs.glsl
 * Delivered via SDN ecies-x25519-hkdf-sha256-aes-256-gcm artifact envelope,
 * or loads raw WASM from dist/ for local development.
 *
 * The WASM exports:
 *   get_vertex_source()        — GLSL vertex shader string pointer
 *   get_fragment_source()      — GLSL fragment shader string pointer
 *   get_frustum_vertex_source() — frustum GLSL vertex string pointer
 *   get_frustum_fragment_source() — frustum GLSL fragment string pointer
 *   get_uniforms()             — JSON uniform descriptor string pointer
 *   plugin_stream_invoke()     — OrbPro stream ABI
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
 * Create a viewshed shader plugin instance.
 *
 * @param {object}    options
 * @param {Uint8Array} [options.wasmBytes]  Decrypted WASM bytes from SDN ecies delivery.
 *                                           If omitted, loads from package dist/.
 * @returns {Promise<object>} Plugin instance exposing get_vertex_source(), get_fragment_source(), etc.
 */
export async function createViewshedShaderPlugin(options = {}) {
  let wasmBytes = options.wasmBytes;

  if (!wasmBytes) {
    wasmBytes = loadPackageWasmBytes("viewshed-shader.wasm");
  }

  // Delegate to OrbPro's internal loader when installed in the OrbPro workspace
  const loader = await import("./loader.js").catch(() => null);
  if (loader?.createViewshedShaderPlugin) {
    return loader.createViewshedShaderPlugin({ ...options, wasmBytes });
  }

  throw new Error(
    "createViewshedShaderPlugin requires the OrbPro engine. Install via the OrbPro workspace.",
  );
}
