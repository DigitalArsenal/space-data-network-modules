// Round-trip verification for the CAT/REC FlatBuffer ingestion path. The
// SDN-side plugin has no JS wrapper, so these tests drive `upsert_cat`
// directly against the raw wasm export, then read the stored record back as
// its `$CAT` FlatBuffer (plugin_get_cat_record_flatbuffer) and through
// `catalog_query`, so the ingested data is checked on every read path.

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import * as flatbuffers from "flatbuffers";
import { CAT } from "spacedatastandards.org/lib/js/CAT/CAT.js";

import {
  CatalogQueryKind,
  decodeCatalogQueryResult,
  encodeCatPayload,
  encodeCatalogQueryRequest,
  encodeOmmPayload,
  encodeRecWithCat,
} from "./lib/payloadEncoders.mjs";
import {
  invokePiv,
  loadRawSgp4Module,
} from "./lib/pivInvokeHelper.mjs";

function readCatRecordBytes(module, noradCatId) {
  const size = module._plugin_get_cat_record_flatbuffer_size(noradCatId);
  assert.ok(size > 8, `expected a $CAT FlatBuffer for CAT ${noradCatId}`);
  const pointer = module._malloc(size);
  try {
    assert.equal(
      module._plugin_get_cat_record_flatbuffer(noradCatId, pointer, size),
      size,
    );
    return module.HEAPU8.slice(pointer, pointer + size);
  } finally {
    module._free(pointer);
  }
}

function readCatRecord(module, noradCatId) {
  const bb = new flatbuffers.ByteBuffer(readCatRecordBytes(module, noradCatId));
  assert.ok(CAT.bufferHasIdentifier(bb));
  return CAT.getRootAsCAT(bb);
}

test("upsert_cat ingests direct $CAT frames and exposes them through catalog_query", async () => {
  const module = await loadRawSgp4Module();
  try {
    // Seed a catalog entry so upsert_cat has something to attach to.
    const ingestResult = invokePiv(module, {
      methodId: "ingest_omm",
      inputs: [
        {
          bytes: encodeOmmPayload({
            noradId: 25544,
            objectName: "ISS (ZARYA)",
            objectId: "1998-067A",
          }),
          portId: "omm",
          schemaName: "orbpro.sds.omm",
          fileIdentifier: "$OMM",
        },
      ],
    });
    assert.equal(ingestResult.response.STATUS_CODE, 0);

    const catBytes = encodeCatPayload({
      noradId: 25544,
      objectName: "ISS CAT",
      objectId: "1998-067A",
    });
    const upsertResult = invokePiv(module, {
      methodId: "upsert_cat",
      inputs: [
        {
          bytes: catBytes,
          portId: "catalog",
          schemaName: "orbpro.sds.cat",
          fileIdentifier: "$CAT",
        },
      ],
    });
    assert.equal(upsertResult.response.STATUS_CODE, 0);

    // A direct `$CAT` is stored and answered verbatim.
    assert.deepEqual(readCatRecordBytes(module, 25544), catBytes);
    assert.equal(readCatRecord(module, 25544).OBJECT_NAME(), "ISS CAT");

    const rowResult = invokePiv(module, {
      methodId: "catalog_query",
      inputs: [
        {
          bytes: encodeCatalogQueryRequest({
            queryKind: CatalogQueryKind.CATALOG_ROW,
            entityIndex: 0,
          }),
          portId: "request",
          schemaName: "orbpro.query.CatalogQueryRequest",
          fileIdentifier: "CQRQ",
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(rowResult.response.STATUS_CODE, 0);
    const rowPayload = decodeCatalogQueryResult(
      rowResult.outputPayloads[0].bytes,
    );
    assert.equal(rowPayload.row?.noradCatId, 25544);
    assert.equal(rowPayload.row?.objectName, "ISS (ZARYA)");
    assert.equal(rowPayload.row?.catObjectName, "ISS CAT");
  } finally {
    module._plugin_destroy();
  }
});

test("upsert_cat ingests $REC-wrapped CAT records and overwrites earlier CAT metadata", async () => {
  const module = await loadRawSgp4Module();
  try {
    const ingestResult = invokePiv(module, {
      methodId: "ingest_omm",
      inputs: [
        {
          bytes: encodeOmmPayload({
            noradId: 25544,
            objectName: "ISS (ZARYA)",
            objectId: "1998-067A",
          }),
          portId: "omm",
          schemaName: "orbpro.sds.omm",
          fileIdentifier: "$OMM",
        },
      ],
    });
    assert.equal(ingestResult.response.STATUS_CODE, 0);

    assert.equal(
      invokePiv(module, {
        methodId: "upsert_cat",
        inputs: [
          {
            bytes: encodeCatPayload({
              noradId: 25544,
              objectName: "ISS CAT",
              objectId: "1998-067A",
            }),
            portId: "catalog",
            schemaName: "orbpro.sds.cat",
            fileIdentifier: "$CAT",
          },
        ],
      }).response.STATUS_CODE,
      0,
    );
    assert.equal(readCatRecord(module, 25544).OBJECT_NAME(), "ISS CAT");

    assert.equal(
      invokePiv(module, {
        methodId: "upsert_cat",
        inputs: [
          {
            bytes: encodeRecWithCat(
              encodeCatPayload({
                noradId: 25544,
                objectName: "ISS REC",
                objectId: "1998-067A",
              }),
            ),
            portId: "catalog",
            schemaName: "orbpro.sds.rec",
            fileIdentifier: "$REC",
          },
        ],
      }).response.STATUS_CODE,
      0,
    );

    const catRecord = readCatRecord(module, 25544);
    assert.equal(catRecord.OBJECT_NAME(), "ISS REC");
    assert.equal(catRecord.NORAD_CAT_ID(), 25544);

    // Several CAT tables in one `$REC` share a vtable that follows them.
    assert.equal(
      invokePiv(module, {
        methodId: "upsert_cat",
        inputs: [
          {
            bytes: encodeRecWithCat(
              ...[25545, 25546, 25547].map((noradId) =>
                encodeCatPayload({ noradId, objectName: `REC ${noradId}`, objectId: "1998-067A" }),
              ),
            ),
            portId: "catalog",
            schemaName: "orbpro.sds.rec",
            fileIdentifier: "$REC",
          },
        ],
      }).response.STATUS_CODE,
      0,
    );
    for (const noradId of [25545, 25546, 25547]) {
      assert.equal(readCatRecord(module, noradId).OBJECT_NAME(), `REC ${noradId}`);
    }
  } finally {
    module._plugin_destroy();
  }
});

// Ninety-seven $CAT frames exactly as the space-data-network-02 provider
// publishes them over SDN (CAT.fbs lane celestrak-satcat-csv, read by the
// SpaceAware console 2026-10-24): a size-prefixed stream whose frames are
// finished behind their prefix, so each frame's scalars are aligned to the
// prefix, not to the frame. 1.3.0 refused every one of them.
const LIVE_SATCAT = new Uint8Array(
  fs.readFileSync(new URL("./fixtures/celestrak-satcat-csv-97.cat", import.meta.url)),
);

function liveFrames() {
  const view = new DataView(LIVE_SATCAT.buffer, LIVE_SATCAT.byteOffset, LIVE_SATCAT.byteLength);
  const frames = [];
  for (let offset = 0; offset + 4 <= LIVE_SATCAT.byteLength; ) {
    const size = view.getUint32(offset, true);
    frames.push(LIVE_SATCAT.subarray(offset + 4, offset + 4 + size));
    offset += 4 + size;
  }
  return frames;
}

function upsertCat(module, bytes) {
  return invokePiv(module, {
    methodId: "upsert_cat",
    inputs: [{ bytes, portId: "catalog", schemaName: "orbpro.sds.cat", fileIdentifier: "$CAT" }],
  }).response.STATUS_CODE;
}

function assertStoredLike(module, frame) {
  const source = CAT.getRootAsCAT(new flatbuffers.ByteBuffer(frame));
  const stored = readCatRecord(module, source.NORAD_CAT_ID());
  assert.equal(stored.NORAD_CAT_ID(), source.NORAD_CAT_ID());
  assert.equal(stored.OBJECT_NAME(), source.OBJECT_NAME());
  assert.equal(stored.OBJECT_ID(), source.OBJECT_ID());
  assert.equal(stored.OWNER(), source.OWNER());
  assert.equal(stored.OBJECT_TYPE(), source.OBJECT_TYPE());
  assert.equal(stored.PERIOD(), source.PERIOD());
  assert.equal(stored.LAUNCH_DATE(), source.LAUNCH_DATE());
}

test("upsert_cat accepts the provider's size-prefixed $CAT stream: all 97 live frames", async () => {
  const frames = liveFrames();
  assert.equal(frames.length, 97);
  const module = await loadRawSgp4Module();
  try {
    assert.equal(upsertCat(module, LIVE_SATCAT), 0);
    for (const frame of frames) assertStoredLike(module, frame);
  } finally {
    module._plugin_destroy();
  }
});

test("upsert_cat accepts a prefix-finished $CAT frame alone, as OrbPro's loader hands one over", async () => {
  const module = await loadRawSgp4Module();
  try {
    for (const frame of liveFrames()) {
      assert.equal(upsertCat(module, frame.slice()), 0);
      assertStoredLike(module, frame);
    }
  } finally {
    module._plugin_destroy();
  }
});
