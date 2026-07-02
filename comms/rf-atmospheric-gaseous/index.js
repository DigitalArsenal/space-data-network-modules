// rf-atmospheric-gaseous JS host wrapper. Direct-export fast path for
// scalar atmospheric-attenuation primitives.

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfAtmosphericGaseousPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfAtmosphericGaseousPluginManifest();
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
  const { default: createModule } = await import("./dist/rf-atmospheric-gaseous.mjs");
  return createModule;
}

async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-atmospheric-gaseous-binary.js");
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
      bytesSymbol: "rf_atmospheric_gaseous_plugin_manifest_bytes",
      sizeSymbol: "rf_atmospheric_gaseous_plugin_manifest_size",
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

export function getRfAtmosphericGaseousManifest() {
  return STATIC_MANIFEST;
}

export async function createRfAtmosphericGaseousPlugin(options = {}) {
  const createModule = await loadModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-atmospheric-gaseous-wasm";
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
    /** Specific oxygen-line absorption in dB/km (single-Lorentzian fit, < 57 GHz). */
    oxygenSpecificAttenuationDbPerKm(frequencyGhz, temperatureC) {
      return module._rf_oxygen_specific_attenuation_db_per_km(
        Number(frequencyGhz),
        Number(temperatureC),
      );
    },
    /** Specific water-vapor-line absorption in dB/km (single-Lorentzian @ 22 GHz). */
    waterVaporSpecificAttenuationDbPerKm(frequencyGhz, temperatureC, humidityPercent) {
      return module._rf_water_vapor_specific_attenuation_db_per_km(
        Number(frequencyGhz),
        Number(temperatureC),
        Number(humidityPercent),
      );
    },
    /** Total slant-path atmospheric absorption (oxygen + water vapor) in dB. */
    atmosphericAbsorptionDb(frequencyGhz, pathKm, temperatureC, humidityPercent) {
      return module._rf_atmospheric_absorption_db(
        Number(frequencyGhz),
        Number(pathKm),
        Number(temperatureC),
        Number(humidityPercent),
      );
    },
    /** WMO No. 8 Annex 4.A.1 saturation vapor pressure over water, in hPa. */
    saturationVaporPressureHpa(temperatureC) {
      return module._rf_saturation_vapor_pressure_hpa(Number(temperatureC));
    },
    /**
     * ITU-R P.676-13 Annex 1 §1 dry-air (oxygen + dry continuum) specific
     * attenuation, dB/km. Strict P.676 semantics: dryPressureHpa is the
     * DRY-air partial pressure (total barometric = dry + e).
     */
    gaseousGamma0P676DbPerKm(
      frequencyGhz,
      dryPressureHpa,
      waterVapourDensityGM3,
      temperatureK,
    ) {
      return module._rf_gaseous_gamma0_p676_db_per_km(
        Number(frequencyGhz),
        Number(dryPressureHpa),
        Number(waterVapourDensityGM3),
        Number(temperatureK),
      );
    },
    /** ITU-R P.676-13 Annex 1 §1 water-vapour specific attenuation, dB/km. */
    gaseousGammawP676DbPerKm(
      frequencyGhz,
      dryPressureHpa,
      waterVapourDensityGM3,
      temperatureK,
    ) {
      return module._rf_gaseous_gammaw_p676_db_per_km(
        Number(frequencyGhz),
        Number(dryPressureHpa),
        Number(waterVapourDensityGM3),
        Number(temperatureK),
      );
    },
    /** ITU-R P.676-13 Annex 1 §1 total specific gaseous attenuation (gamma_o + gamma_w), dB/km. */
    gaseousSpecificAttenuationP676DbPerKm(
      frequencyGhz,
      dryPressureHpa,
      waterVapourDensityGM3,
      temperatureK,
    ) {
      return module._rf_gaseous_specific_attenuation_p676_db_per_km(
        Number(frequencyGhz),
        Number(dryPressureHpa),
        Number(waterVapourDensityGM3),
        Number(temperatureK),
      );
    },
    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadRfAtmosphericGaseousPlugin = createRfAtmosphericGaseousPlugin;
export const metadata = STATIC_METADATA;

export default createRfAtmosphericGaseousPlugin;
