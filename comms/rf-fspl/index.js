// rf-fspl JS host wrapper.
//
// Loads the compiled WASM module, calls the C++ kernels directly via
// Emscripten exports (this is the "fast path" pattern documented in
// space-data-module-sdk: scalar primitives skip the FlatBuffer stream-invoke
// envelope when the cost would dominate the math).

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfFsplPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfFsplPluginManifest();
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

async function loadFsplModuleFactory() {
  const { default: createRfFsplModule } = await import("./dist/rf-fspl.mjs");
  return createRfFsplModule;
}

async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-fspl-binary.js");
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
      bytesSymbol: "rf_fspl_plugin_manifest_bytes",
      sizeSymbol: "rf_fspl_plugin_manifest_size",
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

export function getRfFsplManifest() {
  return STATIC_MANIFEST;
}

export async function createRfFsplPlugin(options = {}) {
  const createRfFsplModule = await loadFsplModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createRfFsplModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-fspl-wasm";
  if (typeof module._plugin_init === "function") {
    module._plugin_init(0, 0);
  }

  const manifest = attachEmbeddedManifestMetadata(module);
  const metadata = module.__orbproMetadata ?? STATIC_METADATA;

  // Direct exports — the JS host calls C++ functions by name. No FlatBuffer
  // envelope, no per-call malloc/copy. For scalar (double, double) -> double
  // primitives this is dramatically faster than going through stream-invoke.
  function frrisDb(rangeMeters, frequencyHz) {
    return module._rf_fspl_friis_db(
      Number(rangeMeters),
      Number(frequencyHz),
    );
  }

  function ituP525Db(distanceKm, frequencyMhz) {
    return module._rf_fspl_itu_p525_db(
      Number(distanceKm),
      Number(frequencyMhz),
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
     * Friis form. range in meters, frequency in Hz, returns dB.
     */
    fsplFriis: frrisDb,
    /**
     * ITU-R P.525-4 §6.1 form. distance in km, frequency in MHz, returns dB.
     */
    fsplItuP525: ituP525Db,
    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadRfFsplPlugin = createRfFsplPlugin;
export const metadata = STATIC_METADATA;

export default createRfFsplPlugin;
