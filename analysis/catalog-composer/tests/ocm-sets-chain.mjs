// The modules tests/ocm-sets.e2e.mjs runs besides the integrator: a module of this repository by its path through the
// SDK's browser module harness, and the source-products flow with a source's recipe (flows/source-products recipe.mjs)
// in the SDK's JS flow host. JS only moves bytes.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { recipeFor } from '../../../flows/source-products/recipe.mjs';
import { runSource } from '../../../flows/source-products/tests/flow-harness.mjs';

const root = (rel) => fileURLToPath(new URL(`../../../${rel}/`, import.meta.url));
export const version = (rel) => JSON.parse(fs.readFileSync(`${root(rel)}${rel.startsWith('flows/') ? 'package.json' : 'plugin-manifest.json'}`, 'utf8')).version;
const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: 'flatbuffer' });
// inputs: [{ port, type, bytes }]
export async function moduleRun(rel, methodId, inputs, config = {}) {
  const dir = root(rel);
  const wasm = fs.readFileSync(`${dir}dist/isomorphic/module.wasm`);
  const manifest = JSON.parse(fs.readFileSync(`${dir}plugin-manifest.json`, 'utf8'));
  const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: 'direct', hostOptions: { config } });
  try {
    const r = await h.invoke({ methodId, inputs: inputs.map((i) => ({ portId: i.port, payload: i.bytes, typeRef: typeRef(i.type) })) });
    const byPort = new Map();
    for (const f of r.outputs ?? []) {
      if (!byPort.has(f.portId)) byPort.set(f.portId, []);
      byPort.get(f.portId).push(Buffer.from(f.payload));
    }
    return { statusCode: r.statusCode, errorCode: r.errorCode ?? null, errorMessage: r.errorMessage ?? null, byPort };
  } finally {
    h.destroy();
  }
}
export const SOURCE = 'space-track-gp';
export const recipe = recipeFor(SOURCE, { created: '2026-11-04T00:00:00Z' });
// One element-set source's run: its history on element_sets, its recipe as the node configuration, its models.
export const runXpFlow = (sets) => runSource([{ trigger: 'element_sets', portId: 'omm', bytes: Buffer.concat(sets) }], recipe);
