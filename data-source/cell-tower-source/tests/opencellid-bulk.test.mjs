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

import {
  byPort,
  decodeIrm,
  drainParse,
  harnessFor,
  joinStream,
  packIrm,
  reportsOf,
  responseFor,
  routeFor,
  sds,
  skippedOf,
} from "./helpers.mjs";

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

async function routeBulk(harness, requestBody = {}) {
  // A run with NO fetchable provider short-circuits: it answers on `decision`
  // and emits no HttpRequest. Either way the contract carries the skip ledger.
  return routeFor(harness, {
    PROVIDERS: ["opencellid-bulk"],
    METHOD: "SINGLE_SOURCE",
    LIMIT: 2000,
    FULL_POPULATION: true,
    CREDENTIAL_MEDIATOR: true,
    ...requestBody,
  });
}

/**
 * Feed one chunk of the gzip through parse as the HttpResponse to `descriptor`,
 * with `context` (default: the request's own CONTEXT) echoed. Returns the
 * reports and the resume mark parse wrote.
 */
async function parseChunk(harness, descriptor, chunk, context) {
  const parsed = await drainParse(harness, [responseFor(descriptor, { status: 206, body: chunk, context })]);
  const resume = parsed.get("resume");
  return { reports: reportsOf(parsed.get("reports").payload), resume: resume ? decodeIrm(resume.payload) : undefined, resumeBytes: resume?.payload };
}

// ── 1. the collapse ────────────────────────────────────────────────────────

test("the bulk gzip decodes to SITES, not cells", async (t) => {
  const harness = await harnessFor(t);
  const { descriptors } = await routeBulk(harness);
  const { reports } = await parseChunk(harness, descriptors[0], BULK_GZ);

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
  const { descriptors } = await routeBulk(harness);
  const { reports } = await parseChunk(harness, descriptors[0], BULK_GZ);

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
  // 32 KiB behind — so the decoder state has to cross the seam in the $IRM
  // resume mark. If it does not, this test does not throw an inflate error: it
  // returns fewer sites, or a site built from half a CSV row.
  const harness = await harnessFor(t);
  const I = sds.IRM;

  const split = 200; // mid-deflate-stream, deliberately not a block boundary
  assert.ok(split < BULK_GZ.length, "the fixture is too small to split");

  const { descriptors } = await routeBulk(harness);
  const chunk1 = await parseChunk(harness, descriptors[0], BULK_GZ.subarray(0, split));

  const mark = chunk1.resume;
  assert.ok(mark, "parse emitted no resume mark for an unfinished bulk download");
  assert.equal(mark.STATE, I.irmJobState.IN_PROGRESS, "an unfinished download reported itself complete");
  assert.equal(Number(mark.NEXT_OFFSET), split, "the resume mark did not advance to the seam");
  assert.equal(mark.PROVIDER_ID, "opencellid-bulk");
  const dc = mark.DECODE_CONTEXT;
  assert.ok(dc.DECODER_STATE.length > 0, "the resume mark carries no decoder state");
  assert.equal(Number(dc.DECODER_STATE_BYTE_LENGTH), dc.DECODER_STATE.length);
  assert.equal(dc.DECODER_STATE_FORMAT, "cell-tower-source/tinfl-v1");
  assert.equal(dc.DECODER_STATE_VERSION, "1");
  assert.equal(dc.WINDOW.length, 32768, "the 32 KiB dictionary did not cross the seam");
  assert.equal(Number(dc.WINDOW_BYTE_LENGTH), 32768);
  assert.ok(Number(dc.WINDOW_POSITION) < 32768);
  assert.equal(dc.COMPRESSION, "gzip");
  assert.equal(dc.FORMAT, "text/csv");

  // The next chunk continues THAT mark: its CONTEXT carries the run contract and
  // the $IRM, exactly as cell-tower-ingest's ingest_plan writes it.
  const context = joinStream([descriptors[0].ctx.aprBytes, chunk1.resumeBytes]);
  const chunk2 = await parseChunk(harness, descriptors[0], BULK_GZ.subarray(split), context);
  assert.equal(chunk2.resume.STATE, I.irmJobState.COMPLETE, "the second chunk did not finish");
  assert.equal(chunk2.resume.DECODE_CONTEXT.DECODER_STATE.length, 0, "a finished stream still carries a decoder");
  assert.equal(Number(chunk2.resume.LAST_CHUNK.RANGE_FIRST_BYTE), split, "the chunk was not recorded from the seam");

  // The two chunks together see every row and every site the whole file has.
  const total = chunk1.reports.length + chunk2.reports.length;
  assert.equal(total, BULK_SITES, `chunked decode found ${total} sites, whole-file decode finds ${BULK_SITES}`);
  assert.equal(
    chunk1.resume.LAST_CHUNK.RECORDS_DECODED + chunk2.resume.LAST_CHUNK.RECORDS_DECODED,
    BULK_ROWS,
    "the chunked run did not see every data row",
  );
});

test("a mark whose decoder stamps disagree RESTARTS rather than resuming into nonsense", async (t) => {
  // DECODER_STATE is an opaque memory image of ONE decoder build. A mark from a
  // different build — a different format token, version or byte length — is
  // refused before it is loaded: this chunk decodes nothing and writes no mark,
  // because inflating mid-symbol from a foreign struct would not fail loudly,
  // it would decode to plausible garbage that stores cleanly.
  const harness = await harnessFor(t);
  const split = 200;
  const { descriptors } = await routeBulk(harness);
  const chunk1 = await parseChunk(harness, descriptors[0], BULK_GZ.subarray(0, split));
  for (const tamper of [
    (m) => { m.DECODE_CONTEXT.DECODER_STATE_FORMAT = "some-other-producer/v9"; },
    (m) => { m.DECODE_CONTEXT.DECODER_STATE_VERSION = "2"; },
    (m) => { m.DECODE_CONTEXT.DECODER_STATE_BYTE_LENGTH = 7n; },
    (m) => { m.DECODE_CONTEXT.WINDOW = m.DECODE_CONTEXT.WINDOW.slice(1); },
  ]) {
    const mark = decodeIrm(chunk1.resumeBytes);
    tamper(mark);
    const context = joinStream([descriptors[0].ctx.aprBytes, packIrm(mark)]);
    const chunk2 = await parseChunk(harness, descriptors[0], BULK_GZ.subarray(split), context);
    assert.deepEqual(chunk2.reports, [], "a foreign decoder image was resumed");
    assert.equal(chunk2.resume, undefined, "a refused mark still advanced");
  }
});

// ── 3. the fail-closed wiring ──────────────────────────────────────────────

test("a credentialed provider is skipped unless the mediator is declared", async (t) => {
  // FAIL CLOSED ON THE WIRING. Emitting a descriptor that still carries
  // `{{credential}}` would spend the owner's daily quota on a request that
  // cannot succeed.
  const harness = await harnessFor(t);
  const { contract, descriptors } = await routeBulk(harness, { CREDENTIAL_MEDIATOR: false });
  assert.equal(descriptors.length, 0, "an unfillable credentialed descriptor was emitted");
  const mine = skippedOf(contract).find((s) => s.provider_id === "opencellid-bulk");
  assert.ok(mine, "the credentialed provider is not named in the skip list");
  // What is missing is the WIRING (the mediator), not a verified endpoint.
  assert.equal(mine.code, "needs-mediator");
});

test("a declared mediator gets a descriptor marked with the lane that fills it", async (t) => {
  const harness = await harnessFor(t);
  const { descriptors } = await routeBulk(harness);
  assert.equal(descriptors.length, 1);
  const d = descriptors[0];
  assert.equal(d.ctx.apr.params.credentialLane, "cell_opencellid-bulk");
  // The request-scoped lane reads the export's first 32 MiB window.
  assert.equal(d.headers.range, `bytes=0-${32 * 1024 * 1024 - 1}`);
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
  const { descriptors } = await routeBulk(harness);
  const { reports } = await parseChunk(
    harness,
    descriptors[0],
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
  const { descriptors } = await routeFor(harness, {
    PROVIDERS: ["openstreetmap-overpass"],
    BBOX: { south: 52.45, west: 13.3, north: 52.55, east: 13.45 },
    LIMIT: 999999,
  });
  assert.equal(descriptors.length > 0, true, "the bounded provider emitted no descriptor");
  for (const d of descriptors) {
    assert.ok(
      /out center 1000;/.test(decodeURIComponent(d.url)),
      `the anonymous per-provider row cap is not 1000 in ${d.url}`,
    );
  }
});
