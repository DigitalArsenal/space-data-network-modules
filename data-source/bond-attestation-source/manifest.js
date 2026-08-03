/**
 * Security-bond attestation module manifest (owner directive 2026-08-03:
 * free chain services, in a WASM module over the wired-up http capability).
 *
 * The canonical manifest is `plugin-manifest.json`. The build embeds it into
 * the WASM via the SDK's `encodePlgManifest(legacyManifestToPlg(...))` — the
 * same $PLG encoder every other compiled module uses.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BOND_ATTESTATION_PLUGIN_ID = "org.spacedatanetwork.bond-attestation";
export const BOND_ATTESTATION_MANIFEST_PATH = path.join(__dirname, "plugin-manifest.json");

export function createBondAttestationPluginManifest() {
  return JSON.parse(fs.readFileSync(BOND_ATTESTATION_MANIFEST_PATH, "utf8"));
}

export default createBondAttestationPluginManifest;
