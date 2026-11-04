// The inputs of the 0.4.0 fixtures (test/fixtures/*-0.4.0.*), shared by the E2Es that replay them: 24 h of
// propagator/ffm's 550 km trajectory (test/fixtures/ffm-leo-550km-53deg.json.gz, GCRF) as one $OEM block, daily $SPW
// rows from 2026-09-28 to 2026-11-03 (observed through 2026-10-01, predicted after), and the fixture grid. Recorded on
// the sdn-ap 0.4.18 dist (modules f34c12c0), before the $OCM: ap-fit-0.4.0.omm is fit under $PCF THEORY SGP4XP, FORCES
// MAXIMUM_TESSERAL_DEGREE 31, MAXIMUM_DEGREE 20, ENABLE_DRAG, NRLMSISE00, WEATHER_SOURCE RECORDS on these rows;
// xp-fit-0.4.0.omm under no FORCES; ap-fit-0.4.0.oem and ap-fit-0.4.0.epochs.oem are propagate and propagate_epochs of
// the AP set on GRID under the same FORCES and rows; xp-fit-0.4.0.cov is sdnap_covariance_at of the XP set at GRID's
// minutes (42 little-endian doubles a time: the TEME state, then the 6 x 6 row-major). JS only moves bytes.
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as BlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT as LineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { SPW, SPWT } from "spacedatastandards.org/lib/js/SPW/SPW.js";
import { F107DataType } from "spacedatastandards.org/lib/js/SPW/F107DataType.js";
import { packOem, rfm } from "./frames.mjs";

const DAY = 86400000;
/** The fixture grid: the set's epoch to two days later at 600 s, TEME. */
export const GRID = Object.freeze({ start: "2026-10-01T00:00:00.000", stop: "2026-10-03T00:00:00.000", step: 600, minutes: 2880 });
export const OBJECT = Object.freeze({ NORAD_CAT_ID: 90400, OBJECT_ID: "2026-904A", OBJECT_NAME: "AP E2E" });
export const ROWS = Object.freeze({ first: "2026-09-28", days: 37, lastObserved: "2026-10-01" });

/** $SPW rows `first` .. `first + days - 1` as size-prefixed records end to end, and their values. */
export function spwRows({ first = ROWS.first, days = ROWS.days, skip = null } = {}) {
  const parts = [], values = [];
  const t0 = Date.parse(`${first}T00:00:00Z`);
  for (let k = 0; k < days; k++) {
    const date = new Date(t0 + k * DAY).toISOString().slice(0, 10);
    if (date === skip) continue;
    const r = Object.assign(new SPWT(), { DATE: date, F107_OBS: 140 + 13 * (k % 5), F107_OBS_CENTER81: 144 + 2 * k, AP_AVG: 7 + 9 * (k % 4),
      F107_DATA_TYPE: date <= ROWS.lastObserved ? F107DataType.OBS : F107DataType.PRD });
    const b = new flatbuffers.Builder(256);
    SPW.finishSizePrefixedSPWBuffer(b, r.pack(b));
    parts.push(b.asUint8Array().slice());
    values.push({ DATE: date, F107_OBS: Math.fround(r.F107_OBS), F107_OBS_CENTER81: Math.fround(r.F107_OBS_CENTER81), AP_AVG: r.AP_AVG, F107_DATA_TYPE: r.F107_DATA_TYPE });
  }
  return { bytes: Buffer.concat(parts), values };
}

/** 24 h of the 550 km trajectory from its first state, GCRF, USEABLE_START_TIME and USEABLE_STOP_TIME stated. */
export function arcOem(hours = 24) {
  const truth = JSON.parse(zlib.gunzipSync(fs.readFileSync(fileURLToPath(new URL("../fixtures/ffm-leo-550km-53deg.json.gz", import.meta.url)))));
  const t0 = Date.parse(truth.epoch), step = truth.stepSeconds * 1000;
  const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
  const n = (hours * 3600000) / step + 1;
  const lines = truth.states.slice(0, n).map((s, k) => Object.assign(new LineT(), { EPOCH: iso(t0 + k * step), X: s[0], Y: s[1], Z: s[2], X_DOT: s[3], Y_DOT: s[4], Z_DOT: s[5] }));
  const block = Object.assign(new BlockT(), { OBJECT: Object.assign(new CATT(), OBJECT), CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("GCRF"), TIME_SYSTEM: timingStandard.UTC,
    START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
  return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [block] })).slice();
}

export const inputs = () => ({ arc: arcOem(24), rows: spwRows() });
