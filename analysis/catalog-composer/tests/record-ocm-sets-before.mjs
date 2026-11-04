// Records tests/fixtures/ocm-sets.before.json from the committed dists before the $OCM set change (catalog-composer
// 0.5.1, epoch-state 0.4.0, the source-products flow 0.2.0) on the inputs of tests/ocm-sets-inputs.mjs: what each gives
// today, by SHA-256 of every output port, so tests/ocm-sets.e2e.mjs can hold what must not move. JS only moves bytes.
//   node analysis/catalog-composer/tests/record-ocm-sets-before.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apOcms, integrateSets, sgp4Omm, xpOmmAsWritten } from './ocm-sets-inputs.mjs';
import { sha256 } from './integrator-fixtures.mjs';
import { moduleRun, runXpFlow, version } from './ocm-sets-chain.mjs';

const json = (value) => JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2);
const ports = (byPort) => Object.fromEntries([...byPort].map(([p, frames]) => [p, sha256(Buffer.concat(frames))]));
const integrator = await integrateSets([0.3, 0.6]);
const epochSgp4 = await moduleRun('analysis/epoch-state', 'derive_omm', [{ port: 'omm', type: 'OMM', bytes: sgp4Omm }]);
const epochAp = await moduleRun('analysis/epoch-state', 'derive_omm', [{ port: 'omm', type: 'OMM', bytes: apOcms[0] }]);
const flow = await runXpFlow([sgp4Omm]);
const flowXp = await runXpFlow([sgp4Omm, xpOmmAsWritten]);
const before = {
  recorded: 'modules c2f476f6 dists, before the $OCM set change',
  versions: { 'catalog-composer': version('analysis/catalog-composer'), 'epoch-state': version('analysis/epoch-state'), 'source-products': version('flows/source-products') },
  integrator: { statusCode: integrator.statusCode, catalog: sha256(integrator.catalog), omm: sha256(integrator.omm), ocm: sha256(integrator.ocm),
    ocmRecords: integrator.report.OCM_RECORDS, products: integrator.report.OBJECTS[0].PRODUCTS.map((p) => p.PRODUCT) },
  epochState: { sgp4: { statusCode: epochSgp4.statusCode, ports: ports(epochSgp4.byPort) }, apOcmOnOmmPort: { statusCode: epochAp.statusCode, errorCode: epochAp.errorCode } },
  sourceProducts: { sgp4: ports(flow.egress), xp: ports(flowXp.egress) },
};
const out = fileURLToPath(new URL('fixtures/ocm-sets.before.json', import.meta.url));
fs.writeFileSync(out, `${json(before)}\n`);
console.log(json(before));
process.exit(0);
