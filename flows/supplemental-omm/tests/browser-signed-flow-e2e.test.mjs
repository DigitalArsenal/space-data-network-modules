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

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseArtifactPath = path.join(
  packageRoot,
  "dist/isomorphic/module.wasm",
);
const trustedReleaseSigner =
  "088ac3d85932dc6946e3ff62882afb48885c2df0cd8b34f2993c5885e3424d89";

// This release lock is updated only when the production-signed outer bundle is
// deliberately replaced. The child locks below prove which exact separately
// signed nodes the browser instantiated, rather than trusting source-tree
// paths that are outside the signed outer artifact.
const expectedOuterSha256 =
  "ed649e974613cf365ab8eadc33df19785eef8f8d17cc6780c2995fbf899698e0";
const expectedChildSha256 = Object.freeze({
  timer: "db8d7a3506a0c3188b006886ebea30cfda9e9c2c2b9c477baefb5c37a375d6bd",
  "provider-starlink":
    "eca46d33c7f6716a929426742e382d6c3c551763c3e4ffa767a3c46b164a7da6",
  "provider-glonass":
    "d8462af69d5fd2311bfdf279ebb665cb5a3fbc1e73d7eba303b0522ca43c4095",
  "provider-intelsat":
    "e31d65c2bd3bca346f12044748102f662227f7f25ee042f9a0e83d07a09397f3",
  "provider-cpf":
    "ffcaa7abe9533eeab795bf7e8452de6e79e6746c6d5d40226dbf50e5dd537fa1",
  "provider-iss":
    "97e0f6231db85dd7dec479cc346cfb37b885c81fe90436d109423f04e9861d17",
  od: "485d068641cf97961d44f33881f6082f734b6b68b3c92ecf9df4a9a6cd2c9e82",
  store:
    "593bd94c0964835c5077a60973cd1da42f5ccf1f5ca63dcd71a82e59df97a93e",
  publication:
    "18a8ef6baaef1b92e7f93940ced3233ab2fa83512fd808b48b6c34b49681ce61",
  status:
    "a4b938be7d2012c2a9f46b7b6fedba4ac5d8659d89380f99132c48cfcb5e650e",
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function encode(text) {
  return new TextEncoder().encode(text);
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
    typeRef: {
      ...fsbType,
      schemaHash: [...Buffer.from(fsbType.schemaHash, "hex")],
      wireFormat: "flatbuffer",
    },
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
    final: envelope.FINAL(),
    data: new Uint8Array(envelope.dataArray() ?? []),
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
      if (operation === "storage.adapter.opaque.delete") {
        values.delete(keyFor(params));
        return { deleted: true };
      }
      if (operation === "storage.adapter.opaque.sync") {
        return { synced: true };
      }
      throw new Error(`unexpected opaque-state operation ${operation}`);
    },
  };
}

function circularStates({ radiusKm, stepSeconds, count, phase = 0 }) {
  const meanMotion = Math.sqrt(398600.4418 / radiusKm ** 3);
  return Array.from({ length: count }, (_, index) => {
    const seconds = index * stepSeconds;
    const angle = phase + meanMotion * seconds;
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

function fixtureResponses() {
  const starlinkFixtureFilename =
    "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt";
  const invalidStarlinkFilename =
    "MEME_67849_STARLINK-36839_1340142_Operational_1463017380_UNCLASSIFIED.txt";
  const starlinkFilenames = [
    invalidStarlinkFilename,
    ...Array.from({ length: 5 }, (_, index) =>
      index === 0
        ? starlinkFixtureFilename
        : `MEME_${67850 + index}_STARLINK-${36840 + index}_1340142_Operational_1463017380_UNCLASSIFIED.txt`,
    ),
  ];
  const starlink = new Uint8Array(
    fs.readFileSync(
      path.resolve(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme",
        starlinkFixtureFilename,
      ),
    ),
  );
  const invalidStarlink = encode(
    [
      "created: 2026-07-21 00:00:00 UTC",
      "ephemeris_start: 2026-07-21 00:00:00 UTC ephemeris_stop: 2026-07-21 00:01:00 UTC step_size: 60",
      "ephemeris_source: deliberately-short-browser-fixture",
      "UVW",
      "2026202000000.000 7000 0 0 0 7.5 0",
      "2026202000100.000 6999 450 0 -0.5 7.48 0",
      "",
    ].join("\n"),
  );

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

  const intelsatFilename =
    "i_aor_e_302.00_is-21_20260721_000000.txt";
  const cpfFilename = "lageos1_cpf_260721_0001.dgf";
  return new Map([
    [defaultUrls.starlinkManifest, encode(`${starlinkFilenames.join("\n")}\n`)],
    ...starlinkFilenames.map((filename) => [
      `${defaultUrls.starlinkBase}${filename}`,
      filename === invalidStarlinkFilename ? invalidStarlink : starlink,
    ]),
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

function serveCompleteHttpFixture(params, body, description) {
  assert.equal(params.method, "GET");
  if (params.headers?.Range === "bytes=0-0") {
    assert.ok(params.max_bytes >= 1, `${description} size probe cannot hold one byte`);
    return {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-0/${body.byteLength}`,
        "Content-Length": "1",
      },
      body: new Uint8Array(body.subarray(0, 1)),
    };
  }
  assert.equal(
    params.headers?.Range,
    undefined,
    `${description} complete fetch used an unexpected range`,
  );
  assert.ok(
    params.max_bytes >= body.byteLength,
    `${description} response ceiling cannot hold the complete fixture`,
  );
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
    downloadedBytes: dss.DOWNLOADED_BYTES(),
    error: dss.ERROR() ?? "",
  };
}

test("exact release-signed Supplemental flow commits the Starlink catalog before OD while executing every signed child", async (t) => {
  const published = new Uint8Array(fs.readFileSync(releaseArtifactPath));
  assert.equal(sha256(published), expectedOuterSha256);
  const outerVerification = await verifyModuleArtifact(published, {
    trustedPublicKeys: [trustedReleaseSigner],
    requireSignature: true,
  });
  assert.equal(outerVerification.verified, true);
  assert.equal(outerVerification.signatureScope, "bundle");
  assert.equal(outerVerification.publicKeyHex, trustedReleaseSigner);

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

  const httpBodies = fixtureResponses();
  const expectedRecordsPerStandard = 9;
  let clockNowMs = Date.parse("2026-07-21T12:34:56Z");
  const hostcalls = [];
  const executionEvents = [];
  const recordEvent = (event) => {
    const recorded = { sequence: executionEvents.length, ...event };
    executionEvents.push(recorded);
    return recorded;
  };
  const opaqueValues = new Map();
  const opaqueKey = (nodeId, params) =>
    `${nodeId}\0${params.namespace}\0${params.key}`;
  const children = [];
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

    children.push({
      pluginId: descriptor.pluginId,
      wasmSource: childEntry.payloadBytes,
      verifySignature: {
        trustedPublicKeys: [trustedReleaseSigner],
        requireSignature: true,
      },
      hostcallDispatch(operation, params) {
        const recordedParams =
          params?.records instanceof Uint8Array
            ? { ...params, records: new Uint8Array(params.records) }
            : structuredClone(params);
        hostcalls.push({
          nodeId: descriptor.nodeId,
          operation,
          params: recordedParams,
        });
        recordEvent({
          kind: "hostcall",
          nodeId: descriptor.nodeId,
          operation,
          params: recordedParams,
        });
        if (operation === "clock.now") return clockNowMs;
        if (operation === "timers.arm" || operation === "timers.cancel") {
          return { accepted: true };
        }
        if (operation === "http.request") {
          const body = httpBodies.get(params?.url);
          assert.ok(body, `no complete browser fixture for ${params?.url}`);
          return serveCompleteHttpFixture(
            params,
            body,
            `signed provider ${params?.url}`,
          );
        }
        if (operation === "pubsub.publish") return true;
        if (operation === "storage.adapter.opaque.read") {
          const value = opaqueValues.get(opaqueKey(descriptor.nodeId, params));
          return {
            found: value !== undefined,
            bytes_b64: value?.slice() ?? new Uint8Array(),
          };
        }
        if (operation === "storage.adapter.opaque.replace") {
          assert.ok(params.data instanceof Uint8Array);
          opaqueValues.set(
            opaqueKey(descriptor.nodeId, params),
            params.data.slice(),
          );
          return { stored_bytes: params.data.byteLength };
        }
        if (operation === "storage.adapter.opaque.delete") {
          opaqueValues.delete(opaqueKey(descriptor.nodeId, params));
          return { deleted: true };
        }
        if (operation === "storage.adapter.opaque.sync") {
          return { synced: true };
        }
        throw new Error(
          `signed child ${descriptor.nodeId} requested unexpected host operation ${operation}`,
        );
      },
    });
  }

  const host = await createIsomorphicFlowRuntimeHost({
    wasmSource: published,
    children,
  });
  t.after(() => host.destroy());
  const childRecordFor = (nodeId) => {
    const descriptor = artifact.nodeArtifacts.find(
      (candidate) => candidate.nodeId === nodeId,
    );
    return (
      host.children.get(nodeId) ?? host.children.get(descriptor?.pluginId)
    );
  };
  for (const descriptor of artifact.nodeArtifacts) {
    const childRecord = childRecordFor(descriptor.nodeId);
    assert.ok(
      childRecord?.harness,
      `${descriptor.nodeId} browser instance was not created from the exact child entry`,
    );
    assert.equal(
      childRecord.sha256,
      expectedChildSha256[descriptor.nodeId],
      `${descriptor.nodeId} browser instance did not retain the exact signed child hash`,
    );
  }
  const starlinkProviderOutputs = [];
  const starlinkHarness = childRecordFor("provider-starlink")?.harness;
  assert.ok(starlinkHarness, "Starlink child harness was not instantiated");
  const invokeStarlink = starlinkHarness.invoke;
  starlinkHarness.invoke = async (request) => {
    const response = await invokeStarlink(request);
    for (const output of response.outputs) {
      const recorded = {
        portId: output.portId,
        wireFormat: output.wireFormat,
        payload: new Uint8Array(output.payload),
      };
      const event = recordEvent({
        kind: "starlink-output",
        portId: output.portId,
      });
      starlinkProviderOutputs.push({ ...recorded, sequence: event.sequence });
    }
    return response;
  };
  const odInvocations = [];
  const odStarlinkFrames = [];
  const odResponses = [];
  const odHarness = childRecordFor("od")?.harness;
  assert.ok(odHarness, "OD child harness was not instantiated");
  const invokeOd = odHarness.invoke;
  odHarness.invoke = async (request) => {
    const starlinkFrames = (request.inputs ?? [])
      .filter((frame) => frame.portId === "starlink")
      .map((frame) => decodeProviderFsb(frame.payload));
    const starlinkRequestIds = new Set(
      starlinkFrames.map(({ requestId }) => requestId.toString()),
    );
    if (starlinkFrames.length > 0) {
      const event = recordEvent({
        kind: "od-starlink-input",
        requestIds: [...starlinkRequestIds],
      });
      odStarlinkFrames.push(
        ...starlinkFrames.map((frame) => ({ ...frame, sequence: event.sequence })),
      );
    }
    odInvocations.push([...starlinkRequestIds]);
    const response = await invokeOd(request);
    odResponses.push({
      statusCode: response.statusCode,
      errorCode: response.errorCode,
      errorMessage: response.errorMessage,
      outputPorts: response.outputs.map((output) => output.portId),
    });
    return response;
  };
  const publicationInputs = [];
  const publicationResponses = [];
  const publicationHarness = childRecordFor("publication")?.harness;
  assert.ok(publicationHarness, "publication child harness was not instantiated");
  const invokePublication = publicationHarness.invoke;
  publicationHarness.invoke = async (request) => {
    publicationInputs.push(
      ...(request.inputs ?? []).map((frame) => ({
        ...frame,
        payload: new Uint8Array(frame.payload),
      })),
    );
    const response = await invokePublication(request);
    publicationResponses.push({
      statusCode: response.statusCode,
      errorCode: response.errorCode,
      errorMessage: response.errorMessage,
      outputCount: response.outputs.length,
    });
    return response;
  };
  const odStatusSnapshots = [];
  const starlinkStatusSnapshots = [];
  const statusInvocationPorts = [];
  const statusResponses = [];
  const statusHarness = childRecordFor("status")?.harness;
  assert.ok(statusHarness, "status child harness was not instantiated");
  const invokeStatus = statusHarness.invoke;
  statusHarness.invoke = async (request) => {
    const inputPorts = (request.inputs ?? []).map((input) => input.portId);
    statusInvocationPorts.push(inputPorts);
    for (const portId of inputPorts) {
      if (portId === "provider-starlink-progress") {
        recordEvent({ kind: "status-starlink-progress", portId });
      }
    }
    const response = await invokeStatus(request);
    statusResponses.push({
      statusCode: response.statusCode,
      errorCode: response.errorCode,
      errorMessage: response.errorMessage,
      outputPorts: response.outputs.map((output) => output.portId),
    });
    odStatusSnapshots.push(
      ...response.outputs
        .filter((output) => output.portId === "od.dss")
        .map((output) =>
          decodeDssRoute({
            ...output,
            payload: new Uint8Array(output.payload),
          }),
        ),
    );
    starlinkStatusSnapshots.push(
      ...response.outputs
        .filter((output) => output.portId === "provider-starlink.dss")
        .map((output) =>
          decodeDssRoute({
            ...output,
            payload: new Uint8Array(output.payload),
          }),
        ),
    );
    return response;
  };

  host.enqueueTrigger(0);
  const bootstrapped = await host.drain({
    maxIterations: 20_000,
    frameBudget: 64,
  });
  assert.ok(bootstrapped.nodesInvoked >= 1);
  assert.equal(
    hostcalls.filter(({ operation }) => operation === "http.request").length,
    0,
    "lifecycle bootstrap must not start provider fetches before APP commit",
  );
  assert.equal(publicationInputs.length, 0);
  assert.equal(publicationResponses.length, 0);

  clockNowMs += 30_000;
  host.enqueueTriggerFrame(0, {
    portId: "wakeup",
    bytes: new Uint8Array(),
  });
  const drained = await host.drain({
    maxIterations: 20_000,
    frameBudget: 64,
  });

  const nodeExecutions = {};
  const publicationInputSummary = publicationInputs.map((frame) => {
    const envelope = FSB.getRootAsFSB(
      new ByteBuffer(new Uint8Array(frame.payload)),
    );
    return {
      portId: frame.portId,
      wireFormat: frame.wireFormat,
      kind: envelope.KIND(),
      sequence: envelope.CHUNK_SEQUENCE(),
      final: envelope.FINAL(),
      totalBytes: envelope.TOTAL_BYTES().toString(),
      recordCount: envelope.RECORD_COUNT().toString(),
      schemaName: envelope.SCHEMA_NAME(),
      fileIdentifier: envelope.FILE_IDENTIFIER(),
      dataLength: envelope.dataLength(),
    };
  });
  assert.ok(
    publicationInputSummary.length > 0,
    "no canonical records reached the independently instantiated publication node",
  );
  assert.ok(
    publicationInputSummary.length >= 3 &&
      publicationInputSummary.length % 3 === 0,
    "publication must receive complete OMM/OCM/OBD aggregate sets",
  );
  const starlinkOdInvocations = odInvocations.filter(
    (requestIds) => requestIds.length > 0,
  );
  const firstStarlinkOdEvent = executionEvents.find(
    ({ kind }) => kind === "od-starlink-input",
  );
  assert.ok(firstStarlinkOdEvent, "no Starlink input reached OD");
  const expectedStarlinkEphemerisUrls = [...httpBodies.keys()].filter(
    (url) =>
      url.startsWith(defaultUrls.starlinkBase) &&
      url !== defaultUrls.starlinkManifest,
  );
  const starlinkEphemerisFetchEvents = executionEvents.filter(
    ({ kind, nodeId, operation, params }) =>
      kind === "hostcall" &&
      nodeId === "provider-starlink" &&
      operation === "http.request" &&
      expectedStarlinkEphemerisUrls.includes(params?.url),
  );
  assert.deepEqual(
    new Set(starlinkEphemerisFetchEvents.map(({ params }) => params.url)),
    new Set(expectedStarlinkEphemerisUrls),
    "the exact signed Starlink child did not fetch every complete fixture file",
  );
  assert.ok(
    starlinkEphemerisFetchEvents.every(
      ({ sequence }) => sequence < firstStarlinkOdEvent.sequence,
    ),
    `Starlink reached OD before the complete fixture was fetched: ${JSON.stringify(executionEvents.map(({ sequence, kind, nodeId, operation, portId }) => ({ sequence, kind, nodeId, operation, portId })))}`,
  );
  const committedStateEvents = executionEvents.filter(
    ({ kind, nodeId, operation, params, sequence }) =>
      kind === "hostcall" &&
      nodeId === "provider-starlink" &&
      operation === "storage.adapter.opaque.replace" &&
      params?.key === "starlink.active.v1" &&
      sequence < firstStarlinkOdEvent.sequence,
  );
  assert.ok(
    committedStateEvents.length > 0,
    "Starlink reached OD without durably replacing starlink.active.v1",
  );
  const generationCommitEvent = committedStateEvents.at(-1);
  assert.ok(
    starlinkEphemerisFetchEvents.every(
      ({ sequence }) => sequence < generationCommitEvent.sequence,
    ),
    "the generation checkpoint was committed before every complete file arrived",
  );
  const generationSyncEvent = executionEvents.find(
    ({ kind, nodeId, operation, sequence }) =>
      kind === "hostcall" &&
      nodeId === "provider-starlink" &&
      operation === "storage.adapter.opaque.sync" &&
      sequence > generationCommitEvent.sequence &&
      sequence < firstStarlinkOdEvent.sequence,
  );
  assert.ok(
    generationSyncEvent,
    "Starlink reached OD before syncing its complete generation checkpoint",
  );
  assert.equal(
    executionEvents.filter(
      ({ kind, nodeId, operation, sequence }) =>
        kind === "hostcall" &&
        nodeId === "provider-starlink" &&
        operation === "http.request" &&
        sequence > firstStarlinkOdEvent.sequence,
    ).length,
    0,
    "Starlink refetched HTTP data after storage-only drain began",
  );
  const progressOutputs = starlinkProviderOutputs.filter(
    ({ portId }) => portId === "progress",
  );
  assert.ok(progressOutputs.length > 0, "Starlink emitted no download progress");
  assert.ok(
    progressOutputs.every(
      ({ sequence }) => sequence < firstStarlinkOdEvent.sequence,
    ),
    "Starlink emitted download progress after OD drain began",
  );
  const finalDownloadProgress = decodeDssRoute(progressOutputs.at(-1));
  assert.equal(finalDownloadProgress.status, 2);
  assert.equal(finalDownloadProgress.syncedRows, 6n);
  assert.equal(finalDownloadProgress.totalRows, 6n);
  assert.equal(finalDownloadProgress.missingRows, 0n);
  const lastStarlinkFetchEvent = starlinkEphemerisFetchEvents.at(-1);
  const completedDownloadSyncEvent = executionEvents.find(
    ({ kind, nodeId, operation, sequence }) =>
      kind === "hostcall" &&
      nodeId === "provider-starlink" &&
      operation === "storage.adapter.opaque.sync" &&
      sequence > lastStarlinkFetchEvent.sequence &&
      sequence < progressOutputs.at(-1).sequence,
  );
  assert.ok(
    completedDownloadSyncEvent,
    "Starlink reported a complete download before the durable sync returned",
  );
  const starlinkProgressInputCount = statusInvocationPorts
    .flat()
    .filter((portId) => portId === "provider-starlink-progress").length;
  assert.equal(
    starlinkProgressInputCount,
    progressOutputs.length,
    "every Starlink progress snapshot must route exactly once to status",
  );
  assert.equal(
    statusInvocationPorts.flat().includes("provider-starlink"),
    false,
    "Starlink OEM must not retain the legacy status edge",
  );
  assert.ok(
    odStarlinkFrames.every(
      ({ schemaName, fileIdentifier }) =>
        schemaName !== "DSS.fbs" && fileIdentifier !== "$DSS",
    ),
    "a Starlink progress DSS was routed into OD",
  );
  assert.ok(
    starlinkStatusSnapshots.some(
      ({ status, syncedRows, totalRows, missingRows }) =>
        status === 2 &&
        syncedRows === 6n &&
        totalRows === 6n &&
        missingRows === 0n,
    ),
    "status never published the complete absolute Starlink snapshot",
  );
  assert.equal(
    starlinkOdInvocations.length,
    6,
    `Starlink must admit exactly one complete object per OD invocation: ${JSON.stringify(starlinkOdInvocations)}`,
  );
  assert.ok(
    starlinkOdInvocations.every((requestIds) => requestIds.length === 1),
    `OD received a Starlink wave containing multiple objects: ${JSON.stringify(starlinkOdInvocations)}`,
  );
  assert.equal(
    new Set(starlinkOdInvocations.flat()).size,
    6,
    "OD did not receive all six complete Starlink objects exactly once",
  );
  assert.ok(
    odStatusSnapshots.length > 0,
    `the independently instantiated status node emitted no OD runtime snapshot; OD responses=${JSON.stringify(odResponses)} status inputs=${JSON.stringify(statusInvocationPorts)} status responses=${JSON.stringify(statusResponses)}`,
  );
  assert.ok(odResponses.length > 0, "OD node was never invoked");
  for (const response of odResponses) {
    assert.equal(
      response.statusCode,
      0,
      `OD invocation failed instead of continuing: ${JSON.stringify(response)}`,
    );
  }
  assert.ok(statusResponses.length > 0, "status node was never invoked");
  for (const response of statusResponses) {
    assert.equal(
      response.statusCode,
      0,
      `status invocation failed: ${JSON.stringify(response)}`,
    );
  }
  const finalOdStatus = odStatusSnapshots.at(-1);
  assert.equal(finalOdStatus.status, 4, finalOdStatus.error);
  assert.match(finalOdStatus.error, /od-native-parse/);
  assert.equal(finalOdStatus.attempts, 10n);
  assert.equal(finalOdStatus.syncedRows, 9n);
  assert.equal(finalOdStatus.totalRows, 10n);
  assert.equal(finalOdStatus.missingRows, 1n);
  const firstFailureIndex = odStatusSnapshots.findIndex(
    (snapshot) => snapshot.status === 4 && /od-native-parse/.test(snapshot.error),
  );
  assert.ok(firstFailureIndex >= 0, "OD parse failure never reached od.dss");
  assert.ok(
    odStatusSnapshots
      .slice(firstFailureIndex + 1)
      .some(
        (snapshot) =>
          snapshot.syncedRows > odStatusSnapshots[firstFailureIndex].syncedRows,
      ),
    "no valid OD object advanced after the sticky parse failure",
  );
  assert.ok(publicationResponses.length > 0);
  for (const summary of publicationInputSummary) {
    assert.equal(summary.portId, "records");
    assert.equal(summary.kind, 1);
    assert.equal(summary.sequence, 0);
    assert.equal(summary.final, true);
    assert.ok(Number(summary.recordCount) > 0);
    assert.ok(["OMM", "OCM", "OBD"].includes(summary.schemaName));
    assert.equal(summary.fileIdentifier, `$${summary.schemaName}`);
    assert.equal(summary.dataLength, Number(summary.totalBytes));
  }
  for (const standard of ["OMM", "OCM", "OBD"]) {
    assert.equal(
      publicationInputSummary
        .filter((summary) => summary.schemaName === standard)
        .reduce((total, summary) => total + Number(summary.recordCount), 0),
      expectedRecordsPerStandard,
      `${standard} aggregate batches did not preserve the full fitted catalog`,
    );
  }
  for (const response of publicationResponses) {
    assert.equal(response.statusCode, 0);
  }
  for (let index = 0; index < host.nodeCount; index += 1) {
    const descriptor = host.getNodeDispatchDescriptor(index);
    const state = host.getNodeState(index);
    nodeExecutions[descriptor.nodeId] = state.invocationCount;
    assert.ok(
      state.invocationCount > 0n,
      `signed graph node ${descriptor.nodeId} was never invoked`,
    );
    assert.equal(
      state.lastStatus,
      0,
      `signed graph node ${descriptor.nodeId} did not complete successfully; publication inputs=${JSON.stringify(publicationInputSummary)} responses=${JSON.stringify(publicationResponses)} hostcalls=${JSON.stringify(hostcalls.map(({ nodeId, operation }) => ({ nodeId, operation })))}`,
    );
    assert.equal(state.ready, false, `${descriptor.nodeId} remained ready`);
    assert.equal(state.queuedFrames, 0, `${descriptor.nodeId} retained queued frames`);
    assert.equal(
      state.backlogRemaining,
      0,
      `${descriptor.nodeId} retained child backlog`,
    );
  }
  assert.deepEqual(
    Object.keys(nodeExecutions).sort(),
    Object.keys(expectedChildSha256).sort(),
  );
  assert.ok(drained.nodesInvoked >= Object.keys(expectedChildSha256).length);
  assert.equal(drained.handlersSkipped, 0);
  const routing = host.getRoutingState();
  assert.ok(
    routing.canonicalRoutes > 0n,
    "separate child instances never exercised canonical fallback routing",
  );
  assert.equal(routing.alignedSharedRoutes, 0n);
  assert.equal(routing.alignedCopiedRoutes, 0n);
  assert.equal(routing.rejectedFrames, 0n);
  assert.deepEqual(
    new Set(
      hostcalls
        .filter(({ operation }) => operation === "http.request")
        .map(({ params }) => params.url),
    ),
    new Set(httpBodies.keys()),
  );
  const publications = hostcalls.filter(
    ({ operation }) => operation === "pubsub.publish",
  );
  assert.ok(
    publications.length > 0,
    "fitted records never reached the independently instantiated publication node",
  );
  assert.equal(publications.length, expectedRecordsPerStandard * 3);
  for (const standard of ["OMM", "OCM", "OBD"]) {
    assert.equal(
      publications.filter(({ params }) => params.standard === standard).length,
      expectedRecordsPerStandard,
    );
  }
  for (const { params } of publications) {
    assert.equal(params.source, "supplemental-omm");
    assert.ok(["OMM", "OCM", "OBD"].includes(params.standard));
    assert.ok(params.data instanceof Uint8Array && params.data.byteLength > 8);
    const expectedIdentifier = `$${params.standard}`;
    assert.ok(
      [4, 8].some(
        (offset) =>
          new TextDecoder().decode(params.data.subarray(offset, offset + 4)) ===
          expectedIdentifier,
      ),
      `pubsub payload is not the inner canonical ${expectedIdentifier} record`,
    );
  }
  const opaqueCalls = hostcalls.filter(({ nodeId, operation }) =>
    nodeId === "store" && operation.startsWith("storage.adapter.opaque."),
  );
  assert.ok(
    opaqueCalls.some(({ operation }) => operation === "storage.adapter.opaque.replace"),
    "FlatSQL never persisted its node-owned snapshot",
  );
  assert.ok(
    opaqueCalls.some(({ operation }) => operation === "storage.adapter.opaque.sync"),
    "FlatSQL never committed its node-owned snapshot",
  );
  assert.ok(
    [...opaqueValues.keys()].some((key) => key.endsWith("\0snapshot.manifest")),
    "FlatSQL did not retain a committed snapshot manifest",
  );
});

test("fresh exact signed Starlink instances reload committed opaque waves without refetching", async (t) => {
  const published = new Uint8Array(fs.readFileSync(releaseArtifactPath));
  assert.equal(sha256(published), expectedOuterSha256);

  const parsed = await parseSingleFileBundle(published);
  const entries = new Map(parsed.entries.map((entry) => [entry.entryId, entry]));
  const artifact = parseJsonEntry(entries.get("artifact.json"), "artifact.json");
  const descriptor = artifact.nodeArtifacts.find(
    ({ nodeId }) => nodeId === "provider-starlink",
  );
  assert.ok(descriptor, "signed outer bundle has no Starlink child descriptor");
  const childEntry = entries.get(descriptor.entryId);
  assert.ok(childEntry, `signed bundle is missing ${descriptor.entryId}`);
  const exactChildBytes = new Uint8Array(childEntry.payloadBytes);
  assert.equal(sha256(exactChildBytes), descriptor.sha256);
  assert.equal(descriptor.sha256, expectedChildSha256[descriptor.nodeId]);
  const childPublisher = parseJsonEntry(
    entries.get(descriptor.publisherEntryId),
    descriptor.publisherEntryId,
  );
  assert.equal(childPublisher.publicKeyHex, trustedReleaseSigner);
  assert.equal(childPublisher.developmentOnly, false);

  const httpBodies = fixtureResponses();
  const filenames = new TextDecoder()
    .decode(httpBodies.get(defaultUrls.starlinkManifest))
    .trim()
    .split(/\r?\n/u);
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
        fetchConcurrency: 4,
        batchSize: 4,
      }),
    ],
  });
  assert.equal(firstWave.statusCode, 0, firstWave.errorMessage);
  assert.deepEqual(firstWave.outputs.map(({ portId }) => portId), ["progress"]);
  const firstProgress = decodeDssRoute(firstWave.outputs[0]);
  assert.equal(firstProgress.status, 1);
  assert.equal(firstProgress.syncedRows, 4n);
  assert.equal(firstProgress.totalRows, BigInt(filenames.length));
  assert.equal(firstProgress.missingRows, BigInt(filenames.length - 4));
  assert.deepEqual(
    new Set(httpCalls),
    new Set([defaultUrls.starlinkManifest, ...ephemerisUrls.slice(0, 4)]),
  );
  const firstStateCommit = opaque.calls.findLastIndex(
    ({ operation, params }) =>
      operation === "storage.adapter.opaque.replace" &&
      params.key === "starlink.active.v1",
  );
  assert.ok(firstStateCommit >= 0, "first wave never committed its state");
  assert.ok(
    opaque.calls.findIndex(
      ({ operation }, index) =>
        index > firstStateCommit &&
        operation === "storage.adapter.opaque.sync",
    ) > firstStateCommit,
    "first wave state was not synced",
  );
  destroy(first);

  const httpCountBeforeResume = httpCalls.length;
  const opaqueCallCountBeforeResume = opaque.calls.length;
  const resumed = await createExactChild();
  assert.deepEqual(new Uint8Array(resumed.readManifest()), signedManifest);
  const replayedWave = await resumed.invoke({
    methodId: "emit",
    inputs: [],
  });
  assert.equal(replayedWave.statusCode, 0, replayedWave.errorMessage);
  assert.deepEqual(replayedWave.outputs.map(({ portId }) => portId), ["progress"]);
  const replayedProgress = decodeDssRoute(replayedWave.outputs[0]);
  assert.equal(replayedProgress.status, 1);
  assert.equal(replayedProgress.syncedRows, 4n);
  assert.equal(
    httpCalls.length,
    httpCountBeforeResume,
    "fresh exact child performed HTTP before replaying committed progress",
  );
  const completedDownload = await resumed.invoke({
    methodId: "emit",
    inputs: [],
  });
  assert.equal(completedDownload.statusCode, 0, completedDownload.errorMessage);
  assert.deepEqual(
    completedDownload.outputs.map(({ portId }) => portId),
    ["progress"],
  );
  const completedProgress = decodeDssRoute(completedDownload.outputs[0]);
  assert.equal(completedProgress.status, 2);
  assert.equal(completedProgress.syncedRows, BigInt(filenames.length));
  assert.equal(completedProgress.totalRows, BigInt(filenames.length));
  assert.equal(completedProgress.missingRows, 0n);
  assert.deepEqual(
    new Set(httpCalls.slice(httpCountBeforeResume)),
    new Set(ephemerisUrls.slice(4)),
    "fresh exact child refetched an already committed file or manifest",
  );
  const resumedCalls = opaque.calls.slice(opaqueCallCountBeforeResume);
  const completeStateCommit = resumedCalls.findLastIndex(
    ({ operation, params }) =>
      operation === "storage.adapter.opaque.replace" &&
      params.key === "starlink.active.v1",
  );
  assert.ok(completeStateCommit >= 0, "resumed wave never committed its state");
  assert.ok(
    resumedCalls.findIndex(
      ({ operation }, index) =>
        index > completeStateCommit &&
        operation === "storage.adapter.opaque.sync",
    ) > completeStateCommit,
    "complete generation state was not synced",
  );
  destroy(resumed);

  const httpCountBeforeDrain = httpCalls.length;
  const draining = await createExactChild();
  assert.deepEqual(new Uint8Array(draining.readManifest()), signedManifest);
  const replayedCompletion = await draining.invoke({
    methodId: "emit",
    inputs: [],
  });
  assert.equal(
    replayedCompletion.statusCode,
    0,
    replayedCompletion.errorMessage,
  );
  assert.deepEqual(
    replayedCompletion.outputs.map(({ portId }) => portId),
    ["progress"],
  );
  assert.equal(decodeDssRoute(replayedCompletion.outputs[0]).status, 2);
  assert.equal(
    httpCalls.length,
    httpCountBeforeDrain,
    "fresh fully committed child performed HTTP before replaying completion",
  );
  const firstDrainedFile = await draining.invoke({
    methodId: "emit",
    inputs: [],
  });
  assert.equal(firstDrainedFile.statusCode, 0, firstDrainedFile.errorMessage);
  assert.ok(firstDrainedFile.yielded, "catalog drain stopped after one file");
  assert.ok(firstDrainedFile.outputs.length > 0);
  assert.ok(
    firstDrainedFile.outputs.every(({ portId }) => portId === "oem"),
    "storage-only drain emitted a non-OEM frame",
  );
  assert.equal(
    httpCalls.length,
    httpCountBeforeDrain,
    "fresh fully committed child refetched instead of draining opaque state",
  );
  const drainedChunks = firstDrainedFile.outputs.map(({ payload }) =>
    decodeProviderFsb(payload),
  );
  assert.ok(drainedChunks.at(-1).final);
  assert.deepEqual(
    Buffer.concat(drainedChunks.map(({ data }) => Buffer.from(data))),
    Buffer.from(httpBodies.get(ephemerisUrls[0])),
    "fresh exact child did not drain the first complete file in manifest order",
  );
  destroy(draining);
});
