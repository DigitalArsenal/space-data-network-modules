import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { decodeIngestResult, encodeIngestRequest, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { createFlatsqlHost, decodeWrapper, withFlatsqlImports } from "./flatsql-host.mjs";

// hostcap/flatsql-store on the typed contracts (1.0), end to end on the built artifact: real fitted records
// (analysis/od's $OMM/$OCM for the ISS OEM fixture, an $OBD for that run, celestrak-parser's $OMM stream for its GP
// fixture) on omm/ocm/obd_records, IngestRequest provenance, a TimerTick trigger and the node config (ModuleConfig via
// plugin.getConfig) in; the wrappers ingested through the "flatsql" trampolines and one IngestResult out. The legacy
// artifact's wrappers for the same inputs (tests/fixtures/legacy-*.wrappers.bin) are the byte-for-byte reference.
const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const FIXTURES = new URL("./fixtures/", import.meta.url);

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));
const fixture = (name) => new Uint8Array(fs.readFileSync(new URL(name, FIXTURES)));
function splitStream(s) {
  const out = [];
  for (let i = 0; i < s.length;) { const n = new DataView(s.buffer, s.byteOffset + i).getUint32(0, true); out.push(s.slice(i, i + 4 + n)); i += 4 + n; }
  return out;
}

const OMM = fixture("iss.omm.bin"), OCM = fixture("iss.ocm.bin"), OBD = fixture("iss.obd.bin");
const [GP0, GP1] = splitStream(fixture("celestrak-gp.omm-stream.bin"));
const CONFIG = { provider: "space-data-network-02", source_name: "od-supplemental", batch_id: "cfg-batch", retain_k: 4 };
const FIRED_MS = 1791900000000;

const typeRef = (code) => ({ schemaName: `${code}.fbs`, fileIdentifier: `$${code}`, rootTypeName: code, wireFormat: "flatbuffer" });
const INGQ = { schemaName: "IngestRequest.fbs", fileIdentifier: "INGQ", rootTypeName: "IngestRequest", wireFormat: "flatbuffer" };
const TICK = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };
const rec = (code, payload) => ({ portId: `${code.toLowerCase()}_records`, typeRef: typeRef(code), payload });
const sha256Hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const prov = (record, schema, provider) => ({ portId: "provenance", typeRef: INGQ, payload: encodeIngestRequest({
  schema, tags: { providerId: provider, sourceName: provider }, provenance: { parser: "analysis/od", normalizedSha256: sha256Hex(record), normalizedCount: 1 } }) });
const trigger = (firedMs) => ({ portId: "trigger", typeRef: TICK, payload: encodeTimerTick({ triggerId: "od-supplemental", scheduledMs: firedMs, firedMs, sequence: 1 }) });

async function harnessFor(t, host, config = CONFIG) {
  const harness = await withFlatsqlImports(host, () =>
    createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface: "direct", hostOptions: { config } }));
  t.after(() => harness.destroy());
  return harness;
}
function result(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "result");
  return decodeIngestResult(response.outputs[0].payload);
}
const wrappersOf = (host) => host.log.ingested.map((x) => x.bytes);
const sameBytes = (actual, legacyFile) => {
  const legacy = splitStream(fixture(legacyFile)).map((b) => b.slice(4));
  assert.equal(actual.length, legacy.length);
  actual.forEach((b, i) => assert.ok(Buffer.from(b).equals(Buffer.from(legacy[i])), `wrapper ${i} differs from the legacy artifact's`));
};

test("hostcap/flatsql-store passes SDK compliance; every port names ONE concrete FlatBuffer type", async () => {
  const report = await validateArtifactWithStandards({ manifest: readManifest(), wasmPath: fileURLToPath(WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  const [method] = readManifest().methods;
  const ids = {};
  for (const port of [...method.inputPorts, ...method.outputPorts]) {
    assert.equal(port.acceptedTypeSets.length, 1, port.portId);
    assert.equal(port.acceptedTypeSets[0].allowedTypes.length, 1, port.portId);
    const [type] = port.acceptedTypeSets[0].allowedTypes;
    assert.equal(type.acceptsAnyFlatbuffer, undefined, port.portId);
    assert.equal(type.wireFormat, "flatbuffer", port.portId);
    ids[port.portId] = type.fileIdentifier;
  }
  assert.deepEqual(ids, { omm_records: "$OMM", ocm_records: "$OCM", obd_records: "$OBD", provenance: "INGQ", trigger: "TICK", result: "INGR" });
});

test("the artifact imports only WASI, the typed hostcall bridge and the flatsql arena trampolines", async () => {
  const inspection = await inspectModule(readWasm());
  assert.deepEqual(Array.from(new Set(inspection.imports.map((e) => e.module))).sort(), ["flatsql", "space_data_module_host", "wasi_snapshot_preview1"]);
  assert.deepEqual(inspection.imports.filter((e) => e.module === "flatsql").map((e) => e.name).sort(),
    ["compact", "exec_envelope", "ingest_record", "mark_deleted_bulk", "query_rows"]);
});

test("a fire stores $OMM/$OCM/$OBD byte-identically to the legacy artifact and answers one IngestResult", async (t) => {
  const host = createFlatsqlHost();
  const harness = await harnessFor(t, host);
  const out = result(await harness.invoke({ methodId: "store", inputs: [
    rec("OMM", OMM), rec("OCM", OCM), rec("OBD", OBD), rec("OMM", GP0), rec("OMM", GP1),
    prov(OMM, "OMM.fbs", "iss"), prov(OCM, "OCM.fbs", "iss"), trigger(FIRED_MS)] }));
  assert.deepEqual(out, { schema: "", providerId: "space-data-network-02", sourceName: "od-supplemental", batchId: "F000001a135901f00",
    inserted: 5, reconciledDuplicates: 0, reconciledOldBatches: 0, archived: "", refused: "" });
  sameBytes(wrappersOf(host), "legacy-fire.wrappers.bin");

  const w = wrappersOf(host).map(decodeWrapper);
  assert.deepEqual(w.map((x) => [x.fileId, x.provider, x.sourceName, x.pulledAt]), [
    ["SOMM", "iss", "iss", FIRED_MS], ["SOCM", "iss", "iss", FIRED_MS], ["SOBD", "space-data-network-02", "od-supplemental", FIRED_MS],
    ["SOMM", "space-data-network-02", "od-supplemental", FIRED_MS], ["SOMM", "space-data-network-02", "od-supplemental", FIRED_MS]]);
  assert.deepEqual(w.map((x) => x.data), [OMM, OCM, OBD, GP0, GP1], "each record is stored verbatim");
  assert.deepEqual(host.live("sds_omm").length + host.live("sds_ocm").length + host.live("sds_obd").length, 5);

  // The module's own statements: a cid COUNT per record, then the retention scan per table.
  assert.deepEqual(host.log.sql.slice(0, 5).map((s) => s.sql), [
    "SELECT COUNT(*) FROM sds_omm WHERE cid = ?", "SELECT COUNT(*) FROM sds_ocm WHERE cid = ?", "SELECT COUNT(*) FROM sds_obd WHERE cid = ?",
    "SELECT COUNT(*) FROM sds_omm WHERE cid = ?", "SELECT COUNT(*) FROM sds_omm WHERE cid = ?"]);
  assert.deepEqual(host.log.sql.slice(0, 5).map((s) => s.params[0].value), w.map((x) => x.cid));
  assert.deepEqual(host.log.sql.slice(5).map((s) => s.sql), ["sds_omm", "sds_ocm", "sds_obd"].map((tbl) =>
    `SELECT batch_id FROM (SELECT batch_id, MAX(_rowid) AS m FROM ${tbl} GROUP BY batch_id ORDER BY m DESC) LIMIT -1 OFFSET 4`));
  assert.equal(host.log.compacts, 0);
});

test("without a trigger the batch id is the legacy per-invocation CID hash, byte-identical", async (t) => {
  const host = createFlatsqlHost();
  const harness = await harnessFor(t, host);
  const out = result(await harness.invoke({ methodId: "store", inputs: [rec("OCM", OCM), rec("OMM", GP1), rec("OMM", OMM)] }));
  sameBytes(wrappersOf(host), "legacy-notrigger.wrappers.bin");
  const w = wrappersOf(host).map(decodeWrapper);
  assert.ok(out.batchId.startsWith("bafkrei"));
  assert.ok(w.every((x) => x.batchId === out.batchId && x.pulledAt === 0));
  assert.equal(out.inserted, 3);
});

test("a later invocation of the same fire (no trigger frame) keeps the fire's batch id; stored cids are skipped", async (t) => {
  const host = createFlatsqlHost();
  const harness = await harnessFor(t, host);
  result(await harness.invoke({ methodId: "store", inputs: [rec("OMM", OMM), trigger(FIRED_MS)] }));
  const second = result(await harness.invoke({ methodId: "store", inputs: [rec("OMM", OMM), rec("OCM", OCM)] }));
  assert.deepEqual([second.batchId, second.inserted, second.reconciledDuplicates], ["F000001a135901f00", 1, 1]);
  const w = wrappersOf(host).map(decodeWrapper);
  assert.deepEqual(w.map((x) => [x.fileId, x.batchId, x.pulledAt]), [["SOMM", "F000001a135901f00", FIRED_MS], ["SOCM", "F000001a135901f00", FIRED_MS]]);
});

test("retention keeps the latest retain_k runs per table, tombstones the rest and compacts", async (t) => {
  const host = createFlatsqlHost();
  const harness = await harnessFor(t, host, { ...CONFIG, retain_k: 2 });
  const fires = [[GP0, FIRED_MS], [GP1, FIRED_MS + 3600000], [OMM, FIRED_MS + 7200000]];
  const results = [];
  for (const [record, ms] of fires) results.push(result(await harness.invoke({ methodId: "store", inputs: [rec("OMM", record), trigger(ms)] })));
  assert.deepEqual(results.map((r) => r.reconciledOldBatches), [0, 0, 1]);
  assert.deepEqual(host.log.tombstoned.map((x) => [x.table, x.batchId]), [["sds_omm", results[0].batchId]]);
  assert.equal(host.log.compacts, 1);
  assert.deepEqual(host.live("sds_omm").map((r) => decodeWrapper(r.bytes).data), [GP1, OMM]);
});

test("a frame whose record is not its port's standard is never stored", async (t) => {
  const host = createFlatsqlHost();
  const harness = await harnessFor(t, host);
  const out = result(await harness.invoke({ methodId: "store", inputs: [rec("OMM", OCM), rec("OBD", OMM), trigger(FIRED_MS)] }));
  assert.deepEqual([out.inserted, out.reconciledDuplicates, host.log.ingested.length], [0, 0, 0]);
});

test("empty node config: provider/source fall back to empty, retain_k to 4", async (t) => {
  const host = createFlatsqlHost();
  const harness = await harnessFor(t, host, {});
  const out = result(await harness.invoke({ methodId: "store", inputs: [rec("OBD", OBD), trigger(FIRED_MS)] }));
  assert.deepEqual([out.providerId, out.sourceName, out.inserted], ["", "", 1]);
  assert.ok(host.log.sql.at(-1).sql.endsWith("OFFSET 4"));
});

test("a failed dedup or ingest trampoline fails the invocation with its code and no result", async (t) => {
  for (const [op, code] of [["exec_envelope", "flatsql-dedup-failed"], ["ingest_record", "flatsql-ingest-failed"]]) {
    const host = createFlatsqlHost();
    host.flatsql[op] = () => -1n;
    const harness = await harnessFor(t, host);
    const response = await harness.invoke({ methodId: "store", inputs: [rec("OMM", OMM), trigger(FIRED_MS)] });
    assert.notEqual(response.statusCode, 0);
    assert.equal(response.errorCode, code);
    assert.equal(response.outputs.length, 0);
  }
});
