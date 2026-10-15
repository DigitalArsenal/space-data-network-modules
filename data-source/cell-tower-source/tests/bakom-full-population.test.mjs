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
import fs from "node:fs";
import test from "node:test";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { deconflict, drainParse, failedFetch, harnessFor, reportsOf, responseFor, routeFor } from "./helpers.mjs";

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

/** Drive route -> parse -> deconflict the way the scheduler does. */
async function runBakom(t, requestBody) {
  const harness = await harnessFor(t);
  const { descriptors } = await routeFor(harness, { PROVIDERS: ["bakom-mobile-sites"], METHOD: "CENTROID", ...requestBody });
  const responses = descriptors.map((d, i) => (i === 0 ? responseFor(d, { body: SLICE }) : failedFetch(d)));
  // parse accumulates across invocations and emits once the fan-in is in.
  const parsed = await drainParse(harness, responses);
  const reports = reportsOf(parsed.get("reports").payload);
  // Deconflict is fed the contract PARSE passes on, not the one route built —
  // parse adds x-sdn-row-capped, and feeding route's copy here would test a
  // wiring the flow does not have.
  const merged = await deconflict(harness, parsed);
  return { descriptors, reports, summary: merged.summary, recordCount: merged.records.length };
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
