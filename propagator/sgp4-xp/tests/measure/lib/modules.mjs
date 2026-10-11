// The two fitters and the SGP4 scorer, as modules through the SDK browser harness (V8). Nothing in this directory
// computes an orbit: it builds $OEM blocks, calls modules and reads their statistics.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { loadModule } from '../../lib/module.mjs';

const modulesRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/** analysis/gp-error-model (fit_elements and element_residuals, from 0.5.0): SDN's SGP4 fitter and scorer. */
export async function loadSgp4Fitter(dir = process.env.SDN_GP_ERROR_MODEL ?? path.join(modulesRoot, 'analysis/gp-error-model')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8'));
  if (!manifest.methods.some((m) => m.methodId === 'fit_elements')) {
    throw new Error(`${dir} has no fit_elements (analysis/gp-error-model 0.5.0 or later); point SDN_GP_ERROR_MODEL at a checkout that has it.`);
  }
  const wasm = fs.readFileSync(path.join(dir, 'dist/isomorphic/module.wasm'));
  const version = manifest.version;
  return {
    version,
    async call(methodId, inputs) {
      const harness = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct' });
      try {
        const response = await harness.invoke({ methodId, inputs });
        if (response.statusCode !== 0) throw new Error(`${methodId}: ${response.errorCode}: ${response.errorMessage}`);
        const out = {};
        for (const o of response.outputs) out[o.portId] = Buffer.from(o.payload);
        return out;
      } finally {
        await harness.destroy();
      }
    },
  };
}

export const json = (portId, value) => ({ portId, payload: Buffer.from(JSON.stringify(value)), typeRef: { schemaName: 'application/json' } });
export { loadModule };
