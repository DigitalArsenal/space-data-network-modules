#!/usr/bin/env node
// E2E (task modules-sdn-ap-ocm-fly-20261103): propagate flies $OCM records alone; the record is the one authority
// for its forces; every malformed or foreign record is refused by name; ingest_omm is the one $OMM boundary.
// - The flight: the stored AP record (test/fixtures/ap-fit-0.6.42.ocm, 0.6.42's fit of the 0.4.0 inputs) under a $PCF with
//   OUTPUT only (the fixture grid) within FLIGHT (below) of 0.6.42's flight of it (ap-fit-0.6.42-0.6.42.oem): states and
//   covariance. 0.6.36's fit (ap-fit-0.6.36.ocm) flies its states within FLIGHT of this build's flight of 0.6.39's fit
//   (ap-fit-0.6.39.ocm, the same mean elements), its covariance refused by name. 0.6.4's fit (test/fixtures/ap-fit-0.6.4.ocm),
//   the stored record through 0.6.34, states GRAVITY_MODEL EGM-96 with gravity terms and is refused (gravity-model-mismatch,
//   SPEC 16.2). The fit: this build's own fit of the same arc, flown on the grid, within FIT of this build's flight of
//   0.6.42's fit (the same ap-fit-0.6.42.ocm), its FIT_RMS within FIT.rmsM of that record's (history and sizes at FLIGHT).
//   The record's own rows fly. Alone (no $PCF) the
//   fitted record gives the default grid: its epoch to one day later at 60 s, TEME, 1441 states.
// - A $PCF with a FORCES table on propagate: configuration-refused FORCES.
// - One record built to trigger each refusal, by name; an $OMM, $SPW, $DCL or $OEM payload on 'ocm' is refused by its
//   type (omm-not-flown, spw-not-flown, dcl-not-flown, grid-not-flown); a frame on a removed port ('omm',
//   'space_weather', 'density_correction', 'grid') is refused by the host (unknown-input-port: the SDK refuses an
//   undeclared port before the module runs); a flight one day past the last row: weather-rows-short:2026-11-01.
// - ingest_omm: one user-defined parameter, user-defined-parameters:1; theory AP, theory-not-ingestable:AP; the $OCM of
//   an SGP4 and of a stock SGP4XP $OMM written with their theory's own forces, assertNoUserDefined on each, and the XP
//   one flies to the bytes of the record it was exported from (SPEC 17.6: the export writes BTERM and AGOM in their own
//   fields, BSTAR and MEAN_MOTION_DDOT 0, and the ingested $OCM's HEADER.COMMENT is "BTERM_SOURCE=BTERM
//   AGOM_SOURCE=AGOM"); the same set with BTERM in BSTAR and AGOM in MEAN_MOTION_DDOT and neither field set (the SGP4-XP
//   element-set definition) ingests to the same BTERM, AGOM and flight, HEADER.COMMENT "BTERM_SOURCE=BSTAR
//   AGOM_SOURCE=MEAN_MOTION_DDOT"; the SGP4 $OCM states no source.
// - On propagator/ffm's 550 km trajectory (24 h fit arcs, no drag), AP's terms (caps 31 and 20 on the theory's flux
//   model) take the fit error below a tenth of XP's and the error two to three days past the arc below a third.
// - The sources: no SDNAP_ mark (SDNAP_EXPORT, the export macro, is not one), no USER_DEFINED_SDNAP, no
//   "ATMOSPHERE_MODEL" mark (the fit's FORCES.ATMOSPHERE_MODEL field is its $PCF's), no omm_theory setter.
// JS only moves bytes and compares numbers the module produced.
//   node test/ap-terms.e2e.mjs
import fs from "node:fs";
import { recordReference } from "./lib/record.mjs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OMM, OMMT } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OMMUserDefinedParameterT } from "spacedatastandards.org/lib/js/OMM/OMMUserDefinedParameter.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ATMT } from "spacedatastandards.org/lib/js/OCM/ATM.js";
import { AtmosphericModelFamily } from "spacedatastandards.org/lib/js/OCM/AtmosphericModelFamily.js";
import { SPWT } from "spacedatastandards.org/lib/js/OCM/SPW.js";
import { DCL, DCLT } from "spacedatastandards.org/lib/js/DCL/DCL.js";
import { RFMT } from "spacedatastandards.org/lib/js/RFM/RFM.js";
import { RFMUnion } from "spacedatastandards.org/lib/js/RFM/RFMUnion.js";
import { CelestialFrameWrapperT } from "spacedatastandards.org/lib/js/RFM/CelestialFrameWrapper.js";
import { CelestialFrame } from "spacedatastandards.org/lib/js/RFM/CelestialFrame.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { pcfDensityCorrection } from "spacedatastandards.org/lib/js/PCF/pcfDensityCorrection.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { pcfPriorForm } from "spacedatastandards.org/lib/js/PCF/pcfPriorForm.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { ensureBuilt, wasmPath, packageRoot } from "./lib/module.mjs";
import { configuration, prior, XP_FORCES } from "./lib/pcf.mjs";
import { arcOem } from "./lib/fixture-inputs.mjs";
import { T, fixtureSets, repackOcm, ocmOf, flight, GRID_OUTPUT } from "./lib/ocm.mjs";
import { oemDistance } from "./lib/oem-distance.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const invoke = (methodId, inputs) => h.invoke({ methodId, inputs });
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)));
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const refused = (label, r, code, field = null) =>
  check(r.statusCode !== 0 && r.errorCode === code && (field === null || String(r.errorMessage).startsWith(field)),
    `${label}: expected ${code}${field ? ` ${field}` : ""}, got ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
const linesOf = (bytes) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(bytes)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;

const { ap, xp, rows } = await fixtureSets(h);
// The flight of fixed elements and the fit, pinned apart so that a change is attributed the day it happens.
// test/fixtures/ap-fit-0.6.4.ocm is 0.6.4's fit of the 0.4.0 inputs (MEAN_ELEMENTS bit-equal to ap-fit-0.4.0.omm), the
// stored record through 0.6.34, flown on the fixture grid (48 h at 600 s from the arc's start). History of that
// flight: its states equal ap-fit-0.4.0.oem's (the 0.4.18 dist's) bit for bit through 0.6.4; its covariance moved at 0.6.1
// (637228fb, the AP DRAG noise row re-fitted, SPEC 12.4: a line's entries by up to 8.9e4 of 0.6.4's largest, the 0.6.0
// floor being far wider); 0.6.5 (24d7d75f, its speed changes: SPEC 16.8) moves the states by 2.904 mm and 2.989 um/s and
// the covariance by 7.2e-5 of a line's largest entry. 0.6.21 (SPEC 16.15 and 16.16, stack #464 and #472) records the
// flight from itself (0.6.4's ap-fit-0.6.4.oem went), the bounds kept. Against 0.6.4's flight, 0.6.20 / 0.6.21: 0.839 /
// 0.839 mm, 0.812 / 0.812 um/s, covariance 7.2e-5 / 9.133e-3 of a line's largest entry. Why: the record's correlations
// between AGOM and the state are 0.6.4's fit's, and 16.16 moves its along-track response to AGOM at 48 h from 1380.7 to
// 823.7 m per m^2/kg; a fit made and flown by 0.6.21 flies to 0.6.4's numbers within 7.1e-5 (covariance.e2e.mjs). 0.6.22
// (AP's own Sun and Moon, SPEC 16.17, stack #446) records it from itself again (ap-fit-0.6.4-0.6.22.oem; the 0.6.21 file
// went), the bounds kept: against 0.6.21's flight 34.755 mm, 38.313 um/s, covariance 2.19e-5 of a line's largest entry.
// 0.6.36 (the field EGM2008, SPEC 16.2) moves it from 0.6.22's flight by 7,140.576 mm, 7,584.457 um/s and a covariance of
// 5.32e-3 of a line's largest entry.
// 0.6.36 refuses a record whose GRAVITY_MODEL is not the embedded field (SPEC 16.2): 0.6.4's fit states EGM-96 and is
// refused, so from 0.6.36 the stored record is 0.6.36's own fit of the same inputs (ap-fit-0.6.36.ocm), recorded with its
// flight (ap-fit-0.6.36-0.6.36.oem; ap-fit-0.6.4-0.6.22.oem went), the bounds kept.
// The fit: this build's fit of the same 24 h arc stops at another point inside its tolerance, 7.3 cm from 0.6.4's along
// the grid (0.6.5: 26 against 28 iterations, FIT_RMS 41.127 against 41.130 m). Against the stored record's flight until
// 0.6.21; from 0.6.22 against this build's flight of 0.6.22's own fit (ap-fit-0.6.22.ocm), the bounds kept: AP's own Sun
// and Moon move the fit of the 550 km arc, 117.73 mm and 130.37 um/s from 0.6.21's flight of 0.6.4's fit and, both flown
// by 0.6.22, 92.35 mm and 101.50 um/s from 0.6.4's fit (FIT_RMS 41.1258 against 41.1299 m).
// 0.6.25 (the slow set, SPEC 16.18) moves the fit, which now carries the slow tesseral terms at 550 km: 17.7 m and 19.4
// mm/s from 0.6.22's fit (both flown by 0.6.25), FIT_RMS 40.049 against 41.126 m. Against the fixture's own truth
// (propagator/ffm's 550 km trajectory) the error 48 to 72 h past the arc goes from 114 m (0.6.24) to 43 m, over the arc
// 24.0 to 23.9 m. So the own fit is 0.6.25's (ap-fit-0.6.25.ocm; 0.6.22's went), the bounds kept.
// 0.6.27 (the slow set's terms of q other than 0, SPEC 16.18) moves the fit: 77.4 m and 45.1 mm/s from 0.6.25's fit
// (both flown by 0.6.27), FIT_RMS 40.260 against 40.049 m. Against the fixture's own truth (propagator/ffm's 550 km
// trajectory) the error 48 to 72 h past the arc stays at 43 m, and over the arc it goes from 23.9 to 24.1 m. So the own
// fit is 0.6.27's (ap-fit-0.6.27.ocm; 0.6.25's went), the bounds kept.
// 0.6.36 (the field EGM2008 in place of EGM-96, SPEC 16.2) moves the fit: 154.6 m and 133.1 mm/s from 0.6.27's fit
// (both flown by 0.6.36), FIT_RMS 40.153 against 40.260 m. Against the fixture's own truth (propagator/ffm's 550 km
// trajectory) the error 48 to 72 h past the arc goes from 43 to 42 m, and over the arc from 24.1 to 24.3 m. So the own
// fit is 0.6.36's (ap-fit-0.6.36.ocm; 0.6.27's went), the bounds kept.
// 0.6.39 (SPEC 12.4, stack #551: an AP set's epoch floor put on and taken off at the two-body state of its own mean
// elements) refuses the covariance of an AP record written before it (cov-floor-at-theory-state; its states fly), 0.6.36's
// fit among them. So from 0.6.39 the stored record is 0.6.39's own fit of the same inputs (ap-fit-0.6.39.ocm: 0.6.36's mean
// elements bit for bit, its COVARIANCE_DATA's state block carrying the floor at the two-body state), and its flight is
// held against 0.6.36's flight of 0.6.36's fit, which it equals to rounding (a set's own flight is as it was); 0.6.36's fit
// flies its states as 0.6.36 flew them, its covariance refused by name.
// 0.6.42 (the low table's fast side, SPEC 16.1, stack #477: the output table to the record's tesseral degree) moves this
// 550 km set, which is in the low table at tesseral 31. Main 0.6.41 (git afdd1568, wasm bec591fe) flies 0.6.39's fit
// within FLIGHT of 0.6.36's flight; 0.6.42 (git b7a7191e, wasm f771420f; the final 0.6.42, git 61048ba9, wasm 3c389abf, flies the same bits) flies it 59,929.891 mm and 47,483.284 um/s from
// it, the covariance 2.11e-5 of a line's largest entry, and 0.6.36's fit's states the same 59,929.940 mm. Its own fit of the
// arc is 10,706.11 mm and 11,917.68 um/s from 0.6.39's fit (both flown by 0.6.42), FIT_RMS 37.2731 against 40.1528 m: the
// fast side fits the arc closer. A base before the fast side holds these to another theory's flight, so from 0.6.42 the
// stored record is 0.6.42's own fit of the same inputs (ap-fit-0.6.42.ocm, written by fit.e2e.mjs's fit), recorded with
// its flight (ap-fit-0.6.42-0.6.42.oem; ap-fit-0.6.36-0.6.36.oem went), and the own fit is the same record, the bounds
// kept. 0.6.36's fit is held against this build's flight of 0.6.39's fit, a record with the same mean elements bit for
// bit (0.361 mm: the state path against the covariance's nominal), its covariance refused by name.
const FLIGHT = { posM: 0.004, velMmS: 0.004, covOfLargest: 1e-4 };
const FIT = { posM: 0.1, velMmS: 0.1, rmsM: 0.01 };

// --- the flight: the stored AP record (0.6.42's fit) on the fixture grid against 0.6.42's flight of it
const stored = fixture("ap-fit-0.6.42.ocm"), storedFlight = fixture("ap-fit-0.6.42-0.6.42.oem");
const flownStored = await invoke("propagate", flight([new Uint8Array(stored)], { output: GRID_OUTPUT }));
check(flownStored.statusCode === 0, `propagate the stored AP record: ${flownStored.errorCode} ${flownStored.errorMessage}`);
if (flownStored.statusCode === 0) {
  recordReference("ap-fit-0.6.42", "oem", new Uint8Array(flownStored.outputs[0].payload));
  const d = oemDistance(new Uint8Array(flownStored.outputs[0].payload), storedFlight);
  console.log(`the stored AP record on the fixture grid against 0.6.42's flight: ${d.bytesEqual ? "byte-equal" : "differs"}; position ${(1000 * d.posM).toFixed(3)} mm, velocity ${(1000 * d.velMmS).toFixed(3)} um/s, covariance ${d.covOfLargest.toExponential(2)} of a line's largest entry (${d.states} states, ${d.covLines} covariance lines)`);
  check(d.states === 289 && d.covLines === 289 && d.epochsDiffer === 0, `the stored record's flight: ${d.states} states, ${d.covLines} covariance lines, ${d.epochsDiffer} epochs differ`);
  check(d.posM <= FLIGHT.posM && d.velMmS <= FLIGHT.velMmS && d.covOfLargest <= FLIGHT.covOfLargest, `the stored AP record's flight moved: ${JSON.stringify(d)} against ${JSON.stringify(FLIGHT)}`);
}
// --- SPEC 12.4: 0.6.36's fit, written before the epoch floor at its mean elements' two-body state, flies its states within
// FLIGHT of this build's flight of 0.6.39's fit, a record with the same mean elements bit for bit and its floor at the
// two-body state (0.361 mm on 0.6.42: a flight without covariance takes the state path, one with it the covariance's nominal); its
// covariance is refused by name (cov-floor-at-theory-state, the block's COMMENT)
{
  const old = await invoke("propagate", flight([new Uint8Array(fixture("ap-fit-0.6.36.ocm"))], { output: GRID_OUTPUT }));
  const same39 = await invoke("propagate", flight([new Uint8Array(fixture("ap-fit-0.6.39.ocm"))], { output: GRID_OUTPUT }));
  check(old.statusCode === 0 && same39.statusCode === 0, `propagate 0.6.36's fit: ${old.errorCode ?? "ok"} ${old.errorMessage ?? ""} | 0.6.39's fit: ${same39.errorCode ?? "ok"}`);
  if (old.statusCode === 0 && same39.statusCode === 0) {
    const block = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(old.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0];
    const d = oemDistance(new Uint8Array(old.outputs[0].payload), new Uint8Array(same39.outputs[0].payload));
    console.log(`0.6.36's fit on the fixture grid: ${d.states} states, position ${(1000 * d.posM).toFixed(3)} mm from this build's flight of 0.6.39's fit, ${block.COVARIANCE_MATRIX_LINES.length} covariance lines; COMMENT ${String(block.COMMENT).slice(0, 60)}`);
    check(d.states === 289 && d.epochsDiffer === 0 && d.posM <= FLIGHT.posM && d.velMmS <= FLIGHT.velMmS && block.COVARIANCE_MATRIX_LINES.length === 0 &&
      String(block.COMMENT ?? "").startsWith("cov-floor-at-theory-state:"), `0.6.36's fit: ${JSON.stringify(d)}, ${block.COVARIANCE_MATRIX_LINES.length} covariance lines, COMMENT ${block.COMMENT}`);
  }
}
// --- the fit: this build's own fit of the stored arc, flown on the same grid, against this build's flight of 0.6.42's fit
const fitRecord = fixture("ap-fit-0.6.42.ocm");
const flown = await invoke("propagate", flight([ap], { output: GRID_OUTPUT }));
const flownRecord = await invoke("propagate", flight([new Uint8Array(fitRecord)], { output: GRID_OUTPUT }));
check(flown.statusCode === 0 && flownRecord.statusCode === 0, `propagate AP: ${flown.errorCode ?? "ok"} ${flown.errorMessage ?? ""} | 0.6.42's fit: ${flownRecord.errorCode ?? "ok"}`);
if (flown.statusCode === 0 && flownRecord.statusCode === 0) {
  const d = oemDistance(new Uint8Array(flown.outputs[0].payload), new Uint8Array(flownRecord.outputs[0].payload));
  const rms = ocmOf(ap).ORBIT_DETERMINATION?.FIT_STATISTICS?.FIT_RMS_KM, rmsStored = ocmOf(new Uint8Array(fitRecord)).ORBIT_DETERMINATION?.FIT_STATISTICS?.FIT_RMS_KM;
  console.log(`this build's fit on the fixture grid (24 h arc and the day after) against 0.6.42's fit: position ${(1000 * d.posM).toFixed(2)} mm, velocity ${(1000 * d.velMmS).toFixed(2)} um/s; FIT_RMS ${(1000 * rms).toFixed(4)} m against ${(1000 * rmsStored).toFixed(4)} m`);
  check(d.posM <= FIT.posM && d.velMmS <= FIT.velMmS && Math.abs(rms - rmsStored) * 1000 <= FIT.rmsM, `this build's fit moved: ${(1000 * d.posM).toFixed(2)} mm, ${(1000 * d.velMmS).toFixed(2)} um/s, FIT_RMS ${rms} km against ${rmsStored} (bounds ${JSON.stringify(FIT)})`);
}
const alone = await invoke("propagate", flight([ap]));
check(alone.statusCode === 0, `propagate AP alone: ${alone.errorCode} ${alone.errorMessage}`);
if (alone.statusCode === 0) {
  const block = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(alone.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0];
  check(block.EPHEMERIS_DATA_LINES.length === 1441 && block.START_TIME === "2026-10-01T00:00:00.000000" && block.STOP_TIME === "2026-10-02T00:00:00.000000" &&
    block.STEP_SIZE === 60 && block.REFERENCE_FRAME?.NAME === "TEME", `the default grid: ${block.EPHEMERIS_DATA_LINES.length} states ${block.START_TIME} to ${block.STOP_TIME}, ${block.STEP_SIZE} s, ${block.REFERENCE_FRAME?.NAME}`);
}

// --- refusals by name
refused("0.6.4's fit (GRAVITY_MODEL EGM-96 with gravity terms)", await invoke("propagate", flight([new Uint8Array(fixture("ap-fit-0.6.4.ocm"))], { output: GRID_OUTPUT })), "gravity-model-mismatch");
refused("FORCES on propagate", await invoke("propagate", flight([ap], { output: GRID_OUTPUT, forces: XP_FORCES })), "configuration-refused", "FORCES");
const ommBytes = fixture("xp-fit-0.4.0.omm");
const dcl = (() => {
  const b = new flatbuffers.Builder(256);
  DCL.finishDCLBuffer(b, new DCLT().pack(b));
  return b.asUint8Array().slice();
})();
const asOcm = (payload) => [{ portId: "ocm", typeRef: T("OCM"), payload }];
refused("an $OMM on 'ocm'", await invoke("propagate", asOcm(ommBytes)), "omm-not-flown");
refused("an $SPW on 'ocm'", await invoke("propagate", asOcm(rows.bytes)), "spw-not-flown");
refused("a $DCL on 'ocm'", await invoke("propagate", asOcm(dcl)), "dcl-not-flown");
refused("an $OEM on 'ocm'", await invoke("propagate", asOcm(arcOem(1))), "grid-not-flown");
refused("garbage on 'ocm'", await invoke("propagate", asOcm(new Uint8Array(64))), "invalid-ocm");
refused("no 'ocm'", await invoke("propagate", [configuration({ output: GRID_OUTPUT })]), "missing-ocm");
for (const [port, type, payload] of [["omm", "OMM", ommBytes], ["space_weather", "SPW", rows.bytes], ["density_correction", "DCL", dcl], ["grid", "OEM", arcOem(1)]])
  refused(`a frame on the removed port '${port}'`, await invoke("propagate", [...asOcm(ap), { portId: port, typeRef: T(type), payload }]), "unknown-input-port");
// an SGP4 $OCM through the boundary
const sgp4Omm = (() => {
  const t = Object.assign(new OMMT(), { OBJECT_NAME: "SGP4 E2E", OBJECT_ID: "1998-067A", CENTER_NAME: "EARTH", EPOCH: "2026-10-01T00:00:00.000000", MEAN_MOTION: 15.5,
    ECCENTRICITY: 0.0005, INCLINATION: 51.64, RA_OF_ASC_NODE: 120, ARG_OF_PERICENTER: 80, MEAN_ANOMALY: 280, BSTAR: 2e-4, NORAD_CAT_ID: 25544, MEAN_ELEMENT_THEORY: 0 });
  const b = new flatbuffers.Builder(512);
  OMM.finishOMMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
})();
const ingest = (payload) => invoke("ingest_omm", [{ portId: "omm", typeRef: T("OMM"), payload }]);
const sgp4In = await ingest(sgp4Omm);
check(sgp4In.statusCode === 0 && sgp4In.outputs.length === 1, `ingest_omm SGP4: ${sgp4In.errorCode} ${sgp4In.errorMessage}`);
const sgp4 = sgp4In.statusCode === 0 ? new Uint8Array(sgp4In.outputs[0].payload) : null;
const exported = await invoke("export_omm", asOcm(xp));
const xpOmm = exported.statusCode === 0 ? new Uint8Array(exported.outputs[0].payload) : null;
const xpIn = xpOmm ? await ingest(xpOmm) : null;
check(xpIn?.statusCode === 0, `ingest_omm of the exported XP set: ${xpIn?.errorCode} ${xpIn?.errorMessage}`);
for (const [name, r] of [["SGP4", sgp4In], ["XP", xpIn]]) {
  if (r?.statusCode !== 0) continue;
  try { assertNoUserDefined(new Uint8Array(r.outputs[0].payload)); } catch (e) { check(false, `ingest_omm ${name}: ${e.message}`); }
}
if (sgp4) {
  const o = ocmOf(sgp4);
  check(o.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY === 0 && o.PERTURBATIONS.GRAVITY_MODEL === "WGS-72" && o.PERTURBATIONS.WEATHER_SOURCE === pcfWeatherSource.NONE &&
    !o.PERTURBATIONS.ATMOSPHERIC_MODEL && o.ORB_AVERAGING === "KOZAI" && o.METADATA.NORAD_CAT_ID === 25544 && o.MEAN_ELEMENTS.BSTAR === 2e-4,
    `the SGP4 $OCM: ${JSON.stringify(o.PERTURBATIONS)} ${o.ORB_AVERAGING}`);
  check((await invoke("propagate", flight([sgp4]))).statusCode === 0, "the SGP4 $OCM does not fly");
  refused("SGP4, WEATHER_SOURCE UNSPECIFIED", await invoke("propagate", flight([repackOcm(sgp4, (t) => { t.PERTURBATIONS.WEATHER_SOURCE = pcfWeatherSource.UNSPECIFIED; })])), "weather-source-unspecified");
  refused("SGP4, ATMOSPHERIC_MODEL beside NONE", await invoke("propagate", flight([repackOcm(sgp4, (t) => { t.PERTURBATIONS.ATMOSPHERIC_MODEL = new ATMT(AtmosphericModelFamily.JXX, 1970); })])), "atmosphere-weather-mismatch");
}
if (xpIn?.statusCode === 0) {
  const back = new Uint8Array(xpIn.outputs[0].payload), o = ocmOf(back), x = ocmOf(xp);
  check(o.PERTURBATIONS.WEATHER_SOURCE === pcfWeatherSource.THEORY_FLUX_MODEL && o.PERTURBATIONS.ATMOSPHERIC_MODEL?.YEAR === 1970 && o.PERTURBATIONS.GRAVITY_MODEL === "EGM-96" &&
    Object.is(o.MEAN_ELEMENTS.BTERM, x.MEAN_ELEMENTS.BTERM) && Object.is(o.MEAN_ELEMENTS.AGOM, x.MEAN_ELEMENTS.AGOM) && Object.is(o.MEAN_ELEMENTS.MEAN_MOTION, x.MEAN_ELEMENTS.MEAN_MOTION),
    "the ingested XP $OCM's forces or elements");
  const a = await invoke("propagate", flight([repackOcm(xp, (t) => { t.COVARIANCE_DATA = []; t.COV_PARAMETER_KINDS = []; t.COV_PARAMETERS = []; t.COV_UNITS = []; t.COV_PROPAGATION = null; t.COV_REALISM = []; t.COV_REF_FRAME = null; t.COV_TYPE = null; t.COV_SIZE = 6; })], { output: GRID_OUTPUT }));
  const b = await invoke("propagate", flight([back], { output: GRID_OUTPUT }));
  check(a.statusCode === 0 && b.statusCode === 0 && same(a.outputs[0].payload, b.outputs[0].payload), "the XP set through export_omm and ingest_omm flies to other bytes");
}
const userOmm = (() => {
  const t = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(sgp4Omm)).unpack();
  t.USER_DEFINED_PARAMETERS = [new OMMUserDefinedParameterT("ANY", "1")];
  const b = new flatbuffers.Builder(512);
  OMM.finishOMMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
})();
refused("ingest_omm, one user-defined parameter", await ingest(userOmm), "user-defined-parameters:1");
// SPEC 17.6: the dedicated fields on the way out; the element-set slots on the way in, with the source stated
if (xpOmm && xpIn?.statusCode === 0) {
  const out = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(xpOmm)).unpack(), x = ocmOf(xp), back = ocmOf(new Uint8Array(xpIn.outputs[0].payload));
  check(Object.is(out.BTERM, x.MEAN_ELEMENTS.BTERM) && Object.is(out.AGOM, x.MEAN_ELEMENTS.AGOM) && out.BSTAR === 0 && out.MEAN_MOTION_DDOT === 0 &&
    JSON.stringify(back.HEADER?.COMMENT) === JSON.stringify(["BTERM_SOURCE=BTERM AGOM_SOURCE=AGOM"]) &&
    (sgp4 ? (ocmOf(sgp4).HEADER?.COMMENT ?? []).length === 0 : true), `the exported XP $OMM: BTERM ${out.BTERM}, AGOM ${out.AGOM}, BSTAR ${out.BSTAR}, MEAN_MOTION_DDOT ${out.MEAN_MOTION_DDOT}, comment ${back.HEADER?.COMMENT}`);
  const slots = Object.assign(OMM.getRootAsOMM(new flatbuffers.ByteBuffer(xpOmm)).unpack(), { BSTAR: out.BTERM, MEAN_MOTION_DDOT: out.AGOM, BTERM: 0, AGOM: 0 });
  const b = new flatbuffers.Builder(1024);
  OMM.finishOMMBuffer(b, slots.pack(b));
  const r = await ingest(b.asUint8Array().slice());
  check(r.statusCode === 0, `ingest_omm of the XP set in the element-set slots: ${r.errorCode} ${r.errorMessage}`);
  if (r.statusCode === 0) {
    const bytes = new Uint8Array(r.outputs[0].payload), o = ocmOf(bytes), comment = (o.HEADER?.COMMENT ?? []).join(" ");
    try { assertNoUserDefined(bytes); } catch (e) { check(false, `ingest_omm slots: ${e.message}`); }
    check(Object.is(o.MEAN_ELEMENTS.BTERM, x.MEAN_ELEMENTS.BTERM) && Object.is(o.MEAN_ELEMENTS.AGOM, x.MEAN_ELEMENTS.AGOM) && comment === "BTERM_SOURCE=BSTAR AGOM_SOURCE=MEAN_MOTION_DDOT",
      `the XP set from the slots: BTERM ${o.MEAN_ELEMENTS.BTERM}, AGOM ${o.MEAN_ELEMENTS.AGOM}, HEADER.COMMENT ${comment}`);
    const a = await invoke("propagate", flight([new Uint8Array(xpIn.outputs[0].payload)], { output: GRID_OUTPUT }));
    const c = await invoke("propagate", flight([bytes], { output: GRID_OUTPUT }));
    check(a.statusCode === 0 && c.statusCode === 0 && same(a.outputs[0].payload, c.outputs[0].payload), "the XP set from the slots flies to other bytes");
    console.log(`$OMM boundary: exported BTERM ${out.BTERM} and AGOM ${out.AGOM} in their fields (BSTAR ${out.BSTAR}, MEAN_MOTION_DDOT ${out.MEAN_MOTION_DDOT}); ` +
      `from the slots: BTERM ${o.MEAN_ELEMENTS.BTERM}, AGOM ${o.MEAN_ELEMENTS.AGOM}, source "${comment}"`);
  }
}
refused("ingest_omm, theory AP", await ingest((() => {
  const t = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(sgp4Omm)).unpack();
  t.MEAN_ELEMENT_THEORY = 5;
  const b = new flatbuffers.Builder(512);
  OMM.finishOMMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
})()), "theory-not-ingestable:AP");
// one record each
const rowOf = (date, k = 0) => Object.assign(new SPWT(), { DATE: date, F107_OBS: 150 + k, F107_OBS_CENTER81: 150, AP_AVG: 8, F107_DATA_TYPE: 0 });
const dcaNodes = (t, cid = "bafkreie2e") => {
  t.PERTURBATIONS.DENSITY_CORRECTION = pcfDensityCorrection.DCA_COMMON_MODE;
  t.PERTURBATIONS.DENSITY_CORRECTION_NODE_TIMES_MS = [BigInt(Date.parse("2026-09-30T00:00:00Z")), BigInt(Date.parse("2026-10-02T00:00:00Z"))];
  t.PERTURBATIONS.DENSITY_CORRECTION_LOG_DENSITY_SCALE_DIMENSIONLESS = [0.1, 0.2];
  t.PERTURBATIONS.DENSITY_CORRECTION_CID = cid;
};
const temeOfDate = () => new RFMT(RFMUnion.CelestialFrameWrapper, new CelestialFrameWrapperT(CelestialFrame.TEMEOFDATE), 0, "TEMEOFDATE");
const cases = [
  ["mean-elements-missing", ap, (t) => { t.MEAN_ELEMENTS = null; }],
  ["mean-element-theory-unspecified", ap, (t) => { t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = 6; }],
  ["theory-not-flown:DSST", ap, (t) => { t.MEAN_ELEMENTS.MEAN_ELEMENT_THEORY = 2; }],
  ["elements-other-theory", xp, (t) => { t.MEAN_ELEMENTS.BSTAR = 1e-4; }],
  ["orb-averaging-mismatch", xp, (t) => { t.ORB_AVERAGING = "KOZAI"; }],
  ["frame-pairing-invalid", ap, (t) => { t.TRAJ_REF_FRAME = temeOfDate(); t.TRAJ_FRAME_EPOCH = null; }],
  ["atmosphere-unsupported", ap, (t) => { t.PERTURBATIONS.ATMOSPHERIC_MODEL = new ATMT(AtmosphericModelFamily.JR71, 1971); }],
  ["weather-rows-missing", ap, (t) => { t.PERTURBATIONS.SPACE_WEATHER = []; }],
  ["weather-rows-invalid:2026-10-05", ap, (t) => { const r = t.PERTURBATIONS.SPACE_WEATHER; r.splice(6, 0, rowOf("2026-10-05", 9)); }],
  ["weather-rows-unselected", xp, (t) => { t.PERTURBATIONS.SPACE_WEATHER = [rowOf("2026-09-30"), rowOf("2026-10-01")]; }],
  ["density-correction-missing", ap, (t) => { t.PERTURBATIONS.DENSITY_CORRECTION = pcfDensityCorrection.DCA_COMMON_MODE; }],
  ["density-correction-unselected", ap, (t) => { dcaNodes(t); t.PERTURBATIONS.DENSITY_CORRECTION = pcfDensityCorrection.NONE; t.PERTURBATIONS.DENSITY_CORRECTION_CID = null; }],
  ["invalid-density-correction", ap, (t) => { dcaNodes(t); t.PERTURBATIONS.DENSITY_CORRECTION_LOG_DENSITY_SCALE_DIMENSIONLESS = [0.1]; }],
  ["density-correction-atmosphere-mismatch", ap, (t) => { dcaNodes(t); t.PERTURBATIONS.ATMOSPHERIC_MODEL = new ATMT(AtmosphericModelFamily.JXX, 1970); }],
  ["density-correction-cid-missing", ap, (t) => { dcaNodes(t, null); }],
  ["cov-parameter-kind-unspecified", ap, (t) => { t.COV_PARAMETER_KINDS = [0, 3]; }],
];
for (const [code, base, edit] of cases) refused(code, await invoke("propagate", flight([repackOcm(base, edit)], { output: GRID_OUTPUT })), code);
refused("one day past the last row", await invoke("propagate", flight([ap], { output: { START_TIME: "2026-10-31T12:00:00", STOP_TIME: "2026-11-01T12:00:00", STEP_SECONDS: 3600 } })),
  "weather-rows-short:2026-11-01");
// DCA on the record's nodes flies (its CID is provenance, not compared)
const dca = await invoke("propagate", flight([repackOcm(ap, (t) => dcaNodes(t))], { output: GRID_OUTPUT }));
check(dca.statusCode === 0, `AP with DCA nodes: ${dca.errorCode} ${dca.errorMessage}`);
refused("maneuver of the AP set", await invoke("maneuver", [...flight([ap]), { portId: "maneuvers", typeRef: T("MNV"), payload: new Uint8Array(0) }]), "theory-not-flown:AP");

// --- AP's terms against XP on FFM's trajectory
const truth = JSON.parse(zlib.gunzipSync(fs.readFileSync(fileURLToPath(new URL("fixtures/ffm-leo-550km-53deg.json.gz", import.meta.url)))));
const t0 = Date.parse(truth.epoch), step = truth.stepSeconds * 1000;
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const NO_DRAG = { DRAG_PRIOR: prior(0, 1e-7), DRAG_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED };
const TERMS = { ...XP_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20 };
const fitArc = async (forces) => {
  const r = await invoke("fit", [{ portId: "ephemeris", typeRef: T("OEM"), payload: arcOem(24) }, configuration({ fit: NO_DRAG, forces })]);
  check(r.statusCode === 0, `fit: ${r.errorCode} ${r.errorMessage}`);
  return new Uint8Array(r.outputs[0].payload);
};
const rmsAgainstTruth = async (set, firstK, lastK) => {
  const r = await invoke("propagate", flight([set], { output: { START_TIME: iso(t0 + firstK * step), STOP_TIME: iso(t0 + lastK * step), STEP_SECONDS: truth.stepSeconds, FRAME: pcfOutputFrame.GCRF } }));
  check(r.statusCode === 0, `propagate: ${r.errorCode} ${r.errorMessage}`);
  const lines = linesOf(new Uint8Array(r.outputs[0].payload));
  let sum = 0;
  lines.forEach((l, i) => { const s = truth.states[firstK + i]; sum += (l.X - s[0]) ** 2 + (l.Y - s[1]) ** 2 + (l.Z - s[2]) ** 2; });
  return Math.sqrt(sum / lines.length);
};
const K24 = (24 * 3600000) / step, K72 = (72 * 3600000) / step, K96 = (96 * 3600000) / step;
const xpSet = await fitArc(XP_FORCES), apSet = await fitArc(TERMS);
const xpFit = await rmsAgainstTruth(xpSet, 0, K24), apFit = await rmsAgainstTruth(apSet, 0, K24);
const xpDay3 = await rmsAgainstTruth(xpSet, K72, K96), apDay3 = await rmsAgainstTruth(apSet, K72, K96);
console.log(`24 h arc, GCRF RMS km: XP ${xpFit.toFixed(4)}, AP ${apFit.toFixed(4)}; 48 to 72 h past the arc: XP ${xpDay3.toFixed(3)}, AP ${apDay3.toFixed(3)}`);
check(ocmOf(apSet).MEAN_ELEMENTS.MEAN_ELEMENT_THEORY === 5 && ocmOf(xpSet).MEAN_ELEMENTS.MEAN_ELEMENT_THEORY === 1, "the theories written");
check(apFit < xpFit / 10, `AP's fit ${apFit} km is not below a tenth of XP's ${xpFit} km`);
check(apDay3 < xpDay3 / 3, `AP past the arc ${apDay3} km is not below a third of XP's ${xpDay3} km`);

// --- the sources
const sources = fs.readdirSync(`${packageRoot}src`).map((f) => [f, fs.readFileSync(`${packageRoot}src/${f}`, "utf8")]);
for (const [f, text] of sources) {
  for (const line of text.split("\n")) {
    if (/SDNAP_(?!EXPORT\b)/.test(line) || line.includes("USER_DEFINED_SDNAP")) check(false, `${f}: ${line.trim()}`);
    if (line.includes('ATMOSPHERE_MODEL"') && !/FORCES\.ATMOSPHERE_MODEL"|\{"ATMOSPHERE_MODEL", Kind::U8/.test(line)) check(false, `${f}: ${line.trim()}`);
  }
  if (text.includes("sdnap_set_omm_theory") || /omm_theory\(\)\s*=/.test(text)) check(false, `${f}: an omm_theory setter`);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\n$OCM flight E2E: PASS");
process.exit(0);
