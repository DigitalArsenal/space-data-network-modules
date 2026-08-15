// data-source/geonames-ingest SDK-compat tests: the four orchestration nodes
// turn a daily timer tick into a flatsql query, a set of fetch descriptors, a
// storage attribution frame and an advanced resume mark — with runner defaults
// and node-CONFIG overrides through the builtin plugin.getConfig hostcall.
//
// Every assertion is a computable outcome of the SCHEDULE: which lane a tick
// runs, which URLs it asks for, what the Range and If-None-Match headers say,
// and under exactly which conditions the mark advances.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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

const BASE = "https://download.geonames.org/export/dump/";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));

function frame(portId, payload) {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
}
const jsonFrame = (portId, value) => frame(portId, JSON.stringify(value));
const tickInput = (firedAt = "2026-08-15T00:00:00Z") => jsonFrame("tick", { firedAt });

function createConfigStub(config = {}) {
  const calls = [];
  const dispatch = (operation) => {
    calls.push(operation);
    if (operation === "plugin.getConfig") return config;
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { calls, dispatch };
}

async function createHarness(t, stub) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const map = new Map();
  for (const out of response.outputs) {
    // The records port carries a FlatBuffer stream, not JSON; it is asserted on
    // by its own test, so it is kept here as raw bytes rather than parsed.
    try {
      map.set(out.portId, JSON.parse(decoder.decode(out.payload)));
    } catch {
      map.set(out.portId, Buffer.from(out.payload));
    }
  }
  return map;
}

// A $GNP record stream is opaque to this plugin — it forwards the bytes
// untouched — so any non-empty size-prefixed buffer serves.
function recordsFrame(count = 2) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const body = Buffer.alloc(24);
    body.write("....$GNP", 0, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length, 0);
    parts.push(len, body);
  }
  const bytes = Buffer.concat(parts);
  return {
    portId: "records",
    typeRef: {
      wireFormat: "flatbuffer",
      schemaName: "GNP.fbs",
      fileIdentifier: "$GNP",
      rootTypeName: "GNP",
      requiredAlignment: 8,
      byteLength: bytes.length,
    },
    payload: Uint8Array.from(bytes),
  };
}

// ---------------------------------------------------------------------------
// artifact
// ---------------------------------------------------------------------------

test("geonames-ingest artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("geonames-ingest imports only WASI + the sync hostcall bridge", async () => {
  const inspection = await inspectModule(readWasm());
  const modules = Array.from(new Set(inspection.imports.map((e) => e.module))).sort();
  assert.deepEqual(modules, ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("the manifest declares capabilities [] and both runtime targets", () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.capabilities, []);
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.equal(manifest.pluginId, "com.digitalarsenal.data-source.geonames-ingest");
});

test("the guest-link metadata declares single-thread", () => {
  const metadata = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../dist/guest-link/metadata.json", import.meta.url)), "utf8"),
  );
  assert.equal(metadata.threadModel, "single-thread");
});

// ---------------------------------------------------------------------------
// mark_query
// ---------------------------------------------------------------------------

test("mark_query emits {sql,params}, which is the only shape flatsql-query executes", async (t) => {
  const stub = createConfigStub();
  const harness = await createHarness(t, stub);
  const query = outputsByPort(await harness.invoke({ methodId: "mark_query", inputs: [tickInput()] })).get("query");
  // hostcap/flatsql-query::query reads `sql` and returns 400 missing-sql for
  // anything else, so a {table,where} frame could never have executed.
  assert.match(query.sql, /^SELECT \* FROM geonames_ingest_mark WHERE dataset_id = \? LIMIT 1$/);
  assert.deepEqual(query.params, [{ t: "str", v: "geonames" }]);
  assert.deepEqual(stub.calls, ["plugin.getConfig"]);
});

test("mark_query keys the mark on the CONFIGURED dataset", async (t) => {
  const harness = await createHarness(t, createConfigStub({ geonames_dataset_id: "geonames-full" }));
  const query = outputsByPort(await harness.invoke({ methodId: "mark_query", inputs: [tickInput()] })).get("query");
  assert.deepEqual(query.params, [{ t: "str", v: "geonames-full" }]);
});

// ---------------------------------------------------------------------------
// ingest_plan — the schedule
// ---------------------------------------------------------------------------

test("the FIRST tick (no mark) runs the SEED: the archive plus all three lookup files", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] }));

  assert.equal(outputs.get("request").url, `${BASE}cities15000.zip`);
  assert.equal(outputs.get("request").method, "GET");
  assert.equal(outputs.get("request_admin1").url, `${BASE}admin1CodesASCII.txt`);
  assert.equal(outputs.get("request_admin2").url, `${BASE}admin2Codes.txt`);
  assert.equal(outputs.get("request_country").url, `${BASE}countryInfo.txt`);
  // A seed edition IS the gazetteer's current state; there is nothing to
  // tombstone, so no deletes fetch is planned.
  assert.equal(outputs.get("request_deletes"), undefined);

  const job = outputs.get("job");
  assert.equal(job.lane, "seed");
  assert.equal(job.container, "zip");
  assert.equal(job.member, "cities15000.txt");
  assert.equal(job.dataset_epoch, "2026-08-15T00:00:00.000Z", "the epoch is the TICK's date");
  assert.equal(job.license, "CC BY 4.0");
  assert.equal(job.attribution, "GeoNames (CC BY 4.0)");
  assert.equal(job.license_url, "https://creativecommons.org/licenses/by/4.0/");
});

test("the seed fetch is RANGED under the host's 4 MiB response-body cap", async (t) => {
  // A larger ask is truncated by the Go host and inflates to a plausible short
  // gazetteer with no error anywhere, so the guest never makes it.
  const harness = await createHarness(t, createConfigStub());
  const request = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] })).get("request");
  assert.equal(request.headers.Range, `bytes=0-${4 * 1024 * 1024 - 1}`);
});

test("a configured seed budget above the host cap is CLAMPED, not honoured", async (t) => {
  const harness = await createHarness(t, createConfigStub({ geonames_seed_max_bytes: 64 * 1024 * 1024 }));
  const request = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] })).get("request");
  assert.equal(request.headers.Range, `bytes=0-${4 * 1024 * 1024 - 1}`);
});

test("a SEEDED mark makes the tick a DELTA for the tick's own UTC day", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "ingest_plan",
      inputs: [
        tickInput("2026-08-15T03:17:00Z"),
        jsonFrame("mark", { dataset_id: "geonames", seeded: true, delta_date: "2026-08-14" }),
      ],
    }),
  );
  assert.equal(outputs.get("request").url, `${BASE}modifications-2026-08-15.txt`);
  assert.equal(outputs.get("request_deletes").url, `${BASE}deletes-2026-08-15.txt`);
  // The lookup tables change on the gazetteer's own slow cadence, not daily.
  assert.equal(outputs.get("request_admin1"), undefined);
  const job = outputs.get("job");
  assert.equal(job.lane, "delta");
  assert.equal(job.container, "plain", "the daily files are served uncompressed");
  assert.equal(job.delta_date, "2026-08-15");
});

test("a tick for a day already on the mark is a LEDGERED NO-OP: no fetch at all", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const response = await harness.invoke({
    methodId: "ingest_plan",
    inputs: [
      tickInput("2026-08-15T00:00:00Z"),
      jsonFrame("mark", { dataset_id: "geonames", seeded: true, delta_date: "2026-08-15" }),
    ],
  });
  assert.equal(response.statusCode, 0, "a day already ingested is not an error");
  assert.equal(response.outputs.length, 0, "nothing is requested, so the run ends here");
});

test("the mark's ETag rides out as If-None-Match, so an unchanged file costs one request", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "ingest_plan",
      inputs: [
        tickInput("2026-08-15T00:00:00Z"),
        jsonFrame("mark", {
          dataset_id: "geonames",
          seeded: true,
          delta_date: "2026-08-14",
          etag: '"76b6-6590c8be06ef0"',
        }),
      ],
    }),
  );
  assert.equal(outputs.get("request").headers["If-None-Match"], '"76b6-6590c8be06ef0"');
});

test("a mark for a DIFFERENT dataset is ignored, never resumed from", async (t) => {
  // Resuming dataset A from dataset B's date would skip A's seed entirely and
  // never report it.
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "ingest_plan",
      inputs: [
        tickInput(),
        jsonFrame("mark", { dataset_id: "somewhere-else", seeded: true, delta_date: "2026-08-15" }),
      ],
    }),
  );
  assert.equal(outputs.get("job").lane, "seed", "an unrelated mark cannot suppress the seed");
});

test("ingest_plan honours node-CONFIG base URL, edition and timeout", async (t) => {
  const harness = await createHarness(
    t,
    createConfigStub({
      geonames_base_url: "https://fixtures.test/dump/",
      geonames_seed_dataset: "cities500",
      geonames_http_timeout_ms: 5000,
    }),
  );
  const outputs = outputsByPort(await harness.invoke({ methodId: "ingest_plan", inputs: [tickInput()] }));
  assert.equal(outputs.get("request").url, "https://fixtures.test/dump/cities500.zip");
  assert.equal(outputs.get("request").timeoutMs, 5000);
  assert.equal(outputs.get("job").member, "cities500.txt");
});

test("ingest_plan refuses a tick it cannot date", async (t) => {
  // $GNP.SOURCE.DATASET_EPOCH is required on every record and is the EDITION
  // boundary; an epoch guessed in-guest would make two editions falsely
  // comparable.
  const harness = await createHarness(t, createConfigStub());
  const response = await harness.invoke({ methodId: "ingest_plan", inputs: [jsonFrame("tick", {})] });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "missing-tick-date");
});

// ---------------------------------------------------------------------------
// ingest_meta
// ---------------------------------------------------------------------------

const SEED_JOB = {
  lane: "seed",
  dataset_id: "geonames",
  dataset_epoch: "2026-08-15T00:00:00.000Z",
  source_url: `${BASE}cities15000.zip`,
  delta_date: "2026-08-15",
  seed_max_bytes: 4 * 1024 * 1024,
};

test("ingest_meta authors $GNP attribution, append reconcile and one batch per edition", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "ingest_meta",
      inputs: [
        jsonFrame("job", SEED_JOB),
        recordsFrame(),
        jsonFrame("decision", { recordsOut: 2 }),
        jsonFrame("response", {
          status: 206,
          headers: {
            "content-range": "bytes 0-4194303/3306445",
            etag: '"3273cd-6590c8be06b08"',
            "last-modified": "Sat, 15 Aug 2026 02:18:01 GMT",
          },
        }),
      ],
    }),
  );
  const meta = outputs.get("meta");
  assert.equal(meta.schema, "GNP");
  assert.equal(meta.provider_id, "geonames");
  assert.equal(meta.source_name, "geonames-gazetteer");
  // NOT a source-batch reconcile: a daily modifications file is an upsert of a
  // few thousand rows, and reconciling on it would delete the rest of the world.
  assert.equal(meta.reconcile, "append");
  assert.equal(meta.batch_id, "geonames@2026-08-15");
  assert.equal(meta.records_in, 2);
  // The three facts only the RESPONSE carries.
  assert.equal(meta.total_bytes, 3306445, "the total is Content-Range's DENOMINATOR");
  assert.equal(meta.etag, '"3273cd-6590c8be06b08"');
  assert.equal(meta.last_modified, "Sat, 15 Aug 2026 02:18:01 GMT");
});

test("ingest_meta forwards the record stream untouched", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const records = recordsFrame(3);
  const response = await harness.invoke({
    methodId: "ingest_meta",
    inputs: [jsonFrame("job", SEED_JOB), records],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const out = response.outputs.find((o) => o.portId === "records");
  assert.deepEqual(Buffer.from(out.payload), Buffer.from(records.payload));
});

test("ingest_meta REFUSES a seed the host could only have truncated", async (t) => {
  // The bytes in hand are a PREFIX of the archive. Decoding a prefix would
  // report a gazetteer that is merely missing places.
  const harness = await createHarness(t, createConfigStub());
  const response = await harness.invoke({
    methodId: "ingest_meta",
    inputs: [
      jsonFrame("job", SEED_JOB),
      recordsFrame(),
      jsonFrame("response", { status: 206, headers: { "content-range": "bytes 0-4194303/12000000" } }),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "seed-exceeds-host-body-cap");
  assert.equal(response.outputs.length, 0, "nothing reaches storage");
});

test("ingest_meta needs the dataset identity storage cannot invent", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  for (const missing of ["dataset_id", "dataset_epoch", "source_url"]) {
    const job = { ...SEED_JOB };
    delete job[missing];
    const response = await harness.invoke({
      methodId: "ingest_meta",
      inputs: [jsonFrame("job", job), recordsFrame()],
    });
    assert.equal(response.errorCode, "incomplete-job-attribution", missing);
  }
});

// ---------------------------------------------------------------------------
// publish_request — the mark advance and the epoch announce
// ---------------------------------------------------------------------------

const META = {
  schema: "GNP",
  provider_id: "geonames",
  source_name: "geonames-gazetteer",
  dataset_id: "geonames",
  dataset_epoch: "2026-08-15T00:00:00.000Z",
  lane: "delta",
  delta_date: "2026-08-15",
  batch_id: "geonames@2026-08-15",
  etag: '"76b6-6590c8be06ef0"',
  last_modified: "Sat, 15 Aug 2026 02:18:01 GMT",
  records_in: 12,
};
const RESULT = { schema: "GNP", inserted: 12, batch_id: "geonames@2026-08-15" };
const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";

test("publish_request advances the mark AND ledgers the ETag from the storage result", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [jsonFrame("result", RESULT), jsonFrame("meta", META)],
    }),
  );
  const mark = outputs.get("mark");
  assert.equal(mark.dataset_id, "geonames");
  assert.equal(mark.seeded, true);
  assert.equal(mark.delta_date, "2026-08-15");
  assert.equal(mark.dataset_epoch, "2026-08-15T00:00:00.000Z");
  assert.equal(mark.etag, '"76b6-6590c8be06ef0"', "the mark IS the same-data ledger");
  assert.equal(mark.last_modified, "Sat, 15 Aug 2026 02:18:01 GMT");
  assert.equal(mark.records, 12);
});

test("a SEED result marks the dataset seeded, so the next tick is a delta", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [
        jsonFrame("result", { ...RESULT, inserted: 26000 }),
        jsonFrame("meta", { ...META, lane: "seed", records_in: 26000 }),
      ],
    }),
  );
  assert.equal(outputs.get("mark").seeded, true);
  assert.equal(outputs.get("mark").lane, "seed");
});

test("SILENT NOP: ok-with-inserted-0 advances NOTHING — not the mark, not the ETag", async (t) => {
  // hostcap/storage-ingest already errors on ok:false (the disk-floor refusal).
  // What survives that check is ok:true with inserted=0, byte-identical to a day
  // on which the gazetteer changed nothing. Ledgering the ETag there would be
  // the worse half: every later tick would no-op against places never stored.
  const harness = await createHarness(t, createConfigStub());
  const response = await harness.invoke({
    methodId: "publish_request",
    inputs: [jsonFrame("result", { ...RESULT, inserted: 0 }), jsonFrame("meta", META)],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "ingest-stored-nothing");
  assert.equal(response.outputs.length, 0, "no mark, so the next tick re-fetches this day");
});

test("a genuinely empty edition still advances the mark", async (t) => {
  // inserted=0 with records_in=0 is a real day on which nothing changed, and it
  // must make progress or the lane stalls on the first quiet day.
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [
        jsonFrame("result", { ...RESULT, inserted: 0 }),
        jsonFrame("meta", { ...META, records_in: 0 }),
      ],
    }),
  );
  assert.equal(outputs.get("mark").delta_date, "2026-08-15");
});

test("the epoch announce is fail-closed without a configured URL", async (t) => {
  const harness = await createHarness(t, createConfigStub());
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [jsonFrame("result", RESULT), jsonFrame("meta", META)],
    }),
  );
  assert.equal(outputs.get("request"), undefined, "absence of config is not permission to publish");
  assert.ok(outputs.get("mark"), "but the mark is NOT gated on publication");
});

test("the epoch announce POSTs the batch identity through the normal publication path", async (t) => {
  // No new record type is minted: DATASET_EPOCH and DATASET_CID already ride in
  // $GNP.SOURCE on every stored record.
  const harness = await createHarness(t, createConfigStub({ geonames_publish_url: PUBLISH_URL }));
  const outputs = outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [jsonFrame("result", RESULT), jsonFrame("meta", META)],
    }),
  );
  const request = outputs.get("request");
  assert.equal(request.method, "POST");
  assert.equal(request.url, PUBLISH_URL);
  assert.equal(request.headers["content-type"], "application/json");
  const body = JSON.parse(Buffer.from(request.bodyB64, "base64").toString("utf8"));
  // DatasetPublicationRequest decodes with DisallowUnknownFields: these four
  // camelCase keys and nothing else.
  assert.deepEqual(Object.keys(body).sort(), ["batchId", "providerId", "schema", "sourceName"]);
  assert.deepEqual(body, {
    schema: "GNP",
    providerId: "geonames",
    sourceName: "geonames-gazetteer",
    batchId: "geonames@2026-08-15",
  });
});

test("publish_request requires BOTH the result and the meta frame", async (t) => {
  // Both ports are declared required, so the SDK harness refuses the invocation
  // before the guest is entered — which is the contract working, not a gap. The
  // guest's own missing-result-frame / missing-meta-frame refusals stand behind
  // it for the composed flow runtime, which does not pre-validate.
  const harness = await createHarness(t, createConfigStub());
  for (const inputs of [[jsonFrame("result", RESULT)], [jsonFrame("meta", META)]]) {
    const response = await harness.invoke({ methodId: "publish_request", inputs });
    assert.notEqual(response.statusCode, 0);
    assert.equal(response.errorCode, "missing-required-input");
    assert.equal(response.outputs.length, 0, "nothing is announced from half an identity");
  }
});
