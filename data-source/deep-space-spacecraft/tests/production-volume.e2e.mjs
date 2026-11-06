// E2E: the production host config through the composed flow, at production
// request volume. On 2026-11-06T00:35:33Z host-01's first run refused at
// advance1 (response-count-mismatch): plan emitted 87 requests (the Horizons
// listing, two NAIF indexes, 84 coverage probes) and the composed runtime hands
// a node at most 64 frames per invocation, so advance1 saw its state and 63 of
// 87 responses. This replays that day's responses through flow.mjs compiled by
// the SDK: every advance must get its state and every response of its stage.
//
// Replays tests/fixtures/production-volume/cassette.json.gz: real fetches on
// the run day (URL, time, sha256 in provenance.json). The config is
// production's (deep_space_enabled, producer_peer_id: discovery and the default
// NAIF sources on) plus `limits` clamping every craft to three days so the
// fixture stays small; limits change no request count before vectors. Kernels
// keep whole SPK segments (tests/cislunar-fixtures.mjs trimSpk).
// `transportFailure` is a real Horizons 503 (answered to concurrent requests
// from one address): one craft's probe answered with it skips only that craft.
// PRODUCTION_RECORD=1 re-records live.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import {
  decodeFlowNotice, decodeHostCall, decodeHttpRequest, encodeHostCallResult, encodeHttpResponse, encodeModuleConfig, encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";
import { deepSpaceFlow, stages } from "../flow.mjs";
import { framesOn, replayStages } from "./horizons-stages.mjs";
import { sha256, trimSpk } from "./cislunar-fixtures.mjs";

const require = createRequire(import.meta.url);
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const modulesRoot = path.resolve(packageDir, "../..");
const fixtureDir = new URL("fixtures/production-volume/", import.meta.url);
const fixtureUrl = new URL("cassette.json.gz", fixtureDir);
const record = process.env.PRODUCTION_RECORD === "1";
const STAGE_CEILING = 63; // 64 frames per invocation (SDK flow_runtime.cpp kMaxInvocationFrames) minus the state frame
const DAY = 86400000;
const http = "com.digitalarsenal.hostcap.http-request", storage = "com.digitalarsenal.hostcap.storage-ingest";
const tickType = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "plugin-manifest.json")));
const wasm = fs.readFileSync(path.join(packageDir, "dist/isomorphic/module.wasm"));
const KERNEL_TRIM = { "lrorg_": (n) => [n - 2, n - 1], "art": (n) => [n - 1] }; // newest whole segments
const isoSeconds = (ms) => new Date(ms).toISOString().slice(0, 19);
const harness = (config) => createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: "direct", hostOptions: { config } });
const planRequest = (firedMs) => ({ methodId: "plan_horizons",
  inputs: [{ portId: "tick", typeRef: tickType, payload: encodeTimerTick({ triggerId: "daily", firedMs }) }] });
const checkResult = (r, label) => assert.equal(r.statusCode, 0, `${label}: ${r.errorCode ?? ""} ${r.errorMessage ?? ""}`);
const stateOf = (result) => JSON.parse(framesOn(result, "state")[0].toString());

async function fetchLive(url) {
  const fetchedAt = new Date().toISOString();
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  const original = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, `live ${url}`);
  let body = original, trimmed = null;
  const file = url.split("/").pop(), rule = Object.entries(KERNEL_TRIM).find(([prefix]) => file.startsWith(prefix));
  if (url.endsWith(".bsp") && rule) {
    const t = trimSpk(original, rule[1]);
    body = t.bytes; trimmed = { rule: rule[0], segmentsInOriginal: t.segments, kept: t.kept };
  }
  return { status: 200, fetchedAt, sha256: sha256(original), bytes: original.length, trimmed, bodySha256: sha256(body), body };
}

// Record: production config; a first pass reads each craft's Horizons coverage
// and the listing's probe ids, then `limits` keep three days per craft.
async function recordCassette() {
  const firedMs = Date.parse("2026-11-06T00:35:33.001Z"), today = Math.floor(firedMs / DAY) * DAY;
  const production = { deep_space_enabled: true, producer_peer_id: "16Uiu2HAmNpWvv4aG4U67cex3LfUJpdrXKXbvcxn6Gm33RPM3MTCf" };
  const responses = {}, answer = async ({ url }) => (responses[url] ??= await fetchLive(url)).body;
  const first = await harness(production);
  try {
    let result = await first.invoke(planRequest(firedMs));
    checkResult(result, "plan_horizons");
    assert.equal(framesOn(result, "request").length, STAGE_CEILING);
    // Stage one, then the rest of the coverage probes: every craft's bounds.
    for (let k = 0; k < 2; k++) {
      const inputs = [{ portId: "state", payload: framesOn(result, "state")[0],
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: framesOn(result, "state")[0].length } }];
      for (const request of framesOn(result, "request").map(decodeHttpRequest)) inputs.push({ portId: "response",
        typeRef: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
        payload: encodeHttpResponse({ status: 200, body: await answer(request) }) });
      result = await first.invoke({ methodId: "advance", inputs });
      checkResult(result, `bounds pass ${k + 1}`);
    }
    const state = stateOf(result), j2000 = Date.UTC(2000, 0, 1, 12);
    // Ended craft: the three days before their coverage ends; the rest: the three days before the run day.
    const ends = new Map(state.queue.filter((p) => p.kind === "discover").map((p) => [p.id, today]));
    for (const c of state.craft) ends.set(c.id, Number.isFinite(c.hi) ? Math.min(today, Math.floor((j2000 + c.hi * 1000) / DAY) * DAY - DAY) : today);
    const limits = [...ends].map(([id, end]) => ({ id, start: isoSeconds(end - 3 * DAY), stop: isoSeconds(end) }));
    return { firedMs, recordedAt: new Date().toISOString(), config: { ...production, limits }, responses };
  } finally { await first.destroy(); }
}

let cassette;
if (record) cassette = await recordCassette();
else {
  cassette = JSON.parse(gunzipSync(fs.readFileSync(fixtureUrl)));
  for (const r of [...Object.values(cassette.responses), cassette.transportFailure]) r.body = Buffer.from(r.body, "base64");
}
const answerFrom = ({ url }) => {
  const r = cassette.responses[url];
  assert.ok(r, `uncached URL ${url}`);
  return r.body;
};

// 1. The standalone staged path: every frame of a stage in one invoke.
async function standalone() {
  const h = await harness(cassette.config);
  try {
    return await replayStages(h, { planRequest: planRequest(cassette.firedMs),
      answer: record ? async (request) => (cassette.responses[request.url] ??= await fetchLive(request.url)).body : answerFrom,
      checkResult });
  } finally { await h.destroy(); }
}
const expected = await standalone();
const firstState = JSON.parse(expected.snapshots[0].inputs[0].payload.toString());
assert.equal(firstState.queue.length, 87, "plan queues the listing, two NAIF indexes and 84 coverage probes, as on host-01");
assert.equal(expected.snapshots[0].requests.length, STAGE_CEILING);
console.log(`PASS standalone: ${expected.requestsSeen.length} requests over ${expected.snapshots.filter((s) => s.requests.length).length} fetch stages`);

if (record) {
  // A real 503 for one craft's probe: Horizons answers concurrent requests from one address with it.
  const url = expected.requestsSeen.find((r) => /COMMAND=%27-31%27/.test(r.url) && r.url.includes("1900-01-01")).url;
  let failure;
  for (let attempt = 0; attempt < 5 && !failure; attempt++) {
    const fetchedAt = new Date().toISOString();
    const answers = await Promise.all(Array.from({ length: 8 }, async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
    }));
    const r = answers.find((a) => a.status === 503);
    if (r) failure = { url, status: 503, fetchedAt, sha256: sha256(r.body), bytes: r.body.length, body: r.body };
  }
  assert.ok(failure, "no 503 observed from 8 concurrent requests");
  cassette.transportFailure = failure;
  const stored = { ...cassette, responses: {} };
  for (const [u, r] of Object.entries(cassette.responses)) stored.responses[u] = { ...r, body: r.body.toString("base64") };
  stored.transportFailure = { ...failure, body: failure.body.toString("base64") };
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(fixtureUrl, gzipSync(JSON.stringify(stored)));
  fs.writeFileSync(new URL("provenance.json", fixtureDir), JSON.stringify({ recordedAt: cassette.recordedAt, firedMs: cassette.firedMs,
    transportFailure: { url: failure.url, status: 503, fetchedAt: failure.fetchedAt, sha256: failure.sha256, bytes: failure.bytes },
    responses: Object.entries(cassette.responses).map(([u, r]) => ({ url: u, fetchedAt: r.fetchedAt, status: r.status,
      sha256: r.sha256, bytes: r.bytes, trimmed: r.trimmed, bodySha256: r.bodySha256 })) }, null, 1) + "\n");
} else {
  for (const [url, r] of Object.entries(cassette.responses)) assert.equal(sha256(r.body), r.bodySha256, `fixture body sha256: ${url}`);
  assert.equal(sha256(cassette.transportFailure.body), cassette.transportFailure.sha256);
}
assert.deepEqual(expected.requestsSeen.map((r) => r.url).sort(), Object.keys(cassette.responses).sort(), "every cassette URL requested once");

// 2. The composed flow, compiled from flow.mjs as the deployment builder does.
function compile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-space-volume-"));
  const node = (nodeId, pluginId, methodId, kind = "transform") => ({ nodeId, pluginId, methodId, kind, drainPolicy: "single-shot" });
  const edge = (a, ap, b, bp) => ({ edgeId: [a, ap, b, bp].join("-"), fromNodeId: a, fromPortId: ap, toNodeId: b, toPortId: bp,
    backpressurePolicy: "queue", queueDepth: 1 });
  const { flow, deps } = deepSpaceFlow({ node, edge, http, storage, packageDir });
  fs.writeFileSync(path.join(dir, "flow.json"), JSON.stringify(flow));
  fs.writeFileSync(path.join(dir, "dependencies.json"), JSON.stringify({ ...deps,
    [http]: path.join(modulesRoot, "hostcap/http-request"), [storage]: path.join(modulesRoot, "hostcap/storage-ingest") }));
  const sdkCli = path.join(path.dirname(path.dirname(require.resolve("space-data-module-sdk"))), "bin/space-data-module.js");
  const standards = path.dirname(require.resolve("spacedatastandards.org/package.json"));
  try {
    for (const command of ["check", "compile"]) execFileSync(process.execPath, [sdkCli, "flow", command, path.join(dir, "flow.json"),
      "--deps", path.join(dir, "dependencies.json"), "--out", path.join(dir, "runtime")],
      { cwd: modulesRoot, env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: standards }, stdio: ["ignore", "ignore", "inherit"] });
    return { flow, wasm: fs.readFileSync(path.join(dir, "runtime/isomorphic/module.wasm")) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function runFlow(flow, wasmSource, answer) {
  const calls = [], egress = [];
  let memory, response = new Uint8Array();
  const extraImports = { space_data_module_host: {
    call(opPtr, opLen, ptr, len) {
      const call = decodeHostCall(new Uint8Array(memory.buffer).slice(ptr, ptr + len));
      calls.push(call);
      let reply;
      switch (call.op) {
        case "plugin.getConfig": reply = { raw: { config: encodeModuleConfig(cassette.config) } }; break;
        case "http.request": {
          const url = Buffer.from(call.raw.url).toString(), { status, body } = answer(url);
          reply = { result: { STATUS: status, RETRIEVED_MS: BigInt(cassette.firedMs) }, raw: { url, headers: "", body } };
          break;
        }
        case "storage.ingest_with_source":
          reply = { result: { SCHEMA: call.params.SCHEMA, BATCH_ID: call.params.BATCH_ID, INSERTED: 1n } };
          break;
        default: assert.fail(`unexpected hostcall ${call.op}`);
      }
      response = encodeHostCallResult({ ok: true, op: call.op, ...reply });
      return 0;
    },
    response_len: () => response.length,
    read_response(dst, n) {
      const k = Math.min(n, response.length);
      new Uint8Array(memory.buffer).set(response.subarray(0, k), dst);
      return k;
    },
  } };
  const host = await createFlowRuntimeHost({ wasmSource, extraImports, runtimeTarget: "browser" });
  memory = host.memory;
  host.enqueueTriggerFrame(flow.triggers.findIndex((t) => t.triggerId === "daily"),
    { portId: "tick", bytes: encodeTimerTick({ triggerId: "daily", scheduledMs: cassette.firedMs, firedMs: cassette.firedMs }) });
  const drained = await host.drain({ "sdn.flow.egress:emit": ({ frames }) => {
    egress.push(...frames.map((f) => Buffer.from(f.bytes)));
    return { statusCode: 0 };
  } }, { maxIterations: 1000 });
  assert.equal(drained.handlersSkipped, 0);
  const nodes = Object.fromEntries(flow.nodes.map(({ nodeId }, i) => [nodeId, host.getNodeState(i)]));
  for (const [id, s] of Object.entries(nodes)) {
    assert.equal(s.lastStatus, 0, `${id} refused`);
    assert.equal(s.queuedFrames, 0, `${id} left ${s.queuedFrames} frames queued`);
  }
  assert.equal(host.getRoutingState().rejectedFrames, 0n);
  const notices = egress.filter((b) => identifierOf(b) === "FNTC").map(decodeFlowNotice);
  return { calls, nodes, notices, ingests: calls.filter((c) => c.op === "storage.ingest_with_source") };
}

const { flow, wasm: flowWasm } = compile();
const run = await runFlow(flow, flowWasm, (url) => ({ status: 200, body: answerFrom({ url }) }));
const urls = run.calls.filter((c) => c.op === "http.request").map((c) => Buffer.from(c.raw.url).toString());
assert.deepEqual(urls, expected.requestsSeen.map((r) => r.url), "the composed lanes send the staged URLs in order");
for (let stage = 0; stage <= stages; stage++) {
  const fetch = run.nodes[`fetch${stage}`], requests = expected.snapshots[stage]?.requests.length ?? 0;
  assert.ok(fetch.consumedFrames <= BigInt(STAGE_CEILING), `fetch${stage} carries at most ${STAGE_CEILING} requests`);
  assert.equal(fetch.invocationCount, requests ? 1n : 0n, `fetch${stage} answers its stage in one invocation`);
  const next = run.nodes[stage < stages ? `advance${stage + 1}` : "build"];
  assert.equal(next.invocationCount, 1n, `the node after fetch${stage} runs once`);
  assert.equal(next.consumedFrames, BigInt(1 + requests), `the node after fetch${stage} gets its state and all ${requests} responses`);
}
for (const [i, call] of run.ingests.entries()) {
  const source = call.params.SOURCE_NAME, port = `${source.replaceAll("-", "_")}_records`;
  assert.deepEqual(Buffer.from(call.raw.records), framesOn(expected.result, port)[0], `${source}: storage bytes equal the staged path (${i})`);
}
const summary = run.notices.find((n) => n.reason === "catalog-counts");
assert.deepEqual(summary, framesOn(expected.result, "notice").map(decodeFlowNotice).find((n) => n.reason === "catalog-counts"));
assert.ok(run.ingests.length >= 2 && run.ingests.some((c) => c.params.SCHEMA === "EGP.fbs"), "OEM catalogs and the EGP listing land");
console.log(`PASS composed: ${urls.length} requests, stage requests ${expected.snapshots.map((s) => s.requests.length).join("/")}, ` +
  `${run.ingests.length} ingests, ${summary.items.join(" ")}`);

// 3. One craft's real 503: that craft is skipped, every other record lands unchanged.
const failed = cassette.transportFailure, craftId = Number(new URL(failed.url).searchParams.get("COMMAND").replaceAll("'", ""));
const outage = await runFlow(flow, flowWasm, (url) => url === failed.url
  ? { status: failed.status, body: failed.body } : { status: 200, body: answerFrom({ url }) });
assert.deepEqual(outage.notices.filter((n) => n.kind === "missing").filter((n) => n.items.includes(String(craftId)))
  .map((n) => n.reason), ["horizons-http-error"], `${craftId} skipped by its 503`);
const records = (bytes) => {
  const list = [];
  for (let at = 0; at < bytes.length;) {
    const size = bytes.readUInt32LE(at) + 4;
    list.push(bytes.subarray(at, at + size));
    at += size;
  }
  return list;
};
for (const call of outage.ingests.filter((c) => c.params.SCHEMA === "OEM.fbs")) {
  const port = `${call.params.SOURCE_NAME.replaceAll("-", "_")}_records`;
  const baseline = records(framesOn(expected.result, port)[0]).map((b) => b.toString("hex"));
  const kept = records(Buffer.from(call.raw.records)).map((b) => b.toString("hex"));
  assert.ok(kept.every((r) => baseline.includes(r)), `${call.params.SOURCE_NAME}: surviving records are byte-identical`);
}
const outageSummary = outage.notices.find((n) => n.reason === "catalog-counts");
assert.ok(outageSummary.count < summary.count && outageSummary.count > 0, "only the failed craft's records are missing");
console.log(`PASS transport: ${craftId}'s probe answered 503 skips it alone (${summary.count} -> ${outageSummary.count} records)`);
