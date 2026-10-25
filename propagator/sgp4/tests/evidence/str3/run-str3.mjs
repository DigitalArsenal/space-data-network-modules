// The module against its SGP4/SDP4 base. Element sets: the seven SGP4-VER sets of
// analysis/epoch-state/tests/vallado-verification.json (near-Earth, Molniya, GEO; elements only), the module's own
// test sets (ISS, the synthetic sun-synchronous object) and four regimes more (GPS, a 24-hour resonant GEO, a 12-hour
// resonant Molniya, a decaying LEO). Times: a day before epoch to ten days after. Each state of the built module
// (dist/browser, ingest_omm then propagate_state in TEME, the request at epoch + t/1440) is held to the base built
// natively without -ffast-math (library_states.cpp, clang++ -O2) at the minutes from epoch the module computes.
// Writes summary-str3.json: the largest position and velocity differences, per regime. Needs clang++.
//   node tests/evidence/str3/run-str3.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { invokePiv, loadRawSgp4Module } from "../../lib/pivInvokeHelper.mjs";
import { ReferenceFrame, SYNTHETIC_SSO, decodePropagatorState, encodeOmmPayload, encodePropagatorBatchRequest } from "../../lib/payloadEncoders.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, "../../../../..");
const OMM_TYPE = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const PROP_TYPE = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };
const verification = JSON.parse(fs.readFileSync(path.join(modules, "analysis/epoch-state/tests/vallado-verification.json"), "utf8")).cases;
const sets = [
  ...verification.map((c) => ({ regime: c.MEAN_MOTION < 1.5 ? "geo" : c.MEAN_MOTION < 6.4 ? "deep" : "near-earth", noradId: c.satnum, epoch: c.epochIso.replace(/Z$/, ""),
    meanMotion: c.MEAN_MOTION, eccentricity: c.ECCENTRICITY, inclination: c.INCLINATION, raan: c.RA_OF_ASC_NODE, argPericenter: c.ARG_OF_PERICENTER, meanAnomaly: c.MEAN_ANOMALY, bstar: c.BSTAR })),
  { regime: "near-earth", noradId: 25544, epoch: "2024-01-01T12:00:00", meanMotion: 15.5, eccentricity: 0.0005, inclination: 51.64, raan: 120, argPericenter: 80, meanAnomaly: 280, bstar: 0.00025 },
  { regime: "near-earth", ...SYNTHETIC_SSO, eccentricity: 0.00011 },
  { regime: "deep", noradId: 90001, epoch: "2024-03-01T06:00:00", meanMotion: 2.0056, eccentricity: 0.01, inclination: 55, raan: 30, argPericenter: 40, meanAnomaly: 50, bstar: 0 },
  { regime: "geo", noradId: 90002, epoch: "2024-03-01T06:00:00", meanMotion: 1.00273, eccentricity: 0.0002, inclination: 0.05, raan: 80, argPericenter: 200, meanAnomaly: 100, bstar: 0 },
  { regime: "deep", noradId: 90003, epoch: "2024-03-01T06:00:00", meanMotion: 2.00611, eccentricity: 0.72, inclination: 63.4, raan: 250, argPericenter: 270, meanAnomaly: 10, bstar: 0.0001 },
  { regime: "near-earth", noradId: 90004, epoch: "2024-03-01T06:00:00", meanMotion: 16.2, eccentricity: 0.001, inclination: 97, raan: 10, argPericenter: 20, meanAnomaly: 30, bstar: 0.002 },
];
const MINUTES = [-1440, -60, 0, 10, 90, 360, 720, 1440, 2880, 4320, 7200, 10080];
// The module's Julian date of an ISO epoch: the 367-day rule and the fraction of a day, as sgp4_base.hpp julianDay.
function julianDate(iso) {
  const [, y, mo, d, h, mi, s] = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(iso).map(Number);
  const jd = 367.0 * y - Math.floor((7 * (y + Math.floor((mo + 9) / 12.0))) * 0.25) + Math.floor((275 * mo) / 9.0) + d + 1721013.5;
  return jd + (s + mi * 60.0 + h * 3600.0) / 86400.0;
}

const module = await loadRawSgp4Module();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sgp4-str3-evidence-"));
try {
  const driver = path.join(work, "library_states");
  execFileSync("clang++", ["-std=c++17", "-O2", `-I${path.join(modules, "foundation/sgp4-str3/include")}`, path.join(here, "library_states.cpp"), "-o", driver]);
  for (const s of sets) {
    const ingest = invokePiv(module, { methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: OMM_TYPE, payload: encodeOmmPayload({ ...s, objectId: `9${s.noradId}`, objectName: `SET ${s.noradId}`, meanMotionDot: 0, meanMotionDdot: 0 }) }] });
    assert.equal(ingest.response.STATUS_CODE, 0, ingest.response.ERROR_MESSAGE);
  }
  const lines = [], expected = [];
  for (const s of sets) {
    const epoch = julianDate(s.epoch);
    const requests = MINUTES.map((t) => epoch + t / 1440);
    const minutes = requests.map((jd) => (jd - epoch) * 1440.0);
    expected.push({ s, requests });
    lines.push([(epoch - 2433281.5) + 2433281.5, s.meanMotion, s.eccentricity, s.inclination, s.raan, s.argPericenter, s.meanAnomaly, s.bstar, minutes.length, ...minutes]
      .map((x) => (Number.isInteger(x) ? String(x) : x.toPrecision(17))).join(" "));
  }
  const blocks = execFileSync(driver, { input: `${lines.join("\n")}\n`, encoding: "utf8" }).split("X\n").slice(0, -1);
  const summary = {};
  expected.forEach(({ s, requests }, k) => {
    const rows = blocks[k].trim().split("\n").map((l) => l.split(" ").map(Number));
    const worst = (summary[s.regime] ??= { sets: 0, states: 0, refusedBoth: 0, maxPositionM: 0, maxVelocityMps: 0, at: "" });
    worst.sets++;
    requests.forEach((jd, j) => {
      const answer = invokePiv(module, { methodId: "propagate_state", inputs: [{ portId: "request", typeRef: PROP_TYPE,
        payload: encodePropagatorBatchRequest({ epoch: jd, catalogNumbers: [s.noradId], outputFrame: ReferenceFrame.TEME }) }], outputStreamCap: 1 });
      assert.equal(answer.response.STATUS_CODE, 0, answer.response.ERROR_MESSAGE);
      const state = decodePropagatorState(answer.outputPayloads[0].bytes);
      const [t, status, ...rv] = rows[j];
      if (status !== 0) { assert.ok(!state.valid, `${s.noradId} at ${t} min: the base refuses (${status}), the module answers`); worst.refusedBoth++; return; }
      assert.ok(state.valid, `${s.noradId} at ${t} min: the module refuses a state the base gives`);
      const dr = Math.hypot(...[0, 1, 2].map((i) => state.position[i] - rv[i] * 1000));
      const dv = Math.hypot(...[0, 1, 2].map((i) => state.velocity[i] - rv[i + 3] * 1000));
      worst.states++;
      if (dr > worst.maxPositionM) { worst.maxPositionM = dr; worst.at = `${s.noradId} at ${t.toFixed(3)} min`; }
      worst.maxVelocityMps = Math.max(worst.maxVelocityMps, dv);
    });
  });
  const out = { module: "propagator/sgp4", reference: "foundation/sgp4-str3, native, no -ffast-math (library_states.cpp)", minutes: MINUTES, regimes: summary };
  fs.writeFileSync(path.join(here, "summary-str3.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out.regimes, null, 1));
} finally {
  module._plugin_destroy();
  fs.rmSync(work, { recursive: true, force: true });
}
