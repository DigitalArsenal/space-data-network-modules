/**
 * OD Fit Pipeline module manifest (App 2, A2.3).
 *
 * The canonical manifest is `plugin-manifest.json`. The build embeds it into the
 * WASM via the SDK's `encodePlgManifest(legacyManifestToPlg(...))` — the same
 * $PLG encoder every compiled module uses and the format the Go node's PLG parser
 * reads to grant host capabilities (storage_query / storage_write / wallet_sign /
 * crypto_sign / pubsub) and schedule the `od-fit-pull` timer.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const OD_FIT_PIPELINE_PLUGIN_ID = "com.orbpro.od-fit-pipeline";
export const OD_FIT_PIPELINE_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

// Default fit cadence: every 2h. CelesTrak regenerates SupGP every 2h ("no need
// to check more often"), and the upstream operator ephemerides refresh on a
// similar or slower cadence, so re-fitting more often than 2h yields nothing.
export const OD_FIT_PIPELINE_PULL_INTERVAL_MS = 7_200_000;

export function createOdFitPipelinePluginManifest() {
  return JSON.parse(fs.readFileSync(OD_FIT_PIPELINE_MANIFEST_PATH, "utf8"));
}

export default createOdFitPipelinePluginManifest;
