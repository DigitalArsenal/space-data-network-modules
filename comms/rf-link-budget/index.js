// rf-link-budget JS host wrapper. Exposes the scalar primitives and a
// composed budget call that mirrors the legacy CommsPlugin 96-byte
// result struct. Includes the Eb/N0 = SNR + 10·log10(B/Rb) fix the
// audit identified.

import readEmbeddedPluginManifest from "../embeddedManifest.js";
import {
  createRfLinkBudgetPluginManifest,
  createLegacyMetadata,
} from "./manifest.js";
import { stripPublicationRecordCollection } from "space-data-module-sdk/transport";

const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";
const STATIC_MANIFEST = createRfLinkBudgetPluginManifest();
const STATIC_METADATA = createLegacyMetadata(STATIC_MANIFEST, {
  encrypted: false,
  requiresProtection: false,
});

export const LinkFlags = Object.freeze({
  LINK_UP: 0x01,
  BER_OK: 0x02,
  MARGIN_OK: 0x04,
  RAIN_FADE: 0x08,
  ATMO_EFFECTS: 0x10,
});

const RESULT_BUFFER_SIZE = 96;

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
  const { default: createModule } = await import("./dist/rf-link-budget.mjs");
  return createModule;
}
async function loadBundledWasmBytes() {
  const { wasmBase64 } = await import("./dist/rf-link-budget-binary.js");
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
      bytesSymbol: "rf_link_budget_plugin_manifest_bytes",
      sizeSymbol: "rf_link_budget_plugin_manifest_size",
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

export function getRfLinkBudgetManifest() {
  return STATIC_MANIFEST;
}

export async function createRfLinkBudgetPlugin(options = {}) {
  const createModule = await loadModuleFactory();
  const wasmBinary = await resolveWasmBinary(options);
  const module = await createModule({
    wasmBinary,
    noInitialRun: true,
  });

  module.runtime = "rf-link-budget-wasm";
  if (typeof module._plugin_init === "function") {
    module._plugin_init(0, 0);
  }

  const manifest = attachEmbeddedManifestMetadata(module);
  const metadata = module.__orbproMetadata ?? STATIC_METADATA;

  function decodeResult(pointer) {
    const view = new DataView(
      module.HEAPU8.buffer,
      pointer,
      RESULT_BUFFER_SIZE,
    );
    return {
      eirpDbw: view.getFloat64(0, true),
      freeSpaceLossDb: view.getFloat64(8, true),
      totalPathLossDb: view.getFloat64(16, true),
      receivedPowerDbw: view.getFloat64(24, true),
      noisePowerDbw: view.getFloat64(32, true),
      snrDb: view.getFloat64(40, true),
      ebnoDb: view.getFloat64(48, true),
      capacityBps: view.getFloat64(56, true),
      linkMarginDb: view.getFloat64(64, true),
      atmosphericLossDb: view.getFloat64(72, true),
      rainLossDb: view.getFloat64(80, true),
      flags: view.getUint32(88, true),
    };
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

    /** EIRP_dBW = 10·log10(P_W) + G_t − L_t. */
    eirpDbw(txPowerW, txGainDbi, txLineLossDb = 0) {
      return module._rf_link_eirp_dbw(
        Number(txPowerW),
        Number(txGainDbi),
        Number(txLineLossDb),
      );
    },
    /** kTB noise floor in dBW with receiver noise figure F. */
    noisePowerDbw(systemTempK, bandwidthHz, rxNoiseFigureDb = 0) {
      return module._rf_link_noise_power_dbw(
        Number(systemTempK),
        Number(bandwidthHz),
        Number(rxNoiseFigureDb),
      );
    },
    /** Friis FSPL — duplicates rf-fspl for self-contained use. */
    freeSpaceLossDb(rangeM, frequencyHz) {
      return module._rf_link_free_space_loss_db(
        Number(rangeM),
        Number(frequencyHz),
      );
    },
    /**
     * Eb/N0 = SNR + 10·log10(B / R_b)  (Sklar Eq. 4.27).
     * Pass symbolRateHz = bandwidthHz to recover the legacy buggy
     * Eb/N0 = SNR identity if you need bit-for-bit comparison with the
     * pre-fix JS implementation.
     */
    ebnoDb(snrDb, bandwidthHz, symbolRateHz) {
      return module._rf_link_ebno_db(
        Number(snrDb),
        Number(bandwidthHz),
        Number(symbolRateHz),
      );
    },
    /** Shannon channel capacity in bps. */
    capacityBps(bandwidthHz, snrDb) {
      return module._rf_link_capacity_bps(
        Number(bandwidthHz),
        Number(snrDb),
      );
    },
    /**
     * Compose a full link budget. The caller has already invoked the
     * per-model modules (rf-fspl, rf-empirical, rf-atmospheric-gaseous,
     * rf-rain, rf-cloud-fog, etc.) and arrived at a model_loss_db plus
     * atmospheric / rain / cloud / environmental / polarization
     * contributions in dB. This function combines them into the Friis
     * + kTB form and returns the structured result the legacy
     * CommsPlugin consumer expects.
     */
    compute({
      rangeM,
      frequencyHz,
      txPowerW,
      txGainDbi,
      txLineLossDb = 0,
      rxGainDbi,
      rxLineLossDb = 0,
      rxNoiseFigureDb = 3,
      systemTempK = 290,
      bandwidthHz,
      symbolRateHz,
      modelLossDb = 0,
      atmosphericLossDb = 0,
      rainLossDb = 0,
      cloudLossDb = 0,
      environmentalLossDb = 0,
      polarizationMismatchDb = 0,
      requiredLinkMarginDb = 10,
    }) {
      // Default symbol rate to bandwidth (legacy Eb/N0 = SNR behavior)
      // when caller hasn't provided one. The C++ kernel falls back the
      // same way internally; setting it explicitly here makes the JS
      // call site self-documenting.
      const Rb = Number.isFinite(symbolRateHz) && Number(symbolRateHz) > 0
        ? Number(symbolRateHz)
        : Number(bandwidthHz);

      const pointer = module._malloc(RESULT_BUFFER_SIZE);
      try {
        const status = module._rf_link_budget_compute(
          Number(rangeM),
          Number(frequencyHz),
          Number(txPowerW),
          Number(txGainDbi),
          Number(txLineLossDb),
          Number(rxGainDbi),
          Number(rxLineLossDb),
          Number(rxNoiseFigureDb),
          Number(systemTempK),
          Number(bandwidthHz),
          Rb,
          Number(modelLossDb),
          Number(atmosphericLossDb),
          Number(rainLossDb),
          Number(cloudLossDb),
          Number(environmentalLossDb),
          Number(polarizationMismatchDb),
          Number(requiredLinkMarginDb),
          pointer,
          RESULT_BUFFER_SIZE,
        );
        if (status !== 0) {
          throw new Error(
            `rf_link_budget_compute returned status ${status}`,
          );
        }
        return decodeResult(pointer);
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

export const loadRfLinkBudgetPlugin = createRfLinkBudgetPlugin;
export const metadata = STATIC_METADATA;

export default createRfLinkBudgetPlugin;
