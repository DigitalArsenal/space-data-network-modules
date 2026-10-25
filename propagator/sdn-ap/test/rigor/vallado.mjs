// David Vallado's questions (verification, frames, time, numerics, covariance): does the module reproduce the
// published verification set, rotate frames as an independent tool does, keep its time arguments straight, and
// behave as a numerical method should (path independence, conservation where conservative, convergence,
// deterministic bytes, a covariance that is a covariance)?
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openModule, THEORY } from "../lib/module.mjs";
import { FRAME_PROBE, jdOf, rotate } from "../lib/frames.mjs";
import { elementsOf, tleLines } from "../lib/tle.mjs";
import { againstReference, days, defineCheck, hypot3, moduleStates, NotMeasured, REVIEWERS } from "./lib/rigor.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const AIAA = JSON.parse(fs.readFileSync(here("./data/aiaa-2006-6753.json"), "utf8"));
const rowOf = (fields, theory) => ({ ...elementsOf(tleLines({ year: 26, day: 290.25, rev: 0, type: 4, bterm: 0.005, agom: 0.01, ...fields })), theory });
const CORPUS = [[15.5, 0.001, 51.6], [14.3, 0.002, 98.2], [12.5, 0.01, 70], [2.0056, 0.01, 55], [2.0059, 0.72, 63.4], [1.0027, 0.0003, 0.1], [0.5, 0.3, 30]];
const corpusRows = (theories) => theories.flatMap((theory) => CORPUS.flatMap(([mm, ecc, inc], k) => [0, 1, 2].map((j) =>
  rowOf({ mm, ecc, inc, raan: 40 + 97 * j + k, argp: 15 + 61 * j, ma: 33 * j + 7 * k, ...(theory === THEORY.SGP4 ? { type: 0, bstar: 1e-5 } : {}) }, theory))));

/** The times SGP4-VER.TLE asks of a set (the epoch, then start..stop by step, then stop), as the published run lists them. */
function requested({ start, stop, step }) {
  const out = [0];
  for (let t = start; t <= stop + 1e-9; t += step) if (Math.abs(t) > 1e-12) out.push(t);
  if (Math.abs(out.at(-1) - stop) > 1e-9) out.push(stop);
  return out;
}

export const checks = [
  defineCheck({
    id: "vallado-aiaa-2006-6753-verification", reviewer: REVIEWERS.VALLADO, tier: "fast",
    question: "Does the SGP4 base reproduce the published outputs of the 33 verification sets of AIAA 2006-6753 in the improved mode that produced them (1 mm, 1e-5 m/s, the same error stops), and does its AFSPC mode, the module's, give the operational reference's states and refusals on the same samples?",
    source: "Vallado, Crawford, Hujsak, Kelso (2006), AIAA 2006-6753, App. D: SGP4-VER.TLE and tcppver.out (data/aiaa-2006-6753.json; inputs and outputs only, no reference code read); USSF Sgp4Prop 9.9 as a black box; paper 1.1",
    async run(ctx) {
      // the published run's driver prints the previous set's last state when a set fails to initialize (33334's t = 0
      // equals 33333's last state): such a set is an error stop at the epoch, its listed state an artifact
      const stale = new Set(AIAA.sets.filter((s, k) => k > 0 && s.states.length === 1 && AIAA.sets[k - 1].states.length > 0
        && hypot3(s.states[0].r, AIAA.sets[k - 1].states.at(-1).r) === 0).map((s) => s.satnum));
      const cases = AIAA.sets.map((s) => {
        const want = requested(s.request);
        const listed = stale.has(s.satnum) ? [] : s.states.map((x) => x.t);
        const refusal = listed.length < want.length ? want[listed.length] : null;
        return { s, states: stale.has(s.satnum) ? [] : s.states, times: refusal === null ? listed : [...listed, refusal], refusal };
      });
      // improved mode: the base built natively (foundation/sgp4-str3, tests/states.cpp)
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "rigor-str3-"));
      let blocks;
      try {
        const driver = path.join(work, "states");
        try {
          execFileSync("clang++", ["-std=c++17", "-O2", `-I${here("../../../../foundation/sgp4-str3/include")}`, here("../../../../foundation/sgp4-str3/tests/states.cpp"), "-o", driver], { stdio: "pipe" });
        } catch { throw new NotMeasured("clang++ is absent: the improved-mode leg builds foundation/sgp4-str3 natively"); }
        const d = Math.PI / 180;
        const input = cases.map(({ s, times }) => { const e = elementsOf(s.lines);
          return [e.epochWhole + e.epochFrac - 2433281.5, (e.meanMotion * 2 * Math.PI) / 1440, e.ecc, e.inc * d, e.raan * d, e.argp * d, e.ma * d, e.bstar, times.length, ...times]
            .map((x) => (Number.isInteger(x) ? String(x) : x.toPrecision(17))).join(" "); });
        blocks = execFileSync(driver, { input: `${input.join("\n")}\n`, encoding: "utf8" }).split("X\n").slice(0, -1);
      } finally { fs.rmSync(work, { recursive: true, force: true }); }
      let worstR = { d: 0 }, worstV = { d: 0 }, missing = [], stopsHeld = 0, stopsMissed = [];
      cases.forEach(({ s, states, refusal }, k) => {
        const rows = blocks[k].trim() ? blocks[k].trim().split("\n").map((l) => l.split(" ").map(Number)) : [];
        states.forEach((ref, j) => {
          const [, status, ...rv] = rows[j];
          if (status !== 0) { missing.push(`${s.satnum} t=${ref.t}`); return; }
          const dr = hypot3(rv, ref.r) * 1e3, dv = hypot3(rv.slice(3), ref.v) * 1e3;
          if (dr > worstR.d) worstR = { d: dr, at: `${s.satnum} t=${ref.t}` };
          if (dv > worstV.d) worstV = { d: dv, at: `${s.satnum} t=${ref.t}` };
        });
        if (refusal !== null) { if (rows.at(-1)[1] !== 0) stopsHeld += 1; else stopsMissed.push(`${s.satnum} t=${refusal}`); }
      });
      const LIMIT_R = 1e-3, LIMIT_V = 1e-5;  // tcppver.out prints km to 1e-8 and km/s to 1e-9
      const improvedOk = missing.length === 0 && stopsMissed.length === 0 && worstR.d <= LIMIT_R && worstV.d <= LIMIT_V;
      // AFSPC mode (the module) against the operational reference on the same samples
      // The reference takes the epoch as one double Julian date (paper 1.1: its rounding is the residual on the resonant
      // sets), so its instant is off by up to half an ulp of that date (2^-32 day, 2.0e-5 s, near JD 2.45e6): a sample's
      // bound is 1e-6 m + |v| ulp(JD)/2. A published error stop (an AIAA 2006-6753 trap) where the module refuses and
      // the reference answers is the module keeping the documented trap (paper 1.1), not a disagreement.
      const module = await ctx.module();
      const refSets = cases.filter((c) => c.times.length).map((c) => ({ name: String(c.s.satnum), lines: c.s.lines, minutes: c.times, refusal: c.refusal }));
      const samples = await againstReference(ctx, refSets);
      const speeds = moduleStates(module, refSets.map((c) => ({ ...elementsOf(c.lines), theory: THEORY.SGP4 })), refSets.map((c) => c.minutes));
      const halfUlpS = (jd) => (2 ** (Math.floor(Math.log2(jd)) - 52) / 2) * 86400;
      let si = 0, trapped = 0;
      for (const [k, c] of refSets.entries()) {
        const e = elementsOf(c.lines);
        for (let j = 0; j < c.minutes.length; j += 1, si += 1) {
          const smp = samples[si], v = speeds[k][j];
          smp.limit = 1e-6 + (v.ok ? Math.hypot(...v.v) * 1e3 : 0) * halfUlpS(e.epochWhole + e.epochFrac);
          if (smp.onlyReference && c.minutes[j] === c.refusal) { smp.onlyReference = false; trapped += 1; }
        }
      }
      const both = samples.filter((x) => x.both);
      const over = both.filter((x) => !(x.dr <= x.limit));
      const oneSide = samples.filter((x) => x.onlyModule || x.onlyReference);
      const worst = both.reduce((w, x) => (x.dr > w.dr ? x : w), { dr: 0 });
      const median = both.map((x) => x.dr).sort((p, q) => p - q)[both.length >> 1];
      const afspc = { pass: over.length === 0 && oneSide.length === 0, evidence: [
        `AFSPC mode (the module) against the reference: ${samples.length} samples, ${both.length} answered by both, median ${median.toExponential(2)} m, worst ${worst.dr.toExponential(3)} m (set ${worst.set?.name} at ${worst.t} min, bound there ${worst.limit?.toExponential(2)} m); ${over.length} over 1e-6 m + |v| ulp(epoch JD)/2`,
        `published error stops where the module refuses and the reference answers (the AIAA 2006-6753 traps the module keeps): ${trapped}; other one-sided samples: ${oneSide.length}`,
        ...over.slice(0, 5).map((x) => `  over: ${x.set.name} t=${x.t} min ${x.dr.toExponential(3)} m, bound ${x.limit.toExponential(2)} m`),
        ...oneSide.slice(0, 5).map((x) => `  one side: ${x.set.name} t=${x.t} min (${x.onlyModule ? "module answers, reference refuses" : "reference answers, module refuses"})`)] };
      // AFSPC mode against the published outputs: reported (the improved mode produced them)
      const mine = moduleStates(module, cases.map((c) => ({ ...elementsOf(c.s.lines), theory: THEORY.SGP4 })), cases.map((c) => c.states.map((x) => x.t)));
      const departures = cases.map((c, k) => [c.s.satnum, Math.max(0, ...c.states.map((x, j) => (mine[k][j].ok ? hypot3(mine[k][j].r, x.r) * 1e3 : 0)))]).filter(([, dm]) => dm > 1e-3);
      return {
        pass: improvedOk && afspc.pass,
        evidence: [
          `${AIAA.sets.length} sets, ${AIAA.sets.reduce((a, s) => a + s.states.length, 0)} published states (tcppver.out sha256 ${AIAA.inputs["tcppver.out"].slice(0, 12)}); initialization error stops recognized by their stale printed state: ${[...stale].join(", ") || "none"}`,
          `improved mode against the published outputs: worst ${worstR.d.toExponential(3)} m (${worstR.at}), ${worstV.d.toExponential(3)} m/s (${worstV.at}); limits ${LIMIT_R} m, ${LIMIT_V} m/s; refused ${missing.length} published states${missing.length ? ` (${missing.join(", ")})` : ""}; error stops held ${stopsHeld}, missed ${stopsMissed.length}${stopsMissed.length ? ` (${stopsMissed.join(", ")})` : ""}`,
          ...afspc.evidence,
          `report only, AFSPC mode against the published outputs, sets over 1 mm: ${departures.map(([n, dm]) => `${n} ${dm.toExponential(2)} m`).join(", ") || "none"} (AFSPC holds the Lyddane node in [0, 2 pi), as the operational library does; paper 1.1)`,
        ],
      };
    },
  }),
  defineCheck({
    id: "vallado-teme-to-gcrf", reviewer: REVIEWERS.VALLADO, tier: "fast",
    question: "Is TEME rotated to GCRF as the published AIAA 2006-6753 example rotates it (within 1 cm), and how far is it from an independent pyerfa rotation of the verification epochs that defines TEME through GMST06?",
    source: "AIAA 2006-6753 sec. V TEME example (2004-04-06 07:51:28.386009 UTC); analysis/epoch-state/tests/vallado-verification.json (pyerfa 2.0.1.5 GCRF of the 33 sets at epoch)",
    async run(ctx) {
      const module = await ctx.module();
      const evidence = [];
      const example = rotate(module, ...Object.values(jdOf("2004-04-06T07:51:28.386009")), [5094.18016210, 6127.64465950, 6380.34453270, -4.746131487, 0.785818041, 5.531931288], FRAME_PROBE.TEME_TO_GCRF);
      const exampleM = hypot3(example.out, [5102.508958, 6123.011401, 6378.136928]) * 1e3;
      evidence.push(`AIAA 2006-6753 example: ${exampleM.toFixed(4)} m from the published GCRF position (printed to 1 mm; status ${example.status})`);
      const ref = JSON.parse(fs.readFileSync(here("../../../../analysis/epoch-state/tests/vallado-verification.json"), "utf8"));
      let worstR = 0, worstV = 0, bad = 0;
      for (const c of ref.cases) {
        const t = jdOf(c.epochIso.replace("Z", ""));
        const { status, out } = rotate(module, t.whole, t.frac, [...c.temeR, ...c.temeV], FRAME_PROBE.TEME_TO_GCRF);
        if (status < 0) { bad += 1; continue; }
        worstR = Math.max(worstR, hypot3(out, c.gcrfR) * 1e3);
        worstV = Math.max(worstV, hypot3(out.slice(3), c.gcrfV) * 1e3);
      }
      evidence.push(`${ref.cases.length} epochs against pyerfa: worst ${worstR.toExponential(3)} m, ${worstV.toExponential(3)} m/s; ${bad} refused`);
      // the example is printed to 1 mm (bound 1 cm: the published TEME input is itself rounded); pyerfa: 1 mm, 1 mm/s
      evidence.push("report only: the pyerfa values take TEME as Rz(ee06a) pnm06a (GMST06), the module as R3(GAST06 - GMST82) NPB06 (src/gcrf.inc, the GMST82 TEME of AIAA 2006-6753); the difference grows from 3.3 mas (2006) to 53 mas (1980)");
      return { pass: example.status === 0 && exampleM <= 0.01 && bad === 0, evidence };
    },
  }),
  defineCheck({
    id: "vallado-time-arguments", reviewer: REVIEWERS.VALLADO, tier: "fast",
    question: "Is a time given as a UTC Julian date the same instant as minutes from the epoch, for every theory, including across the 2016-12-31 leap second (minutes from an element-set epoch are UTC minutes, as the element-set convention counts them)?",
    source: "AIAA 2006-6753 sec. II.F (epoch and time since epoch); IERS Bulletin C 52 (leap second 2016-12-31); paper 2.2",
    async run(ctx) {
      const module = await ctx.module();
      const rows = [];
      for (const theory of [THEORY.SGP4, THEORY.SGP4XP, THEORY.SDNAP]) for (const [mm, ecc, inc] of CORPUS.slice(0, 5)) {
        const base = elementsOf(tleLines({ year: 16, day: 366.5, rev: 0, inc, raan: 10, ecc, argp: 20, ma: 30, mm, ...(theory === THEORY.SGP4 ? { type: 0, bstar: 1e-5 } : { type: 4, bterm: 0.005, agom: 0.01 }) }));
        rows.push({ ...base, theory });
      }
      let worst = 0, refused = 0;
      for (const t of [0, 720, 1440, 2880, 10080]) {
        module.init(rows);
        const byMinutes = module.atMinutes(rows.map(() => t));
        const r0 = rows[0];
        const byJd = module.atJd(r0.epochWhole, r0.epochFrac + t / 1440);
        for (let k = 0; k < rows.length; k += 1) {
          if (byMinutes.status[k] || byJd.status[k]) { refused += 1; continue; }
          worst = Math.max(worst, Math.hypot(byMinutes.x[k] - byJd.x[k], byMinutes.y[k] - byJd.y[k], byMinutes.z[k] - byJd.z[k]) * 1e3);
        }
      }
      return { pass: refused === 0 && worst <= 1e-3, evidence: [`${rows.length} sets at epoch 2016-12-31 12:00 UTC (the leap second at 23:59:60 inside the first day) x 5 times: Julian date vs minutes, worst ${worst.toExponential(3)} m (bound 1 mm); ${refused} refused`] };
    },
  }),
  defineCheck({
    id: "vallado-wgs72-constants", reviewer: REVIEWERS.VALLADO, tier: "fast",
    question: "Are the SGP4 element-set constants WGS-72 as AIAA 2006-6753 Table 2 gives them (mu 398600.8 km^3/s^2, R 6378.135 km, J2 0.001082616, J3 -0.00000253881, J4 -0.00000165597), and does the paper say so?",
    source: "AIAA 2006-6753 sec. VI.B Table 2; src/constants.inc; paper 1.1",
    async run() {
      const text = fs.readFileSync(here("../../src/constants.inc"), "utf8");
      const m = /gravity_wgs72\(\)\s*\{\s*return make_gravity\(([^)]*)\)/.exec(text);
      const got = m ? m[1].split(",").map(Number) : [];
      const want = [398600.8, 6378.135, 0.001082616, -0.00000253881, -0.00000165597];
      const same = want.every((w, k) => got[k] === w);
      return { pass: same, evidence: [`constants.inc gravity_wgs72: ${m ? m[1].trim() : "absent"}`, `AIAA 2006-6753 Table 2 WGS-72: ${want.join(", ")}`, "the AIAA verification check fixes them in use: a WGS-84 SGP4 moves the published states by meters"] };
    },
  }),
  defineCheck({
    id: "vallado-path-independence", reviewer: REVIEWERS.VALLADO, tier: "fast",
    question: "Does a state depend only on the set and the time, not on the path taken to it: the same bytes fresh, and after first going 10 days forward and 10 days back (forward-backward closure of the integrated theories)?",
    source: "AIAA 2006-6753 sec. VI.D (resonance integrated from the epoch at every request); paper 1.1 and 2.2 (checkpoints keyed by time alone)",
    async run(ctx) {
      const module = await ctx.module();
      const rows = corpusRows([THEORY.SGP4, THEORY.SGP4XP, THEORY.SDNAP]);
      const at = (k) => [-2880, 0, 1000, 5000, 9000][k % 5];
      const bytes = (p) => createHash("sha256").update(Buffer.from(new Float64Array([...p.x, ...p.y, ...p.z, ...p.vx, ...p.vy, ...p.vz]).buffer)).update(Buffer.from(p.status.buffer)).digest("hex");
      module.init(rows);
      const fresh = bytes(module.atMinutes(rows.map((_, k) => at(k))));
      module.init(rows);
      module.atMinutes(rows.map(() => 14400));
      module.atMinutes(rows.map(() => -14400));
      const visited = bytes(module.atMinutes(rows.map((_, k) => at(k))));
      return { pass: fresh === visited, evidence: [`${rows.length} sets (SGP4, SGP4XP, SDNAP) at 5 times: fresh ${fresh.slice(0, 16)}, after +10 d and -10 d ${visited.slice(0, 16)}`] };
    },
  }),
  defineCheck({
    id: "vallado-energy-without-drag", reviewer: REVIEWERS.VALLADO, tier: "fast",
    question: "Without drag or radiation pressure, does the SGP4XP mean semi-major axis (the orbit's energy in a zonal and averaged lunisolar field) stay constant over 30 days off resonance, as an averaged conservative theory requires?",
    source: "Brouwer (1959) and Kozai (1959) mean elements; paper 2.1 (no secular a without non-conservative forces off resonance)",
    async run(ctx) {
      const module = await ctx.module();
      const rows = [];
      for (const theory of [THEORY.SGP4XP, THEORY.SDNAP]) for (const [mm, ecc, inc] of [[15.5, 0.001, 51.6], [14.3, 0.002, 98.2], [12.5, 0.01, 70], [4.5, 0.01, 55]]) {
        rows.push(rowOf({ mm, ecc, inc, raan: 40, argp: 15, ma: 7, bterm: 0, agom: 0 }, theory));
      }
      module.init(rows);
      const x = module.x, out = x.sdnap_alloc(48);
      const aAt = (i, t) => (x.sdnap_mean_elements_at(i, t, out) === 0 ? new Float64Array(module.harness.memory.buffer, out, 1)[0] : NaN);
      // the day's average (144 samples): SDNAP's mean a carries the m-daily tesseral terms (paper 3.2), which a day averages
      const dayMean = (i, d) => { let sum = 0; for (let k = 0; k < 144; k += 1) sum += aAt(i, d * 1440 + 10 * k); return sum / 144; };
      const worst = { [THEORY.SGP4XP]: 0, [THEORY.SDNAP]: 0 };
      let refused = 0;
      rows.forEach((row, i) => {
        const a = row.theory === THEORY.SGP4XP ? [aAt(i, 0), aAt(i, 43200)] : [dayMean(i, 0), dayMean(i, 29)];
        if (!a.every(Number.isFinite)) { refused += 1; return; }
        worst[row.theory] = Math.max(worst[row.theory], Math.abs(a[1] / a[0] - 1));
      });
      x.sdnap_free(out);
      return { pass: refused === 0 && worst[THEORY.SGP4XP] <= 1e-12, evidence: [
        `${rows.length} drag-free, radiation-free sets, LEO to MEO, off resonance; ${refused} refused`,
        `SGP4XP mean a, epoch vs 30 days: ${worst[THEORY.SGP4XP].toExponential(3)} relative (bound 1e-12)`,
        `report only: SDNAP mean a, day-1 average vs day-30 average, ${worst[THEORY.SDNAP].toExponential(3)} relative: SDNAP carries the m-daily and shallow-resonance tesseral terms (paper 3.2, 3.4), which exchange energy with the rotating field, so its mean a is not an integral`] };
    },
  }),
  defineCheck({
    id: "vallado-step-convergence", reviewer: REVIEWERS.VALLADO, tier: "full",
    question: "Do the integrated shallow-resonance terms converge as the integration step shrinks: at 7 days the state at step/1 and step/2 approaches step/8, the error falling with the step?",
    source: "paper 2.2 and 3.4 (third-order Runge-Kutta on an epoch-anchored grid); sdnap_tesseral_diagnostic step divisor",
    async run() {
      const rows = [[14.8, 0.001, 53], [13.0, 0.002, 63], [12.0, 0.01, 80]].map(([mm, ecc, inc]) => rowOf({ mm, ecc, inc, raan: 40, argp: 15, ma: 7, bterm: 0, agom: 0 }, THEORY.SDNAP));
      const at = async (divisor) => {
        const m = await openModule();
        m.x.sdnap_tesseral_diagnostic(0, divisor);
        m.init(rows);
        const p = m.atMinutes(rows.map(() => 10080));
        const r = rows.map((_, k) => [p.x[k], p.y[k], p.z[k]]);
        m.destroy();
        return r;
      };
      const ref = await at(8);
      const err = [];
      for (const d of [1, 2, 4]) { const s = await at(d); err.push(Math.max(...s.map((r, k) => hypot3(r, ref[k]) * 1e3))); }
      const falls = err[1] < err[0] && err[2] < err[1];
      return { pass: falls || err[0] === 0, evidence: [`3 SDNAP sets with shallow resonance at 7 days: max |state(step/d) - state(step/8)| = ${err.map((e, k) => `d=${[1, 2, 4][k]}: ${e.toExponential(3)} m`).join(", ")}`] };
    },
  }),
  defineCheck({
    id: "vallado-thread-determinism", reviewer: REVIEWERS.VALLADO, tier: "fast",
    question: "Are the output bytes the same at any thread count (0 and 4 workers) for every theory?",
    source: "paper 12.2 (batch propagation returns the same bytes at any thread count)",
    async run() {
      const rows = corpusRows([THEORY.SGP4, THEORY.SGP4XP, THEORY.SDNAP]);
      const digest = async (threads) => {
        const m = await openModule({ threads });
        m.init(rows);
        const h = createHash("sha256");
        for (const t of [0, 1440, 10080]) { const p = m.atMinutes(rows.map(() => t)); h.update(Buffer.from(new Float64Array([...p.x, ...p.y, ...p.z, ...p.vx, ...p.vy, ...p.vz]).buffer)); }
        return { hex: h.digest("hex"), running: m.threads };
      };
      const a = await digest(0), b = await digest(4);
      return { pass: a.hex === b.hex && b.running > 0, evidence: [`${rows.length} sets x 3 times: 0 threads ${a.hex.slice(0, 16)}; ${b.running} threads ${b.hex.slice(0, 16)}`] };
    },
  }),
  defineCheck({
    id: "vallado-wasmedge-parity", reviewer: REVIEWERS.VALLADO, tier: "full", timeoutSec: 900,
    question: "Does native WasmEdge give the browser host's bytes (test/wasmedge-parity.mjs)?",
    source: "paper 12.2 (the same module.wasm in the browser host and in native WasmEdge 0.16.4)",
    async run() {
      if (spawnSync("wasmedge", ["--version"]).status !== 0) throw new NotMeasured("wasmedge is not installed");
      const r = spawnSync(process.execPath, [here("../wasmedge-parity.mjs")], { encoding: "utf8", cwd: here("../.."), timeout: 850e3 });
      const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-4);
      return { pass: r.status === 0, evidence: [`test/wasmedge-parity.mjs exit ${r.status}`, ...tail] };
    },
  }),
  defineCheck({
    id: "vallado-covariance-realism-bound", reviewer: REVIEWERS.VALLADO, tier: "fast",
    question: "Is the covariance realistic within a stated bound: does the specification state an acceptance band for mean d^2/3 and the 95 % coverage, and does every held-out cell recorded in test/results fall inside it?",
    source: "SPEC 12 and README 'Covariance realism'; test/results/covariance-realism-*.json (chi-square(3) statistics of held-out laser-ranged windows)",
    async run() {
      const spec = fs.readFileSync(here("../../SPEC.md"), "utf8") + fs.readFileSync(here("../../README.md"), "utf8");
      const band = /realism (?:acceptance )?band[^\n]*?mean d\^2\s*\/\s*3 in \[([\d.]+),\s*([\d.]+)\][^\n]*?coverage[^\n]*?\[([\d.]+),\s*([\d.]+)\]/i.exec(spec);
      const cells = [];
      for (const th of ["sdnap", "sgp4xp"]) {
        const r = JSON.parse(fs.readFileSync(here(`../results/covariance-realism-${th}.json`), "utf8"));
        for (const [set, v] of Object.entries(r.realism)) for (const [day, c] of Object.entries(v.all)) cells.push({ th, set, day, m: c.meanD2Over3, cov: c.coverage95 });
      }
      const range = (k) => `${Math.min(...cells.map((c) => c[k]))}..${Math.max(...cells.map((c) => c[k]))}`;
      const evidence = [`${cells.length} held-out cells: mean d^2/3 ${range("m")}, 95 % coverage ${range("cov")}`];
      if (!band) { evidence.push("no realism acceptance band is stated in SPEC.md or README.md: the numbers are reported, not judged"); return { pass: false, evidence }; }
      const out = cells.filter((c) => c.m < +band[1] || c.m > +band[2] || c.cov < +band[3] || c.cov > +band[4]);
      evidence.push(`band: mean d^2/3 [${band[1]}, ${band[2]}], coverage [${band[3]}, ${band[4]}]; ${out.length} cells outside`);
      return { pass: out.length === 0, evidence };
    },
  }),
];
