#!/usr/bin/env node
// E2E (stack #471, #463; SPEC 12.5 and 12.8 "The strong-drag class"): an AP set under the drag with its perigee under
// 600 km (e at most 0.3), fitted under NRLMSISE-00 on BTERM's default prior over an arc inside a row's calibrated span (21.6
// to 25.2 h or 64.8 to 75.6 h), states its sigma of ln BTERM by the arc's information over m^2 combined with the prior's,
// written into the covariance as a rank-1 update along BTERM's own column, and s_d takes the class's share c. Everything
// else is as fitted.
// Model truth: the module's own AP flight (caps 31 and 20, NRLMSISE-00 on constant daily rows) of a set at a 412 km
// perigee (n 15.48 rev/day, e 0.0013, i 87.3, BTERM 0.008, AGOM 0.004), in GCRF at 300 s, the arc ending at the cutoff.
// The reference is the same fit with FIT.DRAG_PRIOR stated as the default's own values (LOG_NORMAL, median 0.01 m^2/kg,
// sigma of the log ln 10): a stated prior is outside the class, so its record is the fit as it was before the class.
// 1. 24 h and 72 h arcs: the two records' MEAN_ELEMENTS are bit for bit (the fit is not touched); the default's sigma of
//    ln BTERM is sqrt(1 / ((1 / s_f^2 - 1 / s_p^2) / m^2 + 1 / s_p^2)) of the stated one's s_f (s_p = ln 10; m 9.22 and
//    14.5) to 1e-9; its covariance is the stated one's plus alpha u u^T (u BTERM's column of the stated one, alpha =
//    (s_h^2 / s_f^2 - 1) / C_BB) to 1e-9 of sqrt(C_ii C_jj); NON_GRAVITATIONAL_SHARE is 0.126 and 0.163 (the stated
//    record's 0.112126311682426) with s_d = share |ng| n to 1e-12; the OD COMMENT names the class.
// 2. Outside the class: a 48 h arc, and a 24 h arc of the same orbit 300 km higher (perigee about 712 km, where the
//    default's median is 0.002), each fitted on the default and on its values stated: the two records are bit for bit
//    but for FIT_STATISTICS.PCF_CID, the content id of each call's own $PCF.
// 3. The 72 h default record flies with its covariance (propagate, COVARIANCE_MATRIX_LINES at 7 days).
// JS only moves bytes and compares numbers the module produced.
//   node test/drag-term-strong-drag-class.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as BlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { prwDynamicParameter } from "spacedatastandards.org/lib/js/OCM/prwDynamicParameter.js";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { configuration, prior, pcfPriorForm } from "./lib/pcf.mjs";
import { T, AP_FORCES, ocmOf, seedOcm, rowsThrough, spwStream, flight, repackOcm } from "./lib/ocm.mjs";
import { packOem, rfm } from "./lib/frames.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const HOUR = 3600000, DAY = 86400000, CUTOFF = Date.parse("2026-09-04T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const rows = [];
for (let k = -6; k <= 45; k++) rows.push({ DATE: new Date(CUTOFF + k * DAY).toISOString().slice(0, 10), F107_OBS: 150, F107_OBS_CENTER81: 150, AP_AVG: 15, F107_DATA_TYPE: 0 });
const spw = rowsThrough(rows);
const SIGMA_P = Math.log(10);
const ROWS = { 24: { m: 9.22, c: 0.126 }, 72: { m: 14.5, c: 0.163 } };
const C_DRAG = 0.112126311682426;
const LOW = { n: 15.4827, e: 0.0013, i: 87.34, raan: 40, argp: 90, ma: 10, bterm: 0.008, agom: 0.004 };
const HIGH = { ...LOW, n: 14.62 };
const STATED = { DRAG_PRIOR: prior(0.01, SIGMA_P), DRAG_PRIOR_FORM: pcfPriorForm.LOG_NORMAL };

async function fly(record, times) {
  const r = await h.invoke({ methodId: "propagate", inputs: flight([record], { output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0];
}
/** The orbit's own flight over `hours` before CUTOFF, as an $OEM. */
async function arcOf(o, hours) {
  const start = CUTOFF - hours * HOUR;
  const seed = seedOcm({ epoch: iso(start), ...o, norad: 99471, msis: true, records: true, tesseral: 31, zonal: 20, rows: spw });
  const lines = (await fly(seed, Array.from({ length: hours * 12 + 1 }, (_, k) => start + k * 300000))).EPHEMERIS_DATA_LINES;
  const block = Object.assign(new BlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99471, OBJECT_NAME: "STRONG DRAG CLASS E2E" }), CENTER_NAME: "EARTH",
    REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH,
    USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
  return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] }));
}
async function fitOf(oem, fit = null) {
  const r = await h.invoke({ methodId: "fit", inputs: [configuration({ theory: "AP", forces: AP_FORCES, ...(fit ? { fit } : {}) }),
    { portId: "space_weather", typeRef: T("SPW"), payload: spwStream(spw) }, { portId: "ephemeris", typeRef: T("OEM"), payload: oem }] });
  if (r.statusCode !== 0) throw new Error(`fit: ${r.errorCode} ${r.errorMessage}`);
  return new Uint8Array(r.outputs.find((x) => x.portId === "elements").payload);
}
const ix = (i, j) => (i >= j ? (i * (i + 1)) / 2 + j : (j * (j + 1)) / 2 + i);
function covOf(bytes) {
  const o = ocmOf(bytes), kinds = o.COV_PARAMETER_KINDS ?? [], N = 6 + kinds.length;
  const at = 6 + kinds.indexOf(prwDynamicParameter.DRAG_AREA_OVER_MASS);
  const cv = o.COVARIANCE_DATA ?? [];
  const C = (i, j) => cv[ix(i, j)];
  return { o, N, at, C, cv, b: o.MEAN_ELEMENTS.BTERM, sigma: Math.sqrt(C(at, at)) / o.MEAN_ELEMENTS.BTERM, cp: o.COV_PROPAGATION,
    comment: [].concat(o.ORBIT_DETERMINATION?.COMMENT ?? []).join(" | ") };
}
// the records of the two calls, but for FIT_STATISTICS.PCF_CID (the content id of each call's own $PCF)
const noCid = (bytes) => repackOcm(bytes, (t) => { t.ORBIT_DETERMINATION.FIT_STATISTICS.PCF_CID = null; });
const sameBytes = (a, b) => { const x = noCid(a), y = noCid(b); return x.length === y.length && x.every((v, k) => v === y[k]); };
const sameElements = (a, b) => JSON.stringify(a.MEAN_ELEMENTS) === JSON.stringify(b.MEAN_ELEMENTS);

// 1. inside the class
for (const hours of [24, 72]) {
  const oem = await arcOf(LOW, hours);
  const d = covOf(await fitOf(oem)), s = covOf(await fitOf(oem, STATED));
  const { m, c } = ROWS[hours];
  const want = Math.sqrt(1 / ((1 / s.sigma ** 2 - 1 / SIGMA_P ** 2) / (m * m) + 1 / SIGMA_P ** 2));
  const alpha = (want ** 2 / s.sigma ** 2 - 1) / s.C(s.at, s.at);
  let worst = 0;
  for (let i = 0; i < s.N; i++)
    for (let j = 0; j <= i; j++) {
      const exp = s.C(i, j) + alpha * s.C(i, s.at) * s.C(j, s.at);
      worst = Math.max(worst, Math.abs(d.C(i, j) - exp) / Math.sqrt(Math.abs(d.C(i, i) * d.C(j, j))));
    }
  const n = d.o.MEAN_ELEMENTS.MEAN_MOTION * 2 * Math.PI;
  const sd = d.cp.NON_GRAVITATIONAL_SHARE * Math.abs(d.cp.NON_GRAVITATIONAL_RATE_PER_DAY) * n;
  console.log(`${hours} h: BTERM ${d.b}, sigma of ln BTERM ${d.sigma} (stated prior: ${s.sigma}; the rule ${want}), share ${d.cp.NON_GRAVITATIONAL_SHARE} ` +
    `(stated prior: ${s.cp.NON_GRAVITATIONAL_SHARE}), rank-1 residual ${worst.toExponential(2)}; ${d.comment.split(" | ").find((x) => x.startsWith("drag term")) ?? "no class note"}`);
  check(sameElements(d.o, s.o), `${hours} h: the two fits' MEAN_ELEMENTS differ`);
  check(Math.abs(d.sigma / want - 1) <= 1e-9, `${hours} h: sigma of ln BTERM ${d.sigma}, not the rule's ${want}`);
  check(d.sigma > s.sigma, `${hours} h: the class's sigma ${d.sigma} is not above the arc's ${s.sigma}`);
  check(worst <= 1e-9, `${hours} h: the covariance is not the rank-1 update along BTERM's column (worst ${worst})`);
  check(d.cp.NON_GRAVITATIONAL_SHARE === c && s.cp.NON_GRAVITATIONAL_SHARE === C_DRAG, `${hours} h: shares ${d.cp.NON_GRAVITATIONAL_SHARE} and ${s.cp.NON_GRAVITATIONAL_SHARE}`);
  check(Math.abs(d.cp.NOISE_NON_GRAVITATIONAL_RAD_DAY2 - sd) <= 1e-12 * Math.abs(sd), `${hours} h: s_d ${d.cp.NOISE_NON_GRAVITATIONAL_RAD_DAY2} against share |ng| n ${sd}`);
  check(/drag term: the strong-drag class/.test(d.comment) && !/strong-drag class/.test(s.comment), `${hours} h: the OD COMMENT does not name the class (or names it on the stated prior's record)`);
  if (hours === 72) {
    const flown = await fly(await fitOf(oem), [CUTOFF + 7 * DAY]);
    check((flown.COVARIANCE_MATRIX_LINES?.length ?? 0) === 1, `72 h: the class's record flown 7 days gives ${flown.COVARIANCE_MATRIX_LINES?.length ?? 0} covariance lines`);
  }
}
// 2. outside it: the default and the stated prior's records are the same bytes
for (const [name, o, hours, stated] of [["48 h arc at a 412 km perigee", LOW, 48, STATED],
  ["24 h arc at a 712 km perigee", HIGH, 24, { ...STATED, DRAG_PRIOR: prior(0.002, SIGMA_P) }]]) {
  const oem = await arcOf(o, hours);
  const d = await fitOf(oem), s = await fitOf(oem, stated);
  const dc = covOf(d);
  console.log(`${name}: share ${dc.cp.NON_GRAVITATIONAL_SHARE}, sigma of ln BTERM ${dc.sigma}; records ${sameBytes(d, s) ? "bit for bit" : "DIFFER"}`);
  check(sameBytes(d, s), `${name}: the default's record differs from the stated prior's`);
  check(dc.cp.NON_GRAVITATIONAL_SHARE === C_DRAG, `${name}: share ${dc.cp.NON_GRAVITATIONAL_SHARE}, not the DRAG row's`);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\ndrag term strong-drag class E2E: PASS");
process.exit(0);
