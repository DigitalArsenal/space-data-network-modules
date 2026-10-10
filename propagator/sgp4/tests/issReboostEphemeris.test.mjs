// A real element-set history through propagate_ephemeris and
// analysis/maneuver-detection detect_maneuvers.
//
// Reference: the ISS reboost of 2024-05-24, as docs/studies/maneuver-detection.md
// records it. NASA's JSC trajectory plans list it at TIG 14:16 UTC (1.1 m/s;
// a later plan repeats it at 23:03). The study propagated the same
// Space-Track history with python-sgp4 2.27, packed May 2024 with a 5-day
// margin as one $OEM (TEME, 60 s, each set from two sets before to two sets
// after) and ran the detector with default options: one event, at 14:56,
// 1.06 m/s in-track.
//
// Here this module writes the trajectories (the same Vallado SGP4, so the
// same states to the millimetre) and the same detector reads them. The event
// must match the burn as the study matches (3 h before to 36 h after the TIG)
// and repeat the study's detection: within 5 min of 14:56 (printed to the
// minute; the 60 s grids differ: the study's whole minutes, this module's
// each block's start) and within 0.05 m/s of 1.06 m/s (printed to 0.01 m/s).
//
// The element sets come from the local SDN GP archive (Space-Track gp_history
// by creation day; one set per EPOCH, the latest CREATION_DATE, as
// study/gp_history.py chooses) and are never stored here. Without the archive
// (SDN_ARCHIVE_ROOT, default /opt/data/sdn-archive) the test is skipped.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

import { invokePiv, loadRawSgp4Module } from "./lib/pivInvokeHelper.mjs";
import { ReferenceFrame, encodeOmmPayload, encodePropagatorBatchRequest, encodeSizePrefixedStream } from "./lib/payloadEncoders.mjs";

const ARCHIVE = path.join(process.env.SDN_ARCHIVE_ROOT ?? "/opt/data/sdn-archive", "spacetrack", "gp_history", "by-creation");
const ISS = "25544";
const WINDOW = ["2024-04-26", "2024-06-06"];   // May 2024 with the study's 5-day margin
const TIG = Date.parse("2024-05-24T14:16:00Z") / 1000;
const STUDY = { time: Date.parse("2024-05-24T14:56:00Z") / 1000, inTrackMps: 1.06 };

// The ISS records of one creation day, read without parsing the day's other
// records (each record is one flat JSON object).
function issRecords(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  const records = [];
  for (let at = text.indexOf(`"NORAD_CAT_ID":"${ISS}"`); at >= 0; at = text.indexOf(`"NORAD_CAT_ID":"${ISS}"`, at + 1)) {
    records.push(JSON.parse(text.slice(text.lastIndexOf("{", at), text.indexOf("}", at) + 1)));
  }
  return records;
}

function history() {
  const latest = new Map();
  for (let day = Date.parse(`${WINDOW[0]}T00:00:00Z`) - 86400000; day <= Date.parse(`${WINDOW[1]}T00:00:00Z`) + 3 * 86400000; day += 86400000) {
    const name = new Date(day).toISOString().slice(0, 10);
    const file = path.join(ARCHIVE, name.slice(0, 4), `${name}.json.gz`);
    if (!fs.existsSync(file)) continue;
    for (const r of issRecords(file)) {
      if (r.MEAN_ELEMENT_THEORY !== "SGP4" || String(r.EPHEMERIS_TYPE ?? "0") !== "0") continue;
      if (r.EPOCH < WINDOW[0] || r.EPOCH >= WINDOW[1]) continue;
      const known = latest.get(r.EPOCH);
      if (!known || r.CREATION_DATE >= known.CREATION_DATE) latest.set(r.EPOCH, r);
    }
  }
  return [...latest.keys()].sort().map((epoch) => latest.get(epoch));
}

test("SGP4 element-set trajectories of the ISS show the 2024-05-24 reboost to maneuver-detection", { skip: !fs.existsSync(ARCHIVE) && `no GP archive at ${ARCHIVE}` }, async (t) => {
  const sets = history();
  assert.ok(sets.length > 100, `only ${sets.length} ISS element sets in the window`);
  const module = await loadRawSgp4Module();
  let oem;
  try {
    const ingest = invokePiv(module, { methodId: "ingest_omm", inputs: [{ portId: "omm",
      typeRef: { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" },
      payload: encodeSizePrefixedStream(sets.map((r) => encodeOmmPayload({
        noradId: Number(r.NORAD_CAT_ID), objectName: r.OBJECT_NAME, objectId: r.OBJECT_ID, epoch: r.EPOCH,
        meanMotion: Number(r.MEAN_MOTION), eccentricity: Number(r.ECCENTRICITY), inclination: Number(r.INCLINATION),
        raan: Number(r.RA_OF_ASC_NODE), argPericenter: Number(r.ARG_OF_PERICENTER), meanAnomaly: Number(r.MEAN_ANOMALY),
        bstar: Number(r.BSTAR), meanMotionDot: Number(r.MEAN_MOTION_DOT), meanMotionDdot: Number(r.MEAN_MOTION_DDOT),
      }))) }] });
    assert.equal(ingest.response.STATUS_CODE, 0, ingest.response.ERROR_MESSAGE);
    const result = invokePiv(module, { methodId: "propagate_ephemeris", outputStreamCap: 1, inputs: [{ portId: "request",
      typeRef: { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" },
      payload: encodePropagatorBatchRequest({ epoch: 0, catalogNumbers: [Number(ISS)], outputFrame: ReferenceFrame.TEME,
        stepSeconds: 60, elementSetBlocks: true, neighbourSets: 2 }) }] });
    assert.equal(result.response.STATUS_CODE, 0, result.response.ERROR_MESSAGE);
    oem = result.outputPayloads[0].bytes;
  } finally {
    module._plugin_destroy();
  }

  const dir = new URL("../../../analysis/maneuver-detection/", import.meta.url);
  const detector = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(new URL("dist/isomorphic/module.wasm", dir)),
    manifest: JSON.parse(fs.readFileSync(new URL("plugin-manifest.json", dir))), surface: "direct" });
  let events;
  try {
    const detected = await detector.invoke({ methodId: "detect_maneuvers", inputs: [{ portId: "ephemerides", payload: oem,
      typeRef: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat: "flatbuffer" } }] });
    assert.equal(detected.statusCode, 0, detected.errorMessage);
    const report = JSON.parse(Buffer.from(detected.outputs.find((o) => o.portId === "report").payload).toString("utf8"));
    events = report.objects[0].events;
  } finally {
    detector.destroy?.();
  }
  const seconds = (text) => Date.parse(text.endsWith("Z") ? text : `${text}Z`) / 1000;
  const matching = events.filter((e) => seconds(e.time) - TIG > -3 * 3600 && seconds(e.time) - TIG < 36 * 3600);
  t.diagnostic(`${sets.length} element sets; events ${JSON.stringify(events.map((e) => [e.time, e.in_track_mps]))}`);
  assert.equal(matching.length, 1, "one event matches the reboost");
  const [event] = matching;
  assert.ok(Math.abs(seconds(event.time) - STUDY.time) <= 300, `event at ${event.time}, the study's at 14:56`);
  assert.ok(Math.abs(event.in_track_mps - STUDY.inTrackMps) <= 0.05, `in-track ${event.in_track_mps} m/s, the study's 1.06`);
});
