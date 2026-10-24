// The request and response frames of the interchange readers, built and read with the SDS FlatBuffers.
//
// Every option of an adapter travels in an $NCD or in the target record (owner, 2026-10-24: "We need to be
// able to pass configurations using a flatbuffer message"). This is the one place a test builds such a
// message: a frame is  [u32le n][$NCD, n bytes][the file's exact bytes]  and the $NCD is also the request.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as flatbuffers from "flatbuffers";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing/browser";
import { toLoadableWasmBytes } from "space-data-module-sdk/bundle";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { NCDSegmentDescriptor } from "spacedatastandards.org/lib/js/NCD/NCDSegmentDescriptor.js";
import { ncdContainerFormat } from "spacedatastandards.org/lib/js/NCD/ncdContainerFormat.js";

export { ncdContainerFormat, NCD };

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const NCD_TYPE = { schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD" };
export const OEM_TYPE = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
export const AEM_TYPE = { schemaName: "AEM.fbs", fileIdentifier: "$AEM", rootTypeName: "AEM" };
export const GNO_TYPE = { schemaName: "GNO.fbs", fileIdentifier: "$GNO", rootTypeName: "GNO" };

/**
 * Build `[u32le n][$NCD][bytes]`.
 *
 * `request` carries the options, all of them $NCD fields:
 *   formatName   PROVIDER_DEFINED_FORMAT_NAME (e.g. "sentinel-eof", "naif-ck", "naif-sclk", "rinex-obs")
 *   startTime / stopTime   the inclusive selection window (ISO 8601, on the file's own time scale)
 *   segments     [{ name, instrument }]  selects segments, objects or satellite systems
 *   clock        the spacecraft clock id, as SEGMENTS[0].TARGET_NAIF_ID
 *   declareHash  declare SOURCE_SHA256 and SOURCE_BYTE_LENGTH (default true)
 */
export function frame(bytes, request = {}) {
  const b = new flatbuffers.Builder(1024);
  const name = request.formatName ? b.createString(request.formatName) : null;
  const start = request.startTime ? b.createString(request.startTime) : null;
  const stop = request.stopTime ? b.createString(request.stopTime) : null;
  const sha = request.declareHash === false ? null : b.createString(sha256Hex(bytes));
  const entries = [...(request.segments ?? [])];
  if (request.clock !== undefined) entries.push({ instrument: request.clock });
  const segmentOffsets = entries.map((s) => {
    const n = s.name ? b.createString(s.name) : null;
    NCDSegmentDescriptor.startNCDSegmentDescriptor(b);
    if (n !== null) NCDSegmentDescriptor.addName(b, n);
    if (s.instrument !== undefined) NCDSegmentDescriptor.addTargetNaifId(b, s.instrument);
    return NCDSegmentDescriptor.endNCDSegmentDescriptor(b);
  });
  const segments = segmentOffsets.length ? NCD.createSegmentsVector(b, segmentOffsets) : null;
  NCD.startNCD(b);
  NCD.addFormat(b, request.format ?? ncdContainerFormat.PROVIDER_DEFINED);
  if (name !== null) NCD.addProviderDefinedFormatName(b, name);
  if (start !== null) NCD.addStartTime(b, start);
  if (stop !== null) NCD.addStopTime(b, stop);
  if (segments !== null) NCD.addSegments(b, segments);
  if (request.declareHash !== false) {
    NCD.addSourceByteLength(b, BigInt(bytes.byteLength));
    NCD.addSourceSha256(b, sha);
  }
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  const descriptor = b.asUint8Array();
  const out = new Uint8Array(descriptor.byteLength + bytes.byteLength);
  out.set(descriptor, 0);
  out.set(bytes, descriptor.byteLength);
  return out;
}

/** A bare size-prefixed $NCD (the optional `descriptor` input of a writer). */
export function descriptorOnly({ internalFileName, comments = [], formatName } = {}) {
  const b = new flatbuffers.Builder(256);
  const file = internalFileName ? b.createString(internalFileName) : null;
  const lines = comments.map((c) => b.createString(c));
  const area = lines.length ? NCD.createCommentAreaVector(b, lines) : null;
  const name = formatName ? b.createString(formatName) : null;
  NCD.startNCD(b);
  NCD.addFormat(b, formatName ? ncdContainerFormat.PROVIDER_DEFINED : ncdContainerFormat.UNSPECIFIED);
  if (name !== null) NCD.addProviderDefinedFormatName(b, name);
  if (file !== null) NCD.addInternalFileName(b, file);
  if (area !== null) NCD.addCommentArea(b, area);
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  return b.asUint8Array();
}

/** The $NCD at the front of a returned frame, and the file behind it. */
export function splitFrame(payload) {
  const bytes = new Uint8Array(payload);
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const descriptor = NCD.getSizePrefixedRootAsNCD(new flatbuffers.ByteBuffer(bytes.slice(0, 4 + n)));
  return { descriptor, body: bytes.slice(4 + n) };
}

export const readNcd = (payload) =>
  NCD.getSizePrefixedRootAsNCD(new flatbuffers.ByteBuffer(new Uint8Array(payload)));

/** The module's harness, loaded the way a consumer loads it. */
export async function harness(packageRoot, surface = "command") {
  const wasm = new Uint8Array(fs.readFileSync(path.join(packageRoot, "dist", "isomorphic", "module.wasm")));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8"));
  return createBrowserModuleHarness({ wasmSource: toLoadableWasmBytes(wasm), manifest, surface });
}

export const input = (portId, typeRef, payload) => ({ portId, typeRef, payload });
