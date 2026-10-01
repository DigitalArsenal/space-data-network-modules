// Writes tests/fixtures/hpop-ppe/crossing-orbits.json: trajectories that the
// HPOP propagator module (propagator/hpop) exports for conjunction screening,
// as conjunction-assessment receives them from any propagator.
//
// Four objects leave one point of a 7000 km orbit at the same instant on
// planes 0, 45, 90 and 120 degrees apart, 0 to 2 km apart in radius, so every
// pair meets near that point and its antipode each half orbit. HPOP integrates
// them (its default resident force model) and exports its
// `conjunction-screening` profile: 13-coefficient Chebyshev intervals of 600 s,
// Earth GCRF, TDB. The fixture keeps the PPE records as HPOP emitted them.
//
// usage: node scripts/generate-hpop-ppe-fixture.mjs   (propagator/hpop built and installed)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hpop = path.resolve(root, '../../propagator/hpop');
const { makeTable, encodePrw, decodePrw, instant, residentState, TYPE } = await import(path.join(hpop, 'tests/lib/prwCodec.mjs'));
const { residentHarness, wasmPath } = await import(path.join(hpop, 'tests/lib/residentRuntime.mjs'));

const EPOCH_TDB_JD = 2461314.5;          // 2026-10-01T00:00:00 TDB
const LEAD_S = 1200;                       // segments start 20 min before the meeting
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
  await call(h, 'ingest_state', 'state', 'RESIDENT_STATE', OBJECTS.map((o) => Object.assign(
    residentState({ epochJD: EPOCH_TDB_JD, position: o.position, velocity: o.velocity }),
    { INSTANCE: instance, ENTITY_HANDLE: o.handle, CATALOG_NUMBER: o.norad, OBJECT_ID: o.name })));
  const prepared = decodePrw((await call(h, 'prepare_trajectory_segments', 'request', 'PREPARE_REQUEST', [
    makeTable('PRWPrepareRequest', { INSTANCE: instance, START_EPOCH: instant(EPOCH_TDB_JD - LEAD_S / 86400), DURATION_SECONDS: DURATION_S, PROFILE: 'conjunction-screening' }),
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
      propagator: 'propagator/hpop prepare_trajectory_segments + describe_trajectory_segments, profile conjunction-screening',
      hpopModuleSha256: createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex'),
      epochTdbJd: EPOCH_TDB_JD, durationSeconds: DURATION_S, frame: 'GCRF', initialStates: OBJECTS,
    },
    sources,
  }) + '\n');
  console.log(`${sources.length} sources, ${sources[0].POLYNOMIAL_EPHEMERIS.POSITION_RECORDS.length} intervals each -> ${path.relative(root, out)}`);
} finally {
  await h.destroy();
}
