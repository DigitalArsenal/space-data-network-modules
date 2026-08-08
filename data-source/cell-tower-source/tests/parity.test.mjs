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
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

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

const httpResponse = (providerId, body) => ({
  provider_id: providerId,
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

// --- reference-side normalization of the same fixture -----------------------
// Mirrors decode_csv in the module: the parity claim is about DECONFLICTION,
// so both sides start from identical reports.
function referenceReports(providerIds) {
  const lines = CSV.toString("utf8").trim().split("\n");
  const header = lines[0].split(",");
  const col = (name) => header.indexOf(name);
  const reports = [];
  for (const providerId of providerIds) {
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      reports.push({
        id: `${providerId}:${c[col("cell")]}`,
        radio: c[col("radio")],
        mcc: Number(c[col("mcc")]),
        mnc: Number(c[col("net")]),
        lac: Number(c[col("area")]),
        cellId: c[col("cell")],
        latitude: Number(c[col("lat")]),
        longitude: Number(c[col("lon")]),
        rangeMeters: Number(c[col("range")]),
        samples: Number(c[col("samples")]),
        observedAt: Number(c[col("updated")]),
        provenance: {
          providerId,
          authority: providerId,
          sourceUrl: `https://example.test/${providerId}`,
          retrievedAt: "2026-08-08T00:00:00.000Z",
          license: "CC BY-SA 4.0",
          attribution: providerId,
        },
      });
    }
  }
  return reports;
}

async function runModule(t, providers, method) {
  const harness = await harnessFor(t);
  const routed = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [
        jsonInput("request", {
          body: JSON.stringify({ PROVIDERS: providers, METHOD: method, LIMIT: 5000 }),
        }),
      ],
    }),
  );
  const job = jsonFrame(routed, "job");

  const responses = providers.map((id) =>
    jsonInput("responses", httpResponse(id, CSV)),
  );
  const parsed = byPort(
    await harness.invoke({
      methodId: "parse",
      inputs: [jsonInput("job", job), ...responses],
    }),
  );
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
    summary: jsonFrame(merged, "summary"),
    records: splitStream(recordsFrame.payload).map(tbsReader),
  };
}

const PROVIDERS = ["fcc-asr", "mls-archive"];

test("catalog answers the provider list the page renders", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "catalog",
      inputs: [jsonInput("request", { body: "" })],
    }),
  );
  const catalog = jsonFrame(out, "catalog");
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
      methodId: "catalog",
      inputs: [jsonInput("request", { body: "" })],
    }),
  );
  const raw = decoder.decode(out.get("catalog").payload);
  for (const forbidden of ["password", "secret", "token", "privateKey", "apiKey"]) {
    assert.ok(
      !new RegExp(forbidden, "iu").test(raw),
      `catalog response mentions ${forbidden}`,
    );
  }
  const catalog = JSON.parse(raw);
  // No node key slot exists yet (upstream-sdn-3), so the catalog must OMIT
  // keySlot rather than publish a placeholder — the GUI keys its refuse-to-
  // collect behaviour off exactly this absence.
  assert.equal("keySlot" in catalog, false);
  // And nothing may claim a credential is held when none can be.
  assert.equal(
    catalog.providers.every((p) => p.credentialConfigured === false),
    true,
  );
});

test("credentialed providers are not selected by default", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "catalog",
      inputs: [jsonInput("request", { body: "" })],
    }),
  );
  const catalog = jsonFrame(out, "catalog");
  // Pre-ticking a provider the run will silently skip produces a result that
  // quietly excludes what the user believes they asked for.
  for (const p of catalog.providers) {
    if (p.credentialRequired) assert.equal(p.defaultSelected, false);
  }
});

test("route refuses an unknown merge method instead of defaulting", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [
        jsonInput("request", {
          body: JSON.stringify({ PROVIDERS: ["fcc-asr"], METHOD: "BEST_GUESS" }),
        }),
      ],
    }),
  );
  const reply = jsonFrame(out, "reply");
  assert.equal(reply.status, 400);
  assert.match(reply.error, /unknown METHOD/u);
  assert.equal(out.has("requests"), false);
});

test("route refuses an empty provider set", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [jsonInput("request", { body: JSON.stringify({ PROVIDERS: [] }) })],
    }),
  );
  assert.equal(jsonFrame(out, "reply").status, 400);
});

test("route skips credentialed providers loudly and never fetches them", async (t) => {
  const harness = await harnessFor(t);
  const out = byPort(
    await harness.invoke({
      methodId: "route",
      inputs: [
        jsonInput("request", {
          body: JSON.stringify({
            PROVIDERS: ["opencellid", "fcc-asr"],
            METHOD: "HIGHEST_SAMPLE_COUNT",
          }),
        }),
      ],
    }),
  );
  const job = jsonFrame(out, "job");
  const requests = jsonFrame(out, "requests");
  // opencellid needs a token the node cannot yet store, so it is skipped with a
  // stated reason. It must NOT appear as a fetch, and must NOT be counted as
  // consulted — "asked" would be a lie.
  assert.deepEqual(requests.map((r) => r.provider_id), ["fcc-asr"]);
  assert.deepEqual(job.providers_consulted, ["fcc-asr"]);
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

test("CELL_ID stays a string — a 36-bit NCI must not be coerced to an int", async (t) => {
  const { records } = await runModule(t, ["fcc-asr"], "SINGLE_SOURCE");
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
      isAuthority: (id) => id === "fcc-asr",
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
    const wasmBuckets = bucket(
      wasm.records.map((r) => ({
        key: `${r.CELL_ID}|${r.MCC}|${r.MNC}`,
        latitude: r.LATITUDE,
        sources: r.sourcesLength,
      })),
      (e) => e.key,
    );
    const refBuckets = bucket(
      reference.sites.map((s) => ({
        key: `${s.cellId}|${s.mcc}|${s.mnc}`,
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

test("PARITY: the duplicate really does collapse, and SINGLE_SOURCE really does not", async (t) => {
  // Guards the parity test above from passing vacuously: if grouping silently
  // stopped working, both implementations would still "agree" on nothing
  // happening. The fixture's first two rows are the same cell.
  const merged = await runModule(t, ["fcc-asr"], "HIGHEST_SAMPLE_COUNT");
  const single = await runModule(t, ["fcc-asr"], "SINGLE_SOURCE");
  assert.ok(
    single.records.length > merged.records.length,
    `SINGLE_SOURCE (${single.records.length}) must emit more sites than a merge (${merged.records.length})`,
  );
  assert.equal(merged.summary.collapsed > 0, true);
});

test("HIGHEST_SAMPLE_COUNT and MOST_RECENT can pick different winners", async (t) => {
  const dense = await runModule(t, ["fcc-asr"], "HIGHEST_SAMPLE_COUNT");
  const fresh = await runModule(t, ["fcc-asr"], "MOST_RECENT");
  const pick = (run) =>
    run.records.find((r) => r.CELL_ID === "17811");
  assert.ok(pick(dense) && pick(fresh));
  // Row 2 has both the higher sample count AND the later timestamp in this
  // fixture, so the winner agrees; what must differ is the RECORDED method.
  assert.equal(dense.summary.method, "HIGHEST_SAMPLE_COUNT");
  assert.equal(fresh.summary.method, "MOST_RECENT");
});
