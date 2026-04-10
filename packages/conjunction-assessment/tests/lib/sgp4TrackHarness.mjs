import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PACKAGES_DIR = path.resolve(__dirname, "..", "..", "..");
const SGP4_PACKAGE_DIR = path.join(REPO_PACKAGES_DIR, "sgp4-propagator");
const SGP4_ISOMORPHIC_WASM_PATH = path.join(
  SGP4_PACKAGE_DIR,
  "dist",
  "isomorphic",
  "module.wasm",
);

function isoToJulianDate(isoString) {
  const millis = Date.parse(String(isoString ?? "").trim());
  if (!Number.isFinite(millis)) {
    throw new Error(`Invalid ISO epoch: ${isoString}`);
  }
  return millis / 86400000 + 2440587.5;
}

function decodeInvokePayload(response) {
  if (response?.statusCode !== 0) {
    throw new Error(
      response?.errorMessage ||
        response?.errorCode ||
        "SGP4 propagator request failed.",
    );
  }

  const payload = response.outputs?.find((frame) => frame.portId === "response")
    ?.payload;
  if (!(payload instanceof Uint8Array)) {
    throw new Error("SGP4 propagator did not emit a response payload.");
  }
  return JSON.parse(new TextDecoder().decode(payload));
}

function makeInvokeRequest(request) {
  return {
    methodId: "invoke",
    inputs: [
      {
        portId: "request",
        payload: Buffer.from(JSON.stringify(request), "utf8"),
      },
    ],
  };
}

export function sgp4ArtifactExists() {
  return fs.existsSync(SGP4_ISOMORPHIC_WASM_PATH);
}

export async function createLocalSgp4Plugin() {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(SGP4_ISOMORPHIC_WASM_PATH),
    surface: "command",
  });
  let records = [];
  let destroyed = false;

  return {
    initFromOMM(ommRecords) {
      records = Array.isArray(ommRecords) ? ommRecords.slice() : [];
      return records.length;
    },

    get entityCount() {
      return records.length;
    },

    async sampleTrack({
      entityIndex,
      startJd,
      stepDays,
      sampleCount,
      objectName = null,
      objectId = null,
    }) {
      const gpRecord = records[entityIndex];
      if (!gpRecord) {
        throw new Error(`No GP record loaded for entity ${entityIndex}.`);
      }

      const safeSampleCount = Math.max(2, Number(sampleCount ?? 0));
      const stepSeconds = Number(stepDays) * 86400.0;
      const endJd =
        Number(startJd) + Number(stepDays) * (safeSampleCount - 1);
      const response = await harness.invoke(
        makeInvokeRequest({
          operation: "propagateGP",
          params: {
            gpJson: JSON.stringify([gpRecord]),
            startJd: Number(startJd),
            endJd,
            stepSeconds,
          },
        }),
      );
      const payload = decodeInvokePayload(response);

      return {
        object_name: objectName ?? payload.objectName ?? gpRecord.OBJECT_NAME ?? null,
        object_id: objectId ?? gpRecord.OBJECT_ID ?? null,
        norad_cat_id: Number(payload.noradId ?? gpRecord.NORAD_CAT_ID ?? 0),
        samples: Array.isArray(payload.states)
          ? payload.states.map((state) => ({
              epochJD: Number(state.epochJd),
              x_km: Number(state.x),
              y_km: Number(state.y),
              z_km: Number(state.z),
              vx_km_s: Number(state.vx),
              vy_km_s: Number(state.vy),
              vz_km_s: Number(state.vz),
            }))
          : [],
      };
    },

    async destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      await harness.destroy();
    },
  };
}

export async function sampleTrackWindowFromReference(
  plugin,
  gpRecords,
  reference,
  options = {},
) {
  const accepted = plugin.initFromOMM(gpRecords);
  if (accepted < 2) {
    throw new Error(`SGP4 plugin accepted ${accepted} records.`);
  }

  const centerJd = isoToJulianDate(reference.tca);
  const leadSeconds = Number(options.leadSeconds ?? 240);
  const lagSeconds = Number(options.lagSeconds ?? 240);
  const sampleStepSeconds = Number(options.sampleStepSeconds ?? 1);
  const startJd = centerJd - leadSeconds / 86400.0;
  const durationSeconds = leadSeconds + lagSeconds;
  const sampleCount = Math.floor(durationSeconds / sampleStepSeconds) + 1;
  const stepDays = sampleStepSeconds / 86400.0;

  return Promise.all(
    gpRecords.map((record, entityIndex) =>
      plugin.sampleTrack({
        entityIndex,
        startJd,
        stepDays,
        sampleCount,
        objectName: record.OBJECT_NAME ?? null,
        objectId: record.OBJECT_ID ?? null,
      }),
    ),
  );
}
