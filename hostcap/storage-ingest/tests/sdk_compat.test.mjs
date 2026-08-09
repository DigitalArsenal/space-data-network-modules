// hostcap/storage-ingest SDK-compat tests (loop C.8a): the capability node
// forwards the parser's ingest meta + record stream (+ optional raw payload)
// to storage.ingest_with_source as hostcall binary segments and emits the
// host result JSON.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const RECORD_STREAM = Uint8Array.from([3, 0, 0, 0, 0xaa, 0xbb, 0xcc, 2, 0, 0, 0, 0x11, 0x22]);
const RAW_PAYLOAD = encoder.encode("NORAD_CAT_ID,EPOCH\n25544,2026-01-01T00:00:00\n");

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

// SDS PIV/TAB aligned typeRefs REQUIRE requiredAlignment and byteLength: the
// SDK invoke codec (src/invoke/codec.js normalizeFrameTypeRef) rejects a frame
// without them and the invoke throws before the wasm is ever entered. This
// suite omitted both, so every behavioural test in it was dead — failing
// identically against old and new artifacts, which reads as "the harness is
// broken" rather than "these fixtures are". Repaired under graph task
// modules-guest-nodes-drop-batched-frames.
function input(portId, payload) {
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength },
    payload,
  };
}

function jsonInput(portId, value) {
  return input(portId, encoder.encode(JSON.stringify(value)));
}

function snapshotParams(params) {
  if (params instanceof Uint8Array) return Uint8Array.from(params);
  if (Array.isArray(params)) return params.map(snapshotParams);
  if (params && typeof params === "object") {
    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, snapshotParams(value)]),
    );
  }
  return params;
}

function createIngestStub({ fail } = {}) {
  const calls = [];
  const dispatch = (operation, params) => {
    calls.push({ operation, params: snapshotParams(params) });
    if (operation === "storage.ingest_with_source") {
      if (fail) throw new Error(fail);
      return { schema: params.schema, inserted: 3, batch_id: params.batch_id };
    }
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  return { calls, dispatch };
}

async function createHarness(t, stub) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
    hostcallDispatch: stub.dispatch,
  });
  t.after(() => harness.destroy());
  return harness;
}

const META = {
  schema: "OMM.fbs",
  provider_id: "space-data-network-02",
  source_name: "celestrak-gp",
  source_url: "https://celestrak.org/gp",
  batch_id: "deadbeef",
  content_key_id: "public",
  source_peer: "source:celestrak",
  reconcile: "duplicates",
  archive: { source: "celestrak", name: "catalog.csv" },
};

test("hostcap/storage-ingest artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("ingest forwards meta + records + raw as binary segments", async (t) => {
  const stub = createIngestStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "ingest",
    inputs: [jsonInput("meta", META), input("records", RECORD_STREAM), input("raw", RAW_PAYLOAD)],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  const result = JSON.parse(decoder.decode(frame.payload));
  assert.equal(result.schema, "OMM.fbs");
  assert.equal(result.inserted, 3);

  assert.equal(stub.calls.length, 1);
  const { operation, params } = stub.calls[0];
  assert.equal(operation, "storage.ingest_with_source");
  assert.equal(params.schema, "OMM.fbs");
  assert.equal(params.provider_id, "space-data-network-02");
  assert.equal(params.source_name, "celestrak-gp");
  assert.equal(params.batch_id, "deadbeef");
  assert.equal(params.reconcile, "duplicates");
  // The JS host re-attaches binary segments as Uint8Array at the $bin refs.
  assert.deepEqual(new Uint8Array(params.records), RECORD_STREAM);
  assert.deepEqual(new Uint8Array(params.archive.raw), RAW_PAYLOAD);
  assert.equal(params.archive.source, "celestrak");
  assert.equal(params.archive.name, "catalog.csv");
});

test("ingest without raw strips the archive block (nothing to archive)", async (t) => {
  const stub = createIngestStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "ingest",
    inputs: [jsonInput("meta", META), input("records", RECORD_STREAM)],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const { params } = stub.calls[0];
  assert.equal(params.archive, undefined, "archive naming without raw bytes must be dropped");
  assert.deepEqual(new Uint8Array(params.records), RECORD_STREAM);
});

test("ingest surfaces host failures as node errors", async (t) => {
  const stub = createIngestStub({ fail: "disk guardrail tripped" });
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "ingest",
    inputs: [jsonInput("meta", META), input("records", RECORD_STREAM)],
  });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /disk guardrail|ingest/i);
});

test("ingest requires meta and records frames", async (t) => {
  const stub = createIngestStub();
  const harness = await createHarness(t, stub);
  const response = await harness.invoke({
    methodId: "ingest",
    inputs: [jsonInput("meta", META)],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(stub.calls.length, 0, "no hostcall without a records frame");
});
