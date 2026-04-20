// Raw `plugin_stream_invoke` contract tests against the SGP4 wasm artifact.
// These mirror the OrbPro direct-call tests so any host (OrbPro monolithic
// build, WasmEdge, or the SDK 0.8.0 browser harness) can trust the same wire
// format for ingest/propagate/catalog_query methods exposed by the plugin.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CatalogQueryKind,
  decodeCatalogQueryResult,
  decodePropagatorState,
  encodeCatalogQueryRequest,
  encodeCatPayload,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
  encodeRecWithCat,
  encodeRecWithOmm,
  encodeSizePrefixedStream,
} from "./lib/payloadEncoders.mjs";
import {
  createInstantiatedDependency,
  invokeStream,
  invokeStreamViaDependency,
  loadRawSgp4Module,
} from "./lib/invokeStreamHelper.mjs";

function readCatRecordJson(module, noradCatId) {
  const required = module._plugin_get_cat_record_json_size(noradCatId);
  assert.ok(required > 1);
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

test("SGP4 stream_invoke ingests direct OMM frames and emits PropagatorState output", async () => {
  const module = await loadRawSgp4Module();
  try {
    assert.equal(typeof module._plugin_stream_invoke, "function");

    const ommPayload = encodeOmmPayload();
    const ingestResult = invokeStream(module, {
      methodId: "ingest_omm",
      inputs: [
        {
          bytes: ommPayload,
          portId: "omm",
          schemaName: "orbpro.sds.omm",
          fileIdentifier: "$OMM",
        },
      ],
    });
    assert.equal(ingestResult.response.errorCode, 0);
    assert.equal(module._get_satellite_count(), 1);

    const requestPayload = encodePropagatorBatchRequest({
      epoch: 2460310.5,
      entityHandles: [0],
      maxCount: 1,
    });
    const propagateResult = invokeStream(module, {
      methodId: "propagate_state",
      inputs: [
        {
          bytes: requestPayload,
          portId: "request",
          schemaName: "orbpro.propagator.batch-request",
        },
      ],
      outputStreamCap: 4,
    });

    assert.equal(propagateResult.response.errorCode, 0);
    assert.equal(propagateResult.outputPayloads.length, 1);
    assert.equal(propagateResult.outputPayloads[0].portId, "state");
    assert.equal(
      propagateResult.outputPayloads[0].typeRef?.fileIdentifier,
      "PRST",
    );

    const state = decodePropagatorState(propagateResult.outputPayloads[0].bytes);
    assert.equal(state.catalogNumber, 25544);
    assert.equal(state.entityIndex, 0);
    assert.equal(state.valid, true);
    assert.equal(state.position.length, 3);
    assert.equal(state.velocity.length, 3);
    assert.ok(Number.isFinite(state.position[0]));
    assert.ok(Number.isFinite(state.velocity[0]));
  } finally {
    module._plugin_destroy();
  }
});

test("SGP4 stream_invoke ingests REC union payloads containing OMM records", async () => {
  const module = await loadRawSgp4Module();
  try {
    const recPayload = encodeRecWithOmm(encodeOmmPayload());
    const ingestResult = invokeStream(module, {
      methodId: "ingest_omm",
      inputs: [
        {
          bytes: recPayload,
          portId: "omm",
          schemaName: "orbpro.sds.rec",
          fileIdentifier: "$REC",
        },
      ],
    });
    assert.equal(ingestResult.response.errorCode, 0);
    assert.equal(module._get_satellite_count(), 1);
  } finally {
    module._plugin_destroy();
  }
});

test("SGP4 stream_invoke ingests size-prefixed mixed OMM and REC streams", async () => {
  const module = await loadRawSgp4Module();
  try {
    const firstOmm = encodeOmmPayload({
      noradId: 25544,
      objectName: "ISS (ZARYA)",
      objectId: "1998-067A",
    });
    const secondOmm = encodeOmmPayload({
      noradId: 43013,
      objectName: "TESS",
      objectId: "2018-038A",
      epoch: "2024-01-01T01:00:00",
      meanMotion: 13.706,
      eccentricity: 0.00012,
      inclination: 28.5,
    });
    const mixedStream = encodeSizePrefixedStream([
      firstOmm,
      encodeRecWithOmm(secondOmm),
    ]);

    const ingestResult = invokeStream(module, {
      methodId: "ingest_omm",
      inputs: [
        {
          bytes: mixedStream,
          portId: "omm",
          schemaName: "orbpro.sds.rec",
        },
      ],
    });
    assert.equal(ingestResult.response.errorCode, 0);
    assert.equal(module._get_satellite_count(), 2);
  } finally {
    module._plugin_destroy();
  }
});

test("SGP4 stream_invoke upserts size-prefixed mixed CAT and REC CAT streams", async () => {
  const module = await loadRawSgp4Module();
  try {
    const mixedStream = encodeSizePrefixedStream([
      encodeCatPayload({
        noradId: 25544,
        objectName: "ISS CAT",
        objectId: "1998-067A",
      }),
      encodeRecWithCat(
        encodeCatPayload({
          noradId: 43013,
          objectName: "TESS CAT",
          objectId: "2018-038A",
          launchDate: "2018-04-18",
        }),
      ),
    ]);

    const upsertResult = invokeStream(module, {
      methodId: "upsert_cat",
      inputs: [
        {
          bytes: mixedStream,
          portId: "catalog",
          schemaName: "orbpro.sds.rec",
        },
      ],
    });

    assert.equal(upsertResult.response.errorCode, 0);
    assert.equal(readCatRecordJson(module, 25544).OBJECT_NAME, "ISS CAT");
    assert.equal(readCatRecordJson(module, 43013).OBJECT_NAME, "TESS CAT");
  } finally {
    module._plugin_destroy();
  }
});

test("SGP4 stream_invoke serves native catalog_query ROWS and VISIBILITY_MASK", async () => {
  const module = await loadRawSgp4Module();
  try {
    const ingestResult = invokeStream(module, {
      methodId: "ingest_omm",
      inputs: [
        {
          bytes: encodeSizePrefixedStream([
            encodeOmmPayload({
              noradId: 25544,
              objectName: "ISS (ZARYA)",
              objectId: "1998-067A",
            }),
            encodeRecWithOmm(
              encodeOmmPayload({
                noradId: 43013,
                objectName: "TESS",
                objectId: "2018-038A",
                epoch: "2024-01-01T01:00:00",
                meanMotion: 13.706,
                eccentricity: 0.00012,
                inclination: 28.5,
              }),
            ),
          ]),
          portId: "omm",
          schemaName: "orbpro.sds.rec",
        },
      ],
    });
    assert.equal(ingestResult.response.errorCode, 0);

    const catResult = invokeStream(module, {
      methodId: "upsert_cat",
      inputs: [
        {
          bytes: encodeSizePrefixedStream([
            encodeCatPayload({
              noradId: 25544,
              objectName: "ISS CAT",
              objectId: "1998-067A",
            }),
            encodeRecWithCat(
              encodeCatPayload({
                noradId: 43013,
                objectName: "TESS CAT",
                objectId: "2018-038A",
              }),
            ),
          ]),
          portId: "catalog",
          schemaName: "orbpro.sds.rec",
        },
      ],
    });
    assert.equal(catResult.response.errorCode, 0);

    const rowsResult = invokeStream(module, {
      methodId: "catalog_query",
      inputs: [
        {
          bytes: encodeCatalogQueryRequest({
            queryKind: CatalogQueryKind.ROWS,
            query: "ISS",
            maxCount: 5,
          }),
          portId: "request",
          schemaName: "orbpro.query.CatalogQueryRequest",
          fileIdentifier: "CQRQ",
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(rowsResult.response.errorCode, 0);
    assert.equal(rowsResult.outputPayloads.length, 1);
    const rowsPayload = decodeCatalogQueryResult(
      rowsResult.outputPayloads[0].bytes,
    );
    assert.equal(rowsPayload.queryKind, CatalogQueryKind.ROWS);
    assert.equal(rowsPayload.rows.length, 1);
    assert.equal(rowsPayload.rows[0].wasmHandle, 0);
    assert.equal(rowsPayload.rows[0].noradCatId, 25544);
    assert.equal(rowsPayload.rows[0].objectName, "ISS (ZARYA)");
    assert.equal(rowsPayload.rows[0].catObjectName, "ISS CAT");

    const visibilityResult = invokeStream(module, {
      methodId: "catalog_query",
      inputs: [
        {
          bytes: encodeCatalogQueryRequest({
            queryKind: CatalogQueryKind.VISIBILITY_MASK,
            query: "TESS",
            entityCount: 4,
          }),
          portId: "request",
          schemaName: "orbpro.query.CatalogQueryRequest",
          fileIdentifier: "CQRQ",
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(visibilityResult.response.errorCode, 0);
    const visibilityPayload = decodeCatalogQueryResult(
      visibilityResult.outputPayloads[0].bytes,
    );
    assert.equal(visibilityPayload.queryKind, CatalogQueryKind.VISIBILITY_MASK);
    assert.equal(visibilityPayload.visibleCount, 1);
    assert.deepEqual(Array.from(visibilityPayload.mask), [0, 1, 0, 0]);
  } finally {
    module._plugin_destroy();
  }
});

test("SGP4 stream_invoke serves catalog_query ENTITY_INDICES and CATALOG_ROW", async () => {
  const module = await loadRawSgp4Module();
  try {
    const ingestResult = invokeStream(module, {
      methodId: "ingest_omm",
      inputs: [
        {
          bytes: encodeSizePrefixedStream([
            encodeOmmPayload({
              noradId: 25544,
              objectName: "ISS (ZARYA)",
              objectId: "1998-067A",
            }),
            encodeRecWithOmm(
              encodeOmmPayload({
                noradId: 43013,
                objectName: "TESS",
                objectId: "2018-038A",
                epoch: "2024-01-01T01:00:00",
              }),
            ),
          ]),
          portId: "omm",
          schemaName: "orbpro.sds.rec",
        },
      ],
    });
    assert.equal(ingestResult.response.errorCode, 0);

    const catResult = invokeStream(module, {
      methodId: "upsert_cat",
      inputs: [
        {
          bytes: encodeRecWithCat(
            encodeCatPayload({
              noradId: 25544,
              objectName: "ISS CAT",
              objectId: "1998-067A",
            }),
          ),
          portId: "catalog",
          schemaName: "orbpro.sds.rec",
        },
      ],
    });
    assert.equal(catResult.response.errorCode, 0);

    const indicesResult = invokeStream(module, {
      methodId: "catalog_query",
      inputs: [
        {
          bytes: encodeCatalogQueryRequest({
            queryKind: CatalogQueryKind.ENTITY_INDICES,
            query: "ISS",
            maxCount: 4,
          }),
          portId: "request",
          schemaName: "orbpro.query.CatalogQueryRequest",
          fileIdentifier: "CQRQ",
          streamId: 5,
          sequence: 1n,
          traceToken: 77n,
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(indicesResult.response.errorCode, 0);
    const indicesPayload = decodeCatalogQueryResult(
      indicesResult.outputPayloads[0].bytes,
    );
    assert.deepEqual(Array.from(indicesPayload.entityIndices), [0]);

    const rowResult = invokeStream(module, {
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
          streamId: 6,
          sequence: 1n,
          traceToken: 78n,
        },
      ],
      outputStreamCap: 1,
    });
    assert.equal(rowResult.response.errorCode, 0);
    const rowPayload = decodeCatalogQueryResult(rowResult.outputPayloads[0].bytes);
    assert.equal(rowPayload.entityIndex, 0);
    assert.equal(rowPayload.row?.catObjectName, "ISS CAT");
    assert.equal(rowPayload.row?.wasmHandle, 0);
  } finally {
    module._plugin_destroy();
  }
});

test("SGP4 dependency bridge drives stream_invoke against the raw artifact", async () => {
  const module = await loadRawSgp4Module();
  try {
    const dependency = createInstantiatedDependency(module);

    const ingestResult = invokeStreamViaDependency(dependency, {
      methodId: "ingest_omm",
      inputs: [
        {
          portId: "omm",
          bytes: encodeRecWithOmm(encodeOmmPayload()),
          typeRef: {
            schemaName: "orbpro.sds.rec",
            fileIdentifier: "$REC",
          },
        },
      ],
    });
    assert.equal(ingestResult.statusCode, 0);
    assert.equal(module._get_satellite_count(), 1);

    const propagateResult = invokeStreamViaDependency(dependency, {
      methodId: "propagate_state",
      inputs: [
        {
          portId: "request",
          bytes: encodePropagatorBatchRequest({
            epoch: 2460310.5,
            entityHandles: [0],
            maxCount: 1,
          }),
          typeRef: {
            schemaName: "orbpro.propagator.batch-request",
          },
        },
      ],
      outputStreamCap: 4,
    });
    assert.equal(propagateResult.statusCode, 0);
    assert.equal(propagateResult.outputs.length, 1);
    const state = decodePropagatorState(propagateResult.outputs[0].bytes);
    assert.equal(state.catalogNumber, 25544);
    assert.equal(state.valid, true);
  } finally {
    module._plugin_destroy();
  }
});
