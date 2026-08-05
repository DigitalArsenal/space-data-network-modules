import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
import { flatSqlNodeOperation } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeOperation.js";
import { flatSqlNodeStatus } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeStatus.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/OMM.js";
import { OCM } from "../../../../spacedatastandards.org/lib/js/OCM/OCM.js";
import { selectLatestManifestEntries } from "../scripts/benchmark-starlink-catalog.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeRoot = path.join(packageRoot, "nodes/od");
const modulesRoot = path.resolve(packageRoot, "../..");
const inputPorts = ["starlink", "glonass", "intelsat", "cpf", "iss"];
const recordOutputPorts = ["omm", "ocm"];
const fsbAlignedSize = 1_048_744;
const fsbAlignedDataCapacity = 1_048_576;
const maxStarlinkManifestBytes = 8 * 1024 * 1024;
const maxStarlinkSourceBytes = 4 * 1024 * 1024;
const liveFetchWaveWidth = 64;
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

function completeCanonicalObjectFrames({
  data,
  requestId,
  schemaName,
  fileIdentifier = "MEME",
  portId = "starlink",
  chunkBytes = fsbAlignedDataCapacity,
}) {
  assert.ok(data.byteLength > 0);
  assert.ok(Number.isSafeInteger(chunkBytes) && chunkBytes > 0);
  const checksum = crypto.createHash("sha256").update(data).digest();
  const frames = [];
  for (let offset = 0, sequence = 0; offset < data.byteLength; sequence += 1) {
    const end = Math.min(offset + chunkBytes, data.byteLength);
    frames.push(
      inputFrame(
        makeChunk({
          data: data.subarray(offset, end),
          sequence,
          final: end === data.byteLength,
          totalBytes: data.byteLength,
          checksum,
          requestId,
          schemaName,
          fileIdentifier,
        }),
        { portId },
      ),
    );
    offset = end;
  }
  return frames;
}

async function readBoundedHttpBody(response, maximumBytes, label) {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > maximumBytes
    ) {
      throw new Error(
        `${label} Content-Length ${declared} exceeds ${maximumBytes}`,
      );
    }
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`${label} exceeded ${maximumBytes} bytes`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = new Uint8Array(value ?? 0);
    if (chunk.byteLength > maximumBytes - byteLength) {
      await reader.cancel(`${label} exceeded its byte bound`);
      throw new Error(`${label} exceeded ${maximumBytes} bytes`);
    }
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

function capturedMemeHeaderAndBlocks() {
  const lines = fs.readFileSync(
    path.join(
      modulesRoot,
      "analysis/od/tests/data/supgp-reference/starlink-live-20260714/meme/" +
        "MEME_67850_STARLINK-36840_1950953_Operational_1468317240_UNCLASSIFIED.txt",
    ),
    "utf8",
  ).split(/\r?\n/);
  const dataStart = lines.findIndex((line) => line.trim() === "UVW") + 1;
  assert.ok(dataStart >= 4);
  const blocks = [];
  for (let index = dataStart; index + 3 < lines.length; index += 4) {
    assert.match(lines[index], /^\d{13}\.\d{3}\s/);
    blocks.push(lines.slice(index, index + 4));
  }
  return { header: lines.slice(0, dataStart), blocks };
}

function capturedMemeBlocksFixture(indices) {
  const { header, blocks } = capturedMemeHeaderAndBlocks();
  const selected = indices.map((index) => {
    assert.ok(index >= 0 && index < blocks.length);
    return blocks[index];
  });
  return new TextEncoder().encode(
    `${[...header, ...selected.flat()].join("\n")}\n`,
  );
}

function makeLongMemeFixture() {
  // Fourteen hours of a captured EME2000 Starlink product contains two
  // complete inclusive eight-hour windows on the six-hour anchor grid.
  return capturedMemeBlocksFixture(
    Array.from({ length: 14 * 60 + 1 }, (_, index) => index),
  );
}

function makeProductionShapedMemeFixture() {
  const { blocks } = capturedMemeHeaderAndBlocks();
  return capturedMemeBlocksFixture(
    Array.from({ length: blocks.length }, (_, index) => index),
  );
}

function irregularMemeObservationMinutes() {
  const minutes = [];
  for (let minute = 0; minute <= 24 * 60; minute += 30) {
    if (![360, 720, 960].includes(minute)) minutes.push(minute);
  }
  minutes.push(370, 730, 950);
  return minutes.sort((left, right) => left - right);
}

function makeIrregularMemeFixture() {
  return capturedMemeBlocksFixture(irregularMemeObservationMinutes());
}

function makeGlonassSp3Fixture() {
  const source = fs.readFileSync(
    path.join(modulesRoot, "analysis/od/tests/data/glonass/iac_glonass.sp3.glo"),
    "utf8",
  );
  const lines = source
    .split(/\r?\n/)
    .filter((line) =>
      line.startsWith("#") ||
      line.startsWith("*") ||
      line.startsWith("PR01") ||
      line.startsWith("PR02")
    );
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

function capturedCelestrakComparisonWindow(fullFixture) {
  const lines = new TextDecoder().decode(fullFixture).split(/\r?\n/);
  const dataStart = lines.findIndex((line) => line.trim() === "UVW") + 1;
  assert.ok(dataStart >= 4);
  const blocks = [];
  for (let index = dataStart; index + 3 < lines.length; index += 4) {
    assert.match(lines[index], /^\d{13}\.\d{3}\s/);
    blocks.push(lines.slice(index, index + 4));
  }
  const first = blocks.findIndex(([state]) =>
    state.startsWith("2026195111042.000 ")
  );
  assert.ok(first >= 0, "captured CelesTrak epoch needs an exact source state");
  const selected = blocks.slice(first, first + 481);
  assert.equal(selected.length, 481);
  assert.match(selected.at(-1)[0], /^2026195191042\.000\s/);
  return new TextEncoder().encode(
    `${[...lines.slice(0, dataStart), ...selected.flat()].join("\n")}\n`,
  );
}

function memeStateTimestampToIso(timestamp) {
  assert.match(timestamp, /^\d{13}\.\d{3}$/);
  const year = Number(timestamp.slice(0, 4));
  const dayOfYear = Number(timestamp.slice(4, 7));
  const hour = Number(timestamp.slice(7, 9));
  const minute = Number(timestamp.slice(9, 11));
  const second = Number(timestamp.slice(11, 13));
  const millisecond = Number(timestamp.slice(14, 17));
  return new Date(
    Date.UTC(year, 0, dayOfYear, hour, minute, second, millisecond),
  ).toISOString();
}

function memeToEme2000Oem(memeFixture) {
  const states = new TextDecoder()
    .decode(memeFixture)
    .split(/\r?\n/)
    .filter((line) => /^\d{13}\.\d{3}\s/.test(line))
    .map((line) => {
      const [epoch, ...components] = line.trim().split(/\s+/);
      assert.equal(components.length, 6);
      return `${memeStateTimestampToIso(epoch)} ${components.join(" ")}`;
    });
  assert.ok(states.length >= 3);
  return new TextEncoder().encode(
    [
      "CCSDS_OEM_VERS = 3.0",
      "OBJECT_NAME = STARLINK-36840",
      "OBJECT_ID = 2026-034A",
      "CENTER_NAME = EARTH",
      "REF_FRAME = EME2000",
      "TIME_SYSTEM = UTC",
      ...states,
      "",
    ].join("\n"),
  );
}

function makeIterationBoundMemeFixture() {
  // Preserve a valid captured EME2000 eight-hour window, but add alternating
  // deterministic position errors that no single SGP4 element set can fit
  // below the publication quality ceiling.
  const { header, blocks } = capturedMemeHeaderAndBlocks();
  const selected = blocks.slice(0, 481).map((block, index) => {
    const [epoch, ...components] = block[0].trim().split(/\s+/);
    assert.equal(components.length, 6);
    const axis = index % 3;
    const sign = index % 2 === 0 ? 1 : -1;
    components[axis] = (
      Number(components[axis]) + sign * 100
    ).toFixed(10);
    return [`${epoch} ${components.join(" ")}`, ...block.slice(1)];
  });
  assert.equal(selected.length, 481);
  return new TextEncoder().encode(
    `${[...header, ...selected.flat()].join("\n")}\n`,
  );
}

function makeTerminalReentryMemeFixture(stateCount = 841) {
  assert.ok(Number.isSafeInteger(stateCount) && stateCount >= 3);
  const { header, blocks } = capturedMemeHeaderAndBlocks();
  const selected = blocks
    .slice(0, stateCount)
    .map((block) => [...block]);
  assert.equal(selected.length, stateCount);
  const [epoch, ...components] = selected.at(-1)[0].trim().split(/\s+/);
  assert.equal(components.length, 6);
  const position = components.slice(0, 3).map(Number);
  const radius = Math.hypot(...position);
  const terminalRadiusKm = 6_378.135 + 119;
  for (let index = 0; index < 3; index += 1) {
    components[index] = (
      position[index] * terminalRadiusKm / radius
    ).toFixed(10);
  }
  selected.at(-1)[0] = `${epoch} ${components.join(" ")}`;
  return new TextEncoder().encode(
    `${[...header, ...selected.flat()].join("\n")}\n`,
  );
}

function dateToMemeStateTimestamp(date) {
  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const dayOfYear =
    Math.floor((date.getTime() - yearStart) / (24 * 60 * 60 * 1000)) + 1;
  return (
    `${year}${String(dayOfYear).padStart(3, "0")}` +
    `${String(date.getUTCHours()).padStart(2, "0")}` +
    `${String(date.getUTCMinutes()).padStart(2, "0")}` +
    `${String(date.getUTCSeconds()).padStart(2, "0")}.` +
    `${String(date.getUTCMilliseconds()).padStart(3, "0")}`
  );
}

function makeCumulativelyDriftingTerminalReentryMemeFixture() {
  const { header, blocks } = capturedMemeHeaderAndBlocks();
  const selected = blocks.slice(0, 181).map((block) => [...block]);
  const firstEpoch = selected[0][0].trim().split(/\s+/, 1)[0];
  const firstMs = Date.parse(memeStateTimestampToIso(firstEpoch));
  for (let index = 0; index < selected.length; index += 1) {
    const [, ...components] = selected[index][0].trim().split(/\s+/);
    const epochMs =
      firstMs + index * 60_000 + (index === 0 ? 0 : 1);
    selected[index][0] =
      `${dateToMemeStateTimestamp(new Date(epochMs))} ${components.join(" ")}`;
  }

  const [epoch, ...components] = selected.at(-1)[0].trim().split(/\s+/);
  const position = components.slice(0, 3).map(Number);
  const radius = Math.hypot(...position);
  const terminalRadiusKm = 6_378.135 + 119;
  for (let index = 0; index < 3; index += 1) {
    components[index] = (
      position[index] * terminalRadiusKm / radius
    ).toFixed(10);
  }
  selected.at(-1)[0] = `${epoch} ${components.join(" ")}`;
  return new TextEncoder().encode(
    `${[...header, ...selected.flat()].join("\n")}\n`,
  );
}

function makeCumulativelyDriftingTerminalReentryIssFixture() {
  const { blocks } = capturedMemeHeaderAndBlocks();
  const selected = blocks.slice(0, 31);
  const firstEpoch = selected[0][0].trim().split(/\s+/, 1)[0];
  const firstUs =
    BigInt(Date.parse(memeStateTimestampToIso(firstEpoch))) * 1_000n;
  const states = selected.map((block, index) => {
    const [, ...components] = block[0].trim().split(/\s+/);
    const epochUs =
      firstUs +
      BigInt(index) * 60_000_000n +
      BigInt(Math.max(0, index - 1)) * 500n;
    const date = new Date(Number(epochUs / 1_000n));
    const fractionalUs = String(epochUs % 1_000_000n).padStart(6, "0");
    const epoch = `${date.toISOString().slice(0, 19)}.${fractionalUs}`;
    return { epoch, components };
  });

  const terminal = states.at(-1).components;
  const position = terminal.slice(0, 3).map(Number);
  const radius = Math.hypot(...position);
  const terminalRadiusKm = 6_378.135 + 119;
  for (let index = 0; index < 3; index += 1) {
    terminal[index] = (
      position[index] * terminalRadiusKm / radius
    ).toFixed(10);
  }
  return new TextEncoder().encode(
    [
      "CCSDS_OEM_VERS = 3.0",
      "OBJECT_NAME = ISS-TERMINAL-DRIFT",
      "OBJECT_ID = 1998-067A",
      "CENTER_NAME = EARTH",
      "REF_FRAME = EME2000",
      "TIME_SYSTEM = UTC",
      ...states.map(({ epoch, components }) =>
        `${epoch} ${components.join(" ")}`
      ),
      "",
    ].join("\n"),
  );
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

function decodeStatusOutputs(response) {
  const outputs = response.outputs.filter((output) => output.portId === "status");
  const decode = (candidate) =>
    typeof candidate === "string"
      ? candidate
      : new TextDecoder().decode(candidate ?? new Uint8Array());
  return outputs.map((output) => {
    const bytes = new Uint8Array(output.payload);
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
  });
}

function decodeStatusOutput(response) {
  const outputs = decodeStatusOutputs(response);
  assert.equal(outputs.length, 1, "each consumed logical object needs one status");
  return outputs[0];
}

function classifyOdProductShape({
  statusMessage,
  trajectoryDescription,
  hasOmm,
}) {
  const terminalStatusMarked =
    /^Terminal reentry OCM complete(?:$|:|;)/.test(statusMessage);
  const terminalDescriptorMarked =
    trajectoryDescription ===
      "TERMINAL_REENTRY_SOURCE_TRAJECTORY_TEME";
  if (terminalStatusMarked || terminalDescriptorMarked) {
    assert.equal(
      terminalStatusMarked,
      true,
      "terminal OCM descriptor requires the explicit status marker",
    );
    assert.equal(
      terminalDescriptorMarked,
      true,
      "terminal status requires the exact trajectory descriptor",
    );
    assert.equal(hasOmm, false, "terminal OCM-only output cannot include an OMM");
    return "terminal-ocm";
  }
  assert.equal(
    hasOmm,
    true,
    "a normal complete fit must carry the OMM/OCM pair",
  );
  return "normal";
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

function expectedOdFlatSqlRequestIds(response, transactionId) {
  const encodeU32 = (value) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const encodeU64 = (value) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(value));
    return bytes;
  };
  const encodeText = (value) => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([encodeU32(bytes.byteLength), bytes]);
  };
  const project = (digest) => digest.readBigUInt64BE(0) || 1n;
  const streams = recordOutputPorts.map((portId) => {
    const reassembled = reassembleRecordStream(response.outputs, portId);
    const first = reassembled.chunks[0];
    const digest = crypto.createHash("sha256").update(reassembled.stream).digest();
    assert.deepEqual(digest, Buffer.from(first.checksum));
    return {
      portId,
      schemaName: first.schemaName,
      fileIdentifier: first.fileIdentifier,
      recordCount: first.recordCount,
      stream: reassembled.stream,
      digest,
    };
  });
  const transactionDigest = crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from("sdn:supplemental-omm:od:flatsql-transaction:v1\0", "utf8"),
    encodeU64(transactionId),
    encodeU32(streams.length),
    ...streams.flatMap((stream) => [
      encodeText(stream.portId),
      encodeText(stream.schemaName),
      encodeText(stream.fileIdentifier),
      encodeU64(stream.recordCount),
      encodeU64(stream.stream.byteLength),
      stream.digest,
    ]),
  ])).digest();
  const used = new Set([BigInt(transactionId)]);
  const streamIds = {};
  for (const stream of streams) {
    const base = [
      Buffer.from("sdn:supplemental-omm:od:flatsql-record-stream:v1\0", "utf8"),
      transactionDigest,
      encodeText(stream.portId),
      encodeText(stream.schemaName),
      encodeText(stream.fileIdentifier),
      encodeU64(stream.recordCount),
      encodeU64(stream.stream.byteLength),
      stream.digest,
    ];
    let salt = 0;
    let requestId;
    do {
      requestId = project(
        crypto.createHash("sha256").update(
          Buffer.concat(salt === 0 ? base : [...base, encodeU32(salt)]),
        ).digest(),
      );
      salt += 1;
    } while (used.has(requestId));
    used.add(requestId);
    streamIds[stream.portId] = requestId;
  }
  return {
    control: BigInt(transactionId),
    streams: streamIds,
  };
}

function odFlatSqlRequestIds(response) {
  const control = response.outputs.find((output) => output.portId === "control");
  assert.ok(control, "OD response is missing FlatSQL control");
  const controlRequestId = control.wireFormat === "aligned-binary"
    ? new DataView(
        control.payload.buffer,
        control.payload.byteOffset,
        control.payload.byteLength,
      ).getBigUint64(8, true)
    : decodeControl(control).requestId;
  const emittedRecordPorts = recordOutputPorts.filter((portId) =>
    response.outputs.some((output) => output.portId === portId)
  );
  assert.ok(emittedRecordPorts.length > 0, "OD response has no record stream");
  const streamIds = Object.fromEntries(emittedRecordPorts.map((portId) => {
    const outputs = response.outputs.filter((output) => output.portId === portId);
    assert.ok(outputs.length > 0, `OD response is missing ${portId}`);
    const requestIds = new Set(outputs.map((output) =>
      output.wireFormat === "aligned-binary"
        ? new DataView(
            output.payload.buffer,
            output.payload.byteOffset,
            output.payload.byteLength,
          ).getBigUint64(8, true)
        : decodeOutput(output).requestId));
    assert.equal(requestIds.size, 1, `${portId} chunks changed request identity`);
    return [portId, [...requestIds][0]];
  }));
  return { control: controlRequestId, streams: streamIds };
}

async function createFlatSqlPersistenceHarness(
  t,
  { opaqueValues = new Map(), registerCleanup = true } = {},
) {
  const flatSqlRoot = path.join(packageRoot, "nodes/flatsql");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(flatSqlRoot, "plugin-manifest.json"), "utf8"),
  );
  const signed = new Uint8Array(
    fs.readFileSync(path.join(flatSqlRoot, "dist/isomorphic/module.wasm")),
  );
  const portable = extractPublicationRecordCollection(signed)?.payloadBytes ?? signed;
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
  if (registerCleanup) t.after(() => harness.destroy());
  return harness;
}

function flatSqlMethodType(methodId, direction, portId) {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "nodes/flatsql/plugin-manifest.json"),
      "utf8",
    ),
  );
  const method = manifest.methods.find((candidate) => candidate.methodId === methodId);
  assert.ok(method, `missing FlatSQL method ${methodId}`);
  const ports = direction === "input" ? method.inputPorts : method.outputPorts;
  const port = ports.find((candidate) => candidate.portId === portId);
  assert.ok(port, `missing FlatSQL ${methodId}.${portId} ${direction} port`);
  const type = port.acceptedTypeSets
    .flatMap((set) => set.allowedTypes)
    .find((candidate) => candidate.wireFormat === "flatbuffer");
  assert.ok(type, `FlatSQL ${methodId}.${portId} needs canonical FlatBuffer`);
  return type;
}

function makeFlatSqlQuery(requestId, query) {
  const builder = new Builder(query.length + 256);
  const databaseName = builder.createString("supplemental-omm");
  const queryBytes = FSO.createQueryVector(builder, new TextEncoder().encode(query));
  FSO.startFSO(builder);
  FSO.addOperation(builder, flatSqlNodeOperation.QUERY_RECORDS);
  FSO.addRequestId(builder, requestId);
  FSO.addDatabaseName(builder, databaseName);
  FSO.addQuery(builder, queryBytes);
  const root = FSO.endFSO(builder);
  FSO.finishFSOBuffer(builder, root);
  return builder.asUint8Array();
}

async function flatSqlTableRecordCount(harness, tableName, requestId) {
  const response = await harness.invoke({
    methodId: "query_records",
    inputs: [{
      portId: "query",
      typeRef: flatSqlMethodType("query_records", "input", "query"),
      payload: makeFlatSqlQuery(requestId, `SELECT _data FROM ${tableName}`),
    }],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const status = decodeStatusOutput(response);
  assert.equal(status.status, flatSqlNodeStatus.COMPLETE, status.message);
  const chunks = response.outputs
    .filter((output) => output.portId === "records")
    .map(decodeOutput)
    .sort((left, right) => left.sequence - right.sequence);
  assert.ok(chunks.length > 0, `FlatSQL query returned no ${tableName} frames`);
  assert.equal(chunks[0].recordCount, status.affectedRecords);
  return chunks[0].recordCount;
}

function odOutputsForFlatSql(response) {
  return response.outputs
    .filter((output) => output.portId !== "status")
    .map((output) => ({
      portId: output.portId === "control" ? "control" : "records",
      wireFormat: output.wireFormat,
      typeRef: { ...output.typeRef },
      payload: new Uint8Array(output.payload).slice(),
    }));
}

function rewriteControlRequestId(output, requestId) {
  const payload = new Uint8Array(output.payload).slice();
  const value = FSO.getRootAsFSO(new ByteBuffer(payload));
  const field = value.bb.__offset(value.bb_pos, 6);
  assert.ok(field, "FSO control request ID is present");
  new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    .setBigUint64(value.bb_pos + field, requestId, true);
  return { ...output, payload };
}

function opaqueStateDigest(opaqueValues) {
  const digest = crypto.createHash("sha256");
  for (const [key, value] of [...opaqueValues.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0)) {
    digest.update(key);
    digest.update("\0");
    digest.update(value);
  }
  return digest.digest("hex");
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
  assert.equal(status?.maxStreams, 64);
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
    "convergenceTolerance",
    "CONFIGURE_INDEX",
    "TABLE_BINDINGS",
    "kResultSchemaIdl",
  ]) {
    assert.match(source, new RegExp(marker), `missing ${marker}`);
  }
  assert.doesNotMatch(source, /128\s*\*\s*1024|131072|rangeBytes|celestrak/i);
});

test("OD package and signed artifact contain only OMM and OCM result products", () => {
  const manifest = readJson("plugin-manifest.json");
  const method = manifest.methods?.find((candidate) => candidate.methodId === "fit");
  assert.ok(method);
  assert.deepEqual(
    method.outputPorts.map((port) => port.portId),
    ["control", "status", "omm", "ocm"],
  );

  for (const relativePath of [
    "src/node.cpp",
    "manifest.mjs",
    "build.mjs",
    "README.md",
    "vendor/od_batch_fit.hpp",
  ]) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(nodeRoot, relativePath), "utf8"),
      /\bOBD\b|\bobd\b/,
      `${relativePath} still owns the retired OBD product`,
    );
  }
  const sourcePatch = fs.readFileSync(
    path.join(nodeRoot, "vendor/od-fit-core-source.patch"),
    "utf8",
  );
  const addedPatchLines = sourcePatch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  assert.doesNotMatch(
    addedPatchLines,
    /\bOBD\b|\bobd\b/,
    "the reconstructed fit core still adds the retired OBD product",
  );

  const artifact = fs.readFileSync(path.join(nodeRoot, "dist/isomorphic/module.wasm"));
  assert.doesNotMatch(
    artifact.toString("latin1"),
    /\$OBD|OBD\.fbs/,
    "the signed OD child still embeds the retired OBD schema or port",
  );
});

test("OD admits bounded nonempty batches to the real fitter and releases fitted OEM bytes", () => {
  const source = fs.readFileSync(path.join(nodeRoot, "src/node.cpp"), "utf8");
  const header = fs.readFileSync(path.join(nodeRoot, "vendor/od_batch_fit.hpp"), "utf8");
  const patch = fs.readFileSync(
    path.join(nodeRoot, "vendor/od-fit-core-source.patch"),
    "utf8",
  );

  assert.match(source, /kMaxFitBatchObjects\s*=\s*16\s*;/);
  assert.match(source, /kFitWorkerThreads\s*=\s*16\s*;/);
  assert.match(source, /kMaxFitBatchBytes\s*=\s*\d+u?\s*\*\s*1024u?\s*\*\s*1024u?\s*;/);
  assert.match(
    source,
    /run_batch_fit\s*\(\s*batch_objects\s*,\s*kFitWorkerThreads\s*,\s*&stats\s*\)/,
    "the signed node must pass admitted complete objects into the real fitter",
  );
  assert.doesNotMatch(
    source,
    /run_batch_fit\s*\(\s*no_objects|fit_one_bounded/,
    "a link-only empty call or serial wrapper is not a parallel OD batch",
  );
  assert.match(source, /g_fitted_fit_objects/);
  assert.match(
    source,
    /std::vector<od::BatchObject>\s*\(\s*\)\.swap\s*\(\s*batch_objects\s*\)/,
    "complete source ephemerides must be released as soon as their batch fit returns",
  );

  assert.match(header, /std::string\s+fit_options\s*;/);
  assert.match(patch, /obj\.fit_options/);
  assert.match(patch, /preflight_fit_epochs/);
  assert.doesNotMatch(
    patch,
    /if\s*\(\s*!epoch\.ok[^)]*\)\s*continue/,
    "one incomplete epoch must reject the entire source fit before any result moves",
  );
});

test("OD globally bounds native assemblies and every queued fit stage", () => {
  const manifest = readJson("plugin-manifest.json");
  const method = manifest.methods?.find((candidate) => candidate.methodId === "fit");
  assert.equal(method?.maxBatch, 64);
  for (const port of method?.inputPorts ?? []) {
    assert.equal(port.maxStreams, 64, `${port.portId} input stream bound changed`);
  }
  assert.equal(
    method?.outputPorts.find((port) => port.portId === "status")?.maxStreams,
    64,
  );
  for (const portId of recordOutputPorts) {
    assert.equal(
      method?.outputPorts.find((port) => port.portId === portId)?.maxStreams,
      64,
    );
  }

  const source = fs.readFileSync(path.join(nodeRoot, "src/node.cpp"), "utf8");
  for (const declaration of [
    /kGuestTransientBudgetBytes\s*=\s*256u?\s*\*\s*1024u?\s*\*\s*1024u?\s*;/,
    /kMaxIncompleteAssemblies\s*=\s*64\s*;/,
    /kMaxIncompleteAssemblyDeclaredBytes\s*=\s*256u?\s*\*\s*1024u?\s*\*\s*1024u?\s*;/,
    /kMaxIncompleteAssemblyBytes\s*=\s*128u?\s*\*\s*1024u?\s*\*\s*1024u?\s*;/,
    /kMaxQueuedStorageBytes\s*=\s*192u?\s*\*\s*1024u?\s*\*\s*1024u?\s*;/,
    /kMaxPendingFitObjects\s*=\s*64\s*;/,
    /kMaxPendingFitBytes\s*=\s*128u?\s*\*\s*1024u?\s*\*\s*1024u?\s*;/,
    /kMaxFittedFitObjects\s*=\s*16\s*;/,
    /kMaxFittedFitBytes\s*=\s*8u?\s*\*\s*1024u?\s*\*\s*1024u?\s*;/,
  ]) {
    assert.match(source, declaration);
  }
  assert.doesNotMatch(
    source,
    /fresh\.bytes\.reserve\s*\(\s*static_cast<size_t>\s*\(\s*chunk\.total_bytes\s*\)\s*\)/,
    "declared TOTAL_BYTES must not become an eager allocation",
  );
  for (const accounting of [
    "incomplete_assembly_declared_bytes",
    "incomplete_assembly_bytes",
    "pending_fit_bytes",
    "fitted_fit_bytes",
    "queued_storage_bytes",
  ]) {
    assert.match(source, new RegExp(accounting), `missing ${accounting}`);
  }
});

test("OD passes a deterministic supported work bound to every complete-arc fit", () => {
  const source = fs.readFileSync(path.join(nodeRoot, "src/node.cpp"), "utf8");
  const header = fs.readFileSync(path.join(nodeRoot, "vendor/od_batch_fit.hpp"), "utf8");
  const patch = fs.readFileSync(
    path.join(nodeRoot, "vendor/od-fit-core-source.patch"),
    "utf8",
  );
  const declaredBound = source.match(/kMaxFitIterations\s*=\s*(\d+)\s*;/);
  assert.ok(declaredBound, "signed OD source must declare its solver-work bound");
  const maxIterations = Number(declaredBound[1]);
  assert.equal(maxIterations, 60);

  const encodedBound = source.match(/"maxIterations"\s*:\s*(\d+)/);
  assert.ok(encodedBound, "signed OD source must encode the supported maxIterations option");
  assert.equal(Number(encodedBound[1]), maxIterations);
  assert.match(source, /"multiEpochSpacingSeconds"\s*:\s*21600/);
  assert.match(source, /"multiEpochWindowSeconds"\s*:\s*28800/);
  assert.match(
    source,
    /object\.fit_options\.assign\s*\(\s*kFitOptions\.data\(\),\s*kFitOptions\.size\(\)\s*\)/,
    "every admitted object must carry the nonempty deterministic options",
  );
  assert.match(header, /std::string\s+fit_options\s*;/);
  assert.match(
    patch,
    /fit_ephemeris_epochs_fb\([^;]+obj\.fit_options/s,
    "the real batch fitter must receive each object's deterministic options",
  );
  assert.match(patch, /multi_epoch_spacing_sec/);
  assert.match(patch, /multi_epoch_window_sec/);
  assert.match(patch, /use_all_window_states/);
});

test("OD preflights every returned epoch before moving any result bytes", () => {
  const patch = fs.readFileSync(
    path.join(nodeRoot, "vendor/od-fit-core-source.patch"),
    "utf8",
  );
  const reconstructed = patch
    .split("\n")
    .filter((line) =>
      line.startsWith(" ") ||
      (line.startsWith("+") && !line.startsWith("+++"))
    )
    .map((line) => line.slice(1))
    .join("\n");
  const helper = reconstructed.match(
    /bool preflight_fit_epochs\([^]*?\n\}/,
  )?.[0];
  assert.ok(helper, "frozen batch core must own an all-epoch preflight helper");
  assert.match(helper, /for\s*\(const PluginFitFBResult& epoch : epochs\)/);
  assert.match(
    helper,
    /!epoch\.ok\s*\|\|\s*epoch\.omm\.empty\(\)\s*\|\|\s*epoch\.ocm\.empty\(\)/,
  );
  assert.match(
    helper,
    /\*error_code = epoch\.error_code\.empty\(\)[^]*?: epoch\.error_code;/,
  );
  assert.match(
    helper,
    /\*error_message = epoch\.error_message\.empty\(\)[^]*?: epoch\.error_message;/,
  );
  assert.match(helper, /fit-incomplete-epoch/);

  const boundedFit = reconstructed.match(
    /BatchResult fit_one\([^]*?\n\}/,
  )?.[0];
  assert.ok(boundedFit);
  const preflight = boundedFit.indexOf("preflight_fit_epochs");
  const firstMove = boundedFit.indexOf("std::move");
  const accepted = boundedFit.indexOf("r.ok = true");
  assert.ok(preflight >= 0, "bounded fit must invoke all-epoch preflight");
  assert.ok(firstMove >= 0);
  assert.ok(accepted >= 0);
  assert.ok(
    preflight < firstMove,
    "all epochs must pass preflight before any result bytes are moved",
  );
  assert.ok(
    preflight < accepted,
    "the object cannot become successful before all epochs pass preflight",
  );
  assert.doesNotMatch(
    boundedFit,
    /if\s*\(!epoch\.ok\s*\|\|\s*epoch\.omm\.empty\(\)\)\s*continue/,
  );
});

test("OD convergence belongs only to the elements selected for publication", () => {
  const patch = fs.readFileSync(
    path.join(nodeRoot, "vendor/od-fit-core-source.patch"),
    "utf8",
  );
  assert.doesNotMatch(
    patch,
    /previously_converged|result\.converged\s*=\s*result\.converged\s*\|\|/,
    "a discarded fit cannot transfer convergence to a lower-RMS element set",
  );
  assert.doesNotMatch(
    patch,
    /^\+\s*result\.converged\s*=\s*true\s*;/m,
    "a fixed-budget derivative-free search cannot claim LM convergence",
  );
  assert.ok(
    [...patch.matchAll(/^\+\s*result\.converged\s*=\s*false\s*;/gm)].length >= 2,
    "Nelder-Mead and differential evolution must remain search seeds",
  );
  assert.match(
    patch,
    /if\s*\(\s*\(!best_result\.converged\s*\|\|\s*best_result\.rms_km\s*>\s*0\.28\)/,
    "multi-start admission must account for a low-RMS non-converged primary",
  );
  assert.match(
    patch,
    /if\s*\(\s*best_result\.converged\s*&&\s*best_result\.rms_km\s*<\s*0\.22\s*\)\s*break;/,
    "multi-start cannot stop early on a low-RMS non-converged incumbent",
  );
});

test("OD benchmark metrics cover terminal drains and product validation", () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const section = (startParts, endParts) => {
    const start = source.indexOf(startParts.join(""));
    const end = source.indexOf(endParts.join(""), start + 1);
    assert.ok(start >= 0, `missing benchmark marker ${startParts.join("")}`);
    assert.ok(end > start, `missing section end ${endParts.join("")}`);
    return source.slice(start, end);
  };

  const batch = section(
    ["OD fits one bounded provider batch and drains fitted results ", "through zero-input continuations"],
    ["OD preserves source transaction IDs across transport, chunking, ", "wire format, and restart"],
  );
  assert.ok(
    batch.indexOf("const batchElapsedMs") >
      batch.indexOf('harness.invoke({ methodId: "fit", inputs: [] })'),
    "bounded-batch timing must include every zero-input output continuation",
  );
  assert.match(batch, /fitAndFullOutputDrainMs=/);

  const realCorpus = section(
    ["benchmark OD on complete real MEME files sampled across ", "the retained catalog"],
    ["benchmark OD full-arc ", "worker scaling"],
  );
  assert.ok(
    realCorpus.indexOf("const usageAfter") >
      realCorpus.indexOf("OMM/OCM epochs diverged"),
    "real-corpus wall/CPU/resource samples must end after product validation",
  );
  assert.match(realCorpus, /p50FullBatchFitDrainValidationSeconds=/);
  assert.match(source, /const terminalStatusMarked/);
  assert.match(source, /Terminal reentry OCM complete/);
  assert.match(source, /TERMINAL_REENTRY_SOURCE_TRAJECTORY_TEME/);
  assert.match(realCorpus, /classifyOdProductShape/);
  assert.match(realCorpus, /terminalOcmOnlyObjects/);
  assert.match(realCorpus, /terminalOcm\.ORBIT_DETERMINATION\(\), null/);
  assert.match(realCorpus, /observationCount === 481 \|\| observationCount === 241/);
  assert.ok(
    realCorpus.indexOf("responses.length >= maximumDrainResponses") <
      realCorpus.indexOf(
        'await harness.invoke({ methodId: "fit", inputs: [] })',
        realCorpus.indexOf("responses.length >= maximumDrainResponses"),
      ),
    "the drain bound must be checked before requesting another continuation",
  );
  assert.ok(
    realCorpus.indexOf("await harness.threadHost?.terminateAll?.()") <
      realCorpus.indexOf(
        "harness.destroy()",
        realCorpus.indexOf("await harness.threadHost?.terminateAll?.()"),
      ),
    "benchmark worker termination must finish before harness destruction",
  );

  const fullArc = section(
    ["benchmark OD full-arc ", "worker scaling"],
    ["OD reassembles native chunks, aggregates one object's epochs, ", "and persists them independently"],
  );
  assert.match(
    fullArc,
    /harness\.invoke\(\{ methodId: "fit", inputs: \[\] \}\)/,
    "full-arc scaling must drain zero-input continuations",
  );
  assert.ok(
    fullArc.indexOf("const elapsedSeconds") >
      fullArc.indexOf("OMM/OCM epochs diverged"),
    "full-arc wall timing must include all per-source OMM/OCM validation",
  );
  assert.match(fullArc, /endToEndFitDrainValidationSeconds=/);
});

test("OD benchmark product classification is explicitly terminal or paired", () => {
  assert.equal(
    classifyOdProductShape({
      statusMessage: "Terminal reentry OCM complete: STARLINK-1606",
      trajectoryDescription: "TERMINAL_REENTRY_SOURCE_TRAJECTORY_TEME",
      hasOmm: false,
    }),
    "terminal-ocm",
  );
  for (const malformed of [
    {
      statusMessage: "OD fit complete",
      trajectoryDescription: "",
      hasOmm: false,
    },
    {
      statusMessage: "Terminal reentry OCM complete: STARLINK-1606",
      trajectoryDescription: "CARTESIAN_PV",
      hasOmm: false,
    },
    {
      statusMessage: "OD fit complete",
      trajectoryDescription: "TERMINAL_REENTRY_SOURCE_TRAJECTORY_TEME",
      hasOmm: false,
    },
    {
      statusMessage: "Terminal reentry OCM complete: STARLINK-1606",
      trajectoryDescription: "TERMINAL_REENTRY_SOURCE_TRAJECTORY_TEME",
      hasOmm: true,
    },
  ]) {
    assert.throws(() => classifyOdProductShape(malformed));
  }
  assert.equal(
    classifyOdProductShape({
      statusMessage: "OD fit complete: STARLINK-1663",
      trajectoryDescription: "",
      hasOmm: true,
    }),
    "normal",
  );
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
    "e1f1baa093cb52ef6fc880e4aa4de958c2bb074b8dac4d7826c50fa540e94ea8",
  );

  const fitHeader = path.join(nodeRoot, "vendor/od_batch_fit.hpp");
  assert.ok(fs.existsSync(fitHeader), `missing ${fitHeader}`);
  assert.match(fs.readFileSync(fitHeader, "utf8"), /additional_epochs/);
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(fitHeader)).digest("hex"),
    "0cc0ffaad93fa089e274e3d24d6db1aa66c01c801a73392805d8b4d15955817a",
  );

  const sourcePatch = path.join(nodeRoot, "vendor/od-fit-core-source.patch");
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(sourcePatch)).digest("hex"),
    "c9e6042809c4ec8ce38a878fb0fd6bd1969e2f9bd4f307c924e571a090b17882",
  );
  const modulesRoot = path.resolve(packageRoot, "../..");
  const reconstructedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "supplemental-od-core-test-"),
  );
  try {
    const archived = spawnSync(
      "git",
      [
        "archive",
        "551f6e178c3332cad46171fd1a0002345271144c",
        "analysis/od",
      ],
      { cwd: modulesRoot, maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(archived.status, 0, String(archived.stderr));
    const extracted = spawnSync("tar", ["-x", "-C", reconstructedRoot], {
      input: archived.stdout,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(extracted.status, 0, String(extracted.stderr));
    const forward = spawnSync(
      "git",
      ["apply", "--check", "--unsafe-paths", sourcePatch],
      { cwd: reconstructedRoot },
    );
    assert.equal(
      forward.status,
      0,
      `vendored source delta must apply to the recorded base: ${forward.stderr}`,
    );
  } finally {
    fs.rmSync(reconstructedRoot, { recursive: true, force: true });
  }

  const license = path.join(nodeRoot, "vendor/SGP4-LICENSE.txt");
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(license)).digest("hex"),
    "771e7128d338686ef6321a67cd2e074c537c400225ea05e115bbd065236e609c",
  );
  const notice = fs.readFileSync(path.join(nodeRoot, "vendor/NOTICE.md"), "utf8");
  assert.match(notice, /base\s+revision[^]+plus the then-uncommitted/i);
  assert.match(notice, /temporary archive/i);
  assert.match(notice, /wasi-sdk:wasi-sdk-24/);
  assert.match(notice, /SGP4-LICENSE\.txt/);
});

test("OD frozen core provides an executable source-to-object reproduction", () => {
  const verifierPath = path.join(
    packageRoot,
    "scripts/verify-od-fit-core-reproducibility.mjs",
  );
  assert.ok(fs.existsSync(verifierPath), `missing ${verifierPath}`);
  const verifier = fs.readFileSync(verifierPath, "utf8");
  assert.match(verifier, /551f6e178c3332cad46171fd1a0002345271144c/);
  assert.match(
    verifier,
    /sha256:6ff1234684d0353e914106f698216a16646c64c208f46b3021676b76435cdc50/,
  );
  assert.match(
    verifier,
    /sha256:59df2a99139fad8ce3814d725c85a7a1b444ea97519186c4aa0be87cda8e6b1d/,
  );
  assert.match(
    verifier,
    /ghcr\.io\/webassembly\/wasi-sdk@sha256:59df2a99139fad8ce3814d725c85a7a1b444ea97519186c4aa0be87cda8e6b1d/,
  );
  assert.doesNotMatch(verifier, /wasi-sdk:wasi-sdk-24@sha256:/);
  assert.match(verifier, /5ab8e415ad13f1e9a75c1cdb1e990f37b1c79d75/);
  assert.match(
    verifier,
    /b04f3dad6c88b1a90e7276c115eaabf3ba7b6c94059269209d0120a83b5989a2/,
  );
  assert.match(verifier, /eigen-5\.0\.1\.tar\.gz/);
  assert.match(
    verifier,
    /e9c326dc8c05cd1e044c71f30f1b2e34a6161a3b6ecf445d56b53ff1669e3dec/,
  );
  assert.match(
    verifier,
    /0cc0ffaad93fa089e274e3d24d6db1aa66c01c801a73392805d8b4d15955817a/,
  );
  assert.match(verifier, /vendor[\\/]od_batch_fit\.hpp/);
  assert.match(verifier, /licensing\/core\/src\/cpp\/generated\/sds/);
  assert.match(verifier, /--network/);
  assert.match(verifier, /--pull/);
  for (const translationUnit of [
    "sgp4_fitter.cpp",
    "meme_parser.cpp",
    "frame_transform.cpp",
    "oem_parser.cpp",
    "oem_fb_reader.cpp",
    "omm_fb_builder.cpp",
    "ocm_fb_builder.cpp",
    "plugin_runtime.cpp",
    "SGP4.cpp",
    "od_batch_fit.cpp",
    "noexcept_stubs.cpp",
  ]) {
    assert.match(verifier, new RegExp(translationUnit.replace(".", "\\.")));
  }
  assert.match(verifier, /--target=wasm32-wasip1-threads/);
  assert.match(verifier, /-ffast-math/);
  assert.match(verifier, /timingSafeEqual/);
});

test(
  "OD frozen core rebuilds byte-identically from the pinned source archive",
  {
    skip: process.env.SDN_OD_VERIFY_FROZEN_CORE_REPRODUCIBILITY !== "1",
    timeout: Number(
      process.env.SDN_OD_VERIFY_FROZEN_CORE_TIMEOUT_MS ?? 300_000,
    ),
  },
  () => {
    const verifierPath = path.join(
      packageRoot,
      "scripts/verify-od-fit-core-reproducibility.mjs",
    );
    const timeout = Number(
      process.env.SDN_OD_VERIFY_FROZEN_CORE_TIMEOUT_MS ?? 300_000,
    );
    const verified = spawnSync(process.execPath, [verifierPath], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(
      verified.status,
      0,
      `${verified.stdout}\n${verified.stderr}`,
    );
    const report = JSON.parse(verified.stdout);
    assert.equal(report.reconstructedSourceMatchesPatch, true);
    assert.equal(report.objectMatchesVendoredBytes, true);
    assert.equal(report.headerMatchesReconstructedBytes, true);
    assert.equal(
      report.headerSha256,
      "0cc0ffaad93fa089e274e3d24d6db1aa66c01c801a73392805d8b4d15955817a",
    );
    assert.equal(
      report.objectSha256,
      "e1f1baa093cb52ef6fc880e4aa4de958c2bb074b8dac4d7826c50fa540e94ea8",
    );
  },
);

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

test("OD applies fixed FSB field bounds to canonical chunks", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const oversized = new Uint8Array(fsbAlignedDataCapacity + 1);
  const response = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(
        makeChunk({
          data: oversized,
          sequence: 0,
          final: true,
          totalBytes: oversized.byteLength,
          checksum: new Uint8Array(),
          requestId: 92_100n,
        }),
      ),
    ],
  });
  assertChunkInvalid(response);
});

test("OD rejects a sixty-fifth incomplete assembly and recovers after release", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const frame = ({ requestId, sequence = 0, totalBytes = 2 }) =>
    inputFrame(
      makeChunk({
        data: new Uint8Array([Number(requestId % 251n)]),
        sequence,
        final: false,
        totalBytes,
        checksum: new Uint8Array(),
        requestId,
      }),
    );

  const admitted = await harness.invoke({
    methodId: "fit",
    inputs: Array.from({ length: 64 }, (_, index) =>
      frame({ requestId: 92_200n + BigInt(index) })
    ),
  });
  assert.equal(admitted.statusCode, 0, admitted.errorMessage);
  assert.deepEqual(admitted.outputs, []);

  const overflow = await harness.invoke({
    methodId: "fit",
    inputs: [frame({ requestId: 92_264n })],
  });
  assert.equal(overflow.statusCode, 413, overflow.errorMessage);
  assert.equal(overflow.errorCode, "od-capacity");

  const released = await harness.invoke({
    methodId: "fit",
    inputs: [
      frame({
        requestId: 92_200n,
        sequence: 1,
        totalBytes: 3,
      }),
    ],
  });
  assertChunkInvalid(released);

  const recovered = await harness.invoke({
    methodId: "fit",
    inputs: [frame({ requestId: 92_264n })],
  });
  assert.equal(recovered.statusCode, 0, recovered.errorMessage);
  assert.equal(recovered.errorCode, null);
});

test("OD bounds aggregate declared assembly bytes without eager allocation", async (t) => {
  const source = fs.readFileSync(path.join(nodeRoot, "src/node.cpp"), "utf8");
  assert.doesNotMatch(source, /fresh\.bytes\.reserve/);
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const frame = ({ requestId, sequence = 0, totalBytes = 64 * 1024 * 1024 }) =>
    inputFrame(
      makeChunk({
        data: new Uint8Array([1]),
        sequence,
        final: false,
        totalBytes,
        checksum: new Uint8Array(),
        requestId,
        schemaName: "OEM",
        fileIdentifier: "OEM",
      }),
      { portId: "iss" },
    );

  for (let index = 0; index < 4; index += 1) {
    const admitted = await harness.invoke({
      methodId: "fit",
      inputs: [frame({ requestId: 92_300n + BigInt(index) })],
    });
    assert.equal(admitted.statusCode, 0, admitted.errorMessage);
  }
  const overflow = await harness.invoke({
    methodId: "fit",
    inputs: [frame({ requestId: 92_304n })],
  });
  assert.equal(overflow.statusCode, 413, overflow.errorMessage);
  assert.equal(overflow.errorCode, "od-capacity");

  const released = await harness.invoke({
    methodId: "fit",
    inputs: [
      frame({
        requestId: 92_300n,
        sequence: 1,
        totalBytes: 63 * 1024 * 1024,
      }),
    ],
  });
  assertChunkInvalid(released);
  const recovered = await harness.invoke({
    methodId: "fit",
    inputs: [frame({ requestId: 92_304n })],
  });
  assert.equal(recovered.statusCode, 0, recovered.errorMessage);
});

test(
  "OD bounds actual incomplete assembly storage and recovers after release",
  { timeout: 120_000 },
  async (t) => {
    const source = fs.readFileSync(path.join(nodeRoot, "src/node.cpp"), "utf8");
    assert.match(
      source,
      /kMaxIncompleteAssemblyBytes\s*=\s*128u?\s*\*\s*1024u?\s*\*\s*1024u?\s*;/,
    );
    const manifest = readJson("plugin-manifest.json");
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());
    const oneMiB = new Uint8Array(1024 * 1024);
    const totalBytes = 64 * 1024 * 1024;
    const frame = ({ requestId, sequence, declaredBytes = totalBytes }) =>
      inputFrame(
        makeChunk({
          data: oneMiB,
          sequence,
          final: false,
          totalBytes: declaredBytes,
          checksum: new Uint8Array(),
          requestId,
          schemaName: "OEM",
          fileIdentifier: "OEM",
        }),
        { portId: "iss" },
      );

    for (const requestId of [92_400n, 92_401n]) {
      for (let offset = 0; offset < 64; offset += 16) {
        const admitted = await harness.invoke({
          methodId: "fit",
          inputs: Array.from({ length: 16 }, (_, index) =>
            frame({ requestId, sequence: offset + index })
          ),
        });
        assert.equal(admitted.statusCode, 0, admitted.errorMessage);
      }
    }
    const overflow = await harness.invoke({
      methodId: "fit",
      inputs: [frame({ requestId: 92_402n, sequence: 0 })],
    });
    assert.equal(overflow.statusCode, 413, overflow.errorMessage);
    assert.equal(overflow.errorCode, "od-capacity");

    const released = await harness.invoke({
      methodId: "fit",
      inputs: [
        frame({
          requestId: 92_400n,
          sequence: 64,
          declaredBytes: totalBytes - 1,
        }),
      ],
    });
    assertChunkInvalid(released);
    const recovered = await harness.invoke({
      methodId: "fit",
      inputs: [frame({ requestId: 92_402n, sequence: 0 })],
    });
    assert.equal(recovered.statusCode, 0, recovered.errorMessage);
  },
);

test("OD rejects pending-object overflow and resumes its bounded queue", async (t) => {
  const source = fs.readFileSync(path.join(nodeRoot, "src/node.cpp"), "utf8");
  assert.match(source, /kMaxPendingFitObjects\s*=\s*64\s*;/);
  const fixture = new Uint8Array(
    fs.readFileSync(
      path.join(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme/" +
          "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
      ),
    ),
  );
  assert.ok(fixture.byteLength < fsbAlignedDataCapacity);
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const inputs = Array.from({ length: 65 }, (_, index) =>
    inputFrame(
      makeChunk({
        data: fixture,
        sequence: 0,
        final: true,
        totalBytes: fixture.byteLength,
        checksum,
        requestId: 92_500n + BigInt(index),
        schemaName: `MEME:${68_000 + index}:STARLINK-PENDING-${index}`,
      }),
    )
  );

  const overflow = await harness.invoke({ methodId: "fit", inputs });
  assert.equal(overflow.statusCode, 413, overflow.errorMessage);
  assert.equal(overflow.errorCode, "od-capacity");
  assert.deepEqual(overflow.outputs, []);

  const recovered = await harness.invoke({ methodId: "fit", inputs: [] });
  assert.equal(recovered.statusCode, 0, recovered.errorMessage);
  assert.equal(recovered.errorCode, null);
  assert.equal(recovered.backlogRemaining, 63);
  assert.equal(decodeStatusOutput(recovered).status, flatSqlNodeStatus.COMPLETE);
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
      message:
        `OD fit complete: ${successName} (NORAD ${successNorad}); ` +
        "batch_objects=1; workers=1; distinct_threads=1",
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
    assert.ok(fitStatus.requestId > 0n);
    assert.notEqual(
      fitStatus.requestId,
      fitRequestId,
      "non-Starlink wrapper counters cannot become durable transaction IDs",
    );
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
  const transactionIds = [];
  for (const response of [first, second]) {
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.errorCode, null, response.errorMessage);
    transactionIds.push(
      decodeControl(
        response.outputs.find((output) => output.portId === "control"),
      ).requestId,
    );
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
  assert.equal(new Set(transactionIds).size, transactionIds.length);
  assert.ok(
    transactionIds.every((transactionId) =>
      transactionId > 0n && transactionId !== 88001n
    ),
    "fanout children need nonzero transaction IDs distinct from their parent",
  );
});

test("OD derives a restart-stable transaction ID for one-object non-Starlink responses", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const createHarness = async () => {
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());
    return harness;
  };
  const fixture = new TextEncoder().encode(
    new TextDecoder()
      .decode(makeGlonassSp3Fixture())
      .split("\n")
      .filter((line) => !line.startsWith("PR02"))
      .join("\n"),
  );
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const parentRequestId = 1n;
  const fit = (harness) =>
    harness.invoke({
      methodId: "fit",
      inputs: [
        inputFrame(
          makeChunk({
            data: fixture,
            sequence: 0,
            final: true,
            totalBytes: fixture.byteLength,
            checksum,
            requestId: parentRequestId,
            schemaName: "SP3",
            fileIdentifier: "SP3",
          }),
          { portId: "glonass" },
        ),
      ],
    });

  const first = await fit(await createHarness());
  const afterRestart = await fit(await createHarness());
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.equal(afterRestart.statusCode, 0, afterRestart.errorMessage);
  assert.equal(first.errorCode, null, first.errorMessage);
  assert.equal(afterRestart.errorCode, null, afterRestart.errorMessage);
  const firstTransactionId = decodeControl(
    first.outputs.find((output) => output.portId === "control"),
  ).requestId;
  const restartTransactionId = decodeControl(
    afterRestart.outputs.find((output) => output.portId === "control"),
  ).requestId;
  assert.notEqual(
    firstTransactionId,
    parentRequestId,
    "restart-local provider counters are not durable transaction identities",
  );
  assert.equal(firstTransactionId, restartTransactionId);
  assert.equal(decodeStatusOutput(first).requestId, firstTransactionId);
  assert.equal(
    decodeStatusOutput(afterRestart).requestId,
    restartTransactionId,
  );
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

test("OD rejects iteration-bound low-quality records without persistence or queue loss", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const badFixture = makeIterationBoundMemeFixture();
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
  assert.equal(isolatedBad.errorCode, "od-quality-gate");
  assert.equal(isolatedBad.yielded, false);
  assert.equal(isolatedBad.backlogRemaining, 0);
  assert.deepEqual(isolatedBad.outputs.map((output) => output.portId), ["status"]);
  const rejectedStatus = decodeStatusOutput(isolatedBad);
  assert.equal(rejectedStatus.requestId, 90001n);
  assert.equal(rejectedStatus.status, flatSqlNodeStatus.INTERNAL_ERROR);
  assert.equal(rejectedStatus.affectedRecords, 0n);
  assert.equal(rejectedStatus.resultBytes, 0n);
  assert.equal(rejectedStatus.errorCode, "od-quality-gate");
  assert.match(rejectedStatus.message, /STARLINK-BAD/);
  assert.match(rejectedStatus.message, /RMS|converged/);

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
  assert.equal(coalescedBad.yielded, true);
  assert.equal(coalescedBad.backlogRemaining, 1);
  assert.deepEqual(coalescedBad.outputs.map((output) => output.portId), ["status"]);
  assert.equal(coalescedBad.errorCode, "od-quality-gate");
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

test("OD emits one complete state-series OCM and no OMM for terminal reentry", async (t) => {
  const fixture = makeTerminalReentryMemeFixture();
  const sourceStates = new TextDecoder()
    .decode(fixture)
    .split(/\r?\n/)
    .filter((line) => /^\d{13}\.\d{3}\s/.test(line))
    .map((line) => {
      const [epoch, ...components] = line.trim().split(/\s+/);
      return { epoch, components: components.map(Number) };
    });
  assert.equal(sourceStates.length, 841);
  assert.ok(
    Math.hypot(...sourceStates.at(-1).components.slice(0, 3)) -
        6_378.135 <= 120,
  );

  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "fit",
    inputs: completeCanonicalObjectFrames({
      data: fixture,
      requestId: 90_101n,
      schemaName: "MEME:46144:STARLINK-TERMINAL",
    }),
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.errorCode, null, response.errorMessage);
  assert.equal(
    response.outputs.some((output) => output.portId === "omm"),
    false,
  );
  const ocmStream = reassembleRecordStream(response.outputs, "ocm");
  assert.equal(ocmStream.recordCount, 1n);
  const [encodedOcm] = splitSizePrefixedRecords(ocmStream.stream);
  const ocm = OCM.getSizePrefixedRootAsOCM(new ByteBuffer(encodedOcm));
  assert.match(String(ocm.TRAJ_TYPE_DESCRIPTION()), /terminal.reentry/i);
  assert.match(String(ocm.TRAJ_TYPE_DESCRIPTION()), /TEME/);
  assert.equal(ocm.STATE_VECTOR_SIZE(), 6);
  assert.equal(ocm.STATE_STEP_SIZE(), 60);
  assert.equal(ocm.stateDataLength(), sourceStates.length * 6);
  assert.ok([...ocm.stateDataArray()].every(Number.isFinite));
  assert.equal(ocm.covarianceDataLength(), 0);
  assert.equal(ocm.ORBIT_DETERMINATION(), null);
  assert.equal(
    ocm.METADATA()?.START_TIME(),
    memeStateTimestampToIso(sourceStates[0].epoch),
  );
  assert.equal(
    ocm.METADATA()?.STOP_TIME(),
    memeStateTimestampToIso(sourceStates.at(-1).epoch),
  );
  assert.ok(
    Math.abs(ocm.METADATA()?.TIME_SPAN() - 14 / 24) < 1e-12,
  );
  assert.equal(ocm.METADATA()?.CATALOG_NAME(), "46144");
  assert.equal(ocm.METADATA()?.OBJECT_NAME(), "STARLINK-TERMINAL");
  const transformedStates = ocm.stateDataArray();
  assert.ok(
    Math.abs(
      Math.hypot(...transformedStates.slice(-6, -3)) -
        Math.hypot(...sourceStates.at(-1).components.slice(0, 3)),
    ) < 1e-6,
    "the EME2000-to-TEME rotation must preserve terminal position magnitude",
  );
  const status = decodeStatusOutput(response);
  assert.equal(status.status, flatSqlNodeStatus.COMPLETE);
  assert.equal(status.affectedRecords, 1n);
  assert.match(status.message, /terminal.reentry/i);
});

test("OD terminal OCM bytes and transaction identity match canonical and aligned input", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const fixture = makeTerminalReentryMemeFixture(31);
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const invoke = async (wireFormat) => {
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());
    const requestId = 90_104n;
    const schemaName = "MEME:46144:STARLINK-TERMINAL-PARITY";
    return harness.invoke({
      methodId: "fit",
      inputs: wireFormat === "aligned-binary"
        ? [
            inputFrame(
              makeAlignedChunk({
                data: fixture,
                checksum,
                requestId,
                schemaName,
                fileIdentifier: "MEME",
              }),
              { wireFormat },
            ),
          ]
        : completeCanonicalObjectFrames({
            data: fixture,
            requestId,
            schemaName,
          }),
    });
  };

  const canonical = await invoke("flatbuffer");
  const aligned = await invoke("aligned-binary");
  for (const [response, wireFormat] of [
    [canonical, "flatbuffer"],
    [aligned, "aligned-binary"],
  ]) {
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.errorCode, null, response.errorMessage);
    assert.equal(
      response.outputs.some(({ portId }) => portId === "omm"),
      false,
    );
    assertOutputWireFormat(response, wireFormat);
  }

  assert.deepEqual(
    reassembleRecordStream(canonical.outputs, "ocm").stream,
    readAlignedRecordStream(aligned.outputs, "ocm").stream,
  );
  assert.deepEqual(
    odFlatSqlRequestIds(canonical),
    odFlatSqlRequestIds(aligned),
  );
  assert.equal(
    decodeStatusOutput(canonical).requestId,
    decodeStatusOutput(aligned).requestId,
  );
});

test(
  "OD preserves every state in hash-pinned real terminal reentry OCMs",
  {
    skip: !process.env.SDN_OD_TERMINAL_REENTRY_REGRESSION_DIR,
    timeout: Number(
      process.env.SDN_OD_TERMINAL_REENTRY_REGRESSION_TIMEOUT_MS ?? 120_000,
    ),
  },
  async (t) => {
    const regressionRoot = path.resolve(
      process.env.SDN_OD_TERMINAL_REENTRY_REGRESSION_DIR,
    );
    const cases = [
      {
        norad: 46144,
        objectName: "STARLINK-1606",
        filename:
          "MEME_46144_STARLINK-1606_1762130_Operational_1466618520_UNCLASSIFIED.txt",
        sourceSha256:
          "e23e60929c6d3254422a96b8d84b425ce3f5da6914517a49fc40a017529278f5",
        ocmSha256:
          "4f6bc00068f092269cb79dfbe64fb334d0211e3261d911565999aa0167fe02bf",
      },
      {
        norad: 47587,
        objectName: "STARLINK-1991",
        filename:
          "MEME_47587_STARLINK-1991_1761918_Operational_1466657400_UNCLASSIFIED.txt",
        sourceSha256:
          "246119027c6ec9fabe520eb13ac987337e5f2b20a808ba1cf549af4cb7a35f63",
        ocmSha256:
          "1b6092e64b972c6fe87a4ab50f9052dc6dfffcfa99663999fb25fc648990a4e1",
      },
    ];
    const manifest = readJson("plugin-manifest.json");
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());

    for (const [caseIndex, terminalCase] of cases.entries()) {
      const fixture = new Uint8Array(
        fs.readFileSync(path.join(regressionRoot, terminalCase.filename)),
      );
      assert.equal(
        crypto.createHash("sha256").update(fixture).digest("hex"),
        terminalCase.sourceSha256,
      );
      const sourceStates = new TextDecoder()
        .decode(fixture)
        .split(/\r?\n/)
        .filter((line) => /^\d{13}\.\d{3}\s/.test(line))
        .map((line) => {
          const [epoch, ...encodedComponents] = line.trim().split(/\s+/);
          const components = encodedComponents.map(Number);
          assert.equal(components.length, 6);
          assert.ok(components.every(Number.isFinite));
          return { epoch, components };
        });
      assert.ok(sourceStates.length >= 3);
      assert.ok(
        Math.hypot(...sourceStates.at(-1).components.slice(0, 3)) <=
          6_378.135 + 120,
      );

      const response = await harness.invoke({
        methodId: "fit",
        inputs: completeCanonicalObjectFrames({
          data: fixture,
          requestId: 91_000n + BigInt(caseIndex),
          schemaName:
            `MEME:${terminalCase.norad}:${terminalCase.objectName}`,
        }),
      });
      assert.equal(response.statusCode, 0, response.errorMessage);
      assert.equal(response.errorCode, null, response.errorMessage);
      assert.equal(
        response.outputs.some(({ portId }) => portId === "omm"),
        false,
      );
      const stream = reassembleRecordStream(response.outputs, "ocm");
      assert.equal(stream.recordCount, 1n);
      const [encodedOcm] = splitSizePrefixedRecords(stream.stream);
      assert.equal(
        crypto.createHash("sha256").update(encodedOcm).digest("hex"),
        terminalCase.ocmSha256,
      );

      const ocm = OCM.getSizePrefixedRootAsOCM(
        new ByteBuffer(encodedOcm),
      );
      assert.equal(
        ocm.TRAJ_TYPE_DESCRIPTION(),
        "TERMINAL_REENTRY_SOURCE_TRAJECTORY_TEME",
      );
      assert.equal(ocm.STATE_VECTOR_SIZE(), 6);
      assert.equal(ocm.STATE_STEP_SIZE(), 60);
      assert.equal(ocm.stateDataLength(), sourceStates.length * 6);
      assert.equal(ocm.covarianceDataLength(), 0);
      assert.equal(ocm.ORBIT_DETERMINATION(), null);
      assert.equal(ocm.METADATA()?.CATALOG_NAME(), String(terminalCase.norad));
      assert.equal(ocm.METADATA()?.OBJECT_NAME(), terminalCase.objectName);
      assert.equal(
        ocm.METADATA()?.START_TIME(),
        memeStateTimestampToIso(sourceStates[0].epoch),
      );
      assert.equal(
        ocm.METADATA()?.STOP_TIME(),
        memeStateTimestampToIso(sourceStates.at(-1).epoch),
      );

      const transformedStates = ocm.stateDataArray();
      assert.ok(transformedStates.every(Number.isFinite));
      for (const [stateIndex, source] of sourceStates.entries()) {
        const offset = stateIndex * 6;
        const transformed = transformedStates.slice(offset, offset + 6);
        const sourcePositionNorm = Math.hypot(...source.components.slice(0, 3));
        const transformedPositionNorm = Math.hypot(
          ...transformed.slice(0, 3),
        );
        const sourceVelocityNorm = Math.hypot(...source.components.slice(3));
        const transformedVelocityNorm = Math.hypot(...transformed.slice(3));
        const sourceRadialVelocity =
          source.components[0] * source.components[3] +
          source.components[1] * source.components[4] +
          source.components[2] * source.components[5];
        const transformedRadialVelocity =
          transformed[0] * transformed[3] +
          transformed[1] * transformed[4] +
          transformed[2] * transformed[5];
        assert.ok(
          Math.abs(transformedPositionNorm - sourcePositionNorm) < 1e-8,
          `${terminalCase.norad} state ${stateIndex} position rotation changed magnitude`,
        );
        assert.ok(
          Math.abs(transformedVelocityNorm - sourceVelocityNorm) < 1e-11,
          `${terminalCase.norad} state ${stateIndex} velocity rotation changed magnitude`,
        );
        assert.ok(
          Math.abs(
            transformedRadialVelocity - sourceRadialVelocity,
          ) < 1e-8,
          `${terminalCase.norad} state ${stateIndex} position/velocity rotation diverged`,
        );
      }
      const status = decodeStatusOutput(response);
      assert.equal(status.status, flatSqlNodeStatus.COMPLETE);
      assert.equal(status.affectedRecords, 1n);
      assert.match(status.message, /terminal.reentry/i);
    }
  },
);

test("OD rejects a terminal trajectory whose millisecond drift accumulates", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "fit",
    inputs: completeCanonicalObjectFrames({
      data: makeCumulativelyDriftingTerminalReentryMemeFixture(),
      requestId: 90_102n,
      schemaName: "MEME:46144:STARLINK-TERMINAL-DRIFT",
    }),
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.errorCode, "od-fit");
  assert.deepEqual(response.outputs.map(({ portId }) => portId), ["status"]);
  const status = decodeStatusOutput(response);
  assert.equal(status.errorCode, "terminal-reentry-invalid");
  assert.match(status.message, /uniform epoch step/i);
});

test("OD rejects sub-millisecond terminal epoch errors that accumulate", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "fit",
    inputs: completeCanonicalObjectFrames({
      data: makeCumulativelyDriftingTerminalReentryIssFixture(),
      requestId: 90_103n,
      schemaName: "OEM:25544:ISS-TERMINAL-DRIFT",
      fileIdentifier: "OEM",
      portId: "iss",
    }),
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.errorCode, "od-fit");
  assert.deepEqual(response.outputs.map(({ portId }) => portId), ["status"]);
  const status = decodeStatusOutput(response);
  assert.equal(status.errorCode, "terminal-reentry-invalid");
  assert.match(status.message, /uniform epoch step/i);
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

test("OD fits one bounded provider batch and drains fitted results through zero-input continuations", async (t) => {
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
  const objects = Array.from({ length: 16 }, (_, index) => ({
    requestId: 78_001n + BigInt(index),
    norad: 67_850 + index,
    objectName: `STARLINK-QUEUE-${String(index + 1).padStart(2, "0")}`,
  }));

  const batchStartedAt = process.hrtime.bigint();
  const first = await harness.invoke({
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
  });
  const responses = [first];
  while (
    responses.at(-1).yielded ||
    responses.at(-1).backlogRemaining > 0
  ) {
    responses.push(await harness.invoke({ methodId: "fit", inputs: [] }));
  }
  const batchElapsedMs =
    Number(process.hrtime.bigint() - batchStartedAt) / 1_000_000;

  assert.deepEqual(
    responses.map(({ yielded, backlogRemaining }) => ({
      yielded,
      backlogRemaining,
    })),
    objects.map((_, index) => ({
      yielded: index + 1 < objects.length,
      backlogRemaining: objects.length - index - 1,
    })),
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
    assert.ok(omm.recordCount >= 1n);
    assert.equal(ocm.recordCount, omm.recordCount);
    const fitStatus = decodeStatusOutput(response);
    assert.equal(fitStatus.requestId, objects[index].requestId);
    assert.match(fitStatus.message, /batch_objects=16/);
    assert.match(fitStatus.message, /workers=16/);
    assert.match(
      fitStatus.message,
      /distinct_threads=(?:[2-9]|1[0-6])/,
      "a saturated batch must execute fits on more than one worker thread",
    );

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
  t.diagnostic(
    `batchObjects=${objects.length} workers=16 fitAndFullOutputDrainMs=${batchElapsedMs.toFixed(3)} ` +
    `objectsPerSecond=${(objects.length * 1_000 / batchElapsedMs).toFixed(2)}`,
  );
});

test("OD preserves source transaction IDs across transport, chunking, wire format, and restart", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const createOdHarness = async () => {
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());
    return harness;
  };
  const fixture = new Uint8Array(
    fs.readFileSync(
      path.join(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme/MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
      ),
    ),
  );
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const fit = (harness, {
    requestId,
    norad,
    objectName,
    wireFormat = "flatbuffer",
    boundaries = [],
  }) => {
    const schemaName = `MEME:${norad}:${objectName}`;
    if (wireFormat === "aligned-binary") {
      return harness.invoke({
        methodId: "fit",
        inputs: [inputFrame(makeAlignedChunk({
          data: fixture,
          checksum,
          requestId,
          schemaName,
          fileIdentifier: "MEME",
        }), { wireFormat })],
      });
    }
    const offsets = [0, ...boundaries, fixture.byteLength];
    return harness.invoke({
      methodId: "fit",
      inputs: offsets.slice(0, -1).map((start, sequence) => inputFrame(
        makeChunk({
          data: fixture.slice(start, offsets[sequence + 1]),
          sequence,
          final: sequence + 2 === offsets.length,
          totalBytes: fixture.byteLength,
          checksum,
          requestId,
          schemaName,
        }),
      )),
    });
  };

  const instanceA = await createOdHarness();
  const warmup = await fit(instanceA, {
    requestId: 79_100n,
    norad: 79_100,
    objectName: "STARLINK-ID-WARMUP",
  });
  assert.equal(warmup.statusCode, 0, warmup.errorMessage);
  const targetAfterWarmup = await fit(instanceA, {
    requestId: 79_101n,
    norad: 79_101,
    objectName: "STARLINK-ID-TARGET",
    boundaries: [
      Math.floor(fixture.byteLength / 3),
      Math.floor((fixture.byteLength * 2) / 3),
    ],
  });
  assert.equal(targetAfterWarmup.statusCode, 0, targetAfterWarmup.errorMessage);

  const instanceB = await createOdHarness();
  const targetAfterRestart = await fit(instanceB, {
    requestId: 79_101n,
    norad: 79_101,
    objectName: "STARLINK-ID-TARGET",
    wireFormat: "aligned-binary",
  });
  assert.equal(targetAfterRestart.statusCode, 0, targetAfterRestart.errorMessage);

  assertOutputWireFormat(targetAfterWarmup, "flatbuffer");
  assertOutputWireFormat(targetAfterRestart, "aligned-binary");
  const afterWarmupIds = odFlatSqlRequestIds(targetAfterWarmup);
  const afterRestartIds = odFlatSqlRequestIds(targetAfterRestart);
  assert.equal(
    afterWarmupIds.control,
    afterRestartIds.control,
    "CONFIGURE_INDEX must preserve the stable source transaction",
  );
  assert.equal(afterWarmupIds.control, 79_101n);
  assert.deepEqual(
    afterWarmupIds.streams,
    afterRestartIds.streams,
    "record-stream IDs must survive a fresh OD instance",
  );
  for (const portId of recordOutputPorts) {
    assert.deepEqual(
      reassembleRecordStream(targetAfterWarmup.outputs, portId).stream,
      readAlignedRecordStream(targetAfterRestart.outputs, portId).stream,
      `${portId} fitted bytes changed with input wire format, chunking, or process history`,
    );
  }
  assert.deepEqual(
    afterWarmupIds,
    expectedOdFlatSqlRequestIds(targetAfterWarmup, 79_101n),
    "request IDs must bind the source transaction and ordered OMM/OCM identities, counts, lengths, and full-stream digests",
  );
  assert.equal(
    new Set(Object.values(afterWarmupIds.streams)).size,
    recordOutputPorts.length,
    "OMM and OCM need distinct request IDs because FlatSQL groups chunks by request ID alone",
  );
  assert.ok(afterWarmupIds.control > 0n);
  assert.ok(Object.values(afterWarmupIds.streams).every((requestId) => requestId > 0n));
  assert.doesNotMatch(
    fs.readFileSync(path.join(nodeRoot, "src/node.cpp"), "utf8"),
    /g_output_request_id/,
    "process-local output counters cannot provide restart idempotency",
  );
});

test("fresh OD and FlatSQL instances replay a lost response exactly once", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const createOdHarness = async () => {
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());
    return harness;
  };
  const fixture = new Uint8Array(
    fs.readFileSync(
      path.join(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme/MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
      ),
    ),
  );
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const fit = (harness, { requestId, norad, objectName }) =>
    harness.invoke({
      methodId: "fit",
      inputs: [
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
      ],
    });

  const odA = await createOdHarness();
  const warmup = await fit(odA, {
    requestId: 79_200n,
    norad: 79_200,
    objectName: "STARLINK-REPLAY-WARMUP",
  });
  assert.equal(warmup.statusCode, 0, warmup.errorMessage);
  const targetA = await fit(odA, {
    requestId: 79_201n,
    norad: 79_201,
    objectName: "STARLINK-REPLAY-TARGET",
  });
  assert.equal(targetA.statusCode, 0, targetA.errorMessage);
  const expectedCounts = Object.fromEntries(
    recordOutputPorts.map((portId) => [
      portId,
      reassembleRecordStream(targetA.outputs, portId).recordCount,
    ]),
  );
  const transactionId = decodeControl(
    targetA.outputs.find((output) => output.portId === "control"),
  ).requestId;

  const opaqueValues = new Map();
  const flatSqlA = await createFlatSqlPersistenceHarness(t, {
    opaqueValues,
    registerCleanup: false,
  });
  const committed = await flatSqlA.invoke({
    methodId: "append_records",
    inputs: odOutputsForFlatSql(targetA),
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.equal(
    decodeStatusOutput(committed).status,
    flatSqlNodeStatus.COMPLETE,
  );
  const durableAfterLostResponse = opaqueStateDigest(opaqueValues);
  flatSqlA.destroy();

  const odB = await createOdHarness();
  const targetB = await fit(odB, {
    requestId: 79_201n,
    norad: 79_201,
    objectName: "STARLINK-REPLAY-TARGET",
  });
  assert.equal(targetB.statusCode, 0, targetB.errorMessage);
  assert.deepEqual(
    expectedOdFlatSqlRequestIds(targetA, 79_201n),
    expectedOdFlatSqlRequestIds(targetB, 79_201n),
  );

  const flatSqlB = await createFlatSqlPersistenceHarness(t, {
    opaqueValues,
    registerCleanup: false,
  });
  t.after(() => flatSqlB.destroy());
  const replay = await flatSqlB.invoke({
    methodId: "append_records",
    inputs: odOutputsForFlatSql(targetB),
  });
  assert.equal(replay.statusCode, 0, replay.errorMessage);
  const replayStatus = decodeStatusOutput(replay);
  assert.equal(replayStatus.status, flatSqlNodeStatus.COMPLETE, replayStatus.message);
  assert.match(replayStatus.message, /already committed/i);
  assert.equal(
    opaqueStateDigest(opaqueValues),
    durableAfterLostResponse,
    "a replay after response loss must not append another durable WAL entry",
  );
  for (const [index, portId] of recordOutputPorts.entries()) {
    assert.equal(
      await flatSqlTableRecordCount(flatSqlB, portId.toUpperCase(), 79_300n + BigInt(index)),
      expectedCounts[portId],
      `${portId} was duplicated by replay`,
    );
  }

  const conflictingOd = await fit(odB, {
    requestId: 79_202n,
    norad: 79_202,
    objectName: "STARLINK-REPLAY-CONFLICT",
  });
  assert.equal(conflictingOd.statusCode, 0, conflictingOd.errorMessage);
  const conflictingInputs = odOutputsForFlatSql(conflictingOd).map((output) =>
    output.portId === "control"
      ? rewriteControlRequestId(output, transactionId)
      : output);
  const conflict = await flatSqlB.invoke({
    methodId: "append_records",
    inputs: conflictingInputs,
  });
  assert.equal(conflict.statusCode, 0, conflict.errorMessage);
  const conflictStatus = decodeStatusOutput(conflict);
  assert.equal(conflictStatus.status, flatSqlNodeStatus.INVALID_ARGUMENT);
  assert.equal(conflictStatus.errorCode, "receipt-conflict");
  assert.equal(
    opaqueStateDigest(opaqueValues),
    durableAfterLostResponse,
    "same transaction ID with a new digest must leave durable state unchanged",
  );
  for (const [index, portId] of recordOutputPorts.entries()) {
    assert.equal(
      await flatSqlTableRecordCount(flatSqlB, portId.toUpperCase(), 79_310n + BigInt(index)),
      expectedCounts[portId],
      `${portId} live state changed after a receipt conflict`,
    );
  }
  flatSqlB.destroy();

  const flatSqlC = await createFlatSqlPersistenceHarness(t, {
    opaqueValues,
    registerCleanup: false,
  });
  t.after(() => flatSqlC.destroy());
  for (const [index, portId] of recordOutputPorts.entries()) {
    assert.equal(
      await flatSqlTableRecordCount(flatSqlC, portId.toUpperCase(), 79_320n + BigInt(index)),
      expectedCounts[portId],
      `${portId} durable state changed after a receipt conflict and reload`,
    );
  }
});

test("OD selects complete eight-hour windows across a captured three-day arc", async (t) => {
  const source = fs.readFileSync(path.join(nodeRoot, "src/node.cpp"), "utf8");
  const maxIterations = Number(
    source.match(/kMaxFitIterations\s*=\s*(\d+)\s*;/)?.[1] ?? 0,
  );
  assert.equal(maxIterations, 60);
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const fixture = makeProductionShapedMemeFixture();
  const response = await harness.invoke({
    methodId: "fit",
    inputs: completeCanonicalObjectFrames({
      data: fixture,
      requestId: 79_001n,
      schemaName: "MEME:79001:STARLINK-CAPTURED-THREE-DAY",
    }),
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.errorCode, null, response.errorMessage);
  assert.equal(response.yielded, false);
  assert.equal(response.backlogRemaining, 0);

  const omm = reassembleRecordStream(response.outputs, "omm");
  const ocm = reassembleRecordStream(response.outputs, "ocm");
  const combinedOutputBytes =
    omm.stream.byteLength + ocm.stream.byteLength;
  assert.equal(
    omm.recordCount,
    12n,
    "a 72-hour arc must produce the 6-hour grid plus its terminal 8-hour window",
  );
  assert.equal(ocm.recordCount, omm.recordCount);

  const fittedEpochs = splitSizePrefixedRecords(omm.stream).map((record) =>
    OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record)).EPOCH(),
  );
  const expectedEpochs = [
    "2026-07-14T09:53:42.000000Z",
    "2026-07-14T15:53:42.000000Z",
    "2026-07-14T21:53:42.000000Z",
    "2026-07-15T03:53:42.000000Z",
    "2026-07-15T09:53:42.000000Z",
    "2026-07-15T15:53:42.000000Z",
    "2026-07-15T21:53:42.000000Z",
    "2026-07-16T03:53:42.000000Z",
    "2026-07-16T09:53:42.000000Z",
    "2026-07-16T15:53:42.000000Z",
    "2026-07-16T21:53:42.000000Z",
    "2026-07-17T01:53:42.000000Z",
  ];
  for (const [index, epoch] of fittedEpochs.entries()) {
    assert.ok(
      Math.abs(Date.parse(epoch) - Date.parse(expectedEpochs[index])) <= 1,
      "Julian-date rendering may differ by one millisecond, but not the selected source observation",
    );
  }

  const decodeText = (value) =>
    typeof value === "string"
      ? value
      : new TextDecoder().decode(value ?? new Uint8Array());
  const records = splitSizePrefixedRecords(ocm.stream).map((record) =>
    OCM.getSizePrefixedRootAsOCM(new ByteBuffer(record)),
  );
  for (const record of records) {
    assert.equal(
      record.ORBIT_DETERMINATION()?.OD_OBSERVATIONS_USED(),
      481,
      "each inclusive 8-hour window must use all 481 one-minute source states",
    );
  }
  const reportedRmsKm = records.map((record) => {
    const residuals = decodeText(
      record.ORBIT_DETERMINATION()?.OD_RESIDUALS(),
    );
    const rms = Number(residuals.match(/WRMS=([0-9.eE+-]+)\s+km/)?.[1]);
    assert.ok(Number.isFinite(rms), `invalid OCM residual summary ${residuals}`);
    return rms;
  });
  const reportedIterations = records.map((record) => {
    const convergenceCriteria = decodeText(
      record.ORBIT_DETERMINATION()?.OD_CONVERGENCE_CRITERIA(),
    );
    const iterations = Number(
      convergenceCriteria.match(/(?:^|;\s*)iterations=(\d+)(?:;|$)/)?.[1],
    );
    assert.ok(
      Number.isSafeInteger(iterations),
      `invalid OCM convergence criteria ${convergenceCriteria}`,
    );
    assert.ok(
      iterations >= 0 && iterations <= maxIterations,
      `OCM iteration count ${iterations} exceeded ${maxIterations}`,
    );
    return iterations;
  });
  const reportedConvergence = records.map((record) => {
    const criteria = decodeText(
      record.ORBIT_DETERMINATION()?.OD_CONVERGENCE_CRITERIA(),
    );
    const value = criteria.match(/(?:^|;\s*)converged=([01])(?:;|$)/)?.[1];
    assert.ok(value === "0" || value === "1", `invalid OCM criteria ${criteria}`);
    return value === "1";
  });
  t.diagnostic(
    `maxIterations=${maxIterations} observedMaxIterations=${Math.max(...reportedIterations)} inputBytes=${fixture.byteLength} outputBytes=${combinedOutputBytes} ommBytes=${omm.stream.byteLength} ocmBytes=${ocm.stream.byteLength} ommRecords=${omm.recordCount} ocmRecords=${ocm.recordCount} maxRmsKm=${Math.max(...reportedRmsKm)}`,
  );
  t.diagnostic(
    `epochMetrics=${fittedEpochs.map((epoch, index) =>
      `${epoch}:${reportedRmsKm[index]}km/${reportedIterations[index]}it/` +
      `${reportedConvergence[index] ? "converged" : "best-effort"}`
    ).join(",")}`,
  );
});

test("OD selects first-at-or-after grid anchors and the terminal complete window on irregular arcs", async (t) => {
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const fixture = makeIrregularMemeFixture();
  const checksum = crypto.createHash("sha256").update(fixture).digest();
  const response = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(
        makeChunk({
          data: fixture,
          sequence: 0,
          final: true,
          totalBytes: fixture.byteLength,
          checksum,
          requestId: 79_002n,
          schemaName: "MEME:79002:STARLINK-IRREGULAR-ANCHORS",
        }),
      ),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.errorCode, null, response.errorMessage);

  const omm = reassembleRecordStream(response.outputs, "omm");
  const ocm = reassembleRecordStream(response.outputs, "ocm");
  assert.equal(omm.recordCount, 4n);
  assert.equal(ocm.recordCount, omm.recordCount);
  const fittedEpochs = splitSizePrefixedRecords(omm.stream).map((record) =>
    OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record)).EPOCH(),
  );
  const expectedEpochs = [
    "2026-07-14T09:53:42.000000Z",
    "2026-07-14T16:03:42.000000Z",
    "2026-07-14T22:03:42.000000Z",
    "2026-07-15T01:43:42.000000Z",
  ];
  for (const [index, epoch] of fittedEpochs.entries()) {
    assert.ok(
      Math.abs(Date.parse(epoch) - Date.parse(expectedEpochs[index])) <= 1,
    );
  }
  const expectedObservationCounts = [17, 17, 17, 16];
  const ocmRecords = splitSizePrefixedRecords(ocm.stream).map((record) =>
    OCM.getSizePrefixedRootAsOCM(new ByteBuffer(record)),
  );
  assert.deepEqual(
    ocmRecords.map((record) =>
      record.ORBIT_DETERMINATION()?.OD_OBSERVATIONS_USED()
    ),
    expectedObservationCounts,
    "irregular inclusive windows must retain every source observation",
  );
});

test(
  "OD fits every state in every complete window of a captured Starlink MEME arc",
  {
    timeout: 180_000,
  },
  async (t) => {
    const fixturePath = String(process.env.SDN_OD_REAL_MEME_FILE ?? "").trim()
      ? path.resolve(process.env.SDN_OD_REAL_MEME_FILE)
      : path.join(
          modulesRoot,
          "analysis/od/tests/data/supgp-reference/starlink-live-20260714/meme/" +
            "MEME_67850_STARLINK-36840_1950953_Operational_1468317240_UNCLASSIFIED.txt",
        );
    const fixture = new Uint8Array(fs.readFileSync(fixturePath));
    assert.ok(
      fixture.byteLength > fsbAlignedDataCapacity,
      "the captured fixture must exercise complete-file multi-chunk reassembly",
    );
    const manifest = readJson("plugin-manifest.json");
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());

    const startedAt = process.hrtime.bigint();
    const response = await harness.invoke({
      methodId: "fit",
      inputs: completeCanonicalObjectFrames({
        data: fixture,
        requestId: 79_003n,
        schemaName: "MEME:62559:STARLINK-11517",
      }),
    });
    const elapsedSeconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.errorCode, null, response.errorMessage);

    const omm = reassembleRecordStream(response.outputs, "omm");
    const ocm = reassembleRecordStream(response.outputs, "ocm");
    assert.equal(omm.recordCount, 12n);
    assert.equal(ocm.recordCount, omm.recordCount);
    const records = splitSizePrefixedRecords(ocm.stream).map((record) =>
      OCM.getSizePrefixedRootAsOCM(new ByteBuffer(record)),
    );
    const decodeText = (value) =>
      typeof value === "string"
        ? value
        : new TextDecoder().decode(value ?? new Uint8Array());
    const observations = records.map((record) =>
      record.ORBIT_DETERMINATION()?.OD_OBSERVATIONS_USED()
    );
    assert.deepEqual(
      observations,
      Array(12).fill(481),
      "each captured eight-hour window must fit all 481 one-minute states",
    );
    const rmsKm = records.map((record) => {
      const residuals = decodeText(
        record.ORBIT_DETERMINATION()?.OD_RESIDUALS(),
      );
      const rms = Number(residuals.match(/WRMS=([0-9.eE+-]+)\s+km/)?.[1]);
      assert.ok(Number.isFinite(rms), `invalid OCM residual summary ${residuals}`);
      return rms;
    });
    const iterations = records.map((record) => {
      const criteria = decodeText(
        record.ORBIT_DETERMINATION()?.OD_CONVERGENCE_CRITERIA(),
      );
      const count = Number(
        criteria.match(/(?:^|;\s*)iterations=(\d+)(?:;|$)/)?.[1],
      );
      assert.ok(Number.isSafeInteger(count), `invalid OCM criteria ${criteria}`);
      assert.ok(count >= 0 && count <= 60, `iteration cap exceeded: ${criteria}`);
      return count;
    });
    const converged = records.map((record) => {
      const criteria = decodeText(
        record.ORBIT_DETERMINATION()?.OD_CONVERGENCE_CRITERIA(),
      );
      return criteria.match(/(?:^|;\s*)converged=([01])(?:;|$)/)?.[1] === "1";
    });
    assert.deepEqual(
      converged,
      Array(12).fill(true),
      "every emitted captured-arc epoch must satisfy the declared convergence criterion",
    );
    const maxRmsKm = Math.max(...rmsKm);
    assert.ok(
      maxRmsKm < 12,
      `captured complete-window RMS ${maxRmsKm} km exceeded 12 km`,
    );
    t.diagnostic(
      `realMeme=${path.basename(fixturePath)} inputBytes=${fixture.byteLength} ` +
      `epochs=${omm.recordCount} observationsPerEpoch=481 ` +
      `wallSeconds=${elapsedSeconds.toFixed(6)} ` +
      `maxRmsKm=${maxRmsKm} maxIterations=${Math.max(...iterations)}`,
    );
  },
);

test("signed OD transforms raw Starlink EME2000 states through the OEM frame path", async (t) => {
  const fullFixture = new Uint8Array(
    fs.readFileSync(
      path.join(
        modulesRoot,
        "analysis/od/tests/data/supgp-reference/starlink-live-20260714/meme/" +
          "MEME_67850_STARLINK-36840_1950953_Operational_1468317240_UNCLASSIFIED.txt",
      ),
    ),
  );
  const memeFixture = capturedCelestrakComparisonWindow(fullFixture);
  const oemFixture = memeToEme2000Oem(memeFixture);
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const invoke = async ({ data, requestId, schemaName, fileIdentifier, portId }) => {
    const response = await harness.invoke({
      methodId: "fit",
      inputs: completeCanonicalObjectFrames({
        data,
        requestId,
        schemaName,
        fileIdentifier,
        portId,
      }),
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.errorCode, null);
    const records = splitSizePrefixedRecords(
      reassembleRecordStream(response.outputs, "omm").stream,
    );
    assert.equal(records.length, 1);
    return OMM.getSizePrefixedRootAsOMM(new ByteBuffer(records[0]));
  };
  const fromMeme = await invoke({
    data: memeFixture,
    requestId: 79_101n,
    schemaName: "MEME:67850:STARLINK-36840",
    fileIdentifier: "MEME",
    portId: "starlink",
  });
  const fromEme2000Oem = await invoke({
    data: oemFixture,
    requestId: 79_102n,
    schemaName: "OEM:67850:STARLINK-36840",
    fileIdentifier: "OEM",
    portId: "iss",
  });
  assert.equal(fromMeme.EPOCH(), fromEme2000Oem.EPOCH());
  for (const field of [
    "MEAN_MOTION",
    "ECCENTRICITY",
    "INCLINATION",
    "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER",
    "MEAN_ANOMALY",
    "BSTAR",
  ]) {
    assert.ok(
      Math.abs(fromMeme[field]() - fromEme2000Oem[field]()) <= 1e-10,
      `${field} differs: MEME=${fromMeme[field]()} ` +
        `EME2000-OEM=${fromEme2000Oem[field]()}`,
    );
  }
});

test("OD beats the captured CelesTrak row on its exact eight-hour source window", async (t) => {
  const evidencePath = path.join(
    nodeRoot,
    "test/reference/celestrak-same-ephemeris-20260714.json",
  );
  const evidenceBytes = fs.readFileSync(evidencePath);
  assert.equal(
    crypto.createHash("sha256").update(evidenceBytes).digest("hex"),
    "c5b078304945aa9ab519261bb4434c5a6e2c5eb842a73a2d79577e30b2572e32",
  );
  const evidence = JSON.parse(evidenceBytes);
  const scorerPath = path.join(
    nodeRoot,
    "test/reference/exact-celestrak-parity.cpp",
  );
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(scorerPath)).digest("hex"),
    evidence.generator.sha256,
  );
  assert.equal(
    crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(nodeRoot, "vendor/od-fit-core.o")))
      .digest("hex"),
    evidence.generator.frozenWasmObjectSha256,
  );
  assert.equal(
    crypto.createHash("sha256")
      .update(
        fs.readFileSync(path.join(nodeRoot, "vendor/od-fit-core-source.patch")),
      )
      .digest("hex"),
    evidence.generator.sourcePatchSha256,
  );
  const captureRoot = path.join(
    modulesRoot,
    "analysis/od/tests/data/supgp-reference/starlink-live-20260714",
  );
  const fixturePath = path.join(
    captureRoot,
    "meme/MEME_67850_STARLINK-36840_1950953_Operational_1468317240_UNCLASSIFIED.txt",
  );
  const celestrakPath = path.join(captureRoot, "celestrak_supgp_live.csv");
  const fullFixture = new Uint8Array(fs.readFileSync(fixturePath));
  const celestrakCapture = fs.readFileSync(celestrakPath);
  assert.equal(
    crypto.createHash("sha256").update(fullFixture).digest("hex"),
    evidence.source.sha256,
  );
  assert.equal(
    crypto.createHash("sha256").update(celestrakCapture).digest("hex"),
    evidence.celestrak.sha256,
  );
  const referenceRow = celestrakCapture.toString("utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith("STARLINK-36840,"));
  assert.equal(referenceRow, evidence.celestrak.row);

  const fixture = capturedCelestrakComparisonWindow(fullFixture);
  const manifest = readJson("plugin-manifest.json");
  const harness = await createBrowserModuleHarness({
    wasmSource: readOdTestArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "fit",
    inputs: completeCanonicalObjectFrames({
      data: fixture,
      requestId: 79_004n,
      schemaName: "MEME:67850:STARLINK-36840",
    }),
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.errorCode, null);
  const omm = reassembleRecordStream(response.outputs, "omm");
  const ocm = reassembleRecordStream(response.outputs, "ocm");
  assert.equal(omm.recordCount, 1n);
  assert.equal(ocm.recordCount, 1n);
  const fitted = OMM.getSizePrefixedRootAsOMM(
    new ByteBuffer(splitSizePrefixedRecords(omm.stream)[0]),
  );
  assert.ok(
    Math.abs(
      Date.parse(fitted.EPOCH()) -
        Date.parse("2026-07-14T11:10:42.000Z"),
    ) <= 1,
    `unexpected exact comparison epoch ${fitted.EPOCH()}`,
  );
  const quality = OCM.getSizePrefixedRootAsOCM(
    new ByteBuffer(splitSizePrefixedRecords(ocm.stream)[0]),
  );
  assert.equal(
    quality.ORBIT_DETERMINATION()?.OD_OBSERVATIONS_USED(),
    481,
  );
  const encodedResiduals =
    quality.ORBIT_DETERMINATION()?.OD_RESIDUALS();
  const residuals = typeof encodedResiduals === "string"
    ? encodedResiduals
    : new TextDecoder().decode(encodedResiduals ?? new Uint8Array());
  const sdnRmsKm = Number(
    residuals.match(/WRMS=([0-9.eE+-]+)\s+km/)?.[1],
  );
  assert.ok(Number.isFinite(sdnRmsKm), residuals);
  assert.ok(
    Math.abs(sdnRmsKm - evidence.result.signedWasmSdnRmsKm) < 1e-9,
    `signed WASM score ${sdnRmsKm} changed from hash-bound ` +
      `${evidence.result.signedWasmSdnRmsKm}`,
  );

  assert.equal(evidence.window.observationCount, 481);
  assert.equal(evidence.window.durationSeconds, 28_800);
  assert.equal(evidence.result.gate, "sdn_rms_km <= celestrak_rms_km + 0.000001");
  assert.ok(
    evidence.result.nativeSdnRmsKm <=
      evidence.result.celestrakSameEphemerisRmsKm + 1e-6,
    evidence.result.nativeOutput,
  );
  const celestrakSameEphemerisRmsKm =
    evidence.result.celestrakSameEphemerisRmsKm;
  assert.ok(
    sdnRmsKm <= celestrakSameEphemerisRmsKm + 1e-6,
    `same-ephemeris gate failed: SDN ${sdnRmsKm} km > ` +
      `CelesTrak ${celestrakSameEphemerisRmsKm} km`,
  );
  t.diagnostic(
    `sameEphemerisNorad=67850 points=481 epoch=${fitted.EPOCH()} ` +
      `sdnRmsKm=${sdnRmsKm} celestrakRmsKm=${celestrakSameEphemerisRmsKm} ` +
      `marginKm=${(celestrakSameEphemerisRmsKm - sdnRmsKm).toFixed(9)} ` +
      "gate=sdn<=celestrak+0.000001",
  );
});

test(
  "OD publishes observable derivatives for a hash-pinned high-drag source",
  {
    skip: !process.env.SDN_OD_ADAPTIVE_WINDOW_REGRESSION_FILE,
    timeout: Number(
      process.env.SDN_OD_ADAPTIVE_WINDOW_REGRESSION_TIMEOUT_MS ?? 120_000,
    ),
  },
  async (t) => {
    const fixturePath = path.resolve(
      process.env.SDN_OD_ADAPTIVE_WINDOW_REGRESSION_FILE,
    );
    const fixture = new Uint8Array(fs.readFileSync(fixturePath));
    assert.equal(
      crypto.createHash("sha256").update(fixture).digest("hex"),
      "af9d94bfac38302c5cfe4a296c8079c20327fb339d043a23b91c7c839c8b1ebd",
      "adaptive-window regression must use the diagnosed complete ephemeris",
    );
    const manifest = readJson("plugin-manifest.json");
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());
    const response = await harness.invoke({
      methodId: "fit",
      inputs: completeCanonicalObjectFrames({
        data: fixture,
        requestId: 79_535n,
        schemaName: "MEME:46535:STARLINK-1663",
      }),
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.errorCode, null, response.errorMessage);

    const omm = reassembleRecordStream(response.outputs, "omm");
    const ocm = reassembleRecordStream(response.outputs, "ocm");
    assert.equal(omm.recordCount, 8n);
    assert.equal(ocm.recordCount, omm.recordCount);
    const fittedOmms = splitSizePrefixedRecords(omm.stream).map((encoded) =>
      OMM.getSizePrefixedRootAsOMM(new ByteBuffer(encoded))
    );
    const epochDays = fittedOmms.map(
      (record) => Date.parse(record.EPOCH()) / 86_400_000,
    );
    for (let index = 0; index < fittedOmms.length; index += 1) {
      let measuredMeanMotionDot;
      if (index === 0 || index + 1 === fittedOmms.length) {
        const left = index === 0 ? 0 : fittedOmms.length - 2;
        const right = left + 1;
        const elapsedDays = epochDays[right] - epochDays[left];
        assert.ok(elapsedDays > 0);
        measuredMeanMotionDot =
          (fittedOmms[right].MEAN_MOTION() -
            fittedOmms[left].MEAN_MOTION()) /
          elapsedDays;
      } else {
        const t0 = epochDays[index - 1] - epochDays[index];
        const t2 = epochDays[index + 1] - epochDays[index];
        measuredMeanMotionDot =
          fittedOmms[index - 1].MEAN_MOTION() *
            (-t2 / (t0 * (t0 - t2))) +
          fittedOmms[index].MEAN_MOTION() *
            ((-t0 - t2) / ((-t0) * (-t2))) +
          fittedOmms[index + 1].MEAN_MOTION() *
            (-t0 / ((t2 - t0) * t2));
      }
      assert.ok(
        Math.abs(
          fittedOmms[index].MEAN_MOTION_DOT() - measuredMeanMotionDot,
        ) < 1e-9,
        `epoch ${index + 1} published unobservable mean-motion derivative ` +
          `${fittedOmms[index].MEAN_MOTION_DOT()} instead of ` +
          `${measuredMeanMotionDot} rev/day^2 from adjacent fitted epochs`,
      );
    }
    for (const encoded of splitSizePrefixedRecords(ocm.stream)) {
      const record = OCM.getSizePrefixedRootAsOCM(new ByteBuffer(encoded));
      const determination = record.ORBIT_DETERMINATION();
      assert.equal(determination?.OD_OBSERVATIONS_USED(), 481);
      const encodedConvergence = determination?.OD_CONVERGENCE_CRITERIA();
      const convergence = typeof encodedConvergence === "string"
        ? encodedConvergence
        : new TextDecoder().decode(
            encodedConvergence ?? new Uint8Array(),
          );
      assert.match(convergence, /(?:^|;\s*)converged=(?:true|1)(?:;|$)/);
      const encodedResiduals = determination?.OD_RESIDUALS();
      const residuals = typeof encodedResiduals === "string"
        ? encodedResiduals
        : new TextDecoder().decode(encodedResiduals ?? new Uint8Array());
      const rmsKm = Number(
        residuals.match(/WRMS=([0-9.eE+-]+)\s+km/)?.[1],
      );
      assert.ok(Number.isFinite(rmsKm), residuals);
      assert.ok(rmsKm < 12, `fallback RMS ${rmsKm} km exceeded 12 km`);
    }
  },
);

test(
  "OD retries a hash-pinned rejected primary fit with complete four-hour windows",
  {
    skip: !process.env.SDN_OD_FOUR_HOUR_FALLBACK_REGRESSION_FILE,
    timeout: Number(
      process.env.SDN_OD_FOUR_HOUR_FALLBACK_REGRESSION_TIMEOUT_MS ?? 120_000,
    ),
  },
  async (t) => {
    const fixturePath = path.resolve(
      process.env.SDN_OD_FOUR_HOUR_FALLBACK_REGRESSION_FILE,
    );
    const fixture = new Uint8Array(fs.readFileSync(fixturePath));
    assert.equal(
      crypto.createHash("sha256").update(fixture).digest("hex"),
      "bbb6d4c5db1f0d3d8d67fdec6987d18f42e4e70f41cf42d0023b1bcd4fee72bd",
      "four-hour fallback regression must use the diagnosed complete ephemeris",
    );
    const manifest = readJson("plugin-manifest.json");
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());
    const response = await harness.invoke({
      methodId: "fit",
      inputs: completeCanonicalObjectFrames({
        data: fixture,
        requestId: 79_753n,
        schemaName: "MEME:46753:STARLINK-1922",
      }),
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.errorCode, null, response.errorMessage);

    const omm = reassembleRecordStream(response.outputs, "omm");
    const ocm = reassembleRecordStream(response.outputs, "ocm");
    assert.equal(omm.recordCount, 14n);
    assert.equal(ocm.recordCount, omm.recordCount);
    for (const encoded of splitSizePrefixedRecords(ocm.stream)) {
      const record = OCM.getSizePrefixedRootAsOCM(new ByteBuffer(encoded));
      const determination = record.ORBIT_DETERMINATION();
      assert.equal(determination?.OD_OBSERVATIONS_USED(), 241);
      const encodedConvergence = determination?.OD_CONVERGENCE_CRITERIA();
      const convergence = typeof encodedConvergence === "string"
        ? encodedConvergence
        : new TextDecoder().decode(
            encodedConvergence ?? new Uint8Array(),
          );
      assert.match(convergence, /(?:^|;\s*)converged=(?:true|1)(?:;|$)/);
      const encodedResiduals = determination?.OD_RESIDUALS();
      const residuals = typeof encodedResiduals === "string"
        ? encodedResiduals
        : new TextDecoder().decode(encodedResiduals ?? new Uint8Array());
      const rmsKm = Number(
        residuals.match(/WRMS=([0-9.eE+-]+)\s+km/)?.[1],
      );
      assert.ok(Number.isFinite(rmsKm), residuals);
      assert.ok(rmsKm < 12, `fallback RMS ${rmsKm} km exceeded 12 km`);
    }
  },
);

test(
  "OD converges every full-window epoch for the hash-pinned NORAD 44748 regression",
  {
    skip: !process.env.SDN_OD_QUALITY_GATE_REGRESSION_FILE,
    timeout: Number(
      process.env.SDN_OD_QUALITY_GATE_REGRESSION_TIMEOUT_MS ?? 120_000,
    ),
  },
  async (t) => {
    const fixturePath = path.resolve(
      process.env.SDN_OD_QUALITY_GATE_REGRESSION_FILE,
    );
    const fixture = new Uint8Array(fs.readFileSync(fixturePath));
    assert.equal(
      crypto.createHash("sha256").update(fixture).digest("hex"),
      "5399b0ad07435e66a96ce7a0e7196ff41d93b49bc2e67c7c08cc5aa698d7b6c4",
      "quality-gate regression must use the diagnosed complete ephemeris",
    );
    const manifest = readJson("plugin-manifest.json");
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());

    const responses = [
      await harness.invoke({
        methodId: "fit",
        inputs: completeCanonicalObjectFrames({
          data: fixture,
          requestId: 79_044n,
          schemaName: "MEME:44748:STARLINK-1043",
        }),
      }),
    ];
    while (
      responses.at(-1).yielded ||
      responses.at(-1).backlogRemaining > 0
    ) {
      responses.push(await harness.invoke({ methodId: "fit", inputs: [] }));
    }
    assert.equal(responses.length, 1);
    const [response] = responses;
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.errorCode, null, response.errorMessage);

    const omm = reassembleRecordStream(response.outputs, "omm");
    const ocm = reassembleRecordStream(response.outputs, "ocm");
    assert.equal(omm.recordCount, 8n);
    assert.equal(ocm.recordCount, 8n);
    const ommEpochs = splitSizePrefixedRecords(omm.stream).map((record) =>
      OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record)).EPOCH()
    );
    const ocmRecords = splitSizePrefixedRecords(ocm.stream).map((record) =>
      OCM.getSizePrefixedRootAsOCM(new ByteBuffer(record))
    );
    const ocmEpochs = [];
    for (const record of ocmRecords) {
      const determination = record.ORBIT_DETERMINATION();
      assert.equal(determination?.OD_OBSERVATIONS_USED(), 481);
      ocmEpochs.push(determination?.OD_EPOCH());
      const encodedConvergence = determination?.OD_CONVERGENCE_CRITERIA();
      const convergence = typeof encodedConvergence === "string"
        ? encodedConvergence
        : new TextDecoder().decode(
            encodedConvergence ?? new Uint8Array(),
          );
      assert.match(convergence, /(?:^|;\s*)converged=(?:true|1)(?:;|$)/);
      const encodedResiduals = determination?.OD_RESIDUALS();
      const residuals = typeof encodedResiduals === "string"
        ? encodedResiduals
        : new TextDecoder().decode(encodedResiduals ?? new Uint8Array());
      const rmsKm = Number(residuals.match(/WRMS=([0-9.eE+-]+)\s+km/)?.[1]);
      assert.ok(Number.isFinite(rmsKm), residuals);
      assert.ok(rmsKm < 12, `quality regression RMS ${rmsKm} km exceeded 12 km`);
    }
    assert.deepEqual(ocmEpochs, ommEpochs);
  },
);

test(
  "OD retains converged element sets for the hash-pinned NORAD 45668 regression",
  {
    skip: !process.env.SDN_OD_CONVERGENCE_SELECTION_REGRESSION_FILE,
    timeout: Number(
      process.env.SDN_OD_CONVERGENCE_SELECTION_REGRESSION_TIMEOUT_MS ??
        120_000,
    ),
  },
  async (t) => {
    const fixturePath = path.resolve(
      process.env.SDN_OD_CONVERGENCE_SELECTION_REGRESSION_FILE,
    );
    const fixture = new Uint8Array(fs.readFileSync(fixturePath));
    assert.equal(
      crypto.createHash("sha256").update(fixture).digest("hex"),
      "e48b367c46cfe990d3668341663e0e226c9a5f0c865808b05179d5de23cf4dc4",
      "convergence-selection regression must use the diagnosed complete ephemeris",
    );
    const manifest = readJson("plugin-manifest.json");
    const harness = await createBrowserModuleHarness({
      wasmSource: readOdTestArtifact(),
      manifest,
      surface: "direct",
    });
    t.after(() => harness.destroy());

    const response = await harness.invoke({
      methodId: "fit",
      inputs: completeCanonicalObjectFrames({
        data: fixture,
        requestId: 79_668n,
        schemaName: "MEME:45668:STARLINK-1451",
      }),
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.errorCode, null, response.errorMessage);

    const omm = reassembleRecordStream(response.outputs, "omm");
    const ocm = reassembleRecordStream(response.outputs, "ocm");
    assert.equal(omm.recordCount, 12n);
    assert.equal(ocm.recordCount, omm.recordCount);
    for (const encoded of splitSizePrefixedRecords(ocm.stream)) {
      const record = OCM.getSizePrefixedRootAsOCM(new ByteBuffer(encoded));
      const determination = record.ORBIT_DETERMINATION();
      assert.equal(determination?.OD_OBSERVATIONS_USED(), 481);
      const encodedConvergence = determination?.OD_CONVERGENCE_CRITERIA();
      const convergence = typeof encodedConvergence === "string"
        ? encodedConvergence
        : new TextDecoder().decode(
            encodedConvergence ?? new Uint8Array(),
          );
      assert.match(convergence, /(?:^|;\s*)converged=(?:true|1)(?:;|$)/);
    }
  },
);

test(
  "benchmark OD on complete real MEME files sampled across the retained catalog",
  {
    skip: process.env.SDN_OD_REAL_MEME_BENCHMARK !== "1",
    timeout: Number(
      process.env.SDN_OD_REAL_MEME_TIMEOUT_MS ?? 600_000,
    ),
  },
  async (t) => {
    const liveCatalog =
      process.env.SDN_OD_REAL_MEME_LIVE === "1";
    const fetchAttempts = Number(
      process.env.SDN_OD_REAL_MEME_FETCH_ATTEMPTS ?? 3,
    );
    assert.ok(
      Number.isSafeInteger(fetchAttempts) &&
        fetchAttempts >= 1 &&
        fetchAttempts <= 5,
      "fetch attempts must be an integer in 1..5",
    );
    const fetchTimeoutMs = Number(
      process.env.SDN_OD_REAL_MEME_FETCH_TIMEOUT_MS ?? 120_000,
    );
    assert.ok(
      Number.isSafeInteger(fetchTimeoutMs) &&
        fetchTimeoutMs >= 1_000 &&
        fetchTimeoutMs <= 600_000,
      "fetch timeout must be an integer in 1000..600000 milliseconds",
    );
    const corpusRoot = path.resolve(
      process.env.SDN_OD_REAL_MEME_DIR ??
        "/Users/tj/software/starlink_downloader/ephemerides",
    );
    const manifest = readJson("plugin-manifest.json");
    const benchmarkArtifact = readOdTestArtifact();
    const artifactSha256 = crypto
      .createHash("sha256")
      .update(benchmarkArtifact)
      .digest("hex");
    const attemptLogPath = String(
      process.env.SDN_OD_REAL_MEME_ATTEMPT_LOG ?? "",
    ).trim();
    const attemptLogDescriptor = attemptLogPath
      ? fs.openSync(path.resolve(attemptLogPath), "wx", 0o600)
      : null;
    if (attemptLogDescriptor !== null) {
      t.after(() => fs.closeSync(attemptLogDescriptor));
    }
    const realCorpusAttempt = (event) => {
      if (attemptLogDescriptor === null) return;
      fs.writeSync(
        attemptLogDescriptor,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          ...event,
        })}\n`,
      );
    };
    let manifestSha256 = null;
    let allSources;
    if (liveCatalog) {
      assert.equal(
        typeof globalThis.fetch,
        "function",
        "live catalog benchmark requires fetch",
      );
      const manifestUrl =
        process.env.SDN_OD_REAL_MEME_MANIFEST_URL ??
        "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
      const ephemerisBase =
        process.env.SDN_OD_REAL_MEME_BASE_URL ??
        "https://api.starlink.com/public-files/ephemerides/";
      const manifestBytes = await readBoundedHttpBody(
        await globalThis.fetch(manifestUrl, {
          signal: AbortSignal.timeout(fetchTimeoutMs),
        }),
        maxStarlinkManifestBytes,
        "Starlink manifest",
      );
      manifestSha256 = crypto
        .createHash("sha256")
        .update(manifestBytes)
        .digest("hex");
      const filenames = selectLatestManifestEntries(
        new TextDecoder().decode(manifestBytes),
      );
      allSources = filenames.map((filename, ordinal) => ({
        filename,
        ordinal,
        sourceKind: "network",
        location: new URL(encodeURIComponent(filename), ephemerisBase).href,
      }));
    } else {
      allSources = fs.readdirSync(corpusRoot)
        .filter((name) => /^MEME_.+\.txt$/.test(name))
        .sort()
        .map((filename) => ({
          filename,
          location: path.join(corpusRoot, filename),
        }))
        .filter(({ location }) => {
          const size = fs.statSync(location).size;
          return size > fsbAlignedDataCapacity &&
            size <= maxStarlinkSourceBytes;
        })
        .map((source, ordinal) => ({
          ...source,
          ordinal,
          sourceKind: "local",
        }));
    }
    realCorpusAttempt({
      event: "catalog-frozen",
      sourceKind: liveCatalog ? "network" : "local",
      entries: allSources.length,
      manifestSha256,
      artifactSha256,
    });
    assert.ok(
      allSources.length >= 16,
      "real benchmark needs at least 16 complete sources",
    );

    const widths = (
      process.env.SDN_OD_REAL_MEME_WIDTHS ?? "1,2,4,8,16"
    )
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 16);
    if (liveCatalog) {
      assert.equal(
        widths.length,
        1,
        "a live catalog benchmark requires exactly one width",
      );
    }
    const repetitions = Number(
      process.env.SDN_OD_REAL_MEME_REPETITIONS ?? 4,
    );
    assert.ok(widths.length > 0);
    assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);

    const sampleCount = Math.min(
      allSources.length,
      Number(
        process.env.SDN_OD_REAL_MEME_SAMPLE_COUNT ??
          (liveCatalog ? allSources.length : Math.max(...widths) * repetitions),
      ),
    );
    assert.ok(Number.isSafeInteger(sampleCount) && sampleCount > 0);
    const sampledSources = Array.from({ length: sampleCount }, (_, index) => {
      const ordinal = sampleCount === 1
        ? 0
        : Math.round((index * (allSources.length - 1)) / (sampleCount - 1));
      return allSources[ordinal];
    });
    assert.equal(
      new Set(sampledSources.map(({ ordinal }) => ordinal)).size,
      sampleCount,
      "even-ordinal selection must not duplicate catalog sources",
    );
    const sampleDigest = crypto.createHash("sha256")
      .update(sampledSources.map(({ filename }) => filename).join("\n"))
      .digest("hex");
    const collectFailures =
      process.env.SDN_OD_REAL_MEME_COLLECT_FAILURES === "1";
    const percentile = (values, probability) => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[
        Math.min(
          sorted.length - 1,
          Math.max(0, Math.ceil(probability * sorted.length) - 1),
        )
      ];
    };

    const loadSourceWave = async (sources) => {
      const attempted = sources.map((source) => {
        const match = source.filename.match(
          /^MEME_(\d+)_([^_]+)_/,
        );
        assert.ok(
          match,
          `unable to read MEME identity from ${source.filename}`,
        );
        return {
          ...source,
          norad: Number(match[1]),
          objectName: match[2],
          requestId: 88_000n + BigInt(source.ordinal),
        };
      });
      const sourceLoadStartedAt = process.hrtime.bigint();
      const loadResults = await Promise.allSettled(
        attempted.map(async (expected) => {
          const maximumAttempts =
            expected.sourceKind === "network" ? fetchAttempts : 1;
          let lastError;
          for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            realCorpusAttempt({
              event: "source-start",
              ordinal: expected.ordinal,
              filename: expected.filename,
              sourceKind: expected.sourceKind,
              attempt,
            });
            try {
              const data = expected.sourceKind === "network"
                ? await readBoundedHttpBody(
                    await globalThis.fetch(expected.location, {
                      signal: AbortSignal.timeout(fetchTimeoutMs),
                    }),
                    maxStarlinkSourceBytes,
                    expected.filename,
                  )
                : new Uint8Array(fs.readFileSync(expected.location));
              if (
                data.byteLength === 0 ||
                data.byteLength > maxStarlinkSourceBytes
              ) {
                throw new Error(
                  `${expected.filename} has ${data.byteLength} bytes outside ` +
                    `1..${maxStarlinkSourceBytes}`,
                );
              }
              realCorpusAttempt({
                event: "source-loaded",
                ordinal: expected.ordinal,
                filename: expected.filename,
                sourceKind: expected.sourceKind,
                attempt,
                bytes: data.byteLength,
              });
              return data;
            } catch (error) {
              lastError = error;
              realCorpusAttempt({
                event: attempt < maximumAttempts
                  ? "source-retry"
                  : "source-exhausted",
                ordinal: expected.ordinal,
                filename: expected.filename,
                sourceKind: expected.sourceKind,
                attempt,
                error: String(error?.message ?? error),
              });
            }
          }
          throw lastError;
        }),
      );
      return {
        entries: attempted.map((expected, index) => {
          const result = loadResults[index];
          return result.status === "fulfilled"
            ? { expected, data: result.value }
            : { expected, loadError: result.reason };
        }),
        sourceLoadSeconds:
          Number(process.hrtime.bigint() - sourceLoadStartedAt) /
          1_000_000_000,
      };
    };

    const fitBatch = async (entries, harness) => {
      const failures = [];
      const failure = (expected, details) => {
        const record = {
          file: expected?.filename ?? null,
          norad: expected?.norad ?? null,
          objectName: expected?.objectName ?? null,
          ordinal: expected?.ordinal ?? null,
          sourceKind: expected?.sourceKind ?? null,
          ...details,
        };
        failures.push(record);
        realCorpusAttempt({ event: "failure", ...record });
      };
      const fixtureBytes = [];
      for (const entry of entries) {
        if (!entry.loadError) {
          fixtureBytes.push({ ...entry.expected, data: entry.data });
        } else {
          failure(entry.expected, {
            type: "source-load",
            statusCode: null,
            errorCode: "source-load",
            errorMessage: String(
              entry.loadError?.message ?? entry.loadError,
            ),
          });
        }
      }
      const expectedByRequestId = new Map(
        fixtureBytes.map((fixture) => [fixture.requestId, fixture]),
      );
      const inputs = fixtureBytes.flatMap(({
        data,
        norad,
        objectName,
        requestId,
      }) => {
        return completeCanonicalObjectFrames({
          data,
          requestId,
          schemaName: `MEME:${norad}:${objectName}`,
        });
      });
      const inputBytes = fixtureBytes.reduce(
        (sum, { data }) => sum + data.byteLength,
        0,
      );
      const usageBefore = process.resourceUsage();
      const startedAt = process.hrtime.bigint();
      const responses = fixtureBytes.length > 0
        ? [await harness.invoke({ methodId: "fit", inputs })]
        : [];
      const maximumDrainResponses = fixtureBytes.length + 1;
      let harnessUnhealthy = false;
      while (
        responses.length > 0 &&
        (
          responses.at(-1).yielded ||
          responses.at(-1).backlogRemaining > 0
        )
      ) {
        if (responses.length >= maximumDrainResponses) {
          harnessUnhealthy = true;
          failure(null, {
            type: "drain-bound",
            statusCode: responses.at(-1).statusCode,
            errorCode: responses.at(-1).errorCode,
            errorMessage:
              `OD remained nonterminal after ${responses.length} responses`,
          });
          break;
        }
        responses.push(
          await harness.invoke({ methodId: "fit", inputs: [] }),
        );
      }
      if (
        responses.length > 0 &&
        (
          responses.at(-1).yielded ||
          responses.at(-1).backlogRemaining > 0
        )
      ) {
        harnessUnhealthy = true;
      } else {
        const quiescent = await harness.invoke({ methodId: "fit", inputs: [] });
        if (
          quiescent.statusCode !== 0 ||
          quiescent.errorCode !== null ||
          quiescent.outputs.length !== 0 ||
          quiescent.yielded ||
          quiescent.backlogRemaining > 0
        ) {
          harnessUnhealthy = true;
          failure(null, {
            type: "quiescence",
            statusCode: quiescent.statusCode,
            errorCode: quiescent.errorCode,
            errorMessage: "OD emitted output or backlog after terminal drain",
          });
        }
      }

      const rmsKm = [];
      let ommRecords = 0;
      let ocmRecords = 0;
      let terminalOcmOnlyObjects = 0;
      let maxObservedIterations = 0;
      const seenRequestIds = new Set();
      for (const response of responses) {
        let statuses;
        try {
          statuses = decodeStatusOutputs(response);
        } catch (error) {
          harnessUnhealthy = true;
          failure(null, {
            type: "status-decode",
            statusCode: response.statusCode,
            errorCode: response.errorCode,
            errorMessage: String(error?.message ?? error),
          });
          continue;
        }
        if (statuses.length !== 1) {
          harnessUnhealthy = true;
          failure(null, {
            type: "missing-status",
            statusCode: response.statusCode,
            errorCode: response.errorCode,
            errorMessage:
              response.errorMessage ??
                `OD response carried ${statuses.length} status outputs`,
          });
          continue;
        }
        const successful = [];
        for (const status of statuses) {
          const expected = expectedByRequestId.get(status.requestId);
          if (!expected) {
            harnessUnhealthy = true;
            failure(null, {
              type: "unexpected-status",
              statusCode: response.statusCode,
              errorCode: status.errorCode || response.errorCode,
              errorMessage:
                `unexpected OD transaction ${status.requestId}: ${status.message}`,
            });
            continue;
          }
          if (seenRequestIds.has(status.requestId)) {
            harnessUnhealthy = true;
            failure(expected, {
              type: "duplicate-status",
              statusCode: response.statusCode,
              errorCode: status.errorCode || response.errorCode,
              errorMessage: `duplicate OD transaction ${status.requestId}`,
            });
            continue;
          }
          seenRequestIds.add(status.requestId);
          if (
            response.statusCode !== 0 ||
            status.status !== flatSqlNodeStatus.COMPLETE
          ) {
            failure(expected, {
              type: "od-status",
              statusCode: response.statusCode,
              errorCode: status.errorCode || response.errorCode,
              errorMessage: status.message || response.errorMessage,
            });
            continue;
          }
          successful.push({ expected, status });
        }
        if (successful.length === 0) continue;
        if (successful.length !== 1) {
          harnessUnhealthy = true;
          for (const { expected } of successful) {
            failure(expected, {
              type: "ambiguous-output",
              statusCode: response.statusCode,
              errorCode: response.errorCode,
              errorMessage:
                "one response carried multiple successful OD transactions",
            });
          }
          continue;
        }
        const [{ expected, status }] = successful;
        const sourceLabel =
          `${expected.norad}:${expected.objectName} (${expected.location})`;
        try {
          const ocm = reassembleRecordStream(response.outputs, "ocm");
          const controlOutputs = response.outputs.filter(
            (output) => output.portId === "control",
          );
          assert.equal(controlOutputs.length, 1);
          const [controlOutput] = controlOutputs;
          const controlRequestId = controlOutput.wireFormat === "aligned-binary"
            ? new DataView(
                controlOutput.payload.buffer,
                controlOutput.payload.byteOffset,
                controlOutput.payload.byteLength,
              ).getBigUint64(8, true)
            : decodeControl(controlOutput).requestId;
          assert.equal(controlRequestId, status.requestId);
          const hasOmm = response.outputs.some(
            (output) => output.portId === "omm",
          );
          const encodedOcmRecords =
            splitSizePrefixedRecords(ocm.stream);
          const decodedOcmRecords = encodedOcmRecords.map((record) =>
            OCM.getSizePrefixedRootAsOCM(new ByteBuffer(record))
          );
          const productShape = classifyOdProductShape({
            statusMessage: status.message,
            trajectoryDescription:
              decodedOcmRecords.length === 1
                ? String(decodedOcmRecords[0].TRAJ_TYPE_DESCRIPTION())
                : "",
            hasOmm,
          });
          if (productShape === "terminal-ocm") {
            assert.equal(status.affectedRecords, 1n);
            assert.equal(ocm.recordCount, 1n);
            assert.equal(status.resultBytes, BigInt(ocm.stream.byteLength));
            const [terminalOcm] = decodedOcmRecords;
            assert.equal(
              terminalOcm.METADATA()?.CATALOG_NAME(),
              String(expected.norad),
            );
            assert.equal(
              terminalOcm.METADATA()?.OBJECT_NAME(),
              expected.objectName,
            );
            assert.equal(terminalOcm.STATE_VECTOR_SIZE(), 6);
            const stepSeconds = terminalOcm.STATE_STEP_SIZE();
            assert.ok(Number.isFinite(stepSeconds) && stepSeconds > 0);
            const stateValueCount = terminalOcm.stateDataLength();
            assert.ok(stateValueCount >= 18);
            assert.equal(stateValueCount % 6, 0);
            assert.ok(
              terminalOcm.stateDataArray().every(Number.isFinite),
            );
            assert.equal(terminalOcm.covarianceDataLength(), 0);
            assert.equal(terminalOcm.ORBIT_DETERMINATION(), null);
            const startMilliseconds =
              Date.parse(terminalOcm.METADATA()?.START_TIME());
            const stopMilliseconds =
              Date.parse(terminalOcm.METADATA()?.STOP_TIME());
            assert.ok(Number.isFinite(startMilliseconds));
            assert.ok(stopMilliseconds > startMilliseconds);
            const stateCount = stateValueCount / 6;
            const expectedDurationSeconds =
              (stateCount - 1) * stepSeconds;
            assert.ok(
              Math.abs(
                (stopMilliseconds - startMilliseconds) / 1_000 -
                  expectedDurationSeconds,
              ) <= 0.001,
              "terminal OCM state count, step, and endpoints diverged",
            );
            assert.ok(
              Math.abs(
                terminalOcm.METADATA()?.TIME_SPAN() * 86_400 -
                  expectedDurationSeconds,
              ) <= 0.001,
            );
            ocmRecords += 1;
            terminalOcmOnlyObjects += 1;
            realCorpusAttempt({
              event: "od-complete",
              ordinal: expected.ordinal,
              filename: expected.filename,
              sourceKind: expected.sourceKind,
              records: 1,
              product: "terminal-ocm",
              maxRmsKm: null,
            });
            continue;
          }

          const omm = reassembleRecordStream(response.outputs, "omm");
          assert.ok(
            omm.recordCount >= 1n,
            "a complete real ephemeris must yield at least one complete window",
          );
          assert.equal(ocm.recordCount, omm.recordCount);
          assert.ok(omm.recordCount <= BigInt(Number.MAX_SAFE_INTEGER));
          assert.ok(ocm.recordCount <= BigInt(Number.MAX_SAFE_INTEGER));
          assert.equal(status.affectedRecords, omm.recordCount);
          assert.equal(
            status.resultBytes,
            BigInt(omm.stream.byteLength + ocm.stream.byteLength),
          );
          const decodedOmmRecords = splitSizePrefixedRecords(omm.stream).map(
            (record) => OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record)),
          );
          assert.ok(
            decodedOmmRecords.every((record) =>
              record.NORAD_CAT_ID() === expected.norad &&
              record.OBJECT_NAME() === expected.objectName
            ),
            `OMM output crossed source boundary for ${expected.norad}:${expected.objectName}`,
          );
          const ommEpochs = decodedOmmRecords.map((record) =>
            Date.parse(record.EPOCH())
          );
          const ocmEpochs = [];
          const sourceRmsKm = [];
          const observationCounts = new Set();
          let sourceMaxObservedIterations = 0;
          for (const record of splitSizePrefixedRecords(ocm.stream)) {
            const value = OCM.getSizePrefixedRootAsOCM(
              new ByteBuffer(record),
            );
            assert.equal(value.METADATA()?.CATALOG_NAME(), String(expected.norad));
            assert.equal(value.METADATA()?.OBJECT_NAME(), expected.objectName);
            ocmEpochs.push(
              Date.parse(value.ORBIT_DETERMINATION()?.OD_EPOCH()),
            );
            const observationCount =
              value.ORBIT_DETERMINATION()?.OD_OBSERVATIONS_USED();
            assert.ok(
              observationCount === 481 || observationCount === 241,
              `unexpected complete-window observation count ${observationCount}`,
            );
            observationCounts.add(observationCount);
            const encoded = value.ORBIT_DETERMINATION()?.OD_RESIDUALS();
            const residuals = typeof encoded === "string"
              ? encoded
              : new TextDecoder().decode(encoded ?? new Uint8Array());
            const rms = Number(
              residuals.match(/WRMS=([0-9.eE+-]+)\s+km/)?.[1],
            );
            assert.ok(Number.isFinite(rms));
            assert.ok(
              rms < 12,
              `real complete-window RMS ${rms} km exceeded 12 km`,
            );
            const convergence =
              value.ORBIT_DETERMINATION()?.OD_CONVERGENCE_CRITERIA();
            const convergenceText =
              typeof convergence === "string"
                ? convergence
                : new TextDecoder().decode(
                    convergence ?? new Uint8Array(),
                  );
            assert.match(
              convergenceText,
              /(?:^|;\s*)converged=(?:true|1)(?:;|$)/,
            );
            const iterations = Number(
              convergenceText.match(
                /(?:^|;\s*)iterations=(\d+)(?:;|$)/,
              )?.[1],
            );
            assert.ok(
              Number.isSafeInteger(iterations) &&
                iterations >= 0 &&
                iterations <= 60,
              `invalid iteration count in ${convergenceText}`,
            );
            sourceMaxObservedIterations = Math.max(
              sourceMaxObservedIterations,
              iterations,
            );
            sourceRmsKm.push(rms);
          }
          assert.equal(
            observationCounts.size,
            1,
            "one source transaction mixed primary and fallback windows",
          );
          assert.deepEqual(
            ocmEpochs,
            ommEpochs,
            `OMM/OCM epochs diverged for ${expected.norad}:${expected.objectName}`,
          );
          ommRecords += Number(omm.recordCount);
          ocmRecords += Number(ocm.recordCount);
          maxObservedIterations = Math.max(
            maxObservedIterations,
            sourceMaxObservedIterations,
          );
          rmsKm.push(...sourceRmsKm);
          realCorpusAttempt({
            event: "od-complete",
            ordinal: expected.ordinal,
            filename: expected.filename,
            sourceKind: expected.sourceKind,
            records: decodedOmmRecords.length,
            product:
              observationCounts.has(241) ? "omm-ocm-fallback" : "omm-ocm",
            maxRmsKm: Math.max(...sourceRmsKm),
          });
        } catch (error) {
          failure(expected, {
            type: "output-validation",
            statusCode: response.statusCode,
            errorCode: response.errorCode,
            errorMessage: `${sourceLabel}: ${error?.message ?? error}`,
          });
        }
      }
      for (const expected of fixtureBytes) {
        if (seenRequestIds.has(expected.requestId)) continue;
        harnessUnhealthy = true;
        failure(expected, {
          type: "missing-status",
          statusCode: null,
          errorCode: "missing-status",
          errorMessage:
            `no terminal OD status for transaction ${expected.requestId}`,
        });
      }
      const fitDrainValidationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      const usageAfter = process.resourceUsage();
      if (!collectFailures && failures.length > 0) {
        assert.fail(
          `${failures.length} OD batch failures: ${JSON.stringify(failures[0])}`,
        );
      }
      return {
        objectCount: entries.length,
        fitDrainValidationSeconds,
        cpuSeconds:
          (usageAfter.userCPUTime - usageBefore.userCPUTime +
            usageAfter.systemCPUTime - usageBefore.systemCPUTime) /
          1_000_000,
        failures,
        harnessUnhealthy,
        inputBytes,
        maxRmsKm: rmsKm.length > 0 ? Math.max(...rmsKm) : null,
        maxObservedIterations,
        ocmRecords,
        ommRecords,
        terminalOcmOnlyObjects,
        processPeakRssMiB: usageAfter.maxRSS / 1_024,
      };
    };

    const createBenchmarkHarness = () =>
      createBrowserModuleHarness({
        wasmSource: benchmarkArtifact,
        manifest,
        surface: "direct",
      });
    const destroyBenchmarkHarness = async (harness) => {
      await harness.threadHost?.terminateAll?.();
      harness.destroy();
    };
    const allFailures = [];
    for (const width of widths) {
      const trials = [];
      let harness = await createBenchmarkHarness();
      const fetchWaveWidth = liveCatalog ? liveFetchWaveWidth : width;
      let sourceLoadSeconds = 0;
      let processedSources = 0;
      const pipelineStartedAt = process.hrtime.bigint();
      let waveOffset = 0;
      let nextWavePromise = loadSourceWave(
        sampledSources.slice(0, fetchWaveWidth),
      );
      try {
        while (nextWavePromise) {
          const loadedWave = await nextWavePromise;
          sourceLoadSeconds += loadedWave.sourceLoadSeconds;
          waveOffset += fetchWaveWidth;
          nextWavePromise = waveOffset < sampledSources.length
            ? loadSourceWave(
                sampledSources.slice(
                  waveOffset,
                  waveOffset + fetchWaveWidth,
                ),
              )
            : null;
          for (
            let entryOffset = 0;
            entryOffset < loadedWave.entries.length;
            entryOffset += width
          ) {
            const entries = loadedWave.entries.slice(
              entryOffset,
              entryOffset + width,
            );
            const trial = await fitBatch(entries, harness);
            for (const entry of entries) {
              entry.data = null;
            }
            trials.push(trial);
            processedSources += entries.length;
            if (
              trial.harnessUnhealthy &&
              processedSources < sampledSources.length
            ) {
              await destroyBenchmarkHarness(harness);
              harness = await createBenchmarkHarness();
            }
          }
        }
      } finally {
        await destroyBenchmarkHarness(harness);
      }
      const pipelineWallSeconds =
        Number(process.hrtime.bigint() - pipelineStartedAt) / 1_000_000_000;
      const wallSeconds = trials.map(
        ({ fitDrainValidationSeconds }) => fitDrainValidationSeconds,
      );
      const fullBatchSeconds = trials
        .filter(({ objectCount }) => objectCount === width)
        .map(({ fitDrainValidationSeconds }) => fitDrainValidationSeconds);
      const tailTrial = trials.find(({ objectCount }) => objectCount < width);
      const totalObjects = trials.reduce(
        (sum, { objectCount }) => sum + objectCount,
        0,
      );
      const totalSeconds = wallSeconds.reduce((sum, value) => sum + value, 0);
      const totalBytes = trials.reduce(
        (sum, { inputBytes }) => sum + inputBytes,
        0,
      );
      const totalCpuSeconds = trials.reduce(
        (sum, { cpuSeconds }) => sum + cpuSeconds,
        0,
      );
      const totalOmmRecords = trials.reduce(
        (sum, { ommRecords }) => sum + ommRecords,
        0,
      );
      const totalOcmRecords = trials.reduce(
        (sum, { ocmRecords }) => sum + ocmRecords,
        0,
      );
      const totalTerminalOcmOnlyObjects = trials.reduce(
        (sum, { terminalOcmOnlyObjects }) =>
          sum + terminalOcmOnlyObjects,
        0,
      );
      assert.equal(
        totalOcmRecords,
        totalOmmRecords + totalTerminalOcmOnlyObjects,
        "OCM totals must equal paired OMM records plus terminal OCM-only objects",
      );
      const maxObservedIterations = Math.max(
        ...trials.map(({ maxObservedIterations }) => maxObservedIterations),
      );
      const failures = trials.flatMap((trial) => trial.failures);
      allFailures.push(...failures);
      const finiteRms = trials
        .map(({ maxRmsKm }) => maxRmsKm)
        .filter(Number.isFinite);
      const batchPercentile = (probability) =>
        fullBatchSeconds.length > 0
          ? percentile(fullBatchSeconds, probability).toFixed(6)
          : "none";
      t.diagnostic(
        `realCorpusFiles=${allSources.length} source=${liveCatalog ? "live-network" : "retained-local"} ` +
        `manifestSha256=${manifestSha256 ?? "none"} artifactSha256=${artifactSha256} ` +
        `selection=even-ordinal ` +
        `sampleFiles=${totalObjects} sampleDigest=${sampleDigest} ` +
        `width=${width} batches=${trials.length} ` +
        `attemptLog=${attemptLogPath || "none"} ` +
        `inputBytes=${totalBytes} p50FullBatchFitDrainValidationSeconds=${batchPercentile(0.5)} ` +
        `p95FullBatchFitDrainValidationSeconds=${batchPercentile(0.95)} ` +
        `p99FullBatchFitDrainValidationSeconds=${batchPercentile(0.99)} ` +
        `tailObjects=${tailTrial?.objectCount ?? 0} ` +
        `tailFitDrainValidationSeconds=${tailTrial?.fitDrainValidationSeconds.toFixed(6) ?? "none"} ` +
        `fetchWaveWidth=${fetchWaveWidth} ` +
        `sourceLoadWaveSeconds=${sourceLoadSeconds.toFixed(6)} ` +
        `pipelineWallSeconds=${pipelineWallSeconds.toFixed(6)} ` +
        `sequentialSourcePlusFitSeconds=${(sourceLoadSeconds + totalSeconds).toFixed(6)} ` +
        `aggregateObjectsPerSecond=${(totalObjects / totalSeconds).toFixed(4)} ` +
        `aggregateMiBPerSecond=${(totalBytes / 1024 / 1024 / totalSeconds).toFixed(3)} ` +
        `cpuSeconds=${totalCpuSeconds.toFixed(3)} ` +
        `averageCpuCores=${(totalCpuSeconds / totalSeconds).toFixed(3)} ` +
        `totalOmmRecords=${totalOmmRecords} ` +
        `totalOcmRecords=${totalOcmRecords} ` +
        `terminalOcmOnlyObjects=${totalTerminalOcmOnlyObjects} ` +
        `maxObservedIterations=${maxObservedIterations} ` +
        `processPeakRssMiB=${Math.max(...trials.map(({ processPeakRssMiB }) => processPeakRssMiB)).toFixed(3)} ` +
        `failedObjects=${failures.length} ` +
        `maxRmsKm=${finiteRms.length > 0 ? Math.max(...finiteRms) : "none"}`,
      );
      for (const failure of failures) {
        t.diagnostic(`realCorpusFailure=${JSON.stringify(failure)}`);
      }
    }
    assert.equal(
      allFailures.length,
      0,
      `${allFailures.length} complete real ephemerides failed OD; ` +
        "see realCorpusFailure diagnostics",
    );
  },
);

test(
  "benchmark OD full-arc worker scaling",
  {
    skip: process.env.SDN_OD_FULL_ARC_BENCHMARK !== "1",
    timeout: 180_000,
  },
  async (t) => {
    const manifest = readJson("plugin-manifest.json");
    const fixture = makeProductionShapedMemeFixture();
    const widths = (
      process.env.SDN_OD_FULL_ARC_WIDTHS ?? "1,2,4,8,16"
    )
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    assert.ok(widths.length > 0, "benchmark requires at least one worker width");
    for (const width of widths) {
      const harness = await createBrowserModuleHarness({
        wasmSource: readOdTestArtifact(),
        manifest,
        surface: "direct",
      });
      try {
        const expectedSources = new Map(
          Array.from({ length: width }, (_, index) => {
            const requestId = 87_000n + BigInt(index);
            return [
              requestId,
              {
                norad: 87_000 + index,
                objectName: `STARLINK-FULL-ARC-${width}-${index}`,
              },
            ];
          }),
        );
        const startedAt = process.hrtime.bigint();
        const first = await harness.invoke({
          methodId: "fit",
          inputs: Array.from({ length: width }, (_, index) =>
            completeCanonicalObjectFrames({
              data: fixture,
              requestId: 87_000n + BigInt(index),
              schemaName:
                `MEME:${87_000 + index}:STARLINK-FULL-ARC-${width}-${index}`,
            })
          ).flat(),
        });
        const responses = [first];
        while (
          responses.at(-1).yielded ||
          responses.at(-1).backlogRemaining > 0
        ) {
          responses.push(
            await harness.invoke({ methodId: "fit", inputs: [] }),
          );
        }
        assert.equal(
          responses.length,
          width,
          "every full-arc source must produce one drained response",
        );
        assert.equal(responses.at(-1).yielded, false);
        assert.equal(responses.at(-1).backlogRemaining, 0);

        const seenRequestIds = new Set();
        const rmsKm = [];
        for (const response of responses) {
          assert.equal(response.statusCode, 0, response.errorMessage);
          assert.equal(response.errorCode, null, response.errorMessage);
          const status = decodeStatusOutput(response);
          const expected = expectedSources.get(status.requestId);
          assert.ok(
            expected,
            `unexpected full-arc source transaction ${status.requestId}`,
          );
          assert.equal(
            seenRequestIds.has(status.requestId),
            false,
            `duplicate full-arc source transaction ${status.requestId}`,
          );
          seenRequestIds.add(status.requestId);
          assert.match(status.message, new RegExp(`batch_objects=${width}`));
          assert.match(status.message, new RegExp(`workers=${width}`));

          const omm = reassembleRecordStream(response.outputs, "omm");
          const ocm = reassembleRecordStream(response.outputs, "ocm");
          assert.equal(
            omm.recordCount,
            12n,
            "a complete captured 72-hour arc must produce 12 epoch-specific OMMs",
          );
          assert.equal(ocm.recordCount, omm.recordCount);
          const ommRecords = splitSizePrefixedRecords(omm.stream).map((record) =>
            OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record))
          );
          assert.ok(
            ommRecords.every((record) =>
              record.NORAD_CAT_ID() === expected.norad &&
              record.OBJECT_NAME() === expected.objectName
            ),
            `OMM output crossed source boundary for ${expected.norad}:${expected.objectName}`,
          );
          const ommEpochs = ommRecords.map((record) =>
            Date.parse(record.EPOCH())
          );
          const ocmEpochs = [];
          for (const record of splitSizePrefixedRecords(ocm.stream)) {
            const value = OCM.getSizePrefixedRootAsOCM(
              new ByteBuffer(record),
            );
            assert.equal(value.METADATA()?.CATALOG_NAME(), String(expected.norad));
            assert.equal(value.METADATA()?.OBJECT_NAME(), expected.objectName);
            ocmEpochs.push(
              Date.parse(value.ORBIT_DETERMINATION()?.OD_EPOCH()),
            );
            assert.equal(
              value.ORBIT_DETERMINATION()?.OD_OBSERVATIONS_USED(),
              481,
            );
            const encodedResiduals =
              value.ORBIT_DETERMINATION()?.OD_RESIDUALS();
            const residuals = typeof encodedResiduals === "string"
              ? encodedResiduals
              : new TextDecoder().decode(
                  encodedResiduals ?? new Uint8Array(),
                );
            const rms = Number(
              residuals.match(/WRMS=([0-9.eE+-]+)\s+km/)?.[1],
            );
            assert.ok(Number.isFinite(rms));
            assert.ok(rms < 12);
            const convergence =
              value.ORBIT_DETERMINATION()?.OD_CONVERGENCE_CRITERIA();
            assert.match(
              typeof convergence === "string"
                ? convergence
                : new TextDecoder().decode(
                    convergence ?? new Uint8Array(),
                  ),
              /(?:^|;\s*)converged=(?:true|1)(?:;|$)/,
            );
            rmsKm.push(rms);
          }
          assert.deepEqual(
            ocmEpochs,
            ommEpochs,
            `OMM/OCM epochs diverged for ${expected.norad}:${expected.objectName}`,
          );
        }
        assert.equal(seenRequestIds.size, expectedSources.size);
        const elapsedSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        const maxRmsKm = Math.max(...rmsKm);
        assert.ok(maxRmsKm < 12);
        const maxRssMiB = process.resourceUsage().maxRSS / 1_024;
        t.diagnostic(
          `fullArcObjects=${width} workers=${width} inputBytesEach=${fixture.byteLength} ` +
          `endToEndFitDrainValidationSeconds=${elapsedSeconds.toFixed(6)} ` +
          `objectsPerSecond=${(width / elapsedSeconds).toFixed(4)} ` +
          `maxRssMiB=${maxRssMiB.toFixed(3)} maxRmsKm=${maxRmsKm}`,
        );
      } finally {
        harness.destroy();
      }
    }
  },
);

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
  assert.equal(complete.errorCode, null, complete.errorMessage);
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
  ]);
  for (const marker of [
    /table\s+OMM/,
    /table\s+OCM/,
    /REFERENCE_FRAME\s*:\s*RFM/,
    /METADATA\s*:\s*Metadata/,
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

  const flatSqlRoot = path.join(packageRoot, "nodes/flatsql");
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
