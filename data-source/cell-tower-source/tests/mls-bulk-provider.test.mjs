// The MLS worldwide bulk lane, and the silence that hid it.
//
// graph: sdn-cellular-ingest-lands-no-batch. host-02 ran
// com.digitalarsenal.flows.cellular-network-ingest three times against the
// Mozilla Location Service final full cell export. Each run fetched exactly
// 3,145,728 B (206, 883 ms, in the node's own fetch ledger), took ~177 s, and
// ended "run completed but landed no batch" with no other trace anywhere.
//
// The cause was one line: the flow config named an MLS provider this module's
// registry had no entry for, and `parse` answered an unresolvable provider id
// with `continue` — a clean return, an empty `reports` list, and a run that
// reported success while storing nothing.
//
// Two things are therefore under test, and neither can be satisfied by a
// "more than zero" assertion:
//
//   1. `mls` DECODES, and decodes as ITSELF. The MLS export is byte-identical
//      in shape to the OpenCelliD bulk export, so the risk is not that it fails
//      to parse — it is that it parses under the wrong provider's name, putting
//      a CC BY-SA licence and an authority that never asserted these rows onto
//      stored records.
//
//   2. AN UNKNOWN PROVIDER ID IS LOUD. The whole defect was a configuration
//      fault that read as success. A run contract naming a provider this build
//      does not have must refuse, and must name what it does have.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Buffer } from "node:buffer";

import { byPort, drainParse, harnessFor, ingestContext, reportsOf, responseFor, sds } from "./helpers.mjs";

const BULK_GZ = fs.readFileSync(
  fileURLToPath(new URL("./fixtures/opencellid-bulk.slice.csv.gz", import.meta.url)),
);

// The same fixture the OpenCelliD bulk lane asserts against: 16 data rows, one
// out of range and dropped, 15 cells collapsing to SIX sites. The MLS export
// carries the identical column contract
// (radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,
// updated,averageSignal — verified against the live file 2026-08-26), so the
// same bytes must produce the same six sites under the MLS name.
const BULK_SITES = 6;

const MLS_URL = "https://archive.org/download/MLS_Full_Cell_Export_Final/MLS-full-cell-export-final.csv.gz";

// The CONTEXT cell-tower-ingest's `ingest_plan` writes, verbatim in shape: the
// ingest run contract (one provider, full population, one fetch) and the $IRM
// the chunk continues (here chunk 0: nothing to resume).
async function parseChunk(harness, providerId) {
  let parsed = await harness.invoke({
    methodId: "parse",
    inputs: [
      responseFor(
        { url: MLS_URL, context: ingestContext(providerId, { sourceUrl: MLS_URL }) },
        { status: 206, headers: { "content-range": `bytes 0-${BULK_GZ.length - 1}/1565271921` }, body: BULK_GZ },
      ),
    ],
  });
  let ports = byPort(parsed);
  // A REFUSAL is final, so stop on it: ticking past it would replace the answer
  // under test with a later invocation's quiet answer.
  for (let tick = 0; tick < 8 && !ports.get("reports") && parsed.statusCode === 0; tick += 1) {
    parsed = await harness.invoke({ methodId: "parse", inputs: [] });
    ports = byPort(parsed);
  }
  return { response: parsed, ports };
}

test("the MLS bulk export decodes to sites under the MLS name", async (t) => {
  const harness = await harnessFor(t);
  const { ports } = await parseChunk(harness, "mls-archive");

  const frame = ports.get("reports");
  assert.ok(frame, "parse emitted no reports frame for provider mls");
  const reports = reportsOf(frame.payload);

  assert.equal(
    reports.length,
    BULK_SITES,
    `expected ${BULK_SITES} collapsed sites from the MLS lane, got ${reports.length}`,
  );
  // ATTRIBUTION, not merely a count. A decoder shared with OpenCelliD must not
  // export Mozilla's rows under OpenCelliD's authority and licence.
  for (const report of reports) {
    assert.equal(
      report.provider_id,
      "mls-archive",
      "an MLS row was attributed to another provider",
    );
  }
});

test("a run contract naming an unknown provider REFUSES instead of reporting an empty register", async (t) => {
  const harness = await harnessFor(t);
  // `mls-typo` is the shape of the real defect: a plausible id that no build
  // answers to. Before this refusal existed the run below returned 0 with an
  // empty reports list, which is indistinguishable from a source that had
  // nothing to say.
  const { response, ports } = await parseChunk(harness, "mls-typo");

  const reports = ports.get("reports");
  assert.equal(
    reports === undefined,
    true,
    "an unknown provider still produced a reports frame — the silent-empty path is back",
  );
  assert.equal(
    response.statusCode,
    400,
    "an unknown provider did not refuse with 400; a configuration fault must never read as a clean run",
  );
  assert.equal(response.errorCode, "unknown-provider", "the refusal carries the wrong error code");
  const message = String(response.errorMessage ?? "");
  assert.match(
    message,
    /mls-typo/,
    `the refusal does not name the offending provider id: ${message}`,
  );
  // Naming what the build DOES have is the difference between a refusal an
  // operator can act on and one they have to go read the source for.
  assert.match(
    message,
    /opencellid-bulk/,
    `the refusal does not name what this build DOES have: ${message}`,
  );
  assert.match(message, /mls-archive/, `the refusal does not list the real MLS provider: ${message}`);
});

// THE CSV HEADER RIDES THE $IRM. In a ranged CSV export the column header
// exists once, at offset 0; a chunk N>0 is headerless, and without the header
// the decoder eats its first data row as a column contract and reports a clean
// empty tail. cell-tower-ingest carries it in IRMDecodeContext.HEADER_LINE.
const CSV = fs.readFileSync(fileURLToPath(new URL("./fixtures/opencellid.sample.csv", import.meta.url)), "utf8");
const [CSV_HEADER, ...CSV_ROWS] = CSV.trimEnd().split("\n");

async function csvChunk(harness, irm) {
  const url = "https://example.invalid/opencellid.csv";
  const body = Buffer.from(CSV_ROWS.join("\n") + "\n");
  const parsed = await drainParse(harness, [
    responseFor({ url, context: ingestContext("opencellid", { sourceUrl: url, irm }) }, { status: 206, body }),
  ]);
  return { reports: reportsOf(parsed.get("reports").payload), resume: parsed.get("resume") };
}

test("a headerless CSV chunk decodes with the header its $IRM carries", async (t) => {
  const harness = await harnessFor(t);
  const DecodeContext = sds.IRM.IRMDecodeContextT;
  const withHeader = await csvChunk(harness, {
    NEXT_OFFSET: BigInt(CSV_HEADER.length + 1),
    DECODE_CONTEXT: Object.assign(new DecodeContext(), { FORMAT: "text/csv", HEADER_LINE: CSV_HEADER }),
  });
  assert.equal(withHeader.reports.length, CSV_ROWS.length, "every data row of the resumed chunk decodes");
  assert.ok(withHeader.reports.every((r) => r.provider_id === "opencellid"));
  // A plain CSV lane runs no stateful decoder, so parse writes no resume mark:
  // the ingest node corrects the offset to a row boundary itself.
  assert.equal(withHeader.resume, undefined);

  const withoutHeader = await csvChunk(harness, { NEXT_OFFSET: BigInt(CSV_HEADER.length + 1) });
  assert.equal(withoutHeader.reports.length, 0, "without the carried header the first row is eaten as a header");
});
