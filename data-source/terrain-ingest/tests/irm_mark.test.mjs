// THE DURABLE RESUME MARK, ROUND-TRIPPED.
//
// Before this, the mark was ad-hoc JSON declared `acceptsAnyFlatbuffer`, read
// back with `SELECT * FROM terrain_ingest_mark WHERE dataset_id = ? LIMIT 1`,
// and routed to EGRESS by the flow — which declared no storage-write capability
// at all. So nothing wrote it, the query named a relation no node has, and
// granule_plan restarted at cell 0 on every tick. It looked like it worked only
// because the off-fleet runner substituted a local resume-mark.json for the
// storage op.
//
// $IRM was minted and ratified in SDS 1.196.0 for exactly this record. What is
// asserted here is the LOOP, not the shape: publish_request authors an $IRM
// record, and feeding that record back to granule_plan as the mark resumes the
// walk where it stopped.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url), "utf8"));
const WASM = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const EPOCH = "2023-04-01T00:00:00.000Z";
const RETRIEVED_AT = "2026-08-26T00:00:00.000Z";
const CONFIG = {
  dataset_id: "copernicus-glo30-quantized-mesh",
  tileset_id: "glo30-test",
  dataset_epoch: EPOCH,
  retrieved_at: RETRIEVED_AT,
  provider_id: "copernicus",
  source_name: "copernicus-glo30",
  min_level: 8,
  max_level: 8,
  regions: [{ name: "probe", west: 10, south: 45, east: 12, north: 47, max_level: 8, priority: 10 }],
};

const frame = (portId, bytes) => ({
  portId,
  typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
  payload: bytes,
});
const jsonFrame = (portId, value) => frame(portId, encoder.encode(JSON.stringify(value)));

async function harnessFor(t, config = CONFIG) {
  const harness = await createBrowserModuleHarness({
    wasmSource: WASM,
    manifest: MANIFEST,
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  return harness;
}

function outputsByPort(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return new Map(response.outputs.map((o) => [o.portId, Buffer.from(o.payload)]));
}
const asJson = (bytes) => JSON.parse(decoder.decode(bytes));

// ── a minimal $IRM reader (field ids follow schema/IRM/main.fbs order) ──────
function tableAt(buf, pos) {
  const vtable = pos - buf.readInt32LE(pos);
  return (id) => {
    const vo = 4 + 2 * id;
    if (vo >= buf.readUInt16LE(vtable)) return 0;
    const off = buf.readUInt16LE(vtable + vo);
    return off === 0 ? 0 : pos + off;
  };
}
function decodeIrm(record) {
  const buf = Buffer.from(record);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "$IRM", "the frame is an $IRM buffer");
  const at = tableAt(buf, buf.readUInt32LE(0));
  const str = (id) => {
    const p = at(id);
    if (!p) return "";
    const sp = p + buf.readUInt32LE(p);
    return buf.subarray(sp + 4, sp + 4 + buf.readUInt32LE(sp)).toString("utf8");
  };
  const u32 = (id) => { const p = at(id); return p ? buf.readUInt32LE(p) : 0; };
  const u64 = (id) => { const p = at(id); return p ? Number(buf.readBigUInt64LE(p)) : 0; };
  const i8 = (id) => { const p = at(id); return p ? buf.readInt8(p) : 0; };
  const decodeContext = () => {
    const p0 = at(10);
    if (!p0) return null;
    const p = p0 + buf.readUInt32LE(p0);
    const inner = tableAt(buf, p);
    const innerStr = (id) => {
      const q = inner(id);
      if (!q) return "";
      const sp = q + buf.readUInt32LE(q);
      return buf.subarray(sp + 4, sp + 4 + buf.readUInt32LE(sp)).toString("utf8");
    };
    const stateAt = inner(11);
    let state = null;
    if (stateAt) {
      const vp = stateAt + buf.readUInt32LE(stateAt);
      state = buf.subarray(vp + 4, vp + 4 + buf.readUInt32LE(vp));
    }
    return {
      format: innerStr(0),
      decoderState: state,
      decoderStateFormat: innerStr(12),
      decoderStateVersion: innerStr(13),
      // id 17: the schema carries DECODER_STATE_SHA256 (15) and
      // DECODER_BUILD_ID (16) between VERSION and MEDIA_TYPE — read off the
      // generated header's VT_ offsets, not counted by eye.
      decoderStateMediaType: innerStr(17),
    };
  };
  return {
    jobId: str(0),
    sequence: u64(1),
    providerId: str(2),
    ingestorId: str(3),
    state: i8(5),
    rangeMode: i8(6),
    nextChunkIndex: u32(8),
    decodeContext: decodeContext(),
    chunksCommitted: u32(12),
    recordsCommitted: u64(14),
    targetStandard: str(15),
    updatedAt: str(21),
  };
}

// Size-prefixed stream framing, which is what hostcap/flatsql-query's `stream`
// port delivers and what the read side has to walk.
function sizePrefixed(record) {
  const out = Buffer.alloc(4 + record.length);
  out.writeUInt32LE(record.length, 0);
  record.copy(out, 4);
  return out;
}

const META = {
  schema: "DTT",
  provider_id: "copernicus",
  source_name: "copernicus-glo30",
  dataset_id: CONFIG.dataset_id,
  tileset_id: CONFIG.tileset_id,
  dataset_epoch: EPOCH,
  lane: "terrain",
  batch_id: `${CONFIG.tileset_id}@${EPOCH}#5`,
  first_tile_index: 5,
  tiles_planned: 1,
  etag: '"9a1b-glo30"',
  last_modified: "Sat, 15 Aug 2026 02:18:01 GMT",
  records_in: 12,
  total_cells: 40,
  stored_tiles_total: 61,
  retrieved_at: RETRIEVED_AT,
};

async function publish(t, overrides = {}) {
  const harness = await harnessFor(t);
  return outputsByPort(
    await harness.invoke({
      methodId: "publish_request",
      inputs: [
        jsonFrame("result", { schema: "DTT", inserted: 12, batch_id: META.batch_id }),
        jsonFrame("meta", { ...META, ...overrides }),
      ],
    }),
  );
}

test("publish_request authors an $IRM record the storage lane can write", async (t) => {
  const outputs = await publish(t);
  const record = outputs.get("mark_record");
  assert.ok(record, "the DURABLE mark is emitted, not only the JSON one");
  const irm = decodeIrm(record);

  // ONE JOB PER EDITION. A new epoch is a new job rather than a mark that has
  // to be sanity-checked, so resuming tileset A from tileset B's index is
  // unrepresentable instead of merely refused.
  assert.equal(irm.jobId, `${CONFIG.dataset_id}@${CONFIG.tileset_id}@${EPOCH}`);
  assert.equal(irm.providerId, "copernicus");
  assert.equal(irm.ingestorId, "terrain-ingest-wasm/v1");
  assert.equal(irm.targetStandard, "DTT");
  assert.equal(irm.state, 1, "IN_PROGRESS: 6 of 40 cells done");
  // PART_INDEX, because this lane walks numbered granule CELLS and no byte
  // offset addresses them — which is exactly what that enum member states.
  assert.equal(irm.rangeMode, 3, "PART_INDEX");
  assert.equal(irm.nextChunkIndex, 6, "first_tile_index + tiles_planned");
  assert.equal(irm.chunksCommitted, 6);
  assert.equal(irm.recordsCommitted, 61 + 12, "cumulative, and only what STORAGE confirmed");
  assert.equal(irm.updatedAt, RETRIEVED_AT);

  // The resume state rides VERBATIM under a version stamp, and it is the SAME
  // JSON the operator-readable egress mark carries — one parser, not two.
  const ctx = irm.decodeContext;
  assert.ok(ctx, "the decode context exists when there is state to carry");
  assert.equal(ctx.decoderStateFormat, "terrain-ingest/resume-v1");
  assert.equal(ctx.decoderStateVersion, "1");
  assert.equal(ctx.decoderStateMediaType, "application/json");
  assert.deepEqual(JSON.parse(ctx.decoderState.toString("utf8")), asJson(outputs.get("mark")));

  // …and the write meta names the type, which storage-write re-derives from
  // the buffer's own file identifier and refuses if the two disagree.
  assert.deepEqual(asJson(outputs.get("mark_meta")), { source: "copernicus", type: "IRM" });
});

test("a drained walk marks the job COMPLETE", async (t) => {
  const outputs = await publish(t, { first_tile_index: 39, tiles_planned: 1, total_cells: 40 });
  const irm = decodeIrm(outputs.get("mark_record"));
  assert.equal(irm.nextChunkIndex, 40);
  assert.equal(irm.state, 2, "COMPLETE");
});

test("no durable mark is written for a batch that stored nothing", async (t) => {
  const harness = await harnessFor(t);
  const response = await harness.invoke({
    methodId: "publish_request",
    inputs: [
      jsonFrame("result", { schema: "DTT", inserted: 0, batch_id: META.batch_id }),
      jsonFrame("meta", META),
    ],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, "ingest-stored-nothing");
  assert.equal(response.outputs.length, 0, "not the JSON mark, and not the $IRM record either");
});

test("THE LOOP: the $IRM record publish_request wrote is the mark granule_plan resumes from", async (t) => {
  const outputs = await publish(t);
  const stream = sizePrefixed(outputs.get("mark_record"));

  const harness = await harnessFor(t);
  const planned = outputsByPort(
    await harness.invoke({
      methodId: "granule_plan",
      inputs: [jsonFrame("tick", { firedAt: RETRIEVED_AT }), frame("mark", stream)],
    }),
  );
  const job = asJson(planned.get("job"));
  assert.equal(job.cell_index, 6, "the walk resumes at the cell the durable mark named");
  assert.equal(job.stored_tiles_total, 73, "…and carries the committed count forward");

  // Without the mark the SAME config starts at cell 0 — which is what every
  // tick was doing before, silently, because an absent mark is a valid first
  // run and never an error.
  const cold = await harnessFor(t);
  const fresh = outputsByPort(
    await cold.invoke({
      methodId: "granule_plan",
      inputs: [jsonFrame("tick", { firedAt: RETRIEVED_AT })],
    }),
  );
  assert.equal(asJson(fresh.get("job")).cell_index, 0);
});

test("a mark for ANOTHER job, or an unrecognised state stamp, restarts rather than resumes", async (t) => {
  const outputs = await publish(t, { tileset_id: "some-other-tileset" });
  const stream = sizePrefixed(outputs.get("mark_record"));
  const harness = await harnessFor(t);
  const planned = outputsByPort(
    await harness.invoke({
      methodId: "granule_plan",
      inputs: [jsonFrame("tick", { firedAt: RETRIEVED_AT }), frame("mark", stream)],
    }),
  );
  assert.equal(
    asJson(planned.get("job")).cell_index,
    0,
    "a mark whose JOB_ID is another lane's says nothing about this walk",
  );
});

test("the legacy JSON mark still resumes, and is never confused with a record", async (t) => {
  // The flow still lands the JSON mark on egress for an operator to read. A
  // FlatBuffer does not begin with '{', so the discrimination is exact.
  const outputs = await publish(t);
  const harness = await harnessFor(t);
  const planned = outputsByPort(
    await harness.invoke({
      methodId: "granule_plan",
      inputs: [jsonFrame("tick", { firedAt: RETRIEVED_AT }), frame("mark", outputs.get("mark"))],
    }),
  );
  assert.equal(asJson(planned.get("job")).cell_index, 6);
});
