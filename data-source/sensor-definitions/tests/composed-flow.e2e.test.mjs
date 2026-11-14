// The composed flow: a weekly tick through the real plan, HTTP, build and ingest guests of the SDK scheduler; only the host boundary
// (plugin.getConfig, http.request, storage.ingest_with_source) is substituted, by the cassette and a recorder. Wiring oracle: what the
// flow stores is byte-identical to what build_sensors emits standalone.
import assert from "node:assert/strict";
import {storedCatRecords} from "./stored-cat-fixture.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeFlowNotice, decodeHostCall, decodeIngestRequest, decodeIngestResult, encodeHostCallResult, encodeModuleConfig, encodeTimerTick, identifierOf } from "space-data-module-sdk/runtime-contracts";
import { sensorDefinitionsFlow } from "../flow.mjs";
import { build, cassette, frames, harness, PEER, plan, records } from "./run-module.mjs";

const require = createRequire(import.meta.url);
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const modulesRoot = path.resolve(packageDir, "../..");
const sdkRoot = path.dirname(path.dirname(require.resolve("space-data-module-sdk")));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(require.resolve("spacedatastandards.org/package.json"));
const firedMs = Date.UTC(2026, 10, 5, 16, 0, 0);
const tick = encodeTimerTick({ triggerId: "weekly", scheduledMs: firedMs, firedMs });
const hostConfig = { producer_peer_id: PEER };
const http = "com.digitalarsenal.hostcap.http-request", storage = "com.digitalarsenal.hostcap.storage-ingest";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const node = (nodeId, pluginId, methodId, kind = "transform") => ({ nodeId, pluginId, methodId, kind, drainPolicy: "single-shot" });
const edge = (fromNodeId, fromPortId, toNodeId, toPortId) => ({
  edgeId: [fromNodeId, fromPortId, toNodeId, toPortId].join("-"), fromNodeId, fromPortId, toNodeId, toPortId, backpressurePolicy: "queue", queueDepth: 1,
});
const { flow, deps } = sensorDefinitionsFlow({ node, edge, http, storage, packageDir });

async function compile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-definitions-flow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "flow.json"), dependencies = path.join(dir, "dependencies.json");
  fs.writeFileSync(file, JSON.stringify(flow));
  fs.writeFileSync(dependencies, JSON.stringify({ ...deps,
    [http]: path.join(modulesRoot, "hostcap/http-request"), [storage]: path.join(modulesRoot, "hostcap/storage-ingest"),
    "com.digitalarsenal.hostcap.flatsql-query": path.join(modulesRoot, "hostcap/flatsql-query"),
    "com.digitalarsenal.hostcap.storage-write": path.join(modulesRoot, "hostcap/storage-write") }));
  for (const command of ["check", "compile"]) {
    try {
      await promisify(execFile)(process.execPath, [path.join(sdkRoot, "bin/space-data-module.js"), "flow", command, file, "--deps", dependencies, "--out", path.join(dir, "runtime")],
        { cwd: modulesRoot, timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: standardsRoot } });
    } catch (error) { throw new Error(`SDK flow ${command} failed: ${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error }); }
  }
  return fs.readFileSync(path.join(dir, "runtime/isomorphic/module.wasm"));
}

async function runFlow(wasmSource) {
  const calls = [], egress = [], urls = [];
  let memory, response = new Uint8Array();
  const extraImports = { space_data_module_host: {
    call(opPtr, opLen, ptr, len) {
      const heap = new Uint8Array(memory.buffer);
      const operation = Buffer.from(heap.subarray(opPtr, opPtr + opLen)).toString();
      const call = decodeHostCall(heap.slice(ptr, ptr + len));
      assert.equal(call.op, operation, "$PIV method matches the imported operation");
      calls.push(call);
      let answer;
      switch (call.op) {
        case "plugin.getConfig": answer = { raw: { config: encodeModuleConfig(hostConfig) } }; break;
        case "http.request": {
          const url = Buffer.from(call.raw.url).toString();
          assert.equal(call.params.METHOD, "GET");
          assert.ok(!url.includes('celestrak.org'), 'no second SATCAT request');
          assert.match(Buffer.from(call.raw.headers ?? []).toString(), /User-Agent: SpaceDataNetwork\/1\.1 /);
          assert.ok(Object.hasOwn(cassette, url), `uncached HTTP request: ${url}`);
          assert.ok(!urls.includes(url), `repeated HTTP request: ${url}`);
          urls.push(url);
          answer = { result: { STATUS: 200, RETRIEVED_MS: BigInt(cassette[url].retrievedMs) }, raw: { url, headers: "", body: Buffer.from(cassette[url].body) } };
          break;
        }
        case "storage.query": {
          assert.equal(call.params.SCHEMA, 'CAT.fbs');
          assert.equal(call.params.LIMIT, 250000);
          const stored = storedCatRecords(PEER);
          const chunks = stored.map(r => {const b=Buffer.alloc(4+r.Data.length); b.writeUInt32LE(r.Data.length); b.set(r.Data,4); return b;});
          answer = {lists: {records_meta: stored.map(r => ({CID:r.CID, TIMESTAMP_MS: BigInt(Date.parse(r.Timestamp)), LENGTH:r.Data.length,
            PROVIDER_ID:r.SourceTags.ProviderID, SOURCE_NAME:r.SourceTags.SourceName, PRODUCER_PEER_ID:r.SourceTags.ProducerPeerID}))},
            raw: {records:Buffer.concat(chunks)}};
          break;
        }
        case "storage.ingest_with_source": {
          const { SCHEMA, BATCH_ID } = call.params;
          assert.equal(SCHEMA, "SNR.fbs");
          let count = 0;
          for (let at = 0, b = Buffer.from(call.raw.records); at < b.length; count++) { const size = b.readUInt32LE(at) + 4; assert.equal(b.subarray(at + 8, at + 12).toString(), "$SNR"); at += size; }
          answer = { result: { SCHEMA, BATCH_ID, INSERTED: BigInt(count) } };
          break;
        }
        default: assert.fail(`unexpected hostcall ${call.op}`);
      }
      response = encodeHostCallResult({ ok: true, op: call.op, ...answer });
      return 0;
    },
    response_len: () => response.length,
    read_response(dst, len) { const n = Math.min(len, response.length); new Uint8Array(memory.buffer).set(response.subarray(0, n), dst); return n; },
  } };
  const host = await createFlowRuntimeHost({ wasmSource, extraImports, runtimeTarget: "browser" });
  memory = host.memory;
  assert.equal(host.nodeCount, flow.nodes.length);
  const triggerIndex = flow.triggers.findIndex((t) => t.triggerId === "weekly");
  host.enqueueTriggerFrame(triggerIndex, { portId: "tick", bytes: tick });
  const drained = await host.drain({ "sdn.flow.egress:emit": ({ frames: f }) => { egress.push(...f.map((x) => ({ ...x, bytes: Buffer.from(x.bytes) }))); return { statusCode: 0 }; } }, { maxIterations: 200 });
  assert.equal(drained.handlersSkipped, 0, "no node silently skipped by the JS host");
  const nodes = Object.fromEntries(flow.nodes.map(({ nodeId }, i) => [nodeId, host.getNodeState(i)]));
  for (const [id, state] of Object.entries(nodes)) {
    assert.equal(state.lastStatus, 0, `${id} failed`);
    assert.equal(state.queuedFrames, 0, `${id} still has queued frames`);
  }
  assert.equal(host.getRoutingState().rejectedFrames, 0n, "no typed frame rejected");
  return { calls, egress, nodes, urls };
}

test("composed sensor-definitions flow: weekly tick through the real HTTP and ingest guests", { timeout: 240000 }, async (t) => {
  const wasm = await compile(t);
  assert.equal(flow.triggers[0].defaultIntervalMs, 604800000, "weekly cadence");
  const standalone = await harness();
  const planned = await plan(standalone);
  const expected = await build(standalone, planned.urls);
  await standalone.destroy();
  const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/identity-equivalence.json', import.meta.url)));
  for (const port of ['space_records', 'ground_records', 'space_meta', 'ground_meta'])
    assert.equal(sha256(Buffer.from(frames(expected, port)[0].payload)), baseline[port], `${port} equals the CSV-identity artifact byte for byte`);
  const modis = records(frames(expected, 'space_records')[0]).find(r => r.snr.NORAD_CAT_ID === 25994 && r.snr.NAME === 'MODIS on TERRA');
  assert.equal(modis.snr.SPECTRAL_BANDS.length, 36);
  const run = await runFlow(wasm);
  assert.equal(run.calls.filter(c => c.op === 'storage.query').length, 1, 'one stored identity query');
  assert.deepEqual(run.urls, planned.urls, "the flow requests exactly the planned URLs in order");
  assert.equal(run.calls.filter((c) => c.op === "plugin.getConfig").length, 1);
  const ingests = run.calls.filter((c) => c.op === "storage.ingest_with_source");
  assert.deepEqual(ingests.map((c) => [c.params.SCHEMA, c.params.PROVIDER_ID, c.params.SOURCE_NAME]), [["SNR.fbs", "sensor-definitions", "space"], ["SNR.fbs", "sensor-definitions", "ground"]]);
  for (const [i, lane] of ["space", "ground"].entries()) {
    const stream = frames(expected, `${lane}_records`)[0].payload, meta = decodeIngestRequest(new Uint8Array(frames(expected, `${lane}_meta`)[0].payload));
    assert.deepEqual(Buffer.from(ingests[i].raw.records), Buffer.from(stream), `${lane}: every stored byte equals the standalone stream`);
    assert.equal(meta.reconcile, "current");
    assert.equal(meta.tags.batchId, sha256(Buffer.from(stream)));
    assert.equal(ingests[i].params.BATCH_ID, meta.tags.batchId);
    assert.equal(ingests[i].params.SOURCE_PEER, PEER);
    assert.equal(ingests[i].params.RECONCILE, 2);
    assert.equal(ingests[i].params.LICENSE, meta.tags.license);
  }
  const notices = [], stored = [];
  for (const frame of run.egress) {
    assert.equal(frame.portId, "result");
    switch (identifierOf(frame.bytes)) {
      case "FNTC": notices.push(decodeFlowNotice(frame.bytes)); break;
      case "INGR": stored.push(decodeIngestResult(frame.bytes)); break;
      default: assert.fail(`unexpected egress: ${identifierOf(frame.bytes)}`);
    }
  }
  assert.equal(notices.length, 1, "the counts notice; no Missing notice on the recorded day");
  assert.equal(notices[0].reason, "sensor-counts");
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((r) => [r.schema, r.sourceName, r.inserted, r.refused]), [["SNR.fbs", "space", records(frames(expected, "space_records")[0]).length, ""], ["SNR.fbs", "ground", 9, ""]]);
  for (const id of ["plan", "fetch", "build", "ingest_space", "ingest_ground"]) assert.equal(run.nodes[id].invocationCount, 1n, `${id} executed exactly once`);
});
