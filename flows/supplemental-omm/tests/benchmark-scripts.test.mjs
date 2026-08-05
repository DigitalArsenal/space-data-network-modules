import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeCanonicalModuleHash,
  createSingleFileBundle,
  signModuleArtifact,
} from "space-data-module-sdk";
import {
  Builder,
  ByteBuffer,
} from "../../../../spacedatastandards.org/node_modules/flatbuffers/js/flatbuffers.js";
import { OCM } from "../../../../spacedatastandards.org/lib/js/OCM/OCM.js";
import { Metadata } from "../../../../spacedatastandards.org/lib/js/OCM/Metadata.js";
import { OrbitDetermination } from "../../../../spacedatastandards.org/lib/js/OCM/OrbitDetermination.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/OMM.js";
import { FSB } from "../../../../spacedatastandards.org/lib/js/FSB/FSB.js";
import { FSO } from "../../../../spacedatastandards.org/lib/js/FSO/FSO.js";
import { flatSqlNodeOperation } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeOperation.js";
import { flatSqlNodeStatus } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeStatus.js";

import {
  measureStarlinkCatalog,
  sampleEvenly,
  selectLatestManifestEntries,
} from "../scripts/benchmark-starlink-catalog.mjs";
import {
  createFileBackedOpaqueAdapter,
  createMeasuredDispatch,
  createNdjsonSink,
  decodeDssRoutePayload,
  instantiateWorkerChildren,
  isFlatSqlAppendCompletePayload,
  loadVerifiedSignedFlow,
  observeSdnRuntime,
  parseCli,
  parseOdQualityText,
  reloadAndQueryFlatSql,
  runLocalExactFlow,
  sampleLinuxProcess,
  summarizeBenchmark,
} from "../scripts/benchmark-signed-starlink-flow.mjs";

const MINIMAL_WASM = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const TEST_SIGNING_SEED = "41".repeat(32);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeSignedFlowFixture(directory) {
  const childUnsigned = await createSingleFileBundle({
    wasmBytes: MINIMAL_WASM,
  });
  const childSigned = await signModuleArtifact(childUnsigned.wasmBytes, {
    privateKeySeedHex: TEST_SIGNING_SEED,
    keyId: "fixture",
    signatureScope: "bundle",
  });
  const childBytes = childSigned.wasmBytes;
  const childHash = sha256(childBytes);
  const portableHash = (await computeCanonicalModuleHash(MINIMAL_WASM)).hashHex;
  const publisher = {
    algorithm: "ed25519",
    keyId: "fixture",
    publicKeyHex: childSigned.signature.publicKeyHex,
    developmentOnly: true,
  };
  const artifact = {
    programId: "org.sdn.test.signed-flow-benchmark",
    dispatchModel: "isomorphic",
    nodeArtifacts: [
      {
        nodeId: "provider-starlink",
        pluginId: "org.sdn.test.starlink",
        methodId: "emit",
        dispatchModel: "isomorphic",
        sha256: childHash,
        entryId: "org.sdn.test.starlink",
        publisherEntryId: "nodes/provider-starlink.publisher.json",
        publisherPublicKeyHex: publisher.publicKeyHex,
        artifactPath: "./must-not-be-read.wasm",
      },
    ],
    runtimeNodeRoutes: [
      {
        key: "provider-starlink.dss",
        nodeId: "status",
        portId: "provider-starlink.dss",
        mediaType: "application/x-flatbuffers",
      },
    ],
    bundle: { portableWasmSha256: portableHash },
  };
  const encoder = new TextEncoder();
  const outerUnsigned = await createSingleFileBundle({
    wasmBytes: MINIMAL_WASM,
    entries: [
      {
        entryId: "flow.plg",
        role: "auxiliary",
        payloadEncoding: "raw",
        payload: encoder.encode("fixture-flow-without-retired-products"),
      },
      {
        entryId: "artifact.json",
        role: "auxiliary",
        payloadEncoding: "json-utf8",
        payload: encoder.encode(JSON.stringify(artifact)),
      },
      {
        entryId: "org.sdn.test.starlink",
        role: "auxiliary",
        payloadEncoding: "raw",
        payload: childBytes,
      },
      {
        entryId: "nodes/provider-starlink.publisher.json",
        role: "auxiliary",
        payloadEncoding: "json-utf8",
        payload: encoder.encode(JSON.stringify(publisher)),
      },
    ],
  });
  const outerSigned = await signModuleArtifact(outerUnsigned.wasmBytes, {
    privateKeySeedHex: TEST_SIGNING_SEED,
    keyId: "fixture",
    signatureScope: "bundle",
  });
  const artifactPath = path.join(directory, "module.wasm");
  fs.writeFileSync(artifactPath, outerSigned.wasmBytes);
  fs.writeFileSync(
    path.join(directory, "must-not-be-read.wasm"),
    Uint8Array.of(1, 2, 3),
  );
  return {
    artifactPath,
    childBytes,
    childHash,
    portableHash,
    publicKeyHex: outerSigned.signature.publicKeyHex,
  };
}

function makeDssRoute({
  status,
  syncedRows = 3n,
  totalRows = 3n,
  missingRows = 0n,
  cachedBytes = 0n,
  downloadedBytes = 12n,
  error = "",
} = {}) {
  const dssBuilder = new Builder(256);
  const errorOffset = error ? dssBuilder.createString(error) : 0;
  const effectiveStatus =
    status ?? (totalRows > 0n && syncedRows === totalRows ? 2 : 1);
  dssBuilder.startObject(34);
  dssBuilder.addFieldInt8(0, effectiveStatus, 0);
  dssBuilder.addFieldInt64(1, syncedRows, 0n);
  dssBuilder.addFieldInt64(2, totalRows, 0n);
  dssBuilder.addFieldInt64(7, missingRows, 0n);
  dssBuilder.addFieldInt64(8, downloadedBytes, 0n);
  dssBuilder.addFieldInt64(9, cachedBytes, 0n);
  if (errorOffset) dssBuilder.addFieldOffset(33, errorOffset, 0);
  const dssRoot = dssBuilder.endObject();
  dssBuilder.finishSizePrefixed(dssRoot, "$DSS");
  const dss = dssBuilder.asUint8Array();

  const fsbBuilder = new Builder(512);
  const schemaName = fsbBuilder.createString("DSS.fbs");
  const fileIdentifier = fsbBuilder.createString("$DSS");
  fsbBuilder.startVector(1, dss.byteLength, 1);
  for (let index = dss.byteLength - 1; index >= 0; index -= 1) {
    fsbBuilder.addInt8(dss[index]);
  }
  const data = fsbBuilder.endVector();
  fsbBuilder.startObject(11);
  fsbBuilder.addFieldInt64(0, 1n, 0n);
  fsbBuilder.addFieldInt8(3, 1, 0);
  fsbBuilder.addFieldInt64(4, BigInt(dss.byteLength), 0n);
  fsbBuilder.addFieldInt64(5, 1n, 0n);
  fsbBuilder.addFieldOffset(7, schemaName, 0);
  fsbBuilder.addFieldOffset(8, fileIdentifier, 0);
  fsbBuilder.addFieldOffset(9, data, 0);
  const fsbRoot = fsbBuilder.endObject();
  fsbBuilder.finish(fsbRoot, "$FSB");
  return fsbBuilder.asUint8Array();
}

function makeOmmRecord({
  norad = 41001,
  objectName = "STARLINK-FIXTURE",
  objectId = "2026-001A",
  epoch = "2026-07-23T00:00:00.000000Z",
} = {}) {
  const builder = new Builder(256);
  const objectNameOffset = builder.createString(objectName);
  const objectIdOffset = builder.createString(objectId);
  const epochOffset = builder.createString(epoch);
  OMM.startOMM(builder);
  OMM.addObjectName(builder, objectNameOffset);
  OMM.addObjectId(builder, objectIdOffset);
  OMM.addEpoch(builder, epochOffset);
  OMM.addNoradCatId(builder, norad);
  const root = OMM.endOMM(builder);
  OMM.finishSizePrefixedOMMBuffer(builder, root);
  return builder.asUint8Array();
}

function makeOcmRecord({
  residuals = "WRMS=0.125 km",
  convergenceCriteria = "iterations=17; converged=true",
  norad = 41001,
  objectName = "STARLINK-FIXTURE",
  objectId = "2026-001A",
  epoch = "2026-07-23T00:00:00.000000Z",
} = {}) {
  const builder = new Builder(512);
  const residualsOffset = builder.createString(residuals);
  const convergenceOffset = builder.createString(convergenceCriteria);
  const objectNameOffset = builder.createString(objectName);
  const objectIdOffset = builder.createString(objectId);
  const catalogOffset = builder.createString(String(norad));
  const epochOffset = builder.createString(epoch);
  Metadata.startMetadata(builder);
  Metadata.addObjectName(builder, objectNameOffset);
  Metadata.addInternationalDesignator(builder, objectIdOffset);
  Metadata.addCatalogName(builder, catalogOffset);
  const metadata = Metadata.endMetadata(builder);
  OrbitDetermination.startOrbitDetermination(builder);
  OrbitDetermination.addOdEpoch(builder, epochOffset);
  OrbitDetermination.addOdResiduals(builder, residualsOffset);
  OrbitDetermination.addOdConvergenceCriteria(builder, convergenceOffset);
  const determination = OrbitDetermination.endOrbitDetermination(builder);
  OCM.startOCM(builder);
  OCM.addMetadata(builder, metadata);
  OCM.addOrbitDetermination(builder, determination);
  const root = OCM.endOCM(builder);
  OCM.finishSizePrefixedOCMBuffer(builder, root);
  return builder.asUint8Array();
}

function makeTerminalOcmRecord({
  norad = 41002,
  objectName = "STARLINK-TERMINAL",
  objectId = "2026-002A",
  epoch = "2026-07-23T00:00:00.000Z",
  stopTime = "2026-07-23T00:02:00.000Z",
  stateStepSize = 60,
  stateData = [
    6_500, 0, 0, 0, 7.5, 0,
    6_450, 50, 0, -0.1, 7.5, 0,
    6_400, 100, 0, -0.2, 7.5, 0,
  ],
  covarianceData = [],
  includeOrbitDetermination = false,
  trajectoryDescription =
    "TERMINAL_REENTRY_SOURCE_TRAJECTORY_TEME",
} = {}) {
  const builder = new Builder(1_024);
  const objectNameOffset = builder.createString(objectName);
  const objectIdOffset = builder.createString(objectId);
  const catalogOffset = builder.createString(String(norad));
  const epochOffset = builder.createString(epoch);
  const stopOffset = builder.createString(stopTime);
  const trajectoryDescriptionOffset =
    builder.createString(trajectoryDescription);
  const encodedStates = OCM.createStateDataVector(builder, stateData);
  const encodedCovariance = covarianceData.length > 0
    ? OCM.createCovarianceDataVector(builder, covarianceData)
    : 0;
  Metadata.startMetadata(builder);
  Metadata.addObjectName(builder, objectNameOffset);
  Metadata.addInternationalDesignator(builder, objectIdOffset);
  Metadata.addCatalogName(builder, catalogOffset);
  Metadata.addEpochTzero(builder, epochOffset);
  Metadata.addStartTime(builder, epochOffset);
  Metadata.addStopTime(builder, stopOffset);
  Metadata.addTimeSpan(
    builder,
    ((stateData.length / 6) - 1) * stateStepSize / 86_400,
  );
  const metadata = Metadata.endMetadata(builder);
  let determination = 0;
  if (includeOrbitDetermination) {
    const residuals = builder.createString("WRMS=0.125 km");
    const convergence = builder.createString(
      "iterations=17; converged=true",
    );
    OrbitDetermination.startOrbitDetermination(builder);
    OrbitDetermination.addOdEpoch(builder, epochOffset);
    OrbitDetermination.addOdResiduals(builder, residuals);
    OrbitDetermination.addOdConvergenceCriteria(builder, convergence);
    determination = OrbitDetermination.endOrbitDetermination(builder);
  }
  OCM.startOCM(builder);
  OCM.addMetadata(builder, metadata);
  OCM.addTrajTypeDescription(builder, trajectoryDescriptionOffset);
  OCM.addStateStepSize(builder, stateStepSize);
  OCM.addStateVectorSize(builder, 6);
  OCM.addStateData(builder, encodedStates);
  if (encodedCovariance) {
    OCM.addCovarianceData(builder, encodedCovariance);
  }
  if (determination) {
    OCM.addOrbitDetermination(builder, determination);
  }
  const root = OCM.endOCM(builder);
  OCM.finishSizePrefixedOCMBuffer(builder, root);
  return builder.asUint8Array();
}

function makeFlatSqlStatus({
  operation = flatSqlNodeOperation.APPEND_RECORDS,
  status = flatSqlNodeStatus.COMPLETE,
  requestId = 42n,
  affectedRecords = 0n,
  resultBytes = 0n,
} = {}) {
  const builder = new Builder(128);
  FSO.startFSO(builder);
  FSO.addOperation(builder, operation);
  FSO.addRequestId(builder, requestId);
  FSO.addStatus(builder, status);
  FSO.addAffectedRecords(builder, affectedRecords);
  FSO.addResultBytes(builder, resultBytes);
  const root = FSO.endFSO(builder);
  FSO.finishFSOBuffer(builder, root);
  return builder.asUint8Array();
}

function makeFlatSqlConfigure({
  databaseName = "supplemental-omm",
  requestId = 1n,
} = {}) {
  const builder = new Builder(256);
  const database = builder.createString(databaseName);
  FSO.startFSO(builder);
  FSO.addOperation(builder, flatSqlNodeOperation.CONFIGURE_INDEX);
  FSO.addRequestId(builder, requestId);
  FSO.addDatabaseName(builder, database);
  const root = FSO.endFSO(builder);
  FSO.finishFSOBuffer(builder, root);
  return builder.asUint8Array();
}

function concatenateBytes(chunks) {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function makeFlatSqlQueryRecords({
  records,
  requestId,
} = {}) {
  const dataBytes = concatenateBytes(records);
  const builder = new Builder(dataBytes.byteLength + 512);
  const data = FSB.createDataVector(builder, dataBytes);
  FSB.startFSB(builder);
  FSB.addRequestId(builder, BigInt(requestId));
  FSB.addKind(builder, 2);
  FSB.addChunkSequence(builder, 0);
  FSB.addFinal(builder, true);
  FSB.addTotalBytes(builder, BigInt(dataBytes.byteLength));
  FSB.addRecordCount(builder, BigInt(records.length));
  FSB.addColumnCount(builder, 1);
  FSB.addData(builder, data);
  const root = FSB.endFSB(builder);
  FSB.finishFSBBuffer(builder, root);
  return builder.asUint8Array();
}

function makeStarlinkOemEnvelope({
  requestId = 1n,
  norad = 41001,
  objectName = "STARLINK-FIXTURE",
  sequence = 0,
  final = true,
} = {}) {
  const builder = new Builder(256);
  const schemaName = builder.createString(`MEME:${norad}:${objectName}`);
  const fileIdentifier = builder.createString("MEME");
  const data = FSB.createDataVector(builder, Uint8Array.of(1));
  FSB.startFSB(builder);
  FSB.addRequestId(builder, requestId);
  FSB.addKind(builder, 1);
  FSB.addChunkSequence(builder, sequence);
  FSB.addFinal(builder, final);
  FSB.addTotalBytes(builder, 1n);
  FSB.addRecordCount(builder, 1n);
  FSB.addSchemaName(builder, schemaName);
  FSB.addFileIdentifier(builder, fileIdentifier);
  FSB.addData(builder, data);
  const root = FSB.endFSB(builder);
  FSB.finishFSBBuffer(builder, root);
  return builder.asUint8Array();
}

function makeVerifiedLocalFlow() {
  return {
    outerSha256: "a".repeat(64),
    portableWasmSha256: "b".repeat(64),
    verification: { publicKeyHex: "c".repeat(64) },
    trustedPublicKeys: ["c".repeat(64)],
    children: [],
    outerBytes: MINIMAL_WASM,
    tree: {},
  };
}

function makeFakeLocalRuntimeFactory({
  bootstrapError,
  hangBootstrap = false,
  hangWorkDrain = false,
  queueEmpty = true,
  omm = makeOmmRecord(),
  ocm = makeOcmRecord(),
  publicationRecords,
  progress = makeDssRoute({
    syncedRows: 1n,
    totalRows: 1n,
  }),
  starlinkOemOutputs = [
    makeStarlinkOemEnvelope(),
  ],
  onDestroy,
} = {}) {
  return async (_loaded, { observer, dispatchFactory }) => {
    let drainCount = 0;
    const parent = {
      nodeCount: 1,
      edgeCount: 0,
      enqueueTrigger() {},
      getNodeDispatchDescriptor() {
        return { nodeId: "status" };
      },
      getNodeState() {
        return {
          ready: !queueEmpty,
          queuedFrames: queueEmpty ? 0 : 1,
          backlogRemaining: 0,
          lastStatus: 0,
        };
      },
      getRoutingState() {
        return { rejectedFrames: 0n };
      },
    };
    return {
      parent,
      async drain() {
        drainCount += 1;
        if (drainCount === 1) {
          if (bootstrapError) throw bootstrapError;
          if (hangBootstrap) return new Promise(() => {});
          return { iterations: 1, nodesInvoked: 1, handlersSkipped: 0 };
        }
        if (hangWorkDrain) return new Promise(() => {});
        const publication = dispatchFactory({ nodeId: "publication" });
        for (const product of publicationRecords ?? [
          { standard: "OMM", data: omm },
          { standard: "OCM", data: ocm },
        ]) {
          await publication("pubsub.publish", product);
        }
        const child = { nodeId: "provider-starlink" };
        await observer.onInvocationStart({ child, frames: [] });
        await observer.onInvocationEnd({
          child,
          elapsedMs: 1,
          response: {
            statusCode: 0,
            backlogRemaining: 0,
            outputs: [
              ...starlinkOemOutputs.map((payload) => ({
                portId: "oem",
                payload,
              })),
              {
                portId: "progress",
                payload: progress,
              },
            ],
          },
        });
        return { iterations: 1, nodesInvoked: 1, handlersSkipped: 0 };
      },
      async destroy() {
        onDestroy?.();
      },
    };
  };
}

function exactReloadResult(metrics, overrides = {}) {
  return {
    verified: true,
    exactChildSha256: "d".repeat(64),
    databaseName: "supplemental-omm",
    recordCounts: {
      OMM: metrics.publications.OMM,
      OCM: metrics.publications.OCM,
    },
    recordHashes: {
      OMM: [...metrics.publications.recordHashes.OMM],
      OCM: [...metrics.publications.recordHashes.OCM],
    },
    ...overrides,
  };
}

test("catalog benchmark selects the latest generation per stable Starlink identity", () => {
  const manifest = [
    "MEME_41001_STARLINK-A_2026001_Operational_100_UNCLASSIFIED.txt",
    "ignored.txt",
    "MEME_41002_STARLINK-B_2026002_Operational_600_UNCLASSIFIED.txt",
    "MEME_41001_STARLINK-A_2026002_Operational_900_UNCLASSIFIED.txt",
    "MEME_41002_STARLINK-B_2026001_Operational_300_UNCLASSIFIED.txt",
    "",
  ].join("\n");

  assert.deepEqual(selectLatestManifestEntries(manifest), [
    "MEME_41002_STARLINK-B_2026002_Operational_600_UNCLASSIFIED.txt",
    "MEME_41001_STARLINK-A_2026002_Operational_900_UNCLASSIFIED.txt",
  ]);
});

test("catalog samples span the entire ordered data set including both endpoints", () => {
  assert.deepEqual(sampleEvenly(["a", "b", "c", "d", "e"], 3), [
    "a",
    "c",
    "e",
  ]);
  assert.deepEqual(sampleEvenly(["a", "b", "c"], 1), ["b"]);
  assert.deepEqual(sampleEvenly(["a", "b"], 10), ["a", "b"]);
});

test("real-corpus OD benchmark is bounded, attributable, and exhaustive", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "od-node.test.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /const maxStarlinkSourceBytes = 4 \* 1024 \* 1024;/,
    "benchmark source bounds must match the signed Starlink OD guest",
  );
  assert.match(
    source,
    /const maximumDrainResponses = fixtureBytes\.length \+ 1;/,
    "a guest backlog must not create an unbounded drain loop",
  );
  assert.match(
    source,
    /decodeStatusOutput\(response\)/,
    "responses must be attributed by their transaction status, not array position",
  );
  assert.match(source, /processPeakRssMiB/);
  assert.match(source, /allFailures\.push\(\.\.\.failures\)/);
  assert.match(source, /const maxStarlinkManifestBytes = 8 \* 1024 \* 1024;/);
  assert.match(source, /const liveFetchWaveWidth = 64;/);
  assert.match(source, /selectLatestManifestEntries/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /nextWavePromise/);
  assert.match(source, /SDN_OD_REAL_MEME_FETCH_ATTEMPTS/);
  assert.match(source, /SDN_OD_REAL_MEME_FETCH_TIMEOUT_MS/);
  assert.match(source, /entry\.data = null;/);
  assert.match(source, /totalOmmRecords=/);
  assert.match(source, /totalOcmRecords=/);
  assert.match(source, /maxObservedIterations=/);
  assert.match(source, /realCorpusAttempt/);
  assert.match(source, /manifestSha256/);
  assert.match(
    source,
    /assert\.equal\(\s*allFailures\.length,\s*0,/s,
    "catalog failures must be asserted after all intended batches finish",
  );
});

test("catalog census bounds probes and sums complete source byte lengths", async () => {
  const manifestUrl = "https://fixture.invalid/MANIFEST.txt";
  const ephemerisBase = "https://fixture.invalid/";
  const filenames = [
    "MEME_41001_STARLINK-A_2026002_Operational_900_UNCLASSIFIED.txt",
    "MEME_41002_STARLINK-B_2026002_Operational_600_UNCLASSIFIED.txt",
    "MEME_41003_STARLINK-C_2026002_Operational_500_UNCLASSIFIED.txt",
  ];
  const byteLengths = new Map([
    [filenames[0], 101],
    [filenames[1], 202],
    [filenames[2], 303],
  ]);
  const manifestText = `${filenames.join("\n")}\n`;
  let active = 0;
  let maximumActive = 0;

  const fetchImpl = async (url, options = {}) => {
    if (url === manifestUrl) {
      return new Response(manifestText, { status: 200 });
    }
    assert.equal(options.headers.Range, "bytes=0-0");
    const filename = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    const total = byteLengths.get(filename);
    assert.ok(total);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return new Response(new Uint8Array([65]), {
      status: 206,
      headers: { "Content-Range": `bytes 0-0/${total}` },
    });
  };

  const report = await measureStarlinkCatalog({
    manifestUrl,
    ephemerisBase,
    concurrency: 2,
    fetchImpl,
  });

  assert.equal(report.selectedEntries, 3);
  assert.equal(report.probedEntries, 3);
  assert.equal(report.manifestSha256, sha256(new TextEncoder().encode(manifestText)));
  assert.equal(report.sourceBytes, 606);
  assert.equal(report.failures.length, 0);
  assert.ok(maximumActive > 1);
  assert.ok(maximumActive <= 2);
  assert.equal(report.concurrency, 2);
});

test("catalog measurement reports the full catalog while evenly sampling it", async () => {
  const manifestUrl = "https://fixture.invalid/MANIFEST.txt";
  const ephemerisBase = "https://fixture.invalid/";
  const filenames = Array.from(
    { length: 5 },
    (_, index) =>
      `MEME_${41001 + index}_STARLINK-${index}_2026002_Operational_${500 + index}_UNCLASSIFIED.txt`,
  );
  const requested = [];
  const fetchImpl = async (url) => {
    if (url === manifestUrl) {
      return new Response(`${filenames.join("\n")}\n`, { status: 200 });
    }
    requested.push(decodeURIComponent(new URL(url).pathname.split("/").at(-1)));
    return new Response(new Uint8Array([65]), {
      status: 206,
      headers: { "Content-Range": "bytes 0-0/100" },
    });
  };

  const report = await measureStarlinkCatalog({
    manifestUrl,
    ephemerisBase,
    sampleCount: 3,
    fetchImpl,
  });

  assert.equal(report.catalogEntries, 5);
  assert.equal(report.selectedEntries, 3);
  assert.deepEqual(requested, [filenames[0], filenames[2], filenames[4]]);
});

test("catalog download mode bounds full transfers and counts actual bytes", async () => {
  const manifestUrl = "https://fixture.invalid/MANIFEST.txt";
  const ephemerisBase = "https://fixture.invalid/";
  const filenames = [
    "MEME_41001_STARLINK-A_2026002_Operational_900_UNCLASSIFIED.txt",
    "MEME_41002_STARLINK-B_2026002_Operational_600_UNCLASSIFIED.txt",
    "MEME_41003_STARLINK-C_2026002_Operational_500_UNCLASSIFIED.txt",
  ];
  const byteLengths = [101, 202, 303];
  let active = 0;
  let maximumActive = 0;

  const fetchImpl = async (url, options = {}) => {
    if (url === manifestUrl) {
      return new Response(`${filenames.join("\n")}\n`, { status: 200 });
    }
    assert.equal(options.headers, undefined);
    const filename = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    const index = filenames.indexOf(filename);
    assert.notEqual(index, -1);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return new Response(new Uint8Array(byteLengths[index]), { status: 200 });
  };

  const report = await measureStarlinkCatalog({
    manifestUrl,
    ephemerisBase,
    concurrency: 2,
    download: true,
    fetchImpl,
  });

  assert.equal(report.mode, "download");
  assert.equal(report.selectedEntries, 3);
  assert.equal(report.completedEntries, 3);
  assert.equal(report.sourceBytes, 606);
  assert.equal(report.transferredBytes, 606);
  assert.ok(report.bytesPerSecond > 0);
  assert.equal(report.failures.length, 0);
  assert.ok(maximumActive > 1);
  assert.ok(maximumActive <= 2);
});

test("signed-flow loader verifies the outer tree and uses only embedded child bytes", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-signed-flow-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = await makeSignedFlowFixture(directory);

  const loaded = await loadVerifiedSignedFlow({
    artifactPath: fixture.artifactPath,
    trustedPublicKeys: [fixture.publicKeyHex],
  });

  assert.equal(loaded.outerSha256, sha256(fs.readFileSync(fixture.artifactPath)));
  assert.equal(loaded.portableWasmSha256, fixture.portableHash);
  assert.equal(loaded.children.length, 1);
  assert.equal(loaded.children[0].sha256, fixture.childHash);
  assert.deepEqual(
    loaded.children[0].wasmBytes,
    fixture.childBytes,
    "the sibling path in artifact metadata must never replace embedded bytes",
  );
  assert.equal(loaded.children[0].verification.signatureScope, "bundle");

  await assert.rejects(
    loadVerifiedSignedFlow({
      artifactPath: fixture.artifactPath,
      trustedPublicKeys: [fixture.publicKeyHex],
      expectedTree: {
        outerSha256: loaded.outerSha256,
        portableWasmSha256: loaded.portableWasmSha256,
        children: { "provider-starlink": "0".repeat(64) },
      },
    }),
    /artifact tree parity mismatch/i,
  );
});

test("file-backed opaque adapter persists compact Starlink cursors and rejects raw ephemerides", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-opaque-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adapter = createFileBackedOpaqueAdapter({
    stateDir: directory,
    maxStarlinkCursorBytes: 128,
  });
  const cursor = new Uint8Array(32);
  cursor.set(new TextEncoder().encode("SLCURS01"));

  assert.deepEqual(
    await adapter.dispatch(
      "provider-starlink",
      "storage.adapter.opaque.replace",
      { namespace: "primary", key: "starlink.cursor.v1", data: cursor },
    ),
    { stored_bytes: cursor.byteLength },
  );
  assert.deepEqual(
    await adapter.dispatch(
      "provider-starlink",
      "storage.adapter.opaque.read",
      { namespace: "primary", key: "starlink.cursor.v1" },
    ),
    { found: true, bytes_b64: cursor },
  );
  assert.deepEqual(
    await adapter.dispatch(
      "provider-starlink",
      "storage.adapter.opaque.list",
      { namespace: "primary" },
    ),
    { keys: ["starlink.cursor.v1"] },
  );
  assert.equal(
    adapter.metrics.byNode["provider-starlink"].replacedBytes,
    cursor.byteLength,
  );
  assert.equal(
    adapter.metrics.byNode["provider-starlink"].readBytes,
    cursor.byteLength,
  );

  const raw = new Uint8Array(64);
  raw.set(new TextEncoder().encode("SLCURS01ephemeris_start:"));
  await assert.rejects(
    adapter.dispatch(
      "provider-starlink",
      "storage.adapter.opaque.replace",
      { namespace: "primary", key: "starlink.cursor.v1", data: raw },
    ),
    /raw Starlink ephemeris/i,
  );
  await assert.rejects(
    adapter.dispatch(
      "provider-starlink",
      "storage.adapter.opaque.replace",
      {
        namespace: "primary",
        key: "starlink.cursor.v1",
        data: new Uint8Array(129),
      },
    ),
    /cursor exceeds/i,
  );
  await assert.rejects(
    adapter.dispatch(
      "provider-starlink",
      "storage.adapter.opaque.replace",
      { namespace: "primary", key: "unexpected.raw", data: cursor },
    ),
    /only persist primary\/starlink\.cursor\.v1/i,
  );
});

test("measured dispatch is application-scoped and records bounded HTTP/publication telemetry", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-dispatch-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const opaqueAdapter = createFileBackedOpaqueAdapter({ stateDir: directory });
  const metrics = {};
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://fixture.invalid/MANIFEST.txt");
    assert.equal(options.method, "GET");
    return new Response("manifest", {
      status: 200,
      headers: { "Content-Length": "8" },
    });
  };
  const starlinkDispatch = createMeasuredDispatch({
    nodeId: "provider-starlink",
    opaqueAdapter,
    metrics,
    fetchImpl,
    now: () => 1234,
  });
  const response = await starlinkDispatch("http.request", {
    url: "https://fixture.invalid/MANIFEST.txt",
    method: "GET",
    max_bytes: 128,
  });
  assert.equal(response.status, 200);
  assert.equal(new TextDecoder().decode(response.body), "manifest");
  assert.equal(metrics.http.requests, 1);
  assert.equal(metrics.http.responseBytes, 8);
  assert.ok(Number.isFinite(metrics.milestones.starlinkManifestFetchedAtMs));

  await assert.rejects(
    starlinkDispatch("pubsub.publish", {
      standard: "OMM",
      data: new Uint8Array(),
    }),
    /not allowed/i,
  );
  const publicationDispatch = createMeasuredDispatch({
    nodeId: "publication",
    opaqueAdapter,
    metrics,
  });
  await assert.rejects(
    publicationDispatch("pubsub.publish", {
      standard: "OBD",
      data: new Uint8Array(),
    }),
    /OBD is retired/i,
  );
  assert.equal(
    await publicationDispatch("pubsub.publish", {
      standard: "OMM",
      data: makeOmmRecord(),
    }),
    true,
  );
  assert.equal(
    await publicationDispatch("pubsub.publish", {
      standard: "OCM",
      data: makeOcmRecord(),
    }),
    true,
  );
  assert.equal(metrics.publications.OMM, 1);
  assert.equal(metrics.publications.OCM, 1);
  assert.deepEqual(metrics.publications.rmsKm, [0.125]);
  assert.deepEqual(metrics.publications.iterations, [17]);
  assert.equal(
    await publicationDispatch("pubsub.publish", {
      standard: "OCM",
      data: makeOcmRecord({
        convergenceCriteria: "iterations=60; converged=true",
        epoch: "2026-07-23T03:00:00.000000Z",
      }),
    }),
    true,
  );
  await assert.rejects(
    publicationDispatch("pubsub.publish", {
      standard: "OCM",
      data: makeOcmRecord({
        convergenceCriteria: "iterations=61; converged=true",
        epoch: "2026-07-23T04:00:00.000000Z",
      }),
    }),
    /60-iteration fit cap/i,
  );
  await assert.rejects(
    publicationDispatch("pubsub.publish", {
      standard: "OCM",
      data: makeOcmRecord({
        residuals: "missing WRMS",
        convergenceCriteria: "missing iteration count",
      }),
    }),
    /finite WRMS and iteration/i,
  );
  await assert.rejects(
    publicationDispatch("pubsub.publish", {
      standard: "OCM",
      data: makeOcmRecord({
        convergenceCriteria: "iterations=17; converged=false",
        epoch: "2026-07-23T05:00:00.000000Z",
      }),
    }),
    /converged=true/i,
  );
  await assert.rejects(
    publicationDispatch("pubsub.publish", {
      standard: "OCM",
      data: makeOcmRecord({
        convergenceCriteria: "iterations=17",
        epoch: "2026-07-23T05:30:00.000000Z",
      }),
    }),
    /converged=true/i,
  );
  await assert.rejects(
    publicationDispatch("pubsub.publish", {
      standard: "OCM",
      data: makeOcmRecord({
        residuals: "WRMS=12 km",
        epoch: "2026-07-23T06:00:00.000000Z",
      }),
    }),
    /below 12 km/i,
  );
});

test("publication telemetry rejects duplicate source/epoch products", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-publication-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dispatch = createMeasuredDispatch({
    nodeId: "publication",
    opaqueAdapter: createFileBackedOpaqueAdapter({ stateDir: directory }),
    metrics: {},
  });
  const record = makeOmmRecord();
  assert.equal(
    await dispatch("pubsub.publish", { standard: "OMM", data: record }),
    true,
  );
  await assert.rejects(
    dispatch("pubsub.publish", { standard: "OMM", data: record }),
    /duplicate.*source.*epoch/i,
  );
});

test("publication telemetry reserves duplicate identities across overlapping hostcalls", async () => {
  let publishCalls = 0;
  let releasePublish;
  let firstPublishEntered;
  const firstEntered = new Promise((resolve) => {
    firstPublishEntered = resolve;
  });
  const publishGate = new Promise((resolve) => {
    releasePublish = resolve;
  });
  const metrics = {};
  const dispatch = createMeasuredDispatch({
    nodeId: "publication",
    metrics,
    publishImpl: async () => {
      publishCalls += 1;
      firstPublishEntered();
      await publishGate;
      return true;
    },
  });
  const record = makeOmmRecord();
  const first = dispatch("pubsub.publish", {
    standard: "OMM",
    data: record,
  });
  await firstEntered;
  const second = dispatch("pubsub.publish", {
    standard: "OMM",
    data: record,
  });
  const settled = Promise.allSettled([first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  releasePublish();
  const results = await settled;

  assert.deepEqual(
    results.map(({ status }) => status).sort(),
    ["fulfilled", "rejected"],
  );
  assert.match(
    results.find(({ status }) => status === "rejected").reason.message,
    /duplicate.*source.*epoch/i,
  );
  assert.equal(publishCalls, 1);
  assert.equal(metrics.publications.OMM, 1);
});

test("publication telemetry records only successful publications", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-publication-result-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let accepted = false;
  const metrics = {};
  const dispatch = createMeasuredDispatch({
    nodeId: "publication",
    opaqueAdapter: createFileBackedOpaqueAdapter({ stateDir: directory }),
    metrics,
    publishImpl: async () => accepted,
  });
  const record = makeOmmRecord();
  assert.equal(
    await dispatch("pubsub.publish", { standard: "OMM", data: record }),
    false,
  );
  assert.equal(metrics.publications.OMM, 0);

  accepted = true;
  assert.equal(
    await dispatch("pubsub.publish", { standard: "OMM", data: record }),
    true,
  );
  assert.equal(metrics.publications.OMM, 1);
});

test("publication telemetry admits only structurally validated terminal OCM-only records", async () => {
  const metrics = {};
  const dispatch = createMeasuredDispatch({
    nodeId: "publication",
    metrics,
  });
  const terminal = makeTerminalOcmRecord();
  const decodedTerminal = OCM.getSizePrefixedRootAsOCM(
    new ByteBuffer(terminal),
  );
  assert.equal(
    decodedTerminal.TRAJ_TYPE_DESCRIPTION(),
    "TERMINAL_REENTRY_SOURCE_TRAJECTORY_TEME",
  );
  assert.equal(decodedTerminal.STATE_VECTOR_SIZE(), 6);
  assert.equal(decodedTerminal.TRAJ_TYPE(), 0);
  assert.equal(decodedTerminal.STATE_STEP_SIZE(), 60);
  assert.equal(decodedTerminal.stateDataLength(), 18);
  assert.ok(decodedTerminal.stateDataArray().every(Number.isFinite));
  assert.equal(
    decodedTerminal.METADATA()?.EPOCH_TZERO(),
    decodedTerminal.METADATA()?.START_TIME(),
  );
  assert.equal(
    decodedTerminal.METADATA()?.STOP_TIME(),
    "2026-07-23T00:02:00.000Z",
  );
  assert.ok(
    Math.abs(decodedTerminal.METADATA()?.TIME_SPAN() * 86_400 - 120) <
      1e-9,
  );
  assert.equal(decodedTerminal.covarianceDataLength(), 0);
  assert.equal(decodedTerminal.ORBIT_DETERMINATION(), null);
  assert.equal(
    await dispatch("pubsub.publish", {
      standard: "OCM",
      data: terminal,
    }),
    true,
  );
  assert.equal(metrics.publications.OCM, 1);
  assert.equal(metrics.publications.terminalOcmOnlyObjects, 1);

  await assert.rejects(
    dispatch("pubsub.publish", {
      standard: "OCM",
      data: makeTerminalOcmRecord({
        norad: 41003,
        trajectoryDescription: "ARBITRARY_CARTESIAN_PV",
      }),
    }),
    /finite WRMS and iteration/i,
  );
  await assert.rejects(
    dispatch("pubsub.publish", {
      standard: "OCM",
      data: makeTerminalOcmRecord({
        norad: 41004,
        stateData: [],
      }),
    }),
    /complete Cartesian-PV state metadata/i,
  );
  await assert.rejects(
    dispatch("pubsub.publish", {
      standard: "OCM",
      data: makeTerminalOcmRecord({
        norad: 41005,
        covarianceData: [1],
      }),
    }),
    /no covariance/i,
  );
  await assert.rejects(
    dispatch("pubsub.publish", {
      standard: "OCM",
      data: makeTerminalOcmRecord({
        norad: 41006,
        includeOrbitDetermination: true,
      }),
    }),
    /no orbit-determination block/i,
  );
  await assert.rejects(
    dispatch("pubsub.publish", {
      standard: "OCM",
      data: makeTerminalOcmRecord({
        norad: 41007,
        stateData: [
          6_500, 0, 0, 0, 7.5, 0,
          6_550, 0, 0, 0, 7.5, 0,
          6_600, 0, 0, 0, 7.5, 0,
        ],
      }),
    }),
    /120 km reentry interface/i,
  );
  assert.equal(metrics.publications.OCM, 1);
  assert.equal(metrics.publications.terminalOcmOnlyObjects, 1);
});

test("publication duplicate telemetry keeps a persistent nonserialized linear index", async () => {
  let historicalHashVisits = 0;
  const correlationHashes = [];
  Object.defineProperty(correlationHashes, Symbol.iterator, {
    configurable: true,
    value: function* instrumentedCorrelationIterator() {
      for (let index = 0; index < this.length; index += 1) {
        historicalHashVisits += 1;
        yield this[index];
      }
    },
  });
  const metrics = {
    publications: {
      OMM: 0,
      OCM: 0,
      OBD: 0,
      bytes: { OMM: 0, OCM: 0 },
      rmsKm: [],
      iterations: [],
      recordHashes: { OMM: [], OCM: [] },
      correlationHashes: { OMM: correlationHashes, OCM: [] },
      sources: { OMM: [], OCM: [] },
    },
  };
  const dispatch = createMeasuredDispatch({
    nodeId: "publication",
    metrics,
  });
  const publicationCount = 2_048;
  for (let index = 0; index < publicationCount; index += 1) {
    assert.equal(
      await dispatch("pubsub.publish", {
        standard: "OMM",
        data: makeOmmRecord({
          norad: 100_000 + index,
          epoch: `2026-07-23T${String(index % 24).padStart(2, "0")}:` +
            `${String(index % 60).padStart(2, "0")}:` +
            `${String(Math.floor(index / 60) % 60).padStart(2, "0")}.000000Z`,
        }),
      }),
      true,
    );
  }
  assert.ok(
    historicalHashVisits <= publicationCount * 2,
    `duplicate index reread ${historicalHashVisits} historical hashes`,
  );
  assert.equal(metrics.publications.OMM, publicationCount);
  assert.equal(
    Object.values(metrics.publications).some((value) => value instanceof Set),
    false,
    "the persistent duplicate index must not enter serialized metrics",
  );
  assert.equal(
    JSON.parse(JSON.stringify(metrics)).publications.OMM,
    publicationCount,
  );
});

test("benchmark summary rejects equal global totals with mismatched source/epoch pairs", () => {
  assert.throws(
    () =>
      summarizeBenchmark({
        startedAtMs: 1,
        finishedAtMs: 2,
        publications: {
          OMM: 1,
          OCM: 1,
          OBD: 0,
          correlationHashes: {
            OMM: ["a".repeat(64)],
            OCM: ["b".repeat(64)],
          },
        },
      }),
    /source\/epoch.*pair/i,
  );
});

test("worker child instantiation binds parent dependencies and gives Starlink the bounded large-response channel", async () => {
  const childBytes = Uint8Array.of(7, 8, 9);
  const childHash = sha256(childBytes);
  const harnessOptions = [];
  let receivedHandlers;
  const parent = {
    dependencyCount: 1,
    nodeCount: 1,
    getDependencyDescriptor() {
      return {
        pluginId: "org.sdn.test.starlink",
        dependencyId: "org.sdn.test.starlink",
        sha256: childHash,
      };
    },
    getNodeDispatchDescriptor() {
      return {
        nodeId: "provider-starlink",
        pluginId: "org.sdn.test.starlink",
        dispatchModel: "isomorphic",
      };
    },
    async drain(handlers) {
      receivedHandlers = handlers;
      return { iterations: 0, nodesInvoked: 0, handlersSkipped: 0 };
    },
  };
  const runtime = await instantiateWorkerChildren(
    {
      outerBytes: MINIMAL_WASM,
      trustedPublicKeys: ["ab".repeat(32)],
      children: [
        {
          nodeId: "provider-starlink",
          pluginId: "org.sdn.test.starlink",
          sha256: childHash,
          wasmBytes: childBytes,
        },
      ],
    },
    {
      createParentHost: async () => parent,
      createWorkerHarness: async (options) => {
        harnessOptions.push(options);
        return {
          async invoke() {
            return {
              statusCode: 0,
              yielded: false,
              backlogRemaining: 0,
              outputs: [],
            };
          },
          async destroy() {},
        };
      },
      dispatchFactory: () => async () => null,
    },
  );
  await runtime.drain();

  assert.equal(harnessOptions.length, 1);
  assert.strictEqual(harnessOptions[0].wasmSource, childBytes);
  assert.equal(harnessOptions[0].maxHostcallResponseBytes, 72 * 1024 * 1024);
  assert.equal(harnessOptions[0].hostcallTimeoutMs, 650_000);
  assert.deepEqual(harnessOptions[0].harnessOptions.verifySignature, {
    trustedPublicKeys: ["ab".repeat(32)],
    requireSignature: true,
  });
  assert.equal(typeof receivedHandlers["org.sdn.test.starlink"], "function");
  await runtime.destroy();
});

test("worker child runtime surfaces a child failure even when the parent drain loop converts it to status", async () => {
  const childBytes = Uint8Array.of(1, 3, 5);
  const childHash = sha256(childBytes);
  const parent = {
    dependencyCount: 1,
    nodeCount: 1,
    getDependencyDescriptor() {
      return {
        pluginId: "org.sdn.test.starlink",
        dependencyId: "org.sdn.test.starlink",
        sha256: childHash,
      };
    },
    getNodeDispatchDescriptor() {
      return {
        nodeId: "provider-starlink",
        pluginId: "org.sdn.test.starlink",
        dispatchModel: "isomorphic",
      };
    },
    async drain(handlers) {
      try {
        await handlers["org.sdn.test.starlink"]({
          nodeId: "provider-starlink",
          pluginId: "org.sdn.test.starlink",
          methodId: "emit",
          frames: [],
        });
      } catch {
        // The real parent flow host converts handler exceptions to status -1.
      }
      return { iterations: 1, nodesInvoked: 1, handlersSkipped: 0 };
    },
  };
  const runtime = await instantiateWorkerChildren(
    {
      outerBytes: MINIMAL_WASM,
      trustedPublicKeys: ["cd".repeat(32)],
      children: [
        {
          nodeId: "provider-starlink",
          pluginId: "org.sdn.test.starlink",
          sha256: childHash,
          wasmBytes: childBytes,
        },
      ],
    },
    {
      createParentHost: async () => parent,
      createWorkerHarness: async () => ({
        async invoke() {
          throw new Error("fixture child failed");
        },
        async destroy() {},
      }),
      dispatchFactory: () => async () => null,
    },
  );
  await assert.rejects(runtime.drain(), /fixture child failed/);
  await runtime.destroy();
});

test("worker child invocation has a real Promise deadline", async () => {
  const childBytes = Uint8Array.of(2, 4, 6);
  const childHash = sha256(childBytes);
  let destroyed = false;
  let invokeSignal;
  const parent = {
    dependencyCount: 1,
    nodeCount: 1,
    getDependencyDescriptor() {
      return {
        pluginId: "org.sdn.test.starlink",
        dependencyId: "org.sdn.test.starlink",
        sha256: childHash,
      };
    },
    getNodeDispatchDescriptor() {
      return {
        nodeId: "provider-starlink",
        pluginId: "org.sdn.test.starlink",
        dispatchModel: "isomorphic",
      };
    },
    async drain(handlers) {
      await handlers["org.sdn.test.starlink"]({
        nodeId: "provider-starlink",
        pluginId: "org.sdn.test.starlink",
        methodId: "emit",
        frames: [],
      });
      return { iterations: 1, nodesInvoked: 1, handlersSkipped: 0 };
    },
  };
  const runtime = await instantiateWorkerChildren(
    {
      outerBytes: MINIMAL_WASM,
      trustedPublicKeys: ["cd".repeat(32)],
      children: [
        {
          nodeId: "provider-starlink",
          pluginId: "org.sdn.test.starlink",
          sha256: childHash,
          wasmBytes: childBytes,
        },
      ],
    },
    {
      invocationTimeoutMs: 20,
      createParentHost: async () => parent,
      createWorkerHarness: async () => ({
        async invoke(request) {
          invokeSignal = request.signal;
          return new Promise(() => {});
        },
        async destroy() {
          destroyed = true;
        },
      }),
      dispatchFactory: () => async () => null,
    },
  );
  await assert.rejects(
    Promise.race([
      runtime.drain(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("test guard expired before child deadline")),
          150,
        ),
      ),
    ]),
    /provider-starlink.*deadline/i,
  );
  assert.equal(invokeSignal?.aborted, true);
  assert.equal(destroyed, true);
  await runtime.destroy();
});

test("worker child invocation bounds a hung timeout destroy", async () => {
  const childBytes = Uint8Array.of(2, 4, 7);
  const childHash = sha256(childBytes);
  let destroyCalled = false;
  let invokeSignal;
  const parent = {
    dependencyCount: 1,
    nodeCount: 1,
    getDependencyDescriptor() {
      return {
        pluginId: "org.sdn.test.starlink",
        dependencyId: "org.sdn.test.starlink",
        sha256: childHash,
      };
    },
    getNodeDispatchDescriptor() {
      return {
        nodeId: "provider-starlink",
        pluginId: "org.sdn.test.starlink",
        dispatchModel: "isomorphic",
      };
    },
    async drain(handlers) {
      await handlers["org.sdn.test.starlink"]({
        nodeId: "provider-starlink",
        pluginId: "org.sdn.test.starlink",
        methodId: "emit",
        frames: [],
      });
      return { iterations: 1, nodesInvoked: 1, handlersSkipped: 0 };
    },
  };
  const runtime = await instantiateWorkerChildren(
    {
      outerBytes: MINIMAL_WASM,
      trustedPublicKeys: ["cd".repeat(32)],
      children: [
        {
          nodeId: "provider-starlink",
          pluginId: "org.sdn.test.starlink",
          sha256: childHash,
          wasmBytes: childBytes,
        },
      ],
    },
    {
      invocationTimeoutMs: 10,
      createParentHost: async () => parent,
      createWorkerHarness: async () => ({
        async invoke(request) {
          invokeSignal = request.signal;
          return new Promise(() => {});
        },
        async destroy() {
          destroyCalled = true;
          return new Promise(() => {});
        },
      }),
      dispatchFactory: () => async () => null,
    },
  );

  await assert.rejects(
    Promise.race([
      runtime.drain(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("test guard expired before bounded teardown")),
          200,
        ),
      ),
    ]),
    /provider-starlink.*deadline.*cleanup|cleanup.*provider-starlink.*deadline/i,
  );
  assert.equal(invokeSignal?.aborted, true);
  assert.equal(destroyCalled, true);
});

test("worker child runtime surfaces destroy failures", async () => {
  const childBytes = Uint8Array.of(7, 8, 9);
  const childHash = sha256(childBytes);
  const parent = {
    dependencyCount: 1,
    nodeCount: 1,
    getDependencyDescriptor() {
      return {
        pluginId: "org.sdn.test.destroy",
        dependencyId: "org.sdn.test.destroy",
        sha256: childHash,
      };
    },
    getNodeDispatchDescriptor() {
      return {
        nodeId: "provider-starlink",
        pluginId: "org.sdn.test.destroy",
        dispatchModel: "isomorphic",
      };
    },
  };
  const runtime = await instantiateWorkerChildren(
    {
      outerBytes: MINIMAL_WASM,
      trustedPublicKeys: ["cd".repeat(32)],
      children: [
        {
          nodeId: "provider-starlink",
          pluginId: "org.sdn.test.destroy",
          sha256: childHash,
          wasmBytes: childBytes,
        },
      ],
    },
    {
      createParentHost: async () => parent,
      createWorkerHarness: async () => ({
        async invoke() {
          return {
            statusCode: 0,
            outputs: [],
          };
        },
        async destroy() {
          throw new Error("fixture destroy failed");
        },
      }),
      dispatchFactory: () => async () => null,
    },
  );

  await assert.rejects(runtime.destroy(), /fixture destroy failed/);
});

test("Linux process sampler parses CPU, RSS, HWM, thread, and I/O counters without scanning data", async (t) => {
  const procRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-proc-"),
  );
  t.after(() => fs.rmSync(procRoot, { recursive: true, force: true }));
  const processDirectory = path.join(procRoot, "321");
  fs.mkdirSync(processDirectory);
  fs.writeFileSync(
    path.join(processDirectory, "stat"),
    "321 (signed flow worker) R 1 2 3 4 5 6 7 8 9 10 111 222 13 14 15\n",
  );
  fs.writeFileSync(
    path.join(processDirectory, "status"),
    "Name:\tsigned-flow\nVmRSS:\t100 kB\nVmHWM:\t250 kB\nThreads:\t4\n",
  );
  fs.writeFileSync(
    path.join(processDirectory, "io"),
    "rchar: 1000\nwchar: 2000\nread_bytes: 3000\nwrite_bytes: 4000\n",
  );

  const sample = await sampleLinuxProcess({ pid: 321, procRoot });
  assert.equal(sample.cpuUserTicks, 111);
  assert.equal(sample.cpuSystemTicks, 222);
  assert.equal(sample.rssBytes, 100 * 1024);
  assert.equal(sample.highWaterRssBytes, 250 * 1024);
  assert.equal(sample.threads, 4);
  assert.equal(sample.io.readBytes, 3000);
  assert.equal(sample.io.writeBytes, 4000);
});

test("DSS observation and benchmark summaries expose completion, quality, and telemetry limits", async () => {
  const status = decodeDssRoutePayload(makeDssRoute());
  assert.equal(status.syncedRows, 3n);
  assert.equal(status.totalRows, 3n);
  assert.equal(status.missingRows, 0n);
  assert.equal(status.cachedBytes, 0n);

  assert.deepEqual(
    parseOdQualityText({
      residuals: "WRMS=0.125 km; observations=481",
      convergenceCriteria: "relative=1e-9; iterations=17; converged=true",
    }),
    { rmsKm: 0.125, iterations: 17, converged: true },
  );
  assert.equal(
    parseOdQualityText({
      residuals: "WRMS=0.125 km",
      convergenceCriteria: "iterations=17; converged=false",
    }).converged,
    false,
  );
  assert.equal(
    parseOdQualityText({
      residuals: "WRMS=0.125 km",
      convergenceCriteria: "iterations=17",
    }).converged,
    null,
  );
  assert.equal(
    parseOdQualityText({
      residuals: "WRMS=0.125 km",
      convergenceCriteria:
        "iterations=17; converged=true; converged=false",
    }).converged,
    null,
  );
  const summary = summarizeBenchmark({
    startedAtMs: 1_000,
    finishedAtMs: 11_000,
    starlink: {
      syncedRows: 3n,
      totalRows: 3n,
      missingRows: 0n,
      downloadedBytes: 600n,
    },
    publications: {
      OMM: 6,
      OCM: 6,
      OBD: 0,
      rmsKm: [0.1, 0.2],
      iterations: [10, 20],
    },
    resources: [
      { rssBytes: 100, cpuUserMicros: 10, cpuSystemMicros: 5 },
      { rssBytes: 200, cpuUserMicros: 40, cpuSystemMicros: 15 },
    ],
    telemetryLimitations: ["fixture limitation"],
  });
  assert.equal(summary.elapsedSeconds, 10);
  assert.equal(summary.starlink.filesPerSecond, 0.3);
  assert.equal(summary.starlink.bytesPerSecond, 60);
  assert.equal(summary.publications.rmsKm.max, 0.2);
  assert.equal(summary.publications.iterations.max, 20);
  assert.equal(summary.resources.maxRssBytes, 200);
  assert.equal(summary.resources.cpuUserDeltaMicros, 30);
  assert.equal(summary.resources.cpuSystemDeltaMicros, 10);
  assert.deepEqual(summary.telemetryLimitations, ["fixture limitation"]);
});

test("benchmark throughput uses observed deltas and labels resumed measurements", () => {
  const summary = summarizeBenchmark({
    mode: "observe",
    startedAtMs: 1_000,
    throughputStartedAtMs: 1_000,
    finishedAtMs: 11_000,
    runClassification: "resumed-observation",
    freshRunThroughput: false,
    starlinkBaseline: {
      syncedRows: 2n,
      downloadedBytes: 400n,
    },
    starlink: {
      syncedRows: 5n,
      totalRows: 5n,
      missingRows: 0n,
      downloadedBytes: 1_000n,
    },
  });

  assert.equal(summary.starlink.observedSyncedRows, 3);
  assert.equal(summary.starlink.observedDownloadedBytes, 600);
  assert.equal(summary.starlink.filesPerSecond, 0.3);
  assert.equal(summary.starlink.bytesPerSecond, 60);
  assert.equal(summary.starlink.runClassification, "resumed-observation");
  assert.equal(summary.starlink.freshRunThroughput, false);
});

test("local benchmark rejects a nonempty state directory even when resume is requested", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-resume-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "existing.bin"), "state");
  const verifiedFlow = {
    outerSha256: "a".repeat(64),
    portableWasmSha256: "b".repeat(64),
    verification: { publicKeyHex: "c".repeat(64) },
    trustedPublicKeys: ["c".repeat(64)],
    children: [],
    outerBytes: MINIMAL_WASM,
    tree: {},
  };

  for (const allowResume of [false, true]) {
    await assert.rejects(
      runLocalExactFlow({
        verifiedFlow,
        stateDir: directory,
        allowResume,
        createParentHost: async () => {
          throw new Error("runtime must not instantiate for resumed state");
        },
      }),
      /nonempty.*fresh-only|fresh-only.*nonempty/i,
    );
  }
});

test("runLocalExactFlow enforces bootstrap and work-drain Promise deadlines", async (t) => {
  for (const [label, factory, expected] of [
    [
      "bootstrap",
      makeFakeLocalRuntimeFactory({ hangBootstrap: true }),
      /bootstrap.*deadline/i,
    ],
    [
      "work",
      makeFakeLocalRuntimeFactory({ hangWorkDrain: true }),
      /flow drain.*deadline/i,
    ],
  ]) {
    await t.test(label, async (child) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), `supplemental-omm-${label}-deadline-`),
      );
      child.after(() =>
        fs.rmSync(directory, { recursive: true, force: true }),
      );
      let destroyed = false;
      await assert.rejects(
        Promise.race([
          runLocalExactFlow({
            verifiedFlow: makeVerifiedLocalFlow(),
            stateDir: directory,
            timeoutMs: 25,
            instantiateRuntime: async (...args) => {
              const runtime = await factory(...args);
              const originalDestroy = runtime.destroy;
              runtime.destroy = async () => {
                destroyed = true;
                await originalDestroy();
              };
              return runtime;
            },
          }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("test guard expired before local deadline")),
              200,
            ),
          ),
        ]),
        expected,
      );
      assert.equal(destroyed, true);
    });
  }
});

test("runLocalExactFlow aborts and destroys a runtime that initializes after its deadline", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-late-init-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let initializationSignal;
  let destroyed = false;

  await assert.rejects(
    runLocalExactFlow({
      verifiedFlow: makeVerifiedLocalFlow(),
      stateDir: directory,
      timeoutMs: 15,
      instantiateRuntime: async (_loaded, options) => {
        initializationSignal = options.signal;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          parent: {
            enqueueTrigger() {},
          },
          async destroy() {
            destroyed = true;
          },
        };
      },
    }),
    /runtime initialization.*deadline/i,
  );

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(initializationSignal?.aborted, true);
  assert.equal(destroyed, true);
});

test("runLocalExactFlow surfaces a late runtime initialization destroy failure", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-late-init-destroy-failure-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let destroyed = false;

  await assert.rejects(
    runLocalExactFlow({
      verifiedFlow: makeVerifiedLocalFlow(),
      stateDir: directory,
      timeoutMs: 15,
      instantiateRuntime: async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return {
          parent: {
            enqueueTrigger() {},
          },
          async destroy() {
            destroyed = true;
            throw new Error("fixture late runtime destroy failed");
          },
        };
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(
        error.errors.some((candidate) =>
          /fixture late runtime destroy failed/i.test(candidate?.message ?? ""),
        ),
      );
      return true;
    },
  );
  assert.equal(destroyed, true);
});

test("runLocalExactFlow propagates run abort to an in-flight measured HTTP request", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-http-abort-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let requestSignal;
  let destroyed = false;
  const fetchImpl = async (_url, options) => {
    requestSignal = options.signal;
    return new Promise((_, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });
  };

  await assert.rejects(
    runLocalExactFlow({
      verifiedFlow: makeVerifiedLocalFlow(),
      stateDir: directory,
      timeoutMs: 30,
      fetchImpl,
      instantiateRuntime: async (_loaded, { dispatchFactory }) => {
        let drains = 0;
        return {
          parent: {
            enqueueTrigger() {},
          },
          async drain() {
            drains += 1;
            if (drains === 1) {
              return { iterations: 1, nodesInvoked: 1, handlersSkipped: 0 };
            }
            const dispatch = dispatchFactory({ nodeId: "provider-starlink" });
            await dispatch("http.request", {
              url: "https://fixture.invalid/starlink.txt",
              max_bytes: 1024,
            });
            return { iterations: 1, nodesInvoked: 1, handlersSkipped: 0 };
          },
          async destroy() {
            destroyed = true;
          },
        };
      },
    }),
    /flow drain.*deadline/i,
  );

  assert.equal(requestSignal?.aborted, true);
  assert.equal(destroyed, true);
});

test("runLocalExactFlow surfaces drain errors and still destroys the runtime", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-local-error-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let destroyed = false;
  await assert.rejects(
    runLocalExactFlow({
      verifiedFlow: makeVerifiedLocalFlow(),
      stateDir: directory,
      instantiateRuntime: makeFakeLocalRuntimeFactory({
        bootstrapError: new Error("fixture parent drain failed"),
        onDestroy() {
          destroyed = true;
        },
      }),
    }),
    /fixture parent drain failed/,
  );
  assert.equal(destroyed, true);
});

test("runLocalExactFlow accepts only a paired, lossless terminal state", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-local-terminal-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await runLocalExactFlow({
    verifiedFlow: makeVerifiedLocalFlow(),
    stateDir: directory,
    instantiateRuntime: makeFakeLocalRuntimeFactory(),
    reloadFlatSql: async ({ metrics }) => exactReloadResult(metrics),
  });

  assert.equal(result.summary.publications.pairing.pairedRecords, 1);
  assert.deepEqual(result.summary.publications.starlinkSourceCoverage, {
    expectedSources: 1,
    coveredOmmSources: 1,
    coveredOcmSources: 1,
    terminalOcmOnlySources: 0,
    sourceIdentityDigest: sha256(
      new TextEncoder().encode("norad:41001"),
    ),
  });
  assert.equal(result.summary.flow.queuesEmpty, true);
  assert.equal(result.summary.flatsqlReload.verified, true);
});

test("runLocalExactFlow accepts a mixed paired fit and validated terminal OCM-only product", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-local-mixed-terminal-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await runLocalExactFlow({
    verifiedFlow: makeVerifiedLocalFlow(),
    stateDir: directory,
    instantiateRuntime: makeFakeLocalRuntimeFactory({
      publicationRecords: [
        { standard: "OMM", data: makeOmmRecord() },
        { standard: "OCM", data: makeOcmRecord() },
        { standard: "OCM", data: makeTerminalOcmRecord() },
      ],
      progress: makeDssRoute({
        syncedRows: 2n,
        totalRows: 2n,
      }),
      starlinkOemOutputs: [
        makeStarlinkOemEnvelope({
          requestId: 1n,
          norad: 41001,
        }),
        makeStarlinkOemEnvelope({
          requestId: 2n,
          norad: 41002,
          objectName: "STARLINK-TERMINAL",
        }),
      ],
    }),
    reloadFlatSql: async ({ metrics }) => exactReloadResult(metrics),
  });

  assert.equal(result.summary.publications.OMM, 1);
  assert.equal(result.summary.publications.OCM, 2);
  assert.equal(result.summary.publications.terminalOcmOnlyObjects, 1);
  assert.equal(result.summary.publications.pairing.pairedRecords, 1);
  assert.equal(
    result.summary.publications.pairing.terminalOcmOnlyObjects,
    1,
  );
  assert.equal(result.summary.publications.pairing.totalOcmRecords, 2);
  assert.equal(result.summary.publications.pairing.uniqueSources, 2);
  assert.match(
    result.summary.publications.pairing.correlationDigest,
    /^[0-9a-f]{64}$/u,
  );
  assert.deepEqual(result.summary.publications.starlinkSourceCoverage, {
    expectedSources: 2,
    coveredOmmSources: 1,
    coveredOcmSources: 2,
    terminalOcmOnlySources: 1,
    sourceIdentityDigest: sha256(
      new TextEncoder().encode("norad:41001\nnorad:41002"),
    ),
  });
  assert.deepEqual(result.summary.flatsqlReload.recordCounts, {
    OMM: 1,
    OCM: 2,
  });
});

test("runLocalExactFlow rejects terminal totals without every provider-derived source", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-local-source-coverage-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    runLocalExactFlow({
      verifiedFlow: makeVerifiedLocalFlow(),
      stateDir: directory,
      instantiateRuntime: makeFakeLocalRuntimeFactory({
        progress: makeDssRoute({
          syncedRows: 2n,
          totalRows: 2n,
        }),
        starlinkOemOutputs: [
          makeStarlinkOemEnvelope({
            requestId: 1n,
            norad: 41001,
          }),
          makeStarlinkOemEnvelope({
            requestId: 2n,
            norad: 41002,
            objectName: "STARLINK-MISSING",
          }),
        ],
      }),
      reloadFlatSql: async ({ metrics }) => exactReloadResult(metrics),
    }),
    /Starlink.*source.*coverage|source.*coverage.*Starlink/i,
  );
});

test("runLocalExactFlow rejects an error DSS even when counters look complete", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-local-dss-error-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    runLocalExactFlow({
      verifiedFlow: makeVerifiedLocalFlow(),
      stateDir: directory,
      instantiateRuntime: makeFakeLocalRuntimeFactory({
        progress: makeDssRoute({
          status: 4,
          error: "fixture local provider failed",
        }),
      }),
      reloadFlatSql: async ({ metrics }) => exactReloadResult(metrics),
    }),
    /fixture local provider failed/,
  );
});

test("runLocalExactFlow rejects a nonempty terminal queue", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-local-queue-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    runLocalExactFlow({
      verifiedFlow: makeVerifiedLocalFlow(),
      stateDir: directory,
      instantiateRuntime: makeFakeLocalRuntimeFactory({ queueEmpty: false }),
      reloadFlatSql: async ({ metrics }) => exactReloadResult(metrics),
    }),
    /did not drain losslessly/i,
  );
});

test("runLocalExactFlow rejects same-count reload corruption and a hung reload", async (t) => {
  await t.test("same-count corruption", async (child) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "supplemental-omm-local-reload-corrupt-"),
    );
    child.after(() =>
      fs.rmSync(directory, { recursive: true, force: true }),
    );
    await assert.rejects(
      runLocalExactFlow({
        verifiedFlow: makeVerifiedLocalFlow(),
        stateDir: directory,
        instantiateRuntime: makeFakeLocalRuntimeFactory(),
        reloadFlatSql: async ({ metrics }) =>
          exactReloadResult(metrics, {
            recordHashes: {
              OMM: ["0".repeat(64)],
              OCM: [...metrics.publications.recordHashes.OCM],
            },
          }),
      }),
      /reload.*content parity/i,
    );
  });

  await t.test("hung reload", async (child) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "supplemental-omm-local-reload-hang-"),
    );
    child.after(() =>
      fs.rmSync(directory, { recursive: true, force: true }),
    );
    await assert.rejects(
      Promise.race([
        runLocalExactFlow({
          verifiedFlow: makeVerifiedLocalFlow(),
          stateDir: directory,
          timeoutMs: 50,
          instantiateRuntime: makeFakeLocalRuntimeFactory(),
          reloadFlatSql: async () => new Promise(() => {}),
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("test guard expired before reload deadline")),
            250,
          ),
        ),
      ]),
      /reload.*deadline/i,
    );
  });
});

test("runLocalExactFlow rejects per-source OMM/OCM mispairing", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-local-mispair-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    runLocalExactFlow({
      verifiedFlow: makeVerifiedLocalFlow(),
      stateDir: directory,
      instantiateRuntime: makeFakeLocalRuntimeFactory({
        ocm: makeOcmRecord({ norad: 49999 }),
      }),
      reloadFlatSql: async ({ metrics }) => exactReloadResult(metrics),
    }),
    /source\/epoch pairing/i,
  );
});

test("runLocalExactFlow rejects an ordinary OCM without its paired OMM", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-local-missing-omm-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    runLocalExactFlow({
      verifiedFlow: makeVerifiedLocalFlow(),
      stateDir: directory,
      instantiateRuntime: makeFakeLocalRuntimeFactory({
        publicationRecords: [
          { standard: "OCM", data: makeOcmRecord() },
        ],
      }),
      reloadFlatSql: async ({ metrics }) => exactReloadResult(metrics),
    }),
    /one OCM per paired OMM/i,
  );
});

test("FlatSQL milestone classification counts durable appends, not bootstrap configuration", () => {
  assert.equal(
    isFlatSqlAppendCompletePayload(makeFlatSqlStatus()),
    true,
  );
  assert.equal(
    isFlatSqlAppendCompletePayload(
      makeFlatSqlStatus({
        operation: flatSqlNodeOperation.CONFIGURE_INDEX,
      }),
    ),
    false,
  );
  assert.equal(
    isFlatSqlAppendCompletePayload(
      makeFlatSqlStatus({
        status: flatSqlNodeStatus.INTERNAL_ERROR,
      }),
    ),
    false,
  );
});

test("FlatSQL reload parity uses bounded pages and exact record hashes", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-reload-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = {
    OMM: [0, 6, 12, 18].map((hour) =>
      makeOmmRecord({
        epoch: `2026-07-23T${String(hour).padStart(2, "0")}:00:00.000000Z`,
      }),
    ),
    OCM: [0, 6, 12, 18].map((hour) =>
      makeOcmRecord({
        epoch: `2026-07-23T${String(hour).padStart(2, "0")}:00:00.000000Z`,
      }),
    ).concat(makeTerminalOcmRecord()),
  };
  const queries = [];
  const createWorkerHarness = async () => ({
    async invoke({ methodId, inputs }) {
      if (methodId === "configure_index") {
        return {
          statusCode: 0,
          outputs: [
            {
              portId: "status",
              payload: makeFlatSqlStatus({
                operation: flatSqlNodeOperation.CONFIGURE_INDEX,
              }),
            },
          ],
        };
      }
      assert.equal(methodId, "query_records");
      const request = FSO.getRootAsFSO(
        new ByteBuffer(new Uint8Array(inputs[0].payload)),
      );
      const query = new TextDecoder().decode(request.queryArray());
      queries.push(query);
      const match = query.match(
        /^SELECT _data FROM (OMM|OCM) ORDER BY rowid LIMIT (\d+) OFFSET (\d+)$/u,
      );
      assert.ok(match, `query is not bounded and deterministic: ${query}`);
      const [, standard, limitText, offsetText] = match;
      const page = records[standard].slice(
        Number(offsetText),
        Number(offsetText) + Number(limitText),
      );
      return {
        statusCode: 0,
        outputs: [
          {
            portId: "status",
            payload: makeFlatSqlStatus({
              operation: flatSqlNodeOperation.QUERY_RECORDS,
              requestId: request.REQUEST_ID(),
              affectedRecords: BigInt(page.length),
            }),
          },
          {
            portId: "records",
            payload: makeFlatSqlQueryRecords({
              records: page,
              requestId: request.REQUEST_ID(),
            }),
          },
        ],
      };
    },
    async destroy() {},
  });
  const metrics = {
    publications: {
      OMM: records.OMM.length,
      OCM: records.OCM.length,
      terminalOcmOnlyObjects: 1,
      recordHashes: {
        OMM: records.OMM.map(sha256),
        OCM: records.OCM.map(sha256),
      },
    },
  };
  const result = await reloadAndQueryFlatSql({
    verifiedFlow: {
      trustedPublicKeys: ["a".repeat(64)],
      children: [
        {
          nodeId: "store",
          sha256: "b".repeat(64),
          wasmBytes: MINIMAL_WASM,
        },
      ],
    },
    opaqueAdapter: createFileBackedOpaqueAdapter({ stateDir: directory }),
    metrics,
    capturedControl: {
      portId: "control",
      typeRef: {},
      payload: makeFlatSqlConfigure(),
    },
    createWorkerHarness,
    pageSize: 2,
    timeoutMs: 1_000,
  });

  assert.deepEqual(result.recordCounts, { OMM: 4, OCM: 5 });
  assert.deepEqual(result.productCounts, {
    OMM: 4,
    OCM: 5,
    terminalOcmOnlyObjects: 1,
  });
  assert.deepEqual(result.recordHashes, metrics.publications.recordHashes);
  assert.deepEqual(queries, [
    "SELECT _data FROM OMM ORDER BY rowid LIMIT 2 OFFSET 0",
    "SELECT _data FROM OMM ORDER BY rowid LIMIT 2 OFFSET 2",
    "SELECT _data FROM OMM ORDER BY rowid LIMIT 2 OFFSET 4",
    "SELECT _data FROM OCM ORDER BY rowid LIMIT 2 OFFSET 0",
    "SELECT _data FROM OCM ORDER BY rowid LIMIT 2 OFFSET 2",
    "SELECT _data FROM OCM ORDER BY rowid LIMIT 2 OFFSET 4",
  ]);
});

test("FlatSQL reload aborts and destroys a worker created after its deadline", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-reload-late-worker-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let creationSignal;
  let destroyed = false;

  await assert.rejects(
    reloadAndQueryFlatSql({
      verifiedFlow: {
        trustedPublicKeys: ["a".repeat(64)],
        children: [
          {
            nodeId: "store",
            sha256: "b".repeat(64),
            wasmBytes: MINIMAL_WASM,
          },
        ],
      },
      opaqueAdapter: createFileBackedOpaqueAdapter({ stateDir: directory }),
      metrics: {
        publications: {
          OMM: 1,
          OCM: 1,
          recordHashes: {
            OMM: ["c".repeat(64)],
            OCM: ["d".repeat(64)],
          },
        },
      },
      capturedControl: {
        portId: "control",
        typeRef: {},
        payload: Uint8Array.of(1),
      },
      createWorkerHarness: async (options) => {
        creationSignal = options.signal;
        await new Promise((resolve) => setTimeout(resolve, 35));
        return {
          async invoke() {
            throw new Error("late worker must not be invoked");
          },
          async destroy() {
            destroyed = true;
          },
        };
      },
      timeoutMs: 10,
      invokeTimeoutMs: 10,
    }),
    /worker creation.*deadline/i,
  );

  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.equal(creationSignal?.aborted, true);
  assert.equal(destroyed, true);
});

test("FlatSQL reload surfaces a late worker initialization destroy failure", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-reload-late-destroy-failure-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let destroyed = false;

  await assert.rejects(
    reloadAndQueryFlatSql({
      verifiedFlow: {
        trustedPublicKeys: ["a".repeat(64)],
        children: [
          {
            nodeId: "store",
            sha256: "b".repeat(64),
            wasmBytes: MINIMAL_WASM,
          },
        ],
      },
      opaqueAdapter: createFileBackedOpaqueAdapter({ stateDir: directory }),
      metrics: {
        publications: {
          OMM: 1,
          OCM: 1,
          recordHashes: {
            OMM: ["c".repeat(64)],
            OCM: ["d".repeat(64)],
          },
        },
      },
      capturedControl: {
        portId: "control",
        typeRef: {},
        payload: Uint8Array.of(1),
      },
      createWorkerHarness: async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return {
          async invoke() {
            throw new Error("late worker must not be invoked");
          },
          async destroy() {
            destroyed = true;
            throw new Error("fixture late FlatSQL destroy failed");
          },
        };
      },
      timeoutMs: 10,
      invokeTimeoutMs: 10,
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(
        error.errors.some((candidate) =>
          /fixture late FlatSQL destroy failed/i.test(candidate?.message ?? ""),
        ),
      );
      return true;
    },
  );
  assert.equal(destroyed, true);
});

test("FlatSQL reload rejects same-count record corruption", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-reload-corrupt-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const expected = makeOmmRecord();
  const corrupt = makeOmmRecord({ objectName: "CORRUPTED-SAME-COUNT" });
  const createWorkerHarness = async () => ({
    async invoke({ methodId, inputs }) {
      if (methodId === "configure_index") {
        return {
          statusCode: 0,
          outputs: [
            {
              portId: "status",
              payload: makeFlatSqlStatus({
                operation: flatSqlNodeOperation.CONFIGURE_INDEX,
              }),
            },
          ],
        };
      }
      const request = FSO.getRootAsFSO(
        new ByteBuffer(new Uint8Array(inputs[0].payload)),
      );
      const query = new TextDecoder().decode(request.queryArray());
      const standard = query.includes("FROM OMM") ? "OMM" : "OCM";
      const record = standard === "OMM" ? corrupt : makeOcmRecord();
      return {
        statusCode: 0,
        outputs: [
          {
            portId: "status",
            payload: makeFlatSqlStatus({
              operation: flatSqlNodeOperation.QUERY_RECORDS,
              requestId: request.REQUEST_ID(),
              affectedRecords: 1n,
            }),
          },
          {
            portId: "records",
            payload: makeFlatSqlQueryRecords({
              records: [record],
              requestId: request.REQUEST_ID(),
              standard,
            }),
          },
        ],
      };
    },
    async destroy() {},
  });

  await assert.rejects(
    reloadAndQueryFlatSql({
      verifiedFlow: {
        trustedPublicKeys: ["a".repeat(64)],
        children: [
          {
            nodeId: "store",
            sha256: "b".repeat(64),
            wasmBytes: MINIMAL_WASM,
          },
        ],
      },
      opaqueAdapter: createFileBackedOpaqueAdapter({ stateDir: directory }),
      metrics: {
        publications: {
          OMM: 1,
          OCM: 1,
          recordHashes: {
            OMM: [sha256(expected)],
            OCM: [sha256(makeOcmRecord())],
          },
        },
      },
      capturedControl: {
        portId: "control",
        typeRef: {},
        payload: makeFlatSqlConfigure(),
      },
      createWorkerHarness,
      pageSize: 2,
      timeoutMs: 1_000,
    }),
    /OMM.*content parity/i,
  );
});

test("observe mode polls only portable-hash DSS routes and reports remote telemetry gaps", async () => {
  const urls = [];
  let polls = 0;
  const verifiedFlow = {
    outerSha256: "a".repeat(64),
    portableWasmSha256: "b".repeat(64),
    artifact: {
      runtimeNodeRoutes: [
        {
          key: "provider-starlink.dss",
          nodeId: "status",
          portId: "provider-starlink.dss",
        },
      ],
    },
  };
  const result = await observeSdnRuntime({
    verifiedFlow,
    baseUrl: "https://sdn.fixture.invalid/",
    pollMs: 0,
    maxPolls: 2,
    fetchImpl: async (url) => {
      urls.push(url);
      polls += 1;
      return new Response(
        polls === 1
          ? makeDssRoute({
              syncedRows: 0n,
              totalRows: 3n,
              downloadedBytes: 0n,
            })
          : makeDssRoute(),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(urls, [
    `https://sdn.fixture.invalid/sdn/v1/artifacts/${verifiedFlow.portableWasmSha256}/runtime/nodes/provider-starlink.dss`,
    `https://sdn.fixture.invalid/sdn/v1/artifacts/${verifiedFlow.portableWasmSha256}/runtime/nodes/provider-starlink.dss`,
  ]);
  assert.equal(result.statuses["provider-starlink.dss"].syncedRows, 3n);
  assert.equal(result.summary.starlink.syncedRows, 3);
  assert.equal(result.summary.mode, "observe");
  assert.equal(result.accepted, false);
  assert.deepEqual(result.remoteEvidence, {
    scope: "portable-runtime-only",
    portableWasmSha256: verifiedFlow.portableWasmSha256,
    exactSignedTreeVerified: false,
    acceptanceReason:
      "The runtime route is keyed only by portable WASM hash; no exact signed outer/child-tree attestation was available.",
  });
  assert.equal("outerSha256" in result, false);
  assert.equal(result.summary.artifact.outerSha256, undefined);
  assert.equal(
    result.summary.artifact.evidenceScope,
    "portable-runtime-only",
  );
  assert.ok(
    result.telemetryLimitations.some((value) =>
      /RMS and iteration/i.test(value),
    ),
  );
  assert.ok(
    result.telemetryLimitations.some((value) =>
      /expect-tree.*local.*not.*remote/i.test(value),
    ),
  );
  assert.equal(
    result.dataDirectoryScans,
    0,
    "observe mode must not turn /data walks into a polling hot path",
  );
});

test("observe mode fails closed on HTTP, malformed, and DSS error routes", async () => {
  const verifiedFlow = {
    outerSha256: "a".repeat(64),
    portableWasmSha256: "b".repeat(64),
    artifact: {
      runtimeNodeRoutes: [
        {
          key: "provider-starlink.dss",
          nodeId: "status",
          portId: "provider-starlink.dss",
        },
      ],
    },
  };
  const base = {
    verifiedFlow,
    baseUrl: "https://sdn.fixture.invalid/",
    pollMs: 0,
    maxPolls: 1,
  };

  await assert.rejects(
    observeSdnRuntime({
      ...base,
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    }),
    /503/,
  );
  await assert.rejects(
    observeSdnRuntime({
      ...base,
      fetchImpl: async () => new Response("not a DSS", { status: 200 }),
    }),
    /canonical \$FSB/i,
  );
  await assert.rejects(
    observeSdnRuntime({
      ...base,
      fetchImpl: async () =>
        new Response(
          makeDssRoute({
            status: 4,
            syncedRows: 0n,
            totalRows: 3n,
            downloadedBytes: 0n,
            error: "fixture provider failed",
          }),
          { status: 200 },
        ),
    }),
    /fixture provider failed/,
  );
});

test("observe mode aborts a hung route deadline and rejects nonterminal exhaustion", async () => {
  const verifiedFlow = {
    outerSha256: "a".repeat(64),
    portableWasmSha256: "b".repeat(64),
    artifact: {
      runtimeNodeRoutes: [
        {
          key: "provider-starlink.dss",
          nodeId: "status",
          portId: "provider-starlink.dss",
        },
      ],
    },
  };
  let aborted = false;
  await assert.rejects(
    observeSdnRuntime({
      verifiedFlow,
      baseUrl: "https://sdn.fixture.invalid/",
      pollMs: 0,
      maxPolls: 1,
      routeTimeoutMs: 20,
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    }),
    /deadline/i,
  );
  assert.equal(aborted, true);

  await assert.rejects(
    observeSdnRuntime({
      verifiedFlow,
      baseUrl: "https://sdn.fixture.invalid/",
      pollMs: 0,
      maxPolls: 1,
      fetchImpl: async () =>
        new Response(
          makeDssRoute({
            syncedRows: 1n,
            totalRows: 3n,
            downloadedBytes: 4n,
          }),
          { status: 200 },
        ),
      allowResume: true,
    }),
    /before.*terminal/i,
  );
});

test("observe mode rejects a mid-run baseline by default and labels explicit resume", async () => {
  const verifiedFlow = {
    outerSha256: "a".repeat(64),
    portableWasmSha256: "b".repeat(64),
    artifact: {
      runtimeNodeRoutes: [
        {
          key: "provider-starlink.dss",
          nodeId: "status",
          portId: "provider-starlink.dss",
        },
      ],
    },
  };
  const midRun = makeDssRoute({
    syncedRows: 1n,
    totalRows: 3n,
    downloadedBytes: 100n,
  });
  await assert.rejects(
    observeSdnRuntime({
      verifiedFlow,
      baseUrl: "https://sdn.fixture.invalid/",
      pollMs: 0,
      maxPolls: 1,
      fetchImpl: async () => new Response(midRun, { status: 200 }),
    }),
    /mid-run.*allow-resume/i,
  );

  let poll = 0;
  const resumed = await observeSdnRuntime({
    verifiedFlow,
    baseUrl: "https://sdn.fixture.invalid/",
    pollMs: 1,
    maxPolls: 2,
    allowResume: true,
    fetchImpl: async () => {
      poll += 1;
      return new Response(
        poll === 1
          ? midRun
          : makeDssRoute({
              syncedRows: 3n,
              totalRows: 3n,
              downloadedBytes: 300n,
            }),
        { status: 200 },
      );
    },
  });
  assert.equal(
    resumed.summary.starlink.runClassification,
    "resumed-observation",
  );
  assert.equal(resumed.summary.starlink.freshRunThroughput, false);
  assert.equal(resumed.summary.starlink.observedSyncedRows, 2);
  assert.equal(resumed.summary.starlink.observedDownloadedBytes, 200);
});

test("NDJSON output sink closes its exclusive file descriptor", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-omm-ndjson-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "benchmark.ndjson");
  const sink = createNdjsonSink(output);
  sink({ kind: "fixture", value: 1n });
  sink.close();
  sink.close();

  assert.deepEqual(
    JSON.parse(fs.readFileSync(output, "utf8").trim()),
    { kind: "fixture", value: "1" },
  );
  assert.throws(() => sink({ kind: "late-write" }), /closed/i);
});

test("benchmark CLI requires explicit resume and accepts a bounded route deadline", () => {
  const options = parseCli([
    "observe",
    "--artifact",
    "./module.wasm",
    "--trusted-key",
    "a".repeat(64),
    "--base-url",
    "https://sdn.fixture.invalid",
    "--allow-resume",
    "--route-timeout-ms",
    "1234",
  ]);
  assert.equal(options.allowResume, true);
  assert.equal(options.routeTimeoutMs, 1234);
});
