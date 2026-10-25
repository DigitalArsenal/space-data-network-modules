#!/usr/bin/env node
// E2E (task modules-sdn-ap-reentry-sigma-calibration-20261025): the `reentry` window is calibrated.
//
// The window (DESIGN 5.2.3, eq. 20) is sigma_L^2 = L^2 [ b0^2 + (K s)^2 + sigma_d^2 g(L / tau) ], with g(x) = (2 / x)
// (1 - (1 / x)(1 - e^(-x))), b0 5 %, sigma_d 15 %, tau 2 days (REENTRY.WINDOW_*), s the set's fitted
// USER_DEFINED_SDNAP_B_EFF_SIGMA / B_eff and L the time to go from the data cutoff; sigma_L never exceeds L (the reentry
// follows the cutoff). Before this change the window was
// the density term and s alone: 50.2 % of the 1,740 scored predictions fell within 1 sigma of the observed time and
// 72.6 % within 2 sigma. K is the one calibrated constant.
//
//   1. The record test/results/reentry-calibration.json holds the 1,740 predictions of the experiment's M29 (57 objects
//      that reentered, 16 CORDS-observed (sample A) and 41 Space-Track TIP (sample B); local-only inputs, so the rows are
//      times, errors and window widths). This test recomputes from the rows: the coverage before and after, K by the
//      calibration rule (the K that holds the pooled 1-sigma and 2-sigma coverage inside 60-75 % and 90-98 % with the
//      largest margin), and the out-of-fold coverage (each object scored with a K calibrated on the other 56). The
//      out-of-fold pooled coverage must sit inside both bands; the Starlinks and the samples are reported beside it.
//   2. The module against the record: decaying SDN-AP sets with fitted B_eff sigmas, REENTRY_EPOCH_UNC against the
//      formula with the record's K (the sigma, the floor and the override REENTRY.WINDOW_BALLISTIC_SIGMA).
// JS moves bytes and counts; the trajectory, the window and the uncertainty are the module's.
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OMMUserDefinedParameter } from "spacedatastandards.org/lib/js/OMM/OMMUserDefinedParameter.js";
import { RDM } from "spacedatastandards.org/lib/js/RDM/RDM.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { wasmPath } from "./lib/module.mjs";
import { configuration, withConfiguration } from "./lib/pcf.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const record = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./results/reentry-calibration.json", import.meta.url)), "utf8"));
const { b0, density_sigma: SD, correlation_days: TAU, kappa: K } = record.model;
const pct = (x) => `${(100 * x).toFixed(1)} %`;

// ---- 1. the record ----------------------------------------------------------------------------------------------
const col = Object.fromEntries(record.predictions.columns.map((c, i) => [c, i]));
const rows = record.predictions.rows;
const N = rows.length;
const gOf = (L) => { const r = TAU / L; return 2 * r * (1 - r * (1 - Math.exp(-1 / r))); };
const lead = rows.map((r) => r[col.lead_h]), err = rows.map((r) => Math.abs(r[col.err_h])), s = rows.map((r) => r[col.s]);
const sigmaOf = (k) => lead.map((L, i) => L * Math.min(1, Math.sqrt(b0 * b0 + (k * s[i]) ** 2 + SD * SD * gOf(L / 24))));
const within = (sigma, pick, m) => { let n = 0, c1 = 0, c2 = 0; for (let i = 0; i < N; ++i) if (pick(i)) { ++n; if (err[i] <= m * sigma[i]) ++c1; if (err[i] <= 2 * m * sigma[i]) ++c2; } return { n, c1: c1 / n, c2: c2 / n }; };
const all = () => true;
const band = (c) => c.c1 >= 0.6 && c.c1 <= 0.75 && c.c2 >= 0.9 && c.c2 <= 0.98;
const margin = (c) => Math.min(c.c1 - 0.6, 0.75 - c.c1, c.c2 - 0.9, 0.98 - c.c2);
const objects = [...new Set(rows.map((r) => r[col.norad]))].sort((a, b) => a - b);
check(N === record.predictions.n && objects.length === record.predictions.objects, `the record's ${N} rows and ${objects.length} objects against ${record.predictions.n} and ${record.predictions.objects}`);

// the module's recorded widths against the formula (the rows carry rounded inputs)
{
  const mine = sigmaOf(K);
  let worst = 0;
  for (let i = 0; i < N; ++i) worst = Math.max(worst, Math.abs(rows[i][col.sigma_after_h] / mine[i] - 1));
  console.log(`recorded sigma_after against the formula with K ${K}: worst relative difference ${worst.toExponential(2)} over ${N} rows`);
  check(worst < 2e-3, `the recorded widths differ from the formula by ${worst}`);
}

// before and after, in sample
const sigmaBefore = rows.map((r) => r[col.sigma_before_h]), sigmaAfter = rows.map((r) => r[col.sigma_after_h]);
const groups = [["all", all], ["sample A (CORDS)", (i) => rows[i][col.sample] === "A"], ["sample B (TIP)", (i) => rows[i][col.sample] === "B"], ["Starlink", (i) => rows[i][col.starlink] === 1], ["other objects", (i) => rows[i][col.starlink] === 0]];
for (const [name, pick] of groups) {
  const b = within(sigmaBefore, pick, 1), a = within(sigmaAfter, pick, 1);
  console.log(`${name.padEnd(17)} n ${String(b.n).padStart(4)}  before ${pct(b.c1)} / ${pct(b.c2)}  after (in sample) ${pct(a.c1)} / ${pct(a.c2)}`);
  if (name === "all") {
    check(Math.abs(b.c1 - record.before.all.within1) < 1e-3 && Math.abs(b.c2 - record.before.all.within2) < 1e-3, `before: ${b.c1} / ${b.c2} against the record`);
    check(Math.abs(a.c1 - record.after_in_sample.all.within1) < 1e-3 && Math.abs(a.c2 - record.after_in_sample.all.within2) < 1e-3, `after: ${a.c1} / ${a.c2} against the record`);
  }
}

// the calibration rule: K on the grid 60, 62, ..., 520 with the largest margin to the acceptance box
const GRID = Array.from({ length: 231 }, (_, k) => 60 + 2 * k);
const SIGMAS = GRID.map(sigmaOf);
const kStar = (pick) => { let best = [-Infinity, 0]; GRID.forEach((k, g) => { const m = margin(within(SIGMAS[g], pick, 1)); if (m > best[0]) best = [m, k]; }); return best[1]; };
const kAll = kStar(all);
console.log(`calibration rule on all ${N} predictions: K ${kAll}`);
check(kAll === K, `K by the calibration rule ${kAll}, the record ${K}`);

// out of fold: leave one object out
const oof = new Array(N);
const byObject = new Map(objects.map((o) => [o, []]));
rows.forEach((r, i) => byObject.get(r[col.norad]).push(i));
const kLeft = [];
for (const o of objects) {
  const out = new Set(byObject.get(o));
  const k = kStar((i) => !out.has(i));
  kLeft.push(k);
  const sg = SIGMAS[GRID.indexOf(k)];
  for (const i of out) oof[i] = sg[i];
}
console.log(`leave one object out: K ${Math.min(...kLeft)} to ${Math.max(...kLeft)}`);
for (const [name, pick] of groups) {
  const c = within(oof, pick, 1);
  console.log(`${name.padEnd(17)} n ${String(c.n).padStart(4)}  out of fold ${pct(c.c1)} within 1 sigma, ${pct(c.c2)} within 2 sigma`);
  if (name === "all") {
    check(band(c), `out-of-fold pooled coverage ${pct(c.c1)} / ${pct(c.c2)} outside 60-75 % / 90-98 %`);
    check(Math.abs(c.c1 - record.out_of_fold_leave_one_object_out.all.within1) < 1e-3 && Math.abs(c.c2 - record.out_of_fold_leave_one_object_out.all.within2) < 1e-3, `out of fold ${c.c1} / ${c.c2} against the record`);
  }
}

// ---- 2. the module against the record ---------------------------------------------------------------------------
const EPOCH = "2026-10-20T12:00:00.000000", epochMs = Date.parse(EPOCH + "Z");
const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const ENV_FILE = process.env.SDNAP_FFM_ENVIRONMENT ?? "/opt/data/sdn-archive/sdn-gp-starlink-ffm-match/environment/environment.json";
const environment = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
const weatherFrame = { portId: "space_weather_table", typeRef: { schemaName: "PRW.fbs", fileIdentifier: "$PRW", rootTypeName: "PRW" }, payload: new Uint8Array(Buffer.from(environment.inputs.space_weather, "base64")) };
const base = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const command = withConfiguration({ invoke: (req) => base.invoke(req.methodId === "reentry" ? { ...req, inputs: [...req.inputs, weatherFrame] } : req) });
// a decaying SDN-AP set (250 km, B_eff 0.02 m^2/kg) whose fit ended `arcEndMin` minutes after its epoch with the fitted B_eff sigma `sigma` (m^2/kg)
const decaying = (sigma, arcEndMin) => {
  const b = new flatbuffers.Builder(256);
  const params = [["SDNAP_B_EFF", "0.02"], ["SDNAP_ARC_END_MIN", String(arcEndMin)], ...(sigma === null ? [] : [["SDNAP_B_EFF_SIGMA", String(sigma)]])]
    .map(([k, v]) => OMMUserDefinedParameter.createOMMUserDefinedParameter(b, b.createString(k), b.createString(v)));
  const vec = OMM.createUserDefinedParametersVector(b, params);
  const epoch = b.createString(EPOCH);
  OMM.startOMM(b);
  OMM.addUserDefinedParameters(b, vec);
  OMM.addEpoch(b, epoch);
  OMM.addMeanMotion(b, 16.08);
  OMM.addEccentricity(b, 0.0004);
  OMM.addInclination(b, 51.6);
  OMM.addRaOfAscNode(b, 40);
  OMM.addArgOfPericenter(b, 90);
  OMM.addMeanAnomaly(b, 10);
  OMM.addNoradCatId(b, 90041);
  OMM.addMeanElementTheory(b, 4);
  OMM.addBstar(b, 0.02);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array();
};
const windowOf = async (label, sigma, arcEndMin, reentry = {}) => {
  const r = await command.invoke({ methodId: "reentry", inputs: [configuration({ reentry }), { portId: "omm", typeRef: ommType, payload: decaying(sigma, arcEndMin) }] });
  if (r.statusCode !== 0) { failures.push(`${label}: ${r.errorCode} ${r.errorMessage}`); return null; }
  const d = RDM.getRootAsRDM(new flatbuffers.ByteBuffer(r.outputs.find((o) => o.portId === "reentry").payload));
  const Ld = (Date.parse(d.REENTRY_EPOCH() + "Z") - epochMs) / 86400e3 - arcEndMin / 1440;
  return { hours: d.REENTRY_EPOCH_UNC(), L: Ld, start: d.REENTRY_WINDOW_START(), end: d.REENTRY_WINDOW_END(), epoch: d.REENTRY_EPOCH() };
};
const expected = (L, sBeff, sigmaB = null) => 24 * L * Math.min(1, Math.sqrt((sigmaB === null ? b0 * b0 + (K * sBeff) ** 2 : sigmaB * sigmaB) + SD * SD * gOf(L)));
const widths = [];
for (const [label, sBeff, arcEndMin] of [["no fitted sigma, cutoff at the epoch", 0, 0], ["fitted sigma 0.04 % of B_eff, 2 d arc", 4e-4, 2880], ["fitted sigma 0.2 % of B_eff, 2 d arc", 2e-3, 2880], ["fitted sigma 0.5 % of B_eff, 3 d arc (the formula reaches 109 % of the time to go: capped there)", 5e-3, 4320]]) {
  const w = await windowOf(label, sBeff === 0 ? null : sBeff * 0.02, arcEndMin);
  if (!w) continue;
  const want = expected(w.L, sBeff);
  console.log(`module, ${label}: L ${w.L.toFixed(3)} d, 1 sigma ${w.hours.toFixed(3)} h (formula ${want.toFixed(3)} h)`);
  check(Math.abs(w.hours / want - 1) < 2e-4, `${label}: REENTRY_EPOCH_UNC ${w.hours} h against ${want} h`);
  widths.push(w.hours / (24 * w.L));
  if (sBeff === 5e-3) {
    const cutoff = epochMs + arcEndMin * 60e3;
    check(Math.abs(Date.parse(w.start + "Z") - cutoff) < 2e3, `the capped window starts at the data cutoff ${new Date(cutoff).toISOString()}: ${w.start}`);
  }
}
check(widths.length === 4 && Math.abs(widths[3] - 1) < 1e-5 && widths[2] > widths[1] && widths[1] > widths[0], `the window widens with the fitted B_eff sigma, to the time to go at most: ${widths.map((x) => x.toFixed(4)).join(" < ")}`);
// REENTRY.WINDOW_BALLISTIC_SIGMA replaces the ballistic term whole (the fitted sigma no longer enters)
{
  const w = await windowOf("override", 2e-3 * 0.02, 2880, { WINDOW_BALLISTIC_SIGMA: 0.02 });
  if (w) {
    const want = expected(w.L, 0, 0.02);
    console.log(`module, REENTRY.WINDOW_BALLISTIC_SIGMA 0.02 with a fitted sigma of 0.2 %: 1 sigma ${w.hours.toFixed(3)} h (formula ${want.toFixed(3)} h)`);
    check(Math.abs(w.hours / want - 1) < 2e-4, `override: REENTRY_EPOCH_UNC ${w.hours} h against ${want} h`);
  }
}

console.log(failures.length === 0 ? "\nreentry calibration E2E: PASS" : `\nreentry calibration E2E: FAIL\n  ${failures.join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
