/**
 * OneWeb (Eutelsat) LTEF data-source module manifest (A2.2c).
 *
 * On a TIMERS-driven `pull` it fetches OneWeb's public LTEF (a single whole-fleet
 * CSV), emits schema-exact SDS OEM records per satellite, stores them, signs a
 * PNM, and publishes it — all on the shared provider-adapter template.
 *
 * NOTE: the LTEF is an undocumented compact encoding; the physical state-vector
 * decode is unresolved (owner-assist residual). The adapter emits honest OEM
 * metadata shells with the raw encoded row preserved in signed provenance — see
 * README.md and the src header for the full finding.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ONEWEB_SOURCE_PLUGIN_ID = "com.orbpro.oneweb-source";
export const ONEWEB_SOURCE_PLUGIN_NAME = "OneWeb (Eutelsat) LTEF Data Source";
export const ONEWEB_SOURCE_PLUGIN_VERSION = "1.0.0";
export const ONEWEB_SOURCE_PLUGIN_DESCRIPTION =
  "Executable data-source: pulls OneWeb's public LTEF (long-term ephemeris file) over HTTP " +
  "on a timer, emits schema-exact SDS OEM records per satellite, and signs + publishes a PNM pointer.";

// Default pull cadence: every 6h (4x/day). The OneWeb LTEF regenerates roughly
// daily (its root timestamp.txt tracks that); 6h guarantees same-day freshness
// within 6h of any regeneration while remaining trivially polite — the whole
// fleet is one small (~45 KB) CSV, so a pull is a single GET (~180 KB/day). A
// 12h cadence would also satisfy the "same-day" target. Per-pull record churn is
// separately bounded by the adapter's objectCap (default 40).
export const ONEWEB_SOURCE_PULL_INTERVAL_MS = 21_600_000;

export const ONEWEB_SOURCE_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

/**
 * Load the canonical OneWeb data-source manifest (plain JSON object). Feed to the
 * SDK's `encodePlgManifest(legacyManifestToPlg(...))` to produce embedded $PLG.
 */
export function createOnewebSourcePluginManifest() {
  return JSON.parse(fs.readFileSync(ONEWEB_SOURCE_MANIFEST_PATH, "utf8"));
}

export default createOnewebSourcePluginManifest;
