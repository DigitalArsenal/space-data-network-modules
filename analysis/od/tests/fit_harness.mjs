// The fit's typed contract for the tests: a text ephemeris goes in as an SDS $FIL on "meme", the options are node
// CONFIG (plugin.getConfig answers the host's `config`), and the result comes back as $OMM / $OBD / $OCM records (and
// the opt-in two-line set as a $FIL on "tle"). A host's config is fixed when it is created, so a pool keeps one
// harness per config.
import assert from "node:assert/strict";
import { ByteBuffer } from "flatbuffers";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OBD } from "spacedatastandards.org/lib/js/OBD/OBD.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";

import { assertSuccessfulResponse, createStandaloneHarnessOrSkip } from "space-data-module-sdk/testing/isomorphic";
import { loadStandard } from "./sds_bindings.mjs";

const { FIL, FILT, flatbuffers } = await loadStandard("FIL");

export const FIL_TYPE = { schemaName: "FIL.fbs", fileIdentifier: "$FIL", rootTypeName: "FIL", wireFormat: "flatbuffer" };

/** A text ephemeris file as the "meme" input: one SDS $FIL whose CONTENT is the text. */
export function filFrame(bytes, name = "ephemeris.txt") {
  const builder = new flatbuffers.Builder(1024 + bytes.length);
  const file = Object.assign(new FILT(), { NAME: name, MEDIA_TYPE: "text/plain", CONTENT: [...bytes] });
  builder.finish(file.pack(builder), "$FIL");
  return { portId: "meme", typeRef: FIL_TYPE, payload: builder.asUint8Array() };
}

export function createFitRequest(payload, config = null) {
  return { methodId: "fit", inputs: [filFrame(payload)], config: config ?? {} };
}

/** One harness per CONFIG; `invoke(request)` runs `request` on the harness whose host answers `request.config`. */
export async function createFitPoolOrSkip(runtimeKind, wasmPath, t, options = {}) {
  const harnesses = new Map();
  const harnessFor = async (config) => {
    const key = JSON.stringify(config ?? {});
    if (!harnesses.has(key)) {
      harnesses.set(key, await createStandaloneHarnessOrSkip(runtimeKind, wasmPath, t, {
        ...options, hostOptions: { ...(options.hostOptions ?? {}), config: config ?? {} },
      }));
    }
    return harnesses.get(key);
  };
  if (!(await harnessFor({}))) return null;
  return {
    async invoke({ config, ...request }) {
      return (await harnessFor(config)).invoke(request);
    },
    async destroy() {
      for (const harness of harnesses.values()) await harness?.destroy();
    },
  };
}

const outputs = (response, portId) => response.outputs.filter((frame) => frame.portId === portId);

/**
 * The fit's records rendered, test-side only, in the shape the checks read (the old result object's field names and
 * formatting: elements_to_json's fixed decimals, RMS / REFERENCE_RMS as 3-decimal km strings).
 */
export function fitRecordFromResponse(response) {
  assertSuccessfulResponse(response, { outputPortId: "omm" });
  const omm = OMM.getSizePrefixedRootAsOMM(new ByteBuffer(outputs(response, "omm")[0].payload));
  const obds = outputs(response, "obd").map((frame) => OBD.getSizePrefixedRootAsOBD(new ByteBuffer(frame.payload)));
  const fit = obds.find((obd) => obd.METHOD_SOURCE() !== "reference");
  const reference = obds.find((obd) => obd.METHOD_SOURCE() === "reference");
  const ocmFrame = outputs(response, "ocm")[0];
  assert.ok(fit, "the fit's $OBD");
  assert.ok(ocmFrame, "the fit's $OCM");
  const ocm = OCM.getSizePrefixedRootAsOCM(new ByteBuffer(ocmFrame.payload));
  const fixed = (value, digits) => Number(value.toFixed(digits));
  const record = {
    OBJECT_NAME: omm.OBJECT_NAME() ?? "",
    OBJECT_ID: omm.OBJECT_ID() ?? "",
    EPOCH: omm.EPOCH(),
    MEAN_MOTION: fixed(omm.MEAN_MOTION(), 8),
    ECCENTRICITY: fixed(omm.ECCENTRICITY(), 7),
    INCLINATION: fixed(omm.INCLINATION(), 4),
    RA_OF_ASC_NODE: fixed(omm.RA_OF_ASC_NODE(), 4),
    ARG_OF_PERICENTER: fixed(omm.ARG_OF_PERICENTER(), 4),
    MEAN_ANOMALY: fixed(omm.MEAN_ANOMALY(), 4),
    EPHEMERIS_TYPE: omm.EPHEMERIS_TYPE(),
    CLASSIFICATION_TYPE: omm.CLASSIFICATION_TYPE() ?? "",
    NORAD_CAT_ID: omm.NORAD_CAT_ID(),
    ELEMENT_SET_NO: omm.ELEMENT_SET_NO(),
    REV_AT_EPOCH: omm.REV_AT_EPOCH(),
    BSTAR: Number(omm.BSTAR().toExponential(5)),
    MEAN_MOTION_DOT: Number(omm.MEAN_MOTION_DOT().toExponential(5)),
    MEAN_MOTION_DDOT: Number(omm.MEAN_MOTION_DDOT().toExponential(5)),
    RMS: fit.WRMS().toFixed(3),
    ITERATIONS: fit.NUM_ITERATIONS(),
    CONVERGED: /converged=1/.test(ocm.ORBIT_DETERMINATION()?.OD_CONVERGENCE_CRITERIA() ?? ""),
    DATA_SOURCE: fit.SENSORS(0)?.SENSOR_ID() ?? "",
  };
  // The decoded records themselves, kept off the enumerable (structured-clone / JSON) fields.
  Object.defineProperties(record, { omm: { value: omm }, obd: { value: fit }, ocm: { value: ocm } });
  if (reference) record.REFERENCE_RMS = reference.WRMS().toFixed(3);
  const tle = outputs(response, "tle")[0];
  if (tle) {
    const file = FIL.getRootAsFIL(new flatbuffers.ByteBuffer(tle.payload));
    const [line1, line2] = new TextDecoder().decode(file.contentArray()).split("\n");
    record.TLE_LINE1 = line1;
    record.TLE_LINE2 = line2;
    record.TLE_NAME = file.NAME();
  }
  return record;
}
