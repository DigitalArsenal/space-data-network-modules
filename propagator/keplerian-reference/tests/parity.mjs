// Tri-runtime parity (browser, WasmEdge, Docker WasmEdge) of the THREADED
// build (dist/isomorphic/module.wasm: pthreads on a shared memory): the SDN
// invoke surface (`ingest_omm`) gives byte-identical responses and identical
// error classes in every lane, so the pthreads artifact instantiates and runs
// the same in the browser, native WasmEdge and the pinned container.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs
// The small-body exports the catalog drives are not invoke methods; their
// threaded results equal the single-thread exports bit for bit
// (tests/small-catalog.e2e.test.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatParityReport, normalizeParityFixture, runParityHarness } from "space-data-module-sdk/testing";

import * as flatbuffers from "flatbuffers";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OMM_TYPE = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
/** A ratified $OMM (ISS-like mean elements), built with the SDS JS bindings. */
function omm({ meanMotion = 15.5, eccentricity = 0.0006 } = {}) {
  const b = new flatbuffers.Builder(256);
  const epoch = b.createString("2026-10-13T00:00:00.000Z");
  const name = b.createString("PARITY");
  OMM.startOMM(b);
  OMM.addObjectName(b, name);
  OMM.addEpoch(b, epoch);
  OMM.addMeanMotion(b, meanMotion);
  OMM.addEccentricity(b, eccentricity);
  OMM.addInclination(b, 51.64);
  OMM.addRaOfAscNode(b, 120.5);
  OMM.addArgOfPericenter(b, 80.1);
  OMM.addMeanAnomaly(b, 280.2);
  OMM.addNoradCatId(b, 25544);
  b.finish(OMM.endOMM(b), "$OMM");
  return { portId: "omm", typeRef: OMM_TYPE, payloadHex: Buffer.from(b.asUint8Array()).toString("hex") };
}
const cases = [
  { id: "ingest", inputs: [omm()] },
  { id: "unphysical", inputs: [omm({ eccentricity: 1.5 })] },
  { id: "refused-identifier", inputs: [{ portId: "omm", typeRef: OMM_TYPE, payloadHex: Buffer.from("0000000000000000", "hex").toString("hex") }] },
  { id: "missing-frame", inputs: [] },
];
const plan = await normalizeParityFixture({
  name: "keplerian-reference 1.8.2 (pthreads) ingest_omm",
  cases: cases.map((c) => ({ id: c.id, request: { methodId: "ingest_omm", inputs: c.inputs } })),
});
const report = await runParityHarness({ wasmPath: path.join(here, "..", "dist", "isomorphic", "module.wasm"), plan, timeoutMs: 300000, log: console.log });
console.log(formatParityReport(report));
fs.mkdirSync(path.join(here, "..", "conformance"), { recursive: true });
fs.writeFileSync(path.join(here, "..", "conformance", "parity.json"), `${JSON.stringify({ ...report, wasmPath: "dist/isomorphic/module.wasm" }, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.failures));
