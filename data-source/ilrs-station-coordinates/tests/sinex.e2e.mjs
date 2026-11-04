#!/usr/bin/env node
// E2E (task modules-ilrs-station-coordinates-source-20261104): the ILRS weekly station solution of 2026-07-18
// (tests/fixtures/ilrsa.pos+eop.260718.v90.no-matrix.snx, cut from EDC's file; PROVENANCE.md) through read_sinex in the
// SDK's browser harness:
// - one $GST per station: the count equals the stations with STAX, STAY and STAZ in the file's SOLUTION/ESTIMATE (20);
// - Graz (7839) and Yarragadee (7090): POSITION_* equal the file's printed estimates to the millimeter, the reference
//   epoch 26:196:43200, the DOMES numbers; Yarragadee's XYZ eccentricity as printed; no velocity in the file, so NaN;
// - one $PVN: SOURCE_ID ilrsa, ORIGINATOR ILRS, LICENSE_CLASS Reproducible, SOURCE_KIND Reference;
// - no USER_DEFINED anywhere: common/tests/no-user-defined.mjs decodes only $OMM and $OCM, so every record here is
//   checked for a USER_DEFINED field in its pinned schema and in its unpacked object.
// Expected values are the numbers printed in the file. JS only moves bytes and compares numbers the module produced.
//   cd data-source/ilrs-station-coordinates && node tests/sinex.e2e.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ByteBuffer } from 'flatbuffers';
import { GST } from 'spacedatastandards.org/lib/js/GST/GST.js';
import { PVN } from 'spacedatastandards.org/lib/js/PVN/PVN.js';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { decodeFlowNotice, encodeHttpResponse } from 'space-data-module-sdk/runtime-contracts';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json'), 'utf8'));
const fixture = fs.readFileSync(here('./fixtures/ilrsa.pos+eop.260718.v90.no-matrix.snx'));
const standards = path.dirname(createRequire(import.meta.url).resolve('spacedatastandards.org/package.json'));
const URL_ = 'https://edc.dgfi.tum.de/pub/slr/products/pos+eop/weekly/2026/260718/ilrsa.pos+eop.260718.v90.snx.gz';
const HRSP = { schemaName: 'HttpResponse.fbs', fileIdentifier: 'HRSP', rootTypeName: 'HttpResponse', wireFormat: 'flatbuffer' };

const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };
const mm = (actual, expected, label) => check(Math.abs(actual - expected) <= 0.0005, `${label}: ${actual} vs ${expected} (more than 1 mm)`);

// The station count the file states: distinct CODE/PT/SOLN with STAX in SOLUTION/ESTIMATE.
const text = fixture.toString('latin1');
const estimate = text.slice(text.indexOf('+SOLUTION/ESTIMATE'), text.indexOf('-SOLUTION/ESTIMATE')).split(/\r?\n/);
const fileStations = new Set(estimate.filter((l) => l.slice(7, 13).trim() === 'STAX').map((l) => l.slice(14, 26))).size;

const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(here('../dist/isomorphic/module.wasm')), manifest, surface: 'direct' });
const result = await host.invoke({ methodId: 'read_sinex', inputs: [{ portId: 'source', typeRef: HRSP,
  payload: encodeHttpResponse({ url: URL_, status: 200, error: '', headers: { 'content-type': 'text/plain' }, body: new Uint8Array(fixture), retrievedMs: Date.parse('2026-10-09T22:37:17.611Z') }) }] });
await host.destroy();
if (result.statusCode !== 0) {
  console.error(`ILRS SINEX STATIONS: FAIL (invoke ${result.statusCode}: ${result.errorMessage})`);
  process.exit(1);
}
const frames = (port) => result.outputs.filter((f) => f.portId === port).map((f) => new Uint8Array(f.payload));
const gst = frames('stations');
const stations = gst.map((b) => GST.getRootAsGST(new ByteBuffer(b)).unpack());
const pvns = frames('provenance');
const notice = decodeFlowNotice(frames('report')[0]);

check(fileStations === 20, `the file's SOLUTION/ESTIMATE names ${fileStations} stations, not 20`);
check(stations.length === fileStations, `$GST count ${stations.length} vs ${fileStations} stations in the file`);
check(Number(notice.count) === stations.length, `report COUNT ${notice.count} vs ${stations.length}`);

// The file's printed SOLUTION/ESTIMATE values (m) and SITE/ECCENTRICITY (m).
const expected = {
  7839: { domes: '11001S002', xyz: [0.419442547811476E+07, 0.116269430082710E+07, 0.464724752941674E+07], ecc: [0, 0, 0] },
  7090: { domes: '50107M001', xyz: [-0.238900806594981E+07, 0.504332975829789E+07, -0.307852326922457E+07], ecc: [-1.2073, 2.5034, -1.5509] },
};
const named = {};
for (const [code, want] of Object.entries(expected)) {
  const s = stations.filter((g) => g.STATION_ID === code);
  check(s.length === 1, `station ${code}: ${s.length} records`);
  if (s.length !== 1) continue;
  const g = (named[code] = s[0]);
  mm(g.POSITION_X, want.xyz[0], `${code} X`);
  mm(g.POSITION_Y, want.xyz[1], `${code} Y`);
  mm(g.POSITION_Z, want.xyz[2], `${code} Z`);
  check(g.DOMES_NUMBER === want.domes && g.CDP_NUMBER === code, `${code} DOMES ${g.DOMES_NUMBER} CDP ${g.CDP_NUMBER}`);
  check(g.REFERENCE_EPOCH === '2026-07-15T12:00:00', `${code} reference epoch ${g.REFERENCE_EPOCH}`);
  check(g.ECCENTRICITY_FRAME === 'XYZ' && [g.ECCENTRICITY_X, g.ECCENTRICITY_Y, g.ECCENTRICITY_Z].every((v, i) => v === want.ecc[i]), `${code} eccentricity ${g.ECCENTRICITY_FRAME} ${g.ECCENTRICITY_X} ${g.ECCENTRICITY_Y} ${g.ECCENTRICITY_Z}`);
  check([g.VELOCITY_X, g.VELOCITY_Y, g.VELOCITY_Z].every(Number.isNaN), `${code} velocity ${g.VELOCITY_X} (the file estimates none: NaN)`);
  check(g.NETWORK === 4, `${code} network ${g.NETWORK}`);
}

check(pvns.length === 1, `${pvns.length} $PVN`);
const p = PVN.getRootAsPVN(new ByteBuffer(pvns[0])).unpack();
check(p.SOURCE_ID === 'ilrsa' && p.ORIGINATOR === 'ILRS' && p.LICENSE_CLASS === 1 && p.SOURCE_KIND === 4 && p.SOURCE_URL === URL_ && p.RETRIEVED_AT === '2026-10-09T22:37:17.611Z',
  `PVN ${JSON.stringify(p, (k, v) => (typeof v === "bigint" ? String(v) : v))}`);

// No USER_DEFINED anywhere: not in the pinned schemas of what is emitted, not in any record.
for (const family of ['GST', 'PVN']) check(!/USER_DEFINED/.test(fs.readFileSync(path.join(standards, 'schema', family, 'main.fbs'), 'utf8')), `${family} schema has a USER_DEFINED field`);
const userDefined = (o) => o && typeof o === 'object' && Object.entries(o).some(([k, v]) => /USER_DEFINED/i.test(k) || userDefined(v));
for (const [i, record] of [...stations, p].entries()) check(!userDefined(record), `record ${i} carries USER_DEFINED`);
check(!notice.items.some((s) => /USER_DEFINED/i.test(s)), 'report carries USER_DEFINED');

const xyz = (g) => [g.POSITION_X, g.POSITION_Y, g.POSITION_Z].map((v) => v.toFixed(4)).join(' ');
console.log(`stations ${stations.length} (file ${fileStations}); Graz 7839 ${named[7839] ? xyz(named[7839]) : '-'} m; Yarragadee 7090 ${named[7090] ? xyz(named[7090]) : '-'} m; $PVN ${p.SOURCE_ID}/${p.ORIGINATOR}; USER_DEFINED none in ${stations.length + 1} records`);
if (failures.length) {
  console.error(`ILRS SINEX STATIONS: FAIL (${failures.length})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ILRS SINEX STATIONS: PASS');
