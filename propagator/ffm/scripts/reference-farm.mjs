// Evidence-only T3 configuration. This does not add a product profile or flag.
// Keep the tested farm/worker code identical except its catalog config import.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { modulesRoot, runCatalog, sha256 } from './benchmark-catalog.mjs';

export const REFERENCE_INTEGRATOR = Object.freeze({ tolerance: 1e-14, initialStep: 2, minStep: 1e-4, maxStep: 2, maxSteps: 100000000 });
export async function runReferenceCatalog(options) {
  const truth = JSON.parse(fs.readFileSync(path.join(modulesRoot, 'propagator/ffm/tests/fixtures/truth/truth.json')));
  assert.equal(truth.settings.integrator, 'RKF78');
  assert.equal(truth.settings.relativeTolerance, REFERENCE_INTEGRATOR.tolerance);
  assert.equal(truth.settings.maximumStepSeconds, REFERENCE_INTEGRATOR.maxStep);
  const source = path.join(modulesRoot, 'analysis/conjunction-assessment/scripts/lib');
  const farmPath = options.farmModule ? path.resolve(options.farmModule) : path.join(source, 'ffmFarm.mjs');
  const workerPath = path.join(path.dirname(farmPath), 'ffmFarmWorker.mjs');
  const original = fs.readFileSync(farmPath, 'utf8'), needle = "catalogPath: path.join(ffm, 'catalog.mjs')";
  assert.equal(original.split(needle).length, 2, 'Review the evidence adapter after farm configuration changes.');
  const referenceRoot = path.join(modulesRoot, 'propagator/ffm/tests/reference');
  const rootNeedle = "const ffm = path.join(o.modulesRoot, 'propagator', implementation);";
  assert.equal(original.split(rootNeedle).length, 2);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffm-ca-reference-'));
  try {
    fs.symlinkSync(path.join(modulesRoot, 'analysis/conjunction-assessment/node_modules'), path.join(temp, 'node_modules'), 'dir');
    const catalogUrl = pathToFileURL(path.join(referenceRoot, 'catalog.mjs')).href;
    fs.writeFileSync(path.join(temp, 'reference-catalog.mjs'), `export * from ${JSON.stringify(catalogUrl)};
import { fullForceRequest as standardRequest } from ${JSON.stringify(catalogUrl)};
export function fullForceRequest(options) { return standardRequest({ ...options, integrator: ${JSON.stringify(REFERENCE_INTEGRATOR)} }); }
`);
    fs.writeFileSync(path.join(temp, 'ffmFarm.mjs'), original.replace(rootNeedle, `const ffm = ${JSON.stringify(referenceRoot)};`).replace(needle, `catalogPath: ${JSON.stringify(path.join(temp, 'reference-catalog.mjs'))}`));
    fs.copyFileSync(workerPath, path.join(temp, 'ffmFarmWorker.mjs'));
    const result = await runCatalog({ ...options, artifactRoot: referenceRoot, implementation: 'ffm', phase: 'phase-1-reference-T3', farmModule: path.join(temp, 'ffmFarm.mjs') });
    result.reference = { integrator: REFERENCE_INTEGRATOR, method: 'RKF78 (resident RK78 alias)',
      farmSourceSha256: sha256(fs.readFileSync(farmPath)), workerSourceSha256: sha256(fs.readFileSync(workerPath)),
      catalogSourceSha256: sha256(fs.readFileSync(path.join(referenceRoot, 'catalog.mjs'))),
      adapterSourceSha256: sha256(fs.readFileSync(path.join(temp, 'reference-catalog.mjs'))),
      scope: 'T3 integrator settings on standard WASM, same resident farm exports and CA screen; native truth output/stop scheduling is not substituted.' };
    return result;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
