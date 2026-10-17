#!/usr/bin/env node
// The synthetic truth of the delta-V uncertainty E2E (tests/dv-uncertainty.e2e.mjs):
// random LEO-M orbits propagated by propagator/ffm at full force, one known
// impulse in RTN per trial, and SGP4 element sets fitted to that truth every
// 8 hours (one hour of jitter), each over the 2 days before its epoch (after
// the burn: from the burn), the first after the burn at least 5 hours after
// it. With 2-day spans the sets' errors at the burn are at the level of the
// GP error model (E14, measured on Space-Track's sets); 0.75-day spans gave
// twice its along-track error. Writes, per base orbit, the sets before the
// burn and, per trial, the burn, its delta-V and the sets after it. The orbit
// computations are the modules' (study/lib/dv-mc-task.mjs).
//
//   npm ci   # this package; the sibling scripts resolve their imports here
//   node study/dv-mc-truth.mjs [--bases 50] [--trials 10] [--seed 20261017] [--fit-days 2] [--out tests/dv-mc-truth.json]
//
// The FFM environment is propagator/ffm's E2E fixture (2026-07-31 to 2026-08-09).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPool, waitForLoad } from './lib/pool.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const bases = Number(args.bases ?? 50), trials = Number(args.trials ?? 10), seed = Number(args.seed ?? 20261017);
const out = path.resolve(args.out ?? path.join(here, '../tests/dv-mc-truth.json'));
const context = { trials, start: '2026-08-01T00:00:00Z', cadenceHours: 8, fitDays: Number(args['fit-days'] ?? 2), sets: 9, postArcHours: 5 };
const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

await waitForLoad(50, log);
const started = Date.now();
const items = Array.from({ length: bases }, (_, base) => ({ base, seed: seed * 1000 + base }));
const results = await runPool(new URL('./lib/dv-mc-task.mjs', import.meta.url), items, context,
  { workers: 6, onDone: (n, of) => log(`${n}/${of} bases ${Math.round((Date.now() - started) / 1000)} s`) });
const fixture = {
  generator: 'study/dv-mc-truth.mjs', seed, ...context,
  truth: 'propagator/ffm catalog.mjs fullForceRequest (FFM-1), impulse in RTN_AXES, environment propagator/ffm/tests/fixtures/ffm-e2e-requests',
  sets: `analysis/gp-error-model fit_elements, SGP4 (WGS-72, opsmode i), epoch at the end of a ${context.fitDays}-day span (after the burn: from the burn), every 300 s; B* fitted before the burn, held after it`,
  set_fields: ['EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR'],
  bases: results.map((r) => r.base),
  trials: results.flatMap((r) => r.trials),
};
fs.writeFileSync(out, `${JSON.stringify(fixture)}\n`);
log(`${fixture.trials.length} trials over ${bases} orbits -> ${out} (${Math.round((Date.now() - started) / 1000)} s)`);
