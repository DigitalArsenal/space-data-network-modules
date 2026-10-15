// The flow's nodes and source modules alone, as built (unsigned), in the SDK's browser module harness.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { CODE_SP3, fixtureResponses, modulesRoot, packageRoot, serve, splitRecords } from "./flow.mjs";
import { TYPE, decodeFlowNotice, decodeHttpRequest, encodeHttpResponse, encodeTimerTick } from "./sds.mjs";

export async function harnessFor(t, dir, config = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin-manifest.json"), "utf8"));
  const harness = await createBrowserModuleHarness({
    wasmSource: new Uint8Array(fs.readFileSync(path.join(dir, "dist/isomorphic/module.wasm"))),
    manifest,
    surface: "direct",
    hostOptions: { config },
  });
  t?.after(() => harness.destroy());
  return harness;
}
export const odNode = (t, config) => harnessFor(t, path.join(packageRoot, "nodes/od"), config);
export const statusNode = (t) => harnessFor(t, path.join(packageRoot, "nodes/status"));

const ok = (response) => {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response;
};
// hostcap/http-request's part: each HttpRequest a source asks for, answered from the fixtures as an HttpResponse.
const answered = (outputs, outPort, inPort, responses) =>
  outputs
    .filter((frame) => frame.portId === outPort)
    .map((frame) => {
      const request = decodeHttpRequest(frame.payload);
      const response = serve(responses, { url: request.url, method: request.method, headers: request.headers });
      return {
        portId: inPort,
        typeRef: TYPE.HRSP,
        payload: encodeHttpResponse({ url: request.url, status: response.status, headers: response.headers, body: response.body, context: request.context, retrievedMs: 0 }),
      };
    });

// Each source module's $OEM frames for the provider fixtures (or `responses`), as the flow hands them to the OD node.
export async function sourceOems(t, responses = fixtureResponses()) {
  const tick = { portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "timer-supplemental-omm", firedMs: 0 }) };
  const chain = async (module, config, steps) => {
    const harness = await harnessFor(t, path.join(modulesRoot, "data-source", module), config);
    let inputs = [tick];
    for (const [methodId, outPort, nextPort] of steps) {
      const response = ok(await harness.invoke({ methodId, inputs }));
      if (!nextPort) return response.outputs.filter((frame) => frame.portId === "oem").map((frame) => new Uint8Array(frame.payload));
      inputs = answered(response.outputs, outPort, nextPort, responses);
    }
    return [];
  };
  return {
    starlink: await chain("spacex-starlink-source", {}, [["plan", "requests", "manifest"], ["select_objects", "requests", "ephemerides"], ["emit"]]),
    glonass: await chain("glonass-source", { sourceUrl: CODE_SP3 }, [["request", "request", "response"], ["emit"]]),
    intelsat: await chain("intelsat-source", {}, [["request", "request", "listing"], ["select_file", "request", "response"], ["emit"]]),
    cpf: await chain("cpf-source", {}, [["request", "request", "listing"], ["select_file", "request", "response"], ["emit"]]),
    iss: await chain("iss-source", {}, [["request", "request", "response"], ["emit"]]),
  };
}

// An ISS OEM (CCSDS KVN text) through data-source/iss-source emit: the $OEM the flow fits.
export async function issOem(t, kvn) {
  const harness = await harnessFor(t, path.join(modulesRoot, "data-source/iss-source"));
  const url = "https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt";
  const response = ok(await harness.invoke({
    methodId: "emit",
    inputs: [{ portId: "response", typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url, status: 200, headers: {}, body: new Uint8Array(kvn), retrievedMs: 0 }) }],
  }));
  const oems = response.outputs.filter((frame) => frame.portId === "oem");
  assert.equal(oems.length, 1);
  return new Uint8Array(oems[0].payload);
}

// The OD node's fit of `frames` (port -> [$OEM]), invoked until its backlog is drained: the record streams by standard,
// the IngestRequests, the notices and the number of invocations.
export async function fit(node, frames) {
  const inputs = Object.entries(frames).flatMap(([portId, list]) => list.map((payload) => ({ portId, typeRef: TYPE.OEM, payload })));
  const out = { omm: [], ocm: [], obd: [], meta: [], notices: [], invocations: 0, backlogs: [] };
  let response = ok(await node.invoke({ methodId: "fit", inputs }));
  for (;;) {
    out.invocations += 1;
    out.backlogs.push(response.backlogRemaining ?? 0);
    for (const frame of response.outputs) {
      if (["omm", "ocm", "obd"].includes(frame.portId)) out[frame.portId].push(...splitRecords(frame.payload));
      else if (frame.portId.endsWith("_meta")) out.meta.push({ port: frame.portId, payload: new Uint8Array(frame.payload) });
      else if (frame.portId === "status") out.notices.push(decodeFlowNotice(frame.payload));
      else assert.fail(`an output on ${frame.portId}`);
    }
    if (!(response.backlogRemaining > 0)) return out;
    response = ok(await node.invoke({ methodId: "fit", inputs: [] }));
  }
}
