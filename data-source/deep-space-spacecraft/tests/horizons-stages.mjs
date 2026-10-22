// Shared standalone replay: the composed-flow test uses this same staged path
// as the authoritative numerical tests, then compares the bytes at storage.
import assert from "node:assert/strict";
import { decodeHttpRequest, encodeHttpResponse } from "space-data-module-sdk/runtime-contracts";

export const framesOn = (result, port) => result.outputs.filter((f) => f.portId === port).map((f) => Buffer.from(f.payload));

export function requestKey(url) {
  const params = Object.fromEntries([...new URL(url).searchParams].map(([k, v]) => [k, v.replace(/^'(.*)'$/s, "$1")]));
  return Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("|");
}

export async function replayStages(harness, { planRequest, answer, checkResult, checkRequest = () => {} }) {
  let result = await harness.invoke(planRequest);
  checkResult(result, "plan_horizons");
  const keys = [], requestsSeen = [], snapshots = [];
  for (const methodId of [...Array(6).fill("advance"), "build_oem"]) {
    const requests = framesOn(result, "request").map(decodeHttpRequest);
    assert.ok(requests.length <= 60, `${methodId} received ${requests.length} requests`);
    const responses = [];
    for (const request of requests) {
      checkRequest(request);
      keys.push(requestKey(request.url));
      requestsSeen.push(request);
      responses.push({ portId: "response", payload: encodeHttpResponse({ status: 200, body: Buffer.from(await answer(request)) }),
        typeRef: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" } });
    }
    const state = framesOn(result, "state");
    assert.equal(state.length, 1);
    const inputs = [{ portId: "state", payload: state[0],
      typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: state[0].length } }, ...responses];
    snapshots.push({ methodId, inputs, requests });
    result = await harness.invoke({ methodId, inputs });
    checkResult(result, `${methodId} ${snapshots.length}`);
  }
  assert.equal(framesOn(result, "request").length, 0);
  return { result, keys, requestsSeen, snapshots };
}
