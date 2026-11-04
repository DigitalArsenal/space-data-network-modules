// The pvn-labels E2E input and the module outputs before the labels moved to typed fields (pvn-labels.before.json,
// recorded from the dist of modules ea824356 with `node tests/fixtures/pvn-labels.mjs --record`).
// Input (synthetic, spacetrack-format.mjs): an SGP4 set, an EPHEMERIS_TYPE 4 (SGP4-XP) set whose BSTAR column holds
// BTERM and MEAN_MOTION_DDOT column AGOM (m**2/kg), and the first set again under its GP_ID (a duplicate).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';
import { gpRecord, synthetic } from './spacetrack-format.mjs';

const here = (p) => new URL(p, import.meta.url).pathname;
export const BEFORE = here('./pvn-labels.before.json');
export const TYPE4 = { EPHEMERIS_TYPE: '4', BSTAR: '0.01230000000000', MEAN_MOTION_DOT: '0.00000000', MEAN_MOTION_DDOT: '0.0042000000000' };
export const SETS = [
  gpRecord(synthetic()),
  gpRecord(synthetic({ name: 'SYNTH XP', objectId: '2026-904A', norad: 99004, gpId: 900000004 }), TYPE4),
  gpRecord(synthetic()),
];
const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };

export async function drive(wasmPath, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: 'direct' });
  try {
    const payload = encodeHttpResponse({ url: 'https://www.space-track.org/basicspacedata/query/class/gp', status: 200, headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(SETS)), retrievedMs: Date.UTC(2026, 9, 10, 18) });
    const r = await host.invoke({ methodId: 'parse_gp', inputs: [{ portId: 'response', payload, typeRef: HRSP }] });
    if (r.statusCode !== 0) throw new Error(`parse_gp: ${r.errorMessage}`);
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
