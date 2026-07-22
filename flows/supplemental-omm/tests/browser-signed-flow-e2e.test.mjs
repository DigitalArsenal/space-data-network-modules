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
  "32b5af1af6608e8a1a907d7a7a9646b80104a1f51c0e5cb9af005f04a29bf8c1";
const expectedChildSha256 = Object.freeze({
  timer: "c712e5714b80854d60334b198fe1e17c29e4e22e274e7339eba370f26fa1db56",
  "provider-starlink":
    "79051ff42a6adc6be46758cb770aba523546f81aa85d906d4a4946c1a86a967d",
  "provider-glonass":
    "b674a723bb2fc2e7e5600cc8a9f5b80e9327231a61b9d8f13291e1e685df14ca",
  "provider-intelsat":
    "e536bf0e92447edfc59c9f669d750dd03f0e23b05b2ee87cabb9163c4657f683",
  "provider-cpf":
    "e6490d06b020e465dc6fc8461f8d5b3de265c5bb7ac33dd20ef40931df0b43bc",
  "provider-iss":
    "9fe7da6a04f6abc79771aefcecc1917982233f2b374a7ff1da6324441a5f3f17",
  od: "c7951ee0c929e273df01d1f33c30b759a62cbb8a9f5fd5886c115f8d0126869b",
  store:
    "63001a3eefa9cb287e4fc04efea012793cb90424a85f2013b7192cb7f95c2204",
  publication:
    "9231337a2b715e74abd58662b900c6217a019c0d7961a8e1b5ed5f47751711aa",
  status:
    "091231053b026ce26e7cbdf8ebe7f3791e433a28f1a11403a38835f153eeeca9",
});

const fsoIdentity = Object.freeze({
  schemaName: "FSO.fbs",
  fileIdentifier: "$FSO",
  schemaVersion: "1.158.2",
  schemaHash:
    "a298ef96af29624073edf749848e8ff1e5b8f45e56966c2e210cb719f3c5e821",
  rootTypeName: "FSO",
});
const emptyFso = new Uint8Array([
  12, 0, 0, 0,
  36, 70, 83, 79,
  4, 0, 4, 0,
  4, 0, 0, 0,
]);

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
  const starlinkFilename =
    "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt";
  const starlink = new Uint8Array(
    fs.readFileSync(
      path.resolve(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme",
        starlinkFilename,
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
    [defaultUrls.starlinkManifest, encode(`${starlinkFilename}\n`)],
    [`${defaultUrls.starlinkBase}${starlinkFilename}`, starlink],
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
  const hostcalls = [];
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
        if (operation === "clock.now") return Date.parse("2026-07-21T12:34:56Z");
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
      host.children.get(descriptor.pluginId)?.sha256,
      expectedChildSha256[descriptor.nodeId],
      `${descriptor.nodeId} browser instance did not retain the exact signed child hash`,
    );
  }
  const publicationInputs = [];
  const publicationResponses = [];
  const publicationHarness = host.children.get(
    "org.sdn.flows.supplemental-omm.publication",
  )?.harness;
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

  host.enqueueTriggerFrame(0, {
    portId: "wakeup",
    bytes: emptyFso,
    typeRef: {
      ...fsoIdentity,
      schemaHash: [...Buffer.from(fsoIdentity.schemaHash, "hex")],
      wireFormat: "flatbuffer",
    },
    wireFormat: "flatbuffer",
    ownership: "host-owned",
    mutability: "immutable",
    endOfStream: true,
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
  assert.ok(publicationResponses.length > 0);
  for (const summary of publicationInputSummary) {
    assert.equal(summary.portId, "records");
    assert.equal(summary.kind, 1);
    assert.equal(summary.sequence, 0);
    assert.equal(summary.final, true);
    assert.equal(summary.recordCount, "1");
    assert.ok(["OMM", "OCM", "OBD"].includes(summary.schemaName));
    assert.equal(summary.fileIdentifier, `$${summary.schemaName}`);
    assert.equal(summary.dataLength, Number(summary.totalBytes));
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
});
