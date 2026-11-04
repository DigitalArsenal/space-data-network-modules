// The pvn-labels E2E input and the module outputs before the labels moved to typed fields (pvn-labels.before.json,
// recorded from the dist of modules ea824356 with `node tests/fixtures/pvn-labels.mjs --record`).
// Input (synthetic, aoe-format.mjs): object 99001 in two sets (records 5001, 5004), 100123 (Alpha-5), an object with no
// NORAD number (catId 777001, no satId), an object whose satId differs from its catId (catId 880001, satId 42), and a
// repeated record id.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { synthetic } from '../../../spacetrack-source/tests/fixtures/spacetrack-format.mjs';
import { aoeRecord } from './aoe-format.mjs';

const here = (p) => new URL(p, import.meta.url).pathname;
export const BEFORE = here('./pvn-labels.before.json');
export const URL_AOE = 'https://www.spacemapper.cn/aoe/records';
const base = (over = {}) => synthetic({ epoch: '2026-10-10T10:00:00.000000', recordId: 5001, ...over });
export const RECORDS = [
  aoeRecord(base()),
  aoeRecord(base({ name: 'SYNTH 2', objectId: '2026-902A', norad: 100123, cell: 'A0123', recordId: 5002, epoch: '2026-10-10T11:30:00.000000' })),
  aoeRecord(base({ name: 'SYNTH 3', objectId: '2026-903A', norad: 55555, recordId: 5003, catId: 777001, satId: null }), { noradId: null, objectType: 'DEBRIS' }),
  aoeRecord(base({ recordId: 5004, epoch: '2026-10-10T12:00:00.000000' })),
  aoeRecord(base({ name: 'SYNTH 5', objectId: '2026-905A', norad: 99005, recordId: 5005, catId: 880001, satId: 42 }), { objectType: 'ROCKET BODY' }),
  aoeRecord(base()),
];
const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };
export const body = () => new TextEncoder().encode(RECORDS.map((r) => JSON.stringify(r)).join('\n'));

export async function drive(wasmPath, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  try {
    const payload = encodeHttpResponse({ url: URL_AOE, status: 200, body: body(), retrievedMs: 1760000000000 });
    const r = await host.invoke({ methodId: 'parse_aoe', inputs: [{ portId: 'response', typeRef: HRSP, payload }] });
    if (r.statusCode !== 0) throw new Error(`parse_aoe: ${r.errorMessage}`);
    return Object.fromEntries(r.outputs.map((f) => [f.portId, new Uint8Array(f.payload)]));
  } finally {
    host.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === '--record') {
  const out = await drive(here('../../dist/isomorphic/module.wasm'), here('../../dist/plugin-manifest.json'));
  fs.writeFileSync(BEFORE, `${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Buffer.from(v).toString('base64')])), null, 1)}\n`);
  console.log(`recorded ${Object.keys(out).join(', ')} -> ${BEFORE}`);
}
