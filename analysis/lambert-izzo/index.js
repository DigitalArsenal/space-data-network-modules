export const manifestUrl = new URL("./plugin-manifest.json", import.meta.url);
export const isomorphicWasmPath = new URL("./dist/isomorphic/module.wasm", import.meta.url);

export default {
  isomorphicWasmPath,
  manifestUrl,
};

export { encodeGridRequest, decodeGridRecord, gridTypeRef } from './grid-codec.js';
