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

const httpResponse = (providerId, body) => ({
  provider_id: providerId,
  status: 200,
  headers: { "content-type": "application/json" },
  bodyB64: Buffer.from(body).toString("base64"),
});

async function routeFor(t, body) {
  const harness = await harnessFor(t);
  const response = await harness.invoke({ methodId: "route", inputs: [htqRequest(JSON.stringify(body))] });
  return {
    harness,
    job: jsonFrame(byPort(response), "job"),
    descriptors: framesFor(response, "requests").map((f) => JSON.parse(decoder.decode(f.payload))),
  };
}

async function parseWith(t, providers, responses, body = {}) {
  const { harness, job } = await routeFor(t, { PROVIDERS: providers, METHOD: "CENTROID", LIMIT: 400, ...body });
  const parsed = byPort(
    await harness.invoke({
      methodId: "parse",
      inputs: [jsonInput("job", job), ...responses.map((r) => jsonInput("responses", r))],
    }),
  );
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
  assert.match(descriptors[0].url, /29\.600000%20and%2030\.100000/u, "inverted bbox was not rejected");
});
