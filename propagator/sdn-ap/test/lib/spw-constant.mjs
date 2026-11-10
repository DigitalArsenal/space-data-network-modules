// The synthetic constant space weather the model-truth runs fly propagator/ffm on (FFM_SPW_FIXTURE): one $SPW row per UTC day
// from 2026-09-14 to 2026-12-13 (2026-10-29 +/- 45 days), F10.7 150 (observed, adjusted, 81-day means) and Ap 15 (Kp 3.0)
// every day, in the SPW field set and key order (unpacked, without PROVENANCE); Bartels rotation and day from the 27-day
// count that began 1832-02-08. Not GFZ or NOAA data. Built here, so a test needs no file outside the repository; its JSON text
// (JSON.stringify(rows) + "\n") has the SHA-256 d7018d1d33afa58220f3f95219f3ef3bd3802129dee5aee378fd46b6c7971f42 of the file
// the registrations were made with. FFM_SPW_FIXTURE names another file of such rows.
import fs from "node:fs";

const DAY = 86400000;

/** The rows' JSON text. */
export function spwConstantText(centerText = "2026-10-29", days = 45) {
  const center = Date.parse(`${centerText}T00:00:00Z`), bartelsStart = Date.parse("1832-02-08T00:00:00Z");
  const rows = [];
  for (let offset = -days; offset <= days; offset++) {
    const at = center + offset * DAY;
    const n = Math.round((at - bartelsStart) / DAY);
    rows.push({
      DATE: new Date(at).toISOString().slice(0, 10),
      BSRN: Math.floor(n / 27) + 1, ND: (n % 27) + 1,
      KP1: 30, KP2: 30, KP3: 30, KP4: 30, KP5: 30, KP6: 30, KP7: 30, KP8: 30, KP_SUM: 240,
      AP1: 15, AP2: 15, AP3: 15, AP4: 15, AP5: 15, AP6: 15, AP7: 15, AP8: 15, AP_AVG: 15,
      CP: 0.7, C9: 3, ISN: 100,
      F107_ADJ: 150, F107_DATA_TYPE: 0, F107_ADJ_CENTER81: 150, F107_ADJ_LAST81: 150,
      F107_OBS: 150, F107_OBS_CENTER81: 150, F107_OBS_LAST81: 150,
    });
  }
  return JSON.stringify(rows) + "\n";
}

/** The fixture's text: FFM_SPW_FIXTURE's file when set, else the rows built here. */
export const spwFixtureText = () => (process.env.FFM_SPW_FIXTURE ? fs.readFileSync(process.env.FFM_SPW_FIXTURE, "utf8") : spwConstantText());

/** The fixture's rows. */
export const spwFixtureRows = () => JSON.parse(spwFixtureText());
