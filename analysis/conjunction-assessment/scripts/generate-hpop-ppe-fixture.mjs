// Writes tests/fixtures/hpop-ppe/crossing-orbits.json: trajectories that the
// HPOP propagator module (propagator/hpop) exports for conjunction screening,
// as conjunction-assessment receives them from any propagator.
//
// Four objects leave one point of a 7000 km orbit at the same instant on
// planes 0, 45, 90 and 120 degrees apart, 0 to 2 km apart in radius, so every
// pair meets near that point and its antipode each half orbit. HPOP integrates
// them under the full force model (propagator/hpop/catalog.mjs, the catalog
// screen's configuration and environment) and exports its
// `conjunction-screening` profile: 13-coefficient Chebyshev intervals of 300 s,
// Earth GCRF, TT. The fixture keeps the PPE records as HPOP emitted them.
//
// usage: node scripts/generate-hpop-ppe-fixture.mjs <environment dir>
//   (kernel.prw, earth_orientation.prw and space_weather.prw covering
//   2026-09-30 and 2026-10-01; propagator/hpop built and installed)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hpop = path.resolve(root, '../../propagator/hpop');
const { makeTable, encodePrw, decodePrw, instant, TYPE } = await import(path.join(hpop, 'tests/lib/prwCodec.mjs'));
const { residentHarness, wasmPath } = await import(path.join(hpop, 'tests/lib/residentRuntime.mjs'));
const catalog = await import(path.join(hpop, 'catalog.mjs'));
const environmentDir = process.argv[2];
if (!environmentDir) throw new Error('usage: generate-hpop-ppe-fixture.mjs <environment dir>');
const environment = ['kernel', 'earth_orientation', 'space_weather'].map((portId) =>
  ({ portId, typeRef: TYPE, payload: new Uint8Array(fs.readFileSync(path.join(environmentDir, `${portId}.prw`))) }));

const EPOCH_UTC = '2026-10-01T00:00:00.000';
const LEAD_START_UTC = '2026-09-30T23:40:00.000';   // segments start 20 min before the meeting
const DURATION_S = 3 * 3600;
const OBJECTS = [                          // km, km/s; GCRF
  { handle: 1, norad: 90001, name: 'CROSSING-0', position: [7000, 0, 0], velocity: [0, 7.546, 0] },
  { handle: 2, norad: 90002, name: 'CROSSING-90', position: [7000.5, 0, 0], velocity: [0, 0, 7.5457] },
  { handle: 3, norad: 90003, name: 'CROSSING-45', position: [7001, 0, 0], velocity: [0, 5.3357, 5.3357] },
  { handle: 4, norad: 90004, name: 'CROSSING-120', position: [7002, 0, 0], velocity: [0, -3.773, 6.535] },
];

const instance = makeTable('PRWInstance', { MODULE_ID: 'com.orbpro.hpop', INSTANCE_ID: 'ca-ppe-fixture', GENERATION: 1n });
const call = async (h, methodId, port, arm, records) => {
  const response = await h.invoke({ methodId, inputs: records.map((r) => ({ portId: port, typeRef: TYPE, payload: encodePrw(arm, r) })) });
  if (response.statusCode !== 0) throw new Error(`${methodId}: ${response.errorCode}: ${response.errorMessage}`);
  return response;
};
// Plain JSON for flatc: BigInt as numbers, typed arrays as arrays.
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) =>
  typeof x === 'bigint' ? Number(x) : ArrayBuffer.isView(x) ? Array.from(x) : x));

const h = await residentHarness('browser');
try {
  const meters = (o) => [...o.position, ...o.velocity].map((x) => x * 1000);
  const ingest = await h.invoke({ methodId: 'ingest_state', inputs: [
    ...OBJECTS.map((o) => ({ portId: 'state', typeRef: TYPE, payload: catalog.encode('RESIDENT_STATE', catalog.residentState({
      instanceId: 'ca-ppe-fixture', handle: o.handle, catalogNumber: o.norad, objectId: o.name, epoch: EPOCH_UTC, state: meters(o),
      cdAm: catalog.DEFAULT_DRAG_AREA_OVER_MASS, crAm: catalog.DEFAULT_SRP_AREA_OVER_MASS })) })),
    { portId: 'configuration', typeRef: TYPE, payload: catalog.encode('EXECUTION_REQUEST', catalog.fullForceRequest({ epoch: EPOCH_UTC, state: meters(OBJECTS[0]) })) },
    ...environment] });
  if (ingest.statusCode !== 0) throw new Error(`ingest_state: ${ingest.errorCode}: ${ingest.errorMessage}`);
  const prepared = decodePrw((await call(h, 'prepare_trajectory_segments', 'request', 'PREPARE_REQUEST', [
    makeTable('PRWPrepareRequest', { INSTANCE: instance, START_EPOCH: catalog.instant(LEAD_START_UTC, 'UTC'), DURATION_SECONDS: DURATION_S, PROFILE: 'conjunction-screening' }),
  ])).outputs[0].payload).PREPARE_RESULT;
  if (!prepared.COVERAGE_COMPLETE) throw new Error('HPOP did not cover the interval.');
  const describe = makeTable('PRWDescribeRequest', { INSTANCE: instance, SEGMENT_SET_HANDLE: prepared.SEGMENT_SET_HANDLE });
  const sources = [];
  for (;;) {
    const chunk = decodePrw((await call(h, 'describe_trajectory_segments', 'request', 'DESCRIBE_REQUEST', [describe])).outputs[0].payload).DESCRIBE_RESULT;
    for (const s of chunk.SOURCES) {
      const o = OBJECTS.find((x) => x.handle === s.SOURCE_HANDLE);
      sources.push({ SOURCE_HANDLE: o.handle, OBJECT_ID: o.name, OBJECT_NAME: o.name, NORAD_CATALOG_ID: o.norad, POLYNOMIAL_EPHEMERIS: plain(s.EPHEMERIS) });
    }
    if (chunk.FINAL_CHUNK) break;
  }
  const out = path.join(root, 'tests/fixtures/hpop-ppe/crossing-orbits.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    source: {
      propagator: 'propagator/hpop ingest_state (full force, catalog.mjs) + prepare_trajectory_segments + describe_trajectory_segments, profile conjunction-screening',
      hpopModuleSha256: createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex'),
      environmentSha256: Object.fromEntries(environment.map((f) => [f.portId, createHash('sha256').update(f.payload).digest('hex')])),
      epochUtc: EPOCH_UTC, durationSeconds: DURATION_S, frame: 'GCRF', initialStates: OBJECTS,
    },
    sources,
  }) + '\n');
  console.log(`${sources.length} sources, ${sources[0].POLYNOMIAL_EPHEMERIS.POSITION_RECORDS.length} intervals each -> ${path.relative(root, out)}`);
} finally {
  await h.destroy();
}
