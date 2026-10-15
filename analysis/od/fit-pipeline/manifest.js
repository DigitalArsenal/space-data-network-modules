/**
 * OD Fit Pipeline module manifest (typed contracts 1.0).
 *
 * The canonical manifest is `plugin-manifest.json`; the SDK compiler embeds it in the WASM (build.mjs). The
 * `od-fit-pull` timer (every 2 h) invokes `fit_pipeline` with a TimerTick; the module reads the stored $OEM records
 * through the typed storage.query hostcall (capability storage_query).
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
