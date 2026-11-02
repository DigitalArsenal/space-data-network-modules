#!/usr/bin/env node
// E2E (task modules-ap-tesseral-terms-20261102): AP's gravity terms (SPEC 16), through the module's invoke surface.
// - Inert at degree 0: FORCES with both degrees at 0 gives the bytes of no FORCES at all (the conformance E2E holds
//   that default to the oracle bit for bit).
// - On propagator/ffm's trajectory (test/fixtures, 550 km, 53 deg, 70x70 field, no drag or SRP; so BTERM is held at 0):
//   against XP, the 24 h fit's error falls below a third, and so does the error two to three days past the arc.
// - The set is marked; a call with other terms refuses it by name, and so does ingest_omm's batch store.
// - load_epochs and propagate_epochs fly it as propagate does.
// - FORCES refusals by name.
// JS only moves bytes and compares numbers the module produced.
//   node test/ap-terms.e2e.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as BlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT as LineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { packOem, rfm } from "./lib/frames.mjs";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { configuration, prior, pcfPriorForm } from "./lib/pcf.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
const invoke = (methodId, inputs) => h.invoke({ methodId, inputs });

const truth = JSON.parse(zlib.gunzipSync(fs.readFileSync(fileURLToPath(new URL("fixtures/ffm-leo-550km-53deg.json.gz", import.meta.url)))));
const t0 = Date.parse(truth.epoch), step = truth.stepSeconds * 1000;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const object = () => Object.assign(new CATT(), { NORAD_CAT_ID: 90400, OBJECT_ID: "2026-904A", OBJECT_NAME: "AP E2E" });
const lineOf = (s, k) => Object.assign(new LineT(), { EPOCH: iso(t0 + k * step), X: s[0], Y: s[1], Z: s[2], X_DOT: s[3], Y_DOT: s[4], Z_DOT: s[5] });
function arcOem(hours) {
  const n = (hours * 3600000) / step + 1, lines = truth.states.slice(0, n).map(lineOf);
  const block = Object.assign(new BlockT(), { OBJECT: object(), CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC,
    START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
  return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] })).slice();
}
function gridOem(firstK, lastK) {
  const block = Object.assign(new BlockT(), { CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC, START_TIME: iso(t0 + firstK * step),
    STOP_TIME: iso(t0 + lastK * step), STEP_SIZE: truth.stepSeconds, EPHEMERIS_DATA_LINES: [] });
  return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] })).slice();
}
const FORCES = (tesseral, zonal) => ({ forces: { EPHEMERIS_SOURCE: "", HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: tesseral, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: zonal } });
const NO_DRAG = { fit: { DRAG_PRIOR: prior(0, 1e-7), DRAG_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED } };
const config = (f) => configuration({ theory: "SGP4XP", ...NO_DRAG, ...(f ?? {}), output: { OUTPUT_FRAME: pcfOutputFrame.GCRF } });
const fit = async (f) => {
  const r = await invoke("fit", [{ portId: "ephemeris", typeRef: T("OEM"), payload: arcOem(24) }, config(f)]);
  check(r.statusCode === 0, `fit: ${r.errorCode} ${r.errorMessage}`);
  return r.statusCode === 0 ? new Uint8Array(r.outputs[0].payload) : null;
};
const flown = async (omm, f, firstK, lastK) => {
  const r = await invoke("propagate", [{ portId: "omm", typeRef: T("OMM"), payload: omm }, { portId: "grid", typeRef: T("OEM"), payload: gridOem(firstK, lastK) }, config(f)]);
  check(r.statusCode === 0, `propagate: ${r.errorCode} ${r.errorMessage}`);
  return r.statusCode === 0 ? new Uint8Array(r.outputs[0].payload) : null;
};
const linesOf = (bytes) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(bytes)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
function rmsAgainstTruth(bytes, firstK) {
  const lines = linesOf(bytes);
  let sum = 0;
  lines.forEach((l, i) => { const s = truth.states[firstK + i]; sum += (l.X - s[0]) ** 2 + (l.Y - s[1]) ** 2 + (l.Z - s[2]) ** 2; });
  return Math.sqrt(sum / lines.length);
}
const K24 = (24 * 3600000) / step, K72 = (72 * 3600000) / step, K96 = (96 * 3600000) / step;
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// --- inert at degree 0
const xp = await fit(null);
const zero = await fit(FORCES(0, 0));
check(same(xp, zero), "fit with both degrees at 0 differs from fit with no FORCES");
check(same(await flown(xp, null, K72, K96), await flown(xp, FORCES(0, 0), K72, K96)), "propagate with both degrees at 0 differs from propagate with no FORCES");

// --- against FFM's trajectory
const AP = FORCES(31, 20);
const ap = await fit(AP);
const xpFit = rmsAgainstTruth(await flown(xp, null, 0, K24), 0), apFit = rmsAgainstTruth(await flown(ap, AP, 0, K24), 0);
const xpDay3 = rmsAgainstTruth(await flown(xp, null, K72, K96), K72), apDay3 = rmsAgainstTruth(await flown(ap, AP, K72, K96), K72);
console.log(`24 h arc, RMS km: XP ${xpFit.toFixed(4)}, AP ${apFit.toFixed(4)}; 48 to 72 h past the arc: XP ${xpDay3.toFixed(3)}, AP ${apDay3.toFixed(3)}`);
check(xpFit > 0.2, `XP's fit no longer shows the floor: ${xpFit} km`);
check(apFit < xpFit / 3, `AP's fit ${apFit} km is not below a third of XP's ${xpFit} km`);
check(apDay3 < xpDay3 / 3, `AP past the arc ${apDay3} km is not below a third of XP's ${xpDay3} km`);

// --- the mark
const mark = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(ap)).unpack().USER_DEFINED_PARAMETERS?.find((p) => p.PARAM_NAME === "SDNAP_GRAVITY_TERMS")?.PARAM_VALUE;
check(mark === "31,20", `the set's SDNAP_GRAVITY_TERMS: ${mark}`);
check(!OMM.getRootAsOMM(new flatbuffers.ByteBuffer(xp)).unpack().USER_DEFINED_PARAMETERS?.some((p) => p.PARAM_NAME === "SDNAP_GRAVITY_TERMS"), "an XP set carries SDNAP_GRAVITY_TERMS");
const refused = async (label, r, code) => check(r.statusCode !== 0 && r.errorCode === code, `${label}: expected ${code}, got ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
const fly = (omm, f) => invoke("propagate", [{ portId: "omm", typeRef: T("OMM"), payload: omm }, { portId: "grid", typeRef: T("OEM"), payload: gridOem(K72, K96) }, config(f)]);
await refused("AP set under no terms", await fly(ap, null), "gravity-terms-mismatch");
await refused("AP set under other terms", await fly(ap, FORCES(12, 20)), "gravity-terms-mismatch");
await refused("XP set under AP's terms", await fly(xp, AP), "gravity-terms-mismatch");
await refused("AP set in ingest_omm", await invoke("ingest_omm", [{ portId: "omm", typeRef: T("OMM"), payload: ap }]), "gravity-terms-mismatch");

// --- the epoch store flies it as propagate does
const direct = linesOf(await flown(ap, AP, K72, K96));
const stored = await invoke("propagate_epochs", [{ portId: "omm", typeRef: T("OMM"), payload: ap }, { portId: "grid", typeRef: T("OEM"), payload: gridOem(K72, K96) }, config(AP)]);
check(stored.statusCode === 0, `propagate_epochs: ${stored.errorCode} ${stored.errorMessage}`);
if (stored.statusCode === 0) {
  const lines = linesOf(new Uint8Array(stored.outputs[0].payload));
  let worst = 0;
  direct.forEach((l, i) => { worst = Math.max(worst, Math.hypot(l.X - lines[i].X, l.Y - lines[i].Y, l.Z - lines[i].Z)); });
  console.log(`propagate_epochs vs propagate: max |dr| ${(worst * 1e6).toFixed(3)} mm`);
  check(lines.length === direct.length && worst < 1e-5, `propagate_epochs differs from propagate by ${worst} km`);
}

// --- refusals by name
const refusedForces = async (fields, field) => {
  const r = await invoke("fit", [{ portId: "ephemeris", typeRef: T("OEM"), payload: arcOem(24) }, configuration({ theory: "SGP4XP", forces: { EPHEMERIS_SOURCE: "", ...fields } })]);
  check(r.statusCode !== 0 && r.errorCode === "configuration-refused" && String(r.errorMessage).startsWith(field), `${field}: ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
};
await refusedForces({ HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 71 }, "FORCES.MAXIMUM_TESSERAL_DEGREE");
await refusedForces({ MAXIMUM_TESSERAL_DEGREE: 12 }, "FORCES.MAXIMUM_TESSERAL_DEGREE");
await refusedForces({ HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 71 }, "FORCES.MAXIMUM_DEGREE");
await refusedForces({ MAXIMUM_DEGREE: 20 }, "FORCES.MAXIMUM_DEGREE");

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\nAP terms E2E: PASS");
process.exit(0);
