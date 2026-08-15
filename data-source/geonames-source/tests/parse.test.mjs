// Decode correctness for the GeoNames lane, against VERBATIM SLICES of the live
// dumps (tests/fixtures/PROVENANCE.md records what each one is and when it was
// cut). Every assertion here is a computable outcome — a count, a byte range, a
// field that must or must not be present — and never a wiring or source-shape
// check.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const FIXTURES = new URL("./fixtures/", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(name, FIXTURES)));

// The dataset contract every $GNP record must be published under. It is the
// job frame geonames-ingest authors; DATASET_ID, DATASET_EPOCH and LICENSE are
// required by the IDL and are never defaulted in the guest.
const JOB = {
  lane: "delta",
  container: "plain",
  dataset_id: "geonames",
  dataset_name: "GeoNames gazetteer",
  dataset_url: "https://download.geonames.org/export/dump/",
  dataset_epoch: "2026-08-14T00:00:00.000Z",
  source_url: "https://download.geonames.org/export/dump/modifications-2026-08-14.txt",
  source_query: "modifications-2026-08-14.txt",
  license: "CC BY 4.0",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "GeoNames (CC BY 4.0)",
  id_prefix: "geonames",
};

function frame(portId, payload) {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : Uint8Array.from(payload);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
}

const jsonFrame = (portId, value) => frame(portId, JSON.stringify(value));

// The http connector's response envelope, in the browser-harness dialect.
const responseFrame = (portId, body, extra = {}) =>
  jsonFrame(portId, {
    status: 200,
    headers: {},
    bodyB64: Buffer.from(body).toString("base64"),
    ...extra,
  });

async function invoke(t, methodId, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

function outputsByPort(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const map = new Map();
  for (const out of response.outputs) map.set(out.portId, out.payload);
  return map;
}

const asJson = (bytes) => JSON.parse(decoder.decode(bytes));

// Walk a size-prefixed record stream: [uint32 LE length][record] repeated.
function splitStream(bytes) {
  const buf = Buffer.from(bytes);
  const records = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += 4;
    assert.ok(off + len <= buf.length, "a length prefix must not run past the stream");
    records.push(buf.subarray(off, off + len));
    off += len;
  }
  assert.equal(off, buf.length, "the stream must end exactly on a record boundary");
  return records;
}

async function lookupTables(t) {
  const outputs = outputsByPort(
    await invoke(t, "parse_lookups", [
      jsonFrame("job", JOB),
      responseFrame("admin1", fixture("admin1CodesASCII.slice.txt")),
      responseFrame("admin2", fixture("admin2Codes.slice.txt")),
      responseFrame("country", fixture("countryInfo.slice.txt")),
    ]),
  );
  return asJson(outputs.get("tables"));
}

// ---------------------------------------------------------------------------
// parse_lookups
// ---------------------------------------------------------------------------

test("parse_lookups folds the three files into code->name tables", async (t) => {
  const tables = await lookupTables(t);
  assert.equal(tables.counts.admin1, 6, "six admin1 rows in the slice");
  assert.equal(tables.counts.admin2, 6, "six admin2 rows in the slice");
  // countryInfo.txt is 50 comment lines then the rows; the comment lines,
  // INCLUDING the "#ISO ISO3 ..." column header, must not become countries.
  assert.equal(tables.counts.country, 10);
  assert.equal(tables.country.AD, "Andorra");
  assert.equal(tables.country.AE, "United Arab Emirates");
  assert.equal(tables.admin1["AD.06"], "Sant Julià de Loria", "UTF-8 survives verbatim");
  assert.equal(tables.admin2["AE.01.101"], "Abu Dhabi Municipality");
  assert.equal(tables.country["#ISO"], undefined, "the column header is not a country");
});

test("parse_lookups refuses a body the origin says is longer than what arrived", async (t) => {
  // The host caps a response body at 4 MiB. A silently short division table
  // resolves every later code to nothing while the run still reports success.
  const body = fixture("admin2Codes.slice.txt");
  const response = await invoke(t, "parse_lookups", [
    jsonFrame("job", JOB),
    jsonFrame("admin2", {
      status: 200,
      headers: { "content-length": String(body.length + 4096) },
      bodyB64: Buffer.from(body).toString("base64"),
    }),
  ]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "lookup-truncated");
});

test("parse_lookups runs with no lookup files at all", async (t) => {
  // The lane must be able to run before any table has been fetched; a place then
  // carries its codes with the names UNSET, which is recoverable. A wrong name
  // is not.
  const tables = asJson(
    outputsByPort(await invoke(t, "parse_lookups", [jsonFrame("job", JOB)])).get("tables"),
  );
  assert.deepEqual(tables.counts, { admin1: 0, admin2: 0, country: 0 });
});

// ---------------------------------------------------------------------------
// parse_places
// ---------------------------------------------------------------------------

const MODIFICATIONS = fixture("geonames-modifications.slice.txt");
const MODIFICATION_ROWS = MODIFICATIONS.toString("utf8").trimEnd().split("\n");

test("parse_places decodes every fixture row into one $GNP record", async (t) => {
  const tables = await lookupTables(t);
  const outputs = outputsByPort(
    await invoke(t, "parse_places", [
      jsonFrame("job", JOB),
      frame("text", MODIFICATIONS),
      jsonFrame("tables", tables),
    ]),
  );
  const decision = asJson(outputs.get("decision"));
  const records = splitStream(outputs.get("records"));

  assert.equal(MODIFICATION_ROWS.length, 12, "the fixture is 12 verbatim rows");
  assert.equal(decision.rowsIn, 12);
  assert.equal(decision.recordsOut, 12, "every row in the live slice is a complete 19-column row");
  assert.equal(records.length, 12, "the stream carries exactly as many records as it reports");
  assert.equal(decision.skippedShortRow, 0);
  assert.equal(decision.skippedNoIdentity, 0);
  assert.equal(decision.skippedOutOfRange, 0);
  assert.equal(decision.truncated, false);
  assert.equal(decision.schema, "GNP");

  // Every record is a real $GNP buffer: the file identifier lives at bytes 4..8
  // of a FlatBuffer root, and getting it wrong is how a stream reaches storage
  // and is routed to the wrong table.
  for (const record of records) {
    assert.equal(record.subarray(4, 8).toString("latin1"), "$GNP");
  }
});

test("parse_places carries the gazetteer's own id in provenance, never in a vendor-named field", async (t) => {
  const outputs = outputsByPort(
    await invoke(t, "parse_places", [jsonFrame("job", JOB), frame("text", MODIFICATIONS)]),
  );
  const first = splitStream(outputs.get("records"))[0].toString("utf8");
  // Column 0 of the first fixture row is geonameid 3432555, and it must appear
  // BOTH as SOURCE.NATIVE_ID (verbatim) and inside the minted, prefixed ID.
  assert.ok(first.includes("3432555"), "the gazetteer row id is carried");
  assert.ok(first.includes("geonames:3432555"), "the publisher-stable ID is prefixed and minted");
  // The licence obligation rides on every record, which is where CC BY is
  // actually discharged — the standard names no gazetteer.
  assert.ok(first.includes("CC BY 4.0"));
  assert.ok(first.includes("GeoNames (CC BY 4.0)"));
  assert.ok(first.includes("2026-08-14T00:00:00.000Z"), "the epoch is the edition boundary");
  // The place's own fields, verbatim from the row.
  assert.ok(first.includes("Laferrere"));
  assert.ok(first.includes("America/Argentina/Buenos_Aires"));
});

test("parse_places joins the resolved admin and country NAMES the IDL requires", async (t) => {
  // The fixture rows are Argentinian (AR.01, AR.13). A hand-built table proves
  // the join key is "CC.A1" / "CC.A1.A2" and not something that only happens to
  // work on one file.
  const tables = {
    admin1: { "AR.01": "Buenos Aires", "AR.13": "Mendoza" },
    admin2: { "AR.01.06427": "Partido de La Matanza" },
    country: { AR: "Argentina" },
  };
  const outputs = outputsByPort(
    await invoke(t, "parse_places", [
      jsonFrame("job", JOB),
      frame("text", MODIFICATIONS),
      jsonFrame("tables", tables),
    ]),
  );
  const first = splitStream(outputs.get("records"))[0].toString("utf8");
  assert.ok(first.includes("Argentina"), "COUNTRY_NAME resolved from the country table");
  assert.ok(first.includes("Buenos Aires"), "ADMIN1_NAME resolved on the CC.A1 key");
  assert.ok(first.includes("Partido de La Matanza"), "ADMIN2_NAME resolved on the CC.A1.A2 key");

  // A MISS LEAVES THE NAME UNSET. Mendoza's admin2 (13.50028) is not in the
  // table above, so no admin2 name may appear for those rows — carrying a
  // neighbouring division's name would be worse than carrying none.
  const second = splitStream(outputs.get("records"))[1].toString("utf8");
  assert.ok(second.includes("Mendoza"), "ADMIN1_NAME still resolves for the second row");
  assert.ok(
    !second.includes("Partido de La Matanza"),
    "an admin2 miss must not inherit another row's division name",
  );
});

test("parse_places refuses a job that cannot state the dataset, epoch and licence", async (t) => {
  for (const missing of ["dataset_id", "dataset_epoch", "license"]) {
    const job = { ...JOB };
    delete job[missing];
    const response = await invoke(t, "parse_places", [
      jsonFrame("job", job),
      frame("text", MODIFICATIONS),
    ]);
    assert.notEqual(response.statusCode, 0, `${missing} must not be defaultable`);
    assert.equal(response.errorCode, "incomplete-dataset-contract");
    assert.equal(response.outputs.length, 0, "nothing is published under a guessed epoch");
  }
});

test("parse_places DROPS an out-of-domain position and counts it, never clamps it", async (t) => {
  // A clamped place is a place in the wrong location, silently. Row 2 here is a
  // verbatim fixture row with its latitude replaced by 91.
  const good = MODIFICATION_ROWS[0];
  const bad = MODIFICATION_ROWS[1].split("\t");
  bad[4] = "91.0";
  const short = "12345\tOnly Three\tColumns";
  const noId = ["", ...MODIFICATION_ROWS[2].split("\t").slice(1)].join("\t");
  const text = [good, bad.join("\t"), short, noId].join("\n");

  const outputs = outputsByPort(
    await invoke(t, "parse_places", [jsonFrame("job", JOB), frame("text", text)]),
  );
  const decision = asJson(outputs.get("decision"));
  assert.equal(decision.rowsIn, 4);
  assert.equal(decision.recordsOut, 1, "only the intact row becomes a record");
  assert.equal(decision.skippedOutOfRange, 1);
  assert.equal(decision.skippedShortRow, 1);
  assert.equal(decision.skippedNoIdentity, 1);
  assert.equal(splitStream(outputs.get("records")).length, 1);
});

test("parse_places reports a cropped answer as cropped", async (t) => {
  const outputs = outputsByPort(
    await invoke(t, "parse_places", [
      jsonFrame("job", { ...JOB, limit: 3 }),
      frame("text", MODIFICATIONS),
    ]),
  );
  const decision = asJson(outputs.get("decision"));
  assert.equal(decision.recordsOut, 3);
  assert.equal(decision.truncated, true, "a partial edition must never read as a complete one");
  assert.equal(splitStream(outputs.get("records")).length, 3);
});

// ---------------------------------------------------------------------------
// parse_deletes
// ---------------------------------------------------------------------------

test("parse_deletes decodes the live tombstone row with its reason verbatim", async (t) => {
  const outputs = outputsByPort(
    await invoke(t, "parse_deletes", [
      jsonFrame("job", JOB),
      frame("text", fixture("geonames-deletes.slice.txt")),
    ]),
  );
  const list = asJson(outputs.get("tombstones"));
  assert.equal(list.rowsIn, 1, "the live 2026-08-14 deletes file held exactly one row");
  assert.equal(list.tombstones, 1);
  assert.deepEqual(list.entries[0], {
    native_id: "793657",
    id: "geonames:793657",
    name: "Malynivka",
    reason: "duplicate",
  });
});

test("parse_deletes distinguishes removal reasons rather than collapsing them", async (t) => {
  const text = [
    "1000001\tPlace One\tduplicate",
    "1000002\tPlace Two\tnot a real place",
    "1000003\tPlace Three\t",
  ].join("\n");
  const list = asJson(
    outputsByPort(
      await invoke(t, "parse_deletes", [jsonFrame("job", JOB), frame("text", text)]),
    ).get("tombstones"),
  );
  assert.equal(list.tombstones, 3);
  assert.deepEqual(
    list.entries.map((e) => e.reason),
    ["duplicate", "not a real place", ""],
  );
});

test("parse_deletes refuses to tombstone anything from an HTML 404 body", async (t) => {
  // GeoNames retains only the most recent day's deletes file and answers 404
  // with an HTML body for any older date (verified live 2026-08-15: every day
  // before the current one 404s). Decoding that body into tombstones would
  // delete places named "<!DOCTYPE".
  const html = '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n';
  const list = asJson(
    outputsByPort(
      await invoke(t, "parse_deletes", [jsonFrame("job", JOB), frame("text", html)]),
    ).get("tombstones"),
  );
  assert.equal(list.tombstones, 0);
  assert.equal(list.skipped, 3, "every HTML line is refused and counted");
  assert.deepEqual(list.entries, []);
});

// ---------------------------------------------------------------------------
// inflate
// ---------------------------------------------------------------------------

// A minimal, real ZIP container around one deflated member. Built here rather
// than committed because the bytes under test are the CONTAINER's, and a
// hand-built one can be made to carry the exact pathologies the decoder must
// survive (a data-descriptor local header, a wrong central-directory size).
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

test("inflate returns the archive member byte-for-byte", async (t) => {
  const zip = buildZip("cities15000.txt", MODIFICATIONS);
  const outputs = outputsByPort(
    await invoke(t, "inflate", [
      jsonFrame("job", { ...JOB, container: "zip", member: "cities15000.txt" }),
      responseFrame("response", zip),
    ]),
  );
  assert.ok(Buffer.from(outputs.get("text")).equals(MODIFICATIONS), "the member round-trips");
  const report = asJson(outputs.get("report"));
  assert.equal(report.member, "cities15000.txt");
  assert.equal(report.bytesIn, zip.length);
  assert.equal(report.bytesOut, MODIFICATIONS.length);
});

test("inflate selects the FIRST member when the job names none", async (t) => {
  const zip = buildZip("whatever-they-renamed-it.txt", MODIFICATIONS);
  const outputs = outputsByPort(
    await invoke(t, "inflate", [
      jsonFrame("job", { ...JOB, container: "zip" }),
      responseFrame("response", zip),
    ]),
  );
  assert.equal(asJson(outputs.get("report")).member, "whatever-they-renamed-it.txt");
  assert.equal(Buffer.from(outputs.get("text")).length, MODIFICATIONS.length);
});

test("inflate reads the sizes from the CENTRAL DIRECTORY, not the local header", async (t) => {
  // A ZIP written with a data descriptor carries ZEROES for both sizes in the
  // local header. Reading those would inflate nothing and report an empty
  // gazetteer, which is indistinguishable from a day on which nothing changed.
  const zip = buildZip("cities15000.txt", MODIFICATIONS, { localSizesZero: true });
  const outputs = outputsByPort(
    await invoke(t, "inflate", [
      jsonFrame("job", { ...JOB, container: "zip" }),
      responseFrame("response", zip),
    ]),
  );
  assert.ok(Buffer.from(outputs.get("text")).equals(MODIFICATIONS));
});

test("inflate REFUSES a member that inflates short of its stated size", async (t) => {
  const zip = buildZip("cities15000.txt", MODIFICATIONS, {
    centralSizeOverride: MODIFICATIONS.length + 1024,
  });
  const response = await invoke(t, "inflate", [
    jsonFrame("job", { ...JOB, container: "zip" }),
    responseFrame("response", zip),
  ]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "inflate-short");
  assert.equal(response.outputs.length, 0, "a short gazetteer is never handed downstream");
});

test("inflate refuses a truncated archive rather than decoding a prefix", async (t) => {
  const zip = buildZip("cities15000.txt", MODIFICATIONS);
  const response = await invoke(t, "inflate", [
    jsonFrame("job", { ...JOB, container: "zip" }),
    responseFrame("response", zip.subarray(0, Math.floor(zip.length / 2))),
  ]);
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "zip-member-not-found");
});

test("inflate passes a plain body through untouched", async (t) => {
  const outputs = outputsByPort(
    await invoke(t, "inflate", [
      jsonFrame("job", { ...JOB, container: "plain" }),
      responseFrame("response", MODIFICATIONS),
    ]),
  );
  assert.ok(Buffer.from(outputs.get("text")).equals(MODIFICATIONS));
});

test("inflate treats 304 as the ledgered no-op it is, and a 5xx as a failure", async (t) => {
  // THE SAME-DATA LEDGER. geonames-ingest attaches If-None-Match from the resume
  // mark; an unchanged file comes back 304 and the tick must end quietly with no
  // text frame, so nothing downstream re-stores identical rows.
  const notModified = await invoke(t, "inflate", [
    jsonFrame("job", { ...JOB, container: "plain" }),
    jsonFrame("response", { status: 304, headers: {}, bodyB64: "" }),
  ]);
  assert.equal(notModified.statusCode, 0, "a ledgered no-op is not an error");
  const ports = notModified.outputs.map((o) => o.portId);
  assert.deepEqual(ports, ["report"], "no text frame, so nothing downstream becomes ready");
  assert.equal(asJson(notModified.outputs[0].payload).ledgeredNoOp, true);

  // An empty edition and a failed fetch must never be the same observation.
  const failed = await invoke(t, "inflate", [
    jsonFrame("job", { ...JOB, container: "plain" }),
    jsonFrame("response", { status: 503, headers: {}, bodyB64: "" }),
  ]);
  assert.notEqual(failed.statusCode, 0);
  assert.equal(failed.errorCode, "upstream-status");
});
