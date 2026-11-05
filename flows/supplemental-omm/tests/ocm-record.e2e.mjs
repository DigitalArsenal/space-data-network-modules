#!/usr/bin/env node
// E2E (task modules-supplemental-omm-xp-ocm-20261103): the OD node writes every fit as $OCM with FIT_STATISTICS and
// no $OBD. On tests/fixtures/starlink-synthetic-12h.oem (a synthetic Starlink-style 12 h ephemeris) on the 'starlink'
// port, against what the OD node of modules main 1f806e4bf6 wrote for it (tests/fixtures/starlink-previous-*):
// - the SGP4-XP window arrives on 'ocm' as an $OCM: MEAN_ELEMENTS SGP4XP equal to the previous XP $OMM's elements bit
//   for bit (BTERM its BSTAR, AGOM its MEAN_MOTION_DDOT), stock forces (WEATHER_SOURCE THEORY_FLUX_MODEL, {JXX,1970},
//   EGM-96), FIT_STATISTICS equal bit for bit to the window's $OCM recorded from the 2.1.1 node
//   (tests/fixtures/starlink-xp.ocm, tests/fixtures/record-xp.mjs: the previous figures were scored with the 0.1.1
//   flight, which returned partial integrator steps), PROVENANCE naming the source module and the library;
// - each OD core epoch arrives as its state $OCM (the previous bytes) and an SGP4 $OCM (MEAN_ELEMENTS SGP4 equal to the
//   core's $OMM, WEATHER_SOURCE NONE, FIT_STATISTICS: FIT_RMS_KM and ITERATIONS equal to the previous $OBD's), and as
//   the core's SGP4 $OMM (the previous bytes) whose COMMENT holds no number;
// - no 'obd' or 'obd_meta' output, no OBD port in the manifest; assertNoUserDefined on every $OMM and $OCM.
// E2E (task modules-supplemental-omm-od-node-sgp4-xp-0-2-2-20261105): the node rebuilt on propagator/sgp4-xp 0.2.2,
// which flies an SGP4-XP set's times in chains of new library satellites, answers what the 2.1.1 node over 0.2.1 (a
// new satellite per time) answered: on every input of the node's tests (tests/lib/answers.mjs) every record bit for
// bit but the version in PROVENANCE.PRODUCER, which names this node's version and propagator/sgp4-xp's, and the same
// notices (tests/fixtures/answers-2-1-1.json); each input's fit timed, median of three, against the record's.
// JS only moves bytes and compares numbers the node produced.
//   cd flows/supplemental-omm && node tests/ocm-record.e2e.mjs
import fs from "node:fs";
import path from "node:path";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { answerInputs, answersOf, median } from "./lib/answers.mjs";
import { modulesRoot, packageRoot, splitRecords } from "./lib/flow.mjs";
import { fit, odNode } from "./lib/nodes.mjs";
import { decodeIngestRequest, decodeObdRecord, decodeOcmRecord, decodeOmmRecord } from "./lib/sds.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const fixture = (name) => fs.readFileSync(path.join(packageRoot, "tests/fixtures", name));
const hex = (r) => Buffer.from(r).toString("hex");
const t = { after: () => {} };
const node = await odNode(t);
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "nodes/od/plugin-manifest.json"), "utf8"));
const fitMethod = manifest.methods.find((m) => m.methodId === "fit");
check(!fitMethod.outputPorts.some((p) => /obd/.test(p.portId)) && !manifest.schemasUsed.some((s) => s.schemaName === "OBD.fbs"), "the manifest still declares an OBD output");

// Every output frame of the fit, by port (fit() asserts no port beyond omm, ocm, *_meta and status).
const raw = await node.invoke({ methodId: "fit", inputs: [{ portId: "starlink", typeRef: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat: "flatbuffer" }, payload: new Uint8Array(fixture("starlink-synthetic-12h.oem")) }] });
check(raw.statusCode === 0, `fit: ${raw.errorCode} ${raw.errorMessage}`);
const ports = raw.outputs.map((o) => o.portId);
check(!ports.some((p) => /obd/.test(p)), `outputs on ${ports.join(", ")}`);
const out = { omm: [], ocm: [], meta: [] };
for (const o of raw.outputs) {
  if (o.portId === "omm" || o.portId === "ocm") out[o.portId].push(...splitRecords(o.payload));
  else if (o.portId.endsWith("_meta")) out.meta.push(decodeIngestRequest(o.payload));
}
check(JSON.stringify(out.meta.map((m) => m.schema)) === JSON.stringify(["OMM.fbs", "OCM.fbs"]), `IngestRequests: ${out.meta.map((m) => m.schema).join(", ")}`);
for (const r of [...out.omm, ...out.ocm]) {
  try { assertNoUserDefined(r); } catch (e) { check(false, e.message); }
}

// the SGP4 $OMM: the core's, unchanged; no number in its COMMENT
const prevSgp4 = splitRecords(fixture("starlink-previous-sgp4.omm"));
check(out.omm.length === prevSgp4.length && out.omm.every((r, i) => hex(r) === hex(prevSgp4[i])), `the SGP4 $OMM: ${out.omm.length} records against ${prevSgp4.length}, not the previous bytes`);
check(out.omm.map(decodeOmmRecord).every((o) => o.MEAN_ELEMENT_THEORY === 0 && !/\d/.test(o.COMMENT ?? "")), "an $OMM is not SGP4 or its COMMENT holds a number");

// the ocm stream: per core epoch its state $OCM and its SGP4 $OCM, then the XP windows
const ocms = out.ocm.map(decodeOcmRecord);
const prevState = splitRecords(fixture("starlink-previous.ocm"));
const prevObd = splitRecords(fixture("starlink-previous.obd")).map(decodeObdRecord);
const sgp4Sets = ocms.filter((o) => o.MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY === 0);
const xpSets = ocms.filter((o) => o.MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY === 1);
const states = out.ocm.filter((r, i) => !ocms[i].MEAN_ELEMENTS);
check(states.length === prevState.length && states.every((r, i) => hex(r) === hex(prevState[i])), `the core's state $OCM: ${states.length} against ${prevState.length}, not the previous bytes`);
check(sgp4Sets.length === prevSgp4.length && xpSets.length === 1 && ocms.length === states.length + sgp4Sets.length + xpSets.length, `ocm stream: ${states.length} state, ${sgp4Sets.length} SGP4, ${xpSets.length} SGP4XP`);
let bits = 0;
const same = (a, b, what) => { bits += 1; check(Object.is(a, b), `${what}: ${a} against ${b}`); };
sgp4Sets.forEach((o, k) => {
  const omm = decodeOmmRecord(prevSgp4[k]), obd = prevObd[k], me = o.MEAN_ELEMENTS, pt = o.PERTURBATIONS, fs_ = o.ORBIT_DETERMINATION?.FIT_STATISTICS;
  for (const key of ["MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT", "EPOCH"]) same(me[key], omm[key], `SGP4 set ${k + 1} ${key}`);
  check(pt.WEATHER_SOURCE === 4 && !pt.ATMOSPHERIC_MODEL && pt.GRAVITY_MODEL === "WGS-72" && o.ORB_AVERAGING === "KOZAI" && o.METADATA.NORAD_CAT_ID === 90001, `SGP4 set ${k + 1}: forces or identity`);
  check(fs_ != null, `SGP4 set ${k + 1}: no FIT_STATISTICS`);
  if (fs_) { same(fs_.FIT_RMS_KM, obd.WRMS, `SGP4 set ${k + 1} FIT_RMS_KM (the previous $OBD WRMS)`); check(fs_.ITERATIONS === obd.NUM_ITERATIONS && fs_.CONVERGED === true && o.ORBIT_DETERMINATION.ACTUAL_OD_SPAN === obd.FIT_SPAN, `SGP4 set ${k + 1}: iterations, convergence, span`); }
});
const prevXp = splitRecords(fixture("starlink-previous-xp.omm")).map(decodeOmmRecord);
const recordedXp = splitRecords(fixture("starlink-xp.ocm")).map(decodeOcmRecord);
xpSets.forEach((o, k) => {
  const old = prevXp[k], me = o.MEAN_ELEMENTS, pt = o.PERTURBATIONS, fs_ = o.ORBIT_DETERMINATION.FIT_STATISTICS;
  for (const key of ["MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "EPOCH"]) same(me[key], old[key], `XP set ${k + 1} ${key}`);
  same(me.BTERM, old.BSTAR, `XP set ${k + 1} BTERM (the previous BSTAR)`);
  same(me.AGOM, old.MEAN_MOTION_DDOT, `XP set ${k + 1} AGOM (the previous MEAN_MOTION_DDOT)`);
  check(pt.WEATHER_SOURCE === 3 && pt.ATMOSPHERIC_MODEL?.YEAR === 1970 && pt.GRAVITY_MODEL === "EGM-96" && pt.SPACE_WEATHER.length === 0 && o.ORB_AVERAGING === "BROUWER", `XP set ${k + 1}: forces`);
  check(o.HEADER.ORIGINATOR === "SpaceX" && o.PROVENANCE.SOURCE_ID === "com.orbpro.spacex-starlink-source" && /US Space Force Sgp4Prop 9\.1\.1\.0/.test(o.PROVENANCE.PRODUCER), `XP set ${k + 1}: provenance ${o.HEADER.ORIGINATOR} ${o.PROVENANCE.SOURCE_ID} ${o.PROVENANCE.PRODUCER}`);
  const want = recordedXp[k]?.ORBIT_DETERMINATION?.FIT_STATISTICS;
  check(want != null, `XP set ${k + 1}: no recorded $OCM`);
  if (want) {
    for (const key of ["FIT_START", "FIT_STOP", "FIT_STATES", "FIT_RMS_KM", "FIT_MAX_KM", "FIT_RADIAL_RMS_KM", "FIT_IN_TRACK_RMS_KM", "FIT_CROSS_TRACK_RMS_KM", "ITERATIONS", "CONVERGED",
      "HELD_OUT_STOP", "HELD_OUT_STATES", "HELD_OUT_RMS_KM", "HELD_OUT_MAX_KM"]) same(fs_[key], want[key], `XP set ${k + 1} ${key}`);
    check(fs_.HELD_OUT_DAYS.length === want.HELD_OUT_DAYS.length && fs_.HELD_OUT_DAYS.every((d, i) => d.DAY === want.HELD_OUT_DAYS[i].DAY && d.STATES === want.HELD_OUT_DAYS[i].STATES && Object.is(d.RMS_KM, want.HELD_OUT_DAYS[i].RMS_KM)), `XP set ${k + 1}: held-out days`);
  }
  console.log(`XP window ${k + 1}: ${me.EPOCH} n ${me.MEAN_MOTION}; fit ${fs_.FIT_STATES} states ${fs_.FIT_RMS_KM} km, held out ${fs_.HELD_OUT_STATES} ${fs_.HELD_OUT_RMS_KM} km`);
});
console.log(`starlink: ${out.omm.length} SGP4 $OMM (previous bytes), ${states.length} state $OCM (previous bytes), ${sgp4Sets.length} SGP4 $OCM, ${xpSets.length} SGP4-XP $OCM; ${bits} values bit for bit; outputs ${[...new Set(ports)].join(", ")}`);
await node.destroy();

// every record of every input of the node's tests against the 2.1.1 node's
const recorded = JSON.parse(fs.readFileSync(path.join(packageRoot, "tests/fixtures/answers-2-1-1.json"), "utf8"));
const engineVersion = JSON.parse(fs.readFileSync(path.join(modulesRoot, "propagator/sgp4-xp/package.json"), "utf8")).version;
const inputs = await answerInputs();
check(JSON.stringify(Object.keys(inputs)) === JSON.stringify(recorded.inputs.map((i) => i.name)), `inputs ${Object.keys(inputs).join(", ")}`);
let records = 0, sameRecords = 0, xpRecords = 0, sameXp = 0;
const times = [];
for (const before of recorded.inputs) {
  const now = await answersOf(inputs[before.name]);
  check(now.records.length === before.records.length && now.invocations === before.invocations, `${before.name}: ${now.records.length} records in ${now.invocations} invocations against ${before.records.length} in ${before.invocations}`);
  before.records.forEach((r, i) => {
    const same = now.records[i]?.kind === r.kind && now.records[i]?.standard === r.standard && now.records[i]?.sha256 === r.sha256;
    records += 1;
    sameRecords += same ? 1 : 0;
    if (r.kind === "ocm-sgp4xp") { xpRecords += 1; sameXp += same ? 1 : 0; }
    check(same, `${before.name} record ${i + 1} (${r.kind}): not the 2.1.1 node's`);
  });
  check(JSON.stringify(now.notices) === JSON.stringify(before.notices), `${before.name}: notices ${now.notices.join("; ")}`);
  check(now.versions.node.every((v) => v === manifest.version) && now.versions.engine.every((v) => v === engineVersion) && (before.versions.engine.length === 0) === (now.versions.engine.length === 0),
    `${before.name}: PRODUCER names node ${now.versions.node} and propagator/sgp4-xp ${now.versions.engine}, not ${manifest.version} and ${engineVersion}`);
  times.push(`${before.name} ${median(before.ms)} -> ${median(now.ms)}`);
}
check(manifest.version !== recorded.node.version, `the node under test is ${manifest.version}, the recorded one's version`);
console.log(`answers: ${sameRecords} of ${records} records of ${recorded.inputs.length} inputs bit for bit with the ${recorded.node.version} node's (${sameXp} of ${xpRecords} SGP4-XP sets), PRODUCER naming node ${manifest.version} over propagator/sgp4-xp ${engineVersion}`);
console.log(`fit ms, median of 3, ${recorded.node.version} -> ${manifest.version}: ${times.join("; ")}`);

if (failures.length) {
  console.error(`OD NODE OCM RECORD: FAIL (${failures.length})\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("OD NODE OCM RECORD: PASS");
process.exit(0);
