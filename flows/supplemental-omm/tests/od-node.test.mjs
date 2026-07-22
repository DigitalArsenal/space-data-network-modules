import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractPublicationRecordCollection,
  verifyModuleArtifact,
} from "../../../node_modules/space-data-module-sdk/src/index.js";
import { createBrowserModuleHarness } from "../../../node_modules/space-data-module-sdk/src/testing/index.js";
import {
  Builder,
  ByteBuffer,
} from "../../../../spacedatastandards.org/node_modules/flatbuffers/js/flatbuffers.js";
import { FSB } from "../../../../spacedatastandards.org/lib/js/FSB/FSB.js";
import { FSO } from "../../../../spacedatastandards.org/lib/js/FSO/FSO.js";
import { FTB } from "../../../../spacedatastandards.org/lib/js/FSO/FTB.js";
import { flatSqlNodeStatus } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeStatus.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/OMM.js";
import { OCM } from "../../../../spacedatastandards.org/lib/js/OCM/OCM.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeRoot = path.join(packageRoot, "nodes/od");
const modulesRoot = path.resolve(packageRoot, "../..");
const inputPorts = ["starlink", "glonass", "intelsat", "cpf", "iss"];
const recordOutputPorts = ["omm", "ocm", "obd"];
const fsbAlignedSize = 1_048_744;
const fsbAlignedDataCapacity = 1_048_576;
const fsoAlignedSize = 361_648;
const outputPorts = ["control", "status", ...recordOutputPorts];
const fsbType = {
  schemaName: "FSB.fbs",
  fileIdentifier: "$FSB",
  schemaVersion: "1.158.1",
  schemaHash: "0b23aa63d0e3f17d828fc84dd433605c2794cb81ade7c043cb200e954c84e945",
  rootTypeName: "FSB",
  wireFormat: "flatbuffer",
};

function readJson(relativePath) {
  const filePath = path.join(nodeRoot, relativePath);
  assert.ok(fs.existsSync(filePath), `missing ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertFsbPair(port, location) {
  assert.equal(port?.acceptedTypeSets?.length, 1, `${location} needs one type set`);
  const types = port.acceptedTypeSets[0]?.allowedTypes ?? [];
  assert.equal(types.length, 2, `${location} needs exactly two representations`);
  const canonical = types.find(
    (type) => (type.wireFormat ?? "flatbuffer") === "flatbuffer",
  );
  const aligned = types.find((type) => type.wireFormat === "aligned-binary");
  assert.ok(canonical, `${location} needs canonical FlatBuffer`);
  assert.ok(aligned, `${location} needs aligned binary`);
  assert.equal(canonical.schemaName, "FSB.fbs");
  assert.equal(canonical.fileIdentifier, "$FSB");
  assert.equal(canonical.rootTypeName, "FSB");
  for (const key of [
    "schemaName",
    "fileIdentifier",
    "schemaVersion",
    "schemaHash",
    "rootTypeName",
  ]) {
    assert.equal(aligned[key] ?? null, canonical[key] ?? null);
  }
  assert.equal(aligned.byteLength, 1_048_744);
  assert.equal(aligned.requiredAlignment, 8);
}

function makeChunk({
  data,
  sequence,
  final,
  totalBytes,
  checksum,
  requestId = 67850n,
  schemaName = "MEME:67850:STARLINK-36840",
  fileIdentifier = "MEME",
}) {
  const builder = new Builder(data.byteLength + 512);
  const encodedSchemaName = builder.createString(schemaName);
  const encodedFileIdentifier = builder.createString(fileIdentifier);
  const dataVector = FSB.createDataVector(builder, data);
  const checksumVector = FSB.createSha256Vector(builder, checksum);
  FSB.startFSB(builder);
  FSB.addRequestId(builder, requestId);
  FSB.addChunkSequence(builder, sequence);
  FSB.addFinal(builder, final);
  FSB.addTotalBytes(builder, BigInt(totalBytes));
  FSB.addRecordCount(builder, 12n);
  FSB.addSchemaName(builder, encodedSchemaName);
  FSB.addFileIdentifier(builder, encodedFileIdentifier);
  FSB.addData(builder, dataVector);
  FSB.addSha256(builder, checksumVector);
  const root = FSB.endFSB(builder);
  FSB.finishFSBBuffer(builder, root);
  return builder.asUint8Array();
}

function makeAlignedChunk({
  data,
  sequence = 0,
  final = true,
  totalBytes = data.byteLength,
  checksum,
  requestId,
  schemaName,
  fileIdentifier,
}) {
  assert.ok(data.byteLength <= fsbAlignedDataCapacity);
  const schema = new TextEncoder().encode(schemaName);
  const identifier = new TextEncoder().encode(fileIdentifier);
  assert.ok(schema.byteLength <= 64);
  assert.ok(identifier.byteLength <= 4);
  assert.equal(checksum.byteLength, 32);
  const bytes = new Uint8Array(fsbAlignedSize);
  const view = new DataView(bytes.buffer);
  bytes[0] = 15;
  view.setBigUint64(8, requestId, true);
  bytes[16] = 1;
  view.setUint32(20, sequence, true);
  bytes[24] = final ? 1 : 0;
  view.setBigUint64(32, BigInt(totalBytes), true);
  view.setBigUint64(40, 12n, true);
  bytes[52] = schema.byteLength;
  bytes.set(schema, 53);
  bytes[117] = identifier.byteLength;
  bytes.set(identifier, 118);
  view.setUint32(124, data.byteLength, true);
  bytes.set(data, 128);
  view.setUint32(1_048_704, checksum.byteLength, true);
  bytes.set(checksum, 1_048_708);
  return bytes;
}

function inputFrame(payload, {
  portId = "starlink",
  wireFormat = "flatbuffer",
} = {}) {
  const aligned = wireFormat === "aligned-binary";
  return {
    portId,
    wireFormat,
    typeRef: {
      ...fsbType,
      schemaHash: [...Buffer.from(fsbType.schemaHash, "hex")],
      wireFormat,
      ...(aligned
        ? { byteLength: fsbAlignedSize, requiredAlignment: 8 }
        : {}),
    },
    payload,
  };
}

function readOdTestArtifact() {
  const gitRef = String(
    process.env.SUPPLEMENTAL_OMM_OD_TEST_ARTIFACT_GIT_REF ?? "",
  ).trim();
  if (!gitRef) {
    return new Uint8Array(
      fs.readFileSync(path.join(nodeRoot, "dist/isomorphic/module.wasm")),
    );
  }
  const artifactPath =
    "flows/supplemental-omm/nodes/od/dist/isomorphic/module.wasm";
  const result = spawnSync("git", ["show", `${gitRef}:${artifactPath}`], {
    cwd: modulesRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `unable to read OD test artifact from ${gitRef}: ${result.stderr}`,
  );
  return new Uint8Array(result.stdout);
}

function makeLongMemeFixture() {
  // Closed-form circular TEME orbit, km and km/s, sampled in UTC every minute.
  // Eight hours crosses the OD core's 3.2-hour local-fit window and therefore
  // proves that one provider object aggregates multiple epoch-specific fits.
  const radiusKm = 7_000;
  const inclination = (53 * Math.PI) / 180;
  const meanMotion = Math.sqrt(398_600.4418 / radiusKm ** 3);
  const lines = [
    "created:2026-07-21 00:00:00 UTC",
    "ephemeris_start:2026-07-21 00:00:00 UTC ephemeris_stop:2026-07-21 08:00:00 UTC step_size:60",
    "ephemeris_source:closed-form-circular-test",
    "UVW",
  ];
  for (let seconds = 0; seconds <= 8 * 60 * 60; seconds += 60) {
    const angle = meanMotion * seconds;
    const hour = Math.floor(seconds / 3_600);
    const minute = Math.floor((seconds % 3_600) / 60);
    const epoch = `2026202${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}00.000`;
    const x = radiusKm * Math.cos(angle);
    const y = radiusKm * Math.sin(angle) * Math.cos(inclination);
    const z = radiusKm * Math.sin(angle) * Math.sin(inclination);
    const vx = -radiusKm * meanMotion * Math.sin(angle);
    const vy = radiusKm * meanMotion * Math.cos(angle) * Math.cos(inclination);
    const vz = radiusKm * meanMotion * Math.cos(angle) * Math.sin(inclination);
    lines.push(
      `${epoch} ${x.toFixed(10)} ${y.toFixed(10)} ${z.toFixed(10)} ${vx.toFixed(12)} ${vy.toFixed(12)} ${vz.toFixed(12)}`,
    );
  }
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

function makeGlonassSp3Fixture() {
  const radiusKm = 25_510;
  const meanMotion = Math.sqrt(398_600.4418 / radiusKm ** 3);
  const lines = ["#dP2026  7 21  0  0  0.00000000 ORBIT TEST"];
  for (let index = 0; index < 8; index += 1) {
    const seconds = index * 15 * 60;
    const hour = Math.floor(seconds / 3_600);
    const minute = Math.floor((seconds % 3_600) / 60);
    lines.push(
      `*  2026 07 21 ${String(hour).padStart(2, "0")} ${String(minute).padStart(2, "0")} 00.00000000`,
    );
    for (const [satellite, phase] of [["R01", 0], ["R02", Math.PI / 3]]) {
      const angle = meanMotion * seconds + phase;
      const x = radiusKm * Math.cos(angle);
      const y = radiusKm * Math.sin(angle);
      const z = 2_000 * Math.sin(angle / 2);
      lines.push(
        `P${satellite} ${x.toFixed(9)} ${y.toFixed(9)} ${z.toFixed(9)} 0.000000`,
      );
    }
  }
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

function makeFutureGlonassSp3Fixture() {
  const lines = ["#dP2028  1  1  0  0  0.00000000 ORBIT TEST"];
  for (let index = 0; index < 4; index += 1) {
    lines.push(
      `*  2028 01 01 00 ${String(index * 15).padStart(2, "0")} 00.00000000`,
      `PR09 ${(25_510 - index * 10).toFixed(9)} ${(index * 900).toFixed(9)} ${(index * 50).toFixed(9)} 0.000000`,
    );
  }
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

function makeNonconvergentMemeFixture() {
  // Three parseable states whose cadence is wider than the OD core's local
  // fit window. The parser accepts the object, but the first epoch has fewer
  // than three in-window states, so the fitter deterministically returns a
  // nonconverged result without entering an expensive optimizer rescue.
  return new TextEncoder().encode([
    "created:2026-07-21 00:00:00 UTC",
    "ephemeris_start:2026-07-21 00:00:00 UTC ephemeris_stop:2026-07-21 08:00:00 UTC step_size:14400",
    "ephemeris_source:nonconvergent-test",
    "UVW",
    "2026202000000.000 7000 0 0 0 7.5 1",
    "2026202040000.000 -6999 10 5 -0.01 -7.5 -1",
    "2026202080000.000 6998 -20 -10 0.02 7.5 1",
    "",
  ].join("\n"));
}

function assertOutputWireFormat(response, wireFormat) {
  assert.ok(response.outputs.length > 0);
  for (const output of response.outputs) {
    assert.equal(output.wireFormat, wireFormat, `${output.portId} changed wire format`);
    if (wireFormat === "aligned-binary") {
      const expectedSize = ["control", "status"].includes(output.portId)
        ? fsoAlignedSize
        : fsbAlignedSize;
      assert.equal(output.payload.byteLength, expectedSize);
      assert.equal(output.typeRef?.byteLength, expectedSize);
      assert.equal(output.typeRef?.requiredAlignment, 8);
    }
  }
}

function assertChunkInvalid(response) {
  assert.equal(response.statusCode, 400, response.errorMessage);
  assert.equal(response.errorCode, "od-chunk-invalid");
  assert.deepEqual(response.outputs, []);
}

function decodeOutput(output) {
  const bytes = new Uint8Array(output.payload);
  const value = FSB.getRootAsFSB(new ByteBuffer(bytes));
  const decode = (candidate) =>
    typeof candidate === "string"
      ? candidate
      : new TextDecoder().decode(candidate ?? new Uint8Array());
  return {
    portId: output.portId,
    requestId: value.REQUEST_ID(),
    sequence: value.CHUNK_SEQUENCE(),
    final: value.FINAL(),
    totalBytes: value.TOTAL_BYTES(),
    recordCount: value.RECORD_COUNT(),
    schemaName: decode(value.SCHEMA_NAME()),
    fileIdentifier: decode(value.FILE_IDENTIFIER()),
    data: new Uint8Array(value.dataArray() ?? []),
    checksum: new Uint8Array(value.sha256Array() ?? []),
  };
}

function countSizePrefixedRecords(bytes) {
  let offset = 0;
  let count = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset < bytes.byteLength) {
    assert.ok(bytes.byteLength - offset >= 4, "record stream ends inside a size prefix");
    const size = view.getUint32(offset, true);
    assert.ok(size <= bytes.byteLength - offset - 4, "record stream ends inside a record");
    offset += size + 4;
    count += 1;
  }
  return count;
}

function splitSizePrefixedRecords(bytes) {
  const records = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    assert.ok(bytes.byteLength - offset >= 4, "record stream ends inside a size prefix");
    const size = view.getUint32(offset, true);
    assert.ok(size <= bytes.byteLength - offset - 4, "record stream ends inside a record");
    records.push(bytes.slice(offset, offset + size + 4));
    offset += size + 4;
  }
  return records;
}

function reassembleRecordStream(outputs, portId) {
  const chunks = outputs
    .filter((output) => output.portId === portId)
    .map(decodeOutput)
    .sort((left, right) => left.sequence - right.sequence);
  assert.ok(chunks.length > 0, `missing ${portId} record stream`);
  const first = chunks[0];
  const stream = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0),
  );
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    assert.equal(chunk.requestId, first.requestId);
    assert.equal(chunk.sequence, index);
    assert.equal(chunk.final, index + 1 === chunks.length);
    assert.equal(chunk.totalBytes, first.totalBytes);
    assert.equal(chunk.recordCount, first.recordCount);
    assert.deepEqual(chunk.checksum, first.checksum);
    stream.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  assert.equal(BigInt(stream.byteLength), first.totalBytes);
  assert.equal(BigInt(splitSizePrefixedRecords(stream).length), first.recordCount);
  return { chunks, stream, recordCount: first.recordCount };
}

function readAlignedRecordStream(outputs, portId) {
  const output = outputs.find((candidate) => candidate.portId === portId);
  assert.ok(output, `missing aligned ${portId} record stream`);
  assert.equal(output.wireFormat, "aligned-binary");
  const bytes = new Uint8Array(output.payload);
  assert.equal(bytes.byteLength, fsbAlignedSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(124, true);
  assert.ok(length <= fsbAlignedDataCapacity);
  return {
    recordCount: view.getBigUint64(40, true),
    stream: bytes.slice(128, 128 + length),
  };
}

function decodeControl(output) {
  const bytes = new Uint8Array(output.payload);
  const value = FSO.getRootAsFSO(new ByteBuffer(bytes));
  const decode = (candidate) =>
    typeof candidate === "string"
      ? candidate
      : new TextDecoder().decode(candidate ?? new Uint8Array());
  const bindings = [];
  for (let index = 0; index < value.tableBindingsLength(); index += 1) {
    const binding = value.TABLE_BINDINGS(index, new FTB());
    bindings.push({
      fileIdentifier: decode(binding?.FILE_IDENTIFIER()),
      tableName: decode(binding?.TABLE_NAME()),
    });
  }
  return {
    operation: value.OPERATION(),
    requestId: value.REQUEST_ID(),
    databaseName: decode(value.DATABASE_NAME()),
    schemaIdl: new TextDecoder().decode(value.schemaIdlArray() ?? []),
    bindings,
  };
}

function decodeStatusOutput(response) {
  const outputs = response.outputs.filter((output) => output.portId === "status");
  assert.equal(outputs.length, 1, "each consumed logical object needs one status");
  const output = outputs[0];
  const bytes = new Uint8Array(output.payload);
  const decode = (candidate) =>
    typeof candidate === "string"
      ? candidate
      : new TextDecoder().decode(candidate ?? new Uint8Array());
  if (output.wireFormat === "aligned-binary") {
    assert.equal(bytes.byteLength, fsoAlignedSize);
    assert.equal(output.typeRef?.byteLength, fsoAlignedSize);
    assert.equal(output.typeRef?.requiredAlignment, 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const errorLength = bytes[357_416];
    const messageLength = view.getUint32(357_548, true);
    assert.ok(errorLength <= 128);
    assert.ok(messageLength <= 4096);
    return {
      wireFormat: output.wireFormat,
      operation: bytes[2],
      requestId: view.getBigUint64(8, true),
      status: bytes[357_392],
      affectedRecords: view.getBigUint64(357_400, true),
      resultBytes: view.getBigUint64(357_408, true),
      errorCode: new TextDecoder().decode(
        bytes.subarray(357_417, 357_417 + errorLength),
      ),
      message: new TextDecoder().decode(
        bytes.subarray(357_552, 357_552 + messageLength),
      ),
    };
  }
  assert.equal(output.wireFormat, "flatbuffer");
  const value = FSO.getRootAsFSO(new ByteBuffer(bytes));
  return {
    wireFormat: output.wireFormat,
    operation: value.OPERATION(),
    requestId: value.REQUEST_ID(),
    status: value.STATUS(),
    affectedRecords: value.AFFECTED_RECORDS(),
    resultBytes: value.RESULT_BYTES(),
    errorCode: decode(value.ERROR_CODE()),
    message: new TextDecoder().decode(value.messageArray() ?? new Uint8Array()),
  };
}

function resultMetrics(response, wireFormat) {
  let affectedRecords = 0n;
  let resultBytes = 0n;
  for (const portId of recordOutputPorts) {
    const records = wireFormat === "aligned-binary"
      ? readAlignedRecordStream(response.outputs, portId)
      : reassembleRecordStream(response.outputs, portId);
    if (portId === "omm") affectedRecords = records.recordCount;
    resultBytes += BigInt(records.stream.byteLength);
  }
  return { affectedRecords, resultBytes };
}

async function createFlatSqlPersistenceHarness(t) {
  const flatSqlRoot = path.join(packageRoot, "../../../flatsql/wasm/node");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(flatSqlRoot, "plugin-manifest.json"), "utf8"),
  );
  const signed = new Uint8Array(
    fs.readFileSync(path.join(flatSqlRoot, "dist/isomorphic/module.wasm")),
  );
  const portable = extractPublicationRecordCollection(signed)?.payloadBytes ?? signed;
  const opaqueValues = new Map();
  const opaqueKey = (params) => `${params.namespace}\0${params.key}`;
  const harness = await createBrowserModuleHarness({
    wasmSource: portable,
    manifest,
    surface: "direct",
    hostcallDispatch(operation, params) {
      if (operation === "storage.adapter.opaque.read") {
        const value = opaqueValues.get(opaqueKey(params));
        return {
          found: value !== undefined,
          bytes_b64: value?.slice() ?? new Uint8Array(),
        };
      }
      if (operation === "storage.adapter.opaque.replace") {
        assert.ok(params.data instanceof Uint8Array);
        opaqueValues.set(opaqueKey(params), params.data.slice());
        return { stored_bytes: params.data.byteLength };
      }
      if (operation === "storage.adapter.opaque.list") {
        const prefix = `${params.namespace}\0`;
        return {
          keys: [...opaqueValues.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length))
            .sort(),
        };
      }
      if (operation === "storage.adapter.opaque.delete") {
        opaqueValues.delete(opaqueKey(params));
        return { deleted: true };
      }
      if (operation === "storage.adapter.opaque.sync") {
        return { synced: true };
      }
      throw new Error(`unexpected FlatSQL host operation ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  return harness;
}

test("OD is a strict dual-FSB native-response transform", () => {
  const manifest = readJson("plugin-manifest.json");
  assert.equal(manifest.pluginId, "org.sdn.flows.supplemental-omm.od");
  assert.deepEqual(manifest.invokeSurfaces, ["direct"]);
  assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
  assert.deepEqual(manifest.capabilities, []);
  const method = manifest.methods?.find((candidate) => candidate.methodId === "fit");
  assert.ok(method);
  assert.deepEqual(method.inputPorts.map((port) => port.portId), inputPorts);
  assert.deepEqual(method.outputPorts.map((port) => port.portId), outputPorts);
  for (const port of [
    ...method.inputPorts,
    ...method.outputPorts.filter((port) => recordOutputPorts.includes(port.portId)),
  ]) {
    assertFsbPair(port, `fit.${port.portId}`);
  }
  for (const portId of ["control", "status"]) {
    const port = method.outputPorts.find((candidate) => candidate.portId === portId);
    const types = port?.acceptedTypeSets?.[0]?.allowedTypes ?? [];
    assert.deepEqual(
      types.map((type) => type.wireFormat).sort(),
      ["aligned-binary", "flatbuffer"],
    );
    assert.ok(types.every((type) => type.schemaName === "FSO.fbs"));
    assert.ok(types.every((type) => type.fileIdentifier === "$FSO"));
  }
  const status = method.outputPorts.find((port) => port.portId === "status");
  assert.equal(status?.required, false);
  assert.equal(status?.minStreams, 0);
  assert.equal(status?.maxStreams, 4096);
  assert.doesNotMatch(JSON.stringify(manifest), /OEM\.fbs|\$OEM|acceptsAnyFlatbuffer/i);
});

test("OD source reassembles complete native chunks and owns every provider parser", () => {
  const sourcePath = path.join(nodeRoot, "src/node.cpp");
  assert.ok(fs.existsSync(sourcePath), `missing ${sourcePath}`);
  const source = fs.readFileSync(sourcePath, "utf8");
  for (const marker of [
    "parse_starlink_meme",
    "parse_glonass_sp3",
    "parse_intelsat_ecf",
    "parse_cpf",
    "parse_iss_oem",
    "CHUNK_SEQUENCE",
    "TOTAL_BYTES",
    "FINAL",
    "run_batch_fit",
    "additional_epochs",
    "CONFIGURE_INDEX",
    "TABLE_BINDINGS",
    "kResultSchemaIdl",
  ]) {
    assert.match(source, new RegExp(marker), `missing ${marker}`);
  }
  assert.doesNotMatch(source, /128\s*\*\s*1024|131072|rangeBytes|celestrak/i);
});

test("OD signed-node build is self-contained inside the Supplemental package", () => {
  const buildSource = fs.readFileSync(path.join(nodeRoot, "build.mjs"), "utf8");
  assert.doesNotMatch(
    buildSource,
    /analysis[\\/]od/,
    "Supplemental OD build must not consume an external dirty OD checkout",
  );
  assert.match(buildSource, /vendor[\\/]od-fit-core\.o/);

  const fitObject = path.join(nodeRoot, "vendor/od-fit-core.o");
  assert.ok(fs.existsSync(fitObject), `missing ${fitObject}`);
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(fitObject)).digest("hex"),
    "7ebc7409148e085759c976ae07f01c378b2f4f5a3662bd21a7c9b6ed6608782e",
  );

  const fitHeader = path.join(nodeRoot, "vendor/od_batch_fit.hpp");
  assert.ok(fs.existsSync(fitHeader), `missing ${fitHeader}`);
  assert.match(fs.readFileSync(fitHeader, "utf8"), /additional_epochs/);

  const sourcePatch = path.join(nodeRoot, "vendor/od-fit-core-source.patch");
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(sourcePatch)).digest("hex"),
    "18af55440c188144082029cacafbaed35a813740d0aefc15aa43cd27bf8dd761",
  );
  const modulesRoot = path.resolve(packageRoot, "../..");
  const forward = spawnSync("git", ["apply", "--check", "--unidiff-zero", sourcePatch], {
    cwd: modulesRoot,
  });
  const reverse = spawnSync("git", ["apply", "--check", "--reverse", "--unidiff-zero", sourcePatch], {
    cwd: modulesRoot,
  });
  assert.ok(
    forward.status === 0 || reverse.status === 0,
    "vendored source delta must apply to the pinned base or exactly match the working source",
  );

  const license = path.join(nodeRoot, "vendor/SGP4-LICENSE.txt");
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(license)).digest("hex"),
    "771e7128d338686ef6321a67cd2e074c537c400225ea05e115bbd065236e609c",
  );
  const notice = fs.readFileSync(path.join(nodeRoot, "vendor/NOTICE.md"), "utf8");
  assert.match(notice, /base\s+revision[^]+plus the then-uncommitted/i);
  assert.match(notice, /SGP4-LICENSE\.txt/);
});

test("OD artifact is independently bundle-signed", async () => {
  const artifactPath = path.join(nodeRoot, "dist/isomorphic/module.wasm");
  assert.ok(fs.existsSync(artifactPath), `missing ${artifactPath}`);
  const publisher = readJson("publisher.json");
  const bytes = new Uint8Array(fs.readFileSync(artifactPath));
  const verified = await verifyModuleArtifact(bytes, {
    trustedPublicKeys: [publisher.publicKeyHex],
    requireSignature: true,
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.signatureScope, "bundle");
  const portable = extractPublicationRecordCollection(bytes)?.payloadBytes ?? bytes;
  assert.ok(portable.byteLength > 0);
  assert.doesNotMatch(Buffer.from(bytes).toString("latin1"), /celestrak/i);
});

test("OD rejects canonical chunk ordering and checksum failures", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const fixture = new TextEncoder().encode("UVW\nnot enough states\n");
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const boundary = Math.floor(fixture.byteLength / 2);
  const partial = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(
        makeChunk({
          data: fixture.slice(0, boundary),
          sequence: 0,
          final: false,
          totalBytes: fixture.byteLength,
          checksum,
          requestId: 92001n,
        }),
      ),
    ],
  });
  assert.equal(partial.statusCode, 0, partial.errorMessage);
  assert.deepEqual(partial.outputs, []);

  const outOfOrder = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(
        makeChunk({
          data: fixture.slice(boundary),
          sequence: 2,
          final: true,
          totalBytes: fixture.byteLength,
          checksum,
          requestId: 92001n,
        }),
      ),
    ],
  });
  assertChunkInvalid(outOfOrder);

  const wrongChecksum = new Uint8Array(32);
  wrongChecksum.fill(0xa5);
  const checksumFailure = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(
        makeChunk({
          data: fixture,
          sequence: 0,
          final: true,
          totalBytes: fixture.byteLength,
          checksum: wrongChecksum,
          requestId: 92002n,
        }),
      ),
    ],
  });
  assertChunkInvalid(checksumFailure);
});

test("OD rejects aligned DATA length beyond its fixed bound", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const dataOverflow = makeAlignedChunk({
    data: new Uint8Array(),
    totalBytes: fsbAlignedDataCapacity,
    checksum: new Uint8Array(32),
    requestId: 93002n,
    schemaName: "MEME:93002:STARLINK-DATA-OVERFLOW",
    fileIdentifier: "MEME",
  });
  dataOverflow.fill(0x20, 128, 128 + fsbAlignedDataCapacity);
  dataOverflow[0] &= ~8;
  const dataOverflowView = new DataView(dataOverflow.buffer);
  dataOverflowView.setUint32(124, fsbAlignedDataCapacity + 1, true);
  dataOverflowView.setUint32(1_048_704, 0, true);
  const dataLengthFailure = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(dataOverflow, { wireFormat: "aligned-binary" }),
    ],
  });
  assertChunkInvalid(dataLengthFailure);
});

test("OD rejects aligned SHA256 length beyond its fixed bound", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const unusable = new TextEncoder().encode("UVW\nnot enough states\n");
  const checksum = crypto.createHash("sha256").update(unusable).digest();
  const valid = makeAlignedChunk({
    data: unusable,
    checksum,
    requestId: 93003n,
    schemaName: "MEME:93003:STARLINK-SHA-OVERFLOW",
    fileIdentifier: "MEME",
  });
  const checksumOverflow = valid.slice();
  new DataView(checksumOverflow.buffer).setUint32(1_048_704, 33, true);
  const checksumLengthFailure = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(checksumOverflow, { wireFormat: "aligned-binary" }),
    ],
  });
  assertChunkInvalid(checksumLengthFailure);
});

test("OD rejects aligned SCHEMA_NAME length beyond its fixed bound", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const unusable = new TextEncoder().encode("UVW\nnot enough states\n");
  const checksum = crypto.createHash("sha256").update(unusable).digest();
  const schemaOverflow = makeAlignedChunk({
    data: unusable,
    checksum,
    requestId: 93004n,
    schemaName: "MEME:93004:STARLINK-SCHEMA-OVERFLOW",
    fileIdentifier: "MEME",
  });
  schemaOverflow[52] = 65;
  const schemaLengthFailure = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(schemaOverflow, { wireFormat: "aligned-binary" }),
    ],
  });
  assertChunkInvalid(schemaLengthFailure);
});

test("OD rejects aligned FILE_IDENTIFIER length beyond its fixed bound", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const unusable = new TextEncoder().encode("UVW\nnot enough states\n");
  const checksum = crypto.createHash("sha256").update(unusable).digest();
  const identifierOverflow = makeAlignedChunk({
    data: unusable,
    checksum,
    requestId: 93005n,
    schemaName: "MEME:93005:STARLINK-IDENTIFIER-OVERFLOW",
    fileIdentifier: "MEME",
  });
  identifierOverflow[117] = 5;
  const identifierLengthFailure = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(identifierOverflow, { wireFormat: "aligned-binary" }),
    ],
  });
  assertChunkInvalid(identifierLengthFailure);
});

for (const wireFormat of ["flatbuffer", "aligned-binary"]) {
  test(`OD emits ${wireFormat} typed status for success and object-local failures`, async (t) => {
    const manifest = readJson("plugin-manifest.json");
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());

    const aligned = wireFormat === "aligned-binary";
    const providerFrame = ({
      data,
      requestId,
      schemaName,
      fileIdentifier = "MEME",
      portId = "starlink",
    }) => {
      const checksum = crypto.createHash("sha256").update(data).digest();
      const payload = aligned
        ? makeAlignedChunk({
            data,
            checksum,
            requestId,
            schemaName,
            fileIdentifier,
          })
        : makeChunk({
            data,
            sequence: 0,
            final: true,
            totalBytes: data.byteLength,
            checksum,
            requestId,
            schemaName,
            fileIdentifier,
          });
      return inputFrame(payload, { portId, wireFormat });
    };

    const suffix = aligned ? 2n : 1n;
    const successRequestId = 94_000n + suffix;
    const successNorad = Number(67_860n + suffix);
    const successName = `STARLINK-STATUS-${wireFormat.toUpperCase()}`;
    const successFixture = new Uint8Array(
      fs.readFileSync(
        path.join(
          packageRoot,
          "../../data-source/spacex-starlink-source/test/fixtures/meme/MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
        ),
      ),
    );
    const success = await harness.invoke({
      methodId: "fit",
      inputs: [
        providerFrame({
          data: successFixture,
          requestId: successRequestId,
          schemaName: `MEME:${successNorad}:${successName}`,
        }),
      ],
    });
    assert.equal(success.statusCode, 0, success.errorMessage);
    assert.equal(success.errorCode, null);
    assert.equal(success.yielded, false);
    assert.equal(success.backlogRemaining, 0);
    const successStatus = decodeStatusOutput(success);
    const metrics = resultMetrics(success, wireFormat);
    assert.deepEqual(successStatus, {
      wireFormat,
      operation: 0,
      requestId: successRequestId,
      status: flatSqlNodeStatus.COMPLETE,
      affectedRecords: metrics.affectedRecords,
      resultBytes: metrics.resultBytes,
      errorCode: "",
      message: `OD fit complete: ${successName} (NORAD ${successNorad})`,
    });

    const parseRequestId = 94_100n + suffix;
    const unusable = new TextEncoder().encode("UVW\nnot enough states\n");
    const parseFailure = await harness.invoke({
      methodId: "fit",
      inputs: [
        providerFrame({
          data: unusable,
          requestId: parseRequestId,
          schemaName: `MEME:9410${suffix}:STARLINK-PARSE-EMPTY`,
        }),
      ],
    });
    assert.equal(parseFailure.statusCode, 0, parseFailure.errorMessage);
    assert.equal(parseFailure.errorCode, "od-native-parse");
    assert.equal(parseFailure.yielded, false);
    assert.equal(parseFailure.backlogRemaining, 0);
    assert.equal(parseFailure.outputs.length, 1);
    const parseStatus = decodeStatusOutput(parseFailure);
    assert.equal(parseStatus.wireFormat, wireFormat);
    assert.equal(parseStatus.operation, 0);
    assert.equal(parseStatus.requestId, parseRequestId);
    assert.equal(parseStatus.status, flatSqlNodeStatus.INVALID_ARGUMENT);
    assert.equal(parseStatus.affectedRecords, 0n);
    assert.equal(parseStatus.resultBytes, 0n);
    assert.equal(parseStatus.errorCode, "od-native-parse");
    assert.match(parseStatus.message, /STARLINK-PARSE-EMPTY/);
    assert.match(parseStatus.message, /fewer than three usable states/);

    const fitRequestId = 94_200n + suffix;
    const queuedRequestId = 94_300n + suffix;
    const fitFailure = await harness.invoke({
      methodId: "fit",
      inputs: [
        providerFrame({
          data: makeFutureGlonassSp3Fixture(),
          requestId: fitRequestId,
          schemaName: "SP3",
          fileIdentifier: "SP3",
          portId: "glonass",
        }),
        providerFrame({
          data: successFixture,
          requestId: queuedRequestId,
          schemaName: `MEME:${successNorad + 10}:STARLINK-AFTER-FIT-ERROR`,
        }),
      ],
    });
    assert.equal(fitFailure.statusCode, 0, fitFailure.errorMessage);
    assert.equal(fitFailure.errorCode, "od-fit");
    assert.equal(fitFailure.yielded, true);
    assert.equal(fitFailure.backlogRemaining, 1);
    assert.equal(fitFailure.outputs.length, 1);
    const fitStatus = decodeStatusOutput(fitFailure);
    assert.equal(fitStatus.wireFormat, wireFormat);
    assert.equal(fitStatus.operation, 0);
    assert.equal(fitStatus.requestId, fitRequestId);
    assert.equal(fitStatus.status, flatSqlNodeStatus.INTERNAL_ERROR);
    assert.equal(fitStatus.affectedRecords, 0n);
    assert.equal(fitStatus.resultBytes, 0n);
    assert.equal(fitStatus.errorCode, "time-past-leap-horizon");
    assert.match(fitStatus.message, /GLONASS R09/);
    assert.match(fitStatus.message, /leap-second validity horizon/);

    const continuation = await harness.invoke({ methodId: "fit", inputs: [] });
    assert.equal(continuation.statusCode, 0, continuation.errorMessage);
    assert.equal(continuation.errorCode, null);
    assert.equal(continuation.yielded, false);
    assert.equal(continuation.backlogRemaining, 0);
    const continuationStatus = decodeStatusOutput(continuation);
    assert.equal(continuationStatus.wireFormat, wireFormat);
    assert.equal(continuationStatus.requestId, queuedRequestId);
    assert.equal(continuationStatus.status, flatSqlNodeStatus.COMPLETE);
  });
}

test("OD expands one GLONASS response into one-object fit continuations", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const fixture = makeGlonassSp3Fixture();
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const first = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(
        makeChunk({
          data: fixture,
          sequence: 0,
          final: true,
          totalBytes: fixture.byteLength,
          checksum,
          requestId: 88001n,
          schemaName: "SP3",
          fileIdentifier: "SP3",
        }),
        { portId: "glonass" },
      ),
    ],
  });
  const second = await harness.invoke({ methodId: "fit", inputs: [] });
  assert.deepEqual(
    [first, second].map(({ yielded, backlogRemaining }) => ({
      yielded,
      backlogRemaining,
    })),
    [
      { yielded: true, backlogRemaining: 1 },
      { yielded: false, backlogRemaining: 0 },
    ],
  );

  const fittedNames = [];
  for (const response of [first, second]) {
    assert.equal(response.statusCode, 0, response.errorMessage);
    const omm = reassembleRecordStream(response.outputs, "omm");
    const names = new Set(
      splitSizePrefixedRecords(omm.stream).map((record) =>
        OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record)).OBJECT_NAME(),
      ),
    );
    assert.equal(names.size, 1, "one continuation fitted multiple SP3 satellites");
    fittedNames.push(...names);
  }
  assert.deepEqual(fittedNames, ["GLONASS R01", "GLONASS R02"]);
});

test("OD retains each queued object's canonical or aligned outer wire format", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const fixture = new Uint8Array(
    fs.readFileSync(
      path.join(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme/MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
      ),
    ),
  );
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const first = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(
        makeChunk({
          data: fixture,
          sequence: 0,
          final: true,
          totalBytes: fixture.byteLength,
          checksum,
          requestId: 89001n,
          schemaName: "MEME:67850:STARLINK-CANONICAL",
        }),
      ),
      inputFrame(
        makeAlignedChunk({
          data: fixture,
          checksum,
          requestId: 89002n,
          schemaName: "MEME:67851:STARLINK-ALIGNED",
          fileIdentifier: "MEME",
        }),
        { wireFormat: "aligned-binary" },
      ),
    ],
  });
  const second = await harness.invoke({ methodId: "fit", inputs: [] });
  assert.deepEqual(
    [first, second].map(({ yielded, backlogRemaining }) => ({
      yielded,
      backlogRemaining,
    })),
    [
      { yielded: true, backlogRemaining: 1 },
      { yielded: false, backlogRemaining: 0 },
    ],
  );
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.equal(second.statusCode, 0, second.errorMessage);
  assertOutputWireFormat(first, "flatbuffer");
  assertOutputWireFormat(second, "aligned-binary");

  const canonicalOmm = reassembleRecordStream(first.outputs, "omm");
  const alignedOmm = readAlignedRecordStream(second.outputs, "omm");
  const identities = [canonicalOmm, alignedOmm].map(({ stream }) => {
    const record = splitSizePrefixedRecords(stream)[0];
    const value = OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record));
    return `${value.NORAD_CAT_ID()}:${value.OBJECT_NAME()}`;
  });
  assert.deepEqual(identities, [
    "67850:STARLINK-CANONICAL",
    "67851:STARLINK-ALIGNED",
  ]);
});

test("OD emits and persists nonconvergent best-effort records without stranding queued objects", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const badFixture = makeNonconvergentMemeFixture();
  const badChecksum = crypto.createHash("sha256").update(badFixture).digest();
  const goodFixture = new Uint8Array(
    fs.readFileSync(
      path.join(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme/MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
      ),
    ),
  );
  const goodChecksum = crypto.createHash("sha256").update(goodFixture).digest();
  const badFrame = (requestId) =>
    inputFrame(
      makeChunk({
        data: badFixture,
        sequence: 0,
        final: true,
        totalBytes: badFixture.byteLength,
        checksum: badChecksum,
        requestId,
        schemaName: `MEME:${requestId}:STARLINK-BAD`,
      }),
    );
  const goodFrame = (requestId, objectName) =>
    inputFrame(
      makeChunk({
        data: goodFixture,
        sequence: 0,
        final: true,
        totalBytes: goodFixture.byteLength,
        checksum: goodChecksum,
        requestId,
        schemaName: `MEME:${requestId}:${objectName}`,
      }),
    );

  const isolatedBad = await harness.invoke({
    methodId: "fit",
    inputs: [badFrame(90001n)],
  });
  assert.equal(isolatedBad.statusCode, 0, isolatedBad.errorMessage);
  assert.equal(isolatedBad.errorCode, null);
  assert.equal(isolatedBad.yielded, false);
  assert.equal(isolatedBad.backlogRemaining, 0);
  assert.deepEqual(
    isolatedBad.outputs.map((output) => output.portId).sort(),
    ["control", "obd", "ocm", "omm", "status"],
  );

  let bestEffortRecordCount = 0n;
  const bestEffortStreams = new Map();
  for (const portId of recordOutputPorts) {
    const records = reassembleRecordStream(isolatedBad.outputs, portId);
    assert.equal(records.recordCount, 1n, `${portId} best-effort record missing`);
    bestEffortRecordCount += records.recordCount;
    bestEffortStreams.set(portId, records.stream);
  }
  const bestEffortOmm = OMM.getSizePrefixedRootAsOMM(
    new ByteBuffer(splitSizePrefixedRecords(bestEffortStreams.get("omm"))[0]),
  );
  assert.equal(bestEffortOmm.NORAD_CAT_ID(), 90001);
  assert.equal(bestEffortOmm.OBJECT_NAME(), "STARLINK-BAD");
  const bestEffortOcm = OCM.getSizePrefixedRootAsOCM(
    new ByteBuffer(splitSizePrefixedRecords(bestEffortStreams.get("ocm"))[0]),
  );
  assert.match(
    bestEffortOcm.ORBIT_DETERMINATION()?.OD_CONVERGENCE_CRITERIA() ?? "",
    /converged=0/,
  );
  const bestEffortStatus = decodeStatusOutput(isolatedBad);
  const bestEffortMetrics = resultMetrics(isolatedBad, "flatbuffer");
  assert.deepEqual(bestEffortStatus, {
    wireFormat: "flatbuffer",
    operation: 0,
    requestId: 90001n,
    status: flatSqlNodeStatus.COMPLETE,
    affectedRecords: bestEffortMetrics.affectedRecords,
    resultBytes: bestEffortMetrics.resultBytes,
    errorCode: "",
    message: "OD fit complete: STARLINK-BAD (NORAD 90001)",
  });

  const flatSql = await createFlatSqlPersistenceHarness(t);
  const append = await flatSql.invoke({
    methodId: "append_records",
    inputs: isolatedBad.outputs
      .filter((output) => output.portId !== "status")
      .map((output) => ({
        ...output,
        portId: output.portId === "control" ? "control" : "records",
      })),
  });
  assert.equal(append.statusCode, 0, append.errorMessage);
  const appendStatusFrame = append.outputs.find(
    (output) => output.portId === "status",
  );
  assert.ok(appendStatusFrame, "FlatSQL returns best-effort append status");
  const appendStatus = FSO.getRootAsFSO(
    new ByteBuffer(new Uint8Array(appendStatusFrame.payload)),
  );
  assert.equal(appendStatus.STATUS(), 4);
  assert.equal(appendStatus.AFFECTED_RECORDS(), bestEffortRecordCount);

  const futureGood = await harness.invoke({
    methodId: "fit",
    inputs: [goodFrame(67853n, "STARLINK-AFTER-ISOLATED-BAD")],
  });
  assert.equal(futureGood.statusCode, 0, futureGood.errorMessage);
  assert.equal(futureGood.backlogRemaining, 0);
  assert.ok(futureGood.outputs.some((output) => output.portId === "omm"));

  const coalescedBad = await harness.invoke({
    methodId: "fit",
    inputs: [
      badFrame(90002n),
      goodFrame(67854n, "STARLINK-AFTER-QUEUED-BAD"),
    ],
  });
  assert.equal(coalescedBad.statusCode, 0, coalescedBad.errorMessage);
  assert.equal(coalescedBad.errorCode, null);
  assert.equal(coalescedBad.yielded, true);
  assert.equal(coalescedBad.backlogRemaining, 1);
  const coalescedOmm = reassembleRecordStream(coalescedBad.outputs, "omm");
  const coalescedIdentity = OMM.getSizePrefixedRootAsOMM(
    new ByteBuffer(splitSizePrefixedRecords(coalescedOmm.stream)[0]),
  );
  assert.equal(coalescedIdentity.NORAD_CAT_ID(), 90002);
  assert.equal(coalescedIdentity.OBJECT_NAME(), "STARLINK-BAD");
  assert.equal(decodeStatusOutput(coalescedBad).requestId, 90002n);

  const queuedGood = await harness.invoke({ methodId: "fit", inputs: [] });
  assert.equal(queuedGood.statusCode, 0, queuedGood.errorMessage);
  assert.equal(queuedGood.yielded, false);
  assert.equal(queuedGood.backlogRemaining, 0);
  const omm = reassembleRecordStream(queuedGood.outputs, "omm");
  const identity = OMM.getSizePrefixedRootAsOMM(
    new ByteBuffer(splitSizePrefixedRecords(omm.stream)[0]),
  );
  assert.equal(identity.NORAD_CAT_ID(), 67854);
  assert.equal(identity.OBJECT_NAME(), "STARLINK-AFTER-QUEUED-BAD");
});

test("OD consumes a complete but unusable native response as an object-level error", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const unusable = new TextEncoder().encode([
    "UVW",
    "2026202000000.000 7000 0 0 0 7.5 0",
    "2026202000100.000 6999 450 0 -0.5 7.48 0",
    "",
  ].join("\n"));
  const checksum = crypto.createHash("sha256").update(unusable).digest();
  const response = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(
        makeChunk({
          data: unusable,
          sequence: 0,
          final: true,
          totalBytes: unusable.byteLength,
          checksum,
          requestId: 91001n,
          schemaName: "MEME:91001:STARLINK-UNUSABLE",
        }),
      ),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.errorCode, "od-native-parse");
  assert.equal(response.outputs.length, 1);
  assert.equal(
    decodeStatusOutput(response).status,
    flatSqlNodeStatus.INVALID_ARGUMENT,
  );
  assert.equal(response.yielded, false);
  assert.equal(response.backlogRemaining, 0);

  const goodFixture = new Uint8Array(
    fs.readFileSync(
      path.join(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme/MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
      ),
    ),
  );
  const goodChecksum = crypto.createHash("sha256").update(goodFixture).digest();
  const futureGood = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(
        makeChunk({
          data: goodFixture,
          sequence: 0,
          final: true,
          totalBytes: goodFixture.byteLength,
          checksum: goodChecksum,
          requestId: 91002n,
          schemaName: "MEME:67855:STARLINK-AFTER-PARSE-ERROR",
        }),
      ),
    ],
  });
  assert.equal(futureGood.statusCode, 0, futureGood.errorMessage);
  assert.equal(futureGood.errorCode, null);
  assert.ok(futureGood.outputs.some((output) => output.portId === "omm"));
});

test("OD fits one queued provider object per invocation and drains through zero-input continuations", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const fixture = new Uint8Array(
    fs.readFileSync(
      path.join(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme/MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
      ),
    ),
  );
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const objects = [
    { requestId: 78001n, norad: 67850, objectName: "STARLINK-QUEUE-A" },
    { requestId: 78002n, norad: 67851, objectName: "STARLINK-QUEUE-B" },
    { requestId: 78003n, norad: 67852, objectName: "STARLINK-QUEUE-C" },
  ];

  const responses = [
    await harness.invoke({
      methodId: "fit",
      inputs: objects.map(({ requestId, norad, objectName }) =>
        inputFrame(
          makeChunk({
            data: fixture,
            sequence: 0,
            final: true,
            totalBytes: fixture.byteLength,
            checksum,
            requestId,
            schemaName: `MEME:${norad}:${objectName}`,
          }),
        ),
      ),
    }),
    await harness.invoke({ methodId: "fit", inputs: [] }),
    await harness.invoke({ methodId: "fit", inputs: [] }),
  ];

  assert.deepEqual(
    responses.map(({ yielded, backlogRemaining }) => ({
      yielded,
      backlogRemaining,
    })),
    [
      { yielded: true, backlogRemaining: 2 },
      { yielded: true, backlogRemaining: 1 },
      { yielded: false, backlogRemaining: 0 },
    ],
  );

  const fittedIdentities = [];
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(
      response.outputs.filter((output) => output.portId === "control").length,
      1,
      "each admitted object configures its independently persisted result batch",
    );
    const omm = reassembleRecordStream(response.outputs, "omm");
    const ocm = reassembleRecordStream(response.outputs, "ocm");
    const obd = reassembleRecordStream(response.outputs, "obd");
    assert.ok(omm.recordCount >= 1n);
    assert.equal(ocm.recordCount, omm.recordCount);
    assert.equal(obd.recordCount, omm.recordCount);

    const identities = new Set(
      splitSizePrefixedRecords(omm.stream).map((record) => {
        const value = OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record));
        return `${value.NORAD_CAT_ID()}:${value.OBJECT_NAME()}`;
      }),
    );
    assert.deepEqual(
      [...identities],
      [`${objects[index].norad}:${objects[index].objectName}`],
      "one continuation mixed, duplicated, or omitted provider objects",
    );
    fittedIdentities.push(...identities);
  }
  assert.deepEqual(
    fittedIdentities,
    objects.map(({ norad, objectName }) => `${norad}:${objectName}`),
  );
});

test("OD reassembles native chunks, aggregates one object's epochs, and persists them independently", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const signed = new Uint8Array(
    fs.readFileSync(path.join(nodeRoot, "dist/isomorphic/module.wasm")),
  );
  const portable = extractPublicationRecordCollection(signed)?.payloadBytes ?? signed;
  const harness = await createBrowserModuleHarness({
    wasmSource: portable,
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const fixture = makeLongMemeFixture();
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const firstBoundary = Math.floor(fixture.byteLength / 3);
  const secondBoundary = Math.floor((fixture.byteLength * 2) / 3);
  const chunks = [
    fixture.subarray(0, firstBoundary),
    fixture.subarray(firstBoundary, secondBoundary),
    fixture.subarray(secondBoundary),
  ].map((data, sequence) =>
    makeChunk({
      data,
      sequence,
      final: sequence === 2,
      totalBytes: fixture.byteLength,
      checksum,
    }),
  );

  const partial = await harness.invoke({
    methodId: "fit",
    inputs: [inputFrame(chunks[0]), inputFrame(chunks[1])],
  });
  assert.equal(partial.statusCode, 0, partial.errorMessage);
  assert.deepEqual(partial.outputs, []);
  assert.equal(partial.yielded, false);
  assert.equal(partial.backlogRemaining, 0);

  const complete = await harness.invoke({
    methodId: "fit",
    inputs: [inputFrame(chunks[2])],
  });
  assert.equal(complete.statusCode, 0, complete.errorMessage);
  assert.equal(complete.yielded, false);
  assert.equal(complete.backlogRemaining, 0);
  const controlFrames = complete.outputs.filter((output) => output.portId === "control");
  assert.equal(controlFrames.length, 1, "one idempotent FlatSQL configuration accompanies each fit batch");
  const control = decodeControl(controlFrames[0]);
  assert.equal(control.operation, 3);
  assert.ok(control.requestId > 0n);
  assert.equal(control.databaseName, "supplemental-omm");
  assert.deepEqual(control.bindings, [
    { fileIdentifier: "$OMM", tableName: "OMM" },
    { fileIdentifier: "$OCM", tableName: "OCM" },
    { fileIdentifier: "$OBD", tableName: "OBD" },
  ]);
  for (const marker of [
    /table\s+OMM/,
    /table\s+OCM/,
    /table\s+OBD/,
    /REFERENCE_FRAME\s*:\s*RFM/,
    /METADATA\s*:\s*Metadata/,
    /SENSORS\s*:\s*\[odSensorContribution\]/,
  ]) {
    assert.match(control.schemaIdl, marker);
  }
  const outputs = complete.outputs
    .filter((output) => recordOutputPorts.includes(output.portId))
    .map(decodeOutput);
  let persistedRecordCount = 0n;
  for (const portId of recordOutputPorts) {
    const matches = outputs
      .filter((output) => output.portId === portId)
      .sort((left, right) => left.sequence - right.sequence);
    assert.ok(matches.length >= 1, `missing fitted ${portId}`);
    const first = matches[0];
    assert.ok(
      first.recordCount > BigInt(matches.length),
      `${portId} records were not aggregated: records=${first.recordCount} frames=${matches.length}`,
    );
    persistedRecordCount += first.recordCount;
    const stream = new Uint8Array(
      matches.reduce((total, output) => total + output.data.byteLength, 0),
    );
    let streamOffset = 0;
    for (let index = 0; index < matches.length; index += 1) {
      const output = matches[index];
      assert.equal(output.requestId, first.requestId);
      assert.equal(output.sequence, index);
      assert.equal(output.final, index + 1 === matches.length);
      assert.equal(output.totalBytes, first.totalBytes);
      assert.equal(output.recordCount, first.recordCount);
      assert.deepEqual(output.checksum, first.checksum);
      assert.equal(output.schemaName, portId.toUpperCase());
      assert.equal(output.fileIdentifier, `$${portId.toUpperCase()}`);
      assert.ok(output.data.byteLength > 8);
      assert.ok(output.data.byteLength <= 1_048_576);
      stream.set(output.data, streamOffset);
      streamOffset += output.data.byteLength;
    }
    assert.equal(BigInt(stream.byteLength), first.totalBytes);
    assert.deepEqual(
      first.checksum,
      new Uint8Array(crypto.createHash("sha256").update(stream).digest()),
    );
    assert.equal(BigInt(countSizePrefixedRecords(stream)), first.recordCount);
    assert.equal(
      new TextDecoder().decode(stream.subarray(8, 12)),
      `$${portId.toUpperCase()}`,
    );
  }

  const flatSqlRoot = path.join(packageRoot, "../../../flatsql/wasm/node");
  const flatSqlManifest = JSON.parse(
    fs.readFileSync(path.join(flatSqlRoot, "plugin-manifest.json"), "utf8"),
  );
  const flatSqlSigned = new Uint8Array(
    fs.readFileSync(path.join(flatSqlRoot, "dist/isomorphic/module.wasm")),
  );
  const flatSqlPortable =
    extractPublicationRecordCollection(flatSqlSigned)?.payloadBytes ?? flatSqlSigned;
  const opaqueValues = new Map();
  const opaqueKey = (params) => `${params.namespace}\0${params.key}`;
  const flatSql = await createBrowserModuleHarness({
    wasmSource: flatSqlPortable,
    manifest: flatSqlManifest,
    surface: "direct",
    hostcallDispatch(operation, params) {
      if (operation === "storage.adapter.opaque.read") {
        const value = opaqueValues.get(opaqueKey(params));
        return {
          found: value !== undefined,
          bytes_b64: value?.slice() ?? new Uint8Array(),
        };
      }
      if (operation === "storage.adapter.opaque.replace") {
        assert.ok(params.data instanceof Uint8Array);
        opaqueValues.set(opaqueKey(params), params.data.slice());
        return { stored_bytes: params.data.byteLength };
      }
      if (operation === "storage.adapter.opaque.list") {
        const prefix = `${params.namespace}\0`;
        return {
          keys: [...opaqueValues.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length))
            .sort(),
        };
      }
      if (operation === "storage.adapter.opaque.delete") {
        opaqueValues.delete(opaqueKey(params));
        return { deleted: true };
      }
      if (operation === "storage.adapter.opaque.sync") {
        return { synced: true };
      }
      throw new Error(`unexpected FlatSQL host operation ${operation}`);
    },
  });
  t.after(() => flatSql.destroy());
  const append = await flatSql.invoke({
    methodId: "append_records",
    inputs: complete.outputs
      .filter((output) => output.portId !== "status")
      .map((output) => ({
        ...output,
        portId: output.portId === "control" ? "control" : "records",
      })),
  });
  assert.equal(append.statusCode, 0, append.errorMessage);
  const appendStatusFrame = append.outputs.find((output) => output.portId === "status");
  assert.ok(appendStatusFrame, "FlatSQL returns its append status");
  const appendStatus = FSO.getRootAsFSO(
    new ByteBuffer(new Uint8Array(appendStatusFrame.payload)),
  );
  assert.equal(appendStatus.OPERATION(), 1);
  const appendErrorCode = appendStatus.ERROR_CODE();
  const appendMessage = new TextDecoder().decode(
    appendStatus.messageArray() ?? new Uint8Array(),
  );
  assert.equal(
    appendStatus.STATUS(),
    4,
    `${typeof appendErrorCode === "string" ? appendErrorCode : new TextDecoder().decode(appendErrorCode ?? new Uint8Array())}: ${appendMessage}`,
  );
  assert.equal(
    appendStatus.AFFECTED_RECORDS(),
    persistedRecordCount,
    "every fitted epoch record is persisted by the independent FlatSQL node",
  );
});

test("OD package owns no local schema or Go control plane", () => {
  const forbidden = [];
  if (fs.existsSync(nodeRoot)) {
    const stack = [nodeRoot];
    while (stack.length > 0) {
      const directory = stack.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(candidate);
        else if (entry.name.endsWith(".go") || entry.name.endsWith(".fbs")) {
          forbidden.push(path.relative(packageRoot, candidate));
        }
      }
    }
  }
  assert.deepEqual(forbidden, []);
});
