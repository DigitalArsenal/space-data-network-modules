// data-source/mlab-starlink-connectivity SDK-compat tests.
//
// The two pure flow nodes run in the SDK browser harness against a fixture cut
// from the LIVE M-Lab per-ASN statistics export (see fixtures/PROVENANCE.md),
// and their outputs are asserted against the Themis $CNP rulings:
//
//   1. A quantity exists only as a CNPMetric, and CNPMetric REQUIRES UNITS and
//      PROVENANCE. There is no encoding for a number without them.
//   2. CNPMetric has no scalar VALUE — a metric is a DISTRIBUTION of
//      CNPStatistic entries. Throughput carries six; minimum-RTT carries one.
//   3. Units are never silently converted: Mbps stays Mbps, ms stays ms.
//   4. Absent means unpublished, never zero: REGION is OMITTED, CLIENT_COUNT
//      is 0, AS_NAME is absent.
//   5. Licence rides per source: CC0-1.0, M-Lab's own citation,
//      NON_COMMERCIAL_ONLY false.
//   6. cnpMethod.MODELED never appears — every number here is measured.
//
// The FlatBuffer reader below is deliberately hand-rolled rather than a
// generated decoder: the point of these assertions is that the BYTES on the
// wire say what the standard says they should, so the test must not share a
// codepath with the builder under test.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const STATS_JSON = fs.readFileSync(
  new URL("./fixtures/mlab-asn14593-histogram_daily_stats.sample.json", import.meta.url),
);
const STATS_ROWS = JSON.parse(STATS_JSON.toString("utf8"));

const SOURCE_URL =
  "https://statistics.measurementlab.net/v0/asn/14593/2024/histogram_daily_stats.json";

const JOB = {
  source_url: SOURCE_URL,
  source_name: "mlab-ndt-statistics",
  archive_source: "mlab",
  archive_name: "histogram_daily_stats.json",
};

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function jsonInput(portId, value) {
  return {
    portId,
    // Control frames are variable-length UTF-8 JSON and ride the opaque
    // flatbuffer lane, exactly as the flow runtime does on an `opaque: true`
    // edge.
    typeRef: { wireFormat: "flatbuffer" },
    payload: encoder.encode(JSON.stringify(value)),
  };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  const map = new Map();
  for (const frame of response.outputs) map.set(frame.portId, frame);
  return map;
}

function jsonFrame(map, portId) {
  const frame = map.get(portId);
  assert.ok(frame, `missing output frame ${portId}`);
  return JSON.parse(decoder.decode(frame.payload));
}

function splitStream(payload) {
  const records = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let off = 0;
  while (off < payload.byteLength) {
    assert.ok(off + 4 <= payload.byteLength, "truncated size prefix");
    const len = view.getUint32(off, true);
    off += 4;
    assert.ok(len > 0 && off + len <= payload.byteLength, "invalid record length");
    records.push(payload.subarray(off, off + len));
    off += len;
  }
  return records;
}

function fileIdentifier(record) {
  return decoder.decode(record.subarray(4, 8));
}

function httpResponse(bodyBytes, headers = {}) {
  return { status: 200, headers, bodyB64: Buffer.from(bodyBytes).toString("base64") };
}

// ---------------------------------------------------------------------------
// Generic FlatBuffer table reader. Slot numbers below are the VT_* constants
// of the generated schema/CNP headers (field index i -> slot 4 + 2i).
// ---------------------------------------------------------------------------

function makeTable(bytes, dv, pos) {
  const vtableOff = pos - dv.getInt32(pos, true);
  const vtableLen = dv.getUint16(vtableOff, true);
  const offsetOf = (slot) => (slot >= vtableLen ? 0 : dv.getUint16(vtableOff + slot, true));
  const abs = (slot) => pos + offsetOf(slot);
  return {
    present: (slot) => offsetOf(slot) !== 0,
    str(slot) {
      if (!this.present(slot)) return null;
      const at = abs(slot);
      const strOff = at + dv.getUint32(at, true);
      const len = dv.getUint32(strOff, true);
      return decoder.decode(bytes.subarray(strOff + 4, strOff + 4 + len));
    },
    f64: (slot, fallback = 0) => (offsetOf(slot) ? dv.getFloat64(abs(slot), true) : fallback),
    i8: (slot, fallback = 0) => (offsetOf(slot) ? dv.getInt8(abs(slot)) : fallback),
    u32: (slot, fallback = 0) => (offsetOf(slot) ? dv.getUint32(abs(slot), true) : fallback),
    u64: (slot, fallback = 0n) =>
      offsetOf(slot) ? dv.getBigUint64(abs(slot), true) : BigInt(fallback),
    bool: (slot, fallback = false) => (offsetOf(slot) ? dv.getUint8(abs(slot)) !== 0 : fallback),
    table(slot) {
      if (!this.present(slot)) return null;
      const at = abs(slot);
      return makeTable(bytes, dv, at + dv.getUint32(at, true));
    },
    tableVector(slot) {
      if (!this.present(slot)) return null;
      const at = abs(slot);
      const vecOff = at + dv.getUint32(at, true);
      const len = dv.getUint32(vecOff, true);
      const out = [];
      for (let i = 0; i < len; i++) {
        const elem = vecOff + 4 + 4 * i;
        out.push(makeTable(bytes, dv, elem + dv.getUint32(elem, true)));
      }
      return out;
    },
  };
}

function rootTable(record) {
  const dv = new DataView(record.buffer, record.byteOffset, record.byteLength);
  return makeTable(record, dv, dv.getUint32(0, true));
}

const CNP = {
  ID: 4, CONSTELLATION: 6, OPERATOR: 8, ASN: 10, AS_NAME: 12, SERVICE_TIER: 14, REGION: 16,
  WINDOW_START: 18, WINDOW_STOP: 20, AGGREGATION_PERIOD: 22, METRICS: 24, SOURCES: 26,
  CREATED_AT: 28, UPDATED_AT: 30, SUPERSEDES_CNP_CID: 32,
};
const METRIC = {
  KIND: 4, SOURCE_METRIC_NAME: 6, UNITS: 8, STATISTICS: 10, SAMPLE_COUNT: 12, CLIENT_COUNT: 14,
  PROVENANCE: 16,
};
const STAT = { STATISTIC: 4, PERCENTILE_RANK: 6, VALUE: 8 };
const PROV = {
  SOURCE: 4, SOURCE_URL: 6, SOURCE_DATASET: 8, SOURCE_QUERY: 10, SOURCE_RECORD_ID: 12,
  SOURCE_SHA256: 14, RETRIEVED_AT: 16, METHOD: 18, MEASUREMENT_SERVER: 20, LICENSE: 22,
  LICENSE_URL: 24, ATTRIBUTION: 26, NON_COMMERCIAL_ONLY: 28,
};

const KIND = {
  DOWNLOAD_THROUGHPUT: 0, UPLOAD_THROUGHPUT: 1, LATENCY_IDLE: 2, LATENCY_LOADED_DOWNLOAD: 3,
  LATENCY_LOADED_UPLOAD: 4, JITTER: 5, PACKET_LOSS: 6, AVAILABILITY: 7, OBSTRUCTION: 8, RTT: 9,
  OTHER: 10,
};
const REDUCTION = {
  MEAN: 0, MEDIAN: 1, PERCENTILE: 2, MINIMUM: 3, MAXIMUM: 4, STANDARD_DEVIATION: 5, COUNT: 6,
};
const METHOD = {
  NDT7: 0, SPEED_TEST: 1, PING: 2, TRACEROUTE: 3, TERMINAL_TELEMETRY: 4, HTTP_DOWNLOAD: 5,
  PASSIVE: 6, MODELED: 7, OTHER: 8,
};
const PERIOD = { CUSTOM: 0, HOUR: 1, DAY: 2, WEEK: 3, MONTH: 4, QUARTER: 5, YEAR: 6 };

function readMetric(metric) {
  return {
    KIND: metric.i8(METRIC.KIND, KIND.OTHER),
    SOURCE_METRIC_NAME: metric.str(METRIC.SOURCE_METRIC_NAME),
    UNITS: metric.str(METRIC.UNITS),
    UNITS_PRESENT: metric.present(METRIC.UNITS),
    SAMPLE_COUNT: metric.u64(METRIC.SAMPLE_COUNT),
    CLIENT_COUNT: metric.u64(METRIC.CLIENT_COUNT),
    CLIENT_COUNT_PRESENT: metric.present(METRIC.CLIENT_COUNT),
    PROVENANCE_PRESENT: metric.present(METRIC.PROVENANCE),
    provenance: metric.table(METRIC.PROVENANCE),
    statistics: (metric.tableVector(METRIC.STATISTICS) ?? []).map((s) => ({
      STATISTIC: s.i8(STAT.STATISTIC, REDUCTION.MEAN),
      PERCENTILE_RANK: s.f64(STAT.PERCENTILE_RANK),
      PERCENTILE_RANK_PRESENT: s.present(STAT.PERCENTILE_RANK),
      VALUE: s.f64(STAT.VALUE),
    })),
  };
}

function readCnp(record) {
  const t = rootTable(record);
  return {
    ID: t.str(CNP.ID),
    CONSTELLATION: t.str(CNP.CONSTELLATION),
    OPERATOR: t.str(CNP.OPERATOR),
    ASN: t.u32(CNP.ASN),
    AS_NAME: t.str(CNP.AS_NAME),
    SERVICE_TIER: t.str(CNP.SERVICE_TIER),
    REGION_PRESENT: t.present(CNP.REGION),
    WINDOW_START: t.str(CNP.WINDOW_START),
    WINDOW_STOP: t.str(CNP.WINDOW_STOP),
    AGGREGATION_PERIOD: t.i8(CNP.AGGREGATION_PERIOD, PERIOD.CUSTOM),
    CREATED_AT: t.str(CNP.CREATED_AT),
    UPDATED_AT: t.str(CNP.UPDATED_AT),
    SUPERSEDES_CNP_CID: t.str(CNP.SUPERSEDES_CNP_CID),
    metrics: (t.tableVector(CNP.METRICS) ?? []).map(readMetric),
    sources: t.tableVector(CNP.SOURCES) ?? [],
  };
}

function readProvenance(p) {
  return {
    SOURCE: p.str(PROV.SOURCE),
    SOURCE_URL: p.str(PROV.SOURCE_URL),
    SOURCE_DATASET: p.str(PROV.SOURCE_DATASET),
    SOURCE_QUERY: p.str(PROV.SOURCE_QUERY),
    SOURCE_RECORD_ID: p.str(PROV.SOURCE_RECORD_ID),
    SOURCE_SHA256: p.str(PROV.SOURCE_SHA256),
    RETRIEVED_AT: p.str(PROV.RETRIEVED_AT),
    METHOD: p.i8(PROV.METHOD, METHOD.OTHER),
    MEASUREMENT_SERVER: p.str(PROV.MEASUREMENT_SERVER),
    LICENSE: p.str(PROV.LICENSE),
    LICENSE_URL: p.str(PROV.LICENSE_URL),
    ATTRIBUTION: p.str(PROV.ATTRIBUTION),
    NON_COMMERCIAL_ONLY: p.bool(PROV.NON_COMMERCIAL_ONLY),
  };
}

async function runParse(t, body, headers = {}, job = JOB) {
  const harness = await createHarness(t);
  return harness.invoke({
    methodId: "parse",
    inputs: [jsonInput("job", job), jsonInput("response", httpResponse(body, headers))],
  });
}

async function parsedRecords(t, body = STATS_JSON, headers = {}) {
  const response = await runParse(t, body, headers);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  return {
    response,
    outputs,
    records: splitStream(outputs.get("cnp_records").payload).map(readCnp),
    rawRecords: splitStream(outputs.get("cnp_records").payload),
  };
}

// The daily columns are constant across a date's eight bucket rows, so any of
// them is the expected value for that date.
function expectedDay(date) {
  const row = STATS_ROWS.find((r) => r.date === date);
  assert.ok(row, `fixture has no date ${date}`);
  return row;
}

const FIXTURE_DATES = [...new Set(STATS_ROWS.map((r) => r.date))];

// ---------------------------------------------------------------------------

test("mlab-starlink-connectivity artifact passes SDK compliance against the standards tree", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("is a pure node: canonical ABI, WASI-only imports besides the config bridge", async () => {
  const inspection = await inspectModule(readWasm());
  for (const required of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
  for (const name of new Set(inspection.imports.map((e) => e.module))) {
    assert.ok(
      name === "wasi_snapshot_preview1" || name === "space_data_module_host",
      `unexpected import module ${name}`,
    );
  }
});

test("manifest declares zero host capabilities (http + storage are the hostcap connectors)", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.capabilities, []);
  assert.equal(manifest.pluginFamily, "data_source");
  assert.deepEqual(manifest.methods.map((m) => m.methodId), ["request", "parse"]);
  assert.deepEqual(manifest.schemasUsed, [
    { schemaName: "CNP.fbs", fileIdentifier: "$CNP", rootTypeName: "CNP" },
  ]);
});

test("request: timer tick -> ONE whole-file anonymous fetch + attribution job", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({ methodId: "request", inputs: [jsonInput("tick", {})] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const request = jsonFrame(outputs, "request");
  assert.equal(request.method, "GET");
  // The default URL is the documented per-ASN statistics path for AS14593.
  assert.equal(request.url, SOURCE_URL);
  // NO BigQuery, no auth, no key: an anonymous HTTPS GET of a static artifact.
  assert.ok(!/bigquery/i.test(request.url), "must not reach for BigQuery");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers["x-api-key"], undefined);
  assert.match(request.headers["user-agent"], /^SDN-CatalogEnrichmentBot\/0\.1 \(\+https:\/\//);
  assert.equal(typeof request.timeoutMs, "number");

  const job = jsonFrame(outputs, "job");
  assert.equal(job.source_name, "mlab-ndt-statistics");
  assert.equal(job.source_url, SOURCE_URL);
  assert.equal(job.archive_source, "mlab");
  assert.ok(job.provider_id.length > 0);
});

test("parse: the eight bucket rows of a date collapse into ONE $CNP per day", async (t) => {
  const { records, outputs } = await parsedRecords(t);
  assert.equal(records.length, FIXTURE_DATES.length);
  assert.deepEqual(
    records.map((r) => r.WINDOW_START.slice(0, 10)),
    FIXTURE_DATES,
  );
  for (const record of splitStream(outputs.get("cnp_records").payload)) {
    assert.equal(fileIdentifier(record), "$CNP", "record carries the $CNP file identifier");
  }
  // Window is [start, stop): a UTC day.
  for (const r of records) {
    const start = Date.parse(r.WINDOW_START);
    const stop = Date.parse(r.WINDOW_STOP);
    assert.equal(stop - start, 86400000, `${r.ID} window is not exactly one day`);
    assert.equal(r.AGGREGATION_PERIOD, PERIOD.DAY);
    assert.match(r.WINDOW_START, /T00:00:00Z$/);
  }
});

test("parse: Starlink is the ASN key, and identity is never inferred from the numbers", async (t) => {
  const { records } = await parsedRecords(t);
  for (const r of records) {
    assert.equal(r.ASN, 14593, "AS14593 = SPACEX-STARLINK is the client-ASN filter");
    assert.equal(r.CONSTELLATION, "Starlink");
    assert.equal(r.OPERATOR, "SpaceX");
    // The export publishes the ASN number only: no AS name, no service tier.
    assert.equal(r.AS_NAME, null, "AS_NAME is not published by the source");
    assert.equal(r.SERVICE_TIER, null, "M-Lab does not separate service tiers");
    assert.equal(r.SUPERSEDES_CNP_CID, null);
    assert.equal(r.ID, `mlab:ndt:asn14593:${r.WINDOW_START.slice(0, 10)}`);
  }
});

test("parse: REGION is OMITTED — the per-ASN export carries no geographic key", async (t) => {
  const { records } = await parsedRecords(t);
  for (const r of records) {
    // Absent REGION means "the source did not key by geography", which is a
    // different fact from cnpRegionKind.GLOBAL. Writing GLOBAL here would
    // assert an aggregation the source never performed.
    assert.equal(r.REGION_PRESENT, false, `${r.ID} invented a REGION`);
  }
});

test("parse: every metric names its UNITS and carries PROVENANCE (Themis ruling 1)", async (t) => {
  const { records } = await parsedRecords(t);
  for (const r of records) {
    assert.ok(r.metrics.length > 0, `${r.ID} has no metrics`);
    for (const m of r.metrics) {
      assert.equal(m.UNITS_PRESENT, true, `${r.ID} metric ${m.KIND} has no UNITS`);
      assert.ok(m.UNITS.length > 0);
      assert.equal(m.PROVENANCE_PRESENT, true, `${r.ID} metric ${m.KIND} has no PROVENANCE`);
      const p = readProvenance(m.provenance);
      assert.equal(p.SOURCE, "M-Lab");
      assert.ok(p.SOURCE_DATASET.length > 0, "SOURCE_DATASET names the upstream view");
      // Replayable, not merely trusted: the query says exactly which request
      // and which columns produced these numbers.
      assert.ok(p.SOURCE_QUERY.startsWith(`GET ${SOURCE_URL}`));
      assert.match(p.SOURCE_QUERY, /row\(asn=14593,date=\d{4}-\d{2}-\d{2}\)/);
      assert.match(p.RETRIEVED_AT, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.equal(p.METHOD, METHOD.NDT7);
      assert.notEqual(p.METHOD, METHOD.MODELED, "a measurement is never MODELED");
      assert.ok(p.MEASUREMENT_SERVER.length > 0, "the vantage point is named");
      assert.equal(p.SOURCE_RECORD_ID, `asn=14593;date=${r.WINDOW_START.slice(0, 10)}`);
      assert.equal(p.SOURCE_SHA256, sha256Hex(STATS_JSON));
    }
  }
});

test("parse: a metric is a DISTRIBUTION, and the six throughput reductions are exact (rulings 2+3)", async (t) => {
  const { records } = await parsedRecords(t);
  for (const r of records) {
    const date = r.WINDOW_START.slice(0, 10);
    const row = expectedDay(date);
    const download = r.metrics.find((m) => m.KIND === KIND.DOWNLOAD_THROUGHPUT);
    const upload = r.metrics.find((m) => m.KIND === KIND.UPLOAD_THROUGHPUT);
    assert.ok(download && upload, `${r.ID} missing a throughput metric`);

    for (const [metric, prefix, samples] of [
      [download, "download", row.dl_samples_day],
      [upload, "upload", row.ul_samples_day],
    ]) {
      // Units verbatim from the upstream column a.MeanThroughputMbps.
      assert.equal(metric.UNITS, "Mbps");
      assert.equal(metric.statistics.length, 6, "six published reductions, no more, no fewer");
      const byReduction = new Map();
      for (const s of metric.statistics) {
        const key = s.STATISTIC === REDUCTION.PERCENTILE ? `P${s.PERCENTILE_RANK}` : s.STATISTIC;
        byReduction.set(key, s);
      }
      assert.equal(byReduction.get(REDUCTION.MINIMUM).VALUE, row[`${prefix}_MIN`]);
      assert.equal(byReduction.get("P25").VALUE, row[`${prefix}_Q25`]);
      assert.equal(byReduction.get(REDUCTION.MEDIAN).VALUE, row[`${prefix}_MED`]);
      assert.equal(byReduction.get(REDUCTION.MEAN).VALUE, row[`${prefix}_AVG`]);
      assert.equal(byReduction.get("P75").VALUE, row[`${prefix}_Q75`]);
      assert.equal(byReduction.get(REDUCTION.MAXIMUM).VALUE, row[`${prefix}_MAX`]);
      // PERCENTILE_RANK is "meaningless otherwise and MUST NOT be set".
      for (const s of metric.statistics) {
        if (s.STATISTIC !== REDUCTION.PERCENTILE) {
          assert.equal(s.PERCENTILE_RANK_PRESENT, false, "rank set on a non-percentile");
        }
      }
      assert.equal(metric.SAMPLE_COUNT, BigInt(samples));
      // CLIENT_COUNT: *_samples_day is one sampled test per client IP, and an
      // IP is not a terminal. 0 == the source published no client count.
      assert.equal(metric.CLIENT_COUNT_PRESENT, false);
      assert.equal(metric.CLIENT_COUNT, 0n);
    }
  }
});

test("parse: minimum-RTT is KIND RTT with exactly one MEDIAN, in ms", async (t) => {
  const { records } = await parsedRecords(t);
  for (const r of records) {
    const row = expectedDay(r.WINDOW_START.slice(0, 10));
    const rtts = r.metrics.filter((m) => m.KIND === KIND.RTT);
    assert.equal(rtts.length, 2, "one RTT metric per direction");
    const byName = new Map(rtts.map((m) => [m.SOURCE_METRIC_NAME, m]));
    for (const [name, expected] of [
      ["download_minRTT_MED", row.download_minRTT_MED],
      ["upload_minRTT_MED", row.upload_minRTT_MED],
    ]) {
      const metric = byName.get(name);
      assert.ok(metric, `missing RTT metric ${name}`);
      assert.equal(metric.UNITS, "ms");
      // A source publishing only a median emits exactly ONE entry, so no
      // consumer can mistake it for a mean.
      assert.equal(metric.statistics.length, 1);
      assert.equal(metric.statistics[0].STATISTIC, REDUCTION.MEDIAN);
      assert.equal(metric.statistics[0].VALUE, expected);
    }
    // MinRTT is the minimum RTT during a loaded test: it is neither the idle
    // latency nor the loaded latency this enum defines, so claiming either
    // would misstate it.
    assert.equal(r.metrics.some((m) => m.KIND === KIND.LATENCY_IDLE), false);
    assert.equal(r.metrics.some((m) => m.KIND === KIND.LATENCY_LOADED_DOWNLOAD), false);
  }
});

test("parse: the CC0 licence and M-Lab's own citation ride on every provenance", async (t) => {
  const { records } = await parsedRecords(t);
  for (const r of records) {
    const date = r.WINDOW_START.slice(0, 10);
    const provenances = [
      ...r.metrics.map((m) => readProvenance(m.provenance)),
      ...r.sources.map(readProvenance),
    ];
    assert.ok(provenances.length >= 5);
    for (const p of provenances) {
      assert.equal(p.LICENSE, "CC0-1.0");
      assert.equal(p.LICENSE_URL, "https://creativecommons.org/publicdomain/zero/1.0/");
      // M-Lab's documented citation shape, carrying this record's own range.
      assert.equal(
        p.ATTRIBUTION,
        `The M-Lab NDT Data Set ${date}–${date}. https://measurementlab.net/tests/ndt`,
      );
      // CC0 has no non-commercial restriction. (The flag exists per source so
      // a CC BY-NC cross-check can sit in the same record without infecting
      // this lane.)
      assert.equal(p.NON_COMMERCIAL_ONLY, false);
    }
  }
});

test("parse: SOURCES lists the provider consulted for the key", async (t) => {
  const { records } = await parsedRecords(t);
  for (const r of records) {
    assert.equal(r.sources.length, 1);
    const p = readProvenance(r.sources[0]);
    assert.equal(p.SOURCE, "M-Lab");
    assert.equal(p.SOURCE_QUERY, `GET ${SOURCE_URL}`);
    assert.equal(p.SOURCE_URL, SOURCE_URL);
  }
});

test("parse: ingest meta + batch provenance record what was NOT encoded", async (t) => {
  const { outputs, records } = await parsedRecords(t, STATS_JSON, {
    "last-modified": "Thu, 28 Mar 2024 03:00:45 GMT",
  });
  const meta = jsonFrame(outputs, "cnp_meta");
  assert.equal(meta.schema, "CNP.fbs");
  assert.equal(meta.source_name, "mlab-ndt-statistics");
  assert.equal(meta.batch_id, sha256Hex(STATS_JSON));
  assert.equal(meta.reconcile, "none");
  assert.deepEqual(meta.archive, { source: "mlab", name: "histogram_daily_stats.json" });

  const provenance = JSON.parse(Buffer.from(meta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.parser_version, "mlab-cnp-wasm/v1");
  assert.equal(provenance.source_sha256, sha256Hex(STATS_JSON));
  assert.equal(provenance.normalized_count, records.length);
  assert.equal(provenance.schema_counts["CNP.fbs"], records.length);
  assert.equal(provenance.license, "CC0-1.0");
  assert.equal(provenance.non_commercial_only, false);
  assert.deepEqual(provenance.units, { throughput: "Mbps", rtt: "ms" });
  // No silent unit conversion: source units and encoded units are identical.
  assert.deepEqual(provenance.source_units, provenance.units);
  assert.equal(provenance.bucket_rows, STATS_ROWS.length);
  assert.equal(provenance.days_in_payload, FIXTURE_DATES.length);
  // The histogram and the geometric means have no honest CNPStatistic
  // encoding, so they are named as dropped rather than silently lost.
  for (const column of [
    "bucket_min",
    "dl_frac_bucket",
    "dl_samples_bucket",
    "dl_LOG_AVG_rnd1",
    "ul_minRTT_LOG_AVG_rnd2",
  ]) {
    assert.ok(
      provenance.unencoded_source_columns.includes(column),
      `${column} must be declared unencoded`,
    );
  }

  // raw payload is the fetched bytes verbatim.
  assert.deepEqual(Buffer.from(outputs.get("raw").payload), Buffer.from(STATS_JSON));
});

test("parse: mlab_max_days keeps the most recent published days (sample, don't mirror)", async (t) => {
  // The fixture is small enough that the default 31-day window keeps all of
  // it; the windowing itself is exercised by a 2-day cap through CONFIG.
  // Node CONFIG arrives through the builtin plugin.getConfig hostcall, which
  // answers with the `{ok,result}` envelope the real host uses.
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    hostcallDispatch: (operation) =>
      operation === "plugin.getConfig" ? { mlab_max_days: 2 } : null,
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "parse",
    inputs: [jsonInput("job", JOB), jsonInput("response", httpResponse(STATS_JSON))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  const records = splitStream(outputs.get("cnp_records").payload).map(readCnp);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.WINDOW_START.slice(0, 10)),
    FIXTURE_DATES.slice(-2),
  );
  const provenance = JSON.parse(
    Buffer.from(jsonFrame(outputs, "cnp_meta").provenance.json, "base64").toString("utf8"),
  );
  assert.equal(provenance.days_in_payload, FIXTURE_DATES.length);
  assert.equal(provenance.days_dropped_by_window, FIXTURE_DATES.length - 2);
});

test("parse: a row whose value is null yields an ABSENT metric, never a zero", async (t) => {
  const body = Buffer.from(
    JSON.stringify([
      {
        asn: 14593,
        date: "2024-04-01",
        download_MIN: null,
        download_Q25: null,
        download_MED: null,
        download_AVG: null,
        download_Q75: null,
        download_MAX: null,
        download_minRTT_MED: null,
        dl_samples_day: 0,
        upload_MIN: 0.007,
        upload_Q25: 2.726,
        upload_MED: 5.199,
        upload_AVG: 5.432,
        upload_Q75: 7.521,
        upload_MAX: 23.401,
        upload_minRTT_MED: 36.256,
        ul_samples_day: 9281,
      },
    ]),
  );
  const response = await runParse(t, body);
  assert.equal(response.statusCode, 0, response.errorMessage);
  const records = splitStream(outputsByPort(response).get("cnp_records").payload).map(readCnp);
  assert.equal(records.length, 1);
  const kinds = records[0].metrics.map((m) => m.KIND);
  // The unpublished download distribution is ABSENT, not a metric full of 0s.
  assert.equal(kinds.includes(KIND.DOWNLOAD_THROUGHPUT), false);
  assert.equal(kinds.includes(KIND.UPLOAD_THROUGHPUT), true);
  const rtts = records[0].metrics.filter((m) => m.KIND === KIND.RTT);
  assert.deepEqual(rtts.map((m) => m.SOURCE_METRIC_NAME), ["upload_minRTT_MED"]);
});

test("parse: non-200 upstream fails closed (nothing emitted)", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse",
    inputs: [
      jsonInput("job", JOB),
      jsonInput("response", { status: 404, headers: {}, bodyB64: "" }),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.outputs.length, 0);
});

test("parse: an empty export fails closed rather than storing an empty batch", async (t) => {
  const response = await runParse(t, Buffer.from("[]"));
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.outputs.length, 0);
});
