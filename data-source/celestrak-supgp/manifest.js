/**
 * CelesTrak SupGP (multi-provider supplemental OMM) data-source module manifest.
 *
 * On a TIMERS-driven `pull` it iterates a data-driven SOURCE-token registry and,
 * per token, fetches CelesTrak's published Supplemental GP (SupGP) OMM set,
 * re-emits each object as a schema-exact SDS OMM record HONESTLY labeled
 * non-independent (these are CelesTrak-fitted OMMs, not our OD), stores it with a
 * per-provider SourceName, signs a PNM (Publish Notification Message), and
 * publishes it — all through host capabilities, on the shared provider-adapter
 * template (common/provider_source.hpp).
 *
 * The canonical manifest is `plugin-manifest.json`. The build embeds it into the
 * WASM via the SDK's `encodePlgManifest(legacyManifestToPlg(...))` — the same
 * $PLG encoder every other compiled module uses.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CELESTRAK_SUPGP_PLUGIN_ID = "com.orbpro.celestrak-supgp";
export const CELESTRAK_SUPGP_PLUGIN_NAME =
  "CelesTrak SupGP (multi-provider supplemental OMM) Data Source";
export const CELESTRAK_SUPGP_PLUGIN_VERSION = "1.0.0";

// Default pull cadence: every 2h. CelesTrak states SupGP regenerates every 2h
// ("no need to check more often"), so a uniform 2h cycle captures every refresh
// while staying a good citizen. Each cycle issues one query per registry token.
export const CELESTRAK_SUPGP_PULL_INTERVAL_MS = 7_200_000;

export const CELESTRAK_SUPGP_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

/**
 * Load the canonical CelesTrak SupGP data-source manifest (plain JSON object).
 * Feed to the SDK's `encodePlgManifest(legacyManifestToPlg(...))` to produce the
 * embedded $PLG buffer.
 */
export function createCelestrakSupgpPluginManifest() {
  return JSON.parse(fs.readFileSync(CELESTRAK_SUPGP_MANIFEST_PATH, "utf8"));
}

export default createCelestrakSupgpPluginManifest;
