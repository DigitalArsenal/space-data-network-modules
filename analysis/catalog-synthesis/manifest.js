/**
 * Supplemental Catalog Synthesis module manifest (App 2, A2.7).
 *
 * The canonical manifest is `plugin-manifest.json`. The build embeds it into the
 * WASM via the SDK's `encodePlgManifest(legacyManifestToPlg(...))` — the same
 * $PLG encoder every compiled module uses and the format the Go node's PLG parser
 * reads to grant host capabilities (storage_query / storage_ingest / wallet_sign /
 * pubsub) and schedule the `catalog-synthesis-pull` timer.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CATALOG_SYNTHESIS_PLUGIN_ID = "com.orbpro.catalog-synthesis";
export const CATALOG_SYNTHESIS_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

// Default synthesis cadence: every 6h. The Space-Track current-gp lane polls on a
// 6h default and CelesTrak SupGP regenerates every 2h; the newest inputs to the
// catalog therefore refresh on a 2–6h cadence, so re-synthesizing faster yields
// nothing new.
export const CATALOG_SYNTHESIS_PULL_INTERVAL_MS = 21_600_000;

export function createCatalogSynthesisPluginManifest() {
  return JSON.parse(fs.readFileSync(CATALOG_SYNTHESIS_MANIFEST_PATH, "utf8"));
}

export default createCatalogSynthesisPluginManifest;
