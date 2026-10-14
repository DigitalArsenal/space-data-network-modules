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
import { createHash } from "node:crypto";
import test from "node:test";

import { encodeIngestRequest, encodeIngestResult } from "space-data-module-sdk/runtime-contracts";

import {
  TYPE,
  IRM_LIB,
  createHarness,
  tickFrame,
  irmRecord,
  markFrames,
  jobIdOf,
  jobRecord,
  encodeIrm,
  decodeIrm,
  irmFrame,
  outputs,
} from "./typed.mjs";

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
const JOB_ID = jobIdOf(CONFIG.dataset_id, CONFIG.tileset_id, EPOCH);
const BATCH = `${CONFIG.tileset_id}@${EPOCH}#5`;

const meta = encodeIngestRequest({
  schema: "DTT",
  tags: { providerId: "copernicus", sourceName: "copernicus-glo30", batchId: BATCH },
  reconcile: "none",
  provenance: { etag: '"9a1b-glo30"', lastModified: "Sat, 15 Aug 2026 02:18:01 GMT", normalizedCount: 12, schemaCounts: { "DTT.fbs": 12 } },
});

// The walk's length for CONFIG, as granule_plan states it on its job (NOTES "... of N cells").
async function walkCells(t) {
  const harness = await createHarness(t, CONFIG);
  const out = outputs(await harness.invoke({ methodId: "granule_plan", inputs: [tickFrame(RETRIEVED_AT)] }));
  return Number(decodeIrm(out.get("job")[0]).notes.match(/of (\d+) cells$/)[1]);
}

async function publish(t, { first = 5, next = 6, committed = 61, inserted = 12, jobId = JOB_ID } = {}) {
  const harness = await createHarness(t, CONFIG);
  return harness.invoke({
    methodId: "publish_request",
    inputs: [
      { portId: "result", typeRef: TYPE.INGR, payload: encodeIngestResult({ schema: "DTT", batchId: BATCH, inserted }) },
      { portId: "meta", typeRef: TYPE.INGQ, payload: meta },
      irmFrame("job", jobRecord({ jobId, first, next, recordsCommitted: committed, epoch: EPOCH })),
    ],
  });
}
const markOf = (response) => outputs(response).get("mark")[0];

async function resumesAtCell(t, records) {
  const harness = await createHarness(t, CONFIG);
  const out = outputs(await harness.invoke({ methodId: "granule_plan", inputs: [tickFrame(RETRIEVED_AT), ...markFrames(records)] }));
  const job = decodeIrm(out.get("job")[0]);
  return { cell: job.firstIndex, committed: job.recordsCommitted };
}

test("publish_request authors the $IRM record the storage lane writes", async (t) => {
  const irm = decodeIrm(markOf(await publish(t)));
  // ONE JOB PER EDITION: resuming tileset A from tileset B's index is unrepresentable instead of merely refused.
  assert.equal(irm.jobId, JOB_ID);
  assert.equal(irm.record.PROVIDER_ID, "copernicus");
  assert.equal(irm.record.INGESTOR_ID, "terrain-ingest-wasm/v1");
  assert.equal(irm.record.TARGET_STANDARD, "DTT");
  assert.equal(irm.state, IRM_LIB.irmJobState.IN_PROGRESS, "6 cells of the walk done");
  // PART_INDEX, because this lane walks numbered granule CELLS and no byte offset addresses them.
  assert.equal(irm.record.RANGE_MODE, IRM_LIB.irmRangeMode.PART_INDEX);
  assert.equal(irm.nextIndex, 6, "the job's first index + its stride");
  assert.equal(irm.record.CHUNKS_COMMITTED, 6);
  assert.equal(Number(irm.record.SEQUENCE), 6, "monotonic per job");
  assert.equal(irm.recordsCommitted, 61 + 12, "cumulative, and only what STORAGE confirmed");
  assert.equal(irm.record.LAST_CHUNK.CHUNK_INDEX, 5);
  assert.equal(irm.record.LAST_CHUNK.BATCH_ID, BATCH);
  assert.equal(irm.record.LAST_CHUNK.RECORDS_STORED, 12);
  assert.equal(irm.record.UPDATED_AT, RETRIEVED_AT);
  assert.equal(irm.etag, '"9a1b-glo30"');
  // Typed contracts 1.0: the position is the record's own fields; no JSON state rides in DECODE_CONTEXT.
  assert.equal(irm.record.DECODE_CONTEXT, null);
});

test("a drained walk marks the job COMPLETE", async (t) => {
  const total = await walkCells(t);
  const irm = decodeIrm(markOf(await publish(t, { first: total - 1, next: total })));
  assert.equal(irm.nextIndex, total);
  assert.equal(irm.state, IRM_LIB.irmJobState.COMPLETE);
  assert.equal(irm.record.COMPLETED_AT, RETRIEVED_AT);
});

test("no durable mark is written for a batch that stored nothing", async (t) => {
  const response = await publish(t, { inserted: 0 });
  assert.equal(response.errorCode, "ingest-stored-nothing");
  assert.equal(response.outputs.length, 0, "no $IRM record");
});

test("THE LOOP: the $IRM record publish_request wrote is the mark granule_plan resumes from", async (t) => {
  const mark = markOf(await publish(t));
  assert.deepEqual(await resumesAtCell(t, [mark]), { cell: 6, committed: 73 }, "resumes at the named cell, carrying the count");
  // The answer may arrive in several $FSB chunks: the stream is reassembled before it is read.
  const harness = await createHarness(t, CONFIG);
  const out = outputs(await harness.invoke({ methodId: "granule_plan", inputs: [tickFrame(RETRIEVED_AT), ...markFrames([mark], 64)] }));
  assert.equal(decodeIrm(out.get("job")[0]).firstIndex, 6);
  // Without the mark the SAME config starts at cell 0.
  const cold = await createHarness(t, CONFIG);
  const fresh = outputs(await cold.invoke({ methodId: "granule_plan", inputs: [tickFrame(RETRIEVED_AT)] }));
  assert.equal(decodeIrm(fresh.get("job")[0]).firstIndex, 0);
});

test("a mark for ANOTHER job restarts rather than resumes; the newest of this job's marks wins", async (t) => {
  const foreign = markOf(await publish(t, { jobId: jobIdOf(CONFIG.dataset_id, "some-other-tileset", EPOCH) }));
  assert.equal((await resumesAtCell(t, [foreign])).cell, 0, "a mark whose JOB_ID is another lane's says nothing about this walk");
  const own = markOf(await publish(t));
  const older = irmRecord({ jobId: JOB_ID, next: 2 });
  assert.equal((await resumesAtCell(t, [foreign, own, older])).cell, 6, "rows arrive newest first; the first of this job is read");
});

test("an ABANDONED or INVALIDATED mark is not a resume point", async (t) => {
  for (const state of ["ABANDONED", "INVALIDATED"]) {
    assert.equal((await resumesAtCell(t, [irmRecord({ jobId: JOB_ID, next: 6, state })])).cell, 0, state);
  }
});

// ── A MARK WRITTEN BEFORE TYPED CONTRACTS 1.0 ─────────────────────────────────
//
// Those marks carried a JSON copy of the resume state in DECODE_CONTEXT.DECODER_STATE under version stamps. This
// build writes none, but it still COMPARES every stamp such a mark carries, as $IRM requires: "A consumer compares
// EVERY stamp it can before loading the image, and on ANY disagreement ... discards the mark and restarts".
function legacyMark(patch = {}) {
  const { IRMDecodeContextT } = IRM_LIB;
  const state = Buffer.from(JSON.stringify({ dataset_id: CONFIG.dataset_id, tileset_id: CONFIG.tileset_id, dataset_epoch: EPOCH, next_tile_index: 6, stored_tiles_total: 73 }));
  const ctx = new IRMDecodeContextT("application/json");
  ctx.DECODER_STATE = [...state];
  ctx.DECODER_STATE_FORMAT = "terrain-ingest/resume-v1";
  ctx.DECODER_STATE_VERSION = "1";
  ctx.DECODER_STATE_MEDIA_TYPE = "application/json";
  ctx.DECODER_STATE_BYTE_LENGTH = BigInt(state.length);
  ctx.DECODER_STATE_SHA256 = createHash("sha256").update(state).digest("hex");
  ctx.DECODER_BUILD_ID = "terrain-ingest-wasm/v1+resume-v1";
  Object.assign(ctx, patch);
  return irmRecord({ jobId: JOB_ID, next: 6, storedTotal: 73, decodeContext: ctx });
}

test("a pre-1.0 mark with its stamps intact still resumes", async (t) => {
  assert.deepEqual(await resumesAtCell(t, [legacyMark()]), { cell: 6, committed: 73 });
  // BUILD_ID is a claim about who wrote it, never compared: a deploy is not a corrupt mark.
  assert.equal((await resumesAtCell(t, [legacyMark({ DECODER_BUILD_ID: "terrain-ingest-wasm/v9+resume-v1" })])).cell, 6);
  // Zero is UNSTAMPED, not a disagreement.
  assert.equal((await resumesAtCell(t, [legacyMark({ DECODER_STATE_BYTE_LENGTH: 0n })])).cell, 6);
});

test("a pre-1.0 mark whose stamps DISAGREE restarts rather than resumes", async (t) => {
  for (const [field, value] of [
    ["DECODER_STATE_FORMAT", "terrain-ingest/resume-v9"],
    ["DECODER_STATE_FORMAT", null],
    ["DECODER_STATE_VERSION", "2"],
    ["DECODER_STATE_MEDIA_TYPE", "application/xson"],
    ["DECODER_STATE_BYTE_LENGTH", 9999n],
    ["DECODER_STATE_SHA256", "0".repeat(64)],
  ]) {
    assert.equal((await resumesAtCell(t, [legacyMark({ [field]: value })])).cell, 0, `${field} = ${value}`);
  }
});
