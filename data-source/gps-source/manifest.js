/**
 * GPS almanac (USCG NAVCEN SEM / YUMA) data-source module manifest (A2.2c-2).
 *
 * On a TIMERS-driven `pull` it fetches a public GPS almanac from USCG NAVCEN
 * (YUMA or SEM, auto-detected), emits a schema-exact SDS OMM record per PRN,
 * stores it, signs a PNM, and publishes it — all on the shared provider-adapter
 * template.
 *
 * NOTE: a GPS almanac is a set of reduced-precision MEAN quasi-Keplerian
 * ELEMENTS (not a state-vector ephemeris). The adapter maps them to OMM WITHOUT
 * fabricating state vectors, and honestly labels them as GPS-LNAV-ALMANAC (not
 * SGP4) with an ECEF-referenced ascending-node caveat — see README.md and the
 * src header for the full canonical-mapping decision and the A2.4 implication.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const GPS_SOURCE_PLUGIN_ID = "com.orbpro.gps-source";
export const GPS_SOURCE_PLUGIN_NAME = "GPS Almanac (NAVCEN SEM/YUMA) Data Source";
export const GPS_SOURCE_PLUGIN_VERSION = "1.0.0";
export const GPS_SOURCE_PLUGIN_DESCRIPTION =
  "Executable data-source: pulls a public GPS almanac (USCG NAVCEN SEM/YUMA) over HTTP " +
  "on a timer, maps each PRN's mean Keplerian elements to a schema-exact SDS OMM record " +
  "(honestly labeled GPS-LNAV-ALMANAC, not SGP4), and signs + publishes a PNM pointer.";

// Default pull cadence: every 12h (2x/day). NAVCEN regenerates the current
// almanac ~daily at most (the constellation almanac changes slowly); 12h
// captures every refresh promptly without over-polling a small (~7-19 KB) file.
export const GPS_SOURCE_PULL_INTERVAL_MS = 43_200_000;

export const GPS_SOURCE_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

/**
 * Load the canonical GPS data-source manifest (plain JSON object). Feed to the
 * SDK's `encodePlgManifest(legacyManifestToPlg(...))` to produce embedded $PLG.
 */
export function createGpsSourcePluginManifest() {
  return JSON.parse(fs.readFileSync(GPS_SOURCE_MANIFEST_PATH, "utf8"));
}

export default createGpsSourcePluginManifest;
