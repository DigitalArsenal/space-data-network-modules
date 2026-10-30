// SGP4 input of the conjunction screen (conjunction-assessment 0.11.0).
//
// (i) An OMM's elements reach SGP4 as published. Every screen_catalog event's two states (TEME, at the event's TCA)
//     equal foundation/sgp4-str3 in AFSPC mode on the OMM's decimal text, built natively from
//     tests/native/sgp4_omm_states.cpp (no module code), within 1 mm and 1 mm/s: B* up to 0.2, perigees below
//     220 km (STR#3's truncated drag terms), resonant and low-inclination deep-space sets, on both screen branches
//     (ALFANO_MAXIMUM, the SGP4 screener, and FOSTER, the generic engine). The same reference with B* and e as a TLE
//     prints them (five digits, seven decimals) is more than a meter off the high-B* states: the check sees the
//     rounding a TLE text step makes.
// (ii) A TLE's text, read by the module's TLE field parser, equals the same set given as an OMM at TLE precision
//     (each field as the TLE prints it, the epoch exactly to the microsecond): the same events, field for field.
//
// Data: tests/fixtures/spacetrack-gp (Space-Track.org GP, 2026-10-29; citation there).
// Run: node --test tests/sgp4OmmInput.e2e.mjs (needs dist/ built and a C++ compiler). The browser runtime by
// default; CQR_TEST_RUNTIME=wasmedge runs it there (slow: a process per invoke). The runtimes' agreement on the same
// bytes is the runtime-parity gate (npm run test:runtime-parity).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createConjunctionCommandHarness } from './lib/conjunctionCommandHarness.mjs';
import { decodeCqr, earthFrame, encodeCqr, gpSource, initCqrFlatc, screeningControls, tleSource } from './lib/cqr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, '../../..');
const SETS = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/spacetrack-gp/gp-2026-10-29.json'), 'utf8'));
const byNorad = new Map(SETS.map((s) => [Number(s.NORAD_CAT_ID), s]));
const START_JD = Date.parse('2026-10-29T00:00:00Z') / 86400000 + 2440587.5;
const HIGH_BSTAR = [67024, 67087, 66831, 66834], LOW_PERIGEE = [32730, 44478];
const GEO = [29055, 31306, 33436, 37775], TWELVE_HOUR = [45254], NODE_NEAR_ZERO = [40942, 58346];
const GROUPS = [
  { label: 'LEO: B* up to 0.2, ISS, perigees below 220 km', thresholdKm: 1000, days: 1,
    norads: [...HIGH_BSTAR, 52634, 52699, 51132, 62600, 54853, 62428, 25544, ...LOW_PERIGEE] },
  { label: 'geosynchronous resonant cluster', thresholdKm: 200, days: 2, norads: GEO },
  { label: 'deep space against LEO: node near 0, 12-hour resonant', thresholdKm: 3000, days: 2,
    norads: [...NODE_NEAR_ZERO, ...TWELVE_HOUR, 25544, 67024, 52634, 62428] },
];
const NUMERIC = ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY',
  'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH'];

// A TLE's fields as it prints them (columns, 1-based): B* 54-61, e 27-33, inclination 9-16, node 18-25, argument of
// perigee 35-42, mean anomaly 44-51, mean motion 53-63; the epoch 19-32, yyddd.dddddddd, where a fraction digit is
// 864 us, so the epoch is exact as microsecond text. Text handling only.
function tleFields(s) {
  const l1 = s.TLE_LINE1, l2 = s.TLE_LINE2, b = l1.slice(53, 61);
  const yy = Number(l1.slice(18, 20)), [dayText, fractionText] = l1.slice(20, 32).split('.');
  const micros = BigInt(fractionText.padEnd(8, '0')) * 864n, seconds = micros / 1000000n;
  const day = new Date(Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, Number(dayText))).toISOString().slice(0, 10);
  const two = (x) => String(x).padStart(2, '0');
  return {
    EPOCH: `${day}T${two(seconds / 3600n)}:${two((seconds / 60n) % 60n)}:${two(seconds % 60n)}.${String(micros % 1000000n).padStart(6, '0')}`,
    BSTAR: `${b[0] === '-' ? '-' : ''}0.${b.slice(1, 6)}e${b[6] === '-' ? '-' : '+'}${b[7]}`,
    ECCENTRICITY: `0.${l2.slice(26, 33)}`, INCLINATION: l2.slice(8, 16).trim(), RA_OF_ASC_NODE: l2.slice(17, 25).trim(),
    ARG_OF_PERICENTER: l2.slice(34, 42).trim(), MEAN_ANOMALY: l2.slice(43, 51).trim(), MEAN_MOTION: l2.slice(52, 63).trim(),
  };
}
const ommSource = (s, text = s) => gpSource({ OBJECT_NAME: s.OBJECT_NAME, OBJECT_ID: s.OBJECT_ID, EPOCH: text.EPOCH,
  CLASSIFICATION_TYPE: s.CLASSIFICATION_TYPE, ...Object.fromEntries(NUMERIC.map((k) => [k, Number(text[k] ?? s[k])])) });
const tleTextSource = (s) => ({ ...tleSource({ name: s.OBJECT_NAME, line1: s.TLE_LINE1, line2: s.TLE_LINE2 }),
  OBJECT_ID: s.OBJECT_ID, NORAD_CATALOG_ID: Number(s.NORAD_CAT_ID) });

// The native reference, built once: states at the given Julian dates, per set (decimal text in, km and km/s out).
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-sgp4-omm-'));
const driver = path.join(work, 'sgp4_omm_states');
execFileSync(process.env.CXX || 'c++', ['-std=c++17', '-O2', `-I${path.join(modules, 'foundation/sgp4-str3/include')}`,
  path.join(here, 'native/sgp4_omm_states.cpp'), '-o', driver]);
function referenceStates(requests) {
  const input = requests.map(({ text, jds }) => [text.EPOCH, text.MEAN_MOTION, text.ECCENTRICITY, text.INCLINATION,
    text.RA_OF_ASC_NODE, text.ARG_OF_PERICENTER, text.MEAN_ANOMALY, text.BSTAR, jds.length, ...jds.map(String)].join(' '));
  const blocks = execFileSync(driver, { input: `${input.join('\n')}\n`, encoding: 'utf8' }).split('X\n').slice(0, -1);
  return blocks.map((block) => block.trim().split('\n').map((line) => line.split(' ').map(Number))
    .map(([status, ...rv]) => ({ status, r: rv.slice(0, 3).map((x) => x * 1e3), v: rv.slice(3).map((x) => x * 1e3) })));
}

const flatc = await initCqrFlatc();
let frames = 1000n;
async function screen(harness, sources, group, algorithm) {
  const record = { CATALOG_REQUEST: { PRIMARIES: sources, EVALUATION_FRAME: earthFrame('TEME'), CONTROLS: {
    ...screeningControls({ startJd: START_JD, durationDays: group.days, thresholdKm: group.thresholdKm, coarseStepSec: 60,
      fineTolSec: 0.001, combinedRadiusM: 10 }), ALGORITHM: algorithm } } };
  // Results come in chunks: the identical request, with its input frame ID, continues until FINAL_CHUNK.
  const payload = encodeCqr(flatc, record), frameId = ++frames, chunks = [];
  while (!chunks.at(-1)?.FINAL_CHUNK) {
    assert.ok(chunks.length < 10000, `${group.label} (${algorithm}): the drain ends`);
    const response = await harness.invoke({ methodId: 'screen_catalog', inputs: [{ portId: 'request', payload, frameId }] });
    assert.equal(response.statusCode, 0, `${group.label} (${algorithm}): ${response.errorCode} ${response.errorMessage}`);
    for (const o of response.outputs) if ((o.portId ?? 'result') === 'result') chunks.push(decodeCqr(flatc, o.payload).CATALOG_RESULT);
  }
  assert.equal(chunks.at(-1).STATISTICS.FAILED_PAIRS, 0, `${group.label} (${algorithm}): failed pairs`);
  return chunks.flatMap((c) => c.EVENTS ?? []);
}
const vector = (v) => [v.X, v.Y, v.Z];
const sides = (e) => [[e.PRIMARY_NORAD_ID, e.PRIMARY_STATE], [e.SECONDARY_NORAD_ID, e.SECONDARY_STATE]];

for (const runtimeKind of [process.env.CQR_TEST_RUNTIME || 'browser']) {
  test(`${runtimeKind}: OMM elements reach SGP4 as published; TLE text equals the OMM at TLE precision`, async () => {
    const harness = await createConjunctionCommandHarness({ runtimeKind });
    try {
      const covered = new Set(), summary = [];
      for (const group of GROUPS) {
        const sets = group.norads.map((n) => byNorad.get(n));
        for (const algorithm of ['ALFANO_MAXIMUM', 'FOSTER']) {
          const tag = `${group.label} (${algorithm})`;
          // (i) every event state against the reference at full precision, and at TLE precision (B* and e only)
          const events = await screen(harness, sets.map((s) => ommSource(s)), group, algorithm);
          assert.ok(events.length > 0, `${tag}: events`);
          const times = new Map();
          for (const e of events) for (const [norad] of sides(e)) {
            covered.add(norad);
            if (!times.has(norad)) times.set(norad, []);
            times.get(norad).push(e.TCA.JULIAN_DATE);
          }
          const norads = [...times.keys()];
          const full = referenceStates(norads.map((n) => ({ text: byNorad.get(n), jds: times.get(n) })));
          const rounded = referenceStates(norads.map((n) => {
            const t = tleFields(byNorad.get(n));
            return { text: { ...byNorad.get(n), BSTAR: t.BSTAR, ECCENTRICITY: t.ECCENTRICITY }, jds: times.get(n) };
          }));
          const next = new Map(norads.map((n) => [n, 0]));
          let dr = 0, dv = 0, tleRounding = 0;
          for (const e of events) for (const [norad, state] of sides(e)) {
            const k = norads.indexOf(norad), j = next.get(norad);
            next.set(norad, j + 1);
            const ref = full[k][j], tle = rounded[k][j];
            assert.equal(ref.status, 0, `${tag}: the reference propagates ${norad} at ${e.TCA.JULIAN_DATE}`);
            const r = vector(state.STATE.POSITION), v = vector(state.STATE.VELOCITY);
            dr = Math.max(dr, Math.hypot(...r.map((x, c) => x - ref.r[c])));
            dv = Math.max(dv, Math.hypot(...v.map((x, c) => x - ref.v[c])));
            if (HIGH_BSTAR.includes(norad)) tleRounding = Math.max(tleRounding, Math.hypot(...r.map((x, c) => x - tle.r[c])));
          }
          assert.ok(dr <= 1e-3, `${tag}: position ${dr} m from sgp4-str3 at full precision`);
          assert.ok(dv <= 1e-3, `${tag}: velocity ${dv} m/s from sgp4-str3 at full precision`);
          if (group === GROUPS[0]) assert.ok(tleRounding > 1, `${tag}: TLE rounding moves the high-B* states only ${tleRounding} m`);
          // (ii) the TLE text against the OMM at TLE precision
          const fromText = await screen(harness, sets.map(tleTextSource), group, algorithm);
          const fromOmm = await screen(harness, sets.map((s) => ommSource(s, { ...s, ...tleFields(s) })), group, algorithm);
          assert.equal(fromText.length, fromOmm.length, `${tag}: TLE text and OMM at TLE precision find the same events`);
          assert.deepEqual(fromText, fromOmm, `${tag}: TLE text and OMM at TLE precision give the same events`);
          summary.push(`${tag}: ${events.length} events, max ${dr.toExponential(2)} m / ${dv.toExponential(2)} m/s from the reference` +
            (group === GROUPS[0] ? `, TLE rounding ${tleRounding.toFixed(1)} m` : '') + `; TLE text = OMM at TLE precision over ${fromText.length} events`);
        }
      }
      for (const [role, list] of [['high B*', HIGH_BSTAR], ['perigee below 220 km', LOW_PERIGEE], ['geosynchronous resonant', GEO],
        ['12-hour resonant', TWELVE_HOUR], ['node near 0', NODE_NEAR_ZERO]])
        assert.ok(list.some((n) => covered.has(n)), `an event state covers the ${role} sets`);
      console.log(summary.join('\n'));
    } finally {
      await harness.destroy?.();
    }
  });
}
test.after(() => fs.rmSync(work, { recursive: true, force: true }));
