#!/usr/bin/env node
// E2E (task modules-sdn-ap-covariance-noise-refit-20261105), a report: AP's DRAG process noise of 0.6.1 against 0.6.0 on
// the held-out windows of the per-axis re-fit (SPEC 12.5). Realism is not claimed: the band is not met.
// - The built module's AP fit of the NASA ISS sample (analysis/od/tests/data/supgp-reference/iss, the demo's sample: its
//   states up to the file's midpoint, $PCF THEORY AP, FORCES JACCHIA70 on THEORY_FLUX_MODEL, degree 20, tesseral 31)
//   writes COV_PROPAGATION with the 0.6.1 DRAG row: s_e, s_i, s_l and the share c equal the re-fit's values bit for bit,
//   and its floor is k_F times the floor of the 0.6.0 build's fit of the same sample (sdn-ap 0.6.0 by `git show` at
//   modules 895b6b38, SHA-256 checked).
// - The ISS figure: each build flies its fit to the file's last state (12 h from its start, EME2000); the in-track
//   1-sigma (the position covariance projected on the truth state's in-track axis) and the error, both builds.
// - The held-out windows (the coverage study's rows, sdn-ap 0.6.0 flights: per lead the error and each process-noise
//   term's variance in R, I and C): the 0.6.0 medians |z| are the rows' own; the 0.6.1 ones re-weight the module's
//   per-term variances to the row the built module wrote (P(t) is linear in each squared size, the floor adds). Per
//   regime, axis and day 1, 3 and 7 (lead hours 24, 72, 167): both medians side by side, the shares within 1 and 2
//   sigma, the worst |ln(median |z| / 0.674)| of each build, and every cell whose |ln| grew.
// Asserts: the row as above; the re-weighting at the rows' own sizes reproduces the rows' variances (1e-6 relative);
// the 0.6.1 medians equal the re-fit's held-out cells (test/fixtures/covariance-refit-held-out.json, MEDIAN_RELATIVE below: six digits stored); no
// 0.6.1 held-out median lies outside 0.32 to 0.91. JS moves bytes, rotates the module's covariance onto the truth's
// axes and takes medians; every state and covariance is the module's.
//   node test/covariance-realism.e2e.mjs
import fs from "node:fs";
import { scratchTemp } from "./lib/scratch.mjs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as BlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT as LineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { ensureBuilt, packageRoot, wasmPath } from "./lib/module.mjs";
import { configuration, XP_FORCES } from "./lib/pcf.mjs";
import { packOem, rfm } from "./lib/frames.mjs";

const ROWS = "/opt/data/sdn-archive/operator-theory/covariance-coverage";
const BEFORE = { commit: "895b6b38de29bc284b4b50a02425a6c3a5fe81a2", sha256: "0b5280f05176fc755dbfb859fd8028fc495759d7537024c53043f498c91faa63" };
// The floor ratio and the held-out medians as the re-fit stated them: within 1e-12 and 1e-5 relative until 0.6.5, whose fit
// (the analytic/SIMD covariance Jacobian among its speed changes, SPEC 16.8) stops at another point inside its tolerance:
// measured 2026-11-10 on 0.6.8, the floors at most 1.1e-3 relative off k_F times 0.6.0's (FLOOR_VU_KM2; FLOOR_VV_KM2
// 2.3e-5), the medians at most 1.2e-5 relative off the re-fit's (strong drag 2025 24 h R 0.6346524 against 0.634645).
const FLOOR_RELATIVE = 2e-3, MEDIAN_RELATIVE = 5e-5;
// 0.6.25 (the slow set, SPEC 16.18) moves the ISS sample's fit (420 km, a 6 h arc), whose floors scale the DRAG row: its
// error at the sample's last state (12 h) against the file's own truth goes from 308.5 to 316.6 m (2.6 %), FLOOR_VV_KM2
// from 1.5128 to 1.5180 times 0.6.0's and FLOOR_WW_KM2 to 1.4626 times. One sample; the held-out cells move by at most
// 0.0011 in median |z| (6 of 11 moved cells away from 0.674, 5 toward), while the real rows at those altitudes gain (the
// slow set's pull request: strong drag 74 to 81 and 91 to 102 windows within 100 m of the numerical propagator). So the
// floors and the moved medians are pinned to this build's (FLOORS_PINNED, MEDIANS_PINNED), the bounds kept; the re-fit's
// k_F and medians are printed beside them.
// 0.6.27 (the slow set's terms of q other than 0) moves the ISS sample's fit again: its error at 12 h against the file's own
// truth goes from 316.6 to 322.9 m (2.0 %), FLOOR_VV_KM2 from 1.518 to 1.467 times 0.6.0's, FLOOR_UU_KM2 to 1.397 and
// FLOOR_WW_KM2 to 1.462 times. The held-out cells move by at most 0.011 in median |z| (S1 24 h R 0.6368 to 0.6474); of the 14
// that move past the bound, 8 move toward 0.674 and 6 away, and one leaves the band (0.603 to 0.754): T 167 h R, 0.7536 to
// 0.7572.
// So the floors and medians are pinned to 0.6.27's, the bounds kept (the cost stated in its pull request).
const FLOORS_PINNED = { FLOOR_UU_KM2: 0.00021677553193454318, FLOOR_VU_KM2: 2.6500774508688905e-7, FLOOR_VV_KM2: 0.0013005930847864295,
  FLOOR_WU_KM2: -0.000012432207238489321, FLOOR_WV_KM2: -0.00016953453851612765, FLOOR_WW_KM2: 0.00020868838795707218 };
const MEDIANS_PINNED = { "T 24 R": 0.643032, "T 24 C": 0.787734, "T 72 R": 0.750729, "T 72 C": 0.876057, "T 167 R": 0.757151,
  "S1 24 R": 0.647389, "S1 24 C": 0.665963, "S1 72 R": 0.646957, "S1 72 C": 0.562886, "S1 167 R": 0.859413, "S1 167 C": 0.380437,
  "T 24 I": 0.468298, "T 167 C": 0.794573, "S1 72 I": 0.487369 };
const ISS = { path: "analysis/od/tests/data/supgp-reference/iss/ISS.OEM_J2K_EPH.trimmed.txt", sha256: "fbda48d1584bee1f38ea562625280ecfe4e6643f67c417e91f2fc245ee48311f" };
const HALF_NORMAL_MEDIAN = 0.6744897501960817, LEADS = [24, 72, 167], AXES = ["R", "I", "C"], RANGE = [0.32, 0.91];
const REGIMES = { T: "strong drag 2025", S1: "near 700 km 2026" };
const SETS = { truth: { regime: "T", arms: ["AP24", "APRa12"] }, truth2: { regime: "S1", arms: ["AP72", "AP24"] } };
const GALILEO_HELD = [43567, 37847, 41862, 41174, 43055, 41175], SWARM_GRACE = [39451, 39452, 39453, 43476, 43477], SWARM_GRACE_LAST = Date.parse("2025-12-28T00:00:00.000Z");
const expected = JSON.parse(fs.readFileSync(fileURLToPath(new URL("fixtures/covariance-refit-held-out.json", import.meta.url)), "utf8"));
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
const fmt = (x) => (Math.abs(x) >= 0.01 ? x.toFixed(3) : x.toExponential(2));
const modulesRoot = path.resolve(packageRoot, "../..");

// ---- the two builds
ensureBuilt();
const beforeBytes = execFileSync("git", ["-C", modulesRoot, "show", `${BEFORE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
check(sha256(beforeBytes) === BEFORE.sha256, `sdn-ap 0.6.0 at ${BEFORE.commit.slice(0, 9)} is ${sha256(beforeBytes)}`);
const scratch = scratchTemp("sdnap-covariance-realism-");
const beforePath = path.join(scratch, "module-0.6.0.wasm");
fs.writeFileSync(beforePath, beforeBytes);
const builds = { "0.6.0": await createStandaloneHarness("browser", beforePath, { surface: "direct" }), "0.6.1": await createStandaloneHarness("browser", wasmPath, { surface: "direct" }) };
console.log(`sdn-ap 0.6.1 ${sha256(fs.readFileSync(wasmPath))}; 0.6.0 ${BEFORE.sha256} (modules ${BEFORE.commit.slice(0, 9)})`);

// ---- the ISS sample as the demo fits it
const text = fs.readFileSync(path.join(modulesRoot, ISS.path));
check(sha256(text) === ISS.sha256, `${ISS.path} is ${sha256(text)}`);
const kv = Object.fromEntries(String(text).split("\n").map((l) => /^([A-Z_]+)\s*=\s*(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const states = String(text).split("\n").map((l) => l.trim().split(/\s+/)).filter((q) => q.length === 7 && /^\d{4}-\d\d-\d\dT/.test(q[0]))
  .map((q) => ({ epoch: q[0], r: q.slice(1, 4).map(Number), v: q.slice(4, 7).map(Number) }));
const msOf = (t) => Date.parse(/Z$/.test(t) ? t : `${t}Z`);
const half = msOf(states[0].epoch) + (msOf(states.at(-1).epoch) - msOf(states[0].epoch)) / 2;
const fitLines = states.filter((q) => msOf(q.epoch) <= half);
const lines = fitLines.map((q) => Object.assign(new LineT(), { EPOCH: q.epoch, X: q.r[0], Y: q.r[1], Z: q.r[2], X_DOT: q.v[0], Y_DOT: q.v[1], Z_DOT: q.v[2] }));
const block = Object.assign(new BlockT(), { OBJECT: Object.assign(new CATT(), { OBJECT_NAME: kv.OBJECT_NAME, OBJECT_ID: kv.OBJECT_ID }), CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm(kv.REF_FRAME),
  TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: kv.USEABLE_START_TIME, USEABLE_STOP_TIME: kv.USEABLE_STOP_TIME, EPHEMERIS_DATA_LINES: lines });
const issOem = packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] })).slice();
const fitPcf = configuration({ theory: "AP", forces: { ...XP_FORCES, WEATHER_SOURCE: pcfWeatherSource.THEORY_FLUX_MODEL, MAXIMUM_DEGREE: 20, HAS_MAXIMUM_DEGREE: true,
  MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_TESSERAL_DEGREE: true } });
const last = states.at(-1);
const flightPcf = configuration({ output: { FRAME: pcfOutputFrame.EME2000, EPOCHS: [last.epoch] } });
const unit = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const iss = {};
for (const [name, h] of Object.entries(builds)) {
  const f = await h.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: issOem }, fitPcf] });
  check(f.statusCode === 0, `${name} fit: ${f.errorCode} ${f.errorMessage}`);
  if (f.statusCode !== 0) continue;
  const ocmBytes = new Uint8Array(f.outputs.find((o) => o.portId === "elements").payload);
  const cp = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(ocmBytes)).unpack().COV_PROPAGATION;
  const p = await h.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: ocmBytes }, flightPcf] });
  check(p.statusCode === 0, `${name} propagate: ${p.errorCode} ${p.errorMessage}`);
  if (p.statusCode !== 0) continue;
  const u = new Uint8Array(p.outputs.find((o) => o.portId === "ephemeris").payload);
  const o = (String.fromCharCode(...u.subarray(8, 12)) === "$OEM" ? OEM.getSizePrefixedRootAsOEM(new flatbuffers.ByteBuffer(u)) : OEM.getRootAsOEM(new flatbuffers.ByteBuffer(u))).unpack();
  const b = o.EPHEMERIS_DATA_BLOCK[0], s = b.EPHEMERIS_DATA_LINES[0], c = b.COVARIANCE_MATRIX_LINES?.[0];
  check(!!s && msOf(s.EPOCH) === msOf(last.epoch) && !!c, `${name}: no state or covariance at ${last.epoch} (${s?.EPOCH})`);
  if (!c) continue;
  const P = [[c.CX_X, c.CY_X, c.CZ_X], [c.CY_X, c.CY_Y, c.CZ_Y], [c.CZ_X, c.CZ_Y, c.CZ_Z]];
  const rh = unit(last.r), ch = unit(cross(last.r, last.v)), ih = cross(ch, rh), err = [s.X - last.r[0], s.Y - last.r[1], s.Z - last.r[2]];
  const quad = (a) => a.reduce((sum, ai, i) => sum + ai * a.reduce((t, aj, j) => t + P[i][j] * aj, 0), 0);
  iss[name] = { cp, sigmaKm: [rh, ih, ch].map((a) => Math.sqrt(quad(a))), errorKm: Math.hypot(...err), inTrackErrorKm: err.reduce((t, e, i) => t + e * ih[i], 0) };
}
for (const name of Object.keys(builds)) if (iss[name]) console.log(`ISS ${last.epoch} (12 h from the file's start), sdn-ap ${name}: 1-sigma R/I/C ${iss[name].sigmaKm.map((x) => x.toFixed(4)).join(" / ")} km; in-track 1-sigma ${iss[name].sigmaKm[1].toFixed(4)} km against the error ${iss[name].errorKm.toFixed(4)} km (in-track ${Math.abs(iss[name].inTrackErrorKm).toFixed(4)} km)`);

// ---- the 0.6.1 DRAG row as the built module writes it
const now = iss["0.6.1"]?.cp, was = iss["0.6.0"]?.cp, F = expected.fitted;
const row = now && was ? { s_e: now.NOISE_ECCENTRICITY_PER_DAY, s_i: now.NOISE_INCLINATION_PER_DAY, s_l: now.NOISE_MEAN_MOTION_RELATIVE, c: now.NON_GRAVITATIONAL_SHARE, k_F: now.FLOOR_VV_KM2 / was.FLOOR_VV_KM2 } : null;
check(!!row, "no 0.6.1 or 0.6.0 COV_PROPAGATION");
if (row) {
  for (const k of ["s_e", "s_i", "s_l", "c"]) check(Object.is(row[k], F[k]), `${k}: the module writes ${row[k]}, the re-fit ${F[k]}`);
  // the diagonal terms relative to themselves; each cross term relative to the square root of the product of its two
  // diagonal terms (2026-11-11, stack #433: a cross term near zero, held relative to itself, read the two builds' fits
  // stopping apart; a millimeter of state change moved FLOOR_VU_KM2 5.6e-3 of itself)
  const PF = FLOORS_PINNED;
  for (const f of ["FLOOR_UU_KM2", "FLOOR_VV_KM2", "FLOOR_WW_KM2"]) {
    console.log(`${f}: 0.6.1 / 0.6.0 = ${now[f] / was[f]}, the re-fit's k_F ${F.k_F}`);
    check(Math.abs(now[f] / PF[f] - 1) <= FLOOR_RELATIVE, `${f}: ${now[f]} against the slow set's ${PF[f]} (within ${FLOOR_RELATIVE} relative)`);
  }
  for (const [f, d1, d2] of [["FLOOR_VU_KM2", "FLOOR_VV_KM2", "FLOOR_UU_KM2"], ["FLOOR_WU_KM2", "FLOOR_WW_KM2", "FLOOR_UU_KM2"], ["FLOOR_WV_KM2", "FLOOR_WW_KM2", "FLOOR_VV_KM2"]]) {
    const refit = Math.abs(now[f] - F.k_F * was[f]) / (F.k_F * Math.sqrt(was[d1] * was[d2]));
    const off = Math.abs(now[f] - PF[f]) / Math.sqrt(PF[d1] * PF[d2]);
    console.log(`${f}: 0.6.1 against k_F times 0.6.0's ${refit.toExponential(2)} of sqrt(${d1} x ${d2}); against the slow set's ${off.toExponential(2)}`);
    check(off <= FLOOR_RELATIVE, `${f}: against the slow set's differs by ${off} of the square root of ${d1} x ${d2} (within ${FLOOR_RELATIVE})`);
  }
  console.log(`0.6.1 DRAG row as written: s_e ${row.s_e}, s_i ${row.s_i}, s_l ${row.s_l}, c ${row.c}, floor ${row.k_F} times 0.6.0's`);
  console.log(`0.6.1 floors as written: ${JSON.stringify(Object.fromEntries(Object.keys(PF).map((f) => [f, now[f]])))}`);
}

// ---- the held-out windows
const blockOf = (regime, date) => { const b = expected.blocks[regime]; return date >= b.heldOut[0] && date <= b.heldOut[1]; };
const samples = { T: new Map(), S1: new Map() };
let maxRel = 0;
for (const [set, s] of Object.entries(SETS)) {
  const dir = path.join(ROWS, set);
  for (const f of fs.readdirSync(dir).filter((n) => /^rows-\d+\.jsonl$/.test(n)).sort()) for (const l of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
    if (!l) continue;
    const r = JSON.parse(l);
    if (!blockOf(s.regime, r.cutoff.slice(0, 10))) continue;
    check(!GALILEO_HELD.includes(r.norad) && !/starlink/i.test(r.name ?? "") && !(SWARM_GRACE.includes(r.norad) && Date.parse(r.cutoff) + 7 * 86400000 > SWARM_GRACE_LAST), `${r.key}: a hold-out`);
    for (const arm of s.arms) {
      const a = r.arms?.[arm];
      if (!a?.ok || !a.leads?.length || !a.covPropagation) continue;
      const cp = a.covPropagation, sizes = [cp.NOISE_ECCENTRICITY_PER_DAY, cp.NOISE_INCLINATION_PER_DAY, cp.NOISE_MEAN_MOTION_RELATIVE, cp.NON_GRAVITATIONAL_SHARE];
      const floor = [cp.FLOOR_UU_KM2, cp.FLOOR_VV_KM2, cp.FLOOR_WW_KM2];
      for (const L of a.leads) {
        if (!LEADS.includes(L.h)) continue;
        // per axis: the variance at sizes q (each against the size the row flew), the floor scaled by kF
        const at = (q, kF) => [0, 1, 2].map((x) => L.v.off[x] + (kF - 1) * floor[x] + ["e", "i", "l", "d"].reduce((t, k, j) => t + (q[j] / sizes[j]) ** 2 * (L.v.full[x] - L.v[k][x]), 0));
        at(sizes, 1).forEach((v, x) => { maxRel = Math.max(maxRel, Math.abs(v - L.v.full[x]) / L.v.full[x]); });
        const v1 = row ? at([row.s_e, row.s_i, row.s_l, row.c], row.k_F) : L.v.full;
        const list = samples[s.regime].get(L.h) ?? samples[s.regime].set(L.h, []).get(L.h);
        list.push({ z0: L.e.map((e, x) => Math.abs(e) / Math.sqrt(L.v.full[x])), z1: L.e.map((e, x) => Math.abs(e) / Math.sqrt(v1[x])) });
      }
    }
  }
}
check(maxRel <= 1e-6, `re-weighting at the rows' own sizes departs from their variances by ${maxRel}`);
const median = (v) => { const s = Float64Array.from(v).sort(); const n = s.length; return n ? (s[(n - 1) >> 1] + s[n >> 1]) / 2 : NaN; };
const share = (v, k) => v.filter((z) => z <= k).length / v.length;
const dist = (m) => Math.abs(Math.log(m / HALF_NORMAL_MEDIAN));
const cells = [];
for (const regime of Object.keys(REGIMES)) for (const h of LEADS) {
  const list = samples[regime].get(h) ?? [];
  AXES.forEach((ax, x) => {
    const z0 = list.map((q) => q.z0[x]), z1 = list.map((q) => q.z1[x]);
    cells.push({ regime, h, ax, n: list.length, m0: median(z0), m1: median(z1), s0: [share(z0, 1), share(z0, 2)], s1: [share(z1, 1), share(z1, 2)] });
  });
}
console.log(`\nHeld-out windows (${Object.entries(expected.blocks).map(([r, b]) => `${REGIMES[r]} ${b.heldOut.join(" to ")}`).join("; ")}), median |z| (calibrated 0.674, band 0.603 to 0.754) and the shares within 1 and 2 sigma (calibrated 0.683, 0.954):`);
console.log("regime            day axis     n   0.6.0 |z|  0.6.1 |z|   0.6.0 in 1, 2 sigma   0.6.1 in 1, 2 sigma");
for (const c of cells) console.log(`${REGIMES[c.regime].padEnd(17)} ${String(c.h === 167 ? 7 : c.h / 24).padStart(3)} ${c.ax.padEnd(4)} ${String(c.n).padStart(5)} ${fmt(c.m0).padStart(10)} ${fmt(c.m1).padStart(10)}   ${c.s0.map((x) => x.toFixed(3)).join(", ").padStart(19)}   ${c.s1.map((x) => x.toFixed(3)).join(", ").padStart(19)}`);
const worst0 = Math.max(...cells.map((c) => dist(c.m0))), worst1 = Math.max(...cells.map((c) => dist(c.m1)));
const worse = cells.filter((c) => dist(c.m1) > dist(c.m0));
const inside = cells.filter((c) => c.m1 >= 0.603 && c.m1 <= 0.754).length;
console.log(`worst held-out |ln(median |z| / 0.674)|: 0.6.0 ${worst0.toFixed(3)}, 0.6.1 ${worst1.toFixed(3)}`);
console.log(`cells further from 0.674 under 0.6.1: ${worse.length ? worse.map((c) => `${REGIMES[c.regime]} day ${c.h === 167 ? 7 : c.h / 24} ${c.ax} ${fmt(c.m0)} -> ${fmt(c.m1)}`).join("; ") : "none"}`);
console.log(`0.6.1 held-out cells inside the band: ${inside} of ${cells.length} (realism not met)`);

// ---- the re-fit's held-out cells reproduce; none outside the report's range
for (const e of expected.heldOut) {
  const c = cells.find((q) => q.regime === e.regime && q.h === e.h && q.ax === e.axis);
  const pinned = MEDIANS_PINNED[`${e.regime} ${e.h} ${e.axis}`], want = pinned ?? e.medianAbsZ;
  check(c && c.n === e.n && Math.abs(c.m1 - want) <= MEDIAN_RELATIVE * want,
    `${e.regime} ${e.h} h ${e.axis}: ${c?.m1} (n ${c?.n}) against ${pinned !== undefined ? `the slow set's ${pinned} (the re-fit's ${e.medianAbsZ})` : `the re-fit's ${e.medianAbsZ}`} (n ${e.n}, within ${MEDIAN_RELATIVE} relative)`);
}
for (const c of cells) check(c.m1 >= RANGE[0] && c.m1 <= RANGE[1], `${REGIMES[c.regime]} ${c.h} h ${c.ax}: 0.6.1 median |z| ${c.m1} outside ${RANGE.join(" to ")}`);
fs.rmSync(scratch, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`\ncovariance realism report E2E: PASS (ISS in-track 1-sigma at 12 h ${iss["0.6.0"].sigmaKm[1].toFixed(2)} -> ${iss["0.6.1"].sigmaKm[1].toFixed(3)} km against the error ${iss["0.6.1"].errorKm.toFixed(3)} km; worst held-out |ln| ${worst0.toFixed(2)} -> ${worst1.toFixed(2)}; ${inside} of ${cells.length} held-out cells inside the band, realism not met)`);
process.exit(0);
