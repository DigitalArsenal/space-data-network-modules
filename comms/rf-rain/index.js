// rf-rain JS host wrapper. Five model entry points exposed via direct
// Emscripten exports — the FlatBuffer envelope would dominate the cost
// for these scalar (frequency, height, height, range[, metro]) -> double
// signatures.

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfRainPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfRainPluginManifest();
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
  const { default: createModule } = await import("./dist/rf-rain.mjs");
  return createModule;
}

async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-rain-binary.js");
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
      bytesSymbol: "rf_rain_plugin_manifest_bytes",
      sizeSymbol: "rf_rain_plugin_manifest_size",
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

export function getRfRainManifest() {
  return STATIC_MANIFEST;
}

export async function createRfRainPlugin(options = {}) {
  const createModule = await loadModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-rain-wasm";
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
     * ITU-R P.838-3 §1 specific rain attenuation γ_R = k·R^α in dB/km.
     * elevationDeg / polarizationTiltDeg default to 0 (terrestrial,
     * horizontal). Returns 0 below 1 GHz where the P.838-3 fit is
     * undefined.
     */
    specificAttenuationDbPerKm(
      frequencyGhz,
      rainRateMmHr,
      elevationDeg = 0,
      polarizationTiltDeg = 0,
    ) {
      return module._rf_rain_specific_attenuation_db_per_km(
        Number(frequencyGhz),
        Number(rainRateMmHr),
        Number(elevationDeg),
        Number(polarizationTiltDeg),
      );
    },
    /**
     * ITU-R P.530-18 §2.4 Eq. (33) terrestrial line-of-sight rain
     * attenuation A = γ_R·d/(1+0.045·d) in dB.
     */
    attenuationDb(
      frequencyGhz,
      rainRateMmHr,
      pathKm,
      elevationDeg = 0,
      polarizationTiltDeg = 0,
    ) {
      return module._rf_rain_attenuation_db(
        Number(frequencyGhz),
        Number(rainRateMmHr),
        Number(pathKm),
        Number(elevationDeg),
        Number(polarizationTiltDeg),
      );
    },
    /**
     * Crane 1980 piecewise-exponential rain attenuation in dB. Path is
     * clamped at 22.5 km (preserves the JS-port behavior).
     */
    attenuationCraneDb(
      frequencyGhz,
      rainRateMmHr,
      pathKm,
      elevationDeg = 0,
      polarizationTiltDeg = 0,
    ) {
      return module._rf_rain_attenuation_crane_db(
        Number(frequencyGhz),
        Number(rainRateMmHr),
        Number(pathKm),
        Number(elevationDeg),
        Number(polarizationTiltDeg),
      );
    },
    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadRfRainPlugin = createRfRainPlugin;
export const metadata = STATIC_METADATA;

export default createRfRainPlugin;
