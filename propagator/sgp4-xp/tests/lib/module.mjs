// The module through the SDK's browser harness (V8; the direct surface), the way tests/*.test.mjs use it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const wasmPath = path.join(root, 'dist/isomorphic/module.wasm');
export const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin-manifest.json'), 'utf8'));

export async function loadModule() {
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  return {
    harness,
    /** Invokes a method; throws on a nonzero status; returns the output frames by port. */
    async invoke(methodId, inputs) {
      const response = await harness.invoke({ methodId, inputs });
      if (response.statusCode !== 0) throw Object.assign(new Error(`${methodId}: ${response.errorCode ?? response.statusCode}: ${response.errorMessage}`), { response });
      const outputs = {};
      for (const o of response.outputs) (outputs[o.portId] ??= []).push(new Uint8Array(o.payload));
      return outputs;
    },
    /** Invokes a method that should be refused: the response, not an exception. */
    refused: (methodId, inputs) => harness.invoke({ methodId, inputs }),
    destroy: () => harness.destroy(),
  };
}
