import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  invokePiv,
  loadRawSgp4Module,
} from "../../sgp4/tests/lib/pivInvokeHelper.mjs";
import {
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "../../sgp4/tests/lib/payloadEncoders.mjs";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const FFM_BROWSER_MODULE_PATH = new URL("../dist/browser/module.js", import.meta.url);
const FFM_BROWSER_WASM_PATH = new URL("../dist/browser/module.wasm", import.meta.url);
const SGP4_BROWSER_MODULE_PATH = new URL("../../sgp4/dist/browser/module.js", import.meta.url);
const SGP4_BROWSER_WASM_PATH = new URL("../../sgp4/dist/browser/module.wasm", import.meta.url);
const SAMPLE_EPOCH_JD = 2460310.5;

async function createFfmHarness() {
  return createBrowserModuleHarness({
    wasmSource: await readFile(FFM_BROWSER_WASM_PATH),
    surface: "direct",
  });
}

function artifactsExist() {
  return (
    fs.existsSync(FFM_BROWSER_MODULE_PATH) &&
    fs.existsSync(FFM_BROWSER_WASM_PATH) &&
    fs.existsSync(SGP4_BROWSER_MODULE_PATH) &&
    fs.existsSync(SGP4_BROWSER_WASM_PATH)
  );
}

function assertOkPiv(response, label) {
  assert.equal(
    response.response.STATUS_CODE ?? 0,
    0,
    response.response.ERROR_MESSAGE ?? `${label} failed`,
  );
}

function assertOkSdk(response, label) {
  assert.equal(response.statusCode, 0, response.errorMessage ?? `${label} failed`);
  assert.ok(response.errorCode === "" || response.errorCode === null);
}

test("FFM ingests an aligned-binary PropagatorState emitted by SGP4", async (t) => {
  if (!artifactsExist()) {
    t.skip("Build FFM and SGP4 browser artifacts before running the inter-module PIV test.");
    return;
  }

  const sgp4 = await loadRawSgp4Module();
  const ffm = await createFfmHarness();
  t.after(() => {
    sgp4._plugin_destroy?.();
    ffm.destroy?.();
  });

  const sgp4Ingest = invokePiv(sgp4, {
    methodId: "ingest_omm",
    inputs: [
      {
        portId: "omm",
        payload: encodeOmmPayload(),
        typeRef: {
          schemaName: "orbpro.sds.omm",
          fileIdentifier: "$OMM",
        },
      },
    ],
  });
  assertOkPiv(sgp4Ingest, "SGP4 ingest_omm");

  const sgp4Propagate = invokePiv(sgp4, {
    methodId: "propagate_state",
    inputs: [
      {
        portId: "request",
        payload: encodePropagatorBatchRequest({
          epoch: SAMPLE_EPOCH_JD,
          entityHandles: [0],
          maxCount: 1,
        }),
        typeRef: {
          schemaName: "orbpro.propagator.PropagatorBatchRequest",
          fileIdentifier: "PROP",
          rootTypeName: "PropagatorBatchRequest",
        },
      },
    ],
    outputStreamCap: 1,
  });
  assertOkPiv(sgp4Propagate, "SGP4 propagate_state");

  const sgp4StateFrame = sgp4Propagate.outputPayloads.find(
    (output) => output.portId === "state",
  );
  assert.ok(sgp4StateFrame, "SGP4 emitted a state frame");
  assert.equal(sgp4StateFrame.wireFormat, "aligned-binary");
  const sgp4State = decodePropagatorState(sgp4StateFrame.bytes);
  assert.equal(sgp4State.catalogNumber, 25544);

  const ffmIngest = await ffm.invoke({
    methodId: "ingest_state_gravity_only",
    inputs: [
      {
        portId: "state",
        payload: sgp4StateFrame.bytes,
        typeRef: {
          schemaName: "orbpro.plugins.PropagatorState",
          fileIdentifier: "PRST",
          rootTypeName: "PropagatorState",
          wireFormat: sgp4StateFrame.wireFormat,
        },
      },
    ],
  });
  assertOkSdk(ffmIngest, "FFM ingest_state");

  const ffmPropagate = await ffm.invoke({
    methodId: "propagate_state",
    inputs: [
      {
        portId: "request",
        payload: encodePropagatorBatchRequest({
          epoch: SAMPLE_EPOCH_JD + 60 / 86400,
          entityHandles: [0],
          maxCount: 1,
        }),
        typeRef: {
          schemaName: "orbpro.propagator.PropagatorBatchRequest",
          rootTypeName: "PropagatorBatchRequest",
          wireFormat: "aligned-binary",
        },
      },
    ],
    outputStreamCap: 1,
  });
  assertOkSdk(ffmPropagate, "FFM propagate_state");

  const ffmStateFrame = ffmPropagate.outputs.find(
    (output) => output.portId === "state",
  );
  assert.ok(ffmStateFrame, "FFM emitted a state frame");
  assert.equal(ffmStateFrame.typeRef?.wireFormat, "aligned-binary");
  const ffmState = decodePropagatorState(ffmStateFrame.payload);
  assert.equal(ffmState.catalogNumber, 25544);
  assert.equal(ffmState.valid, true);
  assert.ok(Number.isFinite(ffmState.position?.[0]));
  assert.ok(Number.isFinite(ffmState.velocity?.[0]));
});
