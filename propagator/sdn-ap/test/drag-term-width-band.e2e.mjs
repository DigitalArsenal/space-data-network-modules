#!/usr/bin/env node
// E2E (stack #471, #463; SPEC 12.8 "The drag term's width at 600 to 2,500 km"): an AP set at e 0.3 or below with its
// perigee at 600 to 2,500 km, fitted under NRLMSISE-00 on BTERM's default prior over a span inside one of width 1's rows,
// states BTERM's sigma of ln as the arc's information over m^2 combined with the prior's on BTERM's diagonal alone, and
// names the rule in a second COV_REALISM entry. The width is stated, not mapped: the reader derives m and the prior's
// sigma from the record's own fields, checks them against the entry's text, and maps the formal variance, so the forecast
// is the same as without the rule; an entry it does not know, or whose figures are not the rule's, maps as stated and the
// flight's COMMENT says so.
// Model truth: the module's own AP flight (caps 31 and 20, NRLMSISE-00 on constant daily rows) of a set at a 700 km
// perigee (n 14.587 rev/day, e 0.001, i 98.2, BTERM 0.008, AGOM 0.005), in GCRF at 300 s, the arc ending at the cutoff.
// The reference is the same fit with FIT.DRAG_PRIOR stated as the default's values there (LOG_NORMAL, median 0.002,
// sigma of the log ln 10): a stated prior is outside the rule.
// 1. 72 h and 24 h arcs (m 11 and 7.75): MEAN_ELEMENTS bit for bit; the default's second COV_REALISM entry is
//    "sdn-ap drag-term width 1: m <m>, prior sigma 2.30259; stated, not mapped" and the reference has one entry; the
//    default's sigma of ln BTERM is sqrt(1 / ((1 / s_f^2 - 1 / s_p^2) / m^2 + 1 / s_p^2)) of the reference's s_f to
//    1e-9; every other COVARIANCE_DATA entry is the reference's, bit for bit.
// 2. Both records flown at 1, 3 and 7 days: the states bit for bit, the covariance lines the same to 1e-12 of each line's
//    largest entry, and no COMMENT on the default's block.
// 3. The 72 h record with the entry's m altered (11 to 12), and with an unknown rule number (width 9): the flight maps
//    the stated width (its covariance more than 1e-6 apart from the reference's) and its COMMENT says "mapped as stated".
// 4. Outside the rule: a 24 h arc at a 412 km perigee fitted both ways: one COV_REALISM entry, records bit for bit but
//    for FIT_STATISTICS.PCF_CID.
// JS only moves bytes and compares numbers the module produced.
//   node test/drag-term-width-band.e2e.mjs
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
const M = { 24: 7.75, 72: 11 };
const BAND = { n: 14.587, e: 0.001, i: 98.2, raan: 40, argp: 90, ma: 10, bterm: 0.008, agom: 0.005 };
const LOW = { n: 15.4827, e: 0.0013, i: 87.34, raan: 40, argp: 90, ma: 10, bterm: 0.008, agom: 0.004 };
const STATED = (median) => ({ DRAG_PRIOR: prior(median, SIGMA_P), DRAG_PRIOR_FORM: pcfPriorForm.LOG_NORMAL });

async function fly(record, times) {
  const r = await h.invoke({ methodId: "propagate", inputs: flight([record], { output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.GCRF } }) });
  if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode} ${r.errorMessage}`);
  return OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(r.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0];
}
async function arcOf(o, hours) {
  const start = CUTOFF - hours * HOUR;
  const seed = seedOcm({ epoch: iso(start), ...o, norad: 99472, msis: true, records: true, tesseral: 31, zonal: 20, rows: spw });
  const lines = (await fly(seed, Array.from({ length: hours * 12 + 1 }, (_, k) => start + k * 300000))).EPHEMERIS_DATA_LINES;
  const block = Object.assign(new BlockT(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99472, OBJECT_NAME: "DRAG TERM WIDTH E2E" }), CENTER_NAME: "EARTH",
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
const drag = (o) => { const at = 6 + o.COV_PARAMETER_KINDS.indexOf(prwDynamicParameter.DRAG_AREA_OVER_MASS); return { at, sigma: Math.sqrt(o.COVARIANCE_DATA[ix(at, at)]) / o.MEAN_ELEMENTS.BTERM }; };
const noCid = (bytes) => repackOcm(bytes, (t) => { t.ORBIT_DETERMINATION.FIT_STATISTICS.PCF_CID = null; });
const sameBytes = (a, b) => { const x = noCid(a), y = noCid(b); return x.length === y.length && x.every((v, k) => v === y[k]); };
const COV = ["CX_X", "CY_X", "CY_Y", "CZ_X", "CZ_Y", "CZ_Z", "CX_DOT_X", "CX_DOT_Y", "CX_DOT_Z", "CX_DOT_X_DOT", "CY_DOT_X", "CY_DOT_Y", "CY_DOT_Z",
  "CY_DOT_X_DOT", "CY_DOT_Y_DOT", "CZ_DOT_X", "CZ_DOT_Y", "CZ_DOT_Z", "CZ_DOT_X_DOT", "CZ_DOT_Y_DOT", "CZ_DOT_Z_DOT"];
/** The largest difference of two flights' covariance lines over each line's largest entry. */
function covApart(a, b) {
  let worst = 0;
  a.COVARIANCE_MATRIX_LINES.forEach((la, k) => {
    const lb = b.COVARIANCE_MATRIX_LINES[k];
    const big = Math.max(...COV.map((f) => Math.abs(la[f] ?? 0)));
    for (const f of COV) worst = Math.max(worst, Math.abs((la[f] ?? 0) - (lb[f] ?? 0)) / big);
  });
  return worst;
}
const sameStates = (a, b) => a.EPHEMERIS_DATA_LINES.every((l, k) => ["X", "Y", "Z", "X_DOT", "Y_DOT", "Z_DOT"].every((f) => l[f] === b.EPHEMERIS_DATA_LINES[k][f]));
const times = [CUTOFF + DAY, CUTOFF + 3 * DAY, CUTOFF + 7 * DAY];

for (const hours of [72, 24]) {
  const oem = await arcOf(BAND, hours);
  const dBytes = await fitOf(oem), sBytes = await fitOf(oem, STATED(0.002));
  const d = ocmOf(dBytes), s = ocmOf(sBytes);
  const dd = drag(d), ds = drag(s);
  const m = M[hours];
  const want = Math.sqrt(1 / ((1 / ds.sigma ** 2 - 1 / SIGMA_P ** 2) / (m * m) + 1 / SIGMA_P ** 2));
  const tag = `sdn-ap drag-term width 1: m ${m}, prior sigma 2.30259; stated, not mapped`;
  const others = d.COVARIANCE_DATA.every((v, k) => k === ix(dd.at, dd.at) || Object.is(v, s.COVARIANCE_DATA[k]));
  console.log(`${hours} h: BTERM ${d.MEAN_ELEMENTS.BTERM}, sigma of ln BTERM ${dd.sigma} (stated prior: ${ds.sigma}; the rule ${want}); entries ${d.COV_REALISM.length} / ${s.COV_REALISM.length}: ${d.COV_REALISM[1]?.MODEL_ID}`);
  check(JSON.stringify(d.MEAN_ELEMENTS) === JSON.stringify(s.MEAN_ELEMENTS), `${hours} h: MEAN_ELEMENTS differ`);
  check(d.COV_REALISM.length === 2 && d.COV_REALISM[1].MODEL_ID === tag && s.COV_REALISM.length === 1, `${hours} h: COV_REALISM ${JSON.stringify(d.COV_REALISM.map((c) => c.MODEL_ID))}`);
  check(Math.abs(dd.sigma / want - 1) <= 1e-9 && dd.sigma > ds.sigma, `${hours} h: sigma of ln BTERM ${dd.sigma}, not the rule's ${want}`);
  check(others, `${hours} h: an entry of COVARIANCE_DATA other than BTERM's diagonal differs from the reference's`);
  const fd = await fly(dBytes, times), fs = await fly(sBytes, times);
  const apart = covApart(fd, fs);
  console.log(`${hours} h: flights' states ${sameStates(fd, fs) ? "bit for bit" : "DIFFER"}, covariance apart ${apart.toExponential(2)} of a line's largest entry; COMMENT ${fd.COMMENT ?? "none"}`);
  check(sameStates(fd, fs), `${hours} h: the two records' flights differ in state`);
  check(apart <= 1e-12, `${hours} h: the forecast covariance is ${apart} apart from the reference's (the width is mapped)`);
  check(!fd.COMMENT, `${hours} h: the default record's flight has a COMMENT: ${fd.COMMENT}`);
  if (hours === 72) {
    for (const [label, edit] of [["m altered", (id) => id.replace("m 11,", "m 12,")], ["unknown rule", (id) => id.replace("width 1:", "width 9:")]]) {
      const bad = repackOcm(dBytes, (t) => { t.COV_REALISM[1].MODEL_ID = edit(t.COV_REALISM[1].MODEL_ID); });
      const fb = await fly(bad, times);
      const off = covApart(fb, fs);
      console.log(`72 h, ${label}: covariance ${off.toExponential(2)} apart from the reference's; COMMENT ${fb.COMMENT}`);
      check(off > 1e-6, `72 h, ${label}: the stated width was not mapped (${off} apart)`);
      check(/mapped as stated/.test(fb.COMMENT ?? ""), `72 h, ${label}: the flight's COMMENT does not say "mapped as stated": ${fb.COMMENT}`);
    }
  }
}
// 4. outside the rule
{
  const oem = await arcOf(LOW, 24);
  const d = await fitOf(oem), s = await fitOf(oem, STATED(0.01));
  console.log(`412 km perigee, 24 h: entries ${ocmOf(d).COV_REALISM.length}; records ${sameBytes(d, s) ? "bit for bit" : "DIFFER"}`);
  check(ocmOf(d).COV_REALISM.length === 1, "412 km: a width entry outside the rule");
  check(sameBytes(d, s), "412 km: the default's record differs from the stated prior's");
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\ndrag term width (600 to 2,500 km) E2E: PASS");
process.exit(0);
