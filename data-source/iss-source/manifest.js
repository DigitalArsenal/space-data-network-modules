/**
 * ISS (NASA public OEM) data-source module manifest (A2.2c).
 *
 * On a TIMERS-driven `pull` it fetches the single public NASA ISS ephemeris
 * (a CCSDS OEM KVN file), re-emits it as a schema-exact SDS OEM record, stores
 * it, signs a PNM (Publish Notification Message), and publishes it — all through
 * host capabilities, on the shared provider-adapter template.
 *
 * The canonical manifest is `plugin-manifest.json`. The build embeds it into the
 * WASM via the SDK's `encodePlgManifest(legacyManifestToPlg(...))` — the same
 * $PLG encoder every other compiled module uses.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ISS_SOURCE_PLUGIN_ID = "com.orbpro.iss-source";
export const ISS_SOURCE_PLUGIN_NAME = "ISS (NASA public OEM) Data Source";
export const ISS_SOURCE_PLUGIN_VERSION = "1.0.0";
export const ISS_SOURCE_PLUGIN_DESCRIPTION =
  "Executable data-source: pulls the NASA public ISS CCSDS OEM ephemeris over HTTP " +
  "on a timer, re-emits it as a schema-exact SDS OEM record, and signs + publishes a PNM pointer.";

// Default pull cadence: every 12h (2x/day). NASA regenerates the ISS OEM a few
// times a week, but each file is a continuous 15-day EME2000 ephemeris, so 12h
// captures every refresh promptly without over-polling a single ~700 KB file.
export const ISS_SOURCE_PULL_INTERVAL_MS = 43_200_000;

export const ISS_SOURCE_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

/**
 * Load the canonical ISS data-source manifest (plain JSON object). Feed to the
 * SDK's `encodePlgManifest(legacyManifestToPlg(...))` to produce embedded $PLG.
 */
export function createIssSourcePluginManifest() {
  return JSON.parse(fs.readFileSync(ISS_SOURCE_MANIFEST_PATH, "utf8"));
}

export default createIssSourcePluginManifest;
