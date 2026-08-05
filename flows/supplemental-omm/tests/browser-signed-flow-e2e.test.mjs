import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseSingleFileBundle,
  verifyModuleArtifact,
} from "space-data-module-sdk";
import { createIsomorphicFlowRuntimeHost } from "space-data-module-sdk/flow";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import {
  Builder,
  ByteBuffer,
} from "../../../../spacedatastandards.org/node_modules/flatbuffers/js/flatbuffers.js";
import { DSS } from "../../../../spacedatastandards.org/lib/js/DSS/DSS.js";
import { FSB } from "../../../../spacedatastandards.org/lib/js/FSB/FSB.js";
import { FSO } from "../../../../spacedatastandards.org/lib/js/FSO/FSO.js";
import { flatSqlNodeOperation } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeOperation.js";
import { flatSqlNodeStatus } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeStatus.js";
import { PLG } from "../../../../spacedatastandards.org/lib/js/PLG/PLG.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseArtifactPath = path.join(
  packageRoot,
  "dist/isomorphic/module.wasm",
);
const starlinkArtifactPath = path.join(
  packageRoot,
  "nodes/providers/starlink/dist/isomorphic/module.wasm",
);
const trustedReleaseSigner =
  "088ac3d85932dc6946e3ff62882afb48885c2df0cd8b34f2993c5885e3424d89";

// Release locks move only when the deliberately rebuilt production-signed
// parent embeds deliberately rebuilt production-signed children.
const expectedOuterSha256 =
  "29dfc59acd816157190067d36efcee6c6a232c90880e5e66fa87b739c3ef4b0f";
const expectedChildSha256 = Object.freeze({
  timer: "ef67e56165444a164994d22f5d496d732667f1f7fcc4e22f660445547e550379",
  "provider-starlink":
    "2438dcd006c6e51540c7479ac8e1f43cc9e0c5388f4486b7300aa4d6c807c0bb",
  "provider-glonass":
    "337a5e408161f3745395aac23881bdbdabfe4b77c89f0077bd4dcb72a320375a",
  "provider-intelsat":
    "100550e29a77fb24c1c4be6026190f7ce92dc732d24ec8c3e67ca3195f12779b",
  "provider-cpf":
    "e950098721ae74e6d47be7842db848820804a5e6bc5e115ba38b9bdfd9da90ae",
  "provider-iss":
    "cfd39ab3c98511d06120c401171f38270cf591369f21a4183b367b0b26b1ece8",
  od: "3d20add1211c79012e31fa48b046ba04aa4cbd4e648637db8037793938f5796b",
  store:
    "9413cbc137efb46b63e0d7b398c5a8b5a8e91c23bd501ba2e16fb6220b8f5991",
  publication:
    "091cd16f2c0054b6445e930db749ebb92309af6c8ea3afd2796222184b67ebbe",
  status:
    "53bf69a807b84b08e3d45d0008f74d14e6c3735c32665fd3bd63f7700c4d9229",
});

const defaultUrls = Object.freeze({
  starlinkManifest:
    "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt",
  starlinkBase: "https://api.starlink.com/public-files/ephemerides/",
  glonass: "https://www.aiub.unibe.ch/download/CODE/COD0OPSULT.SP3",
  intelsatListing: "https://my.intelsat.com/ephemeris/public",
  intelsatBase: "https://my.intelsat.com/Resource/Ephemeris/",
  cpfListing:
    "https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/",
  iss:
    "https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt",
});
const fsbType = Object.freeze({
  schemaName: "FSB.fbs",
  fileIdentifier: "$FSB",
  schemaVersion: "1.158.1",
  schemaHash:
    "0b23aa63d0e3f17d828fc84dd433605c2794cb81ade7c043cb200e954c84e945",
  rootTypeName: "FSB",
});
const fsoType = Object.freeze({
  schemaName: "FSO.fbs",
  fileIdentifier: "$FSO",
  schemaVersion: "1.158.2",
  schemaHash:
    "a298ef96af29624073edf749848e8ff1e5b8f45e56966c2e210cb719f3c5e821",
  rootTypeName: "FSO",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function encode(text) {
  return new TextEncoder().encode(text);
}

function canonicalTypeRef(type) {
  return {
    ...type,
    schemaHash: [...Buffer.from(type.schemaHash, "hex")],
    wireFormat: "flatbuffer",
  };
}

function makeProviderConfigFrame(config) {
  const data = encode(JSON.stringify(config));
  const builder = new Builder(Math.max(256, data.byteLength + 256));
  const schemaName = builder.createString(
    "supplemental-omm.provider-config.v1",
  );
  const fileIdentifier = builder.createString("CONF");
  FSB.startDataVector(builder, data.byteLength);
  for (let index = data.byteLength - 1; index >= 0; index -= 1) {
    builder.addInt8(data[index]);
  }
  const dataVector = builder.endVector();
  FSB.startFSB(builder);
  FSB.addRequestId(builder, 1n);
  FSB.addKind(builder, 1);
  FSB.addFinal(builder, true);
  FSB.addTotalBytes(builder, BigInt(data.byteLength));
  FSB.addRecordCount(builder, 1n);
  FSB.addSchemaName(builder, schemaName);
  FSB.addFileIdentifier(builder, fileIdentifier);
  FSB.addData(builder, dataVector);
  const root = FSB.endFSB(builder);
  FSB.finishFSBBuffer(builder, root);
  return {
    portId: "config",
    wireFormat: "flatbuffer",
    typeRef: canonicalTypeRef(fsbType),
    payload: builder.asUint8Array(),
  };
}

function makeFlatSqlStatusFrame(
  requestId,
  status = flatSqlNodeStatus.COMPLETE,
) {
  const builder = new Builder(256);
  FSO.startFSO(builder);
  FSO.addOperation(builder, flatSqlNodeOperation.APPEND_RECORDS);
  FSO.addRequestId(builder, BigInt(requestId));
  FSO.addStatus(builder, status);
  const root = FSO.endFSO(builder);
  FSO.finishFSOBuffer(builder, root);
  return {
    portId: "ack",
    wireFormat: "flatbuffer",
    typeRef: canonicalTypeRef(fsoType),
    payload: builder.asUint8Array(),
  };
}

function decodeProviderFsb(payload) {
  const envelope = FSB.getRootAsFSB(
    new ByteBuffer(new Uint8Array(payload)),
  );
  return {
    requestId: envelope.REQUEST_ID(),
    schemaName: envelope.SCHEMA_NAME() ?? "",
    fileIdentifier: envelope.FILE_IDENTIFIER() ?? "",
    sequence: envelope.CHUNK_SEQUENCE(),
    final: envelope.FINAL(),
    recordCount: envelope.RECORD_COUNT(),
    data: new Uint8Array(envelope.dataArray() ?? []),
  };
}

function decodeFlatSqlStatus(output) {
  assert.equal(
    output.wireFormat ?? output.typeRef?.wireFormat,
    "flatbuffer",
    "separate signed child instances must route FSO through canonical fallback",
  );
  const value = FSO.getRootAsFSO(
    new ByteBuffer(new Uint8Array(output.payload)),
  );
  const decode = (candidate) =>
    typeof candidate === "string"
      ? candidate
      : new TextDecoder().decode(candidate ?? new Uint8Array());
  return {
    operation: value.OPERATION(),
    requestId: value.REQUEST_ID(),
    status: value.STATUS(),
    affectedRecords: value.AFFECTED_RECORDS(),
    resultBytes: value.RESULT_BYTES(),
    errorCode: decode(value.ERROR_CODE()),
    message: new TextDecoder().decode(value.messageArray() ?? new Uint8Array()),
  };
}

function decodeDssRoute(output) {
  let dssBytes;
  let attempts;
  if (output.wireFormat === "aligned-binary") {
    const payload = new Uint8Array(output.payload);
    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    attempts = view.getBigUint64(8, true);
    const length = view.getUint32(124, true);
    dssBytes = payload.subarray(128, 128 + length);
  } else {
    const envelope = FSB.getRootAsFSB(
      new ByteBuffer(new Uint8Array(output.payload)),
    );
    attempts = envelope.REQUEST_ID();
    dssBytes = new Uint8Array(envelope.dataArray() ?? []);
  }
  assert.equal(new TextDecoder().decode(dssBytes.subarray(8, 12)), "$DSS");
  const dss = DSS.getSizePrefixedRootAsDSS(new ByteBuffer(dssBytes));
  return {
    attempts,
    status: dss.STATUS(),
    syncedRows: dss.SYNCED_ROWS(),
    totalRows: dss.TOTAL_ROWS(),
    missingRows: dss.MISSING_ROWS(),
    cachedBytes: dss.CACHED_BYTES(),
    downloadedBytes: dss.DOWNLOADED_BYTES(),
    error: dss.ERROR() ?? "",
  };
}

function decodeStarlinkCursor(payload) {
  const bytes = new Uint8Array(payload);
  assert.ok(bytes.byteLength >= 164, "cursor is smaller than its fixed envelope");
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), "SLCURS01");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(8, true);
  const flags = view.getUint16(10, true);
  const unitCount = view.getUint32(12, true);
  const acknowledgedCount = view.getUint32(16, true);
  const objectCap = view.getUint32(20, true);
  const fetchConcurrency = view.getUint16(24, true);
  const batchSize = view.getUint16(26, true);
  const manifestUrlLength = view.getUint16(28, true);
  const ephemerisBaseLength = view.getUint16(30, true);
  const lastAcknowledgedIdentityLength = view.getUint16(32, true);
  assert.equal(view.getUint16(34, true), 0);
  assert.equal(version, 1);
  assert.equal(flags, 0);

  let offset =
    132 +
    manifestUrlLength +
    ephemerisBaseLength +
    lastAcknowledgedIdentityLength;
  const filenameCores = [];
  for (let index = 0; index < unitCount; index += 1) {
    assert.ok(offset + 2 <= bytes.byteLength - 32);
    const length = view.getUint16(offset, true);
    offset += 2;
    assert.ok(offset + length <= bytes.byteLength - 32);
    filenameCores.push(
      new TextDecoder().decode(bytes.subarray(offset, offset + length)),
    );
    offset += length;
  }
  assert.equal(offset, bytes.byteLength - 32);
  assert.equal(
    sha256(bytes.subarray(0, offset)),
    Buffer.from(bytes.subarray(offset)).toString("hex"),
    "cursor checksum does not cover the exact compact metadata",
  );
  return {
    version,
    unitCount,
    acknowledgedCount,
    objectCap,
    fetchConcurrency,
    batchSize,
    filenameCores,
    byteLength: bytes.byteLength,
  };
}

function createOpaqueStateAdapter() {
  const values = new Map();
  const calls = [];
  const keyFor = (params) => `${params.namespace}\0${params.key}`;
  return {
    calls,
    values,
    dispatch(operation, params) {
      calls.push({ operation, params: structuredClone(params) });
      if (operation === "storage.adapter.opaque.read") {
        const value = values.get(keyFor(params));
        return {
          found: value !== undefined,
          bytes_b64: value?.slice() ?? new Uint8Array(),
        };
      }
      if (operation === "storage.adapter.opaque.replace") {
        assert.ok(params.data instanceof Uint8Array);
        values.set(keyFor(params), params.data.slice());
        return { stored_bytes: params.data.byteLength };
      }
      if (operation === "storage.adapter.opaque.sync") {
        return { synced: true };
      }
      if (operation === "storage.adapter.opaque.delete") {
        values.delete(keyFor(params));
        return { deleted: true };
      }
      throw new Error(`unexpected opaque-state operation ${operation}`);
    },
  };
}

function circularStates({ radiusKm, stepSeconds, count }) {
  const meanMotion = Math.sqrt(398600.4418 / radiusKm ** 3);
  return Array.from({ length: count }, (_, index) => {
    const seconds = index * stepSeconds;
    const angle = meanMotion * seconds;
    return {
      seconds,
      x: radiusKm * Math.cos(angle),
      y: radiusKm * Math.sin(angle),
      z: 0,
      vx: -radiusKm * meanMotion * Math.sin(angle),
      vy: radiusKm * meanMotion * Math.cos(angle),
      vz: 0,
    };
  });
}

function minuteStamp(index, stepMinutes) {
  const totalMinutes = index * stepMinutes;
  return {
    hour: Math.floor(totalMinutes / 60),
    minute: totalMinutes % 60,
  };
}

function supportingProviderResponses() {
  const glonass = ["#dP2026  7 21  0  0  0.00000000 ORBIT TEST"];
  for (const [index, state] of circularStates({
    radiusKm: 25_510,
    stepSeconds: 900,
    count: 8,
  }).entries()) {
    const { hour, minute } = minuteStamp(index, 15);
    glonass.push(
      `*  2026 07 21 ${String(hour).padStart(2, "0")} ${String(minute).padStart(2, "0")} 00.00000000`,
      `PR01 ${state.x.toFixed(9)} ${state.y.toFixed(9)} ${state.z.toFixed(9)} 0.000000`,
    );
  }

  const intelsat = ["ECF Ephemeris for Intelsat IS-21 / browser fixture"];
  for (const [index, state] of circularStates({
    radiusKm: 42_164,
    stepSeconds: 300,
    count: 8,
  }).entries()) {
    const { hour, minute } = minuteStamp(index, 5);
    intelsat.push(
      `2026/07/21 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000 ${(state.x * 1000).toFixed(3)} ${(state.y * 1000).toFixed(3)} ${(state.z * 1000).toFixed(3)}`,
    );
  }

  const cpf = [
    "H1 CPF 2 DGF 2026 07 21 00 1 0 lageos1 fixture",
    "H2 7603901 1155 8820 2026 7 21 0 0 0 2026 7 22 0 0 0 60 1 1 0 0 0 1",
  ];
  for (const state of circularStates({
    radiusKm: 12_270,
    stepSeconds: 60,
    count: 8,
  })) {
    cpf.push(
      `10 0 61242 ${state.seconds.toFixed(6)} 0 ${(state.x * 1000).toFixed(3)} ${(state.y * 1000).toFixed(3)} ${(state.z * 1000).toFixed(3)}`,
    );
  }
  cpf.push("99");

  const iss = [
    "CCSDS_OEM_VERS = 2.0",
    "CREATION_DATE = 2026-07-21T00:00:00.000",
    "META_START",
    "OBJECT_NAME = ISS",
    "OBJECT_ID = 1998-067A",
    "META_STOP",
  ];
  for (const [index, state] of circularStates({
    radiusKm: 6_780,
    stepSeconds: 60,
    count: 12,
  }).entries()) {
    iss.push(
      `2026-07-21T00:${String(index).padStart(2, "0")}:00.000 ${state.x.toFixed(9)} ${state.y.toFixed(9)} ${state.z.toFixed(9)} ${state.vx.toFixed(12)} ${state.vy.toFixed(12)} ${state.vz.toFixed(12)}`,
    );
  }

  const intelsatFilename = "i_aor_e_302.00_is-21_20260721_000000.txt";
  const cpfFilename = "lageos1_cpf_260721_0001.dgf";
  return new Map([
    [defaultUrls.glonass, encode(`${glonass.join("\n")}\n`)],
    [defaultUrls.intelsatListing, encode(`${intelsatFilename}\n`)],
    [
      `${defaultUrls.intelsatBase}${intelsatFilename}`,
      encode(`${intelsat.join("\n")}\n`),
    ],
    [defaultUrls.cpfListing, encode(`${cpfFilename}\n`)],
    [
      `${defaultUrls.cpfListing}${cpfFilename}`,
      encode(`${cpf.join("\n")}\n`),
    ],
    [defaultUrls.iss, encode(`${iss.join("\n")}\n`)],
  ]);
}

function starlinkFixtureResponses(fileCount = 3) {
  const templateFilename =
    "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt";
  const template = fs.readFileSync(
    path.resolve(
      packageRoot,
      "../../data-source/spacex-starlink-source/test/fixtures/meme",
      templateFilename,
    ),
    "utf8",
  );
  const filenames = Array.from(
    { length: fileCount },
    (_, index) =>
      `MEME_${70000 + index}_STARLINK-STREAMING-${index + 1}_1_Operational_${1700000000 + index}_UNCLASSIFIED.txt`,
  );
  const bodies = filenames.map((_, index) =>
    encode(
      template.replace(
        "ephemeris_source:blend",
        `ephemeris_source:composed-streaming-${index + 1}`,
      ),
    ),
  );
  const responses = supportingProviderResponses();
  responses.set(
    defaultUrls.starlinkManifest,
    encode(`${filenames.join("\n")}\n`),
  );
  filenames.forEach((filename, index) => {
    responses.set(`${defaultUrls.starlinkBase}${filename}`, bodies[index]);
  });
  return { responses, filenames, bodies };
}

function serveCompleteHttpFixture(params, body, description) {
  assert.equal(params.method, "GET");
  const range = params.headers?.Range;
  const rangeMatch =
    typeof range === "string" ? /^bytes=0-([0-9]+)$/u.exec(range) : null;
  if (rangeMatch) {
    const requestedEnd = Number(rangeMatch[1]);
    assert.ok(Number.isSafeInteger(requestedEnd) && requestedEnd >= 0);
    assert.ok(
      params.max_bytes >= requestedEnd + 1,
      `${description} initial data range exceeds its response ceiling`,
    );
    const responseEnd = Math.min(requestedEnd, body.byteLength - 1);
    const responseBody = new Uint8Array(body.subarray(0, responseEnd + 1));
    return {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${responseEnd}/${body.byteLength}`,
        "Content-Length": String(responseBody.byteLength),
      },
      body: responseBody,
    };
  }
  assert.equal(
    params.headers?.Range,
    undefined,
    `${description} complete fetch used an unexpected range`,
  );
  assert.ok(params.max_bytes >= body.byteLength);
  return {
    status: 200,
    headers: { "Content-Length": String(body.byteLength) },
    body: new Uint8Array(body),
  };
}

function parseJsonEntry(entry, label) {
  assert.ok(entry, `signed bundle is missing ${label}`);
  return JSON.parse(new TextDecoder().decode(entry.payloadBytes));
}

async function readVerifiedRelease() {
  const published = new Uint8Array(fs.readFileSync(releaseArtifactPath));
  assert.equal(sha256(published), expectedOuterSha256);
  const verification = await verifyModuleArtifact(published, {
    trustedPublicKeys: [trustedReleaseSigner],
    requireSignature: true,
  });
  assert.equal(verification.verified, true);
  assert.equal(verification.signatureScope, "bundle");
  assert.equal(verification.publicKeyHex, trustedReleaseSigner);

  const parsed = await parseSingleFileBundle(published);
  const entries = new Map(parsed.entries.map((entry) => [entry.entryId, entry]));
  const artifact = parseJsonEntry(entries.get("artifact.json"), "artifact.json");
  assert.deepEqual(
    Object.fromEntries(
      artifact.nodeArtifacts.map(({ nodeId, sha256: childSha256 }) => [
        nodeId,
        childSha256,
      ]),
    ),
    expectedChildSha256,
  );
  for (const descriptor of artifact.nodeArtifacts) {
    const childEntry = entries.get(descriptor.entryId);
    assert.ok(childEntry, `signed bundle is missing ${descriptor.entryId}`);
    assert.equal(sha256(childEntry.payloadBytes), descriptor.sha256);
    const publisher = parseJsonEntry(
      entries.get(descriptor.publisherEntryId),
      descriptor.publisherEntryId,
    );
    assert.equal(publisher.publicKeyHex, trustedReleaseSigner);
    assert.equal(publisher.developmentOnly, false);
  }
  return { published, entries, artifact };
}

function cursorReplaceCalls(calls) {
  return calls.filter(
    ({ operation, params }) =>
      operation === "storage.adapter.opaque.replace" &&
      params.namespace === "primary" &&
      params.key === "starlink.cursor.v1",
  );
}

function responseProgress(response) {
  const progress = response.outputs.filter(({ portId }) => portId === "progress");
  assert.equal(progress.length, 1, "provider invocation must emit one progress");
  return decodeDssRoute(progress[0]);
}

function responseOemRequestIds(response) {
  const frames = response.outputs
    .filter(({ portId }) => portId === "oem")
    .map(({ payload }) => decodeProviderFsb(payload));
  assert.ok(frames.every(({ requestId }) => requestId !== 0n));
  return [...new Set(frames.map(({ requestId }) => requestId.toString()))];
}

test("exact signed composed flow streams Starlink through OD and FlatSQL before the final catalog GET, then drains OMM/OCM-only queues", async (t) => {
  const { published, entries, artifact } = await readVerifiedRelease();
  const flowEntry = entries.get("flow.plg");
  assert.ok(flowEntry, "signed bundle is missing flow.plg");
  const signedFlow = PLG.getRootAsPLG(
    new ByteBuffer(new Uint8Array(flowEntry.payloadBytes)),
  );
  const signedEdges = Array.from(
    { length: signedFlow.flowEdgesLength() },
    (_, index) => {
      const edge = signedFlow.FLOW_EDGES(index);
      return {
        edgeId: edge.EDGE_ID(),
        fromNodeId: edge.FROM_NODE_ID(),
        fromPortId: edge.FROM_PORT_ID(),
        toNodeId: edge.TO_NODE_ID(),
        toPortId: edge.TO_PORT_ID(),
      };
    },
  );
  assert.doesNotMatch(
    JSON.stringify(signedEdges),
    /\bobd\b/iu,
    "the exact signed graph still contains the retired OBD path",
  );
  const boundedCycle = [
    "starlink-native-to-od",
    "od-control-to-store",
    "od-omm-to-store",
    "od-ocm-to-store",
    "store-status-to-starlink-ack",
  ];
  for (const edgeId of boundedCycle) {
    const edge = signedEdges.find((candidate) => candidate.edgeId === edgeId);
    assert.ok(edge, `signed streaming cycle is missing ${edgeId}`);
  }

  const { responses: httpBodies, filenames, bodies } =
    starlinkFixtureResponses(3);
  const starlinkUrls = filenames.map(
    (filename) => `${defaultUrls.starlinkBase}${filename}`,
  );
  const starlinkUrlSet = new Set(starlinkUrls);
  let clockNowMs = Date.parse("2026-07-23T12:34:56Z");
  let sequence = 0;
  const events = [];
  const record = (event) => {
    const value = { sequence: sequence++, ...event };
    events.push(value);
    return value;
  };
  const hostcalls = [];
  const opaqueValues = new Map();
  const opaqueKey = (nodeId, params) =>
    `${nodeId}\0${params.namespace}\0${params.key}`;
  const children = artifact.nodeArtifacts.map((descriptor) => ({
    pluginId: descriptor.pluginId,
    wasmSource: entries.get(descriptor.entryId).payloadBytes,
    verifySignature: {
      trustedPublicKeys: [trustedReleaseSigner],
      requireSignature: true,
    },
    hostcallDispatch(operation, params) {
      const recordedParams =
        params?.data instanceof Uint8Array
          ? { ...params, data: params.data.slice() }
          : params?.records instanceof Uint8Array
            ? { ...params, records: params.records.slice() }
            : structuredClone(params);
      hostcalls.push({
        nodeId: descriptor.nodeId,
        operation,
        params: recordedParams,
      });
      if (operation === "clock.now") return clockNowMs;
      if (operation === "timers.arm" || operation === "timers.cancel") {
        return { accepted: true };
      }
      if (operation === "http.request") {
        record({
          kind: "http",
          nodeId: descriptor.nodeId,
          url: params.url,
        });
        const body = httpBodies.get(params.url);
        assert.ok(body, `no browser fixture for ${params.url}`);
        return serveCompleteHttpFixture(
          params,
          body,
          `signed provider ${params.url}`,
        );
      }
      if (operation === "pubsub.publish") {
        record({
          kind: "publish",
          standard: params.standard,
        });
        return true;
      }
      if (operation === "storage.adapter.opaque.read") {
        const value = opaqueValues.get(opaqueKey(descriptor.nodeId, params));
        return {
          found: value !== undefined,
          bytes_b64: value?.slice() ?? new Uint8Array(),
        };
      }
      if (operation === "storage.adapter.opaque.replace") {
        assert.ok(params.data instanceof Uint8Array);
        record({
          kind: "opaque-replace",
          nodeId: descriptor.nodeId,
          namespace: params.namespace,
          key: params.key,
          byteLength: params.data.byteLength,
        });
        opaqueValues.set(
          opaqueKey(descriptor.nodeId, params),
          params.data.slice(),
        );
        return { stored_bytes: params.data.byteLength };
      }
      if (operation === "storage.adapter.opaque.sync") {
        return { synced: true };
      }
      if (operation === "storage.adapter.opaque.delete") {
        opaqueValues.delete(opaqueKey(descriptor.nodeId, params));
        return { deleted: true };
      }
      throw new Error(
        `signed child ${descriptor.nodeId} requested unexpected host operation ${operation}`,
      );
    },
  }));

  const host = await createIsomorphicFlowRuntimeHost({
    wasmSource: published,
    children,
  });
  t.after(() => host.destroy());
  const childRecordFor = (nodeId) => {
    const descriptor = artifact.nodeArtifacts.find(
      (candidate) => candidate.nodeId === nodeId,
    );
    return host.children.get(descriptor.pluginId);
  };
  for (const descriptor of artifact.nodeArtifacts) {
    const child = childRecordFor(descriptor.nodeId);
    assert.ok(child?.harness, `${descriptor.nodeId} was not instantiated`);
    assert.equal(child.sha256, expectedChildSha256[descriptor.nodeId]);
  }

  const starlinkRequestIds = new Set();
  const starlinkProgress = [];
  const starlinkAckInputs = [];
  const starlinkHarness = childRecordFor("provider-starlink").harness;
  const invokeStarlink = starlinkHarness.invoke;
  let injectedFocusedConfig = false;
  starlinkHarness.invoke = async (request) => {
    const ackFrames = (request.inputs ?? []).filter(
      ({ portId }) => portId === "ack",
    );
    for (const input of ackFrames) {
      assert.equal(input.wireFormat ?? input.typeRef?.wireFormat, "flatbuffer");
      const decoded = decodeFlatSqlStatus(input);
      starlinkAckInputs.push(decoded);
      record({
        kind: "starlink-ack",
        operation: decoded.operation,
        status: decoded.status,
        requestId: decoded.requestId.toString(),
      });
    }

    let forwarded = request;
    if (
      !injectedFocusedConfig &&
      (request.inputs ?? []).some(({ portId }) => portId === "config")
    ) {
      injectedFocusedConfig = true;
      const focusedConfig = makeProviderConfigFrame({
        manifestUrl: defaultUrls.starlinkManifest,
        ephemerisBase: defaultUrls.starlinkBase,
        fetchConcurrency: 2,
        batchSize: 2,
      });
      forwarded = {
        ...request,
        inputs: (request.inputs ?? []).map((input) =>
          input.portId === "config" ? focusedConfig : input,
        ),
      };
    }

    const response = await invokeStarlink(forwarded);
    for (const output of response.outputs) {
      if (output.portId === "oem") {
        const frame = decodeProviderFsb(output.payload);
        starlinkRequestIds.add(frame.requestId.toString());
        record({
          kind: "starlink-oem",
          requestId: frame.requestId.toString(),
          final: frame.final,
        });
      } else if (output.portId === "progress") {
        const progress = decodeDssRoute(output);
        starlinkProgress.push(progress);
        record({
          kind: "starlink-progress",
          syncedRows: progress.syncedRows.toString(),
          totalRows: progress.totalRows.toString(),
        });
      }
    }
    return response;
  };

  const odOutputPorts = [];
  const odRecordSchemas = [];
  const odHarness = childRecordFor("od").harness;
  const invokeOd = odHarness.invoke;
  odHarness.invoke = async (request) => {
    const starlinkFrames = (request.inputs ?? []).filter(
      ({ portId }) => portId === "starlink",
    );
    if (starlinkFrames.length > 0) {
      assert.ok(
        starlinkFrames.every(
          ({ wireFormat, typeRef }) =>
            (wireFormat ?? typeRef?.wireFormat) === "flatbuffer",
        ),
      );
      record({
        kind: "od-starlink",
        requestIds: [
          ...new Set(
            starlinkFrames.map(({ payload }) =>
              decodeProviderFsb(payload).requestId.toString(),
            ),
          ),
        ],
      });
    }
    const response = await invokeOd(request);
    for (const output of response.outputs) {
      odOutputPorts.push(output.portId);
      if (output.portId === "omm" || output.portId === "ocm") {
        odRecordSchemas.push(decodeProviderFsb(output.payload).schemaName);
      }
    }
    return response;
  };

  const storeStatuses = [];
  const storeRecordSchemas = [];
  const storeHarness = childRecordFor("store").harness;
  const invokeStore = storeHarness.invoke;
  storeHarness.invoke = async (request) => {
    for (const input of request.inputs ?? []) {
      if (input.portId === "records") {
        storeRecordSchemas.push(decodeProviderFsb(input.payload).schemaName);
      }
    }
    const response = await invokeStore(request);
    for (const output of response.outputs.filter(
      ({ portId }) => portId === "status",
    )) {
      const status = decodeFlatSqlStatus(output);
      storeStatuses.push(status);
      if (
        status.operation === flatSqlNodeOperation.APPEND_RECORDS &&
        status.status === flatSqlNodeStatus.COMPLETE
      ) {
        record({
          kind: "store-complete",
          requestId: status.requestId.toString(),
        });
      }
    }
    return response;
  };

  host.enqueueTrigger(0);
  const bootstrapped = await host.drain({
    maxIterations: 20_000,
    frameBudget: 64,
  });
  assert.ok(bootstrapped.nodesInvoked >= 1);
  assert.equal(
    events.filter(({ kind }) => kind === "http").length,
    0,
    "lifecycle bootstrap fetched before APP commit",
  );

  clockNowMs += 30_000;
  host.enqueueTrigger(0);
  const drained = await host.drain({
    maxIterations: 100_000,
    frameBudget: 64,
  });

  const starlinkFetches = events.filter(
    ({ kind, nodeId, url }) =>
      kind === "http" &&
      nodeId === "provider-starlink" &&
      starlinkUrlSet.has(url),
  );
  assert.deepEqual(
    new Set(starlinkFetches.map(({ url }) => url)),
    starlinkUrlSet,
    "the exact child did not fetch each complete ephemeris once",
  );
  const finalCatalogGet = starlinkFetches.at(-1);
  const firstOd = events.find(({ kind }) => kind === "od-starlink");
  const firstStoreComplete = events.find(
    ({ kind, requestId }) =>
      kind === "store-complete" && starlinkRequestIds.has(requestId),
  );
  assert.ok(firstOd, "no first-wave Starlink OEM reached OD");
  assert.ok(firstStoreComplete, "no first-wave Starlink fit reached FlatSQL");
  assert.ok(
    firstOd.sequence < finalCatalogGet.sequence,
    "OD waited for the final catalog GET instead of consuming the first wave",
  );
  assert.ok(
    firstStoreComplete.sequence < finalCatalogGet.sequence,
    "FlatSQL waited for the final catalog GET instead of committing the first wave",
  );
  assert.equal(
    starlinkFetches.filter(
      ({ sequence: fetchSequence }) => fetchSequence < firstOd.sequence,
    ).length,
    2,
    "the focused two-file first wave was not released directly to OD",
  );

  const appendCompletes = storeStatuses.filter(
    ({ operation, status, requestId }) =>
      operation === flatSqlNodeOperation.APPEND_RECORDS &&
      status === flatSqlNodeStatus.COMPLETE &&
      starlinkRequestIds.has(requestId.toString()),
  );
  const routedAcks = starlinkAckInputs.filter(
    ({ operation, status, requestId }) =>
      operation === flatSqlNodeOperation.APPEND_RECORDS &&
      status === flatSqlNodeStatus.COMPLETE &&
      starlinkRequestIds.has(requestId.toString()),
  );
  assert.deepEqual(
    new Set(routedAcks.map(({ requestId }) => requestId.toString())),
    new Set(appendCompletes.map(({ requestId }) => requestId.toString())),
    "FlatSQL COMPLETE request IDs did not feed back to their Starlink owner",
  );
  assert.equal(starlinkProgress.at(0).syncedRows, 0n);
  assert.equal(starlinkProgress.at(0).totalRows, 3n);
  assert.equal(starlinkProgress.at(-1).syncedRows, 3n);
  assert.equal(starlinkProgress.at(-1).totalRows, 3n);
  assert.equal(starlinkProgress.at(-1).missingRows, 0n);
  assert.ok(
    starlinkProgress.every(({ cachedBytes }) => cachedBytes === 0n),
    "progress still reports a durable raw ephemeris cache",
  );

  const providerOpaqueCalls = hostcalls.filter(
    ({ nodeId, operation }) =>
      nodeId === "provider-starlink" &&
      operation.startsWith("storage.adapter.opaque."),
  );
  assert.equal(
    providerOpaqueCalls.some(
      ({ operation }) => operation === "storage.adapter.opaque.delete",
    ),
    false,
    "transient ephemerides must not need durable chunk deletion",
  );
  const providerReplaces = providerOpaqueCalls.filter(
    ({ operation }) => operation === "storage.adapter.opaque.replace",
  );
  assert.ok(providerReplaces.length > 0, "Starlink never persisted its cursor");
  const rawBodyHashes = new Set(bodies.map(sha256));
  for (const { params } of providerReplaces) {
    assert.equal(params.namespace, "primary");
    assert.equal(params.key, "starlink.cursor.v1");
    assert.ok(params.data.byteLength < 128 * 1024);
    assert.equal(rawBodyHashes.has(sha256(params.data)), false);
    assert.equal(
      Buffer.from(params.data).includes(Buffer.from("ephemeris_start:")),
      false,
      "raw MEME ephemeris content leaked into opaque state",
    );
    decodeStarlinkCursor(params.data);
  }
  const finalCursor = decodeStarlinkCursor(providerReplaces.at(-1).params.data);
  assert.equal(finalCursor.unitCount, 3);
  assert.equal(finalCursor.acknowledgedCount, 3);

  assert.equal(odOutputPorts.includes("obd"), false);
  assert.equal(storeRecordSchemas.includes("OBD"), false);
  assert.equal(
    hostcalls.some(
      ({ operation, params }) =>
        operation === "pubsub.publish" && params.standard === "OBD",
    ),
    false,
  );
  assert.deepEqual(new Set(odRecordSchemas), new Set(["OMM", "OCM"]));
  assert.deepEqual(new Set(storeRecordSchemas), new Set(["OMM", "OCM"]));
  const publications = hostcalls.filter(
    ({ operation }) => operation === "pubsub.publish",
  );
  assert.ok(publications.length > 0);
  assert.deepEqual(
    new Set(publications.map(({ params }) => params.standard)),
    new Set(["OMM", "OCM"]),
  );
  assert.equal(
    publications.filter(({ params }) => params.standard === "OMM").length,
    publications.filter(({ params }) => params.standard === "OCM").length,
    "epoch-specific OMM and OCM publication counts diverged",
  );

  for (let index = 0; index < host.nodeCount; index += 1) {
    const descriptor = host.getNodeDispatchDescriptor(index);
    const state = host.getNodeState(index);
    assert.ok(state.invocationCount > 0n, `${descriptor.nodeId} was not invoked`);
    assert.equal(state.lastStatus, 0, `${descriptor.nodeId} failed`);
    assert.equal(state.ready, false, `${descriptor.nodeId} remained ready`);
    assert.equal(state.queuedFrames, 0, `${descriptor.nodeId} retained frames`);
    assert.equal(
      state.backlogRemaining,
      0,
      `${descriptor.nodeId} retained an in-memory continuation`,
    );
  }
  for (let index = 0; index < host.edgeCount; index += 1) {
    const ingress = host.getIngressState(index);
    assert.equal(ingress.queuedFrames, 0, `edge ${index} retained frames`);
    assert.equal(ingress.totalDropped, 0n, `edge ${index} dropped bounded work`);
  }
  assert.equal(drained.handlersSkipped, 0);
  assert.equal(host.getRoutingState().rejectedFrames, 0n);
  assert.ok(host.getRoutingState().canonicalRoutes > 0n);
});

test("exact signed Starlink cursor advances only on contiguous FlatSQL COMPLETE acknowledgements and replays a lost post-store ACK idempotently", async (t) => {
  const { entries, artifact } = await readVerifiedRelease();
  const descriptor = artifact.nodeArtifacts.find(
    ({ nodeId }) => nodeId === "provider-starlink",
  );
  assert.ok(descriptor, "signed outer bundle has no Starlink child descriptor");
  const exactChildBytes = new Uint8Array(
    entries.get(descriptor.entryId).payloadBytes,
  );
  const exactTreeBytes = new Uint8Array(fs.readFileSync(starlinkArtifactPath));
  assert.deepEqual(
    exactChildBytes,
    exactTreeBytes,
    "the signed parent does not embed the exact current Starlink child",
  );
  const childVerification = await verifyModuleArtifact(exactChildBytes, {
    trustedPublicKeys: [trustedReleaseSigner],
    requireSignature: true,
  });
  assert.equal(childVerification.verified, true);
  assert.equal(childVerification.publicKeyHex, trustedReleaseSigner);

  const { responses: httpBodies, filenames, bodies } =
    starlinkFixtureResponses(3);
  const ephemerisUrls = filenames.map(
    (filename) => `${defaultUrls.starlinkBase}${filename}`,
  );
  const opaque = createOpaqueStateAdapter();
  const httpCalls = [];
  const hostcallDispatch = (operation, params) => {
    if (operation === "http.request") {
      httpCalls.push(params.url);
      const body = httpBodies.get(params.url);
      assert.ok(body, `no exact-child fixture for ${params.url}`);
      return serveCompleteHttpFixture(
        params,
        body,
        `exact Starlink child ${params.url}`,
      );
    }
    return opaque.dispatch(operation, params);
  };
  const liveHarnesses = new Set();
  t.after(() => {
    for (const harness of liveHarnesses) harness.destroy();
  });
  const createExactChild = async () => {
    const harness = await createBrowserModuleHarness({
      wasmSource: exactChildBytes,
      surface: "direct",
      hostcallDispatch,
      verifySignature: {
        trustedPublicKeys: [trustedReleaseSigner],
        requireSignature: true,
      },
    });
    liveHarnesses.add(harness);
    return harness;
  };
  const destroy = (harness) => {
    harness.destroy();
    liveHarnesses.delete(harness);
  };

  const first = await createExactChild();
  const signedManifest = new Uint8Array(first.readManifest());
  const firstWave = await first.invoke({
    methodId: "emit",
    inputs: [
      makeProviderConfigFrame({
        manifestUrl: defaultUrls.starlinkManifest,
        ephemerisBase: defaultUrls.starlinkBase,
        fetchConcurrency: 2,
        batchSize: 2,
      }),
    ],
  });
  assert.equal(firstWave.statusCode, 0, firstWave.errorMessage);
  const firstWaveIds = responseOemRequestIds(firstWave);
  assert.equal(
    firstWaveIds.length,
    2,
    "the first complete fetch wave did not emit both OEM files immediately",
  );
  assert.equal(responseProgress(firstWave).syncedRows, 0n);
  assert.deepEqual(
    new Set(httpCalls),
    new Set([defaultUrls.starlinkManifest, ...ephemerisUrls.slice(0, 2)]),
  );
  const planWrites = cursorReplaceCalls(opaque.calls);
  assert.equal(planWrites.length, 1);
  assert.equal(
    decodeStarlinkCursor(planWrites[0].params.data).acknowledgedCount,
    0,
  );

  const rejected = await first.invoke({
    methodId: "emit",
    inputs: [
      makeFlatSqlStatusFrame(
        firstWaveIds[0],
        flatSqlNodeStatus.INTERNAL_ERROR,
      ),
    ],
  });
  assert.equal(rejected.statusCode, 0, rejected.errorMessage);
  assert.equal(responseProgress(rejected).syncedRows, 0n);
  assert.equal(cursorReplaceCalls(opaque.calls).length, 1);

  const unmatched = await first.invoke({
    methodId: "emit",
    inputs: [makeFlatSqlStatusFrame(0xfffffffffffffff0n)],
  });
  assert.equal(unmatched.statusCode, 0, unmatched.errorMessage);
  assert.equal(responseProgress(unmatched).syncedRows, 0n);
  assert.equal(cursorReplaceCalls(opaque.calls).length, 1);

  const outOfOrder = await first.invoke({
    methodId: "emit",
    inputs: [makeFlatSqlStatusFrame(firstWaveIds[1])],
  });
  assert.equal(outOfOrder.statusCode, 0, outOfOrder.errorMessage);
  assert.equal(responseProgress(outOfOrder).syncedRows, 0n);
  assert.equal(
    cursorReplaceCalls(opaque.calls).length,
    1,
    "out-of-order completion advanced the durable contiguous prefix",
  );

  const contiguous = await first.invoke({
    methodId: "emit",
    inputs: [makeFlatSqlStatusFrame(firstWaveIds[0])],
  });
  assert.equal(contiguous.statusCode, 0, contiguous.errorMessage);
  assert.equal(responseProgress(contiguous).syncedRows, 2n);
  const afterFirstWaveWrites = cursorReplaceCalls(opaque.calls);
  assert.equal(afterFirstWaveWrites.length, 2);
  assert.equal(
    decodeStarlinkCursor(afterFirstWaveWrites.at(-1).params.data)
      .acknowledgedCount,
    2,
  );

  const finalFetch = await first.invoke({
    methodId: "emit",
    inputs: [],
  });
  assert.equal(finalFetch.statusCode, 0, finalFetch.errorMessage);
  const finalId = responseOemRequestIds(finalFetch);
  assert.equal(finalId.length, 1);
  assert.equal(responseProgress(finalFetch).syncedRows, 2n);
  assert.equal(cursorReplaceCalls(opaque.calls).length, 2);
  assert.deepEqual(
    httpCalls,
    [
      defaultUrls.starlinkManifest,
      ...ephemerisUrls.slice(0, 2),
      ephemerisUrls[2],
    ],
  );

  // Model the exact crash window: FlatSQL durably accepted finalId[0], but its
  // COMPLETE acknowledgement did not reach the provider before destruction.
  destroy(first);
  const restarted = await createExactChild();
  assert.deepEqual(new Uint8Array(restarted.readManifest()), signedManifest);
  const replay = await restarted.invoke({
    methodId: "emit",
    inputs: [],
  });
  assert.equal(replay.statusCode, 0, replay.errorMessage);
  assert.deepEqual(
    responseOemRequestIds(replay),
    finalId,
    "crash replay changed the deterministic FlatSQL transaction request ID",
  );
  assert.equal(responseProgress(replay).syncedRows, 2n);
  assert.equal(
    httpCalls.filter((url) => url === ephemerisUrls[0]).length,
    1,
    "restart refetched an acknowledged prefix entry",
  );
  assert.equal(
    httpCalls.filter((url) => url === ephemerisUrls[1]).length,
    1,
    "restart refetched an acknowledged prefix entry",
  );
  assert.equal(
    httpCalls.filter((url) => url === ephemerisUrls[2]).length,
    2,
    "restart did not replay exactly the unacknowledged stored transaction",
  );
  assert.equal(
    httpCalls.filter((url) => url === defaultUrls.starlinkManifest).length,
    2,
    "restart did not fail-closed verify the persisted plan against the manifest",
  );

  const completed = await restarted.invoke({
    methodId: "emit",
    inputs: [makeFlatSqlStatusFrame(finalId[0])],
  });
  assert.equal(completed.statusCode, 0, completed.errorMessage);
  assert.equal(responseProgress(completed).syncedRows, 3n);
  const completeWrites = cursorReplaceCalls(opaque.calls);
  assert.equal(completeWrites.length, 3);
  const finalCursor = decodeStarlinkCursor(completeWrites.at(-1).params.data);
  assert.equal(finalCursor.unitCount, 3);
  assert.equal(finalCursor.acknowledgedCount, 3);

  const duplicate = await restarted.invoke({
    methodId: "emit",
    inputs: [makeFlatSqlStatusFrame(finalId[0])],
  });
  assert.equal(duplicate.statusCode, 0, duplicate.errorMessage);
  assert.equal(responseProgress(duplicate).syncedRows, 3n);
  assert.equal(
    cursorReplaceCalls(opaque.calls).length,
    3,
    "replayed FlatSQL COMPLETE duplicated a durable cursor commit",
  );

  const rawHashes = new Set(bodies.map(sha256));
  for (const { operation, params } of opaque.calls) {
    if (operation !== "storage.adapter.opaque.replace") continue;
    assert.equal(params.namespace, "primary");
    assert.equal(params.key, "starlink.cursor.v1");
    assert.equal(rawHashes.has(sha256(params.data)), false);
    assert.equal(
      Buffer.from(params.data).includes(Buffer.from("ephemeris_start:")),
      false,
      "raw ephemeris bytes entered durable provider state",
    );
    decodeStarlinkCursor(params.data);
  }
  assert.equal(
    opaque.calls.some(
      ({ operation }) => operation === "storage.adapter.opaque.delete",
    ),
    false,
  );
});
