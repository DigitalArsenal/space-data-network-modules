// A screen whose coarse pass would not fit the module's memory completes in
// chunks, or is refused by name; it never traps.
// Cause (0.15.0): a coarse pass keeps every encounter run of its window (a
// pair's consecutive coarse steps inside the coarse radius, 200 times the
// threshold without a resident index) and an entry for every pair it has hit,
// and only after the pass merges the runs into one list and refines them. At
// 15 km, 2,000 LEO objects make about 4 million runs a day; over 72 h the merge
// asks for more than the module's 2 GiB memory, operator new aborts, and the
// instance ends in `unreachable`. 0.16.0 counts what a pass holds (one count
// for all its workers, checked each step) against 768 MiB. A pass within it
// runs as before. The single-window implicit pass (screen_catalog all vs all,
// screen_window) that would pass it is dropped, and the window is screened on
// the chunked path, in chunks as long as half the budget holds at what a step
// held. A pass that cannot be cut (explicit pairs, or one coarse step of the
// implicit path) is refused: screen-memory-limit, SCREEN_MEMORY_LIMIT naming
// the limit, the window that fits and a threshold that fits.
//
// Synthetic (invented element sets, no real object or catalog): 2,000 LEO
// objects, SGP4 mean elements, TEME, UTC, epoch 2026-10-29T12:00Z: perigee
// 300-1,500 km, apogee at most 2,000 km, inclinations near 53 and 97.6 deg,
// 70-87 deg and 0-110 deg (seeded). Window from 2026-10-30T00:00Z; 15 km
// threshold, 60 s coarse step, 1 ms refinement tolerance, 10 m combined
// radius, ALFANO_MAXIMUM.
// (1) One screen_catalog call over 72 h (8 workers) completes: it refines
//     about 12.2 million encounter runs. Three 24 h calls (6 workers each,
//     each within the budget, so on the single-window pass), merged as
//     consecutive windows are (one pair's events under a second apart across
//     an edge are one, the smaller miss), give the same conjunctions, every
//     event byte for byte (each field of the event, unpacked by the SDS
//     bindings, which keep every double exact). Measured: 3,873 conjunctions,
//     all identical.
// (2) The same call on 0.15.0 (the artifact at BASE, read from git; 8
//     workers) traps: the case still exercises the failure.
// (3) The explicit-pairs path (the first 700 objects as inline primaries, the
//     other 1,300 as secondaries, 7 days at 15 km) is refused by name within
//     seconds, no trap.
// (4) Captured-request replay: the module's suites that drive it through
//     tests/lib/conjunctionCommandHarness.mjs run with CA_REPLAY_BASE_WASM
//     naming 0.15.0, so every invoke runs on both builds; every request, with
//     GP input or without, answers byte for byte alike, the instant a CDM is
//     created aside (CREATION_DATE and the MESSAGE_ID naming it are the wall
//     clock). A floor on each method's count keeps the replay's reach.
// Each call runs in its own process: an invoke holds its process's JS thread
// for its whole run, so the legs and the replay run at once (a call gains
// little past 8 workers: 72 h takes 151 s with 8 and 269 s with 16).
// Run: node --test tests/screenMemoryLimit.e2e.mjs (needs dist/ built and the
// repository's git history)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ByteBuffer } from 'flatbuffers';
import { CQR } from 'spacedatastandards.org/lib/js/CQR/CQR.js';
import { artifactAt, assertAllAlike, replaySuites } from './lib/requestReplay.mjs';

const here = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(here), '..');
const BASE = '22322fdecc54978e5b545505fdc92bc19aba406c';  // conjunction-assessment 0.15.0
const JD_START = 2461343.5;   // 2026-10-30T00:00:00Z
const HOUR_DAYS = 1 / 24;

// ── one leg, in its own process ──
async function leg({ hours, startHours = 0, workers, split = 0, wasm }) {
  const { createConjunctionCommandHarness } = await import('./lib/conjunctionCommandHarness.mjs');
  const cqr = await import('./lib/cqr.mjs');
  const { seeded } = await import('./lib/syntheticCatalog.mjs');
  const flatc = await cqr.initCqrFlatc();
  const random = seeded(20261030), gp = [], MU = 398600.8, RE = 6378.135;
  for (let k = 0; k < 2000; k++) {
    const hp = 300 + 1200 * random(), ha = Math.min(2000, hp + 400 * random() * random());
    const a = RE + (hp + ha) / 2, u = random();
    const inclination = u < 0.3 ? 53 + random() : u < 0.6 ? 97.6 + 0.5 * random() : u < 0.8 ? 70 + 17 * random() : 110 * random();
    gp.push({ OBJECT_NAME: `SYN-LEO-${k}`, OBJECT_ID: `SYN-LEO-${k}`, NORAD_CAT_ID: 800000 + k, EPOCH: '2026-10-29T12:00:00.000000',
      ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1, CLASSIFICATION_TYPE: 'U', BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
      MEAN_MOTION: (Math.sqrt(MU / a ** 3) * 86400) / (2 * Math.PI), ECCENTRICITY: (ha - hp) / (2 * a), INCLINATION: inclination,
      RA_OF_ASC_NODE: 360 * random(), ARG_OF_PERICENTER: 360 * random(), MEAN_ANOMALY: 360 * random() });
  }
  const CONTROLS = { ...cqr.screeningControls({ startJd: JD_START + startHours * HOUR_DAYS, durationSeconds: hours * 3600, thresholdKm: 15,
    numThreads: workers, coarseStepSec: 60, fineTolSec: 0.001, combinedRadiusM: 10 }), ALGORITHM: 'ALFANO_MAXIMUM' };
  const EVALUATION_FRAME = cqr.earthFrame('TEME');
  const inputs = split
    ? [{ portId: 'request', payload: cqr.encodeCqr(flatc, { CATALOG_REQUEST: { CONTROLS, EVALUATION_FRAME,
      PRIMARIES: gp.slice(0, split).map(cqr.gpSource), SECONDARIES: gp.slice(split).map(cqr.gpSource) } }) }]
    : [{ portId: 'request', payload: cqr.encodeCqr(flatc, { CATALOG_REQUEST: { CONTROLS, EVALUATION_FRAME } }) },
      ...gp.map((g) => ({ portId: 'catalog', payload: flatc.generateBinary(cqr.publishedSchema('OMM'), JSON.stringify(cqr.gpRecord(g)), { sizePrefix: false }) }))];
  const harness = await createConjunctionCommandHarness({ runtimeKind: 'browser', ...(wasm ? { wasmSource: wasm } : {}) });
  const t0 = performance.now(), events = [];
  try {
    for (;;) {
      const r = await harness.invoke({ methodId: 'screen_catalog', inputs });
      if (r.statusCode !== 0) return { refused: { code: r.errorCode, message: r.errorMessage }, seconds: (performance.now() - t0) / 1000 };
      const result = CQR.getRootAsCQR(new ByteBuffer(r.outputs.find((f) => f.portId === 'result').payload)).unpack().CATALOG_RESULT;
      events.push(...result.EVENTS);
      if (result.FINAL_CHUNK) {
        assert.equal(Number(result.CONJUNCTIONS_FOUND), events.length);
        return { events, seconds: (performance.now() - t0) / 1000 };
      }
    }
  } catch (error) {
    return { trapped: String(error?.message ?? error), seconds: (performance.now() - t0) / 1000 };
  } finally {
    await harness.destroy?.();
  }
}

const exact = (key, value) => (typeof value === 'bigint' ? `${value}n` : value);
if (process.argv[2] === '--leg') {
  const answer = await leg(JSON.parse(process.argv[3]));
  fs.writeFileSync(process.argv[4], JSON.stringify(answer, exact));
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-screen-memory-'));
const run = (name, options) => new Promise((resolve, reject) => {
  const out = path.join(work, `${name}.json`);
  const child = spawn(process.execPath, [here, '--leg', JSON.stringify(options), out], { cwd: packageRoot, stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', reject);
  child.once('exit', (code, signal) => (code === 0 ? resolve(JSON.parse(fs.readFileSync(out, 'utf8'))) : reject(Error(`${name}: exit ${code}, signal ${signal}`))));
});
const pairOf = (e) => [parseInt(e.PRIMARY_NORAD_ID, 10), parseInt(e.SECONDARY_NORAD_ID, 10)].sort((x, y) => x - y).join('-');
const byPairThenTca = (a, b) => pairOf(a).localeCompare(pairOf(b)) || a.TCA.JULIAN_DATE - b.TCA.JULIAN_DATE;

test('screen_catalog never traps on its coarse storage, and nothing else moves', { concurrency: true }, async (t) => {
  const base = artifactAt(packageRoot, BASE, work);
  try {
    await Promise.all([
      t.test('72 h at 15 km over 2,000 LEO objects: one call completes with the conjunctions of three 24 h calls; 0.15.0 traps; explicit pairs past the budget are refused by name', async () => {
        const whole = run('72h', { hours: 72, workers: 8 });
        const days = Promise.all([0, 24, 48].map((startHours) => run(`24h-${startHours}`, { hours: 24, startHours, workers: 6 })));
        // These two take the 24 h calls' cores once they are done.
        const others = days.then(() => Promise.all([run('72h-0.15.0', { hours: 72, workers: 8, wasm: base }),
          run('explicit-7d', { hours: 168, workers: 4, split: 700 })]));
        const [one, parts, [previous, explicit]] = await Promise.all([whole, days, others]);
        console.log(`72 h one call: ${one.events?.length} conjunctions in ${one.seconds.toFixed(1)} s; 24 h calls: ` +
          `${parts.map((d) => `${d.events?.length} in ${d.seconds.toFixed(1)} s`).join(', ')}; 0.15.0: ${previous.trapped ?? 'no trap'} after ` +
          `${previous.seconds.toFixed(1)} s; explicit 7 d: ${explicit.refused?.code} after ${explicit.seconds.toFixed(1)} s`);

        // (1) The single call completes, with the merged days' conjunctions, byte for byte.
        assert.ok(one.events, `72 h call: ${JSON.stringify(one.refused ?? one.trapped)}`);
        for (const d of parts) assert.ok(d.events, `24 h call: ${JSON.stringify(d.refused ?? d.trapped)}`);
        const merged = [];
        for (const e of parts.flatMap((d) => d.events).sort(byPairThenTca)) {
          const last = merged.at(-1);
          if (last && pairOf(last) === pairOf(e) && Math.abs(e.TCA.JULIAN_DATE - last.TCA.JULIAN_DATE) * 86400 < 1) {
            if (e.MISS_DISTANCE_M < last.MISS_DISTANCE_M) merged[merged.length - 1] = e;
          } else merged.push(e);
        }
        const single = [...one.events].sort(byPairThenTca);
        assert.ok(single.length > 3000, `72 h call: ${single.length} conjunctions`);
        assert.equal(single.length, merged.length, 'as many conjunctions as the three 24 h calls merged');
        const differing = single.map((e, k) => [JSON.stringify(e, exact), JSON.stringify(merged[k], exact)]).filter(([x, y]) => x !== y);
        assert.equal(differing.length, 0, `events differing from the merged 24 h calls: ${differing.slice(0, 2).map((d) => d.join('\n')).join('\n\n')}`);

        // (2) 0.15.0 traps on the same call.
        assert.match(previous.trapped ?? '', /unreachable/, `0.15.0 72 h call: ${JSON.stringify(previous.refused ?? 'completed')}`);

        // (3) Explicit pairs past the budget: refused by name, naming what fits.
        assert.equal(explicit.refused?.code, 'screen-memory-limit', JSON.stringify(explicit));
        assert.match(explicit.refused.message, /^SCREEN_MEMORY_LIMIT: the coarse pass of this screen \(\d+ pairs, 168\.0 h at 15 km\) would hold about \d+ MiB of encounter runs, past the 768 MiB a coarse pass may keep of the module's 2048 MiB\. At 15 km a window of at most \d+\.\d h fits; over 168\.0 h, a threshold of at most \d+(\.\d+)? km\.$/);
        assert.ok(explicit.seconds < 60, `explicit refusal after ${explicit.seconds} s`);
      }),
      t.test('captured-request replay: every request of the module suites answers byte for byte as 0.15.0 does', async () => {
        console.log(assertAllAlike(await replaySuites({ packageRoot, base, dir: work }), `0.15.0 (${BASE.slice(0, 9)})`));
      }),
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
