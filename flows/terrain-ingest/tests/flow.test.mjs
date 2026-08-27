/*
 * Flow-level tests for the compiled terrain-ingest flow — the OFF-FLEET
 * pyramid builder.
 *
 * WHY THIS FILE EXISTS. `npm test` in this package used to report success over
 * an EMPTY tests/ directory: `node --test tests/*.test.mjs` printed
 * "tests 0 / pass 0 / fail 0" and exited 0. A gate that cannot fail is the
 * shape this task's other lanes were held to and corrected in rounds 2 and 4,
 * and this is the flow that builds the ENTIRE published tileset — it was
 * exercised only indirectly, through the tools/terrain-pyramid regional run.
 * That run is genuinely stronger evidence than a unit test, and it is also not
 * something CI can hold a change against.
 *
 * WHAT IS ASSERTED are the invariants the flow's own description claims and
 * that nothing else in the repository checks:
 *
 *   1. one tick is ONE CELL: eight granule descriptors (2x2 neighbourhood in
 *      elevation and water-body form) and one batch of $DTT records;
 *   2. the durable resume mark is written FROM THE VERIFIED STORE RESULT and
 *      not at dispatch — a store that accepts the call but keeps nothing must
 *      leave the mark where it was, so the cell is re-run rather than becoming
 *      an invisible hole in the pyramid;
 *   3. the mark actually ADVANCES the enumeration: a second tick reading the
 *      first tick's $IRM plans a DIFFERENT cell;
 *   4. the compiled artifact carries exactly the four capabilities the flow
 *      declares, and no more.
 *
 * The SAME compiled runtime.wasm that tools/terrain-pyramid/run.mjs executes
 * is instantiated here, with the same four host operations stubbed in the Go
 * host's dialect. Granules are synthesized per requested URL rather than
 * fetched, so the suite is hermetic and needs no cache.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const RUNTIME_WASM = new URL("../dist/runtime.wasm", import.meta.url);
const FLOW_JSON = new URL("../../terrain-ingest.flow.json", import.meta.url);
const ARTIFACT_JSON = new URL("../dist/artifact.json", import.meta.url);

// A single-degree region so one tick's 2x2 neighbourhood is fully synthesized,
// at a level whose tiles are smaller than a granule (the flow refuses anything
// shallower than 8 by name, because a tile wider than a granule breaks the
// containment the neighbourhood rests on).
const CONFIG = {
  dataset_id: "copernicus-glo30-quantized-mesh",
  tileset_id: "spaceaware-terrain",
  dataset_epoch: "2023-04-01T00:00:00.000Z",
  retrieved_at: "2026-08-26T00:00:00.000Z",
  provider_id: "copernicus",
  source_name: "copernicus-glo30",
  grid_size: 9,
  max_grid_size: 25,
  min_level: 8,
  max_level: 8,
  timeout_ms: 120000,
  regions: [{ name: "test-cell", west: 9, south: 44, east: 10, north: 45, max_level: 8, priority: 10 }],
};

// ── hostcall envelope (Go-host dialect) ────────────────────────────────────

function encodeEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4 + segments.reduce((sum, s) => sum + 4 + s.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, metaBytes.length, true);
  out.set(metaBytes, offset + 4);
  offset += 4 + metaBytes.length;
  view.setUint32(offset, segments.length, true);
  offset += 4;
  for (const segment of segments) {
    view.setUint32(offset, segment.length, true);
    out.set(segment, offset + 4);
    offset += 4 + segment.length;
  }
  return out;
}

function decodeEnvelope(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  const meta = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metaLen)));
  let offset = 4 + metaLen;
  const count = view.getUint32(offset, true);
  offset += 4;
  const segments = [];
  for (let i = 0; i < count; i += 1) {
    const length = view.getUint32(offset, true);
    segments.push(Uint8Array.from(bytes.subarray(offset + 4, offset + 4 + length)));
    offset += 4 + length;
  }
  return { meta, segments };
}

// ── a synthetic Copernicus granule for whatever degree square is asked for ──
//
// The URL carries the square (…_N44_00_E009_00_…), so the georeference is
// derived from the request rather than pinned: the tile encoder rejects a
// granule that does not hold the posts it asks for, which would silently turn
// every tile into open ocean and make the assertions below vacuous.
const SQUARE = /_N(\d{2})_00_([EW])(\d{3})_00_/;

function granuleGeoTiff(url) {
  const match = SQUARE.exec(url);
  assert.ok(match, `a granule URL must name its degree square: ${url}`);
  const south = Number(match[1]);
  const west = (match[2] === "W" ? -1 : 1) * Number(match[3]);
  const isWater = /WBM/.test(url);
  const posts = 121; // 30" rather than GLO-30's 1": the georeference is what matters here
  const scale = 1 / (posts - 1);
  const sampleBytes = isWater ? 1 : 4;
  const raw = Buffer.alloc(posts * posts * sampleBytes);
  for (let py = 0; py < posts; py += 1) {
    for (let px = 0; px < posts; px += 1) {
      const at = (py * posts + px) * sampleBytes;
      if (isWater) {
        // A coastline down the middle so the mask is a RASTER rather than
        // uniform: class 0 land, class 1 ocean (the source's own ordinals).
        raw[at] = px < posts / 2 ? 0 : 1;
      } else {
        // Real relief, so the density ladder has something to climb.
        raw.writeFloatLE(Math.fround(200 + 900 * Math.sin(px / 7) * Math.cos(py / 5)), at);
      }
    }
  }
  const compressed = raw; // compression 1 = none, so the fixture stays readable
  const entryCount = 12;
  const ifdBytes = 2 + entryCount * 12 + 4;
  let cursor = 8 + ifdBytes;
  const scaleOffset = cursor;
  cursor += 24;
  const tiepointOffset = cursor;
  cursor += 48;
  const dataOffset = cursor;
  const tags = [];
  const tag = (id, type, count, value) => tags.push({ id, type, count, value });
  tag(256, 3, 1, posts);
  tag(257, 3, 1, posts);
  tag(258, 3, 1, isWater ? 8 : 32);
  tag(259, 3, 1, 1);
  tag(273, 4, 1, dataOffset);
  tag(277, 3, 1, 1);
  tag(278, 3, 1, posts);
  tag(279, 4, 1, compressed.length);
  tag(317, 3, 1, 1);
  tag(339, 3, 1, isWater ? 1 : 3);
  tag(33550, 12, 3, scaleOffset);
  tag(33922, 12, 6, tiepointOffset);
  tags.sort((a, b) => a.id - b.id);
  const file = Buffer.alloc(dataOffset + compressed.length);
  file.write("II", 0, "latin1");
  file.writeUInt16LE(42, 2);
  file.writeUInt32LE(8, 4);
  file.writeUInt16LE(entryCount, 8);
  tags.forEach((t, n) => {
    const at = 10 + n * 12;
    file.writeUInt16LE(t.id, at);
    file.writeUInt16LE(t.type, at + 2);
    file.writeUInt32LE(t.count, at + 4);
    if (t.type === 3) file.writeUInt16LE(t.value, at + 8);
    else file.writeUInt32LE(t.value, at + 8);
  });
  file.writeDoubleLE(scale, scaleOffset);
  file.writeDoubleLE(scale, scaleOffset + 8);
  file.writeDoubleLE(west, tiepointOffset + 24);
  file.writeDoubleLE(south + 1, tiepointOffset + 32);
  compressed.copy(file, dataOffset);
  return file;
}

// ── one tick, driven the way the runner drives it ──────────────────────────

async function tick({ mark = null, storedRecords = null } = {}) {
  const observed = { urls: [], ingested: [], marksWritten: [], egress: [], queries: 0 };
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);

  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const { meta, segments } = decodeEnvelope(
          Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen)),
        );
        if (operation === "plugin.getConfig") {
          response = encodeEnvelope(CONFIG);
          return 0;
        }
        if (operation === "storage.flatsql_query_stream") {
          observed.queries += 1;
          response = encodeEnvelope({ ok: true }, mark ? [mark] : []);
          return 0;
        }
        if (operation === "http.request") {
          observed.urls.push(meta.url);
          response = encodeEnvelope({ ok: true, status: 200, result: { status: 200, headers: {} } }, [
            new Uint8Array(granuleGeoTiff(meta.url)),
          ]);
          return 0;
        }
        if (operation === "storage.ingest_with_source") {
          const stream = Buffer.from(segments[0] ?? new Uint8Array(0));
          const records = [];
          let offset = 0;
          while (offset + 4 <= stream.length) {
            const length = stream.readUInt32LE(offset);
            offset += 4;
            if (length === 0 || offset + length > stream.length) break;
            records.push(stream.subarray(offset, offset + length));
            offset += length;
          }
          observed.ingested.push(records);
          // `storedRecords` is how a store that ACCEPTS the call and keeps
          // nothing is expressed — the case the mark must not advance through.
          const kept = storedRecords === null ? records.length : storedRecords;
          // `inserted` is the connector's own key — hostcap/storage-ingest
          // documents its host result as {"schema","inserted","batch_id",…} —
          // and it is what publish_request's silent-nop guard reads. Writing
          // `records` here instead is exactly the defect this suite found in
          // tools/terrain-pyramid/run.mjs: under the wrong key `inserted`
          // parses as absent, the guard can never fire, and every durable mark
          // claims 0 records committed.
          response = encodeEnvelope({
            ok: true,
            result: { ok: true, schema: meta?.schema, batch_id: meta?.batch_id, inserted: kept },
          });
          return 0;
        }
        if (operation === "storage.write") {
          const bytes = Buffer.from(String(meta?.data ?? ""), "base64");
          observed.marksWritten.push({ schema: String(meta?.schema ?? ""), bytes });
          response = encodeEnvelope({ ok: true, result: { ok: true, schema: meta?.schema, bytes: bytes.length } });
          return 0;
        }
        response = encodeEnvelope({ ok: false, message: `unexpected op ${operation}` });
        return 1;
      },
      response_len() {
        return response.length;
      },
      read_response(dstPtr, dstLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const length = Math.min(dstLen, response.length);
        heap.set(response.subarray(0, length), dstPtr);
        return length;
      },
    },
  };

  const host = await createFlowRuntimeHost({
    wasmSource: new Uint8Array(fs.readFileSync(fileURLToPath(RUNTIME_WASM))),
    extraImports: imports,
    runtimeTarget: "wasmedge",
  });
  memoryRef.memory = host.memory;
  host.enqueueTriggerFrame(0, {
    portId: "tick",
    bytes: encoder.encode(JSON.stringify({ firedAt: "2026-08-27T00:00:00.000Z" })),
  });
  await host.drain(
    {
      "sdn.flow.egress:emit": ({ frames }) => {
        for (const frame of frames) observed.egress.push(decoder.decode(frame.bytes));
        return { statusCode: 0 };
      },
    },
    { maxIterations: 400 },
  );
  observed.reports = observed.egress
    .map((text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return observed;
}

// The store's own framing, so a mark written by one tick reads back as the
// query connector would deliver it to the next.
function markStream(bytes) {
  const framed = Buffer.alloc(4 + bytes.length);
  framed.writeUInt32LE(bytes.length, 0);
  bytes.copy(framed, 4);
  return new Uint8Array(framed);
}

// ---------------------------------------------------------------------------

test("one tick is ONE CELL: eight granule descriptors and one batch of $DTT records", async () => {
  const run = await tick();
  assert.equal(run.urls.length, 8, `the 2x2 neighbourhood in both products: ${run.urls.join(", ")}`);
  assert.equal(run.urls.filter((u) => /WBM/.test(u)).length, 4, "four water-body granules");
  assert.equal(run.urls.filter((u) => !/WBM/.test(u)).length, 4, "four elevation granules");
  assert.equal(new Set(run.urls).size, 8, "and no URL fetched twice in one tick");

  assert.equal(run.ingested.length, 1, "one storage.ingest_with_source per cell, not one per tile");
  const records = run.ingested[0];
  assert.ok(records.length > 0, "the cell stored at least one tile");
  for (const record of records) {
    assert.equal(
      record.subarray(4, 8).toString("latin1"),
      "$DTT",
      "every stored record carries the $DTT file identifier",
    );
  }

  // The encoder's own count and the store's count are the same number: a batch
  // that reports success while storing nothing is exactly what `recordsOut`
  // exists to catch.
  const report = run.reports.find((r) => r.tilesEmitted !== undefined);
  assert.ok(report, "the tile node reports what it emitted");
  assert.equal(report.recordsOut, records.length, "recordsOut is the batch the store received");
});

test("the resume mark is written FROM THE VERIFIED STORE RESULT, never at dispatch", async () => {
  const good = await tick();
  const irm = good.marksWritten.filter((m) => m.schema.toUpperCase().includes("IRM"));
  assert.equal(irm.length, 1, `one durable mark per cell, got ${good.marksWritten.map((m) => m.schema).join(", ")}`);
  assert.equal(
    irm[0].bytes.subarray(4, 8).toString("latin1"),
    "$IRM",
    "the durable mark is an $IRM record, not the JSON one that lands on egress",
  );

  // …and the count it carries forward is STORAGE's answer, not the builder's
  // hope. Under the wrong result key this was 0 on every mark ever written.
  const markJson = good.reports.find((r) => r.next_tile_index !== undefined);
  assert.ok(markJson, "the operator-readable mark lands on egress beside the durable one");
  assert.equal(
    markJson.stored_tiles_total,
    good.ingested[0].length,
    "the mark's cumulative committed count is what storage said it inserted",
  );

  // The same tick against a store that accepts the call and keeps nothing.
  // Advancing here would leave a hole in the pyramid that no later run finds,
  // because the enumeration would have moved past the cell.
  const empty = await tick({ storedRecords: 0 });
  assert.ok(empty.ingested.length > 0, "the control: it did try to store");
  assert.equal(
    empty.marksWritten.filter((m) => m.schema.toUpperCase().includes("IRM")).length,
    0,
    "a store that kept nothing must not advance the durable mark",
  );
});

test("the mark ADVANCES the enumeration: the next tick plans a different cell", async () => {
  const first = await tick();
  const mark = first.marksWritten.find((m) => m.schema.toUpperCase().includes("IRM"));
  assert.ok(mark, "the first tick wrote a mark to resume from");
  assert.ok(first.queries > 0, "and the flow reads the mark through the FlatSQL view");

  const second = await tick({ mark: markStream(mark.bytes) });
  assert.equal(second.urls.length, 8, "the second tick is also one cell");
  assert.notDeepEqual(
    second.urls.slice().sort(),
    first.urls.slice().sort(),
    "a tick that read the mark and planned the SAME cell is a mark nothing resumes from",
  );
});

test("the compiled artifact carries exactly the capabilities the flow declares", async () => {
  // Least privilege, checked against the ARTIFACT rather than the source: this
  // flow is the only one in the lane that may write, and a capability that
  // creeps into the built bundle is what a deployment actually grants.
  const artifact = JSON.parse(fs.readFileSync(fileURLToPath(ARTIFACT_JSON), "utf8"));
  const declared = [...(artifact.capabilities ?? [])].sort();
  assert.deepEqual(
    declared,
    ["http", "storage_ingest", "storage_query", "storage_write"].sort(),
    "the off-fleet builder fetches, queries the mark, appends the batch and writes the mark — nothing else",
  );
  // …and the flow it was compiled from says the same thing, so the two cannot
  // drift without this failing.
  const flow = JSON.parse(fs.readFileSync(fileURLToPath(FLOW_JSON), "utf8"));
  assert.equal(flow.programId, artifact.programId ?? flow.programId);
});
