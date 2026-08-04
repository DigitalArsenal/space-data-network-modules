// data-source/mlab-starlink-connectivity LIVE smoke test.
//
// Proves the endpoint this module is pointed at is REAL, ANONYMOUS and still
// answering, and that the compiled guest turns its actual bytes into $CNP
// records. The fixture tests assert conformance; this one assets that the
// premise (the source exists and is reachable without credentials) is true
// today rather than true when the module was written.
//
// SKIPPABLE WHEN OFFLINE: a DNS/connect failure skips instead of failing, and
// SDN_SKIP_LIVE=1 skips unconditionally.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

// The module's own default target: per-ASN statistics for AS14593 (Starlink).
const LIVE_URL =
  "https://statistics.measurementlab.net/v0/asn/14593/2024/histogram_daily_stats.json";
// The public bucket the front door serves from, listed to prove the freshness
// claim in fixtures/PROVENANCE.md rather than restating it.
const LIVE_BUCKET_LIST =
  "https://storage.googleapis.com/storage/v1/b/statistics-mlab-oti/o" +
  "?prefix=v0/asn/14593/&maxResults=50";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TIMEOUT_MS = 60000;

function offline(error) {
  const code = error?.cause?.code ?? error?.code ?? "";
  return (
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH"].includes(
      code,
    ) || error?.name === "AbortError"
  );
}

async function liveFetch(t, url) {
  if (process.env.SDN_SKIP_LIVE === "1") {
    t.skip("SDN_SKIP_LIVE=1");
    return null;
  }
  try {
    // NO credentials of any kind: the whole point is that this source is open.
    return await fetch(url, {
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

function jsonInput(portId, value) {
  return {
    portId,
    typeRef: { wireFormat: "flatbuffer" },
    payload: encoder.encode(JSON.stringify(value)),
  };
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

test("LIVE: the M-Lab per-ASN statistics export answers an anonymous HTTPS GET", async (t) => {
  const response = await liveFetch(t, LIVE_URL);
  if (!response) return;
  assert.equal(response.status, 200, `${LIVE_URL} -> ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  assert.ok(body.length > 10000, `suspiciously small body: ${body.length} bytes`);
  const rows = JSON.parse(body.toString("utf8"));
  assert.ok(Array.isArray(rows) && rows.length > 0);
  for (const column of [
    "asn",
    "date",
    "download_MIN",
    "download_Q25",
    "download_MED",
    "download_AVG",
    "download_Q75",
    "download_MAX",
    "download_minRTT_MED",
    "dl_samples_day",
    "upload_MED",
    "upload_minRTT_MED",
    "ul_samples_day",
  ]) {
    assert.ok(column in rows[0], `live export lost the ${column} column`);
  }
  assert.equal(rows[0].asn, 14593, "AS14593 is the Starlink client ASN key");
  const dates = [...new Set(rows.map((r) => r.date))];
  console.log(
    `LIVE M-Lab: ${body.length} bytes, ${rows.length} rows, ${dates.length} dates ` +
      `(${dates[0]} .. ${dates[dates.length - 1]})`,
  );
});

test("LIVE: the statistics pipeline's published years are what the module assumes", async (t) => {
  const response = await liveFetch(t, LIVE_BUCKET_LIST);
  if (!response) return;
  assert.equal(response.status, 200);
  const listing = await response.json();
  const items = listing.items ?? [];
  assert.ok(items.length > 0, "the per-ASN prefix lists no objects");
  const years = items.map((i) => i.name.split("/")[3]).sort();
  const newest = items
    .map((i) => i.updated)
    .sort()
    .at(-1);
  console.log(`LIVE M-Lab bucket: years ${years.join(",")} — newest write ${newest}`);
  // The module's default year must be one the pipeline actually published.
  assert.ok(years.includes("2024"), `default mlab_year 2024 is not published; years=${years}`);
});

test("LIVE: the compiled guest turns the real bytes into $CNP records", async (t) => {
  const response = await liveFetch(t, LIVE_URL);
  if (!response) return;
  assert.equal(response.status, 200);
  const body = Buffer.from(await response.arrayBuffer());
  const rows = JSON.parse(body.toString("utf8"));
  const dates = [...new Set(rows.map((r) => r.date))];

  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    // 0 = every published day, so the count is checkable against the source.
    hostcallDispatch: (operation) =>
      operation === "plugin.getConfig" ? { mlab_max_days: 0, mlab_record_cap: 5000 } : null,
  });
  t.after(() => harness.destroy());

  const invoked = await harness.invoke({
    methodId: "parse",
    inputs: [
      jsonInput("job", {
        source_url: LIVE_URL,
        source_name: "mlab-ndt-statistics",
        archive_source: "mlab",
        archive_name: "histogram_daily_stats.json",
      }),
      jsonInput("response", {
        status: 200,
        headers: { "content-type": "application/json" },
        bodyB64: body.toString("base64"),
      }),
    ],
  });
  assert.equal(invoked.statusCode, 0, invoked.errorMessage);
  const outputs = new Map(invoked.outputs.map((f) => [f.portId, f]));
  const records = splitStream(outputs.get("cnp_records").payload);
  assert.equal(records.length, dates.length, "one $CNP per published day");
  for (const record of records) {
    assert.equal(decoder.decode(record.subarray(4, 8)), "$CNP");
  }
  const meta = JSON.parse(decoder.decode(outputs.get("cnp_meta").payload));
  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.normalized_count, records.length);
  assert.equal(provenance.bucket_rows, rows.length);
  assert.equal(provenance.license, "CC0-1.0");
  console.log(
    `LIVE M-Lab -> $CNP: ${records.length} records from ${rows.length} rows, ` +
      `batch ${meta.batch_id.slice(0, 12)}…`,
  );
});
