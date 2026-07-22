import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Builder, ByteBuffer } from "../../../../../ancillary-packages/space-data-module-sdk/node_modules/flatbuffers/js/flatbuffers.js";
import { DSS } from "../../../../spacedatastandards.org/lib/js/DSS/DSS.js";
import { FSB } from "../../../../spacedatastandards.org/lib/js/FSB/FSB.js";
import {
  extractPublicationRecordCollection,
  verifyModuleArtifact,
} from "../../../node_modules/space-data-module-sdk/src/index.js";
import { createBrowserModuleHarness } from "../../../node_modules/space-data-module-sdk/src/testing/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fsbType = {
  schemaName: "FSB.fbs",
  fileIdentifier: "$FSB",
  schemaVersion: "1.158.1",
  schemaHash: "0b23aa63d0e3f17d828fc84dd433605c2794cb81ade7c043cb200e954c84e945",
  rootTypeName: "FSB",
};
const fsbAlignedByteLength = 1_048_744;
const fsbRequiredAlignment = 8;
const fsoType = {
  schemaName: "FSO.fbs",
  fileIdentifier: "$FSO",
  schemaVersion: "1.158.2",
  schemaHash: "a298ef96af29624073edf749848e8ff1e5b8f45e56966c2e210cb719f3c5e821",
  rootTypeName: "FSO",
};
const fsoAlignedByteLength = 361_648;
const fsoRequiredAlignment = 8;
const nodeSpecs = [
  {
    key: "status",
    pluginId: "org.sdn.flows.supplemental-omm.status",
    methodId: "record_event",
    capabilities: [],
  },
  {
    key: "publication",
    pluginId: "org.sdn.flows.supplemental-omm.publication",
    methodId: "publish_records",
    capabilities: ["pubsub"],
  },
];
const statusRoutes = [
  ["provider-starlink", "provider-starlink.dss"],
  ["provider-glonass", "provider-glonass.dss"],
  ["provider-intelsat", "provider-intelsat.dss"],
  ["provider-cpf", "provider-cpf.dss"],
  ["provider-iss", "provider-iss.dss"],
  ["store", "store.dss"],
];

function nodePath(key, ...parts) {
  return path.join(packageRoot, "nodes", key, ...parts);
}

function readJson(filePath, description) {
  assert.ok(fs.existsSync(filePath), `${description} is missing: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertPair(port, location) {
  assert.equal(port?.acceptedTypeSets?.length, 1, `${location} needs one type set`);
  const types = port.acceptedTypeSets[0]?.allowedTypes ?? [];
  assert.equal(types.length, 2, `${location} needs exactly two representations`);
  const canonical = types.find(
    (type) => (type.wireFormat ?? "flatbuffer") === "flatbuffer",
  );
  const aligned = types.find((type) => type.wireFormat === "aligned-binary");
  assert.ok(canonical, `${location} needs canonical FlatBuffer`);
  assert.ok(aligned, `${location} needs aligned-binary`);
  for (const property of [
    "schemaName",
    "fileIdentifier",
    "schemaVersion",
    "schemaHash",
    "rootTypeName",
  ]) {
    assert.equal(aligned[property] ?? null, canonical[property] ?? null);
  }
  assert.equal(Number.isSafeInteger(aligned.byteLength) && aligned.byteLength > 0, true);
  assert.equal(
    Number.isSafeInteger(aligned.requiredAlignment) && aligned.requiredAlignment > 0,
    true,
  );
}

function makeFsb(
  data = new Uint8Array([1, 2, 3, 4]),
  {
    schemaName: recordSchemaName = "OMM",
    fileIdentifier = "$OMM",
    recordCount = 1,
    totalBytes = data.length,
  } = {},
) {
  const builder = new Builder(256);
  const schemaName = builder.createString(recordSchemaName);
  const identifier = builder.createString(fileIdentifier);
  builder.startVector(1, data.length, 1);
  for (let index = data.length - 1; index >= 0; index -= 1) {
    builder.addInt8(data[index]);
  }
  const dataVector = builder.endVector();
  builder.startObject(11);
  builder.addFieldInt64(0, 1n, 0n);
  builder.addFieldInt8(1, 1, 0);
  builder.addFieldInt8(3, 1, 0);
  builder.addFieldInt64(4, BigInt(totalBytes), 0n);
  builder.addFieldInt64(5, BigInt(recordCount), 0n);
  builder.addFieldOffset(7, schemaName, 0);
  builder.addFieldOffset(8, identifier, 0);
  builder.addFieldOffset(9, dataVector, 0);
  const root = builder.endObject();
  builder.finish(root, "$FSB");
  return builder.asUint8Array();
}

function makeFsoStatus({
  affectedRecords,
  resultBytes = 0,
  status = 4,
  errorCode = "",
  message = new Uint8Array(),
}) {
  const builder = new Builder(256);
  const errorCodeOffset = errorCode ? builder.createString(errorCode) : 0;
  const messageBytes =
    message instanceof Uint8Array ? message : new TextEncoder().encode(message);
  let messageOffset = 0;
  if (messageBytes.length > 0) {
    builder.startVector(1, messageBytes.length, 1);
    for (let index = messageBytes.length - 1; index >= 0; index -= 1) {
      builder.addInt8(messageBytes[index]);
    }
    messageOffset = builder.endVector();
  }
  builder.startObject(21);
  builder.addFieldInt8(16, status, 0);
  builder.addFieldInt64(17, BigInt(affectedRecords), 0n);
  builder.addFieldInt64(18, BigInt(resultBytes), 0n);
  if (errorCodeOffset) builder.addFieldOffset(19, errorCodeOffset, 0);
  if (messageOffset) builder.addFieldOffset(20, messageOffset, 0);
  const root = builder.endObject();
  builder.finish(root, "$FSO");
  return builder.asUint8Array();
}

function makeAlignedFsoStatus({ affectedRecords, resultBytes = 0, status = 4 }) {
  const payload = new Uint8Array(fsoAlignedByteLength);
  const view = new DataView(payload.buffer);
  payload[357_392] = status;
  view.setBigUint64(357_400, BigInt(affectedRecords), true);
  view.setBigUint64(357_408, BigInt(resultBytes), true);
  return payload;
}

function makeAlignedFsb(
  data,
  { schemaName = "OCM", fileIdentifier = "$OCM" } = {},
) {
  const payload = new Uint8Array(fsbAlignedByteLength);
  const view = new DataView(payload.buffer);
  payload[0] = 0b0000_0111;
  view.setBigUint64(8, 1n, true);
  payload[16] = 1;
  view.setUint32(20, 0, true);
  payload[24] = 1;
  view.setBigUint64(32, BigInt(data.length), true);
  view.setBigUint64(40, 1n, true);
  payload[52] = schemaName.length;
  payload.set(new TextEncoder().encode(schemaName), 53);
  payload[117] = fileIdentifier.length;
  payload.set(new TextEncoder().encode(fileIdentifier), 118);
  view.setUint32(124, data.length, true);
  payload.set(data, 128);
  return payload;
}

function inputFrame(payload, portId, wireFormat = "flatbuffer") {
  const aligned = wireFormat === "aligned-binary";
  return {
    portId,
    wireFormat,
    typeRef: {
      ...fsbType,
      schemaHash: [...Buffer.from(fsbType.schemaHash, "hex")],
      wireFormat,
      ...(aligned
        ? {
            byteLength: fsbAlignedByteLength,
            requiredAlignment: fsbRequiredAlignment,
          }
        : {}),
    },
    payload,
  };
}

function fsoInputFrame(payload, wireFormat = "flatbuffer") {
  const aligned = wireFormat === "aligned-binary";
  return {
    portId: "store",
    wireFormat,
    typeRef: {
      ...fsoType,
      schemaHash: [...Buffer.from(fsoType.schemaHash, "hex")],
      wireFormat,
      ...(aligned
        ? {
            byteLength: fsoAlignedByteLength,
            requiredAlignment: fsoRequiredAlignment,
          }
        : {}),
    },
    payload,
  };
}

function decodeStatusDss(output) {
  let dssBytes;
  if (output.wireFormat === "aligned-binary") {
    const payload = new Uint8Array(output.payload);
    const length = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    ).getUint32(124, true);
    dssBytes = payload.subarray(128, 128 + length);
  } else {
    const envelope = FSB.getRootAsFSB(
      new ByteBuffer(new Uint8Array(output.payload)),
    );
    dssBytes = new Uint8Array(envelope.dataArray() ?? []);
  }
  assert.equal(new TextDecoder().decode(dssBytes.subarray(8, 12)), "$DSS");
  const dss = DSS.getSizePrefixedRootAsDSS(new ByteBuffer(dssBytes));
  return {
    status: dss.STATUS(),
    syncedRows: dss.SYNCED_ROWS(),
    totalRows: dss.TOTAL_ROWS(),
    downloadedBytes: dss.DOWNLOADED_BYTES(),
    error: dss.ERROR() ?? "",
  };
}

async function createHarness(spec, hostcallDispatch) {
  const manifest = readJson(
    nodePath(spec.key, "plugin-manifest.json"),
    `${spec.key} manifest`,
  );
  const signed = new Uint8Array(
    fs.readFileSync(nodePath(spec.key, "dist/isomorphic/module.wasm")),
  );
  const portable = extractPublicationRecordCollection(signed)?.payloadBytes ?? signed;
  return createBrowserModuleHarness({
    wasmSource: portable,
    manifest,
    surface: "direct",
    ...(hostcallDispatch ? { hostcallDispatch } : {}),
  });
}

for (const spec of nodeSpecs) {
  test(`${spec.key} is an explicit dual-representation isomorphic node`, () => {
    const manifest = readJson(
      nodePath(spec.key, "plugin-manifest.json"),
      `${spec.key} manifest`,
    );
    assert.equal(manifest.pluginId, spec.pluginId);
    assert.deepEqual([...(manifest.runtimeTargets ?? [])].sort(), ["browser", "wasmedge"]);
    assert.deepEqual(manifest.invokeSurfaces, ["direct"]);
    assert.deepEqual(manifest.capabilities ?? [], spec.capabilities);
    const method = manifest.methods?.find(
      (candidate) => candidate.methodId === spec.methodId,
    );
    assert.ok(method, `missing ${spec.methodId}`);
    for (const port of method.inputPorts ?? []) {
      assertPair(port, `${spec.methodId}.${port.portId}`);
    }
    for (const port of method.outputPorts ?? []) {
      assertPair(port, `${spec.methodId}.${port.portId}`);
    }
    if (spec.key === "status") {
      assert.deepEqual(
        method.inputPorts.map((port) => port.portId),
        statusRoutes.map(([inputPortId]) => inputPortId),
      );
      assert.deepEqual(
        method.outputPorts.map((port) => port.portId),
        statusRoutes.map(([, outputPortId]) => outputPortId),
      );
      const storePort = method.inputPorts.find((port) => port.portId === "store");
      assert.equal(
        storePort.acceptedTypeSets[0].allowedTypes[0].fileIdentifier,
        "$FSO",
        "store status must consume FlatSQL's typed operation result",
      );
    }
  });

  test(`${spec.key} artifact is independently bundle-signed`, async () => {
    const artifactPath = nodePath(spec.key, "dist/isomorphic/module.wasm");
    assert.ok(fs.existsSync(artifactPath), `${spec.key} artifact is missing`);
    const publisher = readJson(
      nodePath(spec.key, "publisher.json"),
      `${spec.key} publisher record`,
    );
    const verified = await verifyModuleArtifact(fs.readFileSync(artifactPath), {
      trustedPublicKeys: [publisher.publicKeyHex],
      requireSignature: true,
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.signatureScope, "bundle");
  });
}

test("status node owns application status aggregation and emits FSB-wrapped DSS", async (t) => {
  const harness = await createHarness(nodeSpecs[0]);
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "record_event",
    inputs: [inputFrame(makeFsb(), "provider-starlink")],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "provider-starlink.dss");
  assert.equal(response.outputs[0].typeRef?.fileIdentifier, "$FSB");
  assert.equal(
    new TextDecoder().decode(response.outputs[0].payload.subarray(4, 8)),
    "$FSB",
  );
  const envelope = FSB.getRootAsFSB(
    new ByteBuffer(new Uint8Array(response.outputs[0].payload)),
  );
  const dss = new Uint8Array(envelope.dataArray() ?? []);
  assert.equal(
    new TextDecoder().decode(dss.subarray(8, 12)),
    "$DSS",
    "runtime route payload is a canonical size-prefixed DSS record",
  );
});

test("status node counts provider records and actual chunk bytes without multiplying TOTAL_BYTES", async (t) => {
  const harness = await createHarness(nodeSpecs[0]);
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "record_event",
    inputs: [
      inputFrame(
        makeFsb(new Uint8Array([1, 2, 3]), {
          recordCount: 2,
          totalBytes: 10_000,
        }),
        "provider-starlink",
      ),
      inputFrame(
        makeFsb(new Uint8Array([4, 5, 6, 7, 8]), {
          recordCount: 3,
          totalBytes: 10_000,
        }),
        "provider-starlink",
      ),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const status = decodeStatusDss(response.outputs[0]);
  assert.equal(status.syncedRows, 5n);
  assert.equal(status.totalRows, 5n, "DSS row fields must use the same unit");
  assert.equal(status.downloadedBytes, 8n, "count each DATA byte exactly once");
  assert.equal(
    status.status,
    1,
    "FSB FINAL closes one native stream, not the provider's yielded backlog",
  );
});

test("status node surfaces FlatSQL operation failures instead of reporting a silent zero", async (t) => {
  const harness = await createHarness(nodeSpecs[0]);
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "record_event",
    inputs: [
      fsoInputFrame(
        makeFsoStatus({
          affectedRecords: 0,
          status: 5,
          errorCode: "invalid-record",
          message: "record schema rejected",
        }),
      ),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const status = decodeStatusDss(response.outputs[0]);
  assert.equal(status.status, 4);
  assert.match(status.error, /invalid-record/);
  assert.match(status.error, /record schema rejected/);
});

for (const testCase of [
  {
    name: "canonical",
    wireFormat: "flatbuffer",
    payload: makeFsoStatus({ affectedRecords: 7, resultBytes: 91 }),
  },
  {
    name: "aligned",
    wireFormat: "aligned-binary",
    payload: makeAlignedFsoStatus({ affectedRecords: 11, resultBytes: 123 }),
  },
]) {
  test(`status node reports ${testCase.name} FlatSQL FSO persistence results`, async (t) => {
    const harness = await createHarness(nodeSpecs[0]);
    t.after(() => harness.destroy());
    const response = await harness.invoke({
      methodId: "record_event",
      inputs: [fsoInputFrame(testCase.payload, testCase.wireFormat)],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs[0].portId, "store.dss");
    const status = decodeStatusDss(response.outputs[0]);
    const expectedRecords = testCase.name === "canonical" ? 7n : 11n;
    const expectedBytes = testCase.name === "canonical" ? 91n : 123n;
    assert.equal(status.syncedRows, expectedRecords);
    assert.equal(status.totalRows, expectedRecords);
    assert.equal(status.downloadedBytes, expectedBytes);
  });
}

test("flow routes FlatSQL status directly to the signed status node", () => {
  const flow = readJson(path.join(packageRoot, "flow.json"), "flow source");
  assert.ok(
    flow.edges.some(
      (edge) =>
        edge.edgeId === "store-status-to-status" &&
        edge.fromNodeId === "store" &&
        edge.fromPortId === "status" &&
        edge.toNodeId === "status" &&
        edge.toPortId === "store",
    ),
  );
  assert.equal(
    flow.edges.some((edge) => edge.edgeId === "publication-to-status"),
    false,
  );
});

test("signed status output keys exactly match every APP runtime node route", () => {
  const manifest = readJson(
    nodePath("status", "plugin-manifest.json"),
    "status manifest",
  );
  const method = manifest.methods.find((candidate) => candidate.methodId === "record_event");
  const outputKeys = method.outputPorts.map((port) => port.portId).sort();
  const app = readJson(path.join(packageRoot, "app/app.json"), "APP manifest");
  const appKeys = app.dataflow.map((route) => path.basename(route.locator)).sort();
  assert.deepEqual(outputKeys, appKeys);

  const flow = readJson(path.join(packageRoot, "flow.json"), "flow source");
  assert.deepEqual(
    flow.runtimeNodeRoutes,
    outputKeys.map((key) => ({
      key,
      nodeId: "status",
      portId: key,
      mediaType: "application/x-flatbuffers",
    })),
  );
});

test("publication node publishes the exact inner SDS record through generic pubsub", async (t) => {
  const record = new Uint8Array([8, 6, 7, 5, 3, 0, 9]);
  const payload = makeFsb(record);
  const calls = [];
  const harness = await createHarness(nodeSpecs[1], (operation, params) => {
    // Hostcall binary leaves are zero-copy views into guest memory. Snapshot
    // at dispatch time, before the guest reuses its request arena.
    calls.push({
      operation,
      params: { ...params, data: new Uint8Array(params.data) },
    });
    if (operation === "pubsub.publish") return true;
    throw new Error(`publication node called forbidden operation ${operation}`);
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "publish_records",
    inputs: [inputFrame(payload, "records")],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "published");
  assert.deepEqual(response.outputs[0].payload, payload);
  assert.deepEqual(calls.map(({ operation }) => operation), ["pubsub.publish"]);
  assert.equal(calls[0].params.source, "supplemental-omm");
  assert.equal(calls[0].params.standard, "OMM");
  assert.deepEqual(calls[0].params.data, record);
});

test("publication node preserves aligned FSB receipts while publishing only the exact inner record", async (t) => {
  const record = new Uint8Array([4, 2, 4, 2]);
  const payload = makeAlignedFsb(record);
  const calls = [];
  const harness = await createHarness(nodeSpecs[1], (operation, params) => {
    calls.push({ operation, params: { ...params, data: new Uint8Array(params.data) } });
    return true;
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "publish_records",
    inputs: [inputFrame(payload, "records", "aligned-binary")],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].wireFormat, "aligned-binary");
  assert.deepEqual(response.outputs[0].payload, payload);
  assert.deepEqual(calls.map(({ operation }) => operation), ["pubsub.publish"]);
  assert.equal(calls[0].params.source, "supplemental-omm");
  assert.equal(calls[0].params.standard, "OCM");
  assert.deepEqual(calls[0].params.data, record);
});
