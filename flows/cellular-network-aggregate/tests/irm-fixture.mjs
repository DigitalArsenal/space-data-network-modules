/*
 * $IRM (Ingest Resume Mark) fixtures, built with the OFFICIAL published
 * spacedatastandards.org JS binding.
 *
 * WHY THE OFFICIAL BINDING AND NOT A HAND-BUILT BUFFER. The guest reads $IRM
 * through the generated C++ binding inlined into its translation unit. If the
 * test hand-assembled a vtable from the IDL's declaration order, a slot-index
 * mistake would be made IDENTICALLY on both sides and the round trip would pass
 * while the real store round trip failed. Building the fixture with the
 * published JS binding makes this a genuine cross-implementation check:
 * flatc's JS output writes it, flatc's C++ output reads it.
 *
 * Used by the cellular aggregate's cache and tile tests, which need a durable
 * mark in the store without running the ingest flow.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkTestingEntry = fileURLToPath(
  new URL(import.meta.resolve("space-data-module-sdk/testing")),
);
const sdkRoot = path.resolve(path.dirname(sdkTestingEntry), "..", "..");
const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
const flatbuffers = sdkRequire("flatbuffers");

// PUBLISHED PACKAGE, resolved by Node rather than by a hand-built relative
// path (owner law 2026-08-21: builds consume PUBLISHED packages, never local
// gitlink copies). Declared as a devDependency of the flow packages that use
// it; Node's upward walk finds it wherever the install put it.
const standardsEntry = createRequire(import.meta.url).resolve(
  "spacedatastandards.org/package.json",
);
const irmDir = path.join(path.dirname(standardsEntry), "lib", "js", "IRM");
const { IRM } = await import(pathToFileURL(path.join(irmDir, "IRM.js")).href);
const { IRMSource } = await import(pathToFileURL(path.join(irmDir, "IRMSource.js")).href);
const { IRMChunk } = await import(pathToFileURL(path.join(irmDir, "IRMChunk.js")).href);
const { IRMDecodeContext } = await import(
  pathToFileURL(path.join(irmDir, "IRMDecodeContext.js")).href
);
const { irmJobState } = await import(pathToFileURL(path.join(irmDir, "irmJobState.js")).href);
const { irmRangeMode } = await import(pathToFileURL(path.join(irmDir, "irmRangeMode.js")).href);

export const DECODER_STATE_FORMAT = "cell-tower-source/bulk-resume-v1";

/**
 * One $IRM record.
 *
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {string} opts.sourceUrl
 * @param {number} opts.nextOffset next byte to fetch
 * @param {number} opts.totalBytes 0 = still unknown (never "finished")
 * @param {number} opts.nextChunkIndex
 * @param {number} opts.recordsCommitted cumulative rows the store confirmed
 * @param {string} opts.updatedAt ISO timestamp
 * @param {string} [opts.batchId]
 * @param {string} [opts.headerLine] the CSV header row from chunk 0
 * @param {string} [opts.decoderState] the producer's own resume frame, verbatim
 * @param {string} [opts.decoderStateFormat] its version stamp
 * @returns {Uint8Array} the finished $IRM buffer
 */
export function irmRecord({
  providerId,
  sourceUrl,
  nextOffset,
  totalBytes,
  nextChunkIndex = 1,
  recordsCommitted = 0,
  updatedAt,
  batchId = `${providerId}@0`,
  headerLine = "",
  decoderState = "",
  decoderStateFormat = DECODER_STATE_FORMAT,
}) {
  const b = new flatbuffers.Builder(2048);
  const jobId = b.createString(`${providerId}@${sourceUrl}`);
  const provider = b.createString(providerId);
  const updated = b.createString(updatedAt);
  const target = b.createString("TBS");
  const reconcile = b.createString("append");

  const sourceUrlOffset = b.createString(sourceUrl);
  IRMSource.startIRMSource(b);
  IRMSource.addSourceUrl(b, sourceUrlOffset);
  if (totalBytes > 0) IRMSource.addTotalBytes(b, BigInt(totalBytes));
  const source = IRMSource.endIRMSource(b);

  let decodeContext = 0;
  if (headerLine || decoderState) {
    const formatOffset = b.createString("csv");
    const headerOffset = headerLine ? b.createString(headerLine) : 0;
    const stateBytes = decoderState ? new TextEncoder().encode(decoderState) : null;
    const stateOffset = stateBytes ? IRMDecodeContext.createDecoderStateVector(b, stateBytes) : 0;
    const stateFormatOffset = decoderState ? b.createString(decoderStateFormat) : 0;
    IRMDecodeContext.startIRMDecodeContext(b);
    IRMDecodeContext.addFormat(b, formatOffset);
    if (headerOffset) {
      IRMDecodeContext.addHeaderLine(b, headerOffset);
      IRMDecodeContext.addHeaderByteLength(b, BigInt(headerLine.length));
    }
    if (stateOffset) {
      IRMDecodeContext.addDecoderState(b, stateOffset);
      IRMDecodeContext.addDecoderStateFormat(b, stateFormatOffset);
      IRMDecodeContext.addDecoderStateByteLength(b, BigInt(stateBytes.length));
    }
    decodeContext = IRMDecodeContext.endIRMDecodeContext(b);
  }

  const batchOffset = b.createString(batchId);
  const committedOffset = b.createString(updatedAt);
  IRMChunk.startIRMChunk(b);
  IRMChunk.addChunkIndex(b, nextChunkIndex - 1);
  IRMChunk.addBatchId(b, batchOffset);
  IRMChunk.addCommittedAt(b, committedOffset);
  const lastChunk = IRMChunk.endIRMChunk(b);

  const complete = totalBytes > 0 && nextOffset >= totalBytes;

  IRM.startIRM(b);
  IRM.addJobId(b, jobId);
  IRM.addSequence(b, BigInt(nextChunkIndex));
  IRM.addProviderId(b, provider);
  IRM.addSource(b, source);
  IRM.addState(b, complete ? irmJobState.COMPLETE : irmJobState.IN_PROGRESS);
  IRM.addRangeMode(b, irmRangeMode.INCLUSIVE_BYTE_RANGE);
  IRM.addNextOffset(b, BigInt(nextOffset));
  IRM.addNextChunkIndex(b, nextChunkIndex);
  if (decodeContext) IRM.addDecodeContext(b, decodeContext);
  IRM.addLastChunk(b, lastChunk);
  IRM.addChunksCommitted(b, nextChunkIndex);
  IRM.addBytesCommitted(b, BigInt(nextOffset));
  IRM.addRecordsCommitted(b, BigInt(recordsCommitted));
  IRM.addTargetStandard(b, target);
  IRM.addReconcileMode(b, reconcile);
  IRM.addUpdatedAt(b, updated);
  const off = IRM.endIRM(b);
  IRM.finishIRMBuffer(b, off);
  return b.asUint8Array();
}

/** Wrap buffers as the size-prefixed stream hostcap/flatsql-query returns. */
export function irmStream(records) {
  const total = records.reduce((sum, r) => sum + 4 + r.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const record of records) {
    view.setUint32(offset, record.length, true);
    out.set(record, offset + 4);
    offset += 4 + record.length;
  }
  return out;
}

/** True when the SQL is the durable-mark read rather than the record read. */
export function isMarkQuery(sql) {
  return String(sql ?? "").includes("sds_irm");
}
