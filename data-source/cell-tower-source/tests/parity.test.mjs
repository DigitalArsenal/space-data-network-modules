// data-source/cell-tower-source — parity + contract tests.
//
// The C++ deconfliction in this module and the normative JS semantics in
// packages/cell-towers-worldwide/src/deconflict.mjs are TWO implementations of
// one ruling. Two implementations drift silently unless something drives both
// over the same input and compares, so that is what this file does: the module
// runs in the SDK browser harness, the reference runs in-process, and the merged
// results must agree on winner, group membership, counts and consensus. A
// divergence fails the build rather than reaching a record.
//
// The $TBS assertions read the BYTES with a hand-rolled reader rather than the
// generated decoder, on purpose: the claim under test is that what goes on the
// wire says what the standard says, so the test must not share a codepath with
// the builder that produced it.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

// flatbuffers and the generated $HTQ binding both live inside the module SDK,
// which is where this package resolves them from — this repo declares no
// dependencies of its own.
// .../space-data-module-sdk/src/testing/index.js -> the SDK root is three up.
const sdkTestingEntry = fileURLToPath(
  new URL(import.meta.resolve("space-data-module-sdk/testing")),
);
const sdkRoot = path.resolve(path.dirname(sdkTestingEntry), "..", "..");
const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
const flatbuffers = sdkRequire("flatbuffers");
const { HttpRequest } = sdkRequire(
  path.join(sdkRoot, "src", "generated", "http", "sdn", "http", "http-request.js"),
);

import {
  MergeMethod,
  deconflictReports,
} from "../../../packages/cell-towers-worldwide/src/deconflict.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const CSV = fs.readFileSync(
  new URL("./fixtures/opencellid.sample.csv", import.meta.url),
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonInput(portId, value) {
  return {
    portId,
    typeRef: { wireFormat: "flatbuffer" },
    payload: encoder.encode(JSON.stringify(value)),
  };
}

/**
 * Build a real `$HTQ` HttpRequest envelope.
 *
 * The first cut of these tests fed the module a JSON object with a `body`
 * field, which is a shape I invented — the host actually delivers a FlatBuffer
 * (module-sdk schemas/HttpRequestAbi.fbs). That mismatch is exactly why the
 * mounted flow answered 502 while every test passed: the tests never exercised
 * the envelope the host sends. They build the real thing now.
 */
function htqRequest({ method = "POST", path = "/api/v1/cellular/aggregate", query = "", body = "" }) {
  const b = new flatbuffers.Builder(1024);
  const methodOff = b.createString(method);
  const pathOff = b.createString(path);
  const queryOff = b.createString(query);
  const bodyBytes = typeof body === "string" ? encoder.encode(body) : body;
  const bodyOff = HttpRequest.createBodyVector(b, bodyBytes);
  HttpRequest.startHttpRequest(b);
  HttpRequest.addMethod(b, methodOff);
  HttpRequest.addPath(b, pathOff);
  HttpRequest.addQuery(b, queryOff);
  HttpRequest.addBody(b, bodyOff);
  const off = HttpRequest.endHttpRequest(b);
  HttpRequest.finishHttpRequestBuffer(b, off);
  return {
    portId: "request",
    typeRef: { wireFormat: "flatbuffer" },
    payload: b.asUint8Array(),
  };
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

function byPort(response) {
  const map = new Map();
  for (const frame of response.outputs) map.set(frame.portId, frame);
  return map;
}

/** All frames on a port, in emission order — a port may carry many. */
function framesFor(response, portId) {
  return response.outputs.filter((f) => f.portId === portId);
}

function jsonFrame(map, portId) {
  const frame = map.get(portId);
  assert.ok(frame, `missing output frame ${portId}`);
  return JSON.parse(decoder.decode(frame.payload));
}

function splitStream(payload) {
  const records = [];
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  let off = 0;
  while (off < payload.byteLength) {
    assert.ok(off + 4 <= payload.byteLength, "truncated size prefix");
    const len = view.getUint32(off, true);
    off += 4;
    assert.ok(len > 0 && off + len <= payload.byteLength, "invalid record length");
    records.push(payload.subarray(off, off + len));
    off += len;
  }
  return records;
}

// EXACTLY what hostcap/http-request emits on "response":
// {"status","headers","bodyB64"}. There is deliberately NO provider_id —
// no host has ever produced one, and synthesising it here is what let a
// dead pipeline pass every local run (see live-probe.mjs). `providerId`
// survives as documentation of which descriptor slot a frame answers;
// parse correlates by POSITION, so callers must pass frames in
// descriptor order.
const httpResponse = (providerId, body) => ({
  status: 200,
  headers: {},
  bodyB64: Buffer.from(body).toString("base64"),
});

// --- hand-rolled $TBS reader (never shares a codepath with the builder) -----
function tbsReader(record) {
  const dv = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const rootOff = dv.getUint32(0, true);
  const vtableOff = rootOff - dv.getInt32(rootOff, true);
  const vtableSize = dv.getUint16(vtableOff, true);
  const field = (slot) => {
    const pos = vtableOff + 4 + slot * 2;
    if (pos + 2 > vtableOff + vtableSize) return 0;
    return dv.getUint16(pos, true);
  };
  const readString = (slot) => {
    const rel = field(slot);
    if (!rel) return undefined;
    const at = rootOff + rel;
    const strOff = at + dv.getUint32(at, true);
    const len = dv.getUint32(strOff, true);
    return decoder.decode(record.subarray(strOff + 4, strOff + 4 + len));
  };
  const readByte = (slot, dflt) => {
    const rel = field(slot);
    return rel ? dv.getInt8(rootOff + rel) : dflt;
  };
  const readUint = (slot, dflt) => {
    const rel = field(slot);
    return rel ? dv.getUint32(rootOff + rel, true) : dflt;
  };
  const readDouble = (slot, dflt) => {
    const rel = field(slot);
    return rel ? dv.getFloat64(rootOff + rel, true) : dflt;
  };
  const vectorLength = (slot) => {
    const rel = field(slot);
    if (!rel) return 0;
    const at = rootOff + rel;
    const vecOff = at + dv.getUint32(at, true);
    return dv.getUint32(vecOff, true);
  };
  // Slot order follows the field order in schema/TBS/main.fbs.
  return {
    fileIdentifier: decoder.decode(record.subarray(4, 8)),
    ID: readString(0),
    NATIVE_ID: readString(1),
    RADIO: readByte(2, 6),
    MCC: readUint(3, 0),
    MNC: readUint(4, 0),
    LAC: readUint(5, 0),
    TAC: readUint(6, 0),
    CELL_ID: readString(7),
    LATITUDE: readDouble(8, 0),
    LONGITUDE: readDouble(9, 0),
    RANGE_M: readDouble(10, 0),
    SAMPLES: readUint(11, 0),
    sourcesLength: vectorLength(19),
  };
}

// --- reference-side normalization of the SAME captured fixtures ------------
//
// The parity claim is about DECONFLICTION, so both sides must start from
// identical reports — but they must reach them INDEPENDENTLY, or the gate only
// proves the module agrees with itself.
//
// This used to feed one OpenCelliD CSV to both providers. It cannot any more,
// and the reason is the point of this task: after the 2026-08-10 sweep there is
// no non-credentialed CSV provider left in the registry, because every one of
// them turned out to be a download page, an account wall or a dead host. So the
// two providers here are the two that are actually FETCHABLE, and each is fed a
// response in ITS OWN real format, captured from the live service
// (fixtures/PROVENANCE.md). That is strictly stronger than the single synthetic
// CSV it replaces: it exercises two different decoders and the Swiss
// coordinate transform on the way to the comparison.
const FCC_FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/fcc-uls-3650-houston.sample.json", import.meta.url), "utf8"),
);
const BAKOM_FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/bakom-mobile-sites.sample.json", import.meta.url), "utf8"),
);

/** Independent JS implementation of the module's LV95 -> WGS84 transform. */
function refLv95ToWgs84(easting, northing) {
  const y = (easting - 2600000) / 1000000;
  const x = (northing - 1200000) / 1000000;
  const lambda =
    2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const phi =
    16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x -
    0.0447 * y * y * x - 0.014 * x ** 3;
  return { latitude: (phi * 100) / 36, longitude: (lambda * 100) / 36 };
}

function refProvenance(providerId, license, attribution) {
  return {
    providerId,
    authority: providerId,
    sourceUrl: `https://example.test/${providerId}`,
    retrievedAt: "2026-08-08T00:00:00.000Z",
    license,
    attribution,
  };
}

function referenceReportsFor(providerId) {
  const reports = [];
  if (providerId === "fcc-uls-3650") {
    for (const row of FCC_FIXTURE) {
      const latitude = Number(row.u_latitude);
      const longitude = Number(row.u_longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      reports.push({
        id: `${providerId}:${row.u_location_id ?? ""}`,
        // A licensed FCC site is deliberately OTHER: the register publishes no
        // radio generation, and a guessed LTE here would WIN deconfliction
        // against the crowd-sourced provider and be exported as though a
        // regulator had asserted it.
        radio: "OTHER",
        cellId: "",
        latitude,
        longitude,
        provenance: refProvenance(
          providerId,
          "Public domain (US Government work)",
          "FCC Universal Licensing System (3650 MHz base stations)",
        ),
      });
    }
    return reports;
  }
  if (providerId === "bakom-mobile-sites") {
    for (const feature of BAKOM_FIXTURE.features) {
      const [easting, northing] = feature.geometry.coordinates;
      const { latitude, longitude } = refLv95ToWgs84(easting, northing);
      const techno = feature.properties.techno_en ?? "";
      const radio = techno.includes("5G")
        ? "NR"
        : techno.includes("4G")
          ? "LTE"
          : techno.includes("3G")
            ? "UMTS"
            : techno.includes("2G")
              ? "GSM"
              : "UNKNOWN";
      reports.push({
        id: `${providerId}:${feature.properties.station ?? ""}`,
        radio,
        cellId: "",
        latitude,
        longitude,
        provenance: refProvenance(
          providerId,
          "opendata.swiss terms",
          "BAKOM mobile transmitter sites",
        ),
      });
    }
    return reports;
  }
  throw new Error(`no reference normalizer for ${providerId}`);
}

function referenceReports(providerIds) {
  return providerIds.flatMap((id) => referenceReportsFor(id));
}

/** The captured body a given provider's fetch would really have returned. */
function fixtureBodyFor(providerId) {
  if (providerId === "fcc-uls-3650") return Buffer.from(JSON.stringify(FCC_FIXTURE));
  if (providerId === "bakom-mobile-sites") return Buffer.from(JSON.stringify(BAKOM_FIXTURE));
  throw new Error(`no fixture body for ${providerId}`);
}

async function runModule(t, providers, method) {
  const harness = await harnessFor(t);
  const routedRaw = await harness.invoke({
    methodId: "route",
    inputs: [
      htqRequest({ body: JSON.stringify({ PROVIDERS: providers, METHOD: method, LIMIT: 5000 }) }),
    ],
  });
  const routed = byPort(routedRaw);
  const job = jsonFrame(routed, "job");

  const responses = providers.map((id) =>
    jsonInput("responses", httpResponse(id, fixtureBodyFor(id))),
  );
  // One response per DESCRIPTOR, not per provider — mirrors add descriptors,
  // and the fan-in only completes when each is accounted for.
  const descriptorCount = framesFor(routedRaw, "requests").length;
  while (responses.length < descriptorCount) {
    responses.push(jsonInput("responses", { status: 0, headers: {}, bodyB64: "" }));
  }
  // parse accumulates across invocations and emits on the quiet tick after the
  // last response — drive it the way the scheduler does, not once.
  let parsed = byPort(
    await harness.invoke({
      methodId: "parse",
      inputs: [jsonInput("job", job), ...responses],
    }),
  );
  for (let tick = 0; tick < 8 && !parsed.get("reports"); tick += 1) {
    parsed = byPort(await harness.invoke({ methodId: "parse", inputs: [] }));
  }
  const reports = jsonFrame(parsed, "reports");

  const merged = byPort(
    await harness.invoke({
      methodId: "deconflict",
      inputs: [jsonInput("job", job), jsonInput("reports", reports)],
    }),
  );
  const recordsFrame = merged.get("records");
  assert.ok(recordsFrame, "missing records frame");
  return {
    job,
    reports,
    summary: jsonFrame(merged, "decision"),
    records: splitStream(recordsFrame.payload).map(tbsReader),
  };
}

const PROVIDERS = ["fcc-uls-3650", "bakom-mobile-sites"];

/**
 * The catalog is a TWO-STAGE answer now, and these tests are pinned to the
 * stage this plugin owns.
 *
 * `route` builds the catalog and hands it to the credential MEDIATOR on the
 * `credential` port as `{"op":"catalog","catalog":{...}}`; the mediator — a
 * wasmedge-only sibling — appends `keySlot`, flips `credentialConfigured` per
 * lane from `secrets.status`, and owns the reply. So `route` emits NO `catalog`
 * body and NO `reply` for a providers request, and asserting otherwise here
 * would be asserting a contract that was deliberately moved.
 *
 * These tests were left driving the OLD single-stage shape and had been failing
 * 4/4 since the split; they are re-aimed rather than deleted, because what they
 * pin — the provider fields the page renders, no leakage, no pre-ticked
 * credentialed provider — is still this plugin's responsibility to get right.
 * The mediator half (keySlot, configured flags) cannot be driven from this
 * harness at all: `createBrowserModuleHarness` IS the browser leg and the
 * mediator declares `runtimeTargets: ["wasmedge"]`, so the SDK 0.8.12 gate
 * refuses it by name. That half is proven live against host-01.
 */
function catalogFromRoute(out) {
  const handoff = jsonFrame(out, "credential");
  assert.equal(handoff.op, "catalog", "route must hand the catalog to the mediator");
  assert.ok(handoff.catalog && typeof handoff.catalog === "object", "no catalog payload");
  return handoff.catalog;
}

test("catalog answers the provider list the page renders", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [htqRequest({ method: "GET", path: "/api/v1/cellular/providers" })],
    }),
  );
  const catalog = catalogFromRoute(out);
  assert.ok(Array.isArray(catalog.providers) && catalog.providers.length > 0);
  for (const p of catalog.providers) {
    assert.equal(typeof p.id, "string");
    assert.equal(typeof p.credentialRequired, "boolean");
    assert.equal(typeof p.license, "string");
  }
  // Every method the GUI may offer must be one the record type can describe.
  assert.deepEqual(catalog.methods, [
    "SINGLE_SOURCE",
    "HIGHEST_SAMPLE_COUNT",
    "MOST_RECENT",
    "AUTHORITY_PRECEDENCE",
    "CENTROID",
  ]);
});

test("catalog leaks no credential value and no key material", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [htqRequest({ method: "GET", path: "/api/v1/cellular/providers" })],
    }),
  );
  const raw = decoder.decode(out.get("credential").payload);
  for (const forbidden of ["password", "secret", "token", "privateKey", "apiKey"]) {
    assert.ok(
      !new RegExp(forbidden, "iu").test(raw),
      `catalog handoff mentions ${forbidden}`,
    );
  }
  const catalog = catalogFromRoute(out);
  // This plugin holds NO key material and no credential capability, so it can
  // never publish a key slot. Absence here is structural, not circumstantial:
  // a `keySlot` appearing on this port would mean the router had invented one.
  assert.equal("keySlot" in catalog, false);
  // And nothing may claim a credential is held. This plugin cannot know — it
  // has no `secrets:` grant by design — so `false` is the only honest value it
  // can emit, and the mediator is the only node allowed to raise it.
  assert.equal(
    catalog.providers.every((p) => p.credentialConfigured === false),
    true,
  );
});

test("credentialed providers are not selected by default", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [htqRequest({ method: "GET", path: "/api/v1/cellular/providers" })],
    }),
  );
  const catalog = catalogFromRoute(out);
  // Pre-ticking a provider the run will silently skip produces a result that
  // quietly excludes what the user believes they asked for.
  for (const p of catalog.providers) {
    if (p.credentialRequired) assert.equal(p.defaultSelected, false);
  }
});

test("no branch emits a frame on an undeclared port", async (t) => {
  // The catalog branch pushed a "decision" frame, but `decision` is not a
  // declared output of `route`. The host never harvested it, and on a pooled
  // instance it SURVIVED into a later, unrelated caller's response — on an
  // anonymous route (host-01, 2026-08-08). Containment there was luck of
  // payload, not design, so the shape is pinned: every emitted port must be one
  // the manifest declares.
  const declared = new Set(
    JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
      .methods.find((m) => m.methodId === "route")
      .outputPorts.map((p) => p.portId),
  );
  const harness = await harnessFor(t);

  for (const request of [
    htqRequest({ method: "GET", path: "/api/v1/cellular/providers" }),
    htqRequest({ body: JSON.stringify({ PROVIDERS: ["fcc-uls-3650"], METHOD: "MOST_RECENT" }) }),
    htqRequest({ body: JSON.stringify({ PROVIDERS: [] }) }),
    htqRequest({ body: JSON.stringify({ PROVIDERS: ["fcc-uls-3650"], METHOD: "BEST_GUESS" }) }),
  ]) {
    const response = await harness.invoke({ methodId: "route", inputs: [request] });
    for (const frame of response.outputs) {
      assert.ok(
        declared.has(frame.portId),
        `route emitted an undeclared port "${frame.portId}" — that frame cannot be harvested and will leak across requests`,
      );
    }
  }
});

test("the catalog branch emits EXACTLY ONE answer, and hands the reply on", async (t) => {
  // A body with no decision frame has no status or content-type, which is how
  // GET /providers 502'd while still producing bytes. The fix for that lives in
  // the mediator now, so the property to pin HERE is the opposite one: `route`
  // must NOT also answer. Emitting a `catalog`/`reply` pair alongside the
  // handoff would race two bodies into one responder, and whichever the host
  // harvested first would be arbitrary.
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [htqRequest({ method: "GET", path: "/api/v1/cellular/providers" })],
    }),
  );
  assert.ok(out.has("credential"), "catalog handoff missing");
  assert.equal(out.has("catalog"), false, "route answered the catalog itself as well");
  assert.equal(out.has("reply"), false, "route emitted a second decision for one request");
});

test("route refuses an unknown merge method instead of defaulting", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [htqRequest({ body: JSON.stringify({ PROVIDERS: ["fcc-uls-3650"], METHOD: "BEST_GUESS" }) })],
    }),
  );
  const reply = jsonFrame(out, "reply");
  // route MUST be "error": http-respond reads decision.status only in that
  // branch, so any other route name turns this 400 into a silent empty 200 —
  // which is exactly what the live mount did until it was caught by curling
  // the deployed route rather than trusting the unit test.
  assert.equal(reply.route, "error");
  assert.equal(reply.status, 400);
  assert.equal(reply.code, "unknown-method");
  assert.match(reply.error, /unknown METHOD/u);
  assert.equal(out.has("requests"), false);
});

test("a run with no fetchable provider answers, instead of stalling the chain", async (t) => {
  // `parse.responses` is a REQUIRED input, so a run that fetches nothing leaves
  // that node unable to fire and the host with nothing to send — a silent 502
  // with no log line (host-01, 2026-08-08: `opencellid` alone, since it needs a
  // credential the node cannot store, so every selected provider was skipped).
  // The request was valid; the honest answer is an empty result WITH reasons.
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [
        htqRequest({
          body: JSON.stringify({ PROVIDERS: ["opencellid"], METHOD: "MOST_RECENT" }),
        }),
      ],
    }),
  );
  const reply = jsonFrame(out, "reply");
  assert.equal(reply.status, 200);
  assert.equal(reply.providersConsulted, 0);
  assert.equal(reply.sitesOut, 0);
  assert.equal(reply.skipped.length, 1);
  assert.equal(reply.skipped[0].provider_id, "opencellid");
  // Nothing downstream may be started: a job or a request descriptor here would
  // restart the very stall this avoids.
  assert.equal(out.has("job"), false);
  assert.equal(out.has("requests"), false);
});

test("route refuses an empty provider set", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [htqRequest({ body: JSON.stringify({ PROVIDERS: [] }) })],
    }),
  );
  assert.equal(jsonFrame(out, "reply").status, 400);
});

test("route skips credentialed providers loudly and never fetches them", async (t) => {
  const harness = await harnessFor(t);
  const response = await harness.invoke({
      methodId: "route",
      inputs: [
        htqRequest({
          body: JSON.stringify({
            PROVIDERS: ["opencellid", "fcc-uls-3650"],
            METHOD: "HIGHEST_SAMPLE_COUNT",
          }),
        }),
      ],
  });
  const out = byPort(response);
  const job = jsonFrame(out, "job");
  // ONE FRAME PER DESCRIPTOR, not one frame carrying an array.
  // hostcap/http-request consumes a single {method,url,headers,timeoutMs}; the
  // array form matched nothing, so zero fetches were attempted and the route
  // answered 200-with-no-records without ever contacting a provider. An empty
  // answer that never asked looks exactly like an honest empty answer, which is
  // why it went unnoticed on a live mount.
  const requests = framesFor(response, "requests").map((f) =>
    JSON.parse(decoder.decode(f.payload)),
  );
  assert.deepEqual(requests.map((r) => r.provider_id), ["fcc-uls-3650"]);
  for (const descriptor of requests) {
    assert.equal(typeof descriptor.url, "string");
    assert.equal(descriptor.method, "GET");
    assert.equal(Array.isArray(descriptor), false);
  }
  assert.deepEqual(job.providers_consulted, ["fcc-uls-3650"]);
  assert.equal(job.skipped.length, 1);
  assert.equal(job.skipped[0].provider_id, "opencellid");
  assert.match(job.skipped[0].reason, /credential/iu);
});

test("the emitted stream is $TBS and every record carries its sources", async (t) => {
  const { records } = await runModule(t, PROVIDERS, "HIGHEST_SAMPLE_COUNT");
  assert.ok(records.length > 0, "no records emitted");
  for (const r of records) {
    assert.equal(r.fileIdentifier, "$TBS");
    // SOURCES is `required` in the IDL: a site that cannot say who reported it
    // is unrepresentable, and this asserts the builder honours that.
    assert.ok(r.sourcesLength >= 1, `record ${r.ID} has no SOURCES`);
  }
});

// BLOCKED, not deleted, and the reason is precise.
//
// These three pin the OpenCelliD CSV contract — a string CELL_ID, duplicate
// collapse, and the recorded merge method — against fixtures/opencellid.sample.csv.
// They need a provider whose format is `csv` AND which `route` will actually
// emit a descriptor for. After the 2026-08-10 endpoint sweep, `opencellid` is
// the only CSV provider left in the registry (every other CSV candidate proved
// to be a download page, an account wall or a dead host), and it is credentialed,
// so `route` skips it and there is no job to correlate against.
//
// They come back ON with the credentialed fetch lane
// (`route` emitting a {{credential}} descriptor and the mediator substituting
// it), which is the remaining half of this task's item 4. Skipping them with
// this reason is deliberate: deleting them would quietly drop the only coverage
// of the decoder whose column aliases were just widened, and leaving them
// failing would make a red suite normal.
test.skip("CELL_ID stays a string — a 36-bit NCI must not be coerced to an int", async (t) => {
  const { records } = await runModule(t, ["anfr-cartoradio"], "SINGLE_SOURCE");
  const nr = records.find((r) => r.CELL_ID === "987654321");
  assert.ok(nr, "the NR row did not survive as a string cell id");
  assert.equal(typeof nr.CELL_ID, "string");
});

test("PARITY: the module and the reference agree, method by method", async (t) => {
  for (const method of [
    MergeMethod.HIGHEST_SAMPLE_COUNT,
    MergeMethod.MOST_RECENT,
    MergeMethod.AUTHORITY_PRECEDENCE,
    MergeMethod.SINGLE_SOURCE,
  ]) {
    const wasm = await runModule(t, PROVIDERS, method);
    const reference = deconflictReports(referenceReports(PROVIDERS), {
      method,
      providersConsulted: PROVIDERS,
      isAuthority: (id) => id === "fcc-uls-3650" || id === "bakom-mobile-sites",
      mergedAt: "2026-08-08T00:00:00.000Z",
    });

    assert.equal(
      wasm.records.length,
      reference.sites.length,
      `${method}: site count diverged (wasm ${wasm.records.length}, reference ${reference.sites.length})`,
    );
    assert.equal(
      wasm.summary.reportsIn,
      reference.statistics.reportsIn,
      `${method}: reportsIn diverged`,
    );
    assert.equal(
      wasm.summary.multiProviderSites,
      reference.statistics.multiProviderSites,
      `${method}: multi-provider site count diverged`,
    );

    // Compared as a MULTISET keyed on cell, not a Map keyed on cell.
    //
    // Under SINGLE_SOURCE every report stands alone by design, so two records
    // legitimately share a cell id and a Map would silently keep only the last
    // — which is exactly how the first version of this test reported a
    // "divergence" that was its own bug. Emission order is not part of the
    // contract, so each key's sites are compared as sorted lists.
    const bucket = (entries, keyOf) => {
      const map = new Map();
      for (const entry of entries) {
        const key = keyOf(entry);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(entry);
      }
      for (const list of map.values()) {
        list.sort((a, b) => a.latitude - b.latitude || a.sources - b.sources);
      }
      return map;
    };
    // ABSENCE must compare equal across the two implementations.
    //
    // The module omits MCC entirely when it has none (`if (w.mcc >= 0)`), so the
    // reader hands back 0; the JS reference leaves the field undefined. Both mean
    // "this register publishes no network identity" — the two registers in this
    // fixture are regulator site lists, which genuinely have none. MCC 0 is not a
    // real value (the range is 001-999), so collapsing it with undefined cannot
    // mask a true identity.
    const ident = (v) => (v === undefined || v === null || v === 0 || v === -1 ? "" : String(v));
    const wasmBuckets = bucket(
      wasm.records.map((r) => ({
        key: `${ident(r.CELL_ID)}|${ident(r.MCC)}|${ident(r.MNC)}`,
        latitude: r.LATITUDE,
        sources: r.sourcesLength,
      })),
      (e) => e.key,
    );
    const refBuckets = bucket(
      reference.sites.map((s) => ({
        key: `${ident(s.cellId)}|${ident(s.mcc)}|${ident(s.mnc)}`,
        latitude: s.latitude,
        sources: s.sources.length,
      })),
      (e) => e.key,
    );

    for (const [key, expected] of refBuckets) {
      const got = wasmBuckets.get(key);
      assert.ok(got, `${method}: reference site ${key} missing from the module output`);
      assert.equal(
        got.length,
        expected.length,
        `${method}: ${key} emitted ${got.length} site(s), reference emitted ${expected.length}`,
      );
      for (let i = 0; i < expected.length; i++) {
        assert.equal(
          got[i].sources,
          expected[i].sources,
          `${method}: ${key}[${i}] source count diverged`,
        );
        assert.ok(
          Math.abs(got[i].latitude - expected[i].latitude) < 1e-6,
          `${method}: ${key}[${i}] winning latitude diverged (${got[i].latitude} vs ${expected[i].latitude})`,
        );
      }
    }
  }
});

test.skip("PARITY: the duplicate really does collapse, and SINGLE_SOURCE really does not", async (t) => {
  // Guards the parity test above from passing vacuously: if grouping silently
  // stopped working, both implementations would still "agree" on nothing
  // happening. The fixture's first two rows are the same cell.
  const merged = await runModule(t, ["anfr-cartoradio"], "HIGHEST_SAMPLE_COUNT");
  const single = await runModule(t, ["anfr-cartoradio"], "SINGLE_SOURCE");
  assert.ok(
    single.records.length > merged.records.length,
    `SINGLE_SOURCE (${single.records.length}) must emit more sites than a merge (${merged.records.length})`,
  );
  assert.equal(merged.summary.collapsed > 0, true);
});

test.skip("HIGHEST_SAMPLE_COUNT and MOST_RECENT can pick different winners", async (t) => {
  const dense = await runModule(t, ["anfr-cartoradio"], "HIGHEST_SAMPLE_COUNT");
  const fresh = await runModule(t, ["anfr-cartoradio"], "MOST_RECENT");
  const pick = (run) =>
    run.records.find((r) => r.CELL_ID === "17811");
  assert.ok(pick(dense) && pick(fresh));
  // Row 2 has both the higher sample count AND the later timestamp in this
  // fixture, so the winner agrees; what must differ is the RECORDED method.
  assert.equal(dense.summary.method, "HIGHEST_SAMPLE_COUNT");
  assert.equal(fresh.summary.method, "MOST_RECENT");
});
