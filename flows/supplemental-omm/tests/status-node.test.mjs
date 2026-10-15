// The status node as built (nodes/status/dist/isomorphic/module.wasm, unsigned) in the SDK's browser module harness:
// the frames the flow hands it (the sources' $OEM, the Starlink source's and the OD node's FlowNotices, the
// storage-ingest IngestResults) in, one $DSS per touched route out.
import assert from "node:assert/strict";
import test from "node:test";

import { sourceOems, statusNode } from "./lib/nodes.mjs";
import { TYPE, decodeDss, decodeOem, encodeFlowNotice, encodeIngestResult } from "./lib/sds.mjs";

const notice = (portId, n) => ({ portId, typeRef: TYPE.FNTC, payload: encodeFlowNotice(n) });
const result = (r) => ({ portId: "store", typeRef: TYPE.INGR, payload: encodeIngestResult(r) });
async function record(node, inputs) {
  const response = await node.invoke({ methodId: "record_event", inputs });
  assert.equal(response.statusCode, 0, response.errorMessage);
  return Object.fromEntries(response.outputs.map((frame) => {
    const dss = decodeDss(frame.payload);
    return [frame.portId, [dss.STATUS, Number(dss.SYNCED_ROWS), Number(dss.TOTAL_ROWS), Number(dss.MISSING_ROWS), Number(dss.DOWNLOADED_BYTES), dss.ERROR ?? null]];
  }));
}

test("provider lanes count the states and bytes of the ephemerides; Starlink's also the objects it could not get", async (t) => {
  const oems = await sourceOems(t);
  const node = await statusNode(t);
  const glonassStates = oems.glonass.slice(0, 2).map((b) => decodeOem(b).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.length).reduce((a, b) => a + b);
  const bytes = oems.glonass[0].byteLength + oems.glonass[1].byteLength;
  assert.deepEqual(await record(node, oems.glonass.slice(0, 2).map((payload) => ({ portId: "provider-glonass", typeRef: TYPE.OEM, payload }))), {
    "provider-glonass.dss": [1, glonassStates, glonassStates, 0, bytes, null],
  });
  const starlink = await record(node, [
    { portId: "provider-starlink", typeRef: TYPE.OEM, payload: oems.starlink[0] },
    notice("provider-starlink-notice", { kind: "missing", reason: "objects-unavailable", count: 1, items: ["STARLINK-36348 (67851): HTTP 404"] }),
  ]);
  const states = decodeOem(oems.starlink[0]).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA.length / 6;
  assert.deepEqual(starlink, { "provider-starlink.dss": [4, states, states + 1, 1, oems.starlink[0].byteLength, "objects-unavailable: STARLINK-36348 (67851): HTTP 404"] });
});

test("the OD lane counts objects and keeps the last refusal visible while later fits succeed", async (t) => {
  const node = await statusNode(t);
  const fitted = (name) => notice("od", { kind: "info", reason: "fitted", count: 1, items: [`OD fit complete: ${name}`] });
  assert.deepEqual(await record(node, [fitted("ISS (NORAD 25544)")]), { "od.dss": [2, 1, 1, 0, 0, null] });
  assert.deepEqual(await record(node, [notice("od", { kind: "skipped", reason: "fit-failed", count: 1, items: ["OD fit failed: X: fit-epoch-failed: diverged"] })]), {
    "od.dss": [4, 1, 2, 1, 0, "1 OD failure: fit-failed: OD fit failed: X: fit-epoch-failed: diverged"],
  });
  assert.deepEqual(await record(node, [fitted("lageos1 (NORAD 8820)")]), {
    "od.dss": [4, 2, 3, 1, 0, "1 OD failure: fit-failed: OD fit failed: X: fit-epoch-failed: diverged"],
  });
});

test("the store lane counts the records stored; a refused batch is an error until the next stored one", async (t) => {
  const node = await statusNode(t);
  assert.deepEqual(await record(node, [result({ schema: "OMM.fbs", inserted: 3n }), result({ schema: "OCM.fbs", inserted: 3n })]), { "store.dss": [2, 6, 6, 0, 0, null] });
  assert.deepEqual(await record(node, [result({ schema: "OBD.fbs", refused: "quota" })]), { "store.dss": [4, 6, 6, 0, 0, "OBD.fbs: quota"] });
  assert.deepEqual(await record(node, [result({ schema: "OBD.fbs", inserted: 3n })]), { "store.dss": [2, 9, 9, 0, 0, null] });
});

test("an invocation with a frame that is not its port's type is refused whole: nothing counted", async (t) => {
  const node = await statusNode(t);
  const refused = await node.invoke({ methodId: "record_event", inputs: [result({ schema: "OMM.fbs", inserted: 5n }), { portId: "od", typeRef: TYPE.FNTC, payload: encodeIngestResult({}) }] });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.errorCode, "status-event");
  assert.deepEqual(await record(node, [result({ schema: "OMM.fbs", inserted: 1n })]), { "store.dss": [2, 1, 1, 0, 0, null] });
});
