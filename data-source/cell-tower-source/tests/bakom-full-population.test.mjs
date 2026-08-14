// The BAKOM lane against a CAPTURED SLICE OF THE REAL NATIONAL REGISTER.
//
// Why this file exists (graph: mod-cell-tower-bakom-decode-loss). A worldwide
// run reported ~364 Swiss sites out of a register that publishes 22,347, and
// the reported cause was a broken decoder: a "fragile" json_string(body,
// "features") extraction and an LV95 plausibility guard that silently dropped
// rows. Both were REFUTED by measurement against the live 27,273,745-byte
// asset (2026-08-14): the extraction returns 27,273,596 of those bytes, the
// splitter yields all 22,347 features, and the guard drops ZERO. The decoder
// was never the problem.
//
// The loss was three COMPOUNDING CAPS, each individually defensible and none
// of them visible in the answer:
//
//   1. route asked for `Range: bytes=0-2097151` — a 2 MiB prefix. For one
//      ordered national FeatureCollection a prefix is a GEOGRAPHIC crop.
//   2. parse stopped decoding at the per-provider row cap, min(LIMIT, 1000).
//   3. deconflict stopped writing records at LIMIT.
//
// At the live probe's LIMIT=400 those compose to ~364 sites after the 250 m
// geometric grouping — a number that looked like a decode bug and was not.
//
// So this suite pins the two things that actually matter and could regress:
// the anonymous lane still caps (and now SAYS it capped), and the ingest lane
// returns the whole population with an EXACT count. The fixture is a verbatim
// 1,200-feature prefix of the real asset, so "exact" is a real number from a
// real body, not a shape this test invented.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const sdkTestingEntry = fileURLToPath(
  new URL(import.meta.resolve("space-data-module-sdk/testing")),
);
const sdkRoot = path.resolve(path.dirname(sdkTestingEntry), "..", "..");
const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
const flatbuffers = sdkRequire("flatbuffers");
const { HttpRequest } = sdkRequire(
  path.join(sdkRoot, "src/generated/http/sdn/http/http-request.js"),
);

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The captured slice: gzipped only to keep 1.48 MB of verbatim upstream JSON
// out of the tree. The bytes inside are byte-identical to the live asset's
// prefix — see tests/fixtures/PROVENANCE.md.
const SLICE = zlib.gunzipSync(
  fs.readFileSync(
    fileURLToPath(new URL("./fixtures/bakom-mobile-sites.slice-1200.json.gz", import.meta.url)),
  ),
);
const SLICE_DOC = JSON.parse(SLICE.toString("utf8"));

// THE EXACT COUNT the acceptance criteria asks for, read from the captured
// body rather than hardcoded twice. 1,200 is deliberately ABOVE the 1,000-row
// anonymous cap: a fixture that fit under the cap could not tell a lifted cap
// from an unlifted one.
const SLICE_FEATURES = SLICE_DOC.features.length;

function jsonInput(portId, value) {
  return {
    portId,
    typeRef: { wireFormat: "flatbuffer" },
    payload: encoder.encode(JSON.stringify(value)),
  };
}

function htqRequest(body) {
  const b = new flatbuffers.Builder(1024);
  const methodOff = b.createString("POST");
  const pathOff = b.createString("/api/v1/cellular/aggregate");
  const queryOff = b.createString("");
  const bodyOff = HttpRequest.createBodyVector(b, encoder.encode(JSON.stringify(body)));
  HttpRequest.startHttpRequest(b);
  HttpRequest.addMethod(b, methodOff);
  HttpRequest.addPath(b, pathOff);
  HttpRequest.addQuery(b, queryOff);
  HttpRequest.addBody(b, bodyOff);
  HttpRequest.finishHttpRequestBuffer(b, HttpRequest.endHttpRequest(b));
  return { portId: "request", typeRef: { wireFormat: "flatbuffer" }, payload: b.asUint8Array() };
}

async function harnessFor(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

const byPort = (response) => {
  const map = new Map();
  for (const frame of response.outputs) map.set(frame.portId, frame);
  return map;
};
const framesFor = (response, portId) => response.outputs.filter((f) => f.portId === portId);
const jsonFrame = (map, portId) => {
  const frame = map.get(portId);
  assert.ok(frame, `missing output frame ${portId}`);
  return JSON.parse(decoder.decode(frame.payload));
};

function splitStream(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let off = 0;
  let count = 0;
  while (off < payload.byteLength) {
    assert.ok(off + 4 <= payload.byteLength, "truncated size prefix");
    const len = view.getUint32(off, true);
    off += 4;
    assert.ok(len > 0 && off + len <= payload.byteLength, "invalid record length");
    off += len;
    count += 1;
  }
  return count;
}

/** Drive route -> parse -> deconflict the way the scheduler does. */
async function runBakom(t, requestBody) {
  const harness = await harnessFor(t);
  const routedRaw = await harness.invoke({
    methodId: "route",
    inputs: [htqRequest({ PROVIDERS: ["bakom-mobile-sites"], METHOD: "CENTROID", ...requestBody })],
  });
  const routed = byPort(routedRaw);
  const job = jsonFrame(routed, "job");
  const descriptors = framesFor(routedRaw, "requests").map((f) =>
    JSON.parse(decoder.decode(f.payload)),
  );

  const responses = [jsonInput("responses", {
    status: 200,
    headers: {},
    bodyB64: Buffer.from(SLICE).toString("base64"),
  })];
  while (responses.length < descriptors.length) {
    responses.push(jsonInput("responses", { status: 0, headers: {}, bodyB64: "" }));
  }

  // parse accumulates across invocations and emits on the quiet tick.
  let parsed = byPort(
    await harness.invoke({ methodId: "parse", inputs: [jsonInput("job", job), ...responses] }),
  );
  for (let tick = 0; tick < 8 && !parsed.get("reports"); tick += 1) {
    parsed = byPort(await harness.invoke({ methodId: "parse", inputs: [] }));
  }
  const reports = jsonFrame(parsed, "reports");
  // Deconflict is fed the job PARSE forwards, not the one route built — parse
  // annotates it with `row_capped`, and feeding route's copy here would test a
  // wiring the flow does not have.
  const parsedJob = jsonFrame(parsed, "job");

  const merged = byPort(
    await harness.invoke({
      methodId: "deconflict",
      inputs: [jsonInput("job", parsedJob), jsonInput("reports", reports)],
    }),
  );
  const recordsFrame = merged.get("records");
  assert.ok(recordsFrame, "missing records frame");
  return {
    descriptors,
    reports,
    summary: jsonFrame(merged, "decision"),
    recordCount: splitStream(recordsFrame.payload),
  };
}

test("FULL_POPULATION decodes EVERY feature in the captured slice — exact count", async (t) => {
  const { reports } = await runBakom(t, { LIMIT: 2000, FULL_POPULATION: true });
  // The whole point of the task: not "more than before", not "about 1,200" —
  // exactly what the captured body carries.
  assert.equal(
    reports.length,
    SLICE_FEATURES,
    `decoded ${reports.length} of ${SLICE_FEATURES} captured features`,
  );
  assert.equal(SLICE_FEATURES, 1200, "the captured slice changed shape");
  assert.ok(reports.every((r) => r.provider_id === "bakom-mobile-sites"));
  // Still really Switzerland — a lifted cap must not come with a broken
  // transform, which would render just as confidently.
  for (const r of reports) {
    assert.ok(r.latitude > 45.7 && r.latitude < 47.9, `latitude ${r.latitude} is not Swiss`);
    assert.ok(r.longitude > 5.8 && r.longitude < 10.6, `longitude ${r.longitude} is not Swiss`);
  }
});

test("SINGLE_SOURCE + FULL_POPULATION emits one site per registered station", async (t) => {
  // The acceptance number, end to end. CENTROID and friends collapse masts
  // within 250 m, so their site count is legitimately BELOW the feature count;
  // SINGLE_SOURCE is the lane that does no grouping, and it is the only one
  // where "sites out" and "features in the register" are the same quantity.
  const { reports, recordCount, summary } = await runBakom(t, {
    LIMIT: 2000,
    METHOD: "SINGLE_SOURCE",
    FULL_POPULATION: true,
  });
  assert.equal(reports.length, SLICE_FEATURES);
  assert.equal(recordCount, SLICE_FEATURES, "a station was lost between decode and emit");
  assert.equal(summary.sitesOut, SLICE_FEATURES);
  assert.equal(summary.reportsIn, SLICE_FEATURES);
  assert.equal(summary.truncated, false);
});

test("FULL_POPULATION drops the Range prefix so the whole register is fetched", async (t) => {
  const { descriptors } = await runBakom(t, { LIMIT: 2000, FULL_POPULATION: true });
  assert.equal(descriptors.length, 1);
  assert.equal(
    descriptors[0].headers.range,
    undefined,
    "the ingest lane still asked for a 2 MiB prefix — it would crop the register by document order",
  );
  // The full 27 MB asset has pushed the buffered flow past Cloudflare's
  // response deadline at the anonymous 40 s budget (live 524 at 124 s).
  assert.equal(descriptors[0].timeoutMs, 300000);
});

test("the anonymous lane still caps — and now SAYS it capped", async (t) => {
  const { reports, summary, recordCount } = await runBakom(t, { LIMIT: 400 });
  // Cap 2: parse stops decoding at min(LIMIT, 1000).
  assert.equal(reports.length, 400, "the anonymous per-provider row cap stopped applying");
  assert.equal(recordCount, summary.sitesOut);
  assert.equal(summary.fullPopulation, false);
  // 400 of the slice's 1,200 features were decoded, so this answer is a crop
  // and must announce itself EVEN THOUGH the emit cap was never reached (the
  // 400 reports collapse to fewer than 400 sites at the 250 m tolerance).
  // Reporting only the emit cap is what let a row-capped run read as complete.
  assert.equal(summary.truncated, true, "a row-capped run did not report itself truncated");
  assert.ok(recordCount < 400, "expected the 250 m grouping to collapse some of the 400 reports");
});

test("a capped run is DISTINGUISHABLE from a complete one", async (t) => {
  // This is the actual defect class behind the whole task: for as long as the
  // caps were silent, "364 Swiss sites" and "Switzerland has 364 masts" were
  // the same response. LIMIT=50 against 1,200 features must announce itself.
  const capped = await runBakom(t, { LIMIT: 50 });
  assert.equal(capped.recordCount, 50);
  assert.equal(capped.summary.truncated, true, "a cropped answer did not say so");
  assert.equal(capped.summary.fullPopulation, false);

  const complete = await runBakom(t, { LIMIT: 2000, FULL_POPULATION: true });
  assert.equal(complete.summary.truncated, false);
  assert.equal(complete.summary.fullPopulation, true);
  // And the ingest lane really did emit more sites than the capped run.
  assert.ok(
    complete.recordCount > capped.recordCount,
    `ingest lane emitted ${complete.recordCount}, capped lane ${capped.recordCount}`,
  );
});

test("FULL_POPULATION is opt-in — it is never inferred from a large LIMIT", async (t) => {
  // A caller asking for a big LIMIT is still an anonymous caller. Lifting the
  // fetch bound on their behalf is how a node gets talked into pulling 27 MB
  // per request from a public asset.
  const { descriptors } = await runBakom(t, { LIMIT: 100000 });
  assert.equal(descriptors[0].headers.range, "bytes=0-2097151");
  assert.equal(descriptors[0].timeoutMs, 40000);
});

test("the 250 m grouping survives the population it now has to carry", async (t) => {
  // group_reports was O(n^2) over identity-less reports, and BAKOM publishes no
  // MCC/MNC/cell id, so every Swiss mast takes that path. That cost is WHY the
  // lane was capped at 1,000 rows, so the spatial-bucket rewrite is a
  // precondition of this task rather than an optimisation. Grouping must still
  // collapse co-located masts, and must not collapse the whole country.
  const { reports, recordCount } = await runBakom(t, { LIMIT: 2000, FULL_POPULATION: true });
  assert.equal(reports.length, SLICE_FEATURES);
  assert.ok(recordCount > 0, "grouping emitted nothing");
  assert.ok(
    recordCount < reports.length,
    "nothing collapsed — co-located masts within 250 m must group",
  );
  assert.ok(
    recordCount > reports.length / 2,
    `grouping collapsed ${reports.length} reports into only ${recordCount} sites`,
  );
});
