#!/usr/bin/env node
// E2E (task modules-sdn-ap-products-parameters-20261105): the producer contract of SPEC 17 on the 0.4.0 fixture inputs
// (test/lib/fixture-inputs.mjs: 24 h of propagator/ffm's 550 km trajectory fitted under stock SGP4XP and under AP).
// - fit (fit_drag and fit_agom, the module's fit) writes COV_SIZE 8: COV_PARAMETER_KINDS and COV_PARAMETERS
//   [DRAG_AREA_OVER_MASS, SRP_AREA_OVER_MASS] in the fixed order, COV_UNITS 8 entries [km x3, km/s x3, m**2/kg x2],
//   COVARIANCE_DATA 36 values, COV_ORDERING LTM, COV_REF_FRAME the record's TRAJ_REF_FRAME; OD_DYNAMIC_PARAMETERS
//   names every row with SOLVED_FOR true.
// - fit_bdot, fit_thrust and fit_outgassing (sdnap_fit's options) each refuse: sdnap_fit status -4 and
//   sdnap_fit_refusal parameter-not-modeled:DRAG_AREA_OVER_MASS_RATE / IN_TRACK_ACCELERATION / OUTGASSING_ACCELERATION;
//   options without them have no refusal.
// - A synthetic $OCM with the five rows (the XP fit's 8 x 8 with DRAG_AREA_OVER_MASS_RATE, IN_TRACK_ACCELERATION and
//   OUTGASSING_ACCELERATION inserted in the fixed order, solved, a cross term between IN_TRACK_ACCELERATION and X)
//   reads and flies: sdnap_covariance_full_at gives 6 + 66 doubles a time on the fixture grid with the three unmodeled
//   variances and their mutual terms constant (0 of 3179 differ from the record's) and the 6 x 6 state block equal to the 8-row record's
//   sdnap_covariance_at (0 of 7803 differ); the X / IN_TRACK_ACCELERATION term at epoch equals the record's; propagate flies it
//   to the 8-row record's bytes. Rows out of the fixed order, or not solved for, are refused (-6).
// - ORBIT_DETERMINATION.WEIGHTED_RMS = FIT_RMS_KM / sqrt(3) (sigma 1 km a component); SEDR, the energy removed
//   (the $OCM's definition), finite and positive under drag: the sign of NON_GRAVITATIONAL_RATE_PER_DAY. Stored rows:
//   the first 0.6.0 build (modules a54ff2245) wrote SEDR as the signed dE/dt, negative under drag; an $OCM it wrote
//   reads here with the opposite sign, its magnitude unchanged. On 2026-11-05 no tracked $OCM in this repository (259
//   records parsed), the experiments repository or the sdn-ap package carries SEDR, and no site figure reads it.
// - One $ODR per fit on 'residuals': EDITED_OBSERVATIONS one per state of the input $OEM (the input count), the
//   accepted ones FIT_STATES, OCM_CONTENT_ID the $OCM's CID (sha256, CIDv1 raw), PERTURBATION_MODEL_CODE SGP4XP / AP.
// - assertNoUserDefined on every $OCM emitted and flown; the $ODR schema has no user-defined list.
// JS only moves bytes and compares numbers the module produced.
//   node test/products-parameters.e2e.mjs
import { createHash } from "node:crypto";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { OCMDynamicParameterT } from "spacedatastandards.org/lib/js/OCM/OCMDynamicParameter.js";
import { ODR, ODRT } from "spacedatastandards.org/lib/js/ODR/main.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { prwDynamicParameter } from "spacedatastandards.org/lib/js/PRW/prwDynamicParameter.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { ensureBuilt, wasmPath, elementRows, THEORY } from "./lib/module.mjs";
import { configuration, XP_FORCES } from "./lib/pcf.mjs";
import { T, AP_FORCES, ocmOf, repackOcm, flight, GRID_OUTPUT } from "./lib/ocm.mjs";
import { inputs, GRID } from "./lib/fixture-inputs.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const x = h.instance.exports;
const mem = () => h.memory.buffer;
const P = prwDynamicParameter;
const { arc, rows } = inputs();
const inputCount = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(arc)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.length;
const noUserDefined = (label, bytes) => { try { assertNoUserDefined(bytes); } catch (e) { check(false, `${label}: ${e.message}`); } };
const cidOf = (bytes) => {
  // CIDv1, raw codec, sha2-256, base32 lower case with the 'b' prefix
  const digest = createHash("sha256").update(bytes).digest();
  const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "b";
  for (const byte of raw) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
};

// --- fit: the $OCM's covariance contract, the statistics and the $ODR
const fits = {};
for (const [name, config, spw, code] of [["XP", configuration({ theory: "SGP4XP", forces: XP_FORCES }), null, "SGP4XP"],
  ["AP", configuration({ theory: "AP", forces: AP_FORCES }), rows.bytes, "AP"]]) {
  const r = await h.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: arc }, config,
    ...(spw ? [{ portId: "space_weather", typeRef: T("SPW"), payload: spw }] : [])] });
  check(r.statusCode === 0, `${name} fit: ${r.errorCode} ${r.errorMessage}`);
  if (r.statusCode !== 0) continue;
  const ocmOut = r.outputs.filter((o) => o.portId === "elements"), odrOut = r.outputs.filter((o) => o.portId === "residuals");
  check(ocmOut.length === 1 && odrOut.length === 1 && odrOut[0].typeRef?.fileIdentifier === "$ODR", `${name}: ${ocmOut.length} $OCM, ${odrOut.length} $ODR`);
  const bytes = new Uint8Array(ocmOut[0].payload), odrBytes = new Uint8Array(odrOut[0].payload);
  noUserDefined(`${name} $OCM`, bytes);
  const o = ocmOf(bytes), od = o.ORBIT_DETERMINATION, st = od.FIT_STATISTICS;
  fits[name] = { bytes, o };
  const units = ["km", "km", "km", "km/s", "km/s", "km/s", "m**2/kg", "m**2/kg"];
  check(o.COV_SIZE === 8 && o.COVARIANCE_DATA.length === 36 && o.COV_ORDERING === 0 && JSON.stringify(o.COV_UNITS) === JSON.stringify(units) &&
    JSON.stringify(o.COV_PARAMETERS) === JSON.stringify(["DRAG_AREA_OVER_MASS", "SRP_AREA_OVER_MASS"]) &&
    JSON.stringify(o.COV_PARAMETER_KINDS) === JSON.stringify([P.DRAG_AREA_OVER_MASS, P.SRP_AREA_OVER_MASS]) && o.COV_REF_FRAME?.NAME === o.TRAJ_REF_FRAME?.NAME,
    `${name}: COV_SIZE ${o.COV_SIZE}, ${o.COVARIANCE_DATA.length} values, COV_UNITS ${JSON.stringify(o.COV_UNITS)}, COV_PARAMETERS ${JSON.stringify(o.COV_PARAMETERS)}`);
  const dyn = od.OD_DYNAMIC_PARAMETERS;
  check(dyn.length === 2 && o.COV_PARAMETER_KINDS.every((k) => dyn.some((p) => p.PARAMETER === k && p.SOLVED_FOR)),
    `${name}: OD_DYNAMIC_PARAMETERS ${dyn.map((p) => `${p.NAME}:${p.SOLVED_FOR}`).join(", ")}`);
  const wantRms = st.FIT_RMS_KM / Math.sqrt(3) / 1;
  check(Number.isFinite(od.WEIGHTED_RMS) && Object.is(od.WEIGHTED_RMS, wantRms), `${name}: WEIGHTED_RMS ${od.WEIGHTED_RMS} against FIT_RMS_KM / sqrt(3) ${wantRms}`);
  const rate = o.COV_PROPAGATION.NON_GRAVITATIONAL_RATE_PER_DAY;
  check(Number.isFinite(od.SEDR) && od.SEDR > 0 && Math.sign(od.SEDR) === Math.sign(rate), `${name}: SEDR ${od.SEDR} with the non-gravitational rate ${rate}`);
  const odr = ODR.getRootAsODR(new flatbuffers.ByteBuffer(odrBytes)).unpack();
  const edited = odr.EDITED_OBSERVATIONS, accepted = edited.filter((e) => e.ACCEPTED).length;
  const codes = new Set(edited.map((e) => e.PERTURBATION_MODEL_CODE));
  check(edited.length === inputCount && accepted === st.FIT_STATES && odr.OCM_CONTENT_ID === cidOf(bytes) && codes.size === 1 && codes.has(code) &&
    edited.every((e) => e.OBSERVATION_TYPE === 8 && e.EPOCH && Number.isFinite(e.OBSERVED_VALUE) && (e.REASON === 'DECAYED' || Number.isFinite(e.COMPUTED_VALUE))),  // SPEC 16.25: a DECAYED row has no computed value
    `${name} $ODR: ${edited.length} rows for ${inputCount} inputs, ${accepted} accepted for FIT_STATES ${st.FIT_STATES}, OCM_CONTENT_ID ${odr.OCM_CONTENT_ID} against ${cidOf(bytes)}, codes ${[...codes]}`);
  check(!Object.keys(new ODRT()).some((k) => /USER_DEFINED/.test(k)), "the $ODR carries a user-defined list");
  const worst = Math.max(...edited.filter((e) => Number.isFinite(e.COMPUTED_VALUE)).map((e) => Math.abs(e.OBSERVED_VALUE - e.COMPUTED_VALUE)));
  console.log(`${name}: COV_SIZE ${o.COV_SIZE}, COV_UNITS ${o.COV_UNITS.length}; WEIGHTED_RMS ${od.WEIGHTED_RMS} (FIT_RMS_KM ${st.FIT_RMS_KM}); SEDR ${od.SEDR} W/kg; ` +
    `$ODR ${edited.length} rows for ${inputCount} input states, ${accepted} accepted (FIT_STATES ${st.FIT_STATES}), largest |O - C| ${worst.toExponential(3)} km, code ${[...codes]}`);
}

// --- fit_bdot, fit_thrust, fit_outgassing: refused by name
const rowPtr = x.sdnap_alloc(112), tPtr = x.sdnap_alloc(8 * 3), rPtr = x.sdnap_alloc(8 * 9), optPtr = x.sdnap_alloc(56), statsPtr = x.sdnap_alloc(32);
const fitRow = { epochWhole: 2461314.5, epochFrac: 0, meanMotion: 15.07, ecc: 0.001, inc: 53, raan: 10, argp: 20, ma: 30, bterm: 0.01, agom: 0.01, norad: 90400, theory: THEORY.SGP4XP };
const cText = (p) => { if (!p) return null; const b = new Uint8Array(mem()); let e = p; while (b[e]) e++; return Buffer.from(b.subarray(p, e)).toString("latin1"); };
for (const [offset, name] of [[28, "DRAG_AREA_OVER_MASS_RATE"], [29, "IN_TRACK_ACCELERATION"], [30, "OUTGASSING_ACCELERATION"], [-1, null]]) {
  new Uint8Array(mem(), rowPtr, 112).set(elementRows([fitRow]));
  new Float64Array(mem(), tPtr, 3).set([0, 10, 20]);
  new Float64Array(mem(), rPtr, 9).set([7000, 0, 0, 0, 7000, 0, -7000, 0, 0]);
  const opt = new DataView(mem(), optPtr, 56);
  for (let k = 0; k < 56; k++) opt.setUint8(k, 0);
  opt.setInt32(0, 1, true);  // fit_drag
  opt.setInt32(24, 1, true); // fit_agom
  if (offset >= 0) opt.setInt8(offset, 1);
  const refusal = cText(x.sdnap_fit_refusal(optPtr));
  if (name) {
    const rc = x.sdnap_fit(rowPtr, tPtr, rPtr, 3, optPtr, statsPtr);
    const status = new Float64Array(mem(), statsPtr, 4)[0];
    check(rc !== 0 && status === -4 && refusal === `parameter-not-modeled:${name}`, `${name}: sdnap_fit ${rc}, status ${status}, refusal ${refusal}`);
    console.log(`fit with ${name}: sdnap_fit status ${status}, refused ${refusal}`);
  } else {
    check(refusal === null, `fit_drag and fit_agom alone: refusal ${refusal}`);
  }
}
for (const p of [rowPtr, tPtr, rPtr, optPtr, statsPtr]) x.sdnap_free(p);

// --- a record with the five rows: read, flown, emitted
if (fits.XP) {
  const base = fits.XP.bytes, o8 = fits.XP.o;
  const C8 = (i, j) => (i >= j ? o8.COVARIANCE_DATA[(i * (i + 1)) / 2 + j] : o8.COVARIANCE_DATA[(j * (j + 1)) / 2 + i]);
  const map = [0, 1, 2, 3, 4, 5, 6, -1, 7, -1, -1];  // the 11 rows: the state, DRAG, DRAG_RATE, SRP, THRUST, OUTGASSING
  const added = { 7: 1e-12, 9: 1e-12, 10: 1e-18 };     // (m**2/kg/s)**2, (m/s**2)**2, (km/s**2)**2
  const cross = 0.1 * Math.sqrt(C8(0, 0) * added[9]);  // X with IN_TRACK_ACCELERATION
  const ltm = [];
  for (let i = 0; i < 11; i++)
    for (let j = 0; j <= i; j++)
      ltm.push(map[i] >= 0 && map[j] >= 0 ? C8(map[i], map[j]) : i === j ? added[i] : i === 9 && j === 0 ? cross : 0);
  const kinds = [P.DRAG_AREA_OVER_MASS, P.DRAG_AREA_OVER_MASS_RATE, P.SRP_AREA_OVER_MASS, P.IN_TRACK_ACCELERATION, P.OUTGASSING_ACCELERATION];
  const names = ["DRAG_AREA_OVER_MASS", "DRAG_AREA_OVER_MASS_RATE", "SRP_AREA_OVER_MASS", "IN_TRACK_ACCELERATION", "OUTGASSING_ACCELERATION"];
  const units = ["m**2/kg", "m**2/kg/s", "m**2/kg", "m/s**2", "km/s**2"];
  const five = (edit = () => {}) => repackOcm(base, (t) => {
    t.COV_SIZE = 11; t.COVARIANCE_DATA = ltm; t.COV_PARAMETER_KINDS = kinds; t.COV_PARAMETERS = names;
    t.COV_UNITS = ["km", "km", "km", "km/s", "km/s", "km/s", ...units];
    t.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS = names.map((n, k) => {
      const was = t.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS.find((p) => p.PARAMETER === kinds[k]);
      return Object.assign(new OCMDynamicParameterT(), { NAME: n, VALUE: was ? was.VALUE : 0, UNITS: units[k], SOLVED_FOR: true, PARAMETER: kinds[k] });
    });
    edit(t);
  });
  const fiveBytes = five();
  noUserDefined("the five-row $OCM", fiveBytes);
  const minutes = [];
  for (let t = 0; t <= GRID.minutes; t += GRID.step / 60) minutes.push(t);
  const call = (fn, bytes, stride) => {
    const po = x.sdnap_alloc(bytes.length), pm = x.sdnap_alloc(8 * minutes.length), pout = x.sdnap_alloc(8 * stride * minutes.length);
    new Uint8Array(mem(), po, bytes.length).set(bytes);
    new Float64Array(mem(), pm, minutes.length).set(minutes);
    const rc = x[fn](po, bytes.length, pm, minutes.length, pout);
    const out = new Float64Array(mem().slice(pout, pout + 8 * stride * minutes.length));
    x.sdnap_free(po); x.sdnap_free(pm); x.sdnap_free(pout);
    return { rc, out };
  };
  const full = call("sdnap_covariance_full_at", fiveBytes, 72), six = call("sdnap_covariance_at", base, 42);
  check(full.rc === 0 && six.rc === 0, `sdnap_covariance_full_at ${full.rc}, sdnap_covariance_at ${six.rc}`);
  const at = (i, j) => (i * (i + 1)) / 2 + j;
  let varDiffer = 0, stateDiffer = 0, varCount = 0, stateCount = 0;
  for (let k = 0; k < minutes.length; k++) {
    const f = full.out.subarray(72 * k, 72 * k + 72), s = six.out.subarray(42 * k, 42 * k + 42);
    for (let c = 0; c < 6; c++) { stateCount++; if (!Object.is(f[c], s[c])) stateDiffer++; }
    for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) { stateCount++; if (!Object.is(f[6 + at(i, j)], s[6 + i * 6 + j])) stateDiffer++; }
    for (const i of [7, 9, 10]) for (let j = 6; j <= i; j++) { varCount++; if (!Object.is(f[6 + at(i, j)], ltm[at(i, j)])) varDiffer++; }
  }
  const epochCross = full.out[6 + at(9, 0)];
  const crossRel = Math.abs(epochCross - cross) / Math.abs(cross);
  check(varDiffer === 0 && stateDiffer === 0 && crossRel <= 1e-9, `five rows: ${varDiffer} of ${varCount} parameter values differ, ${stateDiffer} of ${stateCount} state values differ, X / IN_TRACK_ACCELERATION at epoch ${crossRel} relative`);
  console.log(`five rows on ${minutes.length} grid times: 6 + 66 doubles a time; ${varDiffer} of ${varCount} unmodeled parameter values differ from the record (constant); ` +
    `${stateDiffer} of ${stateCount} state values differ from the 8-row record; X / IN_TRACK_ACCELERATION at epoch ${epochCross.toExponential(6)} against ${cross.toExponential(6)} (${crossRel.toExponential(2)} relative)`);
  const a = await h.invoke({ methodId: "propagate", inputs: flight([base], { output: GRID_OUTPUT }) });
  const b = await h.invoke({ methodId: "propagate", inputs: flight([fiveBytes], { output: GRID_OUTPUT }) });
  const same = a.statusCode === 0 && b.statusCode === 0 && Buffer.from(a.outputs[0].payload).equals(Buffer.from(b.outputs[0].payload));
  check(same, `propagate of the five-row record: ${b.statusCode} ${b.errorCode ?? ""}, ${same ? "" : "other bytes than the 8-row record"}`);
  console.log(`propagate of the five-row record: ${same ? "the 8-row record's bytes" : "differs"}`);
  const order = five((t) => { t.COV_PARAMETER_KINDS = [kinds[1], kinds[0], ...kinds.slice(2)]; });
  const unsolved = five((t) => { t.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS[3].SOLVED_FOR = false; });
  for (const [label, bytes] of [["rows out of the fixed order", order], ["IN_TRACK_ACCELERATION not solved for", unsolved]]) {
    const r = call("sdnap_covariance_full_at", bytes, 72).rc;
    check(r === -6, `${label}: ${r}, expected -6`);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\nproducts parameters E2E: PASS");
process.exit(0);
