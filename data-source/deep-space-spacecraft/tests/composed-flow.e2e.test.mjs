import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import {
  decodeFlowNotice, decodeHostCall, decodeIngestRequest, decodeIngestResult,
  encodeHostCallResult, encodeModuleConfig, encodeTimerTick, identifierOf,
} from "space-data-module-sdk/runtime-contracts";
import { deepSpaceFlow } from "../flow.mjs";
import { framesOn, replayStages, requestKey } from "./horizons-stages.mjs";

const require = createRequire(import.meta.url);
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const modulesRoot = path.resolve(packageDir, "../..");
const sdkRoot = path.dirname(path.dirname(require.resolve("space-data-module-sdk")));
const standardsRoot = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(require.resolve("spacedatastandards.org/package.json"));
const cassette = JSON.parse(gunzipSync(fs.readFileSync(new URL("./fixtures/horizons/cassette.json.gz", import.meta.url))));
const firedMs = Date.UTC(2026, 9, 21, 12, 34, 56);
const producer = "16Uiu2HAmTestProducer";
const config = { ...cassette.config, deep_space_enabled: true, producer_peer_id: producer,
  limits: Object.entries(cassette.config.limits).map(([id, bounds]) => ({ id: Number(id), ...bounds })) };
const tick = encodeTimerTick({ triggerId: "daily", scheduledMs: firedMs, firedMs });
const http = "com.digitalarsenal.hostcap.http-request", storage = "com.digitalarsenal.hostcap.storage-ingest";
const catalogIds = ["lunar-orbit", "cislunar", "earth-moon-lagrange", "sun-earth-l1", "sun-earth-l2",
  "mercury-orbit", "venus-orbit", "mars-orbit", "jupiter-orbit", "saturn-orbit", "heliocentric"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Exact helpers/dependencies used by deployment/solar-system-provider-node/build-flow.mjs.
// The flow builder alone marks its private state edges opaque; external edges stay typed.
const node = (nodeId, pluginId, methodId, kind = "transform") => ({ nodeId, pluginId, methodId, kind, drainPolicy: "single-shot" });
const edge = (fromNodeId, fromPortId, toNodeId, toPortId) => ({
  edgeId: [fromNodeId, fromPortId, toNodeId, toPortId].join("-"), fromNodeId, fromPortId, toNodeId, toPortId,
  backpressurePolicy: "queue", queueDepth: 1,
});
const { flow, deps } = deepSpaceFlow({ node, edge, http, storage, packageDir });

async function compile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-space-flow-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "flow.json"), dependencies = path.join(dir, "dependencies.json");
  fs.writeFileSync(file, JSON.stringify(flow));
  fs.writeFileSync(dependencies, JSON.stringify({ ...deps,
    [http]: path.join(modulesRoot, "hostcap/http-request"), [storage]: path.join(modulesRoot, "hostcap/storage-ingest"),
    // The deployment builder includes these for every typed flow; deep-space
    // does not reference them, so neither is linked or invoked here.
    "com.digitalarsenal.hostcap.flatsql-query": path.join(modulesRoot, "hostcap/flatsql-query"),
    "com.digitalarsenal.hostcap.storage-write": path.join(modulesRoot, "hostcap/storage-write"),
  }));
  for (const command of ["check", "compile"]) {
    const start = performance.now();
    try {
      await promisify(execFile)(process.execPath, [path.join(sdkRoot, "bin/space-data-module.js"), "flow", command, file,
        "--deps", dependencies, "--out", path.join(dir, "runtime")], {
        cwd: modulesRoot, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, SPACE_DATA_STANDARDS_ROOT: standardsRoot },
      });
    } catch (error) {
      throw new Error(`SDK flow ${command} failed: ${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error });
    }
    t.diagnostic(`SDK flow ${command} passed in ${((performance.now() - start) / 1000).toFixed(2)}s`);
  }
  return fs.readFileSync(path.join(dir, "runtime/isomorphic/module.wasm"));
}

function cassetteBody(url) {
  const key = requestKey(url);
  assert.ok(Object.hasOwn(cassette.responses, key), `uncached HTTP request: ${url}`);
  return cassette.responses[key];
}

function recordCount(bytes, id) {
  let count = 0;
  for (let at = 0; at < bytes.length; count++) {
    assert.ok(at + 4 <= bytes.length, "complete size prefix");
    const size = bytes.readUInt32LE(at) + 4;
    assert.ok(size > 12 && at + size <= bytes.length, "complete size-prefixed record");
    assert.equal(bytes.subarray(at + 8, at + 12).toString(), id);
    at += size;
  }
  return count;
}

async function standalone() {
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(packageDir, "dist/isomorphic/module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(packageDir, "plugin-manifest.json"))), surface: "direct", hostOptions: { config } });
  try {
    return await replayStages(h, {
      planRequest: { methodId: "plan_horizons", inputs: [{ portId: "tick", payload: tick,
        typeRef: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" } }] },
      answer: ({ url }) => cassetteBody(url),
      checkResult: (r, stage) => assert.equal(r.statusCode, 0, `${stage}: ${r.errorCode}: ${r.errorMessage}`),
    });
  } finally { await h.destroy(); }
}

// Only the actual host boundary is substituted. The compiled source, HTTP and
// ingest guests all execute inside the SDK scheduler, including typed $PIV I/O.
async function runFlow(wasmSource, hostConfig) {
  const calls = [], egress = [], urls = new Set();
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
          const url = Buffer.from(call.raw.url).toString(), key = requestKey(url);
          assert.equal(call.params.METHOD, "GET");
          assert.equal(urls.has(key), false, `repeated HTTP request: ${url}`);
          urls.add(key);
          answer = { result: { STATUS: 200, RETRIEVED_MS: BigInt(firedMs) },
            raw: { url, headers: "", body: Buffer.from(cassetteBody(url)) } };
          break;
        }
        case "storage.ingest_with_source": {
          const { SCHEMA, BATCH_ID } = call.params;
          assert.ok(["OEM.fbs", "EGP.fbs"].includes(SCHEMA), `unexpected schema ${SCHEMA}`);
          answer = { result: { SCHEMA, BATCH_ID, INSERTED: BigInt(recordCount(Buffer.from(call.raw.records), SCHEMA === "OEM.fbs" ? "$OEM" : "$EGP")) } };
          break;
        }
        default: assert.fail(`unexpected hostcall ${call.op}`);
      }
      response = encodeHostCallResult({ ok: true, op: call.op, ...answer });
      return 0;
    },
    response_len: () => response.length,
    read_response(dst, len) {
      const n = Math.min(len, response.length);
      new Uint8Array(memory.buffer).set(response.subarray(0, n), dst);
      return n;
    },
  } };
  const host = await createFlowRuntimeHost({ wasmSource, extraImports, runtimeTarget: "browser" });
  memory = host.memory;
  assert.equal(host.nodeCount, flow.nodes.length);
  const states = () => Object.fromEntries(flow.nodes.map(({ nodeId }, i) => [nodeId, host.getNodeState(i)]));
  for (let i = 0; i < host.nodeCount; i++) {
    const descriptor = host.getNodeDispatchDescriptor(i);
    assert.equal(descriptor.nodeId, flow.nodes[i].nodeId);
    assert.equal(descriptor.dispatchModel, descriptor.nodeId === "egress" ? "host" : "linked-direct");
  }
  // Trigger identity is resolved from the deployed flow, rather than assuming index 0.
  const triggerIndex = flow.triggers.findIndex((t) => t.triggerId === "daily");
  assert.ok(triggerIndex >= 0);
  host.enqueueTriggerFrame(triggerIndex, { portId: "tick", bytes: tick });
  const drained = await host.drain({ "sdn.flow.egress:emit": ({ frames }) => {
    egress.push(...frames.map((f) => ({ ...f, bytes: Buffer.from(f.bytes) })));
    return { statusCode: 0 };
  } }, { maxIterations: 200 });
  assert.equal(drained.handlersSkipped, 0, "no node silently skipped by the JS host");
  const nodes = states();
  for (const [id, state] of Object.entries(nodes)) {
    assert.equal(state.lastStatus, 0, `${id} failed`);
    assert.equal(state.queuedFrames, 0, `${id} still has queued frames`);
    assert.equal(state.ready, false, `${id} is still ready`);
  }
  assert.equal(host.getRoutingState().rejectedFrames, 0n, "no typed frame rejected");
  assert.equal(host.getIngressState(triggerIndex).totalDropped, 0n);
  return { calls, egress, nodes, urls };
}

test("composed deep-space flow: offline weekly tick through real HTTP and ingest guests", { timeout: 180000 }, async (t) => {
  const started = performance.now();
  assert.deepEqual(config.objects, [-143205, -31, -32], "Roadster, Voyager 1 and Voyager 2 only");
  assert.equal(flow.triggers[0].defaultIntervalMs, 604800000, "weekly Horizons predictions cadence");
  const wasm = await compile(t);

  await t.test("enabled: cassette HTTP, byte-identical OEM/EGP storage and summary", async () => {
    // This is a wiring oracle, not a new numerical golden: the shared staged
    // runner is independently checked against Horizons TLIST in the other test.
    // Same fixed UTC tick/config and TDB cassette, Sun/ICRF km + km/s; tolerance
    // is ZERO bytes because routing/transport may not change either record stream.
    const expected = await standalone();
    const run = await runFlow(wasm, config);
    assert.equal(run.urls.size, 29);
    assert.deepEqual([...run.urls].sort(), Object.keys(cassette.responses).sort());
    assert.deepEqual(run.calls.filter((c) => c.op === "http.request").map((c) => Buffer.from(c.raw.url).toString()),
      expected.requestsSeen.map((r) => r.url), "exact URLs and ordering survive the composed HTTP lane");
    const ingests = run.calls.filter((c) => c.op === "storage.ingest_with_source");
    assert.deepEqual(ingests.map((c) => [c.params.SCHEMA, c.params.PROVIDER_ID, c.params.SOURCE_NAME]), [
      ["OEM.fbs", "deep-space-spacecraft", "heliocentric"], ["EGP.fbs", "deep-space-spacecraft", "catalogs"],
    ]);
    for (const [i, source] of ["heliocentric", "catalogs"].entries()) {
      const records = framesOn(expected.result, `${source}_records`), metas = framesOn(expected.result, `${source}_meta`);
      assert.equal(records.length, 1); assert.equal(metas.length, 1);
      const meta = decodeIngestRequest(metas[0]), call = ingests[i], sha = sha256(records[0]);
      assert.deepEqual(Buffer.from(call.raw.records), records[0], `${source}: every storage byte equals the staged path`);
      assert.equal(recordCount(records[0], source === "catalogs" ? "$EGP" : "$OEM"), source === "catalogs" ? 1 : 3);
      assert.equal(meta.reconcile, "current");
      // EGP's existing contract adds the retrieval tick to its content hash.
      assert.equal(meta.tags.batchId, sha + (source === "catalogs" ? `@${firedMs}` : ""));
      for (const [key, value] of Object.entries({ SCHEMA: meta.schema, PROVIDER_ID: meta.tags.providerId,
        SOURCE_NAME: source, BATCH_ID: meta.tags.batchId, SOURCE_PEER: producer, RECONCILE: 2,
        SOURCE_URL: meta.tags.sourceUrl, LICENSE: meta.tags.license, CITATION: meta.tags.citation })) {
        assert.equal(call.params[key], value, `${source}.${key}`); // HostOps.reconcileKind.Current = 2
      }
    }
    for (const source of [...catalogIds, "catalogs"]) {
      assert.equal(run.nodes[`ingest_${source.replaceAll("-", "_")}`].invocationCount,
        ["heliocentric", "catalogs"].includes(source) ? 1n : 0n, `${source} ingest invocations`);
    }
    for (const id of ["plan", ...Array.from({ length: 6 }, (_, i) => `advance${i + 1}`), "build"]) {
      assert.equal(run.nodes[id].invocationCount, 1n, `${id} executed exactly once`);
    }
    for (const [i, snapshot] of expected.snapshots.entries()) {
      assert.equal(run.nodes[`fetch${i}`].invocationCount, snapshot.requests.length ? 1n : 0n, `fetch${i} invocations`);
    }
    const notices = [], stored = [];
    for (const frame of run.egress) {
      assert.equal(frame.portId, "result");
      switch (identifierOf(frame.bytes)) {
        case "FNTC": notices.push(decodeFlowNotice(frame.bytes)); break;
        case "INGR": stored.push(decodeIngestResult(frame.bytes)); break;
        default: assert.fail(`unexpected/error egress: ${identifierOf(frame.bytes)}`);
      }
    }
    assert.equal(notices.length, 8, "plan, six advances and build summary reach egress");
    assert.ok(notices.every((n) => n.kind === "info"), "no skipped/missing/error notice");
    const summary = notices.filter((n) => n.reason === "catalog-counts");
    assert.deepEqual(summary, framesOn(expected.result, "notice").map(decodeFlowNotice));
    assert.equal(summary.length, 1); assert.equal(summary[0].count, 3);
    assert.deepEqual(summary[0].items, catalogIds.map((c) => `${c}:${c === "heliocentric" ? 3 : 0}`));
    assert.deepEqual(stored.map((r) => [r.schema, r.providerId, r.sourceName, r.batchId, r.inserted, r.refused]),
      ingests.map((c, i) => [c.params.SCHEMA, c.params.PROVIDER_ID, c.params.SOURCE_NAME, c.params.BATCH_ID, i === 0 ? 3 : 1, ""]));
  });

  await t.test("disabled: one Skipped notice, no HTTP or storage, no downstream invocation", async () => {
    const run = await runFlow(wasm, { ...config, deep_space_enabled: false });
    assert.deepEqual(run.calls.map((c) => c.op), ["plugin.getConfig"]);
    assert.equal(run.urls.size, 0);
    assert.equal(run.egress.length, 1);
    const notice = decodeFlowNotice(run.egress[0].bytes);
    assert.equal(notice.kind, "skipped"); assert.equal(notice.reason, "disabled");
    for (const [id, state] of Object.entries(run.nodes)) {
      assert.equal(state.invocationCount, ["plan", "egress"].includes(id) ? 1n : 0n, id);
    }
  });
  t.diagnostic(`Composed flow plus standalone oracle completed in ${((performance.now() - started) / 1000).toFixed(2)}s`);
});
