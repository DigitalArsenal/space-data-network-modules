// The four NATIONAL BULK ARCHIVES, against captured slices of the real bodies.
//
// graph: cell-tower-bulk-archive-adapters. These four registers were verified
// live and then carried as `lane: "unavailable"` for one reason each: three
// publish a ZIP and this module had no inflate, and the fourth answers protobuf
// and this module had no decoder. Handing a ZIP to the CSV decoder returns 200
// and parses to zero rows, which is indistinguishable from a region that
// genuinely has none — the exact defect the provider registry exists to
// prevent — so they were never fetched at all.
//
// Every expectation below is an EXACT COUNT taken from a captured body, never a
// "more than zero" or an "about". A ZIP decoder that half-works produces a
// plausible smaller number, and only an exact count can tell those apart.
//
// Two of the assertions here are VALUE assertions rather than counts, because
// for those two providers a count cannot detect the bug:
//
//   - ANFR splits every coordinate across FOUR columns (degrees, minutes,
//     seconds, hemisphere). Reading only the degree column yields a coordinate
//     that is in range, plausible, and wrong by up to a degree. Every row still
//     decodes, so the count is identical and the sites are in the wrong
//     communes.
//   - ComReg encodes longitude as a plain two's-complement varint, not zigzag.
//     Read as unsigned, every Irish mast lands at ~1.8e13 degrees and is
//     dropped by the range guard — a provider that fetches perfectly and
//     contributes nothing.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
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

const fixture = (name) =>
  fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

// Captured slices — see tests/fixtures/PROVENANCE.md for how each was cut and
// what upstream bytes it contains.
const ACMA = fixture("acma-rrl.slice.zip");
const ISED = fixture("ised-sms-tafl.slice.zip");
const ANFR = fixture("anfr-cartoradio.slice.zip");
const COMREG = fixture("comreg-siteviewer.sample.pb");

// The exact populations the captured bodies carry.
const ACMA_SITES = 200;
const ISED_SITES = 200;
const ANFR_SITES = 200;
const COMREG_MASTS = 250;

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

/** Drive route -> parse for one provider against one captured body. */
async function decodeProvider(t, providerId, body, requestBody = {}) {
  const harness = await harnessFor(t);
  const routedRaw = await harness.invoke({
    methodId: "route",
    inputs: [
      htqRequest({
        PROVIDERS: [providerId],
        METHOD: "SINGLE_SOURCE",
        LIMIT: 2000,
        FULL_POPULATION: true,
        ...requestBody,
      }),
    ],
  });
  const routed = byPort(routedRaw);
  const job = jsonFrame(routed, "job");
  const descriptors = framesFor(routedRaw, "requests").map((f) =>
    JSON.parse(decoder.decode(f.payload)),
  );

  const responses = [
    jsonInput("responses", {
      status: 200,
      headers: {},
      bodyB64: Buffer.from(body).toString("base64"),
    }),
  ];
  while (responses.length < descriptors.length) {
    responses.push(jsonInput("responses", { status: 0, headers: {}, bodyB64: "" }));
  }

  let parsed = byPort(
    await harness.invoke({ methodId: "parse", inputs: [jsonInput("job", job), ...responses] }),
  );
  for (let tick = 0; tick < 8 && !parsed.get("reports"); tick += 1) {
    parsed = byPort(await harness.invoke({ methodId: "parse", inputs: [] }));
  }
  return { descriptors, reports: jsonFrame(parsed, "reports"), job };
}

// ── the four are actually reachable now ───────────────────────────────────

test("none of the four is skipped as `unavailable` any more", async (t) => {
  // Before this task each of these was refused at route time with its missing
  // capability named in the job's `skipped` array, and NO request descriptor
  // was ever emitted. That refusal is the thing being lifted, so it is what the
  // test reads — the catalog reply does not carry a lane field to assert on.
  for (const [id, body] of [
    ["acma-rrl", ACMA],
    ["ised-sms-tafl", ISED],
    ["anfr-cartoradio", ANFR],
    ["comreg-siteviewer", COMREG],
  ]) {
    const { descriptors, job } = await decodeProvider(t, id, body);
    const skipped = job.skipped ?? [];
    const mine = skipped.find((s) => s.provider_id === id);
    assert.equal(
      mine,
      undefined,
      `${id} is still skipped at route time: ${mine && mine.reason}`,
    );
    assert.ok(descriptors.length >= 1, `${id} produced no request descriptor`);
  }
});

test("a worldwide request now includes all four national registers", async (t) => {
  // `bulk` is not decoration: it is what lets a provider answer an UNBOUNDED
  // request. A `query` provider is skipped with a reason when no box is named,
  // and an `unavailable` one was skipped always. All four serve their whole
  // dataset in one response, so a worldwide run must consult them.
  const harness = await harnessFor(t);
  const routedRaw = await harness.invoke({
    methodId: "route",
    inputs: [
      htqRequest({
        PROVIDERS: ["acma-rrl", "ised-sms-tafl", "anfr-cartoradio", "comreg-siteviewer"],
        METHOD: "SINGLE_SOURCE",
        LIMIT: 100,
      }),
    ],
  });
  const job = jsonFrame(byPort(routedRaw), "job");
  assert.deepEqual(
    job.skipped ?? [],
    [],
    "a national bulk register was skipped from a worldwide request",
  );
  assert.equal(job.providers_consulted.length, 4);
});

// ── ACMA (Australia) ──────────────────────────────────────────────────────

test("acma-rrl: inflates site.csv and decodes every site — exact count", async (t) => {
  const { reports } = await decodeProvider(t, "acma-rrl", ACMA);
  assert.equal(reports.length, ACMA_SITES, `decoded ${reports.length} of ${ACMA_SITES}`);
  assert.ok(reports.every((r) => r.provider_id === "acma-rrl"));
  // Really Australia — an inflate that works and a column map that does not
  // would render just as confidently.
  for (const r of reports) {
    assert.ok(r.latitude > -44 && r.latitude < -9, `latitude ${r.latitude} is not Australian`);
    assert.ok(r.longitude > 112 && r.longitude < 154, `longitude ${r.longitude} is not Australian`);
  }
  // SITE_ID and NAME are carried; the licensee deliberately is NOT (the join
  // runs through the 383 MB device_details member).
  const first = reports[0];
  assert.equal(first.native_id, "1000");
  assert.equal(first.site_name, "Fort Hill Wharf DARWIN");
  assert.equal(first.country_code, "AU");
  assert.ok(
    reports.every((r) => !r.operator),
    "an operator name appeared that the decoded member never stated",
  );
});

test("acma-rrl: the giant sibling members are never inflated", async (t) => {
  // The fixture carries a `device_details.csv` decoy standing in for the real
  // 383 MB member. If the decoder ever extracts members it does not need, this
  // is where that regresses — the decoy's rows carry no coordinates at all, so
  // decoding it could only ADD junk or throw.
  const { reports } = await decodeProvider(t, "acma-rrl", ACMA);
  assert.equal(reports.length, ACMA_SITES, "a member other than site.csv contributed rows");
});

// ── ISED (Canada) ─────────────────────────────────────────────────────────

test("ised-sms-tafl: decodes the headerless positional CSV — exact count", async (t) => {
  const { reports } = await decodeProvider(t, "ised-sms-tafl", ISED);
  assert.equal(reports.length, ISED_SITES, `decoded ${reports.length} of ${ISED_SITES}`);
  for (const r of reports) {
    assert.ok(r.latitude > 41 && r.latitude < 84, `latitude ${r.latitude} is not Canadian`);
    assert.ok(r.longitude > -142 && r.longitude < -52, `longitude ${r.longitude} is not Canadian`);
  }
});

test("ised-sms-tafl: the positional column map lands on the right fields", async (t) => {
  // There are no column names in this file, so the ordinals ARE the contract.
  // A map shifted by one still produces 200 rows; only the values catch it.
  // These are the first record's verbatim fields from the live archive.
  const { reports } = await decodeProvider(t, "ised-sms-tafl", ISED);
  const first = reports[0];
  assert.equal(first.native_id, "0001403864", "column 2 (frequency record id) moved");
  assert.equal(first.site_name, "CASTLEGAR BC (ILS LOCALIZER)", "column 31 (location) moved");
  assert.equal(first.operator, "NAV CANADA - BRITISH COLUMBIA", "column 54 (licensee) moved");
  assert.equal(first.latitude, 49.2525, "column 40 (latitude) moved");
  assert.equal(first.longitude, -117.6625, "column 41 (longitude) moved");
  assert.equal(first.country_code, "CA");
});

test("ised-sms-tafl: the UTF-8 BOM does not ride into the first field", async (t) => {
  // The live file opens with EF BB BF. Left in place it prefixes the first
  // column of the first row, and since this file is positional there is no
  // header to absorb it — the very first record decodes wrong.
  const { reports } = await decodeProvider(t, "ised-sms-tafl", ISED);
  assert.equal(reports.length, ISED_SITES, "the BOM row was lost");
  assert.ok(
    !reports[0].native_id.startsWith("﻿"),
    "the BOM survived into the first record's id",
  );
});

// ── ANFR (France) ─────────────────────────────────────────────────────────

test("anfr-cartoradio: decodes SUP_SUPPORT — exact count", async (t) => {
  const { reports } = await decodeProvider(t, "anfr-cartoradio", ANFR);
  assert.equal(reports.length, ANFR_SITES, `decoded ${reports.length} of ${ANFR_SITES}`);
  assert.ok(reports.every((r) => r.country_code === "FR"));
});

test("anfr-cartoradio: DMS is converted, not truncated to whole degrees", async (t) => {
  // THE assertion this provider exists for. The first captured support is
  // STA_NM_ANFR 0162290002 at 46 deg 0 min 13 s N, 0 deg 21 min 19 s E.
  // Reading only the degree columns gives (46, 0) — in range, plausible, and
  // ~24 km from the real site. The row count is identical either way.
  const { reports } = await decodeProvider(t, "anfr-cartoradio", ANFR);
  const first = reports[0];
  assert.equal(first.native_id, "0162290002");
  assert.ok(
    Math.abs(first.latitude - 46.003611111) < 1e-6,
    `latitude ${first.latitude} is not 46 deg 0 min 13 s N — minutes/seconds were dropped`,
  );
  assert.ok(
    Math.abs(first.longitude - 0.355277778) < 1e-6,
    `longitude ${first.longitude} is not 0 deg 21 min 19 s E — minutes/seconds were dropped`,
  );
  // A whole-degree read would put every site on an integer coordinate.
  assert.ok(
    reports.some((r) => Math.abs(r.latitude - Math.round(r.latitude)) > 1e-4),
    "every latitude is a whole degree — the DMS conversion is not running",
  );
});

test("anfr-cartoradio: the hemisphere column is honoured", async (t) => {
  // Cartoradio carries W/O longitudes for the western departements and the
  // overseas territories. Ignoring the hemisphere column mirrors them onto the
  // wrong side of the meridian while keeping them in range.
  const { reports } = await decodeProvider(t, "anfr-cartoradio", ANFR);
  assert.ok(
    reports.some((r) => r.longitude < 0),
    "no western longitude survived — COR_CD_EW_LON is being ignored",
  );
});

test("anfr-cartoradio: no operator is invented from ADM_ID", async (t) => {
  // SUP_STATION joins on a numeric affectataire code and the archive ships no
  // table mapping those codes to names. Emitting one would be a fabricated
  // attribution riding into $TBS.SOURCES.
  const { reports } = await decodeProvider(t, "anfr-cartoradio", ANFR);
  assert.ok(reports.every((r) => !r.operator), "an operator name was invented from ADM_ID");
});

// ── ComReg (Ireland) ──────────────────────────────────────────────────────

test("comreg-siteviewer: decodes the protobuf masts — exact count", async (t) => {
  const { reports } = await decodeProvider(t, "comreg-siteviewer", COMREG);
  assert.equal(reports.length, COMREG_MASTS, `decoded ${reports.length} of ${COMREG_MASTS}`);
  assert.ok(reports.every((r) => r.country_code === "IE"));
});

test("comreg-siteviewer: negative longitudes survive the varint decode", async (t) => {
  // Ireland is entirely west of the meridian, so EVERY mast has a negative
  // longitude, encoded as a ten-byte two's-complement varint. Read as unsigned
  // they all land at ~1.8e13 degrees and the range guard drops the entire
  // national register — 200 OK, zero rows.
  const { reports } = await decodeProvider(t, "comreg-siteviewer", COMREG);
  assert.equal(
    reports.filter((r) => r.longitude < 0).length,
    COMREG_MASTS,
    "a mast decoded to a non-negative longitude — the varint was read as unsigned",
  );
  for (const r of reports) {
    assert.ok(r.latitude > 51.3 && r.latitude < 55.5, `latitude ${r.latitude} is not Irish`);
    assert.ok(r.longitude > -11 && r.longitude < -5.3, `longitude ${r.longitude} is not Irish`);
  }
  const first = reports[0];
  assert.equal(first.native_id, "1-EIR_CE_1135-3GQQVUXZ");
  assert.ok(Math.abs(first.latitude - 52.696114) < 1e-6);
  assert.ok(Math.abs(first.longitude - -8.815159) < 1e-6);
});

test("comreg-siteviewer: the operator token is carried verbatim, never expanded", async (t) => {
  // "THR" is evidently Three and "VOD" evidently Vodafone, but evidently is not
  // stated, and this module does not fabricate attribution.
  const { reports } = await decodeProvider(t, "comreg-siteviewer", COMREG);
  const operators = new Set(reports.map((r) => r.operator).filter(Boolean));
  assert.ok(operators.size > 0, "no operator token was recovered from the mast ids");
  for (const op of operators) {
    assert.match(op, /^[A-Z]+$/, `operator ${op} is not a verbatim source token`);
  }
  assert.ok(!operators.has("Three") && !operators.has("Vodafone"), "a token was expanded");
});

test("comreg-siteviewer: the request is the POST the backend requires", async (t) => {
  // The SiteViewer backend is a POST-only RPC. A GET, or a POST with no body,
  // is not an error — it is a 200 that carries nothing, which is the
  // parses-to-zero-rows failure arriving through the request side.
  const { descriptors } = await decodeProvider(t, "comreg-siteviewer", COMREG);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].method, "POST");
  // hostcap/http-request reads the outgoing body from bodyB64 and ignores a
  // plain `body` key, so this must be base64 and must decode to {}.
  assert.ok(descriptors[0].bodyB64, "no request body was sent");
  assert.equal(Buffer.from(descriptors[0].bodyB64, "base64").toString("utf8"), "{}");
  assert.equal(descriptors[0].headers.accept, "application/x-protobuf");
});

// ── shared behaviour ──────────────────────────────────────────────────────

test("a ZIP is never fetched with a Range prefix", async (t) => {
  // A truncated ZIP is not a smaller ZIP. The central directory that names the
  // members lives at the END of the archive, so a prefix is undecodable and
  // would parse to zero rows.
  for (const [id, body] of [
    ["acma-rrl", ACMA],
    ["ised-sms-tafl", ISED],
    ["anfr-cartoradio", ANFR],
  ]) {
    const { descriptors } = await decodeProvider(t, id, body, { FULL_POPULATION: false });
    assert.equal(descriptors[0].headers.range, undefined, `${id} asked for a byte range`);
  }
});

test("the row cap still applies to the bulk archives, and says so", async (t) => {
  // Same law the BAKOM lane records: "you asked for this many" and "the
  // register has this many" must never be the same answer.
  for (const [id, body] of [
    ["acma-rrl", ACMA],
    ["ised-sms-tafl", ISED],
    ["anfr-cartoradio", ANFR],
    ["comreg-siteviewer", COMREG],
  ]) {
    const { reports, job } = await decodeProvider(t, id, body, {
      FULL_POPULATION: false,
      LIMIT: 25,
    });
    assert.equal(reports.length, 25, `${id} ignored the row cap`);
    assert.equal(job.full_population, false);
  }
});

test("each archive is attributed by what it IS, not by frame order", async (t) => {
  // The three ZIPs share one magic number, so they are told apart by member
  // name. Feeding ACMA's body to a run that consulted only ISED must decode
  // NOTHING rather than decode Australian sites as Canadian ones.
  const { reports } = await decodeProvider(t, "ised-sms-tafl", ACMA);
  assert.equal(
    reports.length,
    0,
    "an ACMA archive was decoded under the ISED provider — attribution is not corroborated",
  );
});
