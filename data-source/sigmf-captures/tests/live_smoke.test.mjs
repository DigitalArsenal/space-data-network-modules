// data-source/sigmf-captures LIVE smoke test.
//
// Proves the archive read surface this module is pointed at is REAL and
// ANONYMOUS today, that the payload URLs the records hand a consumer actually
// resolve, and that the compiled guest turns the archive's actual bytes into
// $IQC records. The fixture tests assert conformance; this one asserts that
// the premise is true now rather than when the module was written.
//
// SKIPPABLE WHEN OFFLINE: a DNS/connect failure skips instead of failing, and
// SDN_SKIP_LIVE=1 skips unconditionally.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { JOB, createHarness, metaOf, outputsByPort, responseFrame } from "./typed.mjs";

const BASE_URL = "https://www.iqengine.org";
const DATASOURCES_URL = `${BASE_URL}/api/datasources`;
const BULK_META_URL = `${BASE_URL}/api/datasources/local/local/meta`;

const decoder = new TextDecoder();
const TIMEOUT_MS = 180000;
// The full index is ~31 MB. Fetch it once and share it across the tests in
// this file rather than pulling it from a community-run service repeatedly.
let cachedIndex = null;

function offline(error) {
  const code = error?.cause?.code ?? error?.code ?? "";
  return (
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH"].includes(
      code,
    ) || error?.name === "AbortError"
  );
}

async function liveFetch(t, url, method = "GET") {
  if (process.env.SDN_SKIP_LIVE === "1") {
    t.skip("SDN_SKIP_LIVE=1");
    return null;
  }
  try {
    // NO credentials of any kind: the module only uses what works anonymously.
    return await fetch(url, {
      method,
      headers: {
        "user-agent":
          "SDN-CatalogEnrichmentBot/0.1 (+https://spacedatanetwork.org; contact tjkoury@gmail.com)",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (offline(error)) {
      t.skip(`offline: ${error?.cause?.code ?? error?.name ?? error}`);
      return null;
    }
    throw error;
  }
}

async function liveIndex(t) {
  if (cachedIndex) return cachedIndex;
  const response = await liveFetch(t, BULK_META_URL);
  if (!response) return null;
  assert.equal(response.status, 200, `${BULK_META_URL} -> ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  cachedIndex = { body, docs: JSON.parse(body.toString("utf8")) };
  return cachedIndex;
}

function splitStream(payload) {
  const records = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let off = 0;
  while (off < payload.byteLength) {
    const len = view.getUint32(off, true);
    off += 4;
    records.push(payload.subarray(off, off + len));
    off += len;
  }
  return records;
}

test("LIVE: IQEngine publishes a PUBLIC datasource to an anonymous caller", async (t) => {
  const response = await liveFetch(t, DATASOURCES_URL);
  if (!response) return;
  assert.equal(response.status, 200);
  const datasources = await response.json();
  assert.ok(Array.isArray(datasources) && datasources.length > 0);
  const publicSources = datasources.filter((d) => d.public === true);
  assert.ok(publicSources.length > 0, "no public datasource: the anonymous lane is gone");
  // The module's default account/container must still be one of them.
  assert.ok(
    publicSources.some((d) => d.account === "local" && d.container === "local"),
    `local/local is no longer public: ${JSON.stringify(publicSources.map((d) => [d.account, d.container]))}`,
  );
  console.log(
    `LIVE IQEngine datasources: ${datasources.length} (public: ` +
      `${publicSources.map((d) => `${d.account}/${d.container}`).join(", ")})`,
  );
});

test("LIVE: the bulk metadata index answers anonymously and is SigMF-shaped", async (t) => {
  const index = await liveIndex(t);
  if (!index) return;
  const { body, docs } = index;
  assert.ok(Array.isArray(docs) && docs.length > 0);
  assert.ok(body.length > 1_000_000, `suspiciously small index: ${body.length} bytes`);
  for (const doc of docs.slice(0, 50)) {
    assert.ok(doc.global, "document has no SigMF global object");
    assert.ok(doc.global["traceability:origin"]?.file_path, "document has no archive identity");
  }
  const licensed = docs.filter((d) => d.global["core:license"]).length;
  const geolocated = docs.filter((d) => d.global["core:geolocation"]).length;
  console.log(
    `LIVE IQEngine index: ${body.length} bytes, ${docs.length} documents, ` +
      `${licensed} licensed, ${geolocated} geolocated`,
  );
});

test("LIVE: the payload URLs an $IQC hands a consumer actually resolve", async (t) => {
  const index = await liveIndex(t);
  if (!index) return;
  const doc = index.docs.find((d) => d.global["traceability:origin"]?.file_path === "pulsed_ASK");
  assert.ok(doc, "the reference recording pulsed_ASK is gone from the archive");

  // Exactly the URL shape the module writes into IQCPayloadRef.
  const metaUrl = `${BASE_URL}/api/datasources/local/local/pulsed_ASK.sigmf-meta`;
  const metaResponse = await liveFetch(t, metaUrl);
  if (!metaResponse) return;
  assert.equal(metaResponse.status, 200, `${metaUrl} -> ${metaResponse.status}`);
  const sigmf = await metaResponse.json();
  assert.equal(sigmf.global["core:datatype"], doc.global["core:datatype"]);

  // The DATA payload is 200 MB; a HEAD confirms the URL resolves without
  // pulling the samples this record deliberately refuses to mirror.
  const dataUrl = `${BASE_URL}/api/datasources/local/local/pulsed_ASK.sigmf-data`;
  const dataResponse = await liveFetch(t, dataUrl, "HEAD");
  if (!dataResponse) return;
  assert.equal(dataResponse.status, 200, `${dataUrl} -> ${dataResponse.status}`);
  console.log(`LIVE IQEngine payload URLs: ${metaUrl} 200, ${dataUrl} 200 (HEAD)`);
});

test("LIVE: the compiled guest turns the real index into $IQC records", async (t) => {
  const index = await liveIndex(t);
  if (!index) return;
  const { body, docs } = index;

  // The whole index; the module's default cap is headroom above it.
  const harness = await createHarness(t, { sigmf_record_cap: 50000 });
  const invoked = await harness.invoke({
    methodId: "parse",
    inputs: [
      responseFrame({
        body,
        headers: { "content-type": "application/json" },
        job: { ...JOB, sourceUrl: BULK_META_URL },
      }),
    ],
  });
  assert.equal(invoked.statusCode, 0, invoked.errorMessage);
  const outputs = outputsByPort(invoked);
  const records = splitStream(outputs.get("iqc_records").payload);
  assert.ok(records.length > 0);
  for (const record of records.slice(0, 100)) {
    assert.equal(decoder.decode(record.subarray(4, 8)), "$IQC");
  }
  const meta = metaOf(outputs);
  assert.equal(meta.provenance.normalizedCount, records.length);
  const skipped = meta.provenance.warnings.map((w) => w.match(/^capture documents skipped, no archive identity: (\d+) of (\d+)$/)).find(Boolean);
  assert.equal(records.length + (skipped ? Number(skipped[1]) : 0), docs.length);
  if (skipped) assert.equal(Number(skipped[2]), docs.length);
  console.log(
    `LIVE IQEngine -> $IQC: ${records.length} records from ${docs.length} documents ` +
      `(warnings: ${meta.provenance.warnings.join("; ") || "none"}), batch ${meta.tags.batchId.slice(0, 12)}…`,
  );
});
