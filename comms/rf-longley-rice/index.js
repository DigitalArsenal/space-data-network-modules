// rf-longley-rice JS host wrapper. STUB — see README.md and the C++
// kernel header for the rationale. The signature is frozen so the
// future native NTIA-ITS port can land without breaking JS callers.

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfLongleyRicePluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfLongleyRicePluginManifest();
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
  const { default: createModule } = await import("./dist/rf-longley-rice.mjs");
  return createModule;
}
async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-longley-rice-binary.js");
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
      bytesSymbol: "rf_longley_rice_plugin_manifest_bytes",
      sizeSymbol: "rf_longley_rice_plugin_manifest_size",
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

export function getRfLongleyRiceManifest() {
  return STATIC_MANIFEST;
}

export async function createRfLongleyRicePlugin(options = {}) {
  const createModule = await loadModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-longley-rice-wasm";
  if (typeof module._plugin_init === "function") {
    module._plugin_init(0, 0);
  }

  const manifest = attachEmbeddedManifestMetadata(module);
  const metadata = module.__orbproMetadata ?? STATIC_METADATA;

  const isStub =
    typeof module._rf_longley_rice_is_stub === "function" &&
    module._rf_longley_rice_is_stub() === 1;

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
     * Returns true while the kernel is a stub. Hosts should branch on
     * this and fall back to the existing JS-side
     * `RfCommsCore.computeLongleyRicePathLoss` external WASM until the
     * native NTIA-ITS port replaces the stub.
     */
    isStub,
    /**
     * Path loss in dB per NTIA-ITS Longley-Rice ITM (signature frozen
     * for the future native port). Returns 0 from the current stub.
     */
    pathLossDb({
      distanceKm,
      frequencyMhz,
      txHeightM,
      rxHeightM,
      terrainIrregularityM = 90.0,
      climateCode = 5,
      polarizationCode = 0,
      surfaceRefractivityNUnits = 301.0,
      groundDielectricConstant = 15.0,
      groundConductivitySPerM = 0.005,
      timePercent = 50.0,
      locationPercent = 50.0,
      situationPercent = 50.0,
    } = {}) {
      return module._rf_longley_rice_path_loss_db(
        Number(distanceKm),
        Number(frequencyMhz),
        Number(txHeightM),
        Number(rxHeightM),
        Number(terrainIrregularityM),
        Math.trunc(Number(climateCode)),
        Math.trunc(Number(polarizationCode)),
        Number(surfaceRefractivityNUnits),
        Number(groundDielectricConstant),
        Number(groundConductivitySPerM),
        Number(timePercent),
        Number(locationPercent),
        Number(situationPercent),
      );
    },
    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadRfLongleyRicePlugin = createRfLongleyRicePlugin;
export const metadata = STATIC_METADATA;

export default createRfLongleyRicePlugin;
