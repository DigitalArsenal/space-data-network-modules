/**
 * CPF (ILRS Consolidated Prediction Format) data-source module manifest (A2.2c-2).
 *
 * On a TIMERS-driven `pull` it fetches an ILRS CPF v2 prediction file (ITRF/ECEF
 * position table) from an unauthenticated archive, re-emits it as a schema-exact
 * SDS OEM record with the CPF frame preserved AS DECLARED, stores it, signs a
 * PNM (Publish Notification Message), and publishes it — all through host
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

export const CPF_SOURCE_PLUGIN_ID = "com.orbpro.cpf-source";
export const CPF_SOURCE_PLUGIN_NAME = "CPF (ILRS predictions) Data Source";
export const CPF_SOURCE_PLUGIN_VERSION = "1.0.0";
export const CPF_SOURCE_PLUGIN_DESCRIPTION =
  "Executable data-source: pulls ILRS CPF v2 prediction files over HTTP on a timer, " +
  "re-emits them as schema-exact SDS OEM records with the CPF frame preserved as declared, " +
  "and signs + publishes a PNM pointer.";

// Default pull cadence: every 12h (2x/day). ILRS/analysis centers regenerate CPF
// predictions DAILY (some active targets sub-daily), so a 12h poll catches the
// daily regeneration promptly while a single small CPF file per target keeps
// archive load trivial.
export const CPF_SOURCE_PULL_INTERVAL_MS = 43_200_000;

export const CPF_SOURCE_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

/**
 * Load the canonical CPF data-source manifest (plain JSON object). Feed to the
 * SDK's `encodePlgManifest(legacyManifestToPlg(...))` to produce embedded $PLG.
 */
export function createCpfSourcePluginManifest() {
  return JSON.parse(fs.readFileSync(CPF_SOURCE_MANIFEST_PATH, "utf8"));
}

export default createCpfSourcePluginManifest;
