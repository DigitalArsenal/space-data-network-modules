// data-source/sigmf-captures: node CONFIG integers are honoured as written.
//
// The node serves its YAML config block verbatim through plugin.getConfig, so
// `sigmf_record_cap: "2000"` reaches the guest as a JSON STRING. host-02 staged
// exactly that and the module read it as "absent", fell back to its 50,000
// default and ingested all 36,636 recordings. These tests pin that a quoted
// and an unquoted integer mean the same thing, that a malformed value fails
// closed instead of silently becoming the default, and that a capped cycle
// says in its provenance how much of the index it left unread.
//
// Every expected count below is computed from the fixture itself
// (fixtures/iqengine-meta.sample.json, 16 capture documents, every one with an
// archive identity), not from a previous run of the module.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const META_JSON = fs.readFileSync(new URL("./fixtures/iqengine-meta.sample.json", import.meta.url));
const META_DOCS = JSON.parse(META_JSON.toString("utf8"));

const BASE_URL = "https://www.iqengine.org";
const JOB = {
  adapter: "iqengine-bulk-meta",
  source_url: `${BASE_URL}/api/datasources/local/local/meta`,
  source_name: "IQEngine",
  base_url: BASE_URL,
  account: "local",
  container: "local",
  archive_source: "sigmf",
  archive_name: "iqengine-bulk-meta-meta.json",
};

function jsonInput(portId, value) {
  return {
    portId,
    typeRef: { wireFormat: "flatbuffer" },
    payload: encoder.encode(JSON.stringify(value)),
  };
}

async function harnessWithConfig(t, config) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => (operation === "plugin.getConfig" ? config : null),
  });
  t.after(() => harness.destroy());
  return harness;
}

function recordCount(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let count = 0;
  for (let off = 0; off < payload.byteLength; count += 1) {
    off += 4 + view.getUint32(off, true);
  }
  return count;
}

async function parseWith(t, config) {
  const harness = await harnessWithConfig(t, config);
  const response = await harness.invoke({
    methodId: "parse",
    inputs: [
      jsonInput("job", JOB),
      jsonInput("response", {
        status: 200,
        headers: { "content-type": "application/json" },
        bodyB64: Buffer.from(META_JSON).toString("base64"),
      }),
    ],
  });
  if (response.statusCode !== 0) return { response };
  const outputs = new Map(response.outputs.map((frame) => [frame.portId, frame]));
  const meta = JSON.parse(decoder.decode(outputs.get("iqc_meta").payload));
  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  return { response, records: recordCount(outputs.get("iqc_records").payload), provenance };
}

test("fixture premise: every capture document carries an archive identity", () => {
  assert.equal(META_DOCS.length, 16);
  for (const doc of META_DOCS) {
    assert.ok(doc.global?.["traceability:origin"]?.file_path, "a fixture row would be skipped");
  }
});

test("parse: no cap configured emits every document and reports nothing unread", async (t) => {
  const { response, records, provenance } = await parseWith(t, {});
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(records, META_DOCS.length);
  assert.equal(provenance.record_cap, 50000);
  assert.equal(provenance.rows_unread_record_cap, 0);
  assert.deepEqual(provenance.warnings, []);
});

test("parse: a cap written as a JSON number bounds the cycle", async (t) => {
  const { response, records, provenance } = await parseWith(t, { sigmf_record_cap: 5 });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(records, 5);
  assert.equal(provenance.normalized_count, 5);
  assert.equal(provenance.source_rows, META_DOCS.length);
  assert.equal(provenance.record_cap, 5);
  assert.equal(provenance.rows_unread_record_cap, META_DOCS.length - 5);
  assert.deepEqual(provenance.warnings, [
    `sigmf_record_cap 5 reached: ${META_DOCS.length - 5} of ${META_DOCS.length} capture documents not read`,
  ]);
});

test("parse: a cap written as a quoted string (the YAML shape host-02 used) is the same cap", async (t) => {
  const quoted = await parseWith(t, { sigmf_record_cap: "5" });
  assert.equal(quoted.response.statusCode, 0, quoted.response.errorMessage);
  assert.equal(quoted.records, 5);
  assert.equal(quoted.provenance.record_cap, 5);

  const padded = await parseWith(t, { sigmf_record_cap: " 5 " });
  assert.equal(padded.response.statusCode, 0, padded.response.errorMessage);
  assert.equal(padded.records, 5);
});

test("parse: a cap at or above the document count leaves nothing unread", async (t) => {
  const { response, records, provenance } = await parseWith(t, { sigmf_record_cap: String(META_DOCS.length) });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(records, META_DOCS.length);
  assert.equal(provenance.rows_unread_record_cap, 0);
});

test("parse: a malformed cap FAILS CLOSED instead of reading as the default", async (t) => {
  for (const bad of ["2k", "0", 0, -5, "-5", 2.5, "2.5", true, "", "1234567890"]) {
    const { response, records } = await parseWith(t, { sigmf_record_cap: bad });
    assert.notEqual(response.statusCode, 0, `sigmf_record_cap ${JSON.stringify(bad)} was accepted`);
    assert.equal(records, undefined, `sigmf_record_cap ${JSON.stringify(bad)} still emitted records`);
    assert.match(response.errorMessage ?? "", /sigmf_record_cap must be a positive integer/);
  }
});

test("request: the fetch timeout is honoured as a number or a quoted string", async (t) => {
  for (const [value, expected] of [[undefined, 300000], [120000, 120000], ["90000", 90000]]) {
    const harness = await harnessWithConfig(t, value === undefined ? {} : { sigmf_http_timeout_ms: value });
    const response = await harness.invoke({ methodId: "request", inputs: [jsonInput("tick", {})] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const request = JSON.parse(
      decoder.decode(response.outputs.find((frame) => frame.portId === "request").payload),
    );
    assert.equal(request.timeoutMs, expected);
  }
  const harness = await harnessWithConfig(t, { sigmf_http_timeout_ms: "5 minutes" });
  const refused = await harness.invoke({ methodId: "request", inputs: [jsonInput("tick", {})] });
  assert.notEqual(refused.statusCode, 0);
  assert.match(refused.errorMessage ?? "", /sigmf_http_timeout_ms must be a positive integer/);
});
