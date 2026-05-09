// rf-empirical JS host wrapper. Five model entry points exposed via direct
// Emscripten exports — the FlatBuffer envelope would dominate the cost
// for these scalar (frequency, height, height, range[, metro]) -> double
// signatures.

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfEmpiricalPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfEmpiricalPluginManifest();
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
  const { default: createModule } = await import("./dist/rf-empirical.mjs");
  return createModule;
}

async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-empirical-binary.js");
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
      bytesSymbol: "rf_empirical_plugin_manifest_bytes",
      sizeSymbol: "rf_empirical_plugin_manifest_size",
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

export function getRfEmpiricalManifest() {
  return STATIC_MANIFEST;
}

export async function createRfEmpiricalPlugin(options = {}) {
  const createModule = await loadModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-empirical-wasm";
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
     * Rappaport §4.6.2 two-ray ground reflection model.
     * Inputs in SI units. Returns dB.
     */
    twoRayGroundLossDb(rangeMeters, txHeightMeters, rxHeightMeters, frequencyHz) {
      return module._rf_two_ray_ground_loss_db(
        Number(rangeMeters),
        Number(txHeightMeters),
        Number(rxHeightMeters),
        Number(frequencyHz),
      );
    },
    /** Hata 1980 medium/small-city urban-area path loss in dB. */
    hataUrbanLossDb(frequencyMhz, txHeightMeters, rxHeightMeters, rangeKm) {
      return module._rf_hata_urban_loss_db(
        Number(frequencyMhz),
        Number(txHeightMeters),
        Number(rxHeightMeters),
        Number(rangeKm),
      );
    },
    /** Hata 1980 suburban-area path loss in dB. */
    hataSuburbanLossDb(frequencyMhz, txHeightMeters, rxHeightMeters, rangeKm) {
      return module._rf_hata_suburban_loss_db(
        Number(frequencyMhz),
        Number(txHeightMeters),
        Number(rxHeightMeters),
        Number(rangeKm),
      );
    },
    /** Hata 1980 rural / open-area path loss in dB. */
    hataRuralLossDb(frequencyMhz, txHeightMeters, rxHeightMeters, rangeKm) {
      return module._rf_hata_rural_loss_db(
        Number(frequencyMhz),
        Number(txHeightMeters),
        Number(rxHeightMeters),
        Number(rangeKm),
      );
    },
    /**
     * COST 231 Hata extension to 1500–2000 MHz.
     * metropolitan: boolean (true → +3 dB metro correction).
     */
    cost231LossDb(
      frequencyMhz,
      txHeightMeters,
      rxHeightMeters,
      rangeKm,
      metropolitan,
    ) {
      return module._rf_cost231_loss_db(
        Number(frequencyMhz),
        Number(txHeightMeters),
        Number(rxHeightMeters),
        Number(rangeKm),
        metropolitan ? 1 : 0,
      );
    },
    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadRfEmpiricalPlugin = createRfEmpiricalPlugin;
export const metadata = STATIC_METADATA;

export default createRfEmpiricalPlugin;
