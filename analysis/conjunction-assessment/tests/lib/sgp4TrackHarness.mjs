import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  invokePiv,
  loadRawSgp4Module,
} from "../../../../propagator/sgp4/tests/lib/pivInvokeHelper.mjs";
import {
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "../../../../propagator/sgp4/tests/lib/payloadEncoders.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LEGACY_PACKAGES_DIR = path.resolve(__dirname, "..", "..", "..");
const SGP4_PACKAGE_CANDIDATES = [
  path.join(REPO_ROOT, "propagator", "sgp4"),
  path.join(REPO_ROOT, "propagator.sgp4"),
  path.join(LEGACY_PACKAGES_DIR, "propagator.sgp4"),
];
const SGP4_PACKAGE_DIR =
  SGP4_PACKAGE_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ??
  SGP4_PACKAGE_CANDIDATES[0];
const SGP4_ISOMORPHIC_WASM_PATH = path.join(
  SGP4_PACKAGE_DIR,
  "dist",
  "isomorphic",
  "module.wasm",
);
const SGP4_BROWSER_MODULE_PATH = path.join(
  SGP4_PACKAGE_DIR,
  "dist",
  "browser",
  "module.js",
);
const SGP4_BROWSER_WASM_PATH = path.join(
  SGP4_PACKAGE_DIR,
  "dist",
  "browser",
  "module.wasm",
);

export function sgp4ArtifactExists() {
  return (
    fs.existsSync(SGP4_ISOMORPHIC_WASM_PATH) &&
    fs.existsSync(SGP4_BROWSER_MODULE_PATH) &&
    fs.existsSync(SGP4_BROWSER_WASM_PATH)
  );
}

export async function createLocalSgp4Plugin() {
  const module = await loadRawSgp4Module();
  let records = [];
  let destroyed = false;

  return {
    initFromOMM(ommRecords) {
      records = Array.isArray(ommRecords) ? ommRecords.slice() : [];
      for (const record of records) {
        const ingest = invokePiv(module, {
          methodId: "ingest_omm",
          inputs: [
            {
              portId: "omm",
              bytes: encodeOmmPayload({
                noradId: Number(record.NORAD_CAT_ID ?? 0),
                objectName: record.OBJECT_NAME ?? "",
                objectId: record.OBJECT_ID ?? "",
                epoch: record.EPOCH ?? "",
                meanMotion: Number(record.MEAN_MOTION ?? 0),
                eccentricity: Number(record.ECCENTRICITY ?? 0),
                inclination: Number(record.INCLINATION ?? 0),
                raan: Number(record.RA_OF_ASC_NODE ?? 0),
                argPericenter: Number(record.ARG_OF_PERICENTER ?? 0),
                meanAnomaly: Number(record.MEAN_ANOMALY ?? 0),
                bstar: Number(record.BSTAR ?? 0),
                meanMotionDot: Number(record.MEAN_MOTION_DOT ?? 0),
                meanMotionDdot: Number(record.MEAN_MOTION_DDOT ?? 0),
              }),
              schemaName: "orbpro.sds.omm",
              fileIdentifier: "$OMM",
            },
          ],
        });
        if (ingest.response.STATUS_CODE !== 0) {
          throw new Error(
            ingest.response.ERROR_MESSAGE ||
              `SGP4 ingest_omm failed for ${record.NORAD_CAT_ID}`,
          );
        }
      }
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
      const samples = [];
      for (let i = 0; i < safeSampleCount; i += 1) {
        const epochJd = Number(startJd) + Number(stepDays) * i;
        const propagate = invokePiv(module, {
          methodId: "propagate_state",
          inputs: [
            {
              bytes: encodePropagatorBatchRequest({
                epoch: epochJd,
                entityHandles: [entityIndex],
                maxCount: 1,
              }),
              portId: "request",
              schemaName: "orbpro.propagator.PropagatorBatchRequest",
              fileIdentifier: "PROP",
            },
          ],
          outputStreamCap: 1,
        });
        if (propagate.response.STATUS_CODE !== 0) {
          throw new Error(
            propagate.response.ERROR_MESSAGE ||
              `SGP4 propagate_state failed for ${gpRecord.NORAD_CAT_ID}`,
          );
        }
        const statePayload = propagate.outputPayloads.find(
          (output) => output.portId === "state",
        )?.bytes;
        if (!(statePayload instanceof Uint8Array)) {
          throw new Error("SGP4 propagate_state did not emit a state payload.");
        }
        const state = decodePropagatorState(statePayload);
        samples.push({
          epochJD: Number(state.epochJd ?? epochJd),
          x_km: Number(state.position?.[0]) / 1000.0,
          y_km: Number(state.position?.[1]) / 1000.0,
          z_km: Number(state.position?.[2]) / 1000.0,
          vx_km_s: Number(state.velocity?.[0]) / 1000.0,
          vy_km_s: Number(state.velocity?.[1]) / 1000.0,
          vz_km_s: Number(state.velocity?.[2]) / 1000.0,
        });
      }

      return {
        referenceFrame: "ECEF",
        object_name: objectName ?? gpRecord.OBJECT_NAME ?? null,
        object_id: objectId ?? gpRecord.OBJECT_ID ?? null,
        norad_cat_id: Number(gpRecord.NORAD_CAT_ID ?? 0),
        samples,
      };
    },

    async destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      module._plugin_destroy?.();
    },
  };
}

function isoToJulianDate(isoString) {
  const millis = Date.parse(String(isoString ?? "").trim());
  if (!Number.isFinite(millis)) {
    throw new Error(`Invalid ISO epoch: ${isoString}`);
  }
  return millis / 86400000 + 2440587.5;
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
