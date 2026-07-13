/**
 * Intelsat (public ephemeris) data-source module manifest (A2.2c-2).
 *
 * On a TIMERS-driven `pull` it fetches Intelsat's public operator ephemeris
 * (weekly ECF / center-of-box files at my.intelsat.com/ephemeris/public),
 * re-emits each as a schema-exact SDS OEM record, stores it, signs a PNM
 * (Publish Notification Message), and publishes it — all through host
 * capabilities, on the shared provider-adapter template.
 *
 * The canonical manifest is `plugin-manifest.json`. The build embeds it into the
 * WASM via the SDK's `encodePlgManifest(legacyManifestToPlg(...))` — the same
 * $PLG encoder every other compiled module uses.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const INTELSAT_SOURCE_PLUGIN_ID = "com.orbpro.intelsat-source";
export const INTELSAT_SOURCE_PLUGIN_NAME = "Intelsat (public ephemeris) Data Source";
export const INTELSAT_SOURCE_PLUGIN_VERSION = "1.0.0";
export const INTELSAT_SOURCE_PLUGIN_DESCRIPTION =
  "Executable data-source: pulls Intelsat's public operator ephemeris over HTTP on a timer, " +
  "re-emits each satellite as a schema-exact SDS OEM record, and signs + publishes a PNM pointer.";

// Default pull cadence: every 24h (daily). Intelsat regenerates the public
// ephemeris files WEEKLY, so a daily poll catches every refresh well within a
// day without over-polling the small per-satellite text files.
export const INTELSAT_SOURCE_PULL_INTERVAL_MS = 86_400_000;

export const INTELSAT_SOURCE_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

/**
 * Load the canonical Intelsat data-source manifest (plain JSON object). Feed to
 * the SDK's `encodePlgManifest(legacyManifestToPlg(...))` to produce embedded $PLG.
 */
export function createIntelsatSourcePluginManifest() {
  return JSON.parse(fs.readFileSync(INTELSAT_SOURCE_MANIFEST_PATH, "utf8"));
}

export default createIntelsatSourcePluginManifest;
