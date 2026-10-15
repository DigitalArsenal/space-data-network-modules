/**
 * SpaceX Starlink data-source module manifest (typed contracts 1.0).
 *
 * The canonical manifest is `plugin-manifest.json`: plan (TimerTick -> the MANIFEST.txt HttpRequest), select_objects
 * (the manifest HttpResponse -> one HttpRequest per MEME file, the object's $OEM header in CONTEXT) and emit (the MEME
 * HttpResponses -> SDS $OEM). The SDK compiler embeds it in the WASM. The pull cadence is the flow's timer trigger.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const STARLINK_SOURCE_PLUGIN_ID = "com.orbpro.spacex-starlink-source";
export const STARLINK_SOURCE_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

/** Load the canonical Starlink data-source manifest (plain JSON object). */
export function createStarlinkSourcePluginManifest() {
  return JSON.parse(fs.readFileSync(STARLINK_SOURCE_MANIFEST_PATH, "utf8"));
}

export default createStarlinkSourcePluginManifest;
