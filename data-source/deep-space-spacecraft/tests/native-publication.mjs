// Native leg of tests/cislunar-sources.e2e.mjs, on the data-source/lvdb-source
// pattern: compile the production flow (flow.mjs) with a fixture HTTP transport
// that answers only from the cassette, run it inside an isolated native node,
// let the node auto-publish every lane, then walk each lane's complete
// published series and read every manifest and shard back by CID.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { ByteBuffer } from "flatbuffers";
import { createSingleFileBundle, verifyModuleArtifact } from "space-data-module-sdk/bundle";
import { appendPublicationRecordCollection, encodePublicationRecordCollection } from "space-data-module-sdk/transport";
import { encodeHttpResponse } from "space-data-module-sdk/runtime-contracts";
import { localNode } from "../../lvdb-source/tests/local-node.mjs";
import { deepSpaceFlow } from "../flow.mjs";
import { sha256 } from "./cislunar-fixtures.mjs";

const require = createRequire(import.meta.url);
const PROVIDER = "deep-space-spacecraft", PROGRAM = "com.digitalarsenal.flows.deep-space-catalogs-ingest";
const SOURCE = "com.digitalarsenal.data-source.deep-space-spacecraft";
const HTTP = "com.digitalarsenal.hostcap.http-request", STORAGE = "com.digitalarsenal.hostcap.storage-ingest";

// Test-only HTTP boundary: the cassette's response bytes, compiled into WASM.
function fixtureHttpSource(responses) {
  let declarations = "", cases = "";
  Object.entries(responses).forEach(([url, r], i) => {
    const bytes = encodeHttpResponse({ url, status: r.status, body: Buffer.from(r.body, "base64") });
    declarations += `static const unsigned char response_${i}[]={${[...bytes].join(",")}};\n`;
    declarations += `static const char url_${i}[]={${[...Buffer.from(url), 0].join(",")}};\n`;
    cases += `if(r->URL()->str()==url_${i})return plugin_push_output_ex("response","HttpResponse.fbs","HRSP",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"HttpResponse",0,0,response_${i},sizeof(response_${i}))<0?1:0;\n`;
  });
  return `#include "space_data_module_invoke.h"\n#include "HttpRequest_generated.h"\n${declarations}\n` +
    `static int answer(const plugin_input_frame_t* f){if(!f)return 1;flatbuffers::Verifier v(f->payload,f->payload_length,64,1000000,false);` +
    `if(!sdn::runtime::VerifyHttpRequestBuffer(v))return 1;auto r=sdn::runtime::GetHttpRequest(f->payload);if(!r->URL())return 1;${cases}return 1;}\n` +
    `extern "C" int request(){for(uint32_t i=0;i<plugin_get_input_count();++i)if(answer(plugin_get_input_frame(i)))return 1;return 0;}`;
}

async function compileFixtureFlow(packageDir, responses, out) {
  const modules = path.resolve(packageDir, "../..");
  const standardsRoot = path.dirname(require.resolve("spacedatastandards.org/package.json"));
  process.env.SPACE_DATA_STANDARDS_ROOT = standardsRoot;
  const { compileModuleFromSource } = await import("space-data-module-sdk/compiler");
  const { compileFlowProgram, resolveFlowDependencies } = await import("space-data-module-sdk/flow/compiler");
  const { normalizeManifestForSdnFlow } = await import(pathToFileURL(path.join(path.dirname(require.resolve("space-data-module-sdk/flow/compiler")), "normalize.js")));
  const node = (nodeId, pluginId, methodId, kind = "transform") => ({ nodeId, pluginId, methodId, kind, drainPolicy: "single-shot" });
  const edge = (fromNodeId, fromPortId, toNodeId, toPortId) => ({ edgeId: [fromNodeId, fromPortId, toNodeId, toPortId].join("-"),
    fromNodeId, fromPortId, toNodeId, toPortId, backpressurePolicy: "queue", queueDepth: 1 });
  const { flow } = deepSpaceFlow({ node, edge, http: HTTP, storage: STORAGE, packageDir });
  async function transport(folder, sourceFile) {
    const original = path.join(modules, "hostcap", folder), target = path.join(out, "transport", folder);
    const manifest = JSON.parse(await fs.readFile(path.join(original, "plugin-manifest.json"), "utf8"));
    manifest.sequentialJustification = { kind: "caller-level-parallelism", detail: "Serial host I/O per input frame; host owns concurrency." };
    await fs.mkdir(path.join(target, "dist/isomorphic"), { recursive: true });
    let sourceCode = await fs.readFile(path.join(original, "src", sourceFile), "utf8");
    if (folder === "http-request") { sourceCode = fixtureHttpSource(responses); manifest.capabilities = []; manifest.externalInterfaces = []; }
    const result = await compileModuleFromSource({ manifest, sourceCode, language: "c++", outputPath: path.join(target, "dist/isomorphic/module.wasm"),
      threadModel: "wasi-sequential", allowUndefinedImports: true });
    if (!result.report?.ok) throw new Error(`Host hook ${folder} validation failed`, { cause: result.report?.issues });
    const entry = (await resolveFlowDependencies({ depsPath: original })).get(manifest.pluginId);
    return { ...entry, manifest, normalized: normalizeManifestForSdnFlow(manifest), wasmPath: result.outputPath,
      guestLink: { objectBytes: result.guestLink.objectBytes, metadata: result.guestLink } };
  }
  const dependencies = await resolveFlowDependencies({ depsPath: packageDir });
  dependencies.get(SOURCE).guestLink = { objectBytes: await fs.readFile(path.join(packageDir, "dist/guest-link/module-link.o")),
    metadata: JSON.parse(await fs.readFile(path.join(packageDir, "dist/guest-link/metadata.json"), "utf8")) };
  dependencies.set(HTTP, await transport("http-request", "http_request_module.cpp"));
  dependencies.set(STORAGE, await transport("storage-ingest", "storage_ingest_module.cpp"));
  await compileFlowProgram({ flow, dependencies, outDir: path.join(out, "runtime"), standardsRoot });
  return path.join(out, "runtime");
}

// Every part of one lane's batch, by the public list-published protocol, then every manifest and shard by CID.
async function readbackLane({ client, sdn, peer, peerId, node, lane, batchId, firstManifestCid, expectedCount, license }) {
  const sds = path.dirname(require.resolve("spacedatastandards.org/package.json"));
  const { DPM } = await import(pathToFileURL(path.join(sds, "lib/js/DPM/DPM.js")));
  const { OEM } = await import(pathToFileURL(path.join(sds, "lib/js/OEM/OEM.js")));
  const { EGP } = await import(pathToFileURL(path.join(sds, "lib/js/EGP/EGP.js")));
  const { publicationAssetKind } = await import(pathToFileURL(path.join(sds, "lib/js/DPM/publicationAssetKind.js")));
  const segments = [], cursors = new Set();
  let cursor = "", totalParts;
  do {
    assert(!cursors.has(cursor), "Repeated publication-page cursor"); cursors.add(cursor);
    const stream = await client.libp2p.dialProtocol(peer, sdn.FLATSQL_SYNC_LIST_PUBLISHED_PROTOCOL_ID, { signal: AbortSignal.timeout(30000) });
    const chunks = [];
    const reading = (async () => { for await (const c of stream) chunks.push(c instanceof Uint8Array ? c : c.subarray()); })();
    if (!stream.send(sdn.encodeFlatSqlPublishedListRequest({ schema: lane.schema, providerId: PROVIDER, sourceName: lane.source, batchId, cursor, limit: 2 })))
      await stream.onDrain?.();
    await stream.close(); await reading;
    const page = sdn.decodeFlatSqlPublishedList(Buffer.concat(chunks));
    totalParts ??= page.totalCount; assert.equal(page.totalCount, totalParts);
    assert(totalParts >= 1 && totalParts < 10000, "Bounded series");
    for (const p of page.publications) {
      assert.equal(p.batchId, batchId); assert.equal(p.providerId, PROVIDER);
      assert.equal(p.sourceName, lane.source); assert.equal(p.schemaName, lane.schema);
      segments.push({ ...p, cid: p.shardCid, rowCount: p.recordCount });
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(segments.length, totalParts, "Every publication page consumed");
  segments.sort((a, b) => a.offset - b.offset);
  let offset = 0;
  for (const s of segments) { assert.equal(s.offset, offset, "No gap or overlap in batch"); offset += s.rowCount; }
  assert.equal(offset, expectedCount, `${lane.source}: complete batch count`);
  assert(segments.some((s) => s.manifestCid === firstManifestCid), "Summary manifest belongs to this series");
  const cat = async (cid) => {
    const r = await fetch(node.rpc + "/api/v0/cat?arg=" + encodeURIComponent(cid), { method: "POST", signal: AbortSignal.timeout(30000) });
    assert.equal(r.status, 200, `CID ${cid}`); return Buffer.from(await r.arrayBuffer());
  };
  const ids = [], seenShards = new Set(), shards = [];
  for (const segment of segments) {
    const bytes = await cat(segment.manifestCid);
    const dpm = (bytes.subarray(8, 12).toString() === "$DPM" ? DPM.getSizePrefixedRootAsDPM : DPM.getRootAsDPM)(new ByteBuffer(bytes)).unpack();
    assert(dpm.PROVIDER_SIGNATURE.length); assert.equal(dpm.PROVIDER_PEER_ID, peerId);
    assert(dpm.SOURCES.some((s) => s.SOURCE_NAME === lane.source && s.LICENSE === license), `${lane.source}: DPM source license ${license}`);
    const assets = dpm.ASSETS.filter((a) => a.ASSET_KIND === publicationAssetKind.DATA_SHARD && a.SCHEMA_NAME === lane.schema);
    assert.deepEqual(assets.map((a) => a.CID), [segment.cid], "Signed part binds the batch segment");
    for (const asset of assets) {
      assert(!seenShards.has(asset.CID), "Duplicate shard in batch"); seenShards.add(asset.CID);
      let b = await cat(asset.CID);
      assert.equal(sha256(b), asset.BYTE_SHA256.toLowerCase()); assert.equal(b.length, Number(asset.BYTE_LENGTH));
      if (b[0] === 31 && b[1] === 139) b = gunzipSync(b);
      let count = 0;
      for (let at = 0; at < b.length;) {
        assert(at + 4 <= b.length, "Truncated frame length");
        const n = b.readUInt32LE(at);
        assert(n > 8 && at + 4 + n <= b.length, "Truncated record");
        const record = b.subarray(at, at + 4 + n);
        assert.equal(record.subarray(8, 12).toString(), lane.schema === "OEM.fbs" ? "$OEM" : "$EGP");
        ids.push(lane.schema === "OEM.fbs" ? OEM.getSizePrefixedRootAsOEM(new ByteBuffer(record)).EPHEMERIS_DATA_BLOCK(0).OBJECT_NAIF_ID()
          : EGP.getSizePrefixedRootAsEGP(new ByteBuffer(record)).GROUP_ID());
        count++; at += 4 + n;
      }
      assert.equal(count, segment.rowCount, "Shard count matches batch segment");
      shards.push({ manifestCid: segment.manifestCid, cid: asset.CID, count });
    }
  }
  assert.equal(new Set(ids).size, expectedCount, `${lane.source}: unique identities`);
  return { ids, shards };
}

// lanes: [{schema, source, ids, license}] expected from the browser replay of the same cassette.
export async function nativePublication({ packageDir, binary, sdnJs, cassette, lanes }) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "deep-space-native-"));
  const node = await localNode(binary);
  const day = new Date(cassette.firedMs).toISOString().slice(0, 10);
  try {
    const flowDir = await compileFixtureFlow(packageDir, cassette.responses, scratch);
    node.config.publishing.allowed_schemas = ["OEM", "OEM.fbs", "EGP", "EGP.fbs"];
    // Small shards: each lane's series spans several signed parts.
    node.config.publishing.auto_publish = lanes.map((l) => ({ schema: l.schema, provider_id: PROVIDER, source_name: l.source,
      min_interval: "1s", settle: "1s", max_shard_bytes: 65536 }));
    await node.start();
    const portable = await fs.readFile(path.join(flowDir, "runtime.wasm"));
    const r = await fetch(node.base + "/api/v1/admin/modules/sign", { method: "POST", headers: { "Content-Type": "application/wasm" }, body: portable, signal: AbortSignal.timeout(60000) });
    assert(r.ok, "Scratch-node signing " + r.status);
    const sig = await r.json(); assert.equal(sig.content_hash, sha256(portable));
    const bundle = await createSingleFileBundle({ wasmBytes: portable, signature: sig.signature_entry });
    const signed = appendPublicationRecordCollection(portable, encodePublicationRecordCollection({ mbl: bundle.bundle }));
    assert((await verifyModuleArtifact(signed, { requireSignature: true, trustedPublicKeys: [sig.public_key_hex] })).verified);
    await node.stop();
    const target = path.join(node.dir, "flows", PROGRAM);
    await fs.cp(flowDir, target, { recursive: true });
    await fs.writeFile(path.join(target, "runtime.wasm"), signed);
    await fs.writeFile(path.join(target, "isomorphic/module.wasm"), signed);
    // The cassette's day: the node's tick supplies retrieval time, run_day the planning day.
    node.config.flows.services = [{ flow: PROGRAM, memory_pages: 16384, intervals: { daily: "24h" }, retrieval_interval: "23h",
      exclusive_group: "deep-space-spacecraft", release_after_run: true, config: { ...cassette.config, run_day: day } }];
    await fs.mkdir(path.join(node.dir, "data/modules"), { recursive: true });
    await fs.writeFile(path.join(node.dir, "data/modules/capability_policy.json"), JSON.stringify({ version: 1, approvals: [{
      module_hash: sha256(portable), capability: "storage_ingest", plugin_id: PROGRAM, approved_at: new Date().toISOString(),
      approved_by: "deep-space-spacecraft-e2e", note: "Isolated fixture replay" }] }));
    await fs.writeFile(node.configPath, JSON.stringify(node.config, null, 2));
    const log = await fs.open(path.join(node.dir, "prewarm.log"), "w");
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(binary, ["prewarm-aot", "--config", node.configPath], { cwd: node.dir, env: node.env, stdio: ["ignore", log.fd, log.fd] });
        p.once("error", reject); p.once("exit", (code) => code === 0 ? resolve() : reject(Error("prewarm " + code + "; " + node.dir)));
      });
    } finally { await log.close(); }
    const info = await node.start();
    const published = {}, deadline = Date.now() + 240000;
    while (Date.now() < deadline && Object.keys(published).length < lanes.length) {
      const text = await fs.readFile(path.join(node.dir, "sdn.log"), "utf8");
      for (const m of text.matchAll(/auto-published (OEM|EGP)\.fbs deep-space-spacecraft\/([a-z-]+) batch ([^\s]+): (\d+) records, manifest ([^\s]+)/g))
        published[m[2]] = { batchId: m[3], count: Number(m[4]), manifest: m[5] };
      if (Object.keys(published).length < lanes.length) await new Promise((res) => setTimeout(res, 1000));
    }
    assert.deepEqual(Object.keys(published).sort(), lanes.map((l) => l.source).sort(), "every lane auto-published: " + node.dir + "/sdn.log");
    const sdn = await import(pathToFileURL(path.join(sdnJs, "dist/index.mjs")));
    const client = await sdn.createHeliaSDNNode({ edgeRelays: [`/ip4/127.0.0.1/tcp/${node.ports.ws}/ws/p2p/${info.peer_id}`],
      enableAutoDial: false, enableDHT: false, enableIdentify: true, allowPrivateAddressDial: true });
    const results = [];
    try {
      let peer;
      const until = Date.now() + 30000;
      while (!peer && Date.now() < until) {
        peer = client.libp2p.getConnections().find((c) => String(c.remotePeer) === info.peer_id)?.remotePeer;
        if (!peer) await new Promise((res) => setTimeout(res, 200));
      }
      assert(peer, "Scratch-node peer connection timed out");
      for (const lane of lanes) {
        const p = published[lane.source];
        assert.equal(p.count, lane.ids.length, `${lane.source}: auto-publisher completed the batch`);
        const back = await readbackLane({ client, sdn, peer, peerId: info.peer_id, node, lane, batchId: p.batchId,
          firstManifestCid: p.manifest, expectedCount: lane.ids.length, license: lane.license });
        assert.deepEqual([...back.ids].sort(), [...lane.ids].sort(), `${lane.source}: same identities as the replay`);
        results.push({ ...lane, ...back, manifest: p.manifest });
      }
    } finally { await client.stop(); }
    await node.stop();
    await fs.rm(node.dir, { recursive: true, force: true }); // kept on failure for its sdn.log
    return results;
  } finally {
    await node.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
