/**
 * Security-bond attestation module manifest (WHA in, WHA out; typed contracts 1.0;
 * free chain services read through the host's http capability).
 *
 * The canonical manifest is `plugin-manifest.json`; the SDK compiler embeds it
 * into the WASM (build.mjs).
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
