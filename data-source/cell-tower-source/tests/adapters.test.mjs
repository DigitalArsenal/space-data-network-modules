// data-source/cell-tower-source — per-provider ADAPTER tests.
//
// These run against RESPONSES CAPTURED FROM THE LIVE SERVICES (see
// fixtures/PROVENANCE.md), not against payloads invented here. That distinction
// is the whole lesson of `cell-tower-provider-endpoints-are-download-pages`: the
// previous URLs were written from documentation rather than from a successful
// fetch, and the failure was invisible because a body that parses to zero rows
// is indistinguishable from a region that genuinely has none.
//
// The query-shape tests assert the URL the module ASKS FOR, because an endpoint
// reached with the wrong query returns 200 carrying an error page — which also
// parses to zero rows.

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
  path.join(sdkRoot, "src", "generated", "http", "sdn", "http", "http-request.js"),
);

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const OVERPASS = fs.readFileSync(
  new URL("./fixtures/overpass-berlin.sample.json", import.meta.url),
);
const FCC = fs.readFileSync(
  new URL("./fixtures/fcc-uls-3650-houston.sample.json", import.meta.url),
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function harnessFor(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(WASM_PATH),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

function htqRequest(body) {
  const builder = new flatbuffers.Builder(1024);
  const method = builder.createString("POST");
  const requestPath = builder.createString("/api/v1/cellular/aggregate");
  const query = builder.createString("");
  const bodyVector = HttpRequest.createBodyVector(builder, encoder.encode(body));
  HttpRequest.startHttpRequest(builder);
  HttpRequest.addMethod(builder, method);
  HttpRequest.addPath(builder, requestPath);
  HttpRequest.addQuery(builder, query);
  HttpRequest.addBody(builder, bodyVector);
  HttpRequest.finishHttpRequestBuffer(builder, HttpRequest.endHttpRequest(builder));
  return { portId: "request", typeRef: { wireFormat: "flatbuffer" }, payload: builder.asUint8Array() };
}

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
const framesFor = (response, portId) => response.outputs.filter((f) => f.portId === portId);
const jsonFrame = (map, portId) => {
  const frame = map.get(portId);
  assert.ok(frame, `missing output frame ${portId}`);
  return JSON.parse(decoder.decode(frame.payload));
};

// EXACTLY what hostcap/http-request emits on "response":
// {"status","headers","bodyB64"}. There is deliberately NO provider_id —
// no host has ever produced one, and synthesising it here is what let a
// dead pipeline pass every local run (see live-probe.mjs). `providerId`
// survives as documentation of which descriptor slot a frame answers;
// parse correlates by POSITION, so callers must pass frames in
// descriptor order.
const httpResponse = (providerId, body) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  bodyB64: Buffer.from(body).toString("base64"),
});

const rawHttpResponse = (status, body = new Uint8Array()) => {
  const bytes = Buffer.from(body);
  const frame = Buffer.alloc(8 + bytes.byteLength);
  frame.write("$HRB", 0, "ascii");
  frame.writeInt32LE(status, 4);
  bytes.copy(frame, 8);
  return new Uint8Array(frame);
};

const responseInput = (response) => {
  if (response instanceof Uint8Array) {
    return {
      portId: "responses",
      typeRef: {
        wireFormat: "aligned-binary",
        requiredAlignment: 1,
        byteLength: response.byteLength,
      },
      payload: response,
    };
  }
  return jsonInput("responses", response);
};

async function routeFor(t, body) {
  const harness = await harnessFor(t);
  const response = await harness.invoke({ methodId: "route", inputs: [htqRequest(JSON.stringify(body))] });
  const ports = byPort(response);
  // When NOTHING is fetchable, route answers on `reply` and emits no `job` —
  // the run is over before it starts, and stalling the chain instead would be a
  // silent 502. Both frames carry the same `skipped` ledger, so a caller that
  // only wants to know what was refused reads whichever arrived.
  const jobFrame = ports.get("job");
  const replyFrame = ports.get("reply");
  return {
    harness,
    job: jobFrame ? jsonFrame(ports, "job") : undefined,
    reply: replyFrame ? jsonFrame(ports, "reply") : undefined,
    outcome: jobFrame ? jsonFrame(ports, "job") : jsonFrame(ports, "reply"),
    descriptors: framesFor(response, "requests").map((f) => JSON.parse(decoder.decode(f.payload))),
  };
}

// parse is a FAN-IN node: it accumulates across invocations and emits once, on
// the quiet tick after the last response (it asks for that tick with
// plugin_set_yielded/backlog_remaining). Invoking it ONCE and reading the output
// would test a node the runtime does not have — so drive it the way the
// scheduler does, and let the emission arrive when it actually arrives.
async function drainParse(harness, inputs, maxTicks = 8) {
  let outputs = await harness.invoke({ methodId: "parse", inputs });
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const map = byPort(outputs);
    if (map.get("reports")) return map;
    outputs = await harness.invoke({ methodId: "parse", inputs: [] });
  }
  throw new Error("parse never emitted reports");
}

// A provider with mirrors emits SEVERAL descriptors, and the host answers each
// one — so a test that supplies fewer frames than descriptors is describing a
// run where the rest failed. Say that explicitly with empty frames rather than
// leaving the fan-in short by accident, which is the difference between testing
// the failed-fetch path and hanging on it.
const FAILED_FETCH = { status: 0, headers: {}, bodyB64: "" };

async function parseWith(t, providers, responses, body = {}) {
  const { harness, job, descriptors } = await routeFor(t, {
    PROVIDERS: providers,
    METHOD: "CENTROID",
    LIMIT: 400,
    // Bounded providers are only eligible when a region is named.
    BBOX: { south: 29.6, west: -95.7, north: 30.1, east: -95.2 },
    ...body,
  });
  const padded = [...responses];
  while (padded.length < descriptors.length) padded.push(FAILED_FETCH);
  const parsed = await drainParse(harness, [
    jsonInput("job", job),
    ...padded.map(responseInput),
  ]);
  return jsonFrame(parsed, "reports");
}

test("osm-json: EVERY element decodes, not just the first", async (t) => {
  const captured = JSON.parse(OVERPASS.toString("utf8"));
  const reports = await parseWith(t, ["openstreetmap-overpass"], [
    httpResponse("openstreetmap-overpass", OVERPASS),
  ]);
  // The decoder used to split the DOCUMENT rather than the elements ARRAY. An
  // Overpass response is one top-level object, so it yielded exactly one
  // "element" — the whole body — and 14 of these 15 masts silently vanished.
  assert.equal(
    reports.length,
    captured.elements.length,
    `decoded ${reports.length} of ${captured.elements.length} elements`,
  );
});

test("osm-json: each mast carries ITS OWN tags, not a neighbour's", async (t) => {
  const captured = JSON.parse(OVERPASS.toString("utf8"));
  const reports = await parseWith(t, ["openstreetmap-overpass"], [
    httpResponse("openstreetmap-overpass", OVERPASS),
  ]);
  // The same document-scoped split made every field lookup return the FIRST
  // match anywhere in the response, so the surviving site wore an operator that
  // belonged to a different mast. That is worse than dropping it: an
  // attribution the source never made, exported as though it had.
  for (const element of captured.elements) {
    const report = reports.find((r) => r.native_id === String(element.id));
    assert.ok(report, `element ${element.id} did not decode`);
    const expected = element.tags?.operator;
    if (expected) assert.equal(report.operator, expected);
    else {
      assert.ok(
        !report.operator,
        `element ${element.id} has no operator tag but decoded as "${report.operator}"`,
      );
    }
  }
  // The fixture must actually be able to catch this: it needs both kinds.
  const tagged = captured.elements.filter((e) => e.tags?.operator).length;
  assert.ok(tagged > 0 && tagged < captured.elements.length, "fixture cannot detect cross-contamination");
});

test("soql-json: rows decode with position, site and operator", async (t) => {
  const captured = JSON.parse(FCC.toString("utf8"));
  const reports = await parseWith(t, ["fcc-uls-3650"], [httpResponse("fcc-uls-3650", FCC)]);
  assert.equal(reports.length, captured.length);
  for (const row of captured) {
    const report = reports.find((r) => r.native_id === row.u_location_id);
    assert.ok(report, `row ${row.u_location_id} did not decode`);
    assert.equal(report.latitude.toFixed(5), Number(row.u_latitude).toFixed(5));
    assert.equal(report.longitude.toFixed(5), Number(row.u_longitude).toFixed(5));
    assert.equal(report.operator, row.u_license_name);
  }
  // Western hemisphere: a decoder that dropped the sign would still "work".
  assert.ok(reports.every((r) => r.longitude < 0), "longitude sign was lost");
});

test("soql-json: a licensed site is never given a guessed radio generation", async (t) => {
  const reports = await parseWith(t, ["fcc-uls-3650"], [httpResponse("fcc-uls-3650", FCC)]);
  // The register publishes no MCC/MNC/cell id and no generation. These sites are
  // the AUTHORITATIVE half of the merge, so a guessed LTE here would WIN
  // deconfliction against the crowd-sourced provider and be exported as though a
  // regulator had asserted it. 5 = OTHER in tbsRadioClass.
  for (const r of reports) {
    assert.equal(r.radio, 5, `radio class was guessed as ${r.radio}`);
    assert.ok(!r.cell_id, "a cell id was invented for a site that publishes none");
  }
});

test("query shape: overpass gets an encoded program, soql gets $where", async (t) => {
  const { descriptors } = await routeFor(t, {
    PROVIDERS: ["openstreetmap-overpass", "fcc-uls-3650"],
    METHOD: "CENTROID",
    LIMIT: 400,
    BBOX: { south: 29.6, west: -95.7, north: 30.1, east: -95.2 },
  });
  const overpass = descriptors.filter((d) => d.provider_id === "openstreetmap-overpass");
  const fcc = descriptors.filter((d) => d.provider_id === "fcc-uls-3650");
  assert.equal(fcc.length, 1);
  // Every mirror is issued in the SAME run — a stateless flow node has nowhere
  // to remember where a retry got to.
  assert.ok(overpass.length > 1, "mirrors were not issued");

  for (const d of overpass) {
    assert.match(d.url, /\?data=/u, "overpass program is not in the data parameter");
    // The program must be percent-encoded: raw brackets and quotes in a query
    // string are what turn a working query into a 200-with-an-error-page.
    assert.ok(!/[["\]]/u.test(d.url.split("?data=")[1]), "overpass program was not encoded");
    assert.match(d.url, /29\.600000%2C-95\.700000%2C30\.100000%2C-95\.200000/u, "bbox not substituted");
    assert.ok(!d.url.includes("{{"), "an unsubstituted placeholder reached the URL");
  }
  // $where and $limit are the API's own parameter NAMES and stay literal, or the
  // service reads them as an unknown parameter and silently returns everything.
  assert.match(fcc[0].url, /\?\$where=/u);
  assert.match(fcc[0].url, /&\$limit=400/u);
  assert.match(fcc[0].url, /29\.600000%20and%2030\.100000/u, "bbox not substituted into the filter");
  assert.ok(!fcc[0].url.includes("{{"), "an unsubstituted placeholder reached the URL");
});

test("query shape: the per-provider row cap is bounded, not caller-dictated", async (t) => {
  const { descriptors } = await routeFor(t, {
    PROVIDERS: ["fcc-uls-3650"],
    METHOD: "CENTROID",
    LIMIT: 100000,
  });
  // LIMIT caps records EMITTED — the cheap end. Letting it size the fetch would
  // let an anonymous caller aim the node's outbound work at the expensive end.
  assert.match(descriptors[0].url, /&\$limit=1000$/u);
});

test("a malformed BBOX is refused rather than silently inverted", async (t) => {
  const { descriptors } = await routeFor(t, {
    PROVIDERS: ["fcc-uls-3650"],
    METHOD: "CENTROID",
    LIMIT: 400,
    BBOX: { south: 30.1, west: -95.2, north: 29.6, east: -95.7 },
  });
  // south>north would compile into a filter matching nothing, which reads as
  // "this area has no towers" instead of "you sent the corners backwards".
  // The rejected box falls back to the WORLDWIDE default (owner 2026-08-10),
  // not to a substituted region — a silent regional substitute is the defect
  // this whole task was filed about.
  assert.match(
    descriptors[0].url,
    /-90\.000000%20and%2090\.000000/u,
    "an inverted bbox must fall back to worldwide, not be compiled in",
  );
  assert.doesNotMatch(descriptors[0].url, /29\.600000/u, "the inverted corners reached the query");
});

// --- correlation: how parse knows WHICH provider a response body came from ---
//
// These pin the defect that shipped to host-01 on 2026-08-09: parse read
// `provider_id` off the response frame, but hostcap/http-request emits only
// {"status","headers","bodyB64"}. Every live frame therefore resolved to no
// provider and was skipped — the node fetched all four URLs for real and
// answered 200 with zero records and no error line, while every local test and
// the live probe reported 1451 reports, because they all synthesised the field.

test("attribution survives the host's real response shape (no provider_id)", async (t) => {
  const overpass = JSON.parse(OVERPASS.toString("utf8"));
  const fcc = JSON.parse(FCC.toString("utf8"));

  // Frames exactly as the hostcap emits them, in descriptor order. Nothing in
  // these objects names a provider; the correlation must come from the job.
  const frames = [
    { status: 200, headers: {}, bodyB64: Buffer.from(FCC).toString("base64") },
    { status: 200, headers: {}, bodyB64: Buffer.from(OVERPASS).toString("base64") },
  ];
  for (const f of frames) {
    assert.ok(!("provider_id" in f), "the host does not send provider_id — do not add it");
  }

  const reports = await parseWith(t, ["fcc-uls-3650", "openstreetmap-overpass"], frames);
  const byProvider = {};
  for (const r of reports) byProvider[r.provider_id] = (byProvider[r.provider_id] || 0) + 1;

  assert.equal(byProvider["fcc-uls-3650"], fcc.length);
  assert.equal(byProvider["openstreetmap-overpass"], overpass.elements.length);
});

test("raw-body-v1 parses the provider body without a base64 copy", async (t) => {
  const captured = JSON.parse(BAKOM.toString("utf8"));
  const reports = await parseWith(
    t,
    ["bakom-mobile-sites"],
    [rawHttpResponse(200, BAKOM)],
    { BBOX: undefined },
  );
  assert.equal(reports.length, captured.features.length);
  assert.ok(reports.every((r) => r.provider_id === "bakom-mobile-sites"));
});

test("the national GeoJSON decoder stops at the declared per-provider row cap", async (t) => {
  const document = JSON.stringify({
    type: "FeatureCollection",
    features: Array.from({ length: 8 }, (_, index) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [2600000 + index, 1200000 + index] },
      properties: { station: `bounded-${index}`, techno_en: "Technology 4G" },
    })),
  });
  const reports = await parseWith(
    t,
    ["bakom-mobile-sites"],
    [rawHttpResponse(200, encoder.encode(document))],
    { BBOX: undefined, LIMIT: 3 },
  );
  assert.equal(reports.length, 3, "the decoder scanned past the caller's bounded work cap");
  assert.deepEqual(reports.map((report) => report.site_name), ["bounded-0", "bounded-1", "bounded-2"]);
});

test("attribution follows the BODY, not the slot it arrived in", async (t) => {
  // Same two descriptors, responses SWAPPED — the shape a missing frame
  // produces, and it is the ordinary case here rather than an exotic one:
  // hostcap/http-request pushes NO frame for a failed fetch, and Overpass ships
  // three endpoints precisely because they fail (one answered a five-node query
  // in 30.7s from host-01, so it times out on real ones).
  //
  // Position therefore cannot be the primary key. Among the providers a run
  // consulted, a body whose format only ONE of them uses can only be that
  // one's, whatever slot it landed in — so this must decode BOTH, correctly
  // attributed, rather than lose them.
  const overpass = JSON.parse(OVERPASS.toString("utf8"));
  const fcc = JSON.parse(FCC.toString("utf8"));
  const frames = [
    { status: 200, headers: {}, bodyB64: Buffer.from(OVERPASS).toString("base64") },
    { status: 200, headers: {}, bodyB64: Buffer.from(FCC).toString("base64") },
  ];
  const reports = await parseWith(t, ["fcc-uls-3650", "openstreetmap-overpass"], frames);
  const byProvider = {};
  for (const r of reports) byProvider[r.provider_id] = (byProvider[r.provider_id] || 0) + 1;
  assert.equal(byProvider["openstreetmap-overpass"], overpass.elements.length);
  assert.equal(byProvider["fcc-uls-3650"], fcc.length);
});

test("a body no consulted provider could have produced is dropped, not guessed", async (t) => {
  // Neither an Overpass document nor a row array. Nothing may be invented from
  // it: a deconflicted site that cannot be re-serialized with its true source
  // is worse than a site that is simply absent.
  const frames = [
    { status: 200, headers: {}, bodyB64: Buffer.from('"not-a-provider-document"').toString("base64") },
  ];
  const reports = await parseWith(t, ["fcc-uls-3650", "openstreetmap-overpass"], frames);
  assert.deepEqual(reports, []);
});

test("a failed fetch does not shift every provider after it onto the wrong body", async (t) => {
  // The host emits a frame per request whatever happens, so slot 0 staying
  // present-but-empty is what keeps slot 1 pointing at its own provider.
  const overpass = JSON.parse(OVERPASS.toString("utf8"));
  const frames = [
    { status: 504, headers: {}, bodyB64: "" },
    { status: 200, headers: {}, bodyB64: Buffer.from(OVERPASS).toString("base64") },
  ];
  const reports = await parseWith(t, ["fcc-uls-3650", "openstreetmap-overpass"], frames);
  assert.equal(reports.length, overpass.elements.length);
  assert.ok(
    reports.every((r) => r.provider_id === "openstreetmap-overpass"),
    "the surviving body was attributed to the provider that failed",
  );
});

// --- the 2026-08-10 endpoint sweep -----------------------------------------
//
// These pin the three behaviours that replaced the compiled-in download pages.
// Every provider named here was reached with a successful live fetch before it
// was compiled in; the ones that could not be are gone (see the REMOVED block
// in the module source, each with its measurement).

const BAKOM = fs.readFileSync(
  new URL("./fixtures/bakom-mobile-sites.sample.json", import.meta.url),
);

test("swiss-geojson: LV95 easting/northing become real WGS84 degrees", async (t) => {
  const captured = JSON.parse(BAKOM.toString("utf8"));
  const reports = await parseWith(t, ["bakom-mobile-sites"], [
    httpResponse("bakom-mobile-sites", BAKOM),
  ]);
  assert.equal(
    reports.length,
    captured.features.length,
    `decoded ${reports.length} of ${captured.features.length} features`,
  );
  // The published coordinates are metres (e.g. 2732413, 1219730). Read as
  // degrees they fail the module's own range guard and EVERY row is dropped —
  // a provider that fetches 27 MB perfectly and contributes nothing, which
  // looks identical to a country with no masts.
  for (const r of reports) {
    assert.ok(
      r.latitude > 45.7 && r.latitude < 47.9,
      `latitude ${r.latitude} is not in Switzerland`,
    );
    assert.ok(
      r.longitude > 5.8 && r.longitude < 10.6,
      `longitude ${r.longitude} is not in Switzerland`,
    );
  }
  // A canton code in the operator's own site designator is an INDEPENDENT
  // check on the transform: a rotation or a swapped axis would still land
  // inside the country box above, but it would put the Geneva site somewhere
  // else. GE is Geneva, in the south-west corner.
  const geneva = reports.find((r) => (r.site_name ?? "").includes("GE_"));
  if (geneva) {
    assert.ok(
      geneva.latitude < 46.6 && geneva.longitude < 6.9,
      `a GE_ site landed at ${geneva.latitude},${geneva.longitude}, which is not Geneva`,
    );
  }
});

test("swiss-geojson: the highest generation present wins the radio class", async (t) => {
  const reports = await parseWith(t, ["bakom-mobile-sites"], [
    httpResponse("bakom-mobile-sites", BAKOM),
  ]);
  const captured = JSON.parse(BAKOM.toString("utf8"));
  for (const feature of captured.features) {
    const techno = feature.properties.techno_en ?? "";
    if (!techno.includes("5G")) continue;
    const report = reports.find((r) => r.site_name === feature.properties.station);
    // A site carrying 4G and 5G is a 5G site that also serves 4G. Reporting it
    // as LTE would understate it against a provider that reports NR for the
    // same mast, which then loses deconfliction for the wrong reason.
    assert.ok(report, `${feature.properties.station} did not decode`);
    assert.equal(report.radio, 4, "a 4G,5G site must report as NR");
  }
});

test("a WORLDWIDE request skips bounded providers instead of substituting a region", async (t) => {
  // The compiled-in default used to be a small box around Houston, so a caller
  // who named no region silently received one US metro drawn on a world globe.
  // That is the defect the owner reported as "a square in Texas / Louisiana".
  const { descriptors, job } = await routeFor(t, {
    PROVIDERS: ["openstreetmap-overpass", "fcc-uls-3650"],
    METHOD: "CENTROID",
    LIMIT: 400,
  });
  const asked = descriptors.map((d) => d.provider_id);
  assert.ok(!asked.includes("openstreetmap-overpass"), "a bounded provider was fetched worldwide");
  assert.ok(asked.includes("fcc-uls-3650"), "the bulk provider was not fetched worldwide");
  const skip = job.skipped.find((s) => s.provider_id === "openstreetmap-overpass");
  assert.ok(skip, "the bounded provider vanished instead of being reported");
  assert.equal(skip.needsRegion, true);
  assert.match(skip.reason, /BOUNDED region/u);
  // And the query it DID send must carry the whole planet, not a substitute.
  const fcc = descriptors.find((d) => d.provider_id === "fcc-uls-3650");
  assert.match(fcc.url, /-90\.000000%20and%2090\.000000/u);
});

test("the bounded BAKOM row contract fetches only the sufficient GeoJSON prefix", async (t) => {
  const { descriptors } = await routeFor(t, {
    PROVIDERS: ["bakom-mobile-sites"],
    METHOD: "HIGHEST_SAMPLE_COUNT",
    LIMIT: 2000,
  });
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].headers.range, "bytes=0-2097151");
  assert.equal(descriptors[0].responseWire, "raw-body-v1");
});

test("the four national bulk archives are fetched, not skipped", async (t) => {
  // SUPERSEDES "a bulk-ingest-only provider names the missing capability and is
  // never fetched" (graph: cell-tower-bulk-archive-adapters).
  //
  // That test pinned a REAL constraint honestly: each of these four was
  // verified live and none was fetchable, because this module decoded no ZIP
  // and no protobuf, and handing a ZIP to the CSV decoder returns 200 and
  // parses to zero rows. Refusing to fetch them was the correct behaviour for
  // as long as that was true.
  //
  // It is no longer true. miniz 3.1.2 is vendored and the module streams ZIP
  // members through a 32 KiB window, and the ComReg wire shape was recovered
  // from a live unauthenticated response. The decode side is covered by exact
  // counts in tests/bulk-archives.test.mjs; what this asserts is the ROUTE
  // side — the skip is gone and a descriptor is really emitted for each.
  const { descriptors, outcome } = await routeFor(t, {
    PROVIDERS: ["anfr-cartoradio", "acma-rrl", "ised-sms-tafl", "comreg-siteviewer"],
    METHOD: "CENTROID",
    LIMIT: 400,
  });
  assert.equal(descriptors.length, 4, "a national bulk archive was not fetched");
  for (const id of ["anfr-cartoradio", "acma-rrl", "ised-sms-tafl", "comreg-siteviewer"]) {
    assert.ok(
      descriptors.some((d) => d.provider_id === id),
      `${id} produced no request descriptor`,
    );
    assert.equal(
      outcome.skipped.find((s) => s.provider_id === id),
      undefined,
      `${id} is still skipped`,
    );
  }
  // A ZIP is fetched WHOLE at every lane: its central directory is at the end
  // of the file, so a Range prefix is undecodable rather than merely smaller.
  for (const id of ["anfr-cartoradio", "acma-rrl", "ised-sms-tafl"]) {
    const d = descriptors.find((x) => x.provider_id === id);
    assert.equal(d.headers.range, undefined, `${id} asked for a byte range`);
  }
});

test("the providers that could not be reached at all are GONE, not carried dead", async (t) => {
  // Measured dead on 2026-08-10: a maintenance page, an export switched off in
  // the viewer's own config, and a host that no longer resolves. An honest
  // smaller list beats twelve dead ones, and the proof that one is really gone
  // is that the registry no longer KNOWS it — not merely that it is skipped,
  // which is a different and weaker claim.
  //
  // `mls-archive` LEFT THIS LIST ON 2026-08-26, on evidence. What was measured
  // dead in August was location.services.mozilla.com — the retired service. The
  // register itself survives as one final full cell export on the Internet
  // Archive, which answered live that day: 302 -> 200, 1,565,271,921 B,
  // `Range: bytes=0-3145727` -> 206 with exactly 3,145,728 B, inflating to
  // 9,749,556 B / 127,940 rows of the OpenCelliD bulk column contract. "The
  // service is retired" and "the data is unreachable" are different claims and
  // only the first one was true (graph: sdn-cellular-ingest-lands-no-batch).
  const gone = ["bnetza-emf", "nl-antenneregister", "nz-rsm-rrf"];
  const { descriptors, outcome } = await routeFor(t, {
    PROVIDERS: gone,
    METHOD: "CENTROID",
    LIMIT: 400,
  });
  assert.equal(descriptors.length, 0, "a removed provider was fetched");
  for (const id of gone) {
    const skip = outcome.skipped.find((s) => s.provider_id === id);
    assert.ok(skip, `${id} vanished silently`);
    assert.equal(skip.reason, "unknown provider", `${id} is still in the registry`);
  }
});
