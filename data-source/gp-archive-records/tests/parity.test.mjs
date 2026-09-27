import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatParityReport, normalizeParityFixture, runParityHarness } from "space-data-module-sdk/testing";

// Tri-runtime parity (SDK harness): the one artifact in headless Chrome, native
// WasmEdge at the SDK pin and the pinned Docker WasmEdge must return identical
// bytes and identical error classes. Needs Chrome, WasmEdge 0.16.4 and Docker,
// so it runs on request: npm run test:parity.
const VECTORS = JSON.parse(fs.readFileSync(new URL("./archive-v1-vectors.json", import.meta.url), "utf8"));

const inputBytes = (vector) =>
  vector.inputBase64 !== undefined ? Buffer.from(vector.inputBase64, "base64") : Buffer.from(vector.inputJson, "utf8");

function request(methodId, payload) {
  return {
    methodId,
    inputs: [
      {
        portId: "records",
        payloadBase64: Buffer.from(payload).toString("base64"),
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.length },
      },
    ],
  };
}

const batch = (vectors) =>
  Buffer.concat([Buffer.from("["), ...vectors.flatMap((v, i) => (i ? [Buffer.from(","), inputBytes(v)] : [inputBytes(v)])), Buffer.from("]")]);

test(
  "one artifact produces identical records in Chromium, native WasmEdge and container WasmEdge",
  { skip: process.env.SDN_RUN_GP_ARCHIVE_RECORDS_PARITY !== "1" },
  async () => {
    const plan = await normalizeParityFixture({
      name: "gp-archive-records",
      threadCounts: [1],
      cases: [
        { id: "build-mpe-archive-v1-vectors", request: request("build_mpe", batch(VECTORS.mpe)), expect: "ok" },
        { id: "build-cat-archive-v1-vectors", request: request("build_cat", batch(VECTORS.cat)), expect: "ok" },
        { id: "build-mpe-empty", request: request("build_mpe", Buffer.from("[]")), expect: "ok" },
        { id: "build-mpe-malformed", request: request("build_mpe", Buffer.from('[{"ENTITY_ID":"A"}]')), expect: "ok" },
        { id: "build-cat-out-of-range", request: request("build_cat", Buffer.from('[{"OBJECT_ID":"A","NORAD_CAT_ID":4294967296,"OBJECT_NAME":""}]')), expect: "ok" },
      ],
    });
    const report = await runParityHarness({
      wasmPath: fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)),
      plan,
      autoBuildDockerImage: false,
      timeoutMs: 60000,
      log: (message) => console.log(message),
    });
    console.log(formatParityReport(report));
    assert.equal(report.ok, true, formatParityReport(report));
    assert.equal(report.lanes.length, 3);
  },
);
