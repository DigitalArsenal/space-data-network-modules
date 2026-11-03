// Modules through the SDK browser harness (V8, direct surface), with the provenance a manifest needs.
// Nothing here computes an orbit: it loads WASM, passes frames and returns the modules' outputs.
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { sha256, root } from '../common.mjs';

// The modules checkout: SDN_MODULES_ROOT, else the sibling worktree of this task (space-data-network-modules--<task id>, the repo--task-id naming of the experiment worktree's own name). It needs a node_modules (the
// experiment's own, linked at its root) so the modules' helper scripts resolve the same SDK and SDS packages.
export function modulesRoot() {
  const candidate = process.env.SDN_MODULES_ROOT ?? path.resolve(root, '..', `space-data-network-modules--${path.basename(root).replace(/^orbit-accuracy-experiments--/, '')}`);
  if (!fs.existsSync(path.join(candidate, 'propagator/sgp4-xp/dist/isomorphic/module.wasm'))) {
    throw new Error(`not a built space-data-network-modules checkout: ${candidate} (set SDN_MODULES_ROOT)`);
  }
  return candidate;
}

/**
 * One module by its path in the modules checkout. `call(methodId, inputs)` returns { portId: Buffer } (the last frame of a
 * port wins); `fresh` makes a new harness per call and destroys it (the SGP4 fitter's own measurement does).
 */
export async function openModule(modules, relative, { fresh = false, hostOptions } = {}) {
  const dir = path.join(modules, relative);
  const wasm = fs.readFileSync(path.join(dir, 'dist/isomorphic/module.wasm'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8'));
  const provenance = { path: relative, pluginId: manifest.pluginId, version: manifest.version, wasmSha256: sha256(wasm), manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))) };
  const make = () => createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct', hostOptions });
  let harness = fresh ? null : await make();
  return {
    provenance,
    async response(methodId, inputs) {
      const h = harness ?? (await make());
      try { return await h.invoke({ methodId, inputs }); } finally { if (fresh) await h.destroy(); }
    },
    async call(methodId, inputs) {
      const response = await this.response(methodId, inputs);
      if (response.statusCode !== 0) throw Object.assign(new Error(`${relative} ${methodId}: ${response.errorCode ?? response.statusCode}: ${response.errorMessage}`), { response });
      const out = {};
      for (const o of response.outputs) out[o.portId] = Buffer.from(o.payload);
      return out;
    },
    destroy: async () => { if (harness) await harness.destroy(); harness = null; },
  };
}
