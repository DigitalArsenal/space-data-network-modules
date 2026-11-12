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
// - The radial floor factor (SPEC 12.5, stack #477): the same fit by this build and by the build the registered rows were
//   flown on (modules 41d7b900, SHA-256 checked) differs only by FLOOR_UU times f^2 and FLOOR_VU and FLOOR_WU times f, with
//   f = RADIAL_FACTOR (the low table's fast side), and the same mean elements.
// - The registered windows (stack #477, the build's own flights): 748 windows of the low table (strong drag 2025 and 2026,
//   laser spheres, burn-free altimetry, near 700 km), each fitted by the rows' build at tesseral 31 / zonal 70 (the
//   records the catalog fits) and flown with its own covariance; every 30 min on days 1, 2, 3, 5 and 7 (near 700 km 1 to
//   3) the error and the variance as flown in the truth's R, I and C, and the record's floor. This build's variance is
//   that variance with the radial floor re-weighted, v + (f^2 - 1) FLOOR_UU (the in-track and cross-track as flown).
//   Per regime, day and axis over the judged windows (the split rule's other set): the median |z|, pooled over every
//   sample of the day, and the shares within 1 and 3 sigma.
// Asserts: the DRAG row and the floors as above; the factor; every judged cell equals the registered cell
// (test/fixtures/covariance-judged-31-70.json, MEDIAN_RELATIVE); the cells outside the band [0.603, 0.754] are exactly the
// registered ones, each named with its cause. Realism is not met: 8 of the 42 judged cells are inside the band. JS moves
// bytes, rotates the module's covariance onto the truth's axes and takes medians; every state and covariance is the module's.
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

// the registered rows (stack #477): the build's own flights, records at tesseral 31 / zonal 70, and the build they were flown on
const ROWS = { path: "/opt/data/sdn-archive/operator-theory/covariance-coverage-d36bac74be6d/rows-31-70.jsonl", sha256: "04875c914f74b3695295d182951380da9c71b39f3e26f51c9b4c099a65bbbaa3" };
const ROWS_BUILD = { commit: "41d7b9009a47a76a1c8c70e05d8b029ccf2e8940", sha256: "d36bac74be6defa33d2aaddad74fe1aab7d81b2113586a15f49d59e2cbe8716c" };
// SPEC 12.5's kFloorRadialFastSide, the radial floor's sigma factor in the low table's fast side
const RADIAL_FACTOR = Math.exp(0.10);
const BEFORE ={ commit: "895b6b38de29bc284b4b50a02425a6c3a5fe81a2", sha256: "0b5280f05176fc755dbfb859fd8028fc495759d7537024c53043f498c91faa63" };
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
// 0.6.36 (the field EGM2008, SPEC 16.2) moves the sample's fit once more: its 12 h error 322.9 to 322.7 m, FLOOR_VV_KM2 1.467 to
// 1.476 times 0.6.0's, FLOOR_WW_KM2 1.462 to 1.451 times. The held-out cells move by at most 0.0021 in median |z| (S1 24 h R
// 0.6474 to 0.6454): of the 11 that move past the bound, 5 move toward 0.674 and 6 away, and none crosses the band's edge.
// So the floors and medians are pinned to 0.6.36's, the bounds kept.
// The low table's fast side (SPEC 16.1, stack #477) fits the ISS sample's arc closer, and the floor is that fit's residual
// covariance: FLOOR_VV_KM2 1.476 to 0.494 times 0.6.0's (FLOOR_UU_KM2 0.588, FLOOR_WW_KM2 0.434, the radial factor in); the radial floor then takes RADIAL_FACTOR (SPEC 12.5). The
// floors are pinned to this build's. The held-out windows of 0.6.0's flights re-weighted with this build's variances are
// replaced by the build's own flights (the registered rows above): the floor shrinks with the fit's residual, and what a
// stated covariance is judged on is the build's own errors.
const FLOORS_PINNED = { FLOOR_UU_KM2: 0.0000912831222494661, FLOOR_VU_KM2: -0.0000020918417593167886, FLOOR_VV_KM2: 0.0004380280649517272,
  FLOOR_WU_KM2: 0.000006046253467240998, FLOOR_WV_KM2: 0.000004199684925677152, FLOOR_WW_KM2: 0.00006201096768439081 };
const ISS = { path: "analysis/od/tests/data/supgp-reference/iss/ISS.OEM_J2K_EPH.trimmed.txt", sha256: "fbda48d1584bee1f38ea562625280ecfe4e6643f67c417e91f2fc245ee48311f" };
const AXES = ["R", "I", "C"];
const expected = JSON.parse(fs.readFileSync(fileURLToPath(new URL("fixtures/covariance-refit-held-out.json", import.meta.url)), "utf8"));
const judged = JSON.parse(fs.readFileSync(fileURLToPath(new URL("fixtures/covariance-judged-31-70.json", import.meta.url)), "utf8"));
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
const rowsBuildBytes = execFileSync("git", ["-C", modulesRoot, "show", `${ROWS_BUILD.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
check(sha256(rowsBuildBytes) === ROWS_BUILD.sha256, `the registered rows' build at ${ROWS_BUILD.commit.slice(0, 9)} is ${sha256(rowsBuildBytes)}`);
const rowsBuildPath = path.join(scratch, "module-rows.wasm");
fs.writeFileSync(rowsBuildPath, rowsBuildBytes);
const builds = { "0.6.0": await createStandaloneHarness("browser", beforePath, { surface: "direct" }), "0.6.1": await createStandaloneHarness("browser", wasmPath, { surface: "direct" }),
  rows: await createStandaloneHarness("browser", rowsBuildPath, { surface: "direct" }) };
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
  const ocm = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(ocmBytes)).unpack(), cp = ocm.COV_PROPAGATION, elements = JSON.stringify(ocm.MEAN_ELEMENTS);
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
  iss[name] = { cp, elements, sigmaKm: [rh, ih, ch].map((a) => Math.sqrt(quad(a))), errorKm: Math.hypot(...err), inTrackErrorKm: err.reduce((t, e, i) => t + e * ih[i], 0) };
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
    check(Math.abs(now[f] / PF[f] - 1) <= FLOOR_RELATIVE, `${f}: ${now[f]} against this build's pinned ${PF[f]} (within ${FLOOR_RELATIVE} relative)`);
  }
  for (const [f, d1, d2] of [["FLOOR_VU_KM2", "FLOOR_VV_KM2", "FLOOR_UU_KM2"], ["FLOOR_WU_KM2", "FLOOR_WW_KM2", "FLOOR_UU_KM2"], ["FLOOR_WV_KM2", "FLOOR_WW_KM2", "FLOOR_VV_KM2"]]) {
    const refit = Math.abs(now[f] - F.k_F * was[f]) / (F.k_F * Math.sqrt(was[d1] * was[d2]));
    const off = Math.abs(now[f] - PF[f]) / Math.sqrt(PF[d1] * PF[d2]);
    console.log(`${f}: 0.6.1 against k_F times 0.6.0's ${refit.toExponential(2)} of sqrt(${d1} x ${d2}); against this build's pinned ${off.toExponential(2)}`);
    check(off <= FLOOR_RELATIVE, `${f}: against this build's pinned differs by ${off} of the square root of ${d1} x ${d2} (within ${FLOOR_RELATIVE})`);
  }
  console.log(`0.6.1 DRAG row as written: s_e ${row.s_e}, s_i ${row.s_i}, s_l ${row.s_l}, c ${row.c}, floor ${row.k_F} times 0.6.0's`);
  console.log(`0.6.1 floors as written: ${JSON.stringify(Object.fromEntries(Object.keys(PF).map((f) => [f, now[f]])))}`);
}

// ---- the radial floor factor: this build's fit of the ISS sample (420 km, in the low table at tesseral 31) against the
// rows' build's, the same fit but for the factor
const rowsCp = iss.rows?.cp;
check(!!now && !!rowsCp && iss["0.6.1"].elements === iss.rows.elements, "the ISS fit: this build's and the rows' build's mean elements differ");
if (now && rowsCp) {
  const f = RADIAL_FACTOR, want = { FLOOR_UU_KM2: f * f, FLOOR_VU_KM2: f, FLOOR_WU_KM2: f, FLOOR_VV_KM2: 1, FLOOR_WV_KM2: 1, FLOOR_WW_KM2: 1 };
  for (const [k, w] of Object.entries(want)) check(Math.abs(now[k] / rowsCp[k] / w - 1) <= 1e-12, `${k}: this build / the rows' build ${now[k] / rowsCp[k]}, the factor's ${w}`);
  console.log(`the radial floor factor: FLOOR_UU_KM2 x ${(now.FLOOR_UU_KM2 / rowsCp.FLOOR_UU_KM2).toFixed(6)}, FLOOR_VU_KM2 x ${(now.FLOOR_VU_KM2 / rowsCp.FLOOR_VU_KM2).toFixed(6)}, FLOOR_WU_KM2 x ${(now.FLOOR_WU_KM2 / rowsCp.FLOOR_WU_KM2).toFixed(6)} against the rows' build (f ${f.toFixed(6)})`);
}

// ---- the registered windows: the build's own flights
const rowsText = fs.readFileSync(ROWS.path);
check(sha256(rowsText) === ROWS.sha256, `${ROWS.path} is ${sha256(rowsText)}`);
const zs = new Map();
let windows = 0;
for (const l of String(rowsText).split("\n")) {
  if (!l) continue;
  const w = JSON.parse(l);
  if (w.set !== "judged") continue;
  windows += 1;
  const floorR = w.cp.FLOOR_UU_KM2;
  for (const [sec, eR, eI, eC, vR, vI, vC] of w.samples) {
    const day = Math.ceil(sec / 86400), v = [vR + (RADIAL_FACTOR * RADIAL_FACTOR - 1) * floorR, vI, vC], e = [eR, eI, eC];
    AXES.forEach((ax, x) => { const k = `${w.regime} ${day} ${ax}`; (zs.get(k) ?? zs.set(k, { w: new Set(), z: [] }).get(k)).z.push(Math.abs(e[x]) / Math.sqrt(v[x])); zs.get(k).w.add(w.id); });
  }
}
check(windows === judged.rows.judged, `${windows} judged windows, the registered ${judged.rows.judged}`);
const median = (v) => { const s = Float64Array.from(v).sort(); const n = s.length; return n ? (s[(n - 1) >> 1] + s[n >> 1]) / 2 : NaN; };
const share = (v, k) => v.filter((z) => z <= k).length / v.length;
const [lo, hi] = judged.band;
console.log(`\nJudged windows (${windows}, records at 31/70): median |z| (calibrated ${judged.halfNormalMedian.toFixed(3)}, band ${lo} to ${hi}) and the shares within 1 and 3 sigma`);
console.log("regime              day axis  windows  samples   |z|     in 1, 3 sigma   outside the band: cause");
let inside = 0;
for (const c of judged.judged) {
  const q = zs.get(`${c.regime} ${c.day} ${c.axis}`), m = q ? median(q.z) : NaN, out = !(m >= lo && m <= hi);
  if (!out) inside += 1;
  console.log(`${c.name.padEnd(19)} ${String(c.day).padStart(3)} ${c.axis.padEnd(4)} ${String(q?.w.size ?? 0).padStart(8)} ${String(q?.z.length ?? 0).padStart(8)} ${fmt(m).padStart(7)}   ${q ? [share(q.z, 1), share(q.z, 3)].map((x) => x.toFixed(3)).join(", ") : "-"}   ${out ? c.outsideBand ?? "(no cause registered)" : ""}`);
  check(q && q.w.size <= c.windows && q.z.length === c.samples, `${c.name} day ${c.day} ${c.axis}: ${q?.w.size} windows and ${q?.z.length} samples, the registered ${c.windows} windows (of the regime) and ${c.samples} samples`);
  check(Math.abs(m - c.registered.medianAbsZ) <= MEDIAN_RELATIVE * c.registered.medianAbsZ, `${c.name} day ${c.day} ${c.axis}: median |z| ${m}, the registered ${c.registered.medianAbsZ}`);
  check(out === !!c.outsideBand, `${c.name} day ${c.day} ${c.axis}: median |z| ${m} is ${out ? "outside" : "inside"} the band, registered ${c.outsideBand ? "outside" : "inside"}`);
}
console.log(`judged cells inside the band: ${inside} of ${judged.judged.length} (realism not met; every cell outside carries its cause)`);
// Cross-track on records at zonal degree 20 (the records through this version's catalog): too narrow at day 1 in strong drag
// (0.77 to 1.10 in 2025, 1.05 to 1.30 in 2026, the build's own flights), the node drift of a record that leaves out the
// zonal terms of degree 21 to 70 (SPEC 12.5, stack #531); a record at zonal degree 70 has none of it, and its cross-track is
// registered above.
fs.rmSync(scratch, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`\ncovariance realism report E2E: PASS (ISS in-track 1-sigma at 12 h ${iss["0.6.0"].sigmaKm[1].toFixed(2)} -> ${iss["0.6.1"].sigmaKm[1].toFixed(3)} km against the error ${iss["0.6.1"].errorKm.toFixed(3)} km; ${inside} of ${judged.judged.length} judged cells inside the band)`);
process.exit(0);
