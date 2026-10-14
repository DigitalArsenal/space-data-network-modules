// data-source/sigmf-captures: node CONFIG integers are honoured as written.
//
// The node serves its YAML config block verbatim through plugin.getConfig, so
// `sigmf_record_cap: "2000"` reaches the guest as a STRING ModuleConfig entry (the
// typed $PIV answer keeps the YAML's own kind). host-02 staged
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
import fs from "node:fs";
import test from "node:test";

import { createHarness, decodeJob, metaOf, outputsByPort, requestOf, responseFrame, tick } from "./typed.mjs";

const META_JSON = fs.readFileSync(new URL("./fixtures/iqengine-meta.sample.json", import.meta.url));
const META_DOCS = JSON.parse(META_JSON.toString("utf8"));

function recordCount(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let count = 0;
  for (let off = 0; off < payload.byteLength; count += 1) {
    off += 4 + view.getUint32(off, true);
  }
  return count;
}

async function parseWith(t, config) {
  const harness = await createHarness(t, config);
  const response = await harness.invoke({
    methodId: "parse",
    inputs: [responseFrame({ body: META_JSON, headers: { "content-type": "application/json" } })],
  });
  if (response.statusCode !== 0) return { response };
  const outputs = outputsByPort(response);
  const provenance = metaOf(outputs).provenance;
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
  assert.equal(provenance.normalizedCount, META_DOCS.length);
  // The fixture's transposed position is the one warning; nothing is left unread.
  assert.deepEqual(provenance.warnings, ["geolocation refused, outside WGS-84 range: 1"]);
});

test("parse: a cap written as a JSON number bounds the cycle", async (t) => {
  const { response, records, provenance } = await parseWith(t, { sigmf_record_cap: 5 });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(records, 5);
  assert.equal(provenance.normalizedCount, 5);
  assert.deepEqual(provenance.warnings.filter((w) => w.startsWith("sigmf_record_cap")), [
    `sigmf_record_cap 5 reached: ${META_DOCS.length - 5} of ${META_DOCS.length} capture documents not read`,
  ]);
});

test("parse: a cap written as a quoted string (the YAML shape host-02 used) is the same cap", async (t) => {
  const quoted = await parseWith(t, { sigmf_record_cap: "5" });
  assert.equal(quoted.response.statusCode, 0, quoted.response.errorMessage);
  assert.equal(quoted.records, 5);
  assert.equal(quoted.provenance.normalizedCount, 5);

  const padded = await parseWith(t, { sigmf_record_cap: " 5 " });
  assert.equal(padded.response.statusCode, 0, padded.response.errorMessage);
  assert.equal(padded.records, 5);
});

test("parse: a cap at or above the document count leaves nothing unread", async (t) => {
  const { response, records, provenance } = await parseWith(t, { sigmf_record_cap: String(META_DOCS.length) });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(records, META_DOCS.length);
  assert.equal(provenance.warnings.some((w) => w.startsWith("sigmf_record_cap")), false);
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
    const harness = await createHarness(t, value === undefined ? {} : { sigmf_http_timeout_ms: value });
    const response = await harness.invoke({ methodId: "request", inputs: [tick()] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const request = requestOf(outputsByPort(response));
    assert.equal(request.timeoutMs, expected);
    assert.equal(decodeJob(request.context).schema, "IQC.fbs");
  }
  const harness = await createHarness(t, { sigmf_http_timeout_ms: "5 minutes" });
  const refused = await harness.invoke({ methodId: "request", inputs: [tick()] });
  assert.notEqual(refused.statusCode, 0);
  assert.match(refused.errorMessage ?? "", /sigmf_http_timeout_ms must be a positive integer/);
});
