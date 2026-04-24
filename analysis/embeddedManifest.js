import {
  decodePluginManifest,
  decodePlgManifest,
  isPlgManifestBuffer,
} from "space-data-module-sdk/manifest";

function resolveExport(module, symbolName) {
  if (!module) {
    return null;
  }
  if (typeof module[symbolName] === "function") {
    return module[symbolName];
  }
  const emscriptenName = symbolName.startsWith("_")
    ? symbolName
    : `_${symbolName}`;
  if (typeof module[emscriptenName] === "function") {
    return module[emscriptenName];
  }
  if (module.exports && typeof module.exports[symbolName] === "function") {
    return module.exports[symbolName];
  }
  return null;
}

export function readEmbeddedPluginManifest(module, options = {}) {
  const bytesSymbol = options.bytesSymbol ?? "plugin_get_manifest_flatbuffer";
  const sizeSymbol =
    options.sizeSymbol ?? "plugin_get_manifest_flatbuffer_size";

  const getBytes = resolveExport(module, bytesSymbol);
  const getSize = resolveExport(module, sizeSymbol);

  if (!getBytes || !getSize || !module.HEAPU8) {
    return null;
  }

  const pointer = Number(getBytes());
  const size = Number(getSize());
  if (!Number.isFinite(pointer) || !Number.isFinite(size) || size <= 0) {
    return null;
  }

  const bytes = module.HEAPU8.slice(pointer, pointer + size);
  if (isPlgManifestBuffer(bytes)) {
    return decodePlgManifest(bytes);
  }
  return decodePluginManifest(bytes);
}

export default readEmbeddedPluginManifest;
