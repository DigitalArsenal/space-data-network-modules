import fs from "node:fs";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { encodePluginInvokeRequest, decodePluginInvokeResponse } from "space-data-module-sdk/invoke";
import { vectors, requestFor } from "./orekit-fixture.mjs";
import createCurrent from "../dist/access.mjs";

const [beforeWasmPath, beforeLoaderPath] = process.argv.slice(2);
if (!beforeWasmPath || !beforeLoaderPath) throw new Error("Usage: node tests/compare-artifacts.mjs BEFORE_WASM BEFORE_LOADER");
const beforeBytes = fs.readFileSync(beforeWasmPath);
const afterBytes = fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url));
const createBefore = (await import(pathToFileURL(beforeLoaderPath).href)).default;
const before = await createBefore({ wasmBinary: beforeBytes, noInitialRun: true });
const after = await createCurrent({ wasmBinary: afterBytes });
function invoke(module, request) {
  const bytes = encodePluginInvokeRequest(request);
  const input = module._plugin_alloc(bytes.length);
  const sizePointer = module._plugin_alloc(4);
  module.HEAPU8.set(bytes, input);
  const output = module._plugin_invoke_stream(input, bytes.length, sizePointer);
  const size = new DataView(module.HEAPU8.buffer).getUint32(sizePointer, true);
  const response = decodePluginInvokeResponse(module.HEAPU8.slice(output, output + size));
  module._plugin_free(input, bytes.length); module._plugin_free(sizePointer, 4); module._plugin_free(output, size);
  return response;
}
for (const vector of vectors) {
  const request = requestFor(vector);
  const oldResponse = invoke(before, request), newResponse = invoke(after, request);
  assert.equal(oldResponse.statusCode, 0); assert.equal(newResponse.statusCode, 0);
  assert.deepEqual(newResponse.outputs[0].payload, oldResponse.outputs[0].payload);
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
console.log(`PASS: ${vectors.length} identical ACW payloads on identical inputs; before=${hash(beforeBytes)} after=${hash(afterBytes)}`);
