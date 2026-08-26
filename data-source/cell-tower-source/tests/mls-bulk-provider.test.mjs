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
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const jsonInput = (portId, value) => ({
  portId,
  typeRef: { wireFormat: "flatbuffer" },
  payload: encoder.encode(JSON.stringify(value)),
});
const byPort = (response) => {
  const map = new Map();
  for (const frame of response.outputs) map.set(frame.portId, frame);
  return map;
};

async function harnessFor(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

// The run contract cell-tower-ingest's `ingest_plan` emits, verbatim in shape:
// one provider, one ranged descriptor, full population.
function ingestJob(providerId) {
  return {
    method: 1,
    method_name: "HIGHEST_SAMPLE_COUNT",
    limit: 1000000,
    full_population: true,
    chunk_offset: 0,
    chunk_index: 0,
    chunk_bytes: 3145728,
    prior_stored_rows: 0,
    providers_consulted: [providerId],
    request_providers: [providerId],
    skipped: [],
    provider_id: providerId,
    source_url:
      "https://archive.org/download/MLS_Full_Cell_Export_Final/MLS-full-cell-export-final.csv.gz",
  };
}

async function parseChunk(harness, providerId) {
  let parsed = await harness.invoke({
    methodId: "parse",
    inputs: [
      jsonInput("job", ingestJob(providerId)),
      jsonInput("responses", {
        status: 206,
        headers: { "Content-Range": `bytes 0-${BULK_GZ.length - 1}/1565271921` },
        bodyB64: Buffer.from(BULK_GZ).toString("base64"),
      }),
    ],
  });
  let ports = byPort(parsed);
  // Idle ticks let a multi-frame run finish its fan-in. A REFUSAL is final, so
  // stop on it: ticking past it would replace the answer under test with a
  // later invocation's "no input" complaint.
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
  const reports = JSON.parse(decoder.decode(frame.payload));

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
