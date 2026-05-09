// rf-diffraction JS host wrapper. Direct exports for the four scalar
// kernels plus a JS-side helper for the Deygout multi-knife-edge
// recursion (kept in JS because variable-length obstacle arrays cross
// the WASM boundary at extra cost with no numerical benefit).

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfDiffractionPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfDiffractionPluginManifest();
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
  const { default: createModule } = await import("./dist/rf-diffraction.mjs");
  return createModule;
}

async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-diffraction-binary.js");
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
      bytesSymbol: "rf_diffraction_plugin_manifest_bytes",
      sizeSymbol: "rf_diffraction_plugin_manifest_size",
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

export function getRfDiffractionManifest() {
  return STATIC_MANIFEST;
}

export async function createRfDiffractionPlugin(options = {}) {
  const createModule = await loadModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-diffraction-wasm";
  if (typeof module._plugin_init === "function") {
    module._plugin_init(0, 0);
  }

  const manifest = attachEmbeddedManifestMetadata(module);
  const metadata = module.__orbproMetadata ?? STATIC_METADATA;

  function curvatureDropM(distanceM, effectiveEarthRadiusFactor = 0) {
    return module._rf_curvature_drop_m(
      Number(distanceM),
      Number(effectiveEarthRadiusFactor),
    );
  }

  function fresnelKirchhoffV(clearanceM, d1M, d2M, wavelengthM) {
    return module._rf_fresnel_kirchhoff_v(
      Number(clearanceM),
      Number(d1M),
      Number(d2M),
      Number(wavelengthM),
    );
  }

  function knifeEdgeParameterV({
    startDistanceM,
    startHeightM,
    endDistanceM,
    endHeightM,
    obstacleDistanceM,
    obstacleHeightM,
    wavelengthM,
    effectiveEarthRadiusFactor = 0,
  }) {
    return module._rf_knife_edge_parameter_v(
      Number(startDistanceM),
      Number(startHeightM),
      Number(endDistanceM),
      Number(endHeightM),
      Number(obstacleDistanceM),
      Number(obstacleHeightM),
      Number(wavelengthM),
      Number(effectiveEarthRadiusFactor),
    );
  }

  function knifeEdgeLossDb(v) {
    return module._rf_knife_edge_loss_db(Number(v));
  }

  // Deygout multi-knife-edge recursion. Obstacles list contains
  // {distance, height} pairs in path order. Returns total dB. The
  // host orchestrates the recursion and calls the WASM scalar
  // primitives — no need to marshal arrays across the boundary.
  function multiKnifeEdgeDeygoutLossDb(options) {
    const {
      startDistanceM,
      startHeightM,
      endDistanceM,
      endHeightM,
      obstacles,
      wavelengthM,
      effectiveEarthRadiusFactor = 0,
    } = options;

    if (!Array.isArray(obstacles) || obstacles.length === 0) {
      return 0.0;
    }

    let dominantIndex = -1;
    let dominantV = -Infinity;
    for (let i = 0; i < obstacles.length; i += 1) {
      const ob = obstacles[i];
      const v = module._rf_knife_edge_parameter_v(
        Number(startDistanceM),
        Number(startHeightM),
        Number(endDistanceM),
        Number(endHeightM),
        Number(ob.distance),
        Number(ob.height),
        Number(wavelengthM),
        Number(effectiveEarthRadiusFactor),
      );
      if (v > dominantV) {
        dominantV = v;
        dominantIndex = i;
      }
    }

    if (dominantIndex < 0 || dominantV <= -0.78) {
      return 0.0;
    }

    const dominant = obstacles[dominantIndex];
    let loss = module._rf_knife_edge_loss_db(dominantV);
    if (dominantIndex > 0) {
      loss += multiKnifeEdgeDeygoutLossDb({
        startDistanceM,
        startHeightM,
        endDistanceM: Number(dominant.distance),
        endHeightM: Number(dominant.height),
        obstacles: obstacles.slice(0, dominantIndex),
        wavelengthM,
        effectiveEarthRadiusFactor,
      });
    }
    if (dominantIndex + 1 < obstacles.length) {
      loss += multiKnifeEdgeDeygoutLossDb({
        startDistanceM: Number(dominant.distance),
        startHeightM: Number(dominant.height),
        endDistanceM,
        endHeightM,
        obstacles: obstacles.slice(dominantIndex + 1),
        wavelengthM,
        effectiveEarthRadiusFactor,
      });
    }
    return loss;
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
    curvatureDropM,
    fresnelKirchhoffV,
    knifeEdgeParameterV,
    knifeEdgeLossDb,
    multiKnifeEdgeDeygoutLossDb,
    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadRfDiffractionPlugin = createRfDiffractionPlugin;
export const metadata = STATIC_METADATA;

export default createRfDiffractionPlugin;
