// The OpenCelliD BULK lane: gzip in, SITES out, resumable across byte ranges.
//
// graph: mod-cell-tower-opencellid-bulk. Three things are under test and each
// one has a specific way of failing silently, which is why every assertion here
// is an EXACT count or an exact value rather than a "more than zero":
//
//   1. THE COLLAPSE. The export is ~40 million CELLS and the task refuses to
//      store them (~57 GB). A collapse that half-works still emits plausible
//      towers at plausible places — just too many of them, one per sector. Only
//      an exact site count distinguishes "collapsed" from "nearly collapsed".
//
//   2. THE RESUME. A gzip stream has no restart point, so a chunked download
//      must carry the inflate state across the seam. A resume that drops the
//      state does not error: it produces a shorter answer, or half a CSV row
//      parsed as a whole one. The test therefore asserts that two chunks give
//      byte-identical results to one.
//
//   3. THE FAIL-CLOSED WIRING. A descriptor whose `{{credential}}` is never
//      substituted gets fetched verbatim, and OpenCelliD answers 200 with
//      `{"status":"error","message":"INVALID_TOKEN"}` — a request that spends
//      the owner's daily quota to produce zero rows, reported as an empty
//      register.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
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

const BULK_GZ = fs.readFileSync(
  fileURLToPath(new URL("./fixtures/opencellid-bulk.slice.csv.gz", import.meta.url)),
);

// THE EXACT POPULATION OF THE FIXTURE — see tests/fixtures/PROVENANCE.md for
// the row-by-row construction. 16 data rows, one of which is out of range and
// is DROPPED (never clamped), leaving 15 cells that collapse to SIX sites:
//
//   A  52.520,13.405 LTE 262/1   4 cells (3 sectors + 1 inside the same
//                                1e-3 grid cell at 52.52004)
//   B  52.520,13.405 LTE 262/2   2 cells — same mast, second OPERATOR
//   C  52.520,13.405 UMTS 262/1  2 cells — same mast, second RADIO
//   D  52.521,13.405 LTE 262/1   1 cell  — 111 m away, a different grid cell
//   E  48.857,2.352  LTE 208/1   4 cells
//   F  40.713,-74.006 NR 310/260 2 cells
//
// A decoder that did not collapse would answer 15. One that collapsed on
// position alone would answer 4, merging two operators and two radios into one
// tower each. Both are plausible numbers; only 6 is the right one.
const BULK_SITES = 6;
const BULK_ROWS = 15;

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

async function routeBulk(harness, requestBody = {}) {
  const routedRaw = await harness.invoke({
    methodId: "route",
    inputs: [
      htqRequest({
        PROVIDERS: ["opencellid-bulk"],
        METHOD: "SINGLE_SOURCE",
        LIMIT: 2000,
        FULL_POPULATION: true,
        CREDENTIAL_MEDIATOR: true,
        ...requestBody,
      }),
    ],
  });
  // A run with NO fetchable provider short-circuits: it emits `reply` and no
  // `job`, because starting a pipeline that cannot complete is worse than
  // answering. Both frames carry `skipped`, which is what these tests read.
  const routed = byPort(routedRaw);
  const carrier = routed.has("job") ? "job" : "reply";
  return {
    job: jsonFrame(routed, carrier),
    shortCircuited: carrier === "reply",
    descriptors: framesFor(routedRaw, "requests").map((f) =>
      JSON.parse(decoder.decode(f.payload)),
    ),
  };
}

/** Feed one chunk of the gzip through parse and return {reports, job}. */
async function parseChunk(harness, job, chunk) {
  let parsed = byPort(
    await harness.invoke({
      methodId: "parse",
      inputs: [
        jsonInput("job", job),
        jsonInput("responses", {
          status: 200,
          headers: {},
          bodyB64: Buffer.from(chunk).toString("base64"),
        }),
      ],
    }),
  );
  for (let tick = 0; tick < 8 && !parsed.get("reports"); tick += 1) {
    parsed = byPort(await harness.invoke({ methodId: "parse", inputs: [] }));
  }
  return { reports: jsonFrame(parsed, "reports"), job: jsonFrame(parsed, "job") };
}

// ── 1. the collapse ────────────────────────────────────────────────────────

test("the bulk gzip decodes to SITES, not cells", async (t) => {
  const harness = await harnessFor(t);
  const { job } = await routeBulk(harness);
  const { reports } = await parseChunk(harness, job, BULK_GZ);

  assert.equal(
    reports.length,
    BULK_SITES,
    `expected ${BULK_SITES} collapsed sites, got ${reports.length}`,
  );

  // Every report is attributed to the bulk provider, never to the row-query
  // sibling that shares its authority and licence.
  for (const r of reports) assert.equal(r.provider_id, "opencellid-bulk");

  // The out-of-range row is DROPPED, not clamped to 90.
  assert.equal(
    reports.some((r) => r.latitude > 90 || r.latitude < -90),
    false,
    "an out-of-range coordinate survived the range guard",
  );

  // Two operators on one mast stay two sites, with their own identities.
  const berlin = reports.filter(
    (r) => Math.round(r.latitude * 1000) === 52520 && Math.round(r.longitude * 1000) === 13405,
  );
  assert.equal(berlin.length, 3, "the Berlin mast did not split by operator and radio");
  assert.deepEqual(
    berlin.map((r) => `${r.mcc}/${r.mnc}/${r.radio}`).sort(),
    ["262/1/2", "262/1/3", "262/2/3"].sort(),
    "the Berlin mast's three sites do not carry three distinct identities",
  );
});

test("a collapsed site SUMS its cells' samples and takes the WIDEST range", async (t) => {
  // The winner within a site is the highest-sample cell, which is the same rule
  // HIGHEST_SAMPLE_COUNT would apply — so collapsing here cannot select a
  // different tower than deconfliction would have. But `samples` is the mast's
  // total, because the mast really was observed that many times, and `range` is
  // the union of the sectors' footprints, never the narrowest.
  const harness = await harnessFor(t);
  const { job } = await routeBulk(harness);
  const { reports } = await parseChunk(harness, job, BULK_GZ);

  const paris = reports.find((r) => Math.round(r.latitude * 1000) === 48857);
  assert.ok(paris, "the Paris site is missing");
  assert.equal(paris.samples, 60 + 70 + 65 + 90, "samples were not summed across the site");

  const berlinA = reports.find(
    (r) => Math.round(r.latitude * 1000) === 52520 && r.mnc === 1 && r.radio === 3,
  );
  assert.ok(berlinA, "the Berlin LTE 262/1 site is missing");
  assert.equal(berlinA.samples, 50 + 80 + 20 + 10, "samples were not summed across the site");
  assert.equal(berlinA.range_m, 1200, "the site did not take the widest cell's range");
  // The highest-sample cell (80 samples, cell 10002) is the one that names it.
  assert.equal(berlinA.cell_id, "10002", "the site is not named by its best-sampled cell");
});

// ── 2. the resume ──────────────────────────────────────────────────────────

test("a chunked download resumes across the byte seam with identical results", async (t) => {
  // THE POINT OF THE WHOLE MECHANISM. A raw deflate stream cannot be restarted
  // at an arbitrary offset — there is no sync point and back-references reach
  // 32 KiB behind — so the decoder state has to cross the seam in the job. If
  // it does not, this test does not throw an inflate error: it returns fewer
  // sites, or a site built from half a CSV row.
  const harness = await harnessFor(t);

  const split = 200; // mid-deflate-stream, deliberately not a block boundary
  assert.ok(split < BULK_GZ.length, "the fixture is too small to split");

  const first = await routeBulk(harness);
  const chunk1 = await parseChunk(harness, first.job, BULK_GZ.subarray(0, split));

  const mark = chunk1.job.bulk_resume_next;
  assert.ok(mark, "parse emitted no resume mark for an unfinished bulk download");
  assert.equal(mark.complete, false, "an unfinished download reported itself complete");
  assert.equal(mark.header_done, true, "the gzip header was not consumed");
  assert.ok(mark.decoder && mark.decoder.length > 0, "the resume mark carries no decoder state");
  assert.equal(mark.next_byte, split, "the resume mark did not advance to the seam");

  // The second range is requested from exactly where the first stopped.
  const second = await routeBulk(harness, { BULK_RESUME: mark });
  assert.equal(second.descriptors.length, 1, "the resumed run emitted no descriptor");
  assert.equal(
    second.descriptors[0].headers.range,
    `bytes=${split}-${split + 32 * 1024 * 1024 - 1}`,
    "the resumed descriptor did not ask for the next window",
  );

  const chunk2 = await parseChunk(harness, second.job, BULK_GZ.subarray(split));
  assert.equal(chunk2.job.bulk_resume_next.complete, true, "the second chunk did not finish");

  // The two chunks together see every row and every site the whole file has.
  const total = chunk1.reports.length + chunk2.reports.length;
  assert.equal(
    total,
    BULK_SITES,
    `chunked decode found ${total} sites, whole-file decode finds ${BULK_SITES}`,
  );
  assert.equal(
    chunk2.job.bulk_resume_next.rows_seen,
    BULK_ROWS,
    "the chunked run did not see every data row",
  );
  assert.equal(chunk2.job.bulk_resume_next.sites_emitted, BULK_SITES);
});

test("a finished bulk download is not fetched again", async (t) => {
  // Without this the chunk sequence never terminates: a range past the end of
  // the file is answered 416 with no body, i.e. a provider that fetches forever
  // and contributes nothing.
  const harness = await harnessFor(t);
  const { job, descriptors } = await routeBulk(harness, {
    BULK_RESUME: { next_byte: BULK_GZ.length, complete: true },
  });
  assert.equal(descriptors.length, 0, "a completed bulk download was requested again");
  const mine = (job.skipped ?? []).find((s) => s.provider_id === "opencellid-bulk");
  assert.ok(mine, "the completed provider is not named in the skip list");
  assert.equal(mine.bulkComplete, true);
});

// ── 3. the fail-closed wiring ──────────────────────────────────────────────

test("a credentialed provider is skipped unless the mediator is declared", async (t) => {
  // FAIL CLOSED ON THE WIRING. Emitting a descriptor that still carries
  // `{{credential}}` would spend the owner's daily quota on a request that
  // cannot succeed.
  const harness = await harnessFor(t);
  const { job, descriptors } = await routeBulk(harness, { CREDENTIAL_MEDIATOR: false });
  assert.equal(descriptors.length, 0, "an unfillable credentialed descriptor was emitted");
  const mine = (job.skipped ?? []).find((s) => s.provider_id === "opencellid-bulk");
  assert.ok(mine, "the credentialed provider is not named in the skip list");
  assert.equal(mine.needsMediator, true);
  assert.equal(mine.credentialLane, "cell_opencellid-bulk");
  // The stale reason this task was filed against must be gone: the endpoint IS
  // verified and a credential IS stored; what is missing is the wiring.
  assert.equal(
    /not verified against a live account/.test(mine.reason),
    false,
    "route still claims the endpoint is unverified",
  );
});

test("a declared mediator gets a descriptor marked with the lane that fills it", async (t) => {
  const harness = await harnessFor(t);
  const { descriptors } = await routeBulk(harness);
  assert.equal(descriptors.length, 1);
  const d = descriptors[0];
  assert.equal(d.credentialLane, "cell_opencellid-bulk");
  assert.ok(
    d.url.includes("{{credential}}"),
    "route substituted a credential it does not hold",
  );
  assert.ok(
    d.url.startsWith("https://opencellid.org/ocid/downloads?"),
    `the bulk lane points at ${d.url}, not the verified download route`,
  );
});

test("a 200 that is really a token error decodes to nothing, not to an empty register", async (t) => {
  // VERIFIED LIVE 2026-08-14: a bad token answers **200** with
  // `{"status":"error","message":"INVALID_TOKEN"}`. The HTTP status carries no
  // signal, so if the body reached the gzip decoder an expired credential would
  // be indistinguishable from a register with nothing in it.
  const harness = await harnessFor(t);
  const { job } = await routeBulk(harness);
  const { reports } = await parseChunk(
    harness,
    job,
    Buffer.from('{"status":"error","message":"INVALID_TOKEN"}'),
  );
  assert.deepEqual(reports, [], "a provider error envelope was decoded as register data");
});

// ── the clamp that must NOT move ───────────────────────────────────────────

test("the anonymous 1000-row clamp is untouched by the bulk lane", async (t) => {
  // The bulk lane is credentialed and opt-in. It must not become a way for an
  // ANONYMOUS caller to make the node fetch and merge without bound — the cap
  // this file has carried since the Houston-box defect.
  const harness = await harnessFor(t);
  const routedRaw = await harness.invoke({
    methodId: "route",
    inputs: [
      htqRequest({
        PROVIDERS: ["openstreetmap-overpass"],
        BBOX: { south: 52.45, west: 13.3, north: 52.55, east: 13.45 },
        LIMIT: 999999,
      }),
    ],
  });
  const descriptors = framesFor(routedRaw, "requests").map((f) =>
    JSON.parse(decoder.decode(f.payload)),
  );
  assert.equal(descriptors.length > 0, true, "the bounded provider emitted no descriptor");
  for (const d of descriptors) {
    assert.ok(
      /out center 1000;/.test(decodeURIComponent(d.url)),
      `the anonymous per-provider row cap is not 1000 in ${d.url}`,
    );
  }
});
