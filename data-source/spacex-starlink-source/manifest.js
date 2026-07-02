/**
 * SpaceX Starlink data-source module manifest (WS5).
 *
 * The first executable data-source module: on a TIMERS-driven `pull` it fetches
 * SpaceX/Starlink ephemeris over HTTP, parses + validates it (via its declared
 * dependencies), stores the records, signs a PNM (Provenance/Notification
 * Message), and publishes it — all through host capabilities.
 *
 * The canonical manifest is `plugin-manifest.json` (the shape the whole module
 * toolchain consumes). The build embeds it into the WASM via the SDK's
 * `encodePlgManifest(legacyManifestToPlg(...))` — the same $PLG encoder every
 * other compiled module uses, and the format the Go node's PLG parser reads.
 * The DEPENDENCIES on the Starlink parser / validator are declared on the PLG
 * storefront/publish record (the embedded manifest has no dependencies field).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const STARLINK_SOURCE_PLUGIN_ID = "com.orbpro.spacex-starlink-source";
export const STARLINK_SOURCE_PLUGIN_NAME = "SpaceX Starlink Data Source";
export const STARLINK_SOURCE_PLUGIN_VERSION = "1.0.0";
export const STARLINK_SOURCE_PLUGIN_DESCRIPTION =
  "Executable data-source: pulls SpaceX/Starlink ephemeris over HTTP on a timer, " +
  "parses + validates, stores records, and signs + publishes a PNM pointer.";

// Default pull cadence: hourly.
export const STARLINK_SOURCE_PULL_INTERVAL_MS = 3_600_000;

// Dependency identities (declared on the PLG publish record, not the embedded
// manifest — see WS4.1 / WS5.4).
export const STARLINK_PARSER_PLUGIN_ID = "com.orbpro.starlink-parser";
export const STARLINK_VALIDATOR_PLUGIN_ID = "com.orbpro.starlink-validator";

export const STARLINK_SOURCE_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

/**
 * Load the canonical Starlink data-source manifest (plain JSON object). Feed to
 * the SDK's `encodePlgManifest(legacyManifestToPlg(...))` to produce the
 * embedded $PLG bytes.
 */
export function createStarlinkSourcePluginManifest() {
  return JSON.parse(fs.readFileSync(STARLINK_SOURCE_MANIFEST_PATH, "utf8"));
}

export default createStarlinkSourcePluginManifest;
