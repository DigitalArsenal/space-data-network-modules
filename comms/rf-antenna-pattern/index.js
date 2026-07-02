// rf-antenna-pattern JS host wrapper. All gain math executes in the
// C++ kernel (repo law: physics in WASM); this wrapper only parses
// pattern descriptors (defaults + alias resolution, mirroring
// AntennaPattern.evaluateGain / normalizeSampledPattern), marshals
// float64 grids through plugin memory, and decodes results.

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfAntennaPatternPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfAntennaPatternPluginManifest();
const STATIC_METADATA = createLegacyMetadata(STATIC_MANIFEST, {
  encrypted: false,
  requiresProtection: false,
});

/**
 * Analytic pattern-family enum, matching the C++ kernel's switch and
 * the AntennaPatternType string constants in AntennaPattern.js.
 * Unknown values evaluate as RINGED (the JS `default:` case).
 */
export const AntennaPatternType = Object.freeze({
  ISOTROPIC: 0,
  HEMISPHERIC: 1,
  PARABOLIC: 2,
  GAUSSIAN: 3,
  PENCIL: 4,
  DIPOLE: 5,
  HELIX: 6,
  DISH: 7,
  RINGED: 8,
  TOROIDAL: 9,
  CARDIOID: 10,
  TEARDROP: 11,
});

const PATTERN_TYPE_BY_NAME = Object.freeze({
  isotropic: AntennaPatternType.ISOTROPIC,
  hemispheric: AntennaPatternType.HEMISPHERIC,
  parabolic: AntennaPatternType.PARABOLIC,
  gaussian: AntennaPatternType.GAUSSIAN,
  pencil: AntennaPatternType.PENCIL,
  dipole: AntennaPatternType.DIPOLE,
  helix: AntennaPatternType.HELIX,
  dish: AntennaPatternType.DISH,
  ringed: AntennaPatternType.RINGED,
  toroidal: AntennaPatternType.TOROIDAL,
  cardioid: AntennaPatternType.CARDIOID,
  teardrop: AntennaPatternType.TEARDROP,
});

// AntennaPattern.evaluateGain defaults.
const PATTERN_DEFAULTS = Object.freeze({
  mainLobeExponent: 5.0,
  sideLobeLevel: 0.22,
  sideLobeCount: 5.0,
  backLobeLevel: 0.08,
  backLobeExponent: 2.0,
  axialNullExponent: 1.8,
  angularScale: 1.0,
});

const CONE_CLOCK_RESULT_SIZE = 16;

function resolvePatternType(patternType) {
  if (typeof patternType === "string") {
    const resolved = PATTERN_TYPE_BY_NAME[patternType.toLowerCase()];
    // Unknown strings intentionally map to RINGED — same as the JS
    // evaluator's default switch case.
    return resolved ?? AntennaPatternType.RINGED;
  }
  const numeric = Number(patternType);
  return Number.isInteger(numeric) ? numeric : AntennaPatternType.RINGED;
}

function resolveAnalyticArgs(pattern = {}) {
  return [
    resolvePatternType(pattern.patternType ?? AntennaPatternType.RINGED),
    Number(pattern.mainLobeExponent ?? PATTERN_DEFAULTS.mainLobeExponent),
    Number(pattern.sideLobeLevel ?? PATTERN_DEFAULTS.sideLobeLevel),
    Number(pattern.sideLobeCount ?? PATTERN_DEFAULTS.sideLobeCount),
    Number(pattern.backLobeLevel ?? PATTERN_DEFAULTS.backLobeLevel),
    Number(pattern.backLobeExponent ?? PATTERN_DEFAULTS.backLobeExponent),
    Number(pattern.axialNullExponent ?? PATTERN_DEFAULTS.axialNullExponent),
    Number(pattern.angularScale ?? PATTERN_DEFAULTS.angularScale),
  ];
}

function toNumberArray(values) {
  if (values === undefined || values === null) {
    return undefined;
  }
  return Array.from(values, (value) => Number(value));
}

// Alias resolution + validation, mirroring normalizeSampledPattern in
// AntennaPattern.js. Pure parsing — the interpolation itself is WASM.
function normalizeSampledPatternInput(sampledPattern) {
  const clockAnglesDegrees = toNumberArray(
    sampledPattern.clockAnglesDegrees ??
      sampledPattern.clockAngles ??
      sampledPattern.phiAnglesDegrees,
  );
  const coneAnglesDegrees = toNumberArray(
    sampledPattern.coneAnglesDegrees ??
      sampledPattern.coneAngles ??
      sampledPattern.thetaAnglesDegrees,
  );
  const gainDbValues = toNumberArray(
    sampledPattern.gainDbValues ??
      sampledPattern.gainsDb ??
      sampledPattern.samplesDb,
  );

  if (
    clockAnglesDegrees === undefined ||
    coneAnglesDegrees === undefined ||
    gainDbValues === undefined ||
    clockAnglesDegrees.length < 2 ||
    coneAnglesDegrees.length < 2
  ) {
    throw new Error(
      "sampledPattern must define at least two clock angles, two cone angles, and a dense gainDbValues grid.",
    );
  }
  if (
    gainDbValues.length !==
    clockAnglesDegrees.length * coneAnglesDegrees.length
  ) {
    throw new Error(
      "sampledPattern.gainDbValues length must equal coneAnglesDegrees.length * clockAnglesDegrees.length.",
    );
  }

  return {
    coneAnglesDegrees,
    clockAnglesDegrees,
    gainDbValues,
    clockWrap: sampledPattern.clockWrap ?? true,
    maximumGainDb: sampledPattern.maximumGainDb,
  };
}

function toVector3(value, label) {
  let x;
  let y;
  let z;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    [x, y, z] = value;
  } else if (value && typeof value === "object") {
    ({ x, y, z } = value);
  }
  x = Number(x);
  y = Number(y);
  z = Number(z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(`${label} must be a finite [x, y, z] vector.`);
  }
  return [x, y, z];
}

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
  const { default: createModule } = await import(
    "./dist/rf-antenna-pattern.mjs"
  );
  return createModule;
}
async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-antenna-pattern-binary.js");
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
      bytesSymbol: "rf_antenna_pattern_plugin_manifest_bytes",
      sizeSymbol: "rf_antenna_pattern_plugin_manifest_size",
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

export function getRfAntennaPatternManifest() {
  return STATIC_MANIFEST;
}

export async function createRfAntennaPatternPlugin(options = {}) {
  const createModule = await loadModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-antenna-pattern-wasm";
  if (typeof module._plugin_init === "function") {
    module._plugin_init(0, 0);
  }

  const manifest = attachEmbeddedManifestMetadata(module);
  const metadata = module.__orbproMetadata ?? STATIC_METADATA;

  function writeFloat64Buffer(values) {
    const pointer = module._malloc(values.length * 8);
    new Float64Array(module.HEAPU8.buffer, pointer, values.length).set(values);
    return pointer;
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
     * Analytic-family unit gain in [0, 1]. `pattern` mirrors the
     * AntennaPattern.evaluateGain descriptor: `patternType` (enum or
     * string, unknown → RINGED) plus mainLobeExponent / sideLobeLevel /
     * sideLobeCount / backLobeLevel / backLobeExponent /
     * axialNullExponent / angularScale (evaluateGain defaults apply).
     * Angles in radians.
     */
    gain(pattern, coneAngle, clockAngle) {
      return module._rf_ant_gain(
        ...resolveAnalyticArgs(pattern),
        Number(coneAngle),
        Number(clockAngle),
      );
    },

    /**
     * Analytic-family gain in dB:
     *   pattern.referenceGainDb + 10·log10(max(gain, 1e-12))
     * (floor: referenceGainDb − 120 dB, matching the JS EPSILON12
     * clamp). For sampled patterns use evaluateSampledGainDb — the JS
     * evaluator ignores referenceGainDb on the sampled path.
     */
    gainDb(pattern, coneAngle, clockAngle) {
      return module._rf_ant_gain_db(
        ...resolveAnalyticArgs(pattern),
        Number(coneAngle),
        Number(clockAngle),
        Number(pattern?.referenceGainDb ?? 0.0),
      );
    },

    /**
     * Load a sampled cone×clock dB grid and return an integer handle.
     * Accepts the same descriptor (and aliases) as
     * AntennaPattern normalizeSampledPattern: coneAnglesDegrees /
     * coneAngles / thetaAnglesDegrees, clockAnglesDegrees /
     * clockAngles / phiAnglesDegrees, gainDbValues / gainsDb /
     * samplesDb (row-major by cone), clockWrap (default true),
     * maximumGainDb (default: grid maximum). The grids are copied into
     * WASM memory via _malloc'd float64 buffers and freed immediately.
     */
    loadSampledPattern(sampledPattern) {
      const normalized = normalizeSampledPatternInput(sampledPattern);
      const conePointer = writeFloat64Buffer(normalized.coneAnglesDegrees);
      const clockPointer = writeFloat64Buffer(normalized.clockAnglesDegrees);
      const gainsPointer = writeFloat64Buffer(normalized.gainDbValues);
      try {
        const handle = module._rf_ant_load_sampled_pattern(
          conePointer,
          normalized.coneAnglesDegrees.length,
          clockPointer,
          normalized.clockAnglesDegrees.length,
          gainsPointer,
          normalized.clockWrap ? 1 : 0,
          normalized.maximumGainDb === undefined
            ? Number.NaN
            : Number(normalized.maximumGainDb),
        );
        if (handle < 1) {
          throw new Error(
            `rf_ant_load_sampled_pattern returned status ${handle}`,
          );
        }
        return handle;
      } finally {
        module._free(gainsPointer);
        module._free(clockPointer);
        module._free(conePointer);
      }
    },

    /**
     * Bilinear grid gain in dB at (coneAngle, clockAngle) radians for
     * a loaded handle. Cone axis clamps to the grid extent; clock axis
     * wraps at 360° when the pattern was loaded with clockWrap.
     */
    evaluateSampledGainDb(handle, coneAngle, clockAngle) {
      return module._rf_ant_evaluate_sampled_gain_db(
        Number(handle),
        Number(coneAngle),
        Number(clockAngle),
      );
    },

    /**
     * Sampled unit gain in [0, 1]:
     *   clamp01(10^((gainDb − maximumGainDb) / 10)).
     */
    evaluateSampledGain(handle, coneAngle, clockAngle) {
      return module._rf_ant_evaluate_sampled_gain(
        Number(handle),
        Number(coneAngle),
        Number(clockAngle),
      );
    },

    /** Release a sampled-pattern handle. */
    freePattern(handle) {
      const status = module._rf_ant_free_pattern(Number(handle));
      if (status !== 0) {
        throw new Error(`rf_ant_free_pattern returned status ${status}`);
      }
    },

    /**
     * Geometry bridge: antenna-local { cone, clock } angles (radians)
     * toward a target. Vectors accept [x, y, z] arrays or {x, y, z}
     * objects. Semantics: z = normalize(boresight); x = cross(up, z)
     * with a UNIT_X/UNIT_Y helper fallback when up is parallel to the
     * boresight; y = cross(z, x); cone = acos(clamp(dot(dir, z)));
     * clock = atan2(dot(dir, y), dot(dir, x)).
     */
    computeConeClock(antennaPosition, boresight, up, targetPosition) {
      const ant = toVector3(antennaPosition, "antennaPosition");
      const bore = toVector3(boresight, "boresight");
      const upV = toVector3(up, "up");
      const target = toVector3(targetPosition, "targetPosition");
      const pointer = module._malloc(CONE_CLOCK_RESULT_SIZE);
      try {
        const status = module._rf_ant_compute_cone_clock(
          ant[0], ant[1], ant[2],
          bore[0], bore[1], bore[2],
          upV[0], upV[1], upV[2],
          target[0], target[1], target[2],
          pointer,
          CONE_CLOCK_RESULT_SIZE,
        );
        if (status !== 0) {
          throw new Error(
            `rf_ant_compute_cone_clock returned status ${status}`,
          );
        }
        const view = new DataView(
          module.HEAPU8.buffer,
          pointer,
          CONE_CLOCK_RESULT_SIZE,
        );
        return {
          cone: view.getFloat64(0, true),
          clock: view.getFloat64(8, true),
        };
      } finally {
        module._free(pointer);
      }
    },

    destroy() {
      if (typeof module._plugin_destroy === "function") {
        module._plugin_destroy();
      }
    },
  };
}

export const loadRfAntennaPatternPlugin = createRfAntennaPatternPlugin;
export const metadata = STATIC_METADATA;

export default createRfAntennaPatternPlugin;
