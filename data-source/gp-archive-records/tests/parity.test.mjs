import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatParityReport, normalizeParityFixture, runParityHarness } from "space-data-module-sdk/testing";

import { CAT_FIELDS, MPE_FIELDS, encodeFieldBatch } from "./field-batch.mjs";

// Tri-runtime parity (SDK harness): the one artifact in headless Chrome, native
// WasmEdge at the SDK pin and the pinned Docker WasmEdge must return identical
// bytes and identical error classes. Needs Chrome, WasmEdge 0.16.4 and Docker,
// so it runs on request: npm run test:parity.
const VECTORS = JSON.parse(fs.readFileSync(new URL("./archive-v1-vectors.json", import.meta.url), "utf8"));

const fieldValues = (vector, fields) =>
  Object.fromEntries(
    fields.map(([name, kind]) => [
      name,
      kind === "string" && vector[`${name}_BASE64`] !== undefined
        ? new Uint8Array(Buffer.from(vector[`${name}_BASE64`], "base64"))
        : vector[name],
    ]),
  );

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

const batch = (fields, vectors) => Buffer.from(encodeFieldBatch(fields, vectors.map((v) => fieldValues(v, fields))));

test(
  "one artifact produces identical records in Chromium, native WasmEdge and container WasmEdge",
  { skip: process.env.SDN_RUN_GP_ARCHIVE_RECORDS_PARITY !== "1" },
  async () => {
    const plan = await normalizeParityFixture({
      name: "gp-archive-records",
      threadCounts: [1],
      cases: [
        { id: "build-mpe-archive-v1-vectors", request: request("build_mpe", batch(MPE_FIELDS, VECTORS.mpe)), expect: "ok" },
        { id: "build-cat-archive-v1-vectors", request: request("build_cat", batch(CAT_FIELDS, VECTORS.cat)), expect: "ok" },
        { id: "build-mpe-empty", request: request("build_mpe", batch(MPE_FIELDS, [])), expect: "ok" },
        { id: "build-mpe-missing-field", request: request("build_mpe", batch(MPE_FIELDS.slice(0, 3), VECTORS.mpe.slice(0, 2))), expect: "ok" },
        { id: "build-cat-truncated", request: request("build_cat", batch(CAT_FIELDS, VECTORS.cat.slice(0, 3)).subarray(0, 40)), expect: "ok" },
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
