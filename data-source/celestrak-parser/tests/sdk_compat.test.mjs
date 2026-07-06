// data-source/celestrak-parser SDK-compat tests (loop C.8a): the pure
// provider-parser nodes run in the SDK browser harness against the SAME
// fixture payloads sdn-server's internal/ingest tests use, and their
// outputs are asserted structurally: ingest metas carry full attribution
// (batch = sha256 of the payload), record streams are size-prefixed
// FlatBuffers with the right file identifiers, and the runner's failure
// gates (duplicate SATCAT NORAD, SPW staleness, non-200 fetch) reproduce.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const GP_CSV = fs.readFileSync(new URL("./fixtures/celestrak-gp-omm.csv", import.meta.url));
const SATCAT_TXT = fs.readFileSync(new URL("./fixtures/celestrak-satcat.txt", import.meta.url));
const SATCAT_CSV = fs.readFileSync(new URL("./fixtures/celestrak-satcat.csv", import.meta.url));
const SW_CSV = fs.readFileSync(new URL("./fixtures/celestrak-sw-all.csv", import.meta.url));

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function readWasm() {
  return fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH));
}

function jsonInput(portId, value) {
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary" },
    payload: encoder.encode(JSON.stringify(value)),
  };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createHarness(t) {
  const harness = await createBrowserModuleHarness({
    wasmSource: readWasm(),
    manifest: readManifest(),
    surface: "direct",
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  const map = new Map();
  for (const frame of response.outputs) {
    map.set(frame.portId, frame);
  }
  return map;
}

function jsonFrame(map, portId) {
  const frame = map.get(portId);
  assert.ok(frame, `missing output frame ${portId}`);
  return JSON.parse(decoder.decode(frame.payload));
}

// Splits a size-prefixed record stream into unprefixed record buffers.
function splitStream(payload) {
  const records = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
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

function fileIdentifier(record) {
  return decoder.decode(record.subarray(4, 8));
}

function httpResponse(bodyBytes, headers = {}) {
  return {
    status: 200,
    headers,
    bodyB64: Buffer.from(bodyBytes).toString("base64"),
  };
}

const GP_JOB = {
  source_url: "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=full-catalog&FORMAT=csv",
  source_name: "celestrak-gp",
  archive_source: "celestrak",
  archive_name: "catalog.csv",
};

test("celestrak-parser artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("celestrak-parser artifact is pure: canonical ABI, WASI-only imports", async () => {
  const inspection = await inspectModule(readWasm());
  // No hostcall bridge import at all -> the inspector classifies the module
  // as "standalone" (pure compute node); the canonical ABI exports must
  // still be present.
  assert.equal(inspection.profile, "standalone");
  const importedModuleNames = Array.from(
    new Set(inspection.imports.map((entry) => entry.module)),
  ).sort();
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  for (const required of [
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("parse_gp produces OMM + MPE streams with full attribution", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp",
    inputs: [jsonInput("job", GP_JOB), jsonInput("response", httpResponse(GP_CSV))],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);

  const ommMeta = jsonFrame(outputs, "omm_meta");
  assert.equal(ommMeta.schema, "OMM.fbs");
  assert.equal(ommMeta.provider_id, "space-data-network-02");
  assert.equal(ommMeta.source_name, "celestrak-gp");
  assert.equal(ommMeta.source_url, GP_JOB.source_url);
  assert.equal(ommMeta.batch_id, sha256Hex(GP_CSV));
  assert.equal(ommMeta.content_key_id, "public");
  assert.equal(ommMeta.source_peer, "source:celestrak");
  assert.equal(ommMeta.reconcile, "duplicates");
  assert.deepEqual(ommMeta.archive, { source: "celestrak", name: "catalog.csv" });
  assert.equal(ommMeta.provenance.source, "celestrak-gp");
  const provenance = JSON.parse(Buffer.from(ommMeta.provenance.json, "base64").toString("utf8"));
  assert.equal(provenance.source_sha256, sha256Hex(GP_CSV));
  assert.equal(provenance.parser_version, "celestrak-gp-wasm/v2");
  assert.equal(provenance.schema_counts["OMM.fbs"], 2);
  assert.equal(provenance.schema_counts["MPE.fbs"], 2);

  const mpeMeta = jsonFrame(outputs, "mpe_meta");
  assert.equal(mpeMeta.schema, "MPE.fbs");
  assert.equal(mpeMeta.batch_id, sha256Hex(GP_CSV));
  assert.equal(mpeMeta.archive, undefined, "raw payload is archived once (OMM meta only)");

  const ommRecords = splitStream(outputs.get("omm_records").payload);
  assert.equal(ommRecords.length, 2);
  for (const record of ommRecords) {
    assert.equal(fileIdentifier(record), "$OMM");
  }
  const mpeRecords = splitStream(outputs.get("mpe_records").payload);
  assert.equal(mpeRecords.length, 2);
  for (const record of mpeRecords) {
    assert.equal(fileIdentifier(record), "$MPE");
  }

  const raw = outputs.get("raw");
  assert.deepEqual(Buffer.from(raw.payload), Buffer.from(GP_CSV), "raw payload passthrough");
});

test("parse_gp rejects non-200 fetches", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_gp",
    inputs: [
      jsonInput("job", GP_JOB),
      jsonInput("response", { status: 503, headers: {}, bodyB64: "" }),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /503/);
});

for (const [label, payload] of [
  ["fixed-width txt", SATCAT_TXT],
  ["csv", SATCAT_CSV],
]) {
  test(`parse_satcat handles the ${label} format`, async (t) => {
    const harness = await createHarness(t);
    const response = await harness.invoke({
      methodId: "parse_satcat",
      inputs: [
        jsonInput("job", {
          source_url: "https://celestrak.org/pub/satcat.txt",
          source_name: label === "csv" ? "celestrak-satcat-csv" : "celestrak-satcat",
          archive_source: "celestrak",
          archive_name: label === "csv" ? "satcat.csv" : "satcat.txt",
        }),
        jsonInput("response", httpResponse(payload)),
      ],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    const outputs = outputsByPort(response);
    const catMeta = jsonFrame(outputs, "cat_meta");
    assert.equal(catMeta.schema, "CAT.fbs");
    assert.equal(catMeta.reconcile, "current", "SATCAT is a snapshot source");
    assert.equal(catMeta.batch_id, sha256Hex(payload));
    const catRecords = splitStream(outputs.get("cat_records").payload);
    assert.equal(catRecords.length, 2);
    for (const record of catRecords) {
      assert.equal(fileIdentifier(record), "$CAT");
    }
  });
}

test("parse_satcat rejects duplicate NORAD ids (runner parity)", async (t) => {
  const harness = await createHarness(t);
  const dup = Buffer.concat([SATCAT_TXT, Buffer.from("\n"), SATCAT_TXT]);
  const response = await harness.invoke({
    methodId: "parse_satcat",
    inputs: [
      jsonInput("job", { source_url: "https://x.test", source_name: "celestrak-satcat" }),
      jsonInput("response", httpResponse(dup)),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /duplicate SATCAT NORAD_CAT_ID/);
});

test("parse_spw builds SPW records when the source is fresh", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_spw",
    inputs: [
      jsonInput("job", {
        source_url: "https://celestrak.org/SpaceData/SW-All.csv",
        source_name: "celestrak-space-weather",
        archive_source: "celestrak",
        archive_name: "SW-All.csv",
      }),
      jsonInput(
        "response",
        // Fixture rows end 2026-01-02: a Last-Modified in the same window
        // keeps the 7-day staleness gate green (the reference time).
        httpResponse(SW_CSV, { "last-modified": "Fri, 02 Jan 2026 12:00:00 GMT" }),
      ),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const outputs = outputsByPort(response);
  const spwMeta = jsonFrame(outputs, "spw_meta");
  assert.equal(spwMeta.schema, "SPW.fbs");
  assert.equal(spwMeta.batch_id, sha256Hex(SW_CSV));
  const spwRecords = splitStream(outputs.get("spw_records").payload);
  assert.equal(spwRecords.length, 2);
  for (const record of spwRecords) {
    assert.equal(fileIdentifier(record), "$SPW");
  }
});

test("parse_spw enforces the 7-day stale-source gate", async (t) => {
  const harness = await createHarness(t);
  const response = await harness.invoke({
    methodId: "parse_spw",
    inputs: [
      jsonInput("job", {
        source_url: "https://celestrak.org/SpaceData/SW-All.csv",
        source_name: "celestrak-space-weather",
      }),
      // No Last-Modified: the reference falls back to NOW, far past the
      // fixture's 2026-01-02 latest DATE.
      jsonInput("response", httpResponse(SW_CSV)),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.match(response.errorMessage ?? "", /stale source timestamp/);
});
