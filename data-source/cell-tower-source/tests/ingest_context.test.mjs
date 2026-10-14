// parse on the CONTEXT the ingest lane really sends: cell-tower-ingest's ingest_plan builds [$APR run contract, $IRM
// job] with FinishSizePrefixed records (alignment relative to the size prefix). Hand-built contexts here are plain
// finished buffers, so this is the one test that reads the producer's own bytes - the case that once trapped parse
// (memory access out of bounds: the kept $IRM was read from its prefix instead of its root).
import assert from "node:assert/strict";
import test from "node:test";
import { decodeHttpRequest, encodeHttpResponse, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";

import * as ingest from "../../cell-tower-ingest/tests/helpers.mjs";
import { TYPE, drainParse, harnessFor, reportsOf } from "./helpers.mjs";

const HEADER = "radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal";
const ROW = "LTE,310,260,40495,17811,0,-73.9857,40.7484,450,12,1,1700000000,1710000000,-91";

test("parse decodes a chunk whose CONTEXT is ingest_plan's own size-prefixed [$APR, $IRM]", async (t) => {
  const planner = await ingest.createHarness(t, { cell_ingest_url: "https://example.invalid/opencellid-bulk.csv" });
  const planned = await planner.invoke({
    methodId: "ingest_plan",
    inputs: [{ portId: "tick", typeRef: ingest.TYPE.TICK, payload: encodeTimerTick({}) }, ...ingest.fsbChunks("mark", new Uint8Array(0))],
  });
  assert.equal(planned.statusCode, 0, planned.errorMessage);
  const request = decodeHttpRequest(planned.outputs.find((o) => o.portId === "request").payload);

  const harness = await harnessFor(t);
  const parsed = await drainParse(harness, [{
    portId: "responses",
    typeRef: TYPE.HRSP,
    payload: encodeHttpResponse({ url: request.url, status: 206, body: Buffer.from(`${HEADER}\n${ROW}\n`), context: request.context }),
  }]);
  const reports = reportsOf(parsed.get("reports").payload);
  assert.equal(reports.length, 1, "the one row decodes to one single-source report");
});
