// rf-cloud-fog JS host wrapper. Direct exports for the K_l coefficient
// and the total slant-path cloud attenuation.

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfCloudFogPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfCloudFogPluginManifest();
const STATIC_METADATA = createLegacyMetadata(STATIC_MANIFEST, {
  encrypted: false,
  requiresProtection: false,
});

function base64ToBytes(base64) {
  if (typeof globalThis.Buffer !== "undefined") {
    return new Uint8Array(globalThis.Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function loadModuleFactory() {
  const { default: createModule } = await import("./dist/rf-cloud-fog.mjs");
  return createModule;
}

async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-cloud-fog-binary.js");
  return base64ToBytes(wasmBase64);
}

async function resolveWasmBinary(options = {}) {
  let wasmBytes;
  if (options.wasmBinary) {
    wasmBytes =
      options.wasmBinary instanceof Uint8Array
        ? options.wasmBinary
        : new Uint8Array(options.wasmBinary);
  } else if (options.wasmUrl) {
    const response = await fetch(options.wasmUrl);
    wasmBytes = new Uint8Array(await response.arrayBuffer());
  } else {
    wasmBytes = await loadBundledWasmBytes();
  }
  return stripPublicationRecordCollection(wasmBytes);
}

function attachEmbeddedManifestMetadata(module) {
  if (!module) return STATIC_MANIFEST;
  if (!module.__orbproEmbeddedManifest) {
    const embeddedManifest = readEmbeddedPluginManifest(module, {
      bytesSymbol: "rf_cloud_fog_plugin_manifest_bytes",
      sizeSymbol: "rf_cloud_fog_plugin_manifest_size",
    });
    module.__orbproEmbeddedManifest = STATIC_MANIFEST;
    module.__orbproEmbeddedManifestRaw = embeddedManifest ?? null;
    module.__orbproManifestSource = embeddedManifest
      ? EMBEDDED_MANIFEST_SOURCE
      : "static-fallback";
  }
  if (!module.__orbproMetadata) {
    module.__orbproMetadata = createLegacyMetadata(
      module.__orbproEmbeddedManifest,
      { encrypted: false, requiresProtection: false },
    );
  }
  return module.__orbproEmbeddedManifest;
}

function getResolvedManifestSource(module) {
  attachEmbeddedManifestMetadata(module);
  return module?.__orbproManifestSource ?? "static-fallback";
}

export function getRfCloudFogManifest() {
  return STATIC_MANIFEST;
}

export async function createRfCloudFogPlugin(options = {}) {
  const createModule = await loadModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-cloud-fog-wasm";
  if (typeof module._plugin_init === "function") {
    module._plugin_init(0, 0);
  }

  const manifest = attachEmbeddedManifestMetadata(module);
  const metadata = module.__orbproMetadata ?? STATIC_METADATA;

  return {
    type: "Comms",
    name: metadata.name,
    version: metadata.version,
    metadata,
    manifest,
    manifestSource: getResolvedManifestSource(module),
    module,
    supportsStreamInvoke: false,
    /**
     * ITU-R P.840-9 Annex 1 mass-specific cloud-liquid-water attenuation
     * coefficient K_l in dB/(km · g/m³).
     */
    specificAttenuationCoeff(frequencyGhz, temperatureC) {
      return module._rf_cloud_specific_attenuation_coeff(
        Number(frequencyGhz),
        Number(temperatureC),
      );
    },
    /**
     * Total slant-path cloud / fog attenuation in dB:
     *   A = K_l(f, T) · ρ · path_km
     */
    attenuationDb(frequencyGhz, temperatureC, liquidWaterDensityGm3, pathKm) {
      return module._rf_cloud_attenuation_db(
        Number(frequencyGhz),
        Number(temperatureC),
        Number(liquidWaterDensityGm3),
        Number(pathKm),
      );
    },
    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadRfCloudFogPlugin = createRfCloudFogPlugin;
export const metadata = STATIC_METADATA;

export default createRfCloudFogPlugin;
