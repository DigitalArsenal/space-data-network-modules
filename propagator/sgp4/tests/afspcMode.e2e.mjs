// AFSPC mode (propagator/sgp4 1.4.0): SGP4/SDP4 is foundation/sgp4-str3 in AFSPC mode, the mode of the operational
// code and of the conjunction screen (analysis/conjunction-assessment 0.11.0); one mode for both.
// (1) Space-Track's 2026-10-29 element sets (tests/fixtures/spacetrack-gp, cited there), every state over 7 days at
//     a 6 h step: the built module (dist/browser: ingest_omm, then propagate_state in TEME, the request at
//     epoch + t/1440) equals the base built natively in AFSPC mode (tests/evidence/str3/library_states.cpp,
//     clang++ -O2, no -ffast-math) within 0.1 mm and 0.1 mm/s, at the minutes from epoch the module computes. The
//     five low-inclination deep-space sets whose node crosses 0 are where the modes part: the same base in
//     improved mode is more than a meter off there, so the check sees the mode.
// (2) Spacetrack Report No. 3's SGP4 test case 88888 (Hoots and Roehrich 1980, p. 81): the module's states at 0 to
//     1440 min equal the report's published values within 15 m and 20 mm/s. The report's cases carry 8 digits at
//     epoch and only 5 to 6 after a one-day prediction (its footnote, p. 79).
// Run: node --test tests/afspcMode.e2e.mjs (needs dist/ built and clang++).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { invokePiv, loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";
import { ReferenceFrame, decodePropagatorState, encodeOmmPayload, encodePropagatorBatchRequest } from "./lib/payloadEncoders.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, "../../..");
const OMM_TYPE = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const PROP_TYPE = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };
const NODE_NEAR_ZERO = [40942, 33461, 29165, 32021, 58346];
const spaceTrack = JSON.parse(fs.readFileSync(path.join(here, "fixtures/spacetrack-gp/gp-2026-10-29.json"), "utf8")).map((r) => ({
  noradId: Number(r.NORAD_CAT_ID), epoch: r.EPOCH, meanMotion: Number(r.MEAN_MOTION), eccentricity: Number(r.ECCENTRICITY),
  inclination: Number(r.INCLINATION), raan: Number(r.RA_OF_ASC_NODE), argPericenter: Number(r.ARG_OF_PERICENTER),
  meanAnomaly: Number(r.MEAN_ANOMALY), bstar: Number(r.BSTAR) }));
// STR#3 p. 81: 88888's elements (its TLE) and the published SGP4 states (km, km/s).
const STR3 = { noradId: 88888, epoch: "1980-10-01T23:41:24.113760", meanMotion: 16.05824518, eccentricity: 0.0086731, inclination: 72.8435,
  raan: 115.9689, argPericenter: 52.6988, meanAnomaly: 110.5714, bstar: 0.66816e-4 };
const STR3_STATES = {
  0: [2328.97048951, -5995.22076416, 1719.97067261, 2.91207230, -0.98341546, -7.09081703],
  360: [2456.10705566, -6071.93853760, 1222.89727783, 2.67938992, -0.44829041, -7.22879231],
  720: [2567.56195068, -6112.50384522, 713.96397400, 2.44024599, 0.09810869, -7.31995916],
  1080: [2663.09078980, -6115.48229980, 196.39640427, 2.19611958, 0.65241995, -7.36282432],
  1440: [2742.55133057, -6079.67144775, -326.38095856, 1.94850229, 1.21106251, -7.35619372],
};
const MINUTES = Array.from({ length: 29 }, (_, k) => 360 * k);
// The module's Julian date of an ISO epoch: the 367-day rule and the fraction of a day, as sgp4_base.hpp julianDay.
function julianDate(iso) {
  const [, y, mo, d, h, mi, s] = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d(?:\.\d+)?)/.exec(iso).map(Number);
  const jd = 367.0 * y - Math.floor((7 * (y + Math.floor((mo + 9) / 12.0))) * 0.25) + Math.floor((275 * mo) / 9.0) + d + 1721013.5;
  return jd + (s + mi * 60.0 + h * 3600.0) / 86400.0;
}

test("SGP4/SDP4 runs in AFSPC mode: the module equals its AFSPC base; STR#3's 88888 as published", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sgp4-afspc-"));
  const module = await loadRawSgp4Module();
  try {
    const driver = path.join(work, "library_states");
    execFileSync("clang++", ["-std=c++17", "-O2", `-I${path.join(modules, "foundation/sgp4-str3/include")}`,
      path.join(here, "evidence/str3/library_states.cpp"), "-o", driver]);
    const sets = [...spaceTrack, STR3];
    for (const s of sets) {
      const ingest = invokePiv(module, { methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: OMM_TYPE,
        payload: encodeOmmPayload({ ...s, objectId: `9${s.noradId}`, objectName: `SET ${s.noradId}`, meanMotionDot: 0, meanMotionDdot: 0 }) }] });
      assert.equal(ingest.response.STATUS_CODE, 0, ingest.response.ERROR_MESSAGE);
    }
    // The module's states, and the minutes from epoch it computes for each request
    const answers = sets.map((s) => {
      const epoch = julianDate(s.epoch);
      const times = s === STR3 ? Object.keys(STR3_STATES).map(Number) : MINUTES;
      return { s, epoch, times, states: times.map((t) => {
        const answer = invokePiv(module, { methodId: "propagate_state", inputs: [{ portId: "request", typeRef: PROP_TYPE,
          payload: encodePropagatorBatchRequest({ epoch: epoch + t / 1440, catalogNumbers: [s.noradId], outputFrame: ReferenceFrame.TEME }) }], outputStreamCap: 1 });
        assert.equal(answer.response.STATUS_CODE, 0, answer.response.ERROR_MESSAGE);
        return decodePropagatorState(answer.outputPayloads[0].bytes);
      }), minutes: times.map((t) => (epoch + t / 1440 - epoch) * 1440.0) };
    });
    const base = (mode) => {
      // the epoch as the module carries it: days from 1949 December 31 0h, then the Julian date of that
      const input = answers.map(({ s, epoch, minutes }) => [(epoch - 2433281.5) + 2433281.5, s.meanMotion, s.eccentricity, s.inclination, s.raan, s.argPericenter,
        s.meanAnomaly, s.bstar, minutes.length, ...minutes].map((x) => (Number.isInteger(x) ? String(x) : x.toPrecision(17))).join(" "));
      return execFileSync(driver, mode ? [mode] : [], { input: `${input.join("\n")}\n`, encoding: "utf8" }).split("X\n").slice(0, -1)
        .map((block) => block.trim().split("\n").map((l) => l.split(" ").map(Number)));
    };
    const afspc = base(), improved = base("improved");
    const summary = [];
    let dr = 0, dv = 0;
    answers.forEach(({ s, times, states }, k) => {
      let modeGap = 0;
      states.forEach((state, j) => {
        const [, status, ...rv] = afspc[k][j];
        if (status !== 0) { assert.ok(!state.valid, `${s.noradId} at ${times[j]} min: the base refuses (${status}), the module answers`); return; }
        assert.ok(state.valid, `${s.noradId} at ${times[j]} min: the module refuses a state its base gives`);
        dr = Math.max(dr, Math.hypot(...[0, 1, 2].map((i) => state.position[i] - rv[i] * 1000)));
        dv = Math.max(dv, Math.hypot(...[0, 1, 2].map((i) => state.velocity[i] - rv[i + 3] * 1000)));
        const [, other, ...iv] = improved[k][j];
        if (other === 0) modeGap = Math.max(modeGap, Math.hypot(...[0, 1, 2].map((i) => rv[i] * 1000 - iv[i] * 1000)));
        if (s === STR3) {
          const published = STR3_STATES[times[j]];
          const pr = Math.hypot(...[0, 1, 2].map((i) => state.position[i] - published[i] * 1000));
          const pv = Math.hypot(...[0, 1, 2].map((i) => state.velocity[i] - published[i + 3] * 1000));
          assert.ok(pr <= 15 && pv <= 0.02, `STR#3 88888 at ${times[j]} min: ${pr} m and ${pv} m/s from the published state`);
          summary.push(`STR#3 88888 at ${times[j]} min: ${pr.toFixed(2)} m, ${(pv * 1000).toFixed(2)} mm/s from the published state`);
        }
      });
      if (NODE_NEAR_ZERO.includes(s.noradId)) {
        assert.ok(modeGap > 1, `${s.noradId}: the improved mode is only ${modeGap} m from the AFSPC mode over 7 days`);
        summary.push(`${s.noradId}: improved mode ${modeGap.toFixed(1)} m from AFSPC over 7 days`);
      }
    });
    assert.ok(dr <= 1e-4 && dv <= 1e-4, `the module is ${dr} m and ${dv} m/s from its AFSPC base`);
    console.log([`module against its AFSPC base: ${dr.toExponential(2)} m, ${dv.toExponential(2)} m/s`, ...summary].join("\n"));
  } finally {
    module._plugin_destroy();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
