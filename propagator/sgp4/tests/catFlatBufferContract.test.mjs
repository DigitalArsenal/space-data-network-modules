// Round-trip verification for the CAT/REC FlatBuffer ingestion path. The
// OrbPro wrapper test asserted the same behaviour through `createSGP4Propagator`,
// but the SDN-side plugin has no JS wrapper — so these tests drive `upsert_cat`
// directly against the raw wasm export and then re-read the record through
// the plugin's JSON helper and `catalog_query` to verify the ingested data is
// available on every read path.

import test from "node:test";
import assert from "node:assert/strict";

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

function readCatRecordJson(module, noradCatId) {
  const required = module._plugin_get_cat_record_json_size(noradCatId);
  assert.ok(required > 1, `expected JSON payload for CAT ${noradCatId}`);
  const pointer = module._malloc(required);
  try {
    const result = module._plugin_get_cat_record_json(
      noradCatId,
      pointer,
      required,
    );
    assert.ok(result >= 0);
    const bytes = new Uint8Array(
      module.HEAPU8.slice(pointer, pointer + required - 1),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    module._free(pointer);
  }
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

    const upsertResult = invokePiv(module, {
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
    });
    assert.equal(upsertResult.response.STATUS_CODE, 0);

    assert.equal(readCatRecordJson(module, 25544).OBJECT_NAME, "ISS CAT");

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
    assert.equal(readCatRecordJson(module, 25544).OBJECT_NAME, "ISS CAT");

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

    const catRecord = readCatRecordJson(module, 25544);
    assert.equal(catRecord.OBJECT_NAME, "ISS REC");
    assert.equal(catRecord.NORAD_CAT_ID, 25544);
  } finally {
    module._plugin_destroy();
  }
});
