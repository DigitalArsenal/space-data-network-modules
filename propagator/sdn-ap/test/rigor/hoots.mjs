// Felix Hoots's questions (the theory's author): does the module implement the theory, at its definitions and at
// its edges, as the reference does?
import { THEORY } from "../lib/module.mjs";
import { elementsOf, tleLines } from "../lib/tle.mjs";
import { againstReference, days, defineCheck, moduleStates, REVIEWERS, verdict } from "./lib/rigor.mjs";

const LIMIT_M = 1;  // the conformance acceptance per sample (test/conformance.e2e.mjs; paper 12.1)
const set = (name, fields, minutes) => ({ name, lines: tleLines({ year: 26, day: 290.25, rev: 0, argp: 0, ma: 0, raan: 0, ...fields }), minutes });
const both = (name, fields, minutes, low = false) => [
  set(`${name}/SGP4`, { ...fields, type: 0, bstar: low ? 1e-4 : 1e-6 }, minutes),
  set(`${name}/SGP4XP`, { ...fields, type: 4, bterm: low ? 0.01 : 0.002, agom: 0.01 }, minutes),
];
const WEEK = days(7, 8);

export const checks = [
  defineCheck({
    id: "hoots-225-min-boundary", reviewer: REVIEWERS.HOOTS, tier: "fast",
    question: "Is the switch from near-Earth SGP4 to deep-space SDP4 at a period of 225 min of the recovered mean motion n''o, exactly where the reference switches? Sets swept across the boundary must all match the reference.",
    source: "Spacetrack Report #3 (Hoots & Roehrich 1980) sec. 6 and 10; AIAA 2006-6753 sec. II; paper 1.1",
    async run(ctx) {
      const sets = [];
      for (let k = 0; k <= 40; k += 1) {
        const mm = 6.36 + k * 0.002;
        sets.push(...both(`n=${mm.toFixed(3)}`, { mm, ecc: 0.01, inc: 50, argp: 30, ma: 60 }, [0, 360, 720, 1440]));
      }
      return verdict(await againstReference(ctx, sets), LIMIT_M, "41 mean motions 6.360..6.440 rev/day, SGP4 and SGP4XP");
    },
  }),
  defineCheck({
    id: "hoots-singular-geometry", reviewer: REVIEWERS.HOOTS, tier: "fast", timeoutSec: 30,
    question: "At the singular and critical geometries (e = 0, e at the 1e-4 drag rule, i = 0 and 180 deg, the critical inclination 63.4349 deg and its retrograde twin), does the module give the reference's states, and refuse where it refuses?",
    source: "STR#3 sec. 6 (1/(1-5 cos^2 i) and 1 + cos i divisors); AIAA 2006-6753 sec. VI.A, App. D; paper 1.1",
    async run(ctx) {
      const sets = [];
      for (const ecc of [0, 0.00009, 0.0001, 0.00011, 0.01]) for (const inc of [0, 63.4349, 116.5651, 180]) {
        sets.push(...both(`LEO e=${ecc} i=${inc}`, { mm: 15.2, ecc, inc, argp: 45, ma: 10 }, WEEK, true));
        sets.push(...both(`GEO e=${ecc} i=${inc}`, { mm: 1.0027, ecc, inc, argp: 45, ma: 10 }, WEEK));
      }
      return verdict(await againstReference(ctx, sets), LIMIT_M, "5 eccentricities x 4 inclinations, LEO and GEO, SGP4 and SGP4XP, 7 days");
    },
  }),
  defineCheck({
    id: "hoots-singular-geometry-sdnap", reviewer: REVIEWERS.HOOTS, tier: "fast",
    question: "Does the SDNAP theory stay finite at the same singular geometries: a state for every sample it accepts, never a NaN reported as good?",
    source: "paper 1.3 and 2.1 (equinoctial mean elements, nonsingular at e = 0 and i = 0); SPEC 1.5",
    async run(ctx) {
      const module = await ctx.module();
      const rows = [];
      for (const ecc of [0, 0.0001, 0.01, 0.7]) for (const inc of [0, 63.4349, 116.5651, 180]) for (const mm of [15.2, 2.006, 1.0027]) {
        if (ecc === 0.7 && mm > 3) continue;
        rows.push({ ...elementsOf(tleLines({ year: 26, day: 290.25, type: 4, bterm: 0.002, agom: 0.01, inc, raan: 0, ecc, argp: 45, ma: 10, mm })), theory: THEORY.SDNAP, label: `n=${mm} e=${ecc} i=${inc}` });
      }
      const out = moduleStates(module, rows, rows.map(() => WEEK));
      let good = 0, refused = 0, bad = 0;
      const refusedSets = new Set();
      out.forEach((states, k) => states.forEach((s) => { if (!s.ok) { refused += 1; refusedSets.add(rows[k].label); } else if ([...s.r, ...s.v].every(Number.isFinite)) good += 1; else bad += 1; }));
      return { pass: bad === 0 && good > 0, evidence: [`${rows.length} SDNAP sets x ${WEEK.length} times: ${good} finite states, ${refused} refused, ${bad} non-finite states reported good`,
        `refused (report only): ${[...refusedSets].join("; ") || "none"}`] };
    },
  }),
  defineCheck({
    id: "hoots-every-call-returns", reviewer: REVIEWERS.HOOTS, tier: "fast", timeoutSec: 60,
    question: "Does every call return, for every theory, at the edges of the element domain (e = 0, 1e-4, 0.5, 0.95; i = 0, 90, 179.9999, 180 deg; LEO, 12 h and GEO; up to 7 days either way): a state or a refusal, never a hang and never a non-finite state reported good?",
    source: "AIAA 2006-6753 App. D (a set is refused, not extrapolated); SPEC 1.5 (the equinoctial state for i < 180 deg); paper 1.1",
    async run(ctx) {
      const module = await ctx.module();
      const rows = [];
      for (const theory of [THEORY.SGP4, THEORY.SGP4XP, THEORY.SDNAP]) for (const ecc of [0, 0.0001, 0.5, 0.95]) for (const inc of [0, 90, 179.9999, 180]) for (const mm of [15.2, 2.006, 1.0027]) {
        if (ecc >= 0.5 && mm > 3) continue;
        const fields = { year: 26, day: 290.25, rev: 0, inc, raan: 30, ecc, argp: 45, ma: 10, mm };
        rows.push({ ...elementsOf(tleLines(theory === THEORY.SGP4 ? { ...fields, type: 0, bstar: 1e-4 } : { ...fields, type: 4, bterm: 0.005, agom: 0.01 })), theory });
      }
      // SDNAP a day either way (its integration costs about 60 ms per object-day), the others a week
      const timesOf = (row) => (row.theory === THEORY.SDNAP ? [-1440, 0, 720, 1440] : [-10080, -1440, 0, 720, 1440, 10080]);
      const t0 = performance.now();
      const out = moduleStates(module, rows, rows.map(timesOf));
      const seconds = (performance.now() - t0) / 1e3;
      let good = 0, refused = 0, bad = 0;
      out.flat().forEach((s) => { if (!s.ok) refused += 1; else if ([...s.r, ...s.v].every(Number.isFinite)) good += 1; else bad += 1; });
      return { pass: bad === 0, evidence: [`${rows.length} sets (SGP4, SGP4XP: 7 days either way; SDNAP: 1 day) x 4 to 6 times returned in ${seconds.toFixed(1)} s: ${good} finite states, ${refused} refused, ${bad} non-finite states reported good (a hang is a FAIL at the 60 s cap)`] };
    },
  }),
  defineCheck({
    id: "hoots-low-perigee", reviewer: REVIEWERS.HOOTS, tier: "fast",
    question: "Below 220 km perigee (the simplified drag equations), below 156 km and 98 km (the s* adjustments), and for a perigee under the Earth's surface, does SGP4 give the reference's states and refuse at the same sample (decay: radius below one Earth radius)?",
    source: "STR#3 sec. 6 (isimp, s* for perigee < 156 km and < 98 km); AIAA 2006-6753 sec. VI.A and App. D error traps; paper 1.1",
    async run(ctx) {
      const sets = [];
      const RE = 6378.135, KE = 0.0743669161;  // WGS-72 Earth radius (km) and k_e (er^1.5/min): test inputs only
      for (const hp of [250, 210, 150, 95, -50]) for (const ecc of [0.001, 0.02, 0.1]) {
        const a = (RE + hp) / (1 - ecc);
        const mm = (KE * (a / RE) ** -1.5) * 1440 / (2 * Math.PI);
        const grid = Array.from({ length: 145 }, (_, k) => k * 10);
        sets.push(set(`hp=${hp} km e=${ecc}`, { mm, ecc, inc: 51.6, argp: 270, ma: 90, type: 0, bstar: 2e-4 }, grid));
      }
      const r = verdict(await againstReference(ctx, sets), LIMIT_M, "perigee 250/210/150/95/-50 km x e 0.001/0.02/0.1, SGP4, 24 h at 10 min");
      return r;
    },
  }),
  defineCheck({
    id: "hoots-resonance-classes", reviewer: REVIEWERS.HOOTS, tier: "fast",
    question: "In each resonance class (synchronous, 12-hour at e >= 0.5, and the SGP4XP classes at 16 h and 8 h) and at the edges of the deep-space resonance bands, does the module match the reference over a week?",
    source: "STR#3 sec. 10 (DPINIT resonance windows 0.0034906585..0.0052359877 and 0.00826..0.00924 rad/min); USSF SGP4-XP description (paper ref. 4); paper 1.2 and 3.5",
    async run(ctx) {
      const sets = [];
      const cases = [["GEO", 1.0027, 0.0002, 0.05], ["GEO inclined", 1.0027, 0.001, 14], ["band low edge", 0.8001, 0.01, 10], ["band high edge", 1.1999, 0.01, 10],
        ["Molniya", 2.0059, 0.72, 63.4], ["12 h e=0.5", 2.0, 0.5, 55], ["12 h e=0.49", 2.0, 0.49, 55], ["GPS", 2.0056, 0.01, 55],
        ["12 h band low", 1.8935, 0.6, 63.4], ["12 h band high", 2.1155, 0.6, 63.4], ["16 h", 1.5, 0.3, 40], ["8 h", 3.0, 0.2, 40]];
      for (const [name, mm, ecc, inc] of cases) for (const raan of [0, 120, 240]) sets.push(...both(`${name} raan=${raan}`, { mm, ecc, inc, raan, argp: 270, ma: 30 }, WEEK));
      return verdict(await againstReference(ctx, sets), LIMIT_M, `${cases.length} resonance cases x 3 nodes, SGP4 and SGP4XP, 7 days`);
    },
  }),
  defineCheck({
    id: "hoots-lyddane-node-quadrant", reviewer: REVIEWERS.HOOTS, tier: "fast",
    question: "Below 0.2 rad of inclination (the Lyddane choice) and with the node near 0, 180 and 360 deg, is the node taken in the right quadrant, as the reference takes it?",
    source: "AIAA 2006-6753 sec. VI.C (Lyddane on the perturbed inclination; node within pi of the old node); paper 1.1",
    async run(ctx) {
      const sets = [];
      for (const inc of [0.01, 1, 5, 11.4, 11.5, 12]) for (const raan of [0, 0.05, 179.95, 180, 359.95]) {
        sets.push(...both(`i=${inc} raan=${raan}`, { mm: 1.0027, ecc: 0.0005, inc, raan, argp: 10, ma: 200 }, WEEK));
      }
      return verdict(await againstReference(ctx, sets), LIMIT_M, "6 inclinations x 5 nodes, deep space, SGP4 and SGP4XP, 7 days");
    },
  }),
  defineCheck({
    id: "hoots-mean-element-recovery", reviewer: REVIEWERS.HOOTS, tier: "fast",
    question: "Are the mean elements the set's: at the epoch, does the integrated mean state give back the set's e, i, node, perigee and anomaly, and does the inverse map of its mean a give back the set's mean motion?",
    source: "paper 2.1 and 2.4 (the inverse map); SPEC 1.1 and 1.5 (a = (k_e/n)^(2/3) of the set's mean motion)",
    async run(ctx) {
      const module = await ctx.module();
      const rows = [];
      for (const theory of [THEORY.SGP4XP, THEORY.SDNAP]) for (const [mm, ecc, inc] of [[15.5, 0.001, 51.6], [14.3, 0.002, 98.2], [2.0056, 0.01, 55], [2.0059, 0.72, 63.4], [1.0027, 0.0003, 0.1]]) {
        rows.push({ ...elementsOf(tleLines({ year: 26, day: 290.25, type: 4, bterm: 0.005, agom: 0.01, inc, raan: 33.3, ecc, argp: 123.4, ma: 222.2, mm })), theory });
      }
      module.init(rows);
      const x = module.x, out = x.sdnap_alloc(48);
      let worstN = 0, worstAng = 0, worstE = 0, refused = 0;
      const evidence = [];
      rows.forEach((row, i) => {
        const status = x.sdnap_mean_elements_at(i, 0, out);
        if (status !== 0) { refused += 1; evidence.push(`  row ${i} theory ${row.theory}: sdnap_mean_elements_at ${status}`); return; }
        const [a, e, inc, node, argp, m] = Array.from(new Float64Array(module.harness.memory.buffer, out, 6));
        const n = x.sdnap_mean_motion_of(a, e, inc);
        worstN = Math.max(worstN, Math.abs(n / row.meanMotion - 1));
        worstE = Math.max(worstE, Math.abs(e - row.ecc));
        const dAng = (p, q) => Math.abs(((p - q + 540) % 360) - 180);
        // node and perigee are undefined at e = 0 or i = 0 alone; their sum (and the mean longitude) is not
        worstAng = Math.max(worstAng, dAng(inc, row.inc), dAng(node + argp + m, row.raan + row.argp + row.ma));
      });
      x.sdnap_free(out);
      evidence.unshift(`${rows.length} sets (SGP4XP and SDNAP): mean motion back within ${worstN.toExponential(2)} relative, e within ${worstE.toExponential(2)}, i and mean longitude within ${worstAng.toExponential(2)} deg; ${refused} refused`);
      return { pass: refused === 0 && worstN <= 1e-12 && worstE <= 1e-12 && worstAng <= 1e-9, evidence };
    },
  }),
];
