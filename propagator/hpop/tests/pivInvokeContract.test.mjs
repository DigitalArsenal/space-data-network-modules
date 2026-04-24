// SDS PIV invoke contract for propagator.hpop.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { invokePiv, loadRawHpopModule } from "./lib/pivInvokeHelper.mjs";

const REQUEST_FIXTURE_PATH = new URL(
  "./fixtures/request.propagate.json",
  import.meta.url,
);

const textDecoder = new TextDecoder();

test("HPOP plugin_invoke_stream accepts SDS PIV request envelopes", async () => {
  const module = await loadRawHpopModule();
  try {
    module.__initialize?.();
    assert.equal(module._plugin_init(), 0);

    const response = invokePiv(module, {
      methodId: "invoke",
      inputs: [
        {
          portId: "request",
          bytes: await readFile(REQUEST_FIXTURE_PATH),
          schemaName: "orbpro.hpop.InvokeRequest",
          fileIdentifier: null,
        },
      ],
      outputStreamCap: 1,
    });

    assert.equal(response.response.STATUS_CODE, 0);
    assert.equal(response.outputPayloads.length, 1);
    assert.equal(response.outputPayloads[0].portId, "response");

    const payload = JSON.parse(
      textDecoder.decode(response.outputPayloads[0].bytes),
    );
    assert.ok(
      payload.version || payload.epochJD,
      "response must contain version or propagation result",
    );
  } finally {
    module._plugin_destroy?.();
  }
});
