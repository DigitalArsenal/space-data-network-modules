// Decode correctness for the GeoNames lane on the typed contracts (1.0), against VERBATIM SLICES of the live dumps
// (tests/fixtures/PROVENANCE.md records what each one is and when it was cut). Every frame is a FlatBuffer: the fetched
// files arrive as HttpResponses (HRSP) carrying the job - a size-prefixed $GNP header record - in CONTEXT, the places
// leave as a size-prefixed $GNP stream and the summaries as FlowNotices (FNTC). Every assertion is a computable outcome -
// a count, a byte range, a field that must or must not be present - and never a wiring or source-shape check.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import zlib from "node:zlib";

import { decodeHttpResponse } from "space-data-module-sdk/runtime-contracts";

import { JOB, SEED_JOB, decodeGnp, fixture, gnpLib, invoke, itemsOf, jobHeader, outputsByPort, responseFrame, splitStream } from "./helpers.mjs";

const MODIFICATIONS = fixture("geonames-modifications.slice.txt");
const MODIFICATION_ROWS = MODIFICATIONS.toString("utf8").trimEnd().split("\n");
const ADMIN1 = fixture("admin1CodesASCII.slice.txt");
const ADMIN2 = fixture("admin2Codes.slice.txt");
const COUNTRY = fixture("countryInfo.slice.txt");

const text = (body, job = JOB) => responseFrame("text", body, { job });
const lookupFrames = () => [responseFrame("admin1", ADMIN1), responseFrame("admin2", ADMIN2), responseFrame("country", COUNTRY)];

// ---------------------------------------------------------------------------
// parse_places: the lookup join
// ---------------------------------------------------------------------------

test("parse_places folds the three lookup files and resolves every name they publish", async (t) => {
  // The six admin1 rows of the slice are Andorran parishes; a place row naming one resolves to its UTF-8 name, and the
  // country file's 50 comment lines (the "#ISO ISO3 ..." column header among them) must not become countries.
  const rows = [
    "3039162\tSant Julia\tSant Julia\t\t42.46372\t1.49129\tA\tADM1\tAD\t\t06\t\t\t\t0\t\t1000\tEurope/Andorra\t2026-08-14",
    "292968\tAbu Dhabi\tAbu Dhabi\t\t24.45118\t54.39696\tP\tPPLC\tAE\t\t01\t101\t\t\t603492\t\t3\tAsia/Dubai\t2026-08-14",
    "1\tNowhere\tNowhere\t\t0\t0\tP\tPPL\t#ISO\t\t\t\t\t\t0\t\t0\t\t2026-08-14",
  ].join("\n");
  const outputs = outputsByPort(await invoke(t, "parse_places", [text(rows), ...lookupFrames()]));
  const [andorra, abuDhabi, nowhere] = splitStream(outputs.get("records")[0]).map(decodeGnp);
  assert.equal(andorra.COUNTRY_NAME, "Andorra");
  assert.equal(andorra.ADMIN1_NAME, "Sant Julià de Loria", "UTF-8 survives verbatim");
  assert.equal(abuDhabi.COUNTRY_NAME, "United Arab Emirates");
  assert.equal(abuDhabi.ADMIN2_NAME, "Abu Dhabi Municipality");
  assert.equal(nowhere.COUNTRY_NAME, null, "the column header is not a country");
  const decision = itemsOf(outputs.get("decision")[0]);
  assert.deepEqual([decision.admin1_resolved, decision.admin2_resolved, decision.countries_resolved], ["6", "6", "10"]);
});

test("parse_places refuses a lookup body the origin says is longer than what arrived", async (t) => {
  // The host caps a response body at 4 MiB. A silently short division table resolves every later code to nothing
  // while the run still reports success.
  const response = await invoke(t, "parse_places", [
    text(MODIFICATIONS),
    responseFrame("admin2", ADMIN2, { headers: { "content-length": String(ADMIN2.length + 4096) } }),
  ]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "lookup-truncated");
  assert.equal(response.outputs.length, 0);
});

test("parse_places runs with no lookup files at all: codes kept, names unset", async (t) => {
  // The lane must be able to run before any table has been fetched (the delta lane fetches none); a place then carries
  // its codes with the names UNSET, which is recoverable. A wrong name is not.
  const outputs = outputsByPort(await invoke(t, "parse_places", [text(MODIFICATIONS)]));
  const first = decodeGnp(splitStream(outputs.get("records")[0])[0]);
  assert.deepEqual([first.COUNTRY_CODE, first.ADMIN1_CODE, first.ADMIN2_CODE], ["AR", "01", "06427"]);
  assert.deepEqual([first.COUNTRY_NAME, first.ADMIN1_NAME, first.ADMIN2_NAME], [null, null, null]);
  const decision = itemsOf(outputs.get("decision")[0]);
  assert.deepEqual([decision.admin1_resolved, decision.admin2_resolved, decision.countries_resolved], ["0", "0", "0"]);
});

// ---------------------------------------------------------------------------
// parse_places: the rows
// ---------------------------------------------------------------------------

test("parse_places decodes every fixture row into one $GNP record", async (t) => {
  const outputs = outputsByPort(await invoke(t, "parse_places", [text(MODIFICATIONS), ...lookupFrames()]));
  const [decision] = outputs.get("decision");
  const records = splitStream(outputs.get("records")[0]);

  assert.equal(MODIFICATION_ROWS.length, 12, "the fixture is 12 verbatim rows");
  assert.deepEqual([decision.kind, decision.reason, decision.count, decision.schema], ["info", "places-decoded", 12, "GNP.fbs"]);
  assert.equal(decision.sourceName, "geonames");
  assert.equal(decision.atMs, Date.UTC(2026, 7, 14), "AT_MS is the edition's epoch");
  const items = itemsOf(decision);
  assert.equal(items.rows_in, "12");
  assert.equal(items.records_out, "12", "every row in the live slice is a complete 19-column row");
  assert.deepEqual([items.skipped_short_row, items.skipped_no_identity, items.skipped_out_of_range, items.truncated], ["0", "0", "0", "false"]);
  assert.equal(items.lane, "delta");
  assert.equal(records.length, 12, "the stream carries exactly as many records as it reports");
  // Every record is a real $GNP buffer: the file identifier lives at bytes 4..8 of a FlatBuffer root, and getting it
  // wrong is how a stream reaches storage and is routed to the wrong table.
  for (const record of records) assert.equal(record.subarray(4, 8).toString("latin1"), "$GNP");
});

test("parse_places carries the gazetteer's own id in provenance and the dataset contract on every record", async (t) => {
  const outputs = outputsByPort(await invoke(t, "parse_places", [text(MODIFICATIONS)]));
  const first = decodeGnp(splitStream(outputs.get("records")[0])[0]);
  // Column 0 of the first fixture row is geonameid 3432555: SOURCE.NATIVE_ID verbatim, and inside the minted ID.
  assert.equal(first.ID, "geonames:3432555", "the publisher-stable ID is prefixed and minted");
  assert.equal(first.SOURCE.NATIVE_ID, "3432555");
  assert.equal(first.SOURCE.NATIVE_MODIFIED, "2026-08-15");
  // The licence obligation rides on every record, which is where CC BY is actually discharged.
  assert.equal(first.SOURCE.LICENSE, "CC BY 4.0");
  assert.equal(first.SOURCE.ATTRIBUTION, "GeoNames (CC BY 4.0)");
  assert.equal(first.SOURCE.LICENSE_URL, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(first.SOURCE.DATASET_ID, "geonames");
  assert.equal(first.SOURCE.DATASET_NAME, "GeoNames gazetteer");
  assert.equal(first.SOURCE.DATASET_EPOCH, "2026-08-14T00:00:00.000Z", "the epoch is the edition boundary");
  assert.equal(first.SOURCE.SOURCE_URL, JOB.sourceUrl);
  assert.equal(first.SOURCE.SOURCE_QUERY, "modifications-2026-08-14.txt");
  assert.match(first.SOURCE.RETRIEVED_AT, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // The place's own fields, verbatim from the row; empty columns UNSET.
  assert.equal(first.NAME, "Laferrere");
  assert.equal(first.TIME_ZONE_ID, "America/Argentina/Buenos_Aires");
  assert.deepEqual([first.LATITUDE, first.LONGITUDE], [-34.75049, -58.58464]);
  assert.equal(first.POPULATION, 248362n);
  assert.equal(first.FEATURE_CLASS, gnpLib.gnpFeatureClass.POPULATED_PLACE);
  assert.deepEqual([first.FEATURE_CLASS_CODE, first.FEATURE_CODE], ["P", "PPL"]);
  assert.deepEqual(first.ALTERNATE_NAMES.map((n) => [n.NAME, n.LANGUAGE]), [["Gregorio de Laferrere", null]]);
  assert.equal(first.ELEVATION_PUBLISHED, false, "no elevation published is not an elevation of zero");
  assert.equal(first.DEM_ELEVATION_M, 13);
  assert.equal(first.DEM_MODEL, null, "the job states no DEM model");
});

test("parse_places joins the resolved admin and country NAMES the IDL requires, on CC.A1 / CC.A1.A2", async (t) => {
  // The fixture rows are Argentinian (AR.01, AR.13). Hand-cut lookup files prove the join key is "CC.A1" / "CC.A1.A2"
  // and not something that only happens to work on one file.
  const outputs = outputsByPort(await invoke(t, "parse_places", [
    text(MODIFICATIONS),
    responseFrame("admin1", "AR.01\tBuenos Aires\tBuenos Aires\t3435907\nAR.13\tMendoza\tMendoza\t3844419\n"),
    responseFrame("admin2", "AR.01.06427\tPartido de La Matanza\tPartido de La Matanza\t3432379\n"),
    responseFrame("country", "#ISO\tISO3\tISO-Numeric\tfips\tCountry\nAR\tARG\t032\tAR\tArgentina\tBuenos Aires\n"),
  ]));
  const [first, second] = splitStream(outputs.get("records")[0]).map(decodeGnp);
  assert.equal(first.COUNTRY_NAME, "Argentina", "COUNTRY_NAME resolved from the country file");
  assert.equal(first.ADMIN1_NAME, "Buenos Aires", "ADMIN1_NAME resolved on the CC.A1 key");
  assert.equal(first.ADMIN2_NAME, "Partido de La Matanza", "ADMIN2_NAME resolved on the CC.A1.A2 key");
  // A MISS LEAVES THE NAME UNSET. Mendoza's admin2 (13.50028) is not in the file above, so no admin2 name may appear
  // for that row - carrying a neighbouring division's name would be worse than carrying none.
  assert.equal(second.ADMIN1_NAME, "Mendoza", "ADMIN1_NAME still resolves for the second row");
  assert.equal(second.ADMIN2_CODE, "50028");
  assert.equal(second.ADMIN2_NAME, null, "an admin2 miss must not inherit another row's division name");
});

test("parse_places refuses a job that cannot state the dataset, epoch and licence", async (t) => {
  for (const missing of ["datasetId", "datasetEpoch", "license"]) {
    // (the header's required strings are present but EMPTY: a job planned without them)
    const response = await invoke(t, "parse_places", [text(MODIFICATIONS, { ...JOB, [missing]: "" })]);
    assert.notEqual(response.statusCode, 0, `${missing} must not be defaultable`);
    assert.equal(response.errorCode, "incomplete-dataset-contract");
    assert.equal(response.outputs.length, 0, "nothing is published under a guessed epoch");
  }
  // a text frame with no job at all
  const orphan = await invoke(t, "parse_places", [responseFrame("text", MODIFICATIONS)]);
  assert.equal(orphan.errorCode, "incomplete-dataset-contract");
});

test("parse_places DROPS an out-of-domain position and counts it, never clamps it", async (t) => {
  // A clamped place is a place in the wrong location, silently. Row 2 here is a verbatim fixture row with its latitude
  // replaced by 91.
  const good = MODIFICATION_ROWS[0];
  const bad = MODIFICATION_ROWS[1].split("\t");
  bad[4] = "91.0";
  const short = "12345\tOnly Three\tColumns";
  const noId = ["", ...MODIFICATION_ROWS[2].split("\t").slice(1)].join("\t");
  const outputs = outputsByPort(await invoke(t, "parse_places", [text([good, bad.join("\t"), short, noId].join("\n"))]));
  const items = itemsOf(outputs.get("decision")[0]);
  assert.equal(items.rows_in, "4");
  assert.equal(items.records_out, "1", "only the intact row becomes a record");
  assert.deepEqual([items.skipped_out_of_range, items.skipped_short_row, items.skipped_no_identity], ["1", "1", "1"]);
  assert.equal(splitStream(outputs.get("records")[0]).length, 1);
});

test("parse_places reports a cropped answer as cropped (node config geonames_limit)", async (t) => {
  const response = await invoke(t, "parse_places", [text(MODIFICATIONS)], { geonames_limit: 3 });
  const outputs = outputsByPort(response);
  const [decision] = outputs.get("decision");
  assert.deepEqual([decision.reason, decision.count], ["places-cropped", 3]);
  assert.equal(itemsOf(decision).truncated, "true", "a partial edition must never read as a complete one");
  assert.equal(splitStream(outputs.get("records")[0]).length, 3);
  assert.deepEqual(response.calls.map((c) => c.op), ["plugin.getConfig"], "one config read, nothing else");
});

// ---------------------------------------------------------------------------
// parse_deletes
// ---------------------------------------------------------------------------

test("parse_deletes decodes the live tombstone row with its reason verbatim", async (t) => {
  const outputs = outputsByPort(await invoke(t, "parse_deletes", [text(fixture("geonames-deletes.slice.txt"))]));
  const notices = outputs.get("tombstones");
  assert.equal(notices.length, 1, "no refused rows, so no second notice");
  assert.deepEqual(notices[0], {
    kind: "info", schema: "GNP.fbs", providerId: "", sourceName: "geonames", batchId: "", count: 1, reason: "tombstones",
    items: ["geonames:793657\tMalynivka\tduplicate"], atMs: Date.UTC(2026, 7, 14),
  }, "the live 2026-08-14 deletes file held exactly one row");
});

test("parse_deletes distinguishes removal reasons rather than collapsing them", async (t) => {
  const rows = ["1000001\tPlace One\tduplicate", "1000002\tPlace Two\tnot a real place", "1000003\tPlace Three\t"].join("\n");
  const [list] = outputsByPort(await invoke(t, "parse_deletes", [text(rows)])).get("tombstones");
  assert.equal(list.count, 3);
  assert.deepEqual(list.items.map((e) => e.split("\t")[2]), ["duplicate", "not a real place", ""]);
});

test("parse_deletes refuses to tombstone anything from an HTML 404 body", async (t) => {
  // GeoNames retains only the most recent day's deletes file and answers 404 with an HTML body for any older date
  // (verified live 2026-08-15). Decoding that body into tombstones would delete places named "<!DOCTYPE".
  const html = '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n';
  const [list, skipped] = outputsByPort(await invoke(t, "parse_deletes", [text(html)])).get("tombstones");
  assert.deepEqual([list.reason, list.count, list.items], ["tombstones", 0, []]);
  assert.deepEqual([skipped.reason, skipped.count, skipped.items], ["deletes-rows-skipped", 3, ["rows_in=3"]], "every HTML line is refused and counted");
});

// ---------------------------------------------------------------------------
// inflate
// ---------------------------------------------------------------------------

// A minimal, real ZIP container around one deflated member. Built here rather than committed because the bytes under
// test are the CONTAINER's, and a hand-built one can be made to carry the exact pathologies the decoder must survive (a
// data-descriptor local header, a wrong central-directory size).
function buildZip(name, contents, { localSizesZero = false, centralSizeOverride } = {}) {
  const nameBytes = Buffer.from(name, "utf8");
  const raw = Buffer.from(contents);
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(localSizesZero ? 0x0008 : 0, 6); // bit 3 = data descriptor
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(localSizesZero ? 0 : deflated.length, 18);
  local.writeUInt32LE(localSizesZero ? 0 : raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(localSizesZero ? 0x0008 : 0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(centralSizeOverride ?? raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(local.length + nameBytes.length + deflated.length, 16);

  return Buffer.concat([local, nameBytes, deflated, central, nameBytes, eocd]);
}

const seedResponse = (body, job = SEED_JOB, extra = {}) =>
  responseFrame("response", body, { job, status: 206, headers: { "content-range": `bytes 0-${body.length - 1}/${body.length}`, etag: '"3273cd"' }, url: job.sourceUrl, retrievedMs: Date.UTC(2026, 7, 15, 2), ...extra });

test("inflate returns the archive member byte-for-byte, the response and its job carried on", async (t) => {
  const zip = buildZip("cities15000.txt", MODIFICATIONS);
  const input = seedResponse(zip);
  const outputs = outputsByPort(await invoke(t, "inflate", [input]));
  const [out] = outputs.get("text");
  assert.ok(Buffer.from(out.body).equals(MODIFICATIONS), "the member round-trips");
  const sent = decodeHttpResponse(input.payload);
  assert.deepEqual({ ...out, body: null }, { ...sent, body: null }, "URL, STATUS, HEADERS, CONTEXT (the job) and RETRIEVED_MS verbatim");
  assert.deepEqual(out.context, jobHeader(SEED_JOB));
  const [report] = outputs.get("report");
  assert.deepEqual([report.kind, report.reason, report.count, report.sourceName], ["info", "inflated", MODIFICATIONS.length, "geonames"]);
  assert.deepEqual(itemsOf(report), { container: "zip", member: "cities15000.txt", bytes_in: String(zip.length), bytes_out: String(MODIFICATIONS.length), status: "206" });
});

test("inflate selects the FIRST member when the job names none", async (t) => {
  const zip = buildZip("whatever-they-renamed-it.txt", MODIFICATIONS);
  const outputs = outputsByPort(await invoke(t, "inflate", [seedResponse(zip, { ...SEED_JOB, name: "" })]));
  assert.equal(itemsOf(outputs.get("report")[0]).member, "whatever-they-renamed-it.txt");
  assert.equal(outputs.get("text")[0].body.length, MODIFICATIONS.length);
  // and a job that NAMES a member the archive lacks is refused, never answered from another member
  const named = await invoke(t, "inflate", [seedResponse(zip)]);
  assert.equal(named.errorCode, "zip-member-not-found");
});

test("inflate reads the sizes from the CENTRAL DIRECTORY, not the local header", async (t) => {
  // A ZIP written with a data descriptor carries ZEROES for both sizes in the local header. Reading those would
  // inflate nothing and report an empty gazetteer, which is indistinguishable from a day on which nothing changed.
  const zip = buildZip("cities15000.txt", MODIFICATIONS, { localSizesZero: true });
  const outputs = outputsByPort(await invoke(t, "inflate", [seedResponse(zip)]));
  assert.ok(Buffer.from(outputs.get("text")[0].body).equals(MODIFICATIONS));
});

test("inflate REFUSES a member that inflates short of its stated size", async (t) => {
  const zip = buildZip("cities15000.txt", MODIFICATIONS, { centralSizeOverride: MODIFICATIONS.length + 1024 });
  const response = await invoke(t, "inflate", [seedResponse(zip)]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "inflate-short");
  assert.equal(response.outputs.length, 0, "a short gazetteer is never handed downstream");
});

test("inflate refuses a truncated archive rather than decoding a prefix", async (t) => {
  const zip = buildZip("cities15000.txt", MODIFICATIONS);
  const response = await invoke(t, "inflate", [seedResponse(zip.subarray(0, Math.floor(zip.length / 2)))]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "zip-member-not-found");
});

test("inflate passes a plain body through untouched (a delta job, or a response with no job)", async (t) => {
  for (const job of [JOB, undefined]) {
    const outputs = outputsByPort(await invoke(t, "inflate", [responseFrame("response", MODIFICATIONS, { job })]));
    assert.ok(Buffer.from(outputs.get("text")[0].body).equals(MODIFICATIONS));
    assert.equal(itemsOf(outputs.get("report")[0]).container, "plain");
  }
});

test("inflate treats 304 as the ledgered no-op it is, and a 5xx or a failed fetch as a failure", async (t) => {
  // THE SAME-DATA LEDGER. geonames-ingest attaches If-None-Match from the resume mark; an unchanged file comes back 304
  // and the tick must end quietly with no text frame, so nothing downstream re-stores identical rows.
  const notModified = await invoke(t, "inflate", [responseFrame("response", "", { status: 304, job: JOB })]);
  assert.equal(notModified.statusCode, 0, "a ledgered no-op is not an error");
  assert.deepEqual(notModified.outputs.map((o) => o.portId), ["report"], "no text frame, so nothing downstream becomes ready");
  const [report] = outputsByPort(notModified).get("report");
  assert.deepEqual([report.kind, report.reason, itemsOf(report).status], ["unchanged", "not-modified", "304"]);

  // An empty edition and a failed fetch must never be the same observation.
  const failed = await invoke(t, "inflate", [responseFrame("response", "", { status: 503, job: JOB })]);
  assert.equal(failed.errorCode, "upstream-status");
  const unreachable = await invoke(t, "inflate", [responseFrame("response", "", { status: 0, job: JOB, error: "dial tcp: i/o timeout" })]);
  assert.equal(unreachable.errorCode, "upstream-status");
  assert.match(unreachable.errorMessage, /HTTP 0: dial tcp: i\/o timeout/);
});
