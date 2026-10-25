#!/usr/bin/env node
// SDN-AP environment E2E: real space weather and an open-DCA common mode, read as FFM reads them.
// - $SPW: the experiment lane's environment (a size-prefixed $PRW whose SPACE_WEATHER holds GFZ/SWPC $SPW rows), loaded
//   through the load_environment method; checked against FFM's reading at UTC instants: F10.7 the observed flux of the day
//   before, F10.7a the 81-day centered mean and Ap the daily Ap of the day.
// - $DCL: no open-DCA $DCL has been published yet, so a synthetic one (Solved, NRLMSISE-00 baseline, LogDensityNodes every
//   3 h) is built with the SDS 1.261.0 builders and loaded through sdnap_load_density_correction and through the invoke
//   surface (load_environment's 'density_correction' port, the same loader); s(t) must follow FFM's
//   handling: linear between UTC nodes, held at the end values outside them.
//   node test/environment.e2e.mjs [--environment FILE]
import fs from "node:fs";
import * as flatbuffers from "flatbuffers";
import { DCL } from "spacedatastandards.org/lib/js/DCL/DCL.js";
import { dclCorrection } from "spacedatastandards.org/lib/js/DCL/dclCorrection.js";
import { ATM } from "spacedatastandards.org/lib/js/DCL/ATM.js";
import { AtmosphericModelFamily } from "spacedatastandards.org/lib/js/DCL/AtmosphericModelFamily.js";
import { dclCorrectionForm } from "spacedatastandards.org/lib/js/DCL/dclCorrectionForm.js";
import { dclStatus } from "spacedatastandards.org/lib/js/DCL/dclStatus.js";
import { PRW } from "spacedatastandards.org/lib/js/PRW/PRW.js";
import { openModule } from "./lib/module.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ENVIRONMENT = arg("--environment", "/opt/data/sdn-archive/sdn-gp-starlink-ffm-match/environment/environment.json");

const m = await openModule();
const x = m.x;
const failures = [];
const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) failures.push(`${what}: ${a} vs ${b}`); };
const envAt = (d50) => {
  const p = x.sdnap_alloc(32);
  x.sdnap_environment_at(d50, p);
  const v = Array.from(new Float64Array(m.harness.memory.buffer, p, 4));
  x.sdnap_free(p);
  return v;
};
const d50Of = (iso) => (Date.parse(`${iso}Z`) / 86400000 + 2440587.5) - 2433281.5;

// --- space weather
const env = JSON.parse(fs.readFileSync(ENVIRONMENT, "utf8"));
const prwBytes = new Uint8Array(Buffer.from(env.inputs.space_weather, "base64"));
const load = await m.harness.invoke({
  methodId: "load_environment",
  inputs: [{ portId: "space_weather_table", typeRef: { schemaName: "PRW.fbs", fileIdentifier: "$PRW", rootTypeName: "PRW" }, payload: prwBytes }],
});
if (load.statusCode !== 0) failures.push(`load_environment: ${load.errorCode} ${load.errorMessage}`);
const prw = PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(prwBytes));
const table = prw.SPACE_WEATHER();
const rows = [];
for (let i = 0; i < table.rowsLength(); i += 1) {
  const r = table.ROWS(i);
  rows.push({ date: r.DATE(), f107: r.F107_OBS(), f107a: r.F107_OBS_CENTER81(), ap: r.AP_AVG() });
}
const days = x.sdnap_space_weather_days();
if (days !== new Set(rows.map((r) => r.date)).size) failures.push(`space weather days ${days} vs ${rows.length} rows`);
let checked = 0;
for (let i = 1; i < rows.length; i += Math.max(1, Math.floor(rows.length / 400))) {
  const [f107, f107a, ap] = envAt(d50Of(`${rows[i].date}T07:30:00`));
  near(f107, rows[i - 1].f107, 1e-3, `F10.7 on ${rows[i].date}`);
  near(f107a, rows[i].f107a, 1e-3, `F10.7a on ${rows[i].date}`);
  near(ap, rows[i].ap, 1e-9, `Ap on ${rows[i].date}`);
  checked += 1;
}

// --- density correction (synthetic)
const t0 = Date.parse("2026-10-18T00:00:00Z");
const times = [], values = [];
for (let k = 0; k <= 80; k += 1) { times.push(BigInt(t0 + k * 3 * 3600000)); values.push(0.1 * Math.sin((2 * Math.PI * k) / 40) - 0.05); }
const b = new flatbuffers.Builder(4096);
const tv = dclCorrection.createNodeTimesMsVector(b, times);
const vv = dclCorrection.createNodeLogDensityScaleDimensionlessVector(b, values);
dclCorrection.startdclCorrection(b);
dclCorrection.addForm(b, dclCorrectionForm.LogDensityNodes);
dclCorrection.addNodeTimesMs(b, tv);
dclCorrection.addNodeLogDensityScaleDimensionless(b, vv);
const corr = dclCorrection.enddclCorrection(b);
ATM.startATM(b);
ATM.addModel(b, AtmosphericModelFamily.NRLMSIS00E);
const atm = ATM.endATM(b);
DCL.startDCL(b);
DCL.addAtmosphere(b, atm);
DCL.addCorrection(b, corr);
DCL.addStatus(b, dclStatus.Solved);
DCL.finishDCLBuffer(b, DCL.endDCL(b));
const dclBytes = b.asUint8Array();
const pd = x.sdnap_alloc(dclBytes.length);
new Uint8Array(m.harness.memory.buffer, pd, dclBytes.length).set(dclBytes);
const st = x.sdnap_load_density_correction(pd, dclBytes.length);
x.sdnap_free(pd);
if (st !== 0) failures.push(`sdnap_load_density_correction returned ${st}`);
const sAt = (ms) => envAt(ms / 86400000 + 2440587.5 - 2433281.5)[3];
for (let k = 0; k < 80; k += 7) {
  near(sAt(t0 + k * 3 * 3600000), values[k], 1e-12, `s at node ${k}`);
  near(sAt(t0 + (k + 0.5) * 3 * 3600000), 0.5 * (values[k] + values[k + 1]), 1e-9, `s between nodes ${k}, ${k + 1}`);
}
near(sAt(t0 - 86400000), values[0], 1e-12, "s before the first node");
near(sAt(t0 + 81 * 3 * 3600000), values[80], 1e-12, "s after the last node");

// --- the same $DCL through the invoke surface: load_environment's 'density_correction' port. A flat s = 0 is loaded
// first through the export, so the port's effect is seen.
const flat = (() => {
  const fb = new flatbuffers.Builder(1024);
  const ftv = dclCorrection.createNodeTimesMsVector(fb, [BigInt(t0), BigInt(t0 + 3600000)]);
  const fvv = dclCorrection.createNodeLogDensityScaleDimensionlessVector(fb, [0, 0]);
  dclCorrection.startdclCorrection(fb);
  dclCorrection.addForm(fb, dclCorrectionForm.LogDensityNodes);
  dclCorrection.addNodeTimesMs(fb, ftv);
  dclCorrection.addNodeLogDensityScaleDimensionless(fb, fvv);
  const fc = dclCorrection.enddclCorrection(fb);
  ATM.startATM(fb);
  ATM.addModel(fb, AtmosphericModelFamily.NRLMSIS00E);
  const fa = ATM.endATM(fb);
  DCL.startDCL(fb);
  DCL.addAtmosphere(fb, fa);
  DCL.addCorrection(fb, fc);
  DCL.addStatus(fb, dclStatus.Solved);
  DCL.finishDCLBuffer(fb, DCL.endDCL(fb));
  return fb.asUint8Array();
})();
const pf = x.sdnap_alloc(flat.length);
new Uint8Array(m.harness.memory.buffer, pf, flat.length).set(flat);
x.sdnap_load_density_correction(pf, flat.length);
x.sdnap_free(pf);
near(sAt(t0 + 1.5 * 3 * 3600000), 0, 0, "s after the flat $DCL");
const dclType = { schemaName: "DCL.fbs", fileIdentifier: "$DCL", rootTypeName: "DCL" };
const viaPort = await m.harness.invoke({ methodId: "load_environment", inputs: [{ portId: "density_correction", typeRef: dclType, payload: dclBytes }] });
if (viaPort.statusCode !== 0) failures.push(`load_environment($DCL) returned ${viaPort.statusCode} ${viaPort.errorCode}`);
for (let k = 0; k < 80; k += 7) near(sAt(t0 + (k + 0.5) * 3 * 3600000), 0.5 * (values[k] + values[k + 1]), 1e-9, `port: s between nodes ${k}, ${k + 1}`);
// a calibration that is not Solved is refused by name
const bad = new flatbuffers.Builder(256);
ATM.startATM(bad);
ATM.addModel(bad, AtmosphericModelFamily.NRLMSIS00E);
const badAtm = ATM.endATM(bad);
DCL.startDCL(bad);
DCL.addAtmosphere(bad, badAtm);
DCL.finishDCLBuffer(bad, DCL.endDCL(bad));
const refused = await m.harness.invoke({ methodId: "load_environment", inputs: [{ portId: "density_correction", typeRef: dclType, payload: bad.asUint8Array() }] });
if (refused.statusCode === 0 || refused.errorCode !== "invalid-density-correction") failures.push(`unsolved $DCL: ${refused.statusCode} ${refused.errorCode}`);

// --- a real density correction: E13's open-DCA reference check (test B, 2026-04-01..07-31), Swarm A's measured
// log-density offsets from NRLMSISE-00 per 12 h window, carried as an SDS $DCL (Solved, NRLMSISE-00, LogDensityNodes at
// the window centers) and loaded through the port. SDN-AP drag through the shared kernel and the direct path must
// scale by exp(s(t)) exactly, and the kernel must agree with the direct path within 1 % (DESIGN 2a.7).
const REAL = arg("--real-dcl", "/opt/data/sdn-archive/e13-open-dca/density/testB-msis/swarmA.json");
let realCheck = null;
if (fs.existsSync(REAL)) {
  const src = JSON.parse(fs.readFileSync(REAL, "utf8"));
  const wins = src.windows.filter((w) => Number.isFinite(w.x));
  const rb = new flatbuffers.Builder(1 << 16);
  const rt = dclCorrection.createNodeTimesMsVector(rb, wins.map((w) => BigInt(w.startMs + 6 * 3600000)));
  const rv = dclCorrection.createNodeLogDensityScaleDimensionlessVector(rb, wins.map((w) => w.x));
  dclCorrection.startdclCorrection(rb);
  dclCorrection.addForm(rb, dclCorrectionForm.LogDensityNodes);
  dclCorrection.addNodeTimesMs(rb, rt);
  dclCorrection.addNodeLogDensityScaleDimensionless(rb, rv);
  const rc = dclCorrection.enddclCorrection(rb);
  ATM.startATM(rb);
  ATM.addModel(rb, AtmosphericModelFamily.NRLMSIS00E);
  const ra = ATM.endATM(rb);
  DCL.startDCL(rb);
  DCL.addAtmosphere(rb, ra);
  DCL.addCorrection(rb, rc);
  DCL.addStatus(rb, dclStatus.Solved);
  DCL.finishDCLBuffer(rb, DCL.endDCL(rb));
  const realBytes = rb.asUint8Array();
  // one SDN-AP row near Swarm A (430 km, 87.4 deg) at three window centers
  const centres = [40, 120, 200].map((k) => wins[k]);
  const rowAt = (w) => ({ epochWhole: Math.floor(w.startMs / 86400000) + 2440587.5, epochFrac: ((w.startMs % 86400000) + 6 * 3600000) / 86400000,
    meanMotion: 15.56, ecc: 0.0005, inc: 87.35, raan: 100, argp: 90, ma: 0, bterm: 0.01, agom: 0, norad: 39452, theory: 16 });
  const ndot = () => centres.map((w, k) => m.xpNative(k, 0).rates[5]);
  // the drag's n-dot alone: the shallow tesseral resonance (2d, density-independent) is off for this leg
  const shallowDegree = x.sdnap_shallow_resonance(0, 0, 0);
  m.init(centres.map(rowAt));
  const res = {};
  for (const kernel of [1, 0]) {
    x.sdnap_set_density_kernel(kernel);
    const pf2 = x.sdnap_alloc(flat.length);
    new Uint8Array(m.harness.memory.buffer, pf2, flat.length).set(flat);
    x.sdnap_load_density_correction(pf2, flat.length);
    x.sdnap_free(pf2);
    m.init(centres.map(rowAt));
    const base = ndot();
    const load = await m.harness.invoke({ methodId: "load_environment", inputs: [{ portId: "density_correction", typeRef: dclType, payload: realBytes }] });
    if (load.statusCode !== 0) failures.push(`real $DCL refused: ${load.errorCode}`);
    m.init(centres.map(rowAt));
    const withDcl = ndot();
    res[kernel ? "kernel" : "direct"] = { base, withDcl };
    centres.forEach((w, k) => near(withDcl[k] / base[k], Math.exp(w.x), 1e-12 * Math.exp(Math.abs(w.x)), `exp(s) scaling, ${kernel ? "kernel" : "direct"} path, window ${k}`));
  }
  x.sdnap_set_density_kernel(1);
  x.sdnap_shallow_resonance(shallowDegree, 0, 0);
  centres.forEach((w, k) => near(res.kernel.withDcl[k] / res.direct.withDcl[k], 1, 0.01, `kernel against direct path, window ${k}`));
  realCheck = { source: REAL, nodes: wins.length, s: centres.map((w) => +w.x.toFixed(4)),
    kernelOverDirect: centres.map((w, k) => +(res.kernel.withDcl[k] / res.direct.withDcl[k]).toFixed(5)) };
}

console.log(JSON.stringify({ spaceWeatherRows: rows.length, daysHeld: days, firstDate: rows[0].date, lastDate: rows[rows.length - 1].date,
  checkedDays: checked, dclNodes: times.length, dclSource: "synthetic (no open-DCA $DCL published yet)", dclPort: viaPort.statusCode === 0, realDcl: realCheck, failures: failures.slice(0, 10) }, null, 1));
process.exit(failures.length ? 1 : 0);
