#!/usr/bin/env node
// E2E (task modules-sdn-gp-propagator-20261023): the module's SGP4XP against
// the black-box oracle over a randomized corpus across LEO, SSO, MEO, GEO,
// HEO and VDS for 7 days. Acceptance: median <= 1 cm over at least 10,000
// SGP4XP sets, and every scored sample within 1 m except where an inherent
// class (coordinator ruling 2026-10-24) accepts it:
// - decay: a set either side refuses within the span, or whose drag moves it
//   more than 1,000 km, is scored only while both propagate, within 1e-4 of the
//   drag-induced displacement, and both refusal epochs agree within 1 % of the
//   elapsed lifetime (bisected to 1 minute);
// - shadow: where the module's rounding-limited SPEC 4 decisions (amendment 6: a
//   candidate with 1e-13 <= |S| <= 1e-11, or a decision that moving the inputs
//   by up to 8 units in the last place changes), run both ways in every rate
//   evaluation (every one a sunlit arc, every one wholly sunlit), give different
//   states, the oracle must fall between them (in each coordinate, 1 m margin);
// - equator node: in a deterministic corpus of argp = 0 sets the hemisphere
//   flipped at the node must reproduce the oracle where the unflipped one does
//   not.
// A control corpus of SGP4 (type 0) sets checks the public base against the
// same library.
//
// The module is asked for the times in a shuffled order, the oracle in
// ascending order; the module's answers must not depend on the order (the
// same bytes again in a second shuffled order).
//
//   node test/conformance.e2e.mjs [--sets N] [--seed S] [--report-only] [--json FILE] [--reproduce FILE]
//
// --reproduce FILE: the run must equal a stored summary (FILE, as --json writes it) in every statistic, digest and
// acceptance flag (the oracle's name aside); the exit code is that comparison's (a tree moved or rebuilt reproduces
// the stored run bit for bit), and the stored run's own acceptance is printed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { openModule, THEORY } from "./lib/module.mjs";
import { openReference } from "./lib/oracle.mjs";
import { elementsOf, tleLines } from "./lib/tle.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const XP_SETS = Number(arg("--sets", 10200));
const SGP4_SETS = Number(arg("--control", 1200));
const SEED = Number(arg("--seed", 20261023));
const REPORT_ONLY = process.argv.includes("--report-only");
const JSON_OUT = arg("--json", null);
const REPRODUCE = arg("--reproduce", null);
const WORST = Number(arg("--worst", 0));  // print the N largest position differences per regime
const SPAN_MIN = 7 * 1440;
const TIMES = 8;

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const r = random(SEED);
const between = (a, b) => a + (b - a) * r();

// Mean motion (rev/day), eccentricity, inclination (deg) of each regime.
const REGIMES = {
  LEO: () => {
    const mm = between(14.8, 16.2);
    return { mm, ecc: between(0, mm > 15.8 ? 0.002 : 0.02), inc: between(20, 90) };
  },
  SSO: () => ({ mm: between(14.2, 15.4), ecc: between(0, 0.005), inc: between(96.5, 99.5) }),
  MEO: () => ({ mm: between(1.7, 6.5), ecc: between(0, 0.02), inc: between(0, 70) }),
  GEO: () => ({ mm: between(0.99, 1.01), ecc: between(0, 0.003), inc: between(0, 15) }),
  HEO: () => (r() < 0.5
    ? { mm: between(1.95, 2.05), ecc: between(0.6, 0.75), inc: between(62, 65) }
    : { mm: between(2.2, 2.4), ecc: between(0.70, 0.73), inc: between(5, 30) }),
  VDS: () => ({ mm: between(0.07, 0.9), ecc: between(0.1, 0.8), inc: between(0, 90) }),
};
const NAMES = Object.keys(REGIMES);

function corpus(count, type, firstSatnum) {
  const sets = [];
  for (let i = 0; i < count; i += 1) {
    const regime = NAMES[i % NAMES.length];
    const { mm, ecc, inc } = REGIMES[regime]();
    const low = regime === "LEO" || regime === "SSO";
    const lines = tleLines({
      satnum: firstSatnum + i, year: 26, day: between(280, 296), type,
      bstar: type === 0 ? (low ? between(1e-5, 5e-4) : between(0, 1e-5)) : 0,
      bterm: type === 4 ? (low ? between(0.002, 0.05) : between(0.001, 0.02)) : 0,
      agom: type === 4 ? between(0.001, 0.05) : 0,
      inc, raan: between(0, 360), ecc, argp: between(0, 360), ma: between(0, 360), mm, rev: 0,
    });
    const minutes = [0, SPAN_MIN];
    while (minutes.length < TIMES) minutes.push(Math.round(between(0, SPAN_MIN) * 1e3) / 1e3);
    minutes.sort((a, b) => a - b);
    sets.push({ regime, type, lines, minutes });
  }
  return sets;
}

function median(values) {
  if (!values.length) return NaN;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function shuffled(n) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

async function measure(label, sets, oracle, module, inherent = false) {
  // Oracle: each set alone, its times ascending.
  const started = performance.now();
  const reference = [];
  for (const s of sets) reference.push(await oracle.propagate(s.lines, s.minutes));
  const oracleMs = performance.now() - started;

  // Module: all sets at once, time index by time index, in a shuffled order, twice.
  const accepted = sets.map((s, i) => reference[i] !== null);
  module.init(sets.map((s) => elementsOf(s.lines)));
  const answers = [[], []];
  for (const pass of [0, 1]) {
    for (const k of shuffled(TIMES)) {
      const p = module.atMinutes(sets.map((s) => s.minutes[k]));
      answers[pass][k] = p;
    }
  }
  // SHA-256 of every module output (planes and status, time index by time index): the bit-identity check.
  const hash = createHash("sha256");
  for (let k = 0; k < TIMES; k += 1) {
    for (const plane of ["x", "y", "z", "vx", "vy", "vz"]) hash.update(new Uint8Array(answers[0][k][plane].buffer.slice(0)));
    hash.update(new Uint8Array(answers[0][k].status.buffer.slice(0)));
  }
  const digest = hash.digest("hex");
  let orderDependent = 0;
  for (let k = 0; k < TIMES; k += 1) {
    for (const plane of ["x", "y", "z", "vx", "vy", "vz"]) {
      const a = answers[0][k][plane], b = answers[1][k][plane];
      for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) orderDependent += 1;
    }
  }

  // Inherent classes (XP corpus): the shadow envelope (near-limit decisions both ways), the drag-free run, refusals.
  let envA = null, envB = null, dragFree = null;
  if (inherent) {
    envA = []; envB = []; dragFree = [];
    for (const [policy, store] of [[1, envA], [2, envB]]) {
      module.x.sdnap_shadow_policy(policy);
      for (let k = 0; k < TIMES; k += 1) store[k] = module.atMinutes(sets.map((s) => s.minutes[k]));
    }
    module.x.sdnap_shadow_policy(0);
    module.init(sets.map((s) => ({ ...elementsOf(s.lines), bterm: 0 })));
    for (let k = 0; k < TIMES; k += 1) dragFree[k] = module.atMinutes(sets.map((s) => s.minutes[k]));
    module.init(sets.map((s) => elementsOf(s.lines)));
  }
  const decaySets = new Set();
  if (inherent) sets.forEach((s, i) => {
    let refused = false, heavy = false;
    for (let k = 0; k < TIMES; k += 1) {
      if (!reference[i] || !reference[i][k] || answers[0][k].status[i] !== 0) refused = true;
      else if (dragFree[k].status[i] === 0 &&
        Math.hypot(answers[0][k].x[i] - dragFree[k].x[i], answers[0][k].y[i] - dragFree[k].y[i], answers[0][k].z[i] - dragFree[k].z[i]) > 1000) heavy = true;
    }
    if (refused || heavy) decaySets.add(i);
  });
  const failedSets = {};
  const perRegime = Object.fromEntries(NAMES.map((n) => [n, { sets: 0, samples: 0, refused: 0, oracleErrors: 0, moduleErrors: 0, dr: [], dv: [], scoredDr: [], acceptedDecay: 0, acceptedShadow: 0, failed: 0 }]));
  sets.forEach((s, i) => {
    const row = perRegime[s.regime];
    if (!accepted[i]) { row.refused += 1; return; }
    row.sets += 1;
    for (let k = 0; k < TIMES; k += 1) {
      const ref = reference[i][k];
      const p = answers[0][k];
      if (!ref) { row.oracleErrors += 1; continue; }
      if (p.status[i] !== 0) {
        row.moduleErrors += 1;
        if (WORST) console.log(`  module error ${s.regime} set ${i} t ${s.minutes[k]} min status ${p.status[i]}: ${s.lines[1].slice(8, 69)}`);
        continue;
      }
      row.samples += 1;
      row.dr.push(1000 * Math.hypot(p.x[i] - ref.r[0], p.y[i] - ref.r[1], p.z[i] - ref.r[2]));
      if (inherent) {
        const d = row.dr[row.dr.length - 1];
        let ok = d <= 1.0;
        if (!ok && decaySets.has(i) && dragFree[k].status[i] === 0) {
          const disp = 1000 * Math.hypot(p.x[i] - dragFree[k].x[i], p.y[i] - dragFree[k].y[i], p.z[i] - dragFree[k].z[i]);
          if (d <= 1e-4 * disp) { ok = true; row.acceptedDecay += 1; }
        }
        if (!ok && envA[k].status[i] === 0 && envB[k].status[i] === 0) {
          const a = [envA[k].x[i], envA[k].y[i], envA[k].z[i]], b = [envB[k].x[i], envB[k].y[i], envB[k].z[i]];
          const width = 1000 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          const inside = [0, 1, 2].every((c) => ref.r[c] >= Math.min(a[c], b[c]) - 1e-3 && ref.r[c] <= Math.max(a[c], b[c]) + 1e-3);
          if (width > 0 && inside) { ok = true; row.acceptedShadow += 1; }
        }
        if (!ok) {
          row.failed += 1;
          row.scoredDr.push(d);
          const f = (failedSets[i] ??= { set: i, regime: s.regime, samples: 0, maxDrM: 0, atMin: 0, lines: s.lines });
          f.samples += 1;
          if (d > f.maxDrM) { f.maxDrM = d; f.atMin = s.minutes[k]; }
        }
      }
      if (WORST) (row.worst ??= []).push({ dr: row.dr[row.dr.length - 1], i, t: s.minutes[k], el: s.lines[1].slice(8, 69), b: s.lines[0].slice(53, 61) });
      row.dv.push(1000 * Math.hypot(p.vx[i] - ref.v[0], p.vy[i] - ref.v[1], p.vz[i] - ref.v[2]));
    }
  });
  const table = NAMES.map((name) => {
    const row = perRegime[name];
    const maxDr = row.dr.reduce((a, b) => Math.max(a, b), 0);
    const maxDv = row.dv.reduce((a, b) => Math.max(a, b), 0);
    return { regime: name, sets: row.sets, samples: row.samples, refused: row.refused, oracleErrors: row.oracleErrors,
      moduleErrors: row.moduleErrors, maxM: maxDr, medianM: median(row.dr), maxMmPerS: maxDv, medianMmPerS: median(row.dv),
      ...(inherent ? { acceptedDecay: row.acceptedDecay, acceptedShadow: row.acceptedShadow, failed: row.failed,
        maxFailedM: row.scoredDr.reduce((a, b) => Math.max(a, b), 0) } : {}) };
  });
  if (WORST) for (const name of NAMES) for (const w of (perRegime[name].worst ?? []).sort((a, b) => b.dr - a.dr).slice(0, WORST))
    console.log(`  worst ${name} ${w.dr.toExponential(3)} m set ${w.i} t ${w.t} min | ${w.el} | ${w.b}`);
  const all = NAMES.flatMap((n) => perRegime[n].dr);
  const overall = { sets: table.reduce((a, t) => a + t.sets, 0), samples: all.length, maxM: all.reduce((a, b) => Math.max(a, b), 0), medianM: median(all) };
  // Decay: both refusal epochs, bisected to 1 minute, within 1 % of the elapsed lifetime.
  let refusalChecks = null;
  if (inherent) {
    refusalChecks = { sets: 0, agree: 0, worst: null, disagree: [] };
    // one set at a time (the corpus answers are already taken)
    const moduleAlive = (i, t) => module.atMinutes([t]).status[0] === 0;
    for (const i of decaySets) {
      const s = sets[i];
      module.init([elementsOf(s.lines)]);
      const oracleAlive = async (t) => { const r = await oracle.propagate(s.lines, [t]); return !!(r && r[0]); };
      const endM = moduleAlive(i, SPAN_MIN), endO = await oracleAlive(SPAN_MIN);
      if (endM && endO) continue;
      const bisect = async (alive) => { let lo = 0, hi = SPAN_MIN; while (hi - lo > 1) { const mid = (lo + hi) / 2; if (await alive(mid)) lo = mid; else hi = mid; } return hi; };
      const tM = endM ? Infinity : await bisect(async (t) => moduleAlive(i, t));
      const tO = endO ? Infinity : await bisect(oracleAlive);
      const lifetime = Math.min(tM, tO);
      const agree = Number.isFinite(tM) && Number.isFinite(tO) ? Math.abs(tM - tO) <= 0.01 * lifetime : lifetime >= 0.99 * SPAN_MIN;
      refusalChecks.sets += 1;
      if (agree) refusalChecks.agree += 1;
      else {
        refusalChecks.disagree.push({ set: i, module: tM, oracle: tO, lines: s.lines });
        if (!refusalChecks.worst || Math.abs(tM - tO) > Math.abs(refusalChecks.worst.module - refusalChecks.worst.oracle)) refusalChecks.worst = { set: i, module: tM, oracle: tO };
      }
    }
  }
  const failedAll = NAMES.flatMap((n) => perRegime[n].scoredDr);
  // the sets with samples over 1 m outside every inherent class, worst first, with their element sets
  const failed = Object.values(failedSets).sort((a, b) => b.maxDrM - a.maxDrM);
  if (inherent) overall.maxFailedM = failedAll.reduce((a, b) => Math.max(a, b), 0);
  return { label, table, overall, orderDependent, digest, oracleMs: Math.round(oracleMs), decaySets: decaySets.size, refusalChecks, failedSets: inherent ? failed : undefined };
}

function print(result) {
  console.log(`\n${result.label}: ${result.overall.sets} sets, ${result.overall.samples} samples; order-dependent values ${result.orderDependent}; outputs sha256 ${result.digest}`);
  console.log("regime  sets   samples  refused  oracle-err  module-err  max dr (m)     median dr (m)  max dv (mm/s)");
  for (const t of result.table) {
    console.log(`${t.regime.padEnd(6)} ${String(t.sets).padStart(5)} ${String(t.samples).padStart(9)} ${String(t.refused).padStart(8)} ${String(t.oracleErrors).padStart(11)} ${String(t.moduleErrors).padStart(11)}  ${t.maxM.toExponential(3).padStart(12)}  ${t.medianM.toExponential(3).padStart(12)}  ${t.maxMmPerS.toExponential(3).padStart(12)}`);
  }
  console.log(`all    max ${result.overall.maxM.toExponential(3)} m, median ${result.overall.medianM.toExponential(3)} m`);
}

const oracle = await openReference();
const module = await openModule();
console.log(`oracle: ${oracle.name}; corpus seed ${SEED}; ${TIMES} times per set over 7 days`);

const control = await measure("SGP4 (type 0) public base vs oracle", corpus(SGP4_SETS, 0, 10000), oracle, module);
print(control);
const xp = await measure("SGP4XP (type 4) vs oracle", corpus(XP_SETS, 4, 40000), oracle, module, true);
print(xp);
console.log("inherent classes: regime accepted-decay accepted-shadow failed max-failed (m)");
for (const t of xp.table) console.log(`  ${t.regime.padEnd(5)} ${String(t.acceptedDecay).padStart(6)} ${String(t.acceptedShadow).padStart(6)} ${String(t.failed).padStart(6)}  ${t.maxFailedM.toExponential(3)}`);
console.log(`decay sets ${xp.decaySets}; refusal epochs within 1 %: ${xp.refusalChecks.agree}/${xp.refusalChecks.sets}${xp.refusalChecks.worst ? ` (worst set ${xp.refusalChecks.worst.set}: module ${xp.refusalChecks.worst.module} min, oracle ${xp.refusalChecks.worst.oracle} min)` : ""}`);

// Equator node: argp = 0 sets whose central drag node lies on the equator (perigee 200-250 km, the seasonal term
// applies); where the module and the oracle differ at one day, the hemisphere flipped at the node must reproduce it.
const equator = [];
for (const [year, day] of [[9, 120.5], [14, 120.5], [19, 340.5], [24, 100.5], [26, 290.5]])
  for (const [ecc, inc, raan] of [[0.01, 51.6, 40], [0.05, 97.5, 10], [0.05, 97.5, 220], [0.1, 63.4, 10], [0.0001, 51.6, 10]])
    for (const hp of [200, 250]) {
      const a = (6378.135 + hp) / (1 - ecc);
      const mm = 1440 / (2 * Math.PI * Math.sqrt(a * a * a / 398600.8) / 60);
      equator.push({ lines: tleLines({ satnum: 70000 + equator.length, year, day, type: 4, bterm: 0.01, agom: 0, inc, raan, ecc, argp: 0, ma: 0, mm }), minutes: [1440] });
    }
const eqRef = [];
for (const s of equator) eqRef.push(await oracle.propagate(s.lines, s.minutes));
module.init(equator.map((s) => elementsOf(s.lines)));
const eqDr = (p) => equator.map((s, i) => (eqRef[i] && eqRef[i][0] && p.status[i] === 0 ? 1000 * Math.hypot(p.x[i] - eqRef[i][0].r[0], p.y[i] - eqRef[i][0].r[1], p.z[i] - eqRef[i][0].r[2]) : NaN));
const eqPlain = eqDr(module.atMinutes(equator.map(() => 1440)));
module.x.sdnap_hemisphere_flip(1);
module.init(equator.map((s) => elementsOf(s.lines)));
const eqFlip = eqDr(module.atMinutes(equator.map(() => 1440)));
module.x.sdnap_hemisphere_flip(0);
const eqCases = eqPlain.map((d, i) => ({ d, f: eqFlip[i] })).filter((c) => Number.isFinite(c.d));
const eqDiffer = eqCases.filter((c) => c.d > 1.0);
const eqFixed = eqDiffer.filter((c) => c.f <= 1.0);
console.log(`equator node: ${eqCases.length} cases, ${eqCases.length - eqDiffer.length} within 1 m as computed, ${eqFixed.length} of the other ${eqDiffer.length} within 1 m with the hemisphere flipped`);

// SPEC 6.4: the classes' G_lpq are the Maclaurin polynomials (to e^26 / e^27) of the Hansen
// coefficients: within 1e-12 of the exact functions (numerical Hansen integral) at e = 0.1, 0.2,
// where truncation is below rounding.
const hansenSource = fs.readFileSync(new URL("../src/xp_hansen_series.inc", import.meta.url), "utf8");
const hansenRows = [...hansenSource.matchAll(/\{(\d), (\d), (-?\d+), \d+, \d+, \{/g)].map((x) => [+x[1], +x[2], +x[3]]);
let hansenWorst = 0;
for (const e of [0.1, 0.2]) for (const [l, p, q] of hansenRows) hansenWorst = Math.max(hansenWorst, Math.abs(module.hansen(l, p, q, e, 1) - module.hansen(l, p, q, e, 0)));
console.log(`\nSPEC 6 eccentricity series: ${hansenRows.length} G_lpq, max |series - exact| ${hansenWorst.toExponential(2)} at e <= 0.2`);

const acceptance = {
  xpSets: xp.overall.sets >= 10000,
  xpMaxNonInherent: xp.overall.maxFailedM <= 1.0,
  decayRefusals: xp.refusalChecks.agree === xp.refusalChecks.sets,
  equatorNode: eqFixed.length === eqDiffer.length,
  xpMedian: xp.overall.medianM <= 0.01,
  orderIndependent: xp.orderDependent === 0 && control.orderDependent === 0,
  spec6Eccentricity: hansenRows.length === 56 && hansenWorst <= 1e-12,
};
const pass = Object.values(acceptance).every(Boolean);
const summary = { task: "modules-sdn-gp-propagator-20261023", oracle: oracle.name, seed: SEED, control, xp,
  equatorNode: { cases: eqCases.length, differ: eqDiffer.length, fixedByFlip: eqFixed.length }, spec6Eccentricity: { terms: hansenRows.length, maxSeriesMinusExact: hansenWorst }, acceptance, pass };
// Full-precision statistics are kept (exactMaxM, exactMedianM) so that a change can be held to a stated bound.
for (const result of [control, xp]) for (const t of result.table) { t.exactMaxM = t.maxM; t.exactMedianM = t.medianM; t.maxM = +t.maxM.toPrecision(4); t.medianM = +t.medianM.toPrecision(4); t.maxMmPerS = +t.maxMmPerS.toPrecision(4); t.medianMmPerS = +t.medianMmPerS.toPrecision(4); }
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 1)}\n`);
console.log(`\nacceptance ${JSON.stringify(acceptance)} -> ${pass ? "PASS" : "FAIL"}`);
let reproduced = null;
if (REPRODUCE) {
  const stored = JSON.parse(fs.readFileSync(REPRODUCE, "utf8"));
  // every statistic, digest and flag; not the oracle's wall-clock time
  const comparable = (x) => JSON.stringify(x, (k, v) => (k === "oracleMs" ? undefined : v));
  const fields = ["seed", "control", "xp", "equatorNode", "spec6Eccentricity", "acceptance", "pass"];
  const differing = fields.filter((f) => comparable({ v: summary[f] }) !== comparable({ v: stored[f] }));
  reproduced = differing.length === 0;
  console.log(`reproduces ${REPRODUCE}: ${reproduced ? "identical (XP digest " + summary.xp.digest.slice(0, 12) + ", control " + summary.control.digest.slice(0, 12) + ")" : "differs in " + differing.join(", ")}; the stored run: ${stored.pass ? "PASS" : "FAIL"}`);
}
module.destroy();
await oracle.close();
process.exit(REPRODUCE ? (reproduced ? 0 : 1) : pass || REPORT_ONLY ? 0 : 1);
