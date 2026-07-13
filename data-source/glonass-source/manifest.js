/**
 * GLONASS precise ephemeris (IAC SP3) data-source module manifest (A2.2c-2).
 *
 * On a TIMERS-driven `pull` it fetches an IAC GLONASS precise ephemeris (SP3-d),
 * emits a schema-exact SDS OEM record per GLONASS satellite, stores it, signs a
 * PNM, and publishes it — all on the shared provider-adapter template.
 *
 * NOTE (honest, mission correction): IAC's precise SP3 declares REFERENCE_FRAME
 * = IGS20 (an ITRF2020 realization) and TIME_SYSTEM = GPS, NOT PZ-90.11 /
 * GLONASS time (that is the broadcast-nav frame). The adapter preserves what the
 * file declares and does not transform frames (the OD module owns transforms).
 * Records are position-only (SP3 has no velocity records). See README.md + the
 * src header.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const GLONASS_SOURCE_PLUGIN_ID = "com.orbpro.glonass-source";
export const GLONASS_SOURCE_PLUGIN_NAME = "GLONASS Precise Ephemeris (IAC SP3) Data Source";
export const GLONASS_SOURCE_PLUGIN_VERSION = "1.0.0";
export const GLONASS_SOURCE_PLUGIN_DESCRIPTION =
  "Executable data-source: pulls an IAC GLONASS precise ephemeris (SP3-d) over HTTP on a timer, " +
  "emits a schema-exact SDS OEM record per GLONASS satellite (frame/time preserved AS DECLARED " +
  "in the SP3 header, position-only), and signs + publishes a PNM pointer.";

// Default pull cadence: every 12h (2x/day). IAC regenerates its GLONASS precise
// products roughly daily (rapid) with a rolling ultra-rapid; 12h captures the
// refresh promptly without over-polling. Per-pull record churn is bounded by
// objectCap (one record per GLONASS satellite).
export const GLONASS_SOURCE_PULL_INTERVAL_MS = 43_200_000;

export const GLONASS_SOURCE_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

/**
 * Load the canonical GLONASS data-source manifest (plain JSON object). Feed to
 * the SDK's `encodePlgManifest(legacyManifestToPlg(...))` to produce embedded $PLG.
 */
export function createGlonassSourcePluginManifest() {
  return JSON.parse(fs.readFileSync(GLONASS_SOURCE_MANIFEST_PATH, "utf8"));
}

export default createGlonassSourcePluginManifest;
