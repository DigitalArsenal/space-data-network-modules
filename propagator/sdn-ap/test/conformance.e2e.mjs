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
//   evaluation (every one a sunlit arc, every one wholly sunlit; each run on
//   fresh nodes, so that the setting reaches every node and stage), give
//   different states, the oracle must fall between them (in each coordinate,
//   1 m margin) or, where the decisions go in mixed directions (amendment 6:
//   both outcomes of each conform), within the two runs' spread of the
//   module's answer;
// - reference split: a sample the classes above leave open is accepted when
//   the reference's other build (SDN_AP_ORACLE_SECOND, default 9.1.1.0, black
//   box) is within 1 m of the module: the two builds of the one library take a
//   decision differently, so the decision rests on rounding;
// - equator node: in a deterministic corpus of argp = 0 sets the hemisphere
//   flipped at the node must reproduce the oracle where the unflipped one does
//   not.
// A control corpus of SGP4 (type 0) sets checks the public base against the
// same library.
// Perigee passages (stack #550): the corpus's 8 random times per set land in a
// window of a few milliseconds at a perigee passage only by chance. A fixed set
// of type-4 records across the eccentric regime (e 0.02 to 0.9, several mean
// motions, the 4:1 record of SGP4-XP's 72 h fit of synthetic case
// grid-hp2000-e0.5-i70 among them) is flown on both sides every 1 ms for 3 s
// either side of each record's first perigee passages, five for the records at
// e 0.5 and above (where a passage can be clean and a later one not: e 0.82
// departs at one passage of five) and two for the rest (the reference's own
// radius minima on a 10 s flight, refined by a parabola), and every sample is
// held to conformance's 1 m (acceptance perigeePassages). Its result is kept
// apart from the corpus's digests. Why 3 s either side holds the window: it lies
// where the osculating and the mean anomaly straddle 0, that is within the
// anomaly's short-period correction divided by the mean motion at the passage,
// milliseconds on these records; the largest offset seen from the passage is
// -549 ms, on the 4:1 record. --perigee-only runs this part alone; --corpus-only leaves it out, for a change that cannot
// reach SGP4XP's output solve (section 8), and says so in its output and its --json summary.
//
// The module is asked for the times in a shuffled order, the oracle in
// ascending order; the module's answers must not depend on the order (the
// same bytes again in a second shuffled order).
//
//   node test/conformance.e2e.mjs [--sets N] [--seed S] [--report-only] [--json FILE] [--reproduce FILE] [--digest-only] [--perigee-only | --corpus-only]
//
// --reproduce FILE: the run must equal a stored summary (FILE, as --json writes it) in every statistic, digest and
// acceptance flag (the oracle's name aside); the exit code is that comparison's (a tree moved or rebuilt reproduces
// the stored run bit for bit), and the stored run's own acceptance is printed.
// --digest-only: the module's side of that comparison without the oracle: the SGP4XP corpus's and the SGP4 control's
// output digests and order independence must equal the stored run's (FILE, default test/results/conformance.json).
// The stored run (2026-10-25) is XP digest 72dcf6005046; builds 0.6.5 to 0.6.7 gave 34cc810d5d99 (SPEC 16.8).
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
const DIGEST_ONLY = process.argv.includes("--digest-only");
const PERIGEE_ONLY = process.argv.includes("--perigee-only");
const CORPUS_ONLY = process.argv.includes("--corpus-only");
if (PERIGEE_ONLY && CORPUS_ONLY) throw new Error("--perigee-only and --corpus-only are each other's opposite");
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

// The perigee-passage records (stack #550): mean motion (rev/day), eccentricity, inclination, node, argument of perigee
// and mean anomaly (deg), BTERM and AGOM (m^2/kg), all at epoch 2026 day 72.0; passages, the perigee passages flown (2 unless
// stated).
const PERIGEE_RECORDS = [
  { name: "e 0.02, 14 rev/day", mm: 14.0, ecc: 0.02, inc: 98.0, raan: 40, argp: 120, ma: 10, bterm: 0.01, agom: 0.01 },
  { name: "e 0.05, 14 rev/day", mm: 14.0, ecc: 0.05, inc: 63.4, raan: 80, argp: 270, ma: 200, bterm: 0.005, agom: 0.01 },
  { name: "e 0.1, 8 rev/day", mm: 8.0, ecc: 0.1, inc: 55.0, raan: 120, argp: 30, ma: 300, bterm: 0.005, agom: 0.01 },
  { name: "e 0.3, 6 rev/day", mm: 6.0, ecc: 0.3, inc: 30.0, raan: 160, argp: 60, ma: 90, bterm: 0.005, agom: 0.01 },
  { name: "e 0.3, 1 rev/day", mm: 1.0027, ecc: 0.3, inc: 30.0, raan: 200, argp: 150, ma: 45, bterm: 0.002, agom: 0.01 },
  { name: "e 0.5, 4 rev/day (the 4:1 record)", mm: 4.0025623, ecc: 0.4999943, inc: 70.0003, raan: 199.9006, argp: 225.8973, ma: 75.3961, bterm: 0.010109, agom: 0.019276, passages: 5 },
  { name: "e 0.74, 2 rev/day (Molniya-like)", mm: 2.0055, ecc: 0.74, inc: 63.4, raan: 240, argp: 270, ma: 180, bterm: 0.002, agom: 0.01, passages: 5 },
  { name: "e 0.73, 2.25 rev/day (transfer-like)", mm: 2.25, ecc: 0.73, inc: 27.0, raan: 280, argp: 180, ma: 0, bterm: 0.005, agom: 0.01, passages: 5 },
  { name: "e 0.82, 1 rev/day", mm: 1.0027, ecc: 0.82, inc: 10.0, raan: 320, argp: 0, ma: 270, bterm: 0.002, agom: 0.01, passages: 5 },
  { name: "e 0.9, 0.5 rev/day", mm: 0.5, ecc: 0.9, inc: 37.0, raan: 10, argp: 90, ma: 120, bterm: 0.002, agom: 0.01, passages: 5 },
];
// five passages for the five records at e 0.5 and above (the 4:1 record's e is 0.4999943), two for the rest
const PERIGEE_HALF_MS = 3000, passagesOf = (x) => x.passages ?? 2;

/** Each record's first passagesOf(record) perigee passages, both sides every 1 ms for 3 s either side; samples over 1 m listed. */
async function perigeePassages(oracle, module) {
  const started = performance.now();
  const records = [];
  for (const [k, x] of PERIGEE_RECORDS.entries()) {
    const lines = tleLines({ satnum: 99400 + k, year: 26, day: 72, type: 4, bterm: x.bterm, agom: x.agom, inc: x.inc, raan: x.raan, ecc: x.ecc, argp: x.argp, ma: x.ma, mm: x.mm, rev: 0 });
    const periodMin = 1440 / x.mm, PERIGEE_PASSAGES = passagesOf(x);
    const coarse = Array.from({ length: Math.ceil(((PERIGEE_PASSAGES + 0.5) * periodMin * 60) / 10) }, (_, j) => (j * 10) / 60);
    const cs = await oracle.propagate(lines, coarse);
    const r = cs ? cs.map((s) => (s ? Math.hypot(...s.r) : NaN)) : [];
    const passages = [];
    for (let j = 1; j + 1 < r.length && passages.length < PERIGEE_PASSAGES; j += 1) {
      if (!(r[j] < r[j - 1] && r[j] <= r[j + 1])) continue;
      const den = r[j - 1] - 2 * r[j] + r[j + 1];
      passages.push(coarse[j] + (den > 0 ? ((10 / 60) * (r[j - 1] - r[j + 1])) / (2 * den) : 0));
    }
    module.init([elementsOf(lines)]);
    const rows = [];
    for (const tp of passages) {
      const minutes = Array.from({ length: 2 * PERIGEE_HALF_MS + 1 }, (_, j) => tp + (j - PERIGEE_HALF_MS) / 60000);
      const ref = await oracle.propagate(lines, minutes);
      const over = [];
      let maxM = 0, missing = 0;
      for (const [j, m] of minutes.entries()) {
        const p = module.atMinutes([m]);
        if (!ref || !ref[j] || p.status[0] !== 0) { missing += 1; continue; }
        const d = 1000 * Math.hypot(p.x[0] - ref[j].r[0], p.y[0] - ref[j].r[1], p.z[0] - ref[j].r[2]);
        if (d > maxM) maxM = d;
        if (d > 1.0) over.push({ ms: j - PERIGEE_HALF_MS, m: +d.toPrecision(6) });
      }
      rows.push({ passageMin: +tp.toFixed(6), samples: minutes.length - missing, missing, maxM, over });
    }
    records.push({ name: x.name, lines, passages: rows });
  }
  const all = records.flatMap((x) => x.passages);
  return { records, passages: all.length, samples: all.reduce((s, x) => s + x.samples, 0), missing: all.reduce((s, x) => s + x.missing, 0),
    overOneMeter: all.reduce((s, x) => s + x.over.length, 0), maxM: Math.max(0, ...all.map((x) => x.maxM)), ms: Math.round(performance.now() - started) };
}

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

// Module: all sets at once, time index by time index, in a shuffled order, twice; the SHA-256 of every output of the
// first pass (planes and status, time index by time index: the bit-identity check) and the values the order changed.
function flyModule(sets, module) {
  module.init(sets.map((s) => elementsOf(s.lines)));
  const answers = [[], []];
  for (const pass of [0, 1]) {
    for (const k of shuffled(TIMES)) {
      const p = module.atMinutes(sets.map((s) => s.minutes[k]));
      answers[pass][k] = p;
    }
  }
  const hash = createHash("sha256");
  for (let k = 0; k < TIMES; k += 1) {
    for (const plane of ["x", "y", "z", "vx", "vy", "vz"]) hash.update(new Uint8Array(answers[0][k][plane].buffer.slice(0)));
    hash.update(new Uint8Array(answers[0][k].status.buffer.slice(0)));
  }
  let orderDependent = 0;
  for (let k = 0; k < TIMES; k += 1) {
    for (const plane of ["x", "y", "z", "vx", "vy", "vz"]) {
      const a = answers[0][k][plane], b = answers[1][k][plane];
      for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) orderDependent += 1;
    }
  }
  return { answers, digest: hash.digest("hex"), orderDependent };
}

async function measure(label, sets, oracle, module, inherent = false, second = null) {
  // Oracle: each set alone, its times ascending.
  const started = performance.now();
  const reference = [];
  for (const s of sets) reference.push(await oracle.propagate(s.lines, s.minutes));
  const oracleMs = performance.now() - started;

  const accepted = sets.map((s, i) => reference[i] !== null);
  const { answers, digest, orderDependent } = flyModule(sets, module);

  // Inherent classes (XP corpus): the shadow envelope (near-limit decisions both ways), the drag-free run, refusals.
  let envA = null, envB = null, dragFree = null;
  if (inherent) {
    envA = []; envB = []; dragFree = [];
    for (const [policy, store] of [[1, envA], [2, envB]]) {
      module.x.sdnap_shadow_policy(policy);
      // fresh nodes: the nominal run's cached nodes would carry policy 0's decisions into this run
      module.init(sets.map((s) => elementsOf(s.lines)));
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
  // the class of a scored sample over 1 m (d, m from the oracle): "decay", "shadow" or null
  const classOf = (i, k, d) => {
    const p = answers[0][k], ref = reference[i][k];
    if (decaySets.has(i) && dragFree[k].status[i] === 0) {
      const disp = 1000 * Math.hypot(p.x[i] - dragFree[k].x[i], p.y[i] - dragFree[k].y[i], p.z[i] - dragFree[k].z[i]);
      if (d <= 1e-4 * disp) return "decay";
    }
    if (envA[k].status[i] === 0 && envB[k].status[i] === 0) {
      const a = [envA[k].x[i], envA[k].y[i], envA[k].z[i]], b = [envB[k].x[i], envB[k].y[i], envB[k].z[i]];
      const width = 1000 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const inside = [0, 1, 2].every((c) => ref.r[c] >= Math.min(a[c], b[c]) - 1e-3 && ref.r[c] <= Math.max(a[c], b[c]) + 1e-3);
      if (width > 0 && (inside || d <= width)) return "shadow";
    }
    return null;
  };
  const drOf = (i, k, r) => 1000 * Math.hypot(answers[0][k].x[i] - r[0], answers[0][k].y[i] - r[1], answers[0][k].z[i] - r[2]);
  const scored = (i, k) => accepted[i] && reference[i][k] && answers[0][k].status[i] === 0;
  // reference split: the other build, asked only for the sets with a sample the classes above leave open
  const otherBuild = new Map();
  if (inherent && second) {
    for (const [i, s] of sets.entries()) {
      let open = false;
      for (let k = 0; k < TIMES && !open; k += 1) if (scored(i, k)) { const d = drOf(i, k, reference[i][k].r); open = d > 1.0 && !classOf(i, k, d); }
      if (open) otherBuild.set(i, await second.propagate(s.lines, s.minutes));
    }
  }
  const failedSets = {};
  const perRegime = Object.fromEntries(NAMES.map((n) => [n, { sets: 0, samples: 0, refused: 0, oracleErrors: 0, moduleErrors: 0, dr: [], dv: [], scoredDr: [], acceptedDecay: 0, acceptedShadow: 0, acceptedSplit: 0, failed: 0 }]));
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
        if (!ok) {
          const cls = classOf(i, k, d);
          if (cls === "decay") { ok = true; row.acceptedDecay += 1; }
          else if (cls === "shadow") { ok = true; row.acceptedShadow += 1; }
          else {
            const other = otherBuild.get(i);
            if (other && other[k] && drOf(i, k, other[k].r) <= 1.0) { ok = true; row.acceptedSplit += 1; }
          }
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
      ...(inherent ? { acceptedDecay: row.acceptedDecay, acceptedShadow: row.acceptedShadow, acceptedSplit: row.acceptedSplit, failed: row.failed,
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

if (DIGEST_ONLY) {
  // The module's side of --reproduce alone, no oracle: the same corpora in the same order, the SGP4 control's and the
  // SGP4XP corpus's output digests and order independence against the stored run.
  const stored = JSON.parse(fs.readFileSync(REPRODUCE ?? new URL("./results/conformance.json", import.meta.url), "utf8"));
  const module = await openModule();
  const control = flyModule(corpus(SGP4_SETS, 0, 10000), module);
  const xp = flyModule(corpus(XP_SETS, 4, 40000), module);
  module.destroy();
  const same = control.digest === stored.control.digest && xp.digest === stored.xp.digest && control.orderDependent === 0 && xp.orderDependent === 0;
  console.log(`module outputs against ${REPRODUCE ?? "test/results/conformance.json"} (no oracle): XP ${xp.digest.slice(0, 12)} (stored ${stored.xp.digest.slice(0, 12)}), control ${control.digest.slice(0, 12)} (stored ${stored.control.digest.slice(0, 12)}), order-dependent values ${xp.orderDependent + control.orderDependent}: ${same ? "identical" : "DIFFERENT"}`);
  process.exit(same ? 0 : 1);
}

function printPerigee(perigee) {
  console.log(`\nperigee passages: ${PERIGEE_RECORDS.length} records, ${perigee.passages} passages, ${perigee.samples} samples at 1 ms (${perigee.missing} not served); over 1 m: ${perigee.overOneMeter}; max ${perigee.maxM.toExponential(3)} m; ${(perigee.ms / 1000).toFixed(1)} s`);
  for (const x of perigee.records) for (const [i, p] of x.passages.entries()) {
    const runs = [];
    for (const o of p.over) { const last = runs.at(-1); if (last && o.ms === last.to + 1) { last.to = o.ms; last.m = Math.max(last.m, o.m); } else runs.push({ from: o.ms, to: o.ms, m: o.m }); }
    console.log(`  ${x.name}, passage ${i + 1} (${p.passageMin.toFixed(4)} min): ${p.over.length ? `FAIL ${p.over.length} ms over 1 m: ${runs.map((w) => `${w.from} to ${w.to} ms up to ${w.m.toExponential(3)} m`).join("; ")}` : `max ${p.maxM.toExponential(3)} m`}`);
  }
}

if (PERIGEE_ONLY) {
  // the perigee-passage part alone, against the oracle
  const oracle = await openReference(), module = await openModule();
  console.log(`oracle: ${oracle.name}; the perigee-passage part alone`);
  const perigee = await perigeePassages(oracle, module);
  printPerigee(perigee);
  const ok = perigee.missing === 0 && perigee.overOneMeter === 0;
  console.log(`\nacceptance ${JSON.stringify({ perigeePassages: ok })} -> ${ok ? "PASS" : "FAIL"}`);
  module.destroy();
  await oracle.close();
  process.exit(ok ? 0 : 1);
}

const oracle = await openReference();
const second = await openReference({ version: process.env.SDN_AP_ORACLE_SECOND || "9.1.1.0" });
const module = await openModule();
console.log(`oracle: ${oracle.name}; corpus seed ${SEED}; ${TIMES} times per set over 7 days; reference split against ${second.version}`);

const control = await measure("SGP4 (type 0) public base vs oracle", corpus(SGP4_SETS, 0, 10000), oracle, module);
print(control);
const xp = await measure("SGP4XP (type 4) vs oracle", corpus(XP_SETS, 4, 40000), oracle, module, true, second);
print(xp);
console.log("inherent classes: regime accepted-decay accepted-shadow accepted-split failed max-failed (m)");
for (const t of xp.table) console.log(`  ${t.regime.padEnd(5)} ${String(t.acceptedDecay).padStart(6)} ${String(t.acceptedShadow).padStart(6)} ${String(t.acceptedSplit).padStart(6)} ${String(t.failed).padStart(6)}  ${t.maxFailedM.toExponential(3)}`);
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

// Perigee passages (stack #550): every sample within 1 m of the oracle. --corpus-only leaves the part out (a change that cannot
// reach SGP4XP's output solve): the run then says so, and its pass is the corpus's alone.
const perigee = CORPUS_ONLY ? null : await perigeePassages(oracle, module);
if (perigee) printPerigee(perigee);
else console.log("\nperigee passages: not run (--corpus-only)");

const acceptance = {
  xpSets: xp.overall.sets >= 10000,
  xpMaxNonInherent: xp.overall.maxFailedM <= 1.0,
  decayRefusals: xp.refusalChecks.agree === xp.refusalChecks.sets,
  equatorNode: eqFixed.length === eqDiffer.length,
  xpMedian: xp.overall.medianM <= 0.01,
  orderIndependent: xp.orderDependent === 0 && control.orderDependent === 0,
  spec6Eccentricity: hansenRows.length === 56 && hansenWorst <= 1e-12,
};
// the perigee part's own flag, kept beside the corpus's so that a stored run of the corpus alone still compares
const perigeeAcceptance = perigee ? { perigeePassages: perigee.missing === 0 && perigee.overOneMeter === 0 } : { perigeePassages: "not run" };
const pass = Object.values(acceptance).every(Boolean) && (perigee ? perigeeAcceptance.perigeePassages : true);
const summary = { task: "sdn-ap-sgp4xp-conformance-tail-20261025", oracle: oracle.name, second: second.name, seed: SEED, control, xp,
  equatorNode: { cases: eqCases.length, differ: eqDiffer.length, fixedByFlip: eqFixed.length }, spec6Eccentricity: { terms: hansenRows.length, maxSeriesMinusExact: hansenWorst },
  perigeePassages: perigee ? { ...perigee, ms: undefined } : null, acceptance, perigeeAcceptance, pass, ...(CORPUS_ONLY ? { corpusOnly: true } : {}) };
// Full-precision statistics are kept (exactMaxM, exactMedianM) so that a change can be held to a stated bound.
for (const result of [control, xp]) for (const t of result.table) { t.exactMaxM = t.maxM; t.exactMedianM = t.medianM; t.maxM = +t.maxM.toPrecision(4); t.medianM = +t.medianM.toPrecision(4); t.maxMmPerS = +t.maxMmPerS.toPrecision(4); t.medianMmPerS = +t.medianMmPerS.toPrecision(4); }
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 1)}\n`);
console.log(`\nacceptance ${JSON.stringify({ ...acceptance, ...perigeeAcceptance })} -> ${pass ? "PASS" : "FAIL"}`);
let reproduced = null;
if (REPRODUCE) {
  const stored = JSON.parse(fs.readFileSync(REPRODUCE, "utf8"));
  // every statistic, digest and flag; not the oracle's wall-clock time (a stored run from before the perigee part is compared
  // on the corpus's fields alone)
  const comparable = (x) => JSON.stringify(x, (k, v) => (k === "oracleMs" ? undefined : v));
  const fields = ["seed", "control", "xp", "equatorNode", "spec6Eccentricity", "acceptance", ...(stored.perigeePassages && !CORPUS_ONLY ? ["perigeePassages", "perigeeAcceptance", "pass"] : [])];
  const differing = fields.filter((f) => comparable({ v: summary[f] }) !== comparable({ v: stored[f] }));
  reproduced = differing.length === 0;
  console.log(`reproduces ${REPRODUCE}: ${reproduced ? "identical (XP digest " + summary.xp.digest.slice(0, 12) + ", control " + summary.control.digest.slice(0, 12) + ")" : "differs in " + differing.join(", ")}; the stored run: ${stored.pass ? "PASS" : "FAIL"}`);
}
module.destroy();
await oracle.close();
await second.close();
process.exit(REPRODUCE ? (reproduced ? 0 : 1) : pass || REPORT_ONLY ? 0 : 1);
