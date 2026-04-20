// Shared FlatBuffer payload encoders used across the sgp4-propagator tests.
// OMM/CAT/REC come from the canonical spacedatastandards.org JS bindings so
// the contract tests mirror what a real OrbPro host would send on the wire.
// PropagatorBatchRequest, PropagatorState, CatalogQueryRequest, and
// CatalogQueryResult come from bindings we generate at build time from the
// .fbs schemas under ../../schemas/. Run `generate-test-bindings.mjs` to
// refresh them.

import * as flatbuffers from "flatbuffers";

import { OMM as OMMClass, OMMT } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { CAT as CATClass } from "spacedatastandards.org/lib/js/REC/CAT.js";
import { REC as RECClass, RECT } from "spacedatastandards.org/lib/js/REC/REC.js";
import { RecordT } from "spacedatastandards.org/lib/js/REC/Record.js";
import { RecordType } from "spacedatastandards.org/lib/js/REC/RecordType.js";

import {
  PropagatorBatchRequest,
  PropagatorBatchRequestT,
} from "./generated/orbpro/propagator/propagator-batch-request.js";
import {
  PropagatorState,
} from "./generated/orbpro/plugins/propagator-state.js";
import {
  CatalogQueryKind,
} from "./generated/orbpro/query/catalog-query-kind.js";
import {
  CatalogQueryRequest,
  CatalogQueryRequestT,
} from "./generated/orbpro/query/catalog-query-request.js";
import {
  CatalogQueryResult,
} from "./generated/orbpro/query/catalog-query-result.js";

export { CatalogQueryKind };

// -------- OMM / CAT / REC encoders (SDS wire contract) ----------------------

export function encodeOmmPayload({
  noradId = 25544,
  objectName = "ISS (ZARYA)",
  objectId = "1998-067A",
  epoch = "2024-01-01T00:00:00",
  meanMotion = 15.50000001,
  eccentricity = 0.0006703,
  inclination = 51.6414,
  raan = 21.5245,
  argPericenter = 325.0288,
  meanAnomaly = 173.4281,
  bstar = 0.0001027,
  meanMotionDot = 0.00004512,
  meanMotionDdot = 0.0,
} = {}) {
  const omm = new OMMT();
  omm.CCSDS_OMM_VERS = 2.0;
  omm.OBJECT_NAME = objectName;
  omm.OBJECT_ID = objectId;
  omm.EPOCH = epoch;
  omm.MEAN_MOTION = meanMotion;
  omm.ECCENTRICITY = eccentricity;
  omm.INCLINATION = inclination;
  omm.RA_OF_ASC_NODE = raan;
  omm.ARG_OF_PERICENTER = argPericenter;
  omm.MEAN_ANOMALY = meanAnomaly;
  omm.NORAD_CAT_ID = noradId;
  omm.BSTAR = bstar;
  omm.MEAN_MOTION_DOT = meanMotionDot;
  omm.MEAN_MOTION_DDOT = meanMotionDdot;

  const builder = new flatbuffers.Builder(1024);
  OMMClass.finishOMMBuffer(builder, omm.pack(builder));
  return builder.asUint8Array();
}

export function encodeCatPayload({
  noradId = 25544,
  objectName = "ISS (ZARYA)",
  objectId = "1998-067A",
  launchDate = "1998-11-20",
} = {}) {
  const builder = new flatbuffers.Builder(512);
  const objectNameOffset = builder.createString(objectName);
  const objectIdOffset = builder.createString(objectId);
  const launchDateOffset = builder.createString(launchDate);

  CATClass.startCAT(builder);
  CATClass.addObjectName(builder, objectNameOffset);
  CATClass.addObjectId(builder, objectIdOffset);
  CATClass.addNoradCatId(builder, noradId);
  CATClass.addLaunchDate(builder, launchDateOffset);
  const catOffset = CATClass.endCAT(builder);
  CATClass.finishCATBuffer(builder, catOffset);
  return builder.asUint8Array();
}

export function encodeRecWithOmm(ommPayload) {
  const omm = OMMClass.getRootAsOMM(
    new flatbuffers.ByteBuffer(ommPayload),
  ).unpack();
  const rec = new RECT("1.0", [new RecordT(RecordType.OMM, omm, "OMM")]);
  const builder = new flatbuffers.Builder(1024);
  RECClass.finishRECBuffer(builder, rec.pack(builder));
  return builder.asUint8Array();
}

export function encodeRecWithCat(catPayload) {
  const cat = CATClass.getRootAsCAT(
    new flatbuffers.ByteBuffer(catPayload),
  ).unpack();
  const rec = new RECT("1.0", [new RecordT(RecordType.CAT, cat, "CAT")]);
  const builder = new flatbuffers.Builder(1024);
  RECClass.finishRECBuffer(builder, rec.pack(builder));
  return builder.asUint8Array();
}

export function encodeSizePrefixedStream(payloads) {
  const totalSize = payloads.reduce(
    (sum, payload) => sum + 4 + payload.length,
    0,
  );
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const payload of payloads) {
    view.setUint32(offset, payload.length, true);
    offset += 4;
    bytes.set(payload, offset);
    offset += payload.length;
  }
  return bytes;
}

// -------- PropagatorBatchRequest --------------------------------------------
// Real FlatBuffer encoder matching orbpro.propagator.PropagatorBatchRequest,
// which the C++ side decodes via flatbuffers::Verifier + GetRoot<>.

export function encodePropagatorBatchRequest({
  epoch,
  entityHandles = [],
  outputOffset = 0,
  maxCount = 0,
}) {
  const builder = new flatbuffers.Builder(256);
  const request = new PropagatorBatchRequestT(
    epoch,
    entityHandles,
    outputOffset,
    maxCount,
  );
  builder.finish(request.pack(builder));
  return builder.asUint8Array();
}

// -------- CatalogQueryRequest -----------------------------------------------
// FlatBuffer encoder for orbpro.query.CatalogQueryRequest. The plugin verifies
// the file identifier "CQRQ" so we finish the buffer with that identifier.

export function encodeCatalogQueryRequest({
  queryKind = CatalogQueryKind.ROWS,
  query = "",
  entityIndex = 0,
  maxCount = 0,
  entityCount = 0,
} = {}) {
  const builder = new flatbuffers.Builder(256);
  const request = new CatalogQueryRequestT(
    queryKind,
    query,
    entityIndex,
    maxCount,
    entityCount,
  );
  CatalogQueryRequest.finishCatalogQueryRequestBuffer(
    builder,
    request.pack(builder),
  );
  return builder.asUint8Array();
}

// -------- PropagatorState decoder -------------------------------------------

export function decodePropagatorState(bytes) {
  const buffer = new flatbuffers.ByteBuffer(bytes);
  if (!PropagatorState.bufferHasIdentifier(buffer)) {
    throw new Error("PropagatorState payload missing PRST file identifier");
  }
  return PropagatorState.getRootAsPropagatorState(buffer).unpack();
}

// -------- CatalogQueryResult decoder ----------------------------------------

export function decodeCatalogQueryResult(bytes) {
  const buffer = new flatbuffers.ByteBuffer(bytes);
  if (!CatalogQueryResult.bufferHasIdentifier(buffer)) {
    throw new Error("CatalogQueryResult payload missing CQRS file identifier");
  }
  return CatalogQueryResult.getRootAsCatalogQueryResult(buffer).unpack();
}
