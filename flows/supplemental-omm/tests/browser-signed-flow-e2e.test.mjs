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
import { ByteBuffer } from "../../../../spacedatastandards.org/node_modules/flatbuffers/js/flatbuffers.js";
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
  "95bfebfff875d637850546ced267a9765548c1bd905b3021b8c7f1573729ec26";
const expectedChildSha256 = Object.freeze({
  timer: "db8d7a3506a0c3188b006886ebea30cfda9e9c2c2b9c477baefb5c37a375d6bd",
  "provider-starlink":
    "119590576d4a92857afbe595676eb501288211214bf88c127d51751a03fca4d5",
  "provider-glonass":
    "321373d51d9eae4baa8dd11552a1711d7a6fe1a37f5d3391df483a4e691c5ad5",
  "provider-intelsat":
    "1fd325db5d4e54bcf751c63a518052e653872a9a2d26a2f1d8cb92fd1416f551",
  "provider-cpf":
    "684c822c77537a620c85bcf920ff678e5125553bf07a77600a47b7d96f74dc2a",
  "provider-iss":
    "e5a0c7070dbe7875c363d85ca2de220daa31dba747a6e550e0324e38a0a70ca8",
  od: "9cb9d62b3652d0af088a7e9da350e4f2d0e4abaa539c1665dc43a6379aa6f48a",
  store:
    "593bd94c0964835c5077a60973cd1da42f5ccf1f5ca63dcd71a82e59df97a93e",
  publication:
    "18a8ef6baaef1b92e7f93940ced3233ab2fa83512fd808b48b6c34b49681ce61",
  status:
    "1e8fc3234578902743a68d8da4be23151aa78bc81512d3b0144f5404a1ddb342",
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function encode(text) {
  return new TextEncoder().encode(text);
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
  const starlinkFilenames = Array.from({ length: 5 }, (_, index) =>
    index === 0
      ? starlinkFixtureFilename
      : `MEME_${67850 + index}_STARLINK-${36840 + index}_1340142_Operational_1463017380_UNCLASSIFIED.txt`,
  );
  const starlink = new Uint8Array(
    fs.readFileSync(
      path.resolve(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme",
        starlinkFixtureFilename,
      ),
    ),
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
      starlink,
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

function parseJsonEntry(entry, label) {
  assert.ok(entry, `signed bundle is missing ${label}`);
  return JSON.parse(new TextDecoder().decode(entry.payloadBytes));
}

test("exact release-signed Supplemental flow executes every signed child in the browser host", async (t) => {
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
        hostcalls.push({
          nodeId: descriptor.nodeId,
          operation,
          params:
            params?.records instanceof Uint8Array
              ? { ...params, records: new Uint8Array(params.records) }
              : structuredClone(params),
        });
        if (operation === "clock.now") return clockNowMs;
        if (operation === "timers.arm" || operation === "timers.cancel") {
          return { accepted: true };
        }
        if (operation === "http.request") {
          const body = httpBodies.get(params?.url);
          assert.ok(body, `no complete browser fixture for ${params?.url}`);
          assert.equal(params.method, "GET");
          assert.equal(
            params.headers?.Range,
            undefined,
            "signed provider attempted a prefix/range sample",
          );
          assert.ok(
            params.max_bytes >= body.byteLength,
            "signed provider response ceiling cannot hold the complete fixture",
          );
          return { status: 200, body: new Uint8Array(body) };
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
  for (const descriptor of artifact.nodeArtifacts) {
    assert.equal(
      host.children.get(descriptor.nodeId)?.sha256,
      expectedChildSha256[descriptor.nodeId],
      `${descriptor.nodeId} browser instance did not retain the exact signed child hash`,
    );
  }
  const odInvocations = [];
  const odHarness = host.children.get("od")?.harness;
  assert.ok(odHarness, "OD child harness was not instantiated");
  const invokeOd = odHarness.invoke;
  odHarness.invoke = async (request) => {
    const starlinkRequestIds = new Set(
      (request.inputs ?? [])
        .filter((frame) => frame.portId === "starlink")
        .map((frame) =>
          FSB.getRootAsFSB(
            new ByteBuffer(new Uint8Array(frame.payload)),
          ).REQUEST_ID().toString(),
        ),
    );
    odInvocations.push([...starlinkRequestIds]);
    return invokeOd(request);
  };
  const publicationInputs = [];
  const publicationResponses = [];
  const publicationHarness = host.children.get("publication")?.harness;
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
  assert.ok(
    starlinkOdInvocations.length >= 2,
    `five Starlink objects were coalesced into one OD invocation: ${JSON.stringify(starlinkOdInvocations)}`,
  );
  assert.ok(
    starlinkOdInvocations.every((requestIds) => requestIds.length <= 4),
    `OD received a Starlink wave above four objects: ${JSON.stringify(starlinkOdInvocations)}`,
  );
  assert.equal(
    new Set(starlinkOdInvocations.flat()).size,
    5,
    "OD did not receive all five complete Starlink objects exactly once",
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
