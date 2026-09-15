import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

// Compatibility names and live views only. The SDK instantiates the same bytes
// used by the command runner; all access calculations execute inside WASM.
export default async function createAccessModule({ wasmBinary }) {
  const harness = await createBrowserModuleHarness({ wasmSource: wasmBinary, surface: "direct" });
  const exports = harness.instance.exports;
  const module = {};
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value === "function") module[`_${name}`] = value;
  }
  module._access_plugin_manifest_bytes = exports.plugin_get_manifest_flatbuffer;
  module._access_plugin_manifest_size = exports.plugin_get_manifest_flatbuffer_size;
  module._malloc = exports.plugin_alloc;
  module._free = (pointer) => exports.plugin_free(pointer, 0);
  for (const [name, View] of Object.entries({ HEAPU8: Uint8Array, HEAP32: Int32Array, HEAPU32: Uint32Array, HEAPF64: Float64Array })) {
    Object.defineProperty(module, name, { get: () => new View(exports.memory.buffer) });
  }
  return module;
}
