// data-source/celestrak-supgp end to end on the typed contracts (1.0): the compiled wasm in the SDK browser harness,
// node config served by plugin.getConfig (hostOptions.config), a TimerTick (TICK) in, HttpRequests (HREQ) out with
// the $ICN parse job in CONTEXT; the SupGP-shaped fixtures (synthetic numbers, test/fixtures/PROVENANCE.md) handed back
// as the HttpResponses (HRSP) hostcap/http-request answers, each carrying its request's CONTEXT; IngestRequest (INGQ),
// the size-prefixed $OMM stream, the raw HttpResponse and FlowNotices (FNTC) out.
//
// The legacy artifact stored each object as OMM JSON text, so there are no legacy bytes to keep identical: the $OMM
// fields are checked against the feed values the legacy record copied (strtod of the same text) and its constants.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { ByteBuffer } from "flatbuffers";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import {
  decodeFlowNotice,
  decodeHttpRequest,
  decodeIngestRequest,
  encodeHttpResponse,
  encodeTimerTick,
} from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { CelestialFrame, OMM, RFMUnion, ephemerisFormat, meanElementSource } from "spacedatastandards.org/lib/js/OMM/main.js";
import { ICN } from "spacedatastandards.org/lib/js/ICN/main.js";

const here = (p) => new URL(p, import.meta.url).pathname;
const wasmPath = here("../dist/isomorphic/module.wasm");
const manifest = JSON.parse(fs.readFileSync(here("../plugin-manifest.json"), "utf8"));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ?? here("../node_modules/spacedatastandards.org/");
const fixture = (name) => fs.readFileSync(here(`./fixtures/${name}`));
const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
};
const BASE = "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php";
// Registry token -> source name and fixture (records = valid objects in the fixture).
const REGISTRY = {
  "SES-E": { sourceName: "ses", fixture: "SES-E.trimmed.json", records: 4 },
  Planet: { sourceName: "planet", fixture: "Planet.trimmed.json", records: 4 },
  Iridium: { sourceName: "iridium", fixture: "Iridium.trimmed.json", records: 4 },
  Telesat: { sourceName: "telesat", fixture: "Telesat.trimmed.json", records: 4 },
  "Kuiper-E": { sourceName: "kuiper", fixture: "Kuiper-E.trimmed.json", records: 4 },
  AST: { sourceName: "ast-spacemobile", fixture: "AST.trimmed.json", records: 10 },
  "CSS-E": { sourceName: "css", fixture: "CSS-E.trimmed.json", records: 3 },
};

async function harness(t, config = {}) {
  const host = await createBrowserModuleHarness({ wasmSource: new Uint8Array(fs.readFileSync(wasmPath)), manifest, surface: "direct", hostOptions: { config } });
  t.after(() => host.destroy());
  return host;
}
const ok = (r) => { assert.equal(r.statusCode, 0, r.errorMessage); return r; };
const tick = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "supgp-pull", firedMs: Date.UTC(2026, 9, 14) }) });
const framesOn = (r, port) => r.outputs.filter((f) => f.portId === port);

// The GETs request asks for, decoded with their $ICN jobs.
async function requests(host) {
  return framesOn(ok(await host.invoke({ methodId: "request", inputs: [tick()] })), "requests").map((f) => {
    assert.equal(f.typeRef.fileIdentifier, "HREQ");
    const req = decodeHttpRequest(f.payload);
    const icn = ICN.getSizePrefixedRootAsICN(new ByteBuffer(req.context));
    return { req, job: { connector: icn.CONNECTOR_ID(), dataset: icn.DATASET_ID(), sourceName: icn.SOURCE_NAME(), url: icn.ENDPOINT_URL(), provider: icn.PROVIDER_ID(), target: icn.TARGET_SCHEMA() } };
  });
}
// hostcap/http-request's answer to a request: CONTEXT echoed.
const answer = (req, body, { status = 200, error = "", headers = {} } = {}) => ({
  portId: "response", typeRef: TYPE.HRSP,
  payload: encodeHttpResponse({ url: req.url, status, error, headers, body: new Uint8Array(body), context: req.context, retrievedMs: Date.UTC(2026, 9, 14, 1) }),
});
function splitStream(bytes) {
  const out = [];
  const view = Buffer.from(bytes);
  for (let off = 0; off < view.length;) { const n = view.readUInt32LE(off); out.push(view.subarray(off + 4, off + 4 + n)); off += 4 + n; }
  return out;
}
const omms = (r) => {
  const [frame] = framesOn(r, "omm_records");
  assert.equal(frame.typeRef.fileIdentifier, "$OMM");
  return splitStream(frame.payload).map((b) => {
    assert.ok(OMM.bufferHasIdentifier(new ByteBuffer(new Uint8Array(b))));
    return OMM.getRootAsOMM(new ByteBuffer(new Uint8Array(b))).unpack();
  });
};
const params = (o) => Object.fromEntries(o.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));

test("the artifact validates, and every port names one concrete FlatBuffer type", async () => {
  const result = await validateArtifactWithStandards({ wasmPath, manifest, standardsRoot });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(manifest.capabilities, []);
  for (const method of manifest.methods) {
    for (const port of [...method.inputPorts, ...method.outputPorts]) {
      const types = port.acceptedTypeSets.flatMap((s) => s.allowedTypes);
      assert.equal(types.length, 1, `${method.methodId}.${port.portId}`);
      assert.equal(types[0].wireFormat, "flatbuffer");
      assert.ok(!types[0].acceptsAnyFlatbuffer);
    }
  }
});

test("request: one GET per registry token, each with its $ICN parse job", async (t) => {
  const out = await requests(await harness(t));
  assert.deepEqual(out.map((o) => o.req.url), Object.keys(REGISTRY).map((token) => `${BASE}?SOURCE=${token}&FORMAT=JSON`));
  for (const { req, job } of out) {
    const token = new URL(req.url).searchParams.get("SOURCE");
    assert.equal(req.method, "GET");
    assert.deepEqual(job, { connector: `celestrak-supgp-${token}`, dataset: `supgp-${token}`, sourceName: REGISTRY[token].sourceName, url: req.url, provider: "space-data-network-02", target: "OMM.fbs" });
  }
});

test("request: config names one token (sourceName defaults to its lower case) and the format", async (t) => {
  const out = await requests(await harness(t, { token: "OneWeb", format: "CSV", baseUrl: "https://mirror.test/sup-gp.php", providerId: "node-7" }));
  assert.equal(out.length, 1);
  assert.equal(out[0].req.url, "https://mirror.test/sup-gp.php?SOURCE=OneWeb&FORMAT=CSV");
  assert.equal(out[0].job.sourceName, "oneweb");
  assert.equal(out[0].job.provider, "node-7");
  const full = await requests(await harness(t, { token: "AST", sourceName: "ast-x", sourceUrl: "https://x.test/ast.json" }));
  assert.equal(full[0].req.url, "https://x.test/ast.json");
  assert.equal(full[0].job.sourceName, "ast-x");
});

test("parse: every registry fixture becomes its token's OMM batch with the feed's values and the legacy record's constants", async (t) => {
  const host = await harness(t);
  for (const { req } of await requests(host)) {
    const token = new URL(req.url).searchParams.get("SOURCE");
    const { sourceName, fixture: file, records } = REGISTRY[token];
    const body = fixture(file);
    const r = ok(await host.invoke({ methodId: "parse", inputs: [answer(req, body, { headers: { etag: '"abc"', "content-type": "application/json" } })] }));
    assert.deepEqual(r.outputs.map((f) => f.portId), ["omm_meta", "omm_records", "raw"]);

    const meta = decodeIngestRequest(framesOn(r, "omm_meta")[0].payload);
    const batchId = crypto.createHash("sha256").update(body).digest("hex");
    assert.equal(meta.schema, "OMM.fbs");
    assert.deepEqual(meta.tags, {
      providerId: "space-data-network-02", sourceName, batchId, sourceUrl: req.url, contentKeyId: "public", sourcePeer: "source:celestrak",
      license: "LicenseRef-CelesTrak-Usage-Policy", licenseUrl: "https://celestrak.org/usage-policy.php",
      citation: "CelesTrak Usage Policy, by Dr. T.S. Kelso, https://celestrak.org/usage-policy.php", shareAlike: false,
    });
    assert.equal(meta.reconcile, "duplicates");
    assert.deepEqual(meta.archive, { source: "celestrak", name: `celestrak_supgp_${token}.json` });
    assert.equal(meta.provenance.sourceSha256, batchId);
    assert.equal(meta.provenance.etag, '"abc"');
    assert.equal(meta.provenance.parser, "celestrak-supgp");
    assert.deepEqual(meta.provenance.schemaCounts, { "OMM.fbs": records });
    assert.deepEqual(meta.provenance.attributes, [
      // ATTRIBUTES is keyed by NAME, so the builder writes it sorted.
      { name: "celestrak_token", value: token }, { name: "data_source", value: "CelesTrak SupGP" },
      { name: "format", value: "JSON" }, { name: "independent", value: "false" },
    ]);
    assert.equal(framesOn(r, "raw")[0].typeRef.fileIdentifier, "HRSP");

    const feed = JSON.parse(body);
    const out = omms(r);
    assert.equal(out.length, records);
    out.forEach((o, i) => {
      const f = feed[i];
      assert.equal(o.CCSDS_OMM_VERS, 2.0);
      assert.equal(o.OBJECT_NAME, f.OBJECT_NAME);
      assert.equal(o.OBJECT_ID, f.OBJECT_ID);
      assert.equal(o.CENTER_NAME, "EARTH");
      assert.equal(o.REFERENCE_FRAME.REFERENCE_FRAME_type, RFMUnion.CelestialFrameWrapper);
      assert.equal(o.REFERENCE_FRAME.REFERENCE_FRAME.frame, CelestialFrame.TEMEOFDATE);
      assert.equal(o.MEAN_ELEMENT_THEORY, meanElementSource.SGP4);
      assert.equal(o.EPOCH, f.EPOCH);
      for (const k of ["MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT", "REV_AT_EPOCH"]) {
        assert.equal(o[k], Number(f[k]), `${f.OBJECT_NAME} ${k}`);
      }
      assert.equal(o.NORAD_CAT_ID, f.NORAD_CAT_ID);
      assert.equal(o.ELEMENT_SET_NO, f.ELEMENT_SET_NO);
      assert.equal(o.EPHEMERIS_TYPE, f.EPHEMERIS_TYPE);
      assert.equal(o.CLASSIFICATION_TYPE, f.CLASSIFICATION_TYPE);
      assert.match(o.COMMENT, /^CelesTrak Supplemental GP \(SupGP\) OMM re-published by SDN/);
      assert.match(o.COMMENT, /\nNON-INDEPENDENT: these are CelesTrak-FITTED SGP4 mean elements/);
      assert.ok(o.COMMENT.endsWith(`SOURCE_NAME=${sourceName} CELESTRAK_DATA_SOURCE=${f.DATA_SOURCE} CELESTRAK_RMS=${f.RMS}`));
      assert.deepEqual(o.USER_DEFINED_PARAMETERS.map((p) => p.PARAM_NAME), ["SDN_SOURCE_NAME", "SDN_DATA_SOURCE", "SDN_INDEPENDENT", "SDN_CELESTRAK_DATA_SOURCE", "SDN_CELESTRAK_RMS"]);
      assert.deepEqual(params(o), { SDN_SOURCE_NAME: sourceName, SDN_DATA_SOURCE: "CelesTrak SupGP", SDN_INDEPENDENT: "false", SDN_CELESTRAK_DATA_SOURCE: f.DATA_SOURCE, SDN_CELESTRAK_RMS: f.RMS });
    });
  }
});

test("parse: the CSV form gives the same records as the JSON form", async (t) => {
  const host = await harness(t);
  const [{ req: jsonReq }] = await requests(host);
  const [{ req: csvReq }] = await requests(await harness(t, { token: "SES-E", sourceName: "ses", format: "CSV" }));
  const fromJson = omms(ok(await host.invoke({ methodId: "parse", inputs: [answer(jsonReq, fixture("SES-E.trimmed.json"))] })));
  const csv = ok(await host.invoke({ methodId: "parse", inputs: [answer(csvReq, fixture("SES-E.csv.trimmed.csv"))] }));
  assert.equal(decodeIngestRequest(framesOn(csv, "omm_meta")[0].payload).archive.name, "celestrak_supgp_SES-E.csv");
  assert.deepEqual(omms(csv), fromJson);
});

test("parse: config objectCap bounds the records", async (t) => {
  const host = await harness(t, { objectCap: 3 });
  const ast = (await requests(host)).find((o) => o.job.dataset === "supgp-AST");
  assert.equal(omms(ok(await host.invoke({ methodId: "parse", inputs: [answer(ast.req, fixture("AST.trimmed.json"))] }))).length, 3);
});

test("parse: a 304 is Unchanged; a transport error, another status or nothing valid is Missing; a response without the job is refused", async (t) => {
  const host = await harness(t);
  const [{ req }] = await requests(host);
  const notice = async (opts, body = fixture("SES-E.trimmed.json")) => {
    const r = ok(await host.invoke({ methodId: "parse", inputs: [answer(req, body, opts)] }));
    assert.equal(r.outputs.length, 1);
    return { port: r.outputs[0].portId, ...decodeFlowNotice(r.outputs[0].payload) };
  };
  const unchanged = await notice({ status: 304 }, new Uint8Array(0));
  assert.deepEqual({ port: unchanged.port, kind: unchanged.kind, reason: unchanged.reason, items: unchanged.items, sourceName: unchanged.sourceName, schema: unchanged.schema },
    { port: "unchanged", kind: "unchanged", reason: "not-modified", items: [req.url], sourceName: "ses", schema: "OMM.fbs" });
  const down = await notice({ status: 503 });
  assert.deepEqual([down.port, down.kind, down.reason, down.items], ["status", "missing", "supgp-unavailable: HTTP status 503", [req.url]]);
  const failed = await notice({ status: 0, error: "dial tcp: timeout" }, new Uint8Array(0));
  assert.deepEqual([failed.port, failed.kind, failed.reason], ["status", "missing", "supgp-unavailable: dial tcp: timeout"]);
  assert.equal((await notice({}, Buffer.from("[]"))).reason, "supgp-no-records");

  const noJob = await host.invoke({ methodId: "parse", inputs: [{ portId: "response", typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url: req.url, status: 200, headers: {}, body: fixture("SES-E.trimmed.json"), retrievedMs: 0 }) }] });
  assert.notEqual(noJob.statusCode, 0);
  assert.equal(noJob.errorCode, "missing-context");
  assert.equal(noJob.outputs?.length ?? 0, 0);
});

test("a surplus frame on a single-stream port is refused", async (t) => {
  const host = await harness(t);
  const [{ req }] = await requests(host);
  const r = await host.invoke({ methodId: "parse", inputs: [answer(req, fixture("SES-E.trimmed.json")), answer(req, fixture("SES-E.trimmed.json"))] });
  assert.equal(r.errorCode, "batched-input-frames");
  assert.equal(r.outputs?.length ?? 0, 0);
});
