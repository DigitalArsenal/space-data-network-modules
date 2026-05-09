// rf-doppler-fresnel JS host wrapper. Two scalar primitives, both called
// via direct Emscripten exports (the FlatBuffer stream-invoke envelope
// would dominate the cost for these (double, double) -> double signatures).

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfDopplerFresnelPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfDopplerFresnelPluginManifest();
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
  const { default: createModule } = await import("./dist/rf-doppler-fresnel.mjs");
  return createModule;
}

async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-doppler-fresnel-binary.js");
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
  if (!module) {
    return STATIC_MANIFEST;
  }
  if (!module.__orbproEmbeddedManifest) {
    const embeddedManifest = readEmbeddedPluginManifest(module, {
      bytesSymbol: "rf_doppler_fresnel_plugin_manifest_bytes",
      sizeSymbol: "rf_doppler_fresnel_plugin_manifest_size",
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

export function getRfDopplerFresnelManifest() {
  return STATIC_MANIFEST;
}

export async function createRfDopplerFresnelPlugin(options = {}) {
  const createModule = await loadModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-doppler-fresnel-wasm";
  if (typeof module._plugin_init === "function") {
    module._plugin_init(0, 0);
  }

  const manifest = attachEmbeddedManifestMetadata(module);
  const metadata = module.__orbproMetadata ?? STATIC_METADATA;

  function dopplerShiftHz(relativeVelocityMps, frequencyHz) {
    return module._rf_doppler_shift_hz(
      Number(relativeVelocityMps),
      Number(frequencyHz),
    );
  }

  function fresnelZoneRadiusM(d1Meters, d2Meters, frequencyHz, zone = 1) {
    return module._rf_fresnel_zone_radius_m(
      Number(d1Meters),
      Number(d2Meters),
      Number(frequencyHz),
      Math.trunc(Number(zone)),
    );
  }

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
     * Classical first-order Doppler shift Δf = (v_r/c) · f_0.
     * relativeVelocityMps positive = closing rate (transmitter and
     * receiver approaching). Returns shift in Hz; negative if receding.
     */
    dopplerShiftHz,
    /**
     * n-th Fresnel-zone radius at an obstruction plane (ITU-R P.526-15 §3).
     * d1 + d2 = total path length; both in meters.
     */
    fresnelZoneRadiusM,
    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadRfDopplerFresnelPlugin = createRfDopplerFresnelPlugin;
export const metadata = STATIC_METADATA;

export default createRfDopplerFresnelPlugin;
