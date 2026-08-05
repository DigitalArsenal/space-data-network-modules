import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  verifyModuleArtifact,
} from "../../../node_modules/space-data-module-sdk/src/index.js";
import {
  analyzeWasmThreadFeatures,
  assertPthreadArtifact,
} from "../../../node_modules/space-data-module-sdk/src/compiler/pthreadArtifactGuard.js";
import {
  createBrowserModuleHarness,
  createWorkerModuleHarness,
} from "../../../node_modules/space-data-module-sdk/src/testing/index.js";
import {
  decodePluginInvokeResponse,
  encodePluginInvokeRequest,
} from "../../../node_modules/space-data-module-sdk/src/invoke/codec.js";
import {
  Builder,
  ByteBuffer,
} from "../../../../spacedatastandards.org/node_modules/flatbuffers/js/flatbuffers.js";
import { DSS } from "../../../../spacedatastandards.org/lib/js/DSS/DSS.js";
import { FSB } from "../../../../spacedatastandards.org/lib/js/FSB/FSB.js";
import { FSO } from "../../../../spacedatastandards.org/lib/js/FSO/FSO.js";
import { flatSqlNodeOperation } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeOperation.js";
import { flatSqlNodeStatus } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeStatus.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const providers = [
  ["starlink", "com.orbpro.spacex-starlink-source"],
  ["glonass", "com.orbpro.glonass-source"],
  ["intelsat", "com.orbpro.intelsat-source"],
  ["cpf", "com.orbpro.cpf-source"],
  ["iss", "com.orbpro.iss-source"],
];
const fsbType = {
  schemaName: "FSB.fbs",
  fileIdentifier: "$FSB",
  schemaVersion: "1.158.1",
  schemaHash: "0b23aa63d0e3f17d828fc84dd433605c2794cb81ade7c043cb200e954c84e945",
  rootTypeName: "FSB",
};
const fixtureOrigin = "https://provider-fixtures.invalid";
const codeGlonassSource =
  "https://www.aiub.unibe.ch/download/CODE/COD0OPSULT.SP3";
const minimumFullFixtureBytes = 128 * 1024 + 8192;
const minimumThreadedFixtureBytes = 1024 * 1024 + 8192;
const starlinkInitialRangeBytes = 2 * 1024 * 1024;
const fsbAlignedSize = 1_048_744;
const fsbAlignedDataCapacity = 1_048_576;
const fsoAlignedSize = 361_648;
const fsoType = {
  schemaName: "FSO.fbs",
  fileIdentifier: "$FSO",
  schemaVersion: "1.158.2",
  schemaHash: "a298ef96af29624073edf749848e8ff1e5b8f45e56966c2e210cb719f3c5e821",
  rootTypeName: "FSO",
};

function nodePath(key, ...parts) {
  return path.join(packageRoot, "nodes/providers", key, ...parts);
}

function joinFixtureUrl(base, child) {
  return base.endsWith("/") ? `${base}${child}` : `${base}/${child}`;
}

function isStarlinkSizeProbe(params) {
  return isStarlinkInitialDataRange(params);
}

function isStarlinkInitialDataRange(params) {
  return params.headers?.Range ===
    `bytes=0-${starlinkInitialRangeBytes - 1}`;
}

function serveStarlinkRangeAsData(params, responses) {
  const body = responses.get(params.url);
  if (!body) return { status: 404, body: new Uint8Array() };
  const bytes = new Uint8Array(body);
  if (isStarlinkInitialDataRange(params)) {
    const length = Math.min(bytes.byteLength, starlinkInitialRangeBytes);
    return {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${length - 1}/${bytes.byteLength}`,
        "Content-Length": String(length),
      },
      body: bytes.subarray(0, length).slice(),
    };
  }
  if (params.headers?.Range !== undefined) {
    return { status: 416, body: new Uint8Array() };
  }
  return {
    status: 200,
    headers: { "Content-Length": String(bytes.byteLength) },
    body: bytes.slice(),
  };
}

function serveFixtureHttp(params, responses) {
  return serveStarlinkRangeAsData(params, responses);
}

function readJson(filePath, description) {
  assert.ok(fs.existsSync(filePath), `${description} is missing: ${filePath}`);
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
  for (const property of [
    "schemaName",
    "fileIdentifier",
    "schemaVersion",
    "schemaHash",
    "rootTypeName",
  ]) {
    assert.equal(aligned[property] ?? null, canonical[property] ?? null);
  }
  assert.equal(aligned.byteLength, 1_048_744);
  assert.equal(aligned.requiredAlignment, 8);
}

function assertFsoPair(port, location) {
  assert.equal(port?.acceptedTypeSets?.length, 1, `${location} needs one type set`);
  const types = port.acceptedTypeSets[0]?.allowedTypes ?? [];
  assert.equal(types.length, 2, `${location} needs exactly two representations`);
  const canonical = types.find(
    (type) => (type.wireFormat ?? "flatbuffer") === "flatbuffer",
  );
  const aligned = types.find((type) => type.wireFormat === "aligned-binary");
  assert.ok(canonical, `${location} needs canonical FlatBuffer`);
  assert.ok(aligned, `${location} needs aligned binary`);
  assert.equal(canonical.schemaName, "FSO.fbs");
  assert.equal(canonical.fileIdentifier, "$FSO");
  assert.equal(canonical.rootTypeName, "FSO");
  for (const property of [
    "schemaName",
    "fileIdentifier",
    "schemaVersion",
    "schemaHash",
    "rootTypeName",
  ]) {
    assert.equal(aligned[property] ?? null, canonical[property] ?? null);
  }
  assert.equal(aligned.byteLength, fsoAlignedSize);
  assert.equal(aligned.requiredAlignment, 8);
}

function makeFsb(data) {
  const builder = new Builder(Math.max(256, data.byteLength + 256));
  const schemaName = builder.createString("supplemental-omm.provider-config.v1");
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
  return builder.asUint8Array();
}

function makeAlignedFsb(data) {
  assert.ok(data.byteLength <= fsbAlignedDataCapacity);
  const bytes = new Uint8Array(fsbAlignedSize);
  const view = new DataView(bytes.buffer);
  const schemaName = new TextEncoder().encode(
    "supplemental-omm.provider-config.v1",
  );
  const fileIdentifier = new TextEncoder().encode("CONF");
  bytes[0] = 7;
  view.setBigUint64(8, 1n, true);
  bytes[16] = 1;
  bytes[24] = 1;
  view.setBigUint64(32, BigInt(data.byteLength), true);
  view.setBigUint64(40, 1n, true);
  bytes[52] = schemaName.byteLength;
  bytes.set(schemaName, 53);
  bytes[117] = fileIdentifier.byteLength;
  bytes.set(fileIdentifier, 118);
  view.setUint32(124, data.byteLength, true);
  bytes.set(data, 128);
  return bytes;
}

function configJsonFrame(json, wireFormat = "flatbuffer") {
  const encoded = new TextEncoder().encode(json);
  const aligned = wireFormat === "aligned-binary";
  return {
    portId: "config",
    wireFormat,
    typeRef: {
      ...fsbType,
      schemaHash: [...Buffer.from(fsbType.schemaHash, "hex")],
      wireFormat,
      ...(aligned
        ? { byteLength: fsbAlignedSize, requiredAlignment: 8 }
        : {}),
    },
    payload: aligned ? makeAlignedFsb(encoded) : makeFsb(encoded),
  };
}

function configFrame(config, wireFormat = "flatbuffer") {
  return configJsonFrame(JSON.stringify(config), wireFormat);
}

function makeCanonicalFsoAck(
  requestId,
  operation = flatSqlNodeOperation.APPEND_RECORDS,
  status = flatSqlNodeStatus.COMPLETE,
) {
  const builder = new Builder(256);
  FSO.startFSO(builder);
  FSO.addOperation(builder, operation);
  FSO.addRequestId(builder, BigInt(requestId));
  FSO.addStatus(builder, status);
  const root = FSO.endFSO(builder);
  FSO.finishFSOBuffer(builder, root);
  return builder.asUint8Array();
}

function makeAlignedFsoAck(
  requestId,
  operation = flatSqlNodeOperation.APPEND_RECORDS,
  status = flatSqlNodeStatus.COMPLETE,
) {
  const bytes = new Uint8Array(fsoAlignedSize);
  const view = new DataView(bytes.buffer);
  bytes[2] = operation;
  view.setBigUint64(8, BigInt(requestId), true);
  bytes[357_392] = status;
  return bytes;
}

function ackFrame(
  requestId,
  wireFormat = "flatbuffer",
  {
    operation = flatSqlNodeOperation.APPEND_RECORDS,
    status = flatSqlNodeStatus.COMPLETE,
  } = {},
) {
  const aligned = wireFormat === "aligned-binary";
  return {
    portId: "ack",
    wireFormat,
    typeRef: {
      ...fsoType,
      schemaHash: [...Buffer.from(fsoType.schemaHash, "hex")],
      wireFormat,
      ...(aligned
        ? { byteLength: fsoAlignedSize, requiredAlignment: 8 }
        : {}),
    },
    payload: aligned
      ? makeAlignedFsoAck(requestId, operation, status)
      : makeCanonicalFsoAck(requestId, operation, status),
  };
}

function text(value) {
  return typeof value === "string" ? value : new TextDecoder().decode(value ?? []);
}

function decodeFsb(payload) {
  const bytes = new Uint8Array(payload);
  assert.equal(new TextDecoder().decode(bytes.subarray(4, 8)), "$FSB");
  const value = FSB.getRootAsFSB(new ByteBuffer(bytes));
  return {
    requestId: value.REQUEST_ID(),
    chunkSequence: value.CHUNK_SEQUENCE(),
    final: value.FINAL(),
    totalBytes: value.TOTAL_BYTES(),
    recordCount: value.RECORD_COUNT(),
    schemaName: text(value.SCHEMA_NAME()),
    fileIdentifier: text(value.FILE_IDENTIFIER()),
    data: new Uint8Array(value.dataArray() ?? []),
    sha256: new Uint8Array(value.sha256Array() ?? []),
  };
}

function decodeProgressDss(frame) {
  const envelope = decodeFsb(frame.payload);
  assert.equal(envelope.schemaName, "DSS.fbs");
  assert.equal(envelope.fileIdentifier, "$DSS");
  assert.equal(envelope.final, true);
  assert.equal(envelope.recordCount, 1n);
  assert.ok(envelope.data.byteLength >= 12);
  assert.equal(
    new DataView(
      envelope.data.buffer,
      envelope.data.byteOffset,
      envelope.data.byteLength,
    ).getUint32(0, true) + 4,
    envelope.data.byteLength,
    "progress DATA must contain exactly one canonical size-prefixed DSS",
  );
  assert.equal(
    new TextDecoder().decode(envelope.data.subarray(8, 12)),
    "$DSS",
  );
  const dss = DSS.getSizePrefixedRootAsDSS(new ByteBuffer(envelope.data));
  return {
    status: dss.STATUS(),
    syncedRows: dss.SYNCED_ROWS(),
    totalRows: dss.TOTAL_ROWS(),
    localRows: dss.LOCAL_ROWS(),
    missingRows: dss.MISSING_ROWS(),
    cachedBytes: dss.CACHED_BYTES(),
    downloadedBytes: dss.DOWNLOADED_BYTES(),
  };
}

function createOpaqueStateAdapter() {
  let values = new Map();
  let durableValues = new Map();
  const calls = [];
  const keyFor = (params) => `${params.namespace}\0${params.key}`;
  const cloneValues = (source) =>
    new Map([...source].map(([key, value]) => [key, value.slice()]));
  const keysFrom = (source) =>
    [...source.keys()].map((key) => key.split("\0").at(-1)).sort();
  return {
    calls,
    durableKeys() {
      return keysFrom(durableValues);
    },
    getDurable(key, namespace = "primary") {
      return durableValues.get(`${namespace}\0${key}`)?.slice();
    },
    crash() {
      values = cloneValues(durableValues);
    },
    dispatch(operation, params) {
      calls.push({
        operation,
        params: {
          namespace: params.namespace,
          key: params.key,
          ...(params.data instanceof Uint8Array
            ? { data: params.data.slice() }
            : {}),
        },
      });
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
        const prefix = `${params.namespace}\0`;
        for (const key of durableValues.keys()) {
          if (key.startsWith(prefix)) durableValues.delete(key);
        }
        for (const [key, value] of values) {
          if (key.startsWith(prefix)) durableValues.set(key, value.slice());
        }
        return { synced: true };
      }
      throw new Error(`unexpected opaque-state operation ${operation}`);
    },
  };
}

function decodeStarlinkStreamingCursor(bytesLike) {
  const bytes = new Uint8Array(bytesLike ?? []);
  assert.ok(bytes.byteLength >= 166, "streaming cursor is too short");
  const payloadEnd = bytes.byteLength - 32;
  assert.deepEqual(
    bytes.subarray(payloadEnd),
    new Uint8Array(
      crypto.createHash("sha256").update(bytes.subarray(0, payloadEnd)).digest(),
    ),
    "streaming cursor checksum mismatch",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), "SLCURS01");
  assert.equal(view.getUint16(8, true), 1);
  assert.equal(view.getUint16(10, true), 0);
  const unitCount = view.getUint32(12, true);
  const acknowledgedCount = view.getUint32(16, true);
  const objectCap = view.getUint32(20, true);
  const fetchConcurrency = view.getUint16(24, true);
  const batchSize = view.getUint16(26, true);
  const manifestUrlLength = view.getUint16(28, true);
  const ephemerisBaseLength = view.getUint16(30, true);
  const acknowledgedIdentityLength = view.getUint16(32, true);
  assert.equal(view.getUint16(34, true), 0);
  const manifestHash = bytes.subarray(36, 68).slice();
  const planIdentity = bytes.subarray(68, 100).slice();
  const runId = bytes.subarray(100, 132).slice();
  let cursor = 132;
  const manifestUrl = text(
    bytes.subarray(cursor, cursor + manifestUrlLength),
  );
  cursor += manifestUrlLength;
  const ephemerisBase = text(
    bytes.subarray(cursor, cursor + ephemerisBaseLength),
  );
  cursor += ephemerisBaseLength;
  const acknowledgedIdentity = text(
    bytes.subarray(cursor, cursor + acknowledgedIdentityLength),
  );
  cursor += acknowledgedIdentityLength;
  const units = [];
  for (let index = 0; index < unitCount; index += 1) {
    const coreLength = view.getUint16(cursor, true);
    cursor += 2;
    const core = text(bytes.subarray(cursor, cursor + coreLength));
    cursor += coreLength;
    const filename = `MEME_${core}_UNCLASSIFIED.txt`;
    const fields = filename.split("_");
    units.push({
      filename,
      identity: `MEME:${fields[1]}:${fields[2]}`,
    });
  }
  assert.equal(cursor, payloadEnd, "streaming cursor has trailing fields");
  return {
    bytes,
    unitCount,
    acknowledgedCount,
    objectCap,
    fetchConcurrency,
    batchSize,
    manifestUrl,
    ephemerisBase,
    acknowledgedIdentity,
    manifestHash,
    planIdentity,
    runId,
    units,
  };
}

function readAlignedVector(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(offset, true);
  return bytes.subarray(offset + 4, offset + 4 + length).slice();
}

function readAlignedString(bytes, offset) {
  return new TextDecoder().decode(
    bytes.subarray(offset + 1, offset + 1 + bytes[offset]),
  );
}

function decodeAlignedFsb(payload) {
  const bytes = new Uint8Array(payload);
  assert.equal(bytes.byteLength, fsbAlignedSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    requestId: view.getBigUint64(8, true),
    chunkSequence: view.getUint32(20, true),
    final: bytes[24] !== 0,
    totalBytes: view.getBigUint64(32, true),
    recordCount: view.getBigUint64(40, true),
    schemaName: (bytes[0] & 1) !== 0 ? readAlignedString(bytes, 52) : "",
    fileIdentifier:
      (bytes[0] & 2) !== 0 ? readAlignedString(bytes, 117) : "",
    data:
      (bytes[0] & 4) !== 0
        ? readAlignedVector(bytes, 124)
        : new Uint8Array(),
    sha256:
      (bytes[0] & 8) !== 0
        ? readAlignedVector(bytes, 1_048_704)
        : new Uint8Array(),
  };
}

function repeatToSize(seedLines, minimumBytes = minimumFullFixtureBytes) {
  const isMeme =
    seedLines[0]?.startsWith("created:") &&
    seedLines[1]?.startsWith("ephemeris_start:") &&
    seedLines[2]?.startsWith("ephemeris_source:") &&
    seedLines[3] === "UVW";
  const header = `${seedLines.slice(0, isMeme ? 4 : seedLines.length).join("\n")}\n`;
  const repeatable = isMeme
    ? `${seedLines.slice(4).join("\n")}\n`
    : header;
  let value = header + (isMeme ? repeatable : "");
  while (Buffer.byteLength(value) <= minimumBytes) value += repeatable;
  return new TextEncoder().encode(value);
}

function memeToExactSize(seedLines, exactBytes) {
  assert.ok(seedLines.length > 4);
  assert.equal(seedLines[3], "UVW");
  const encoder = new TextEncoder();
  const header = encoder.encode(`${seedLines.slice(0, 4).join("\n")}\n`);
  const data = encoder.encode(`${seedLines.slice(4).join("\n")}\n`);
  assert.ok(header.byteLength + data.byteLength <= exactBytes);
  const output = new Uint8Array(exactBytes);
  output.fill(0x20);
  output.set(header, 0);
  let cursor = header.byteLength;
  do {
    output.set(data, cursor);
    cursor += data.byteLength;
  } while (cursor + data.byteLength <= exactBytes);
  return output;
}

const fixtureBodies = {
  starlinkA: repeatToSize([
    "created: 2026-07-21 00:00:00 UTC",
    "ephemeris_start: 2026-07-21 00:00:00 UTC ephemeris_stop: 2026-07-22 00:00:00 UTC step_size: 60",
    "ephemeris_source: test",
    "UVW",
    "2026202000000.000 7000 0 0 0 7.5 0",
    "1.0e-4 0 0",
    "2026202000100.000 6999 450 0 -0.5 7.48 0",
  ], minimumThreadedFixtureBytes),
  starlinkB: repeatToSize([
    "created: 2026-07-21 01:00:00 UTC",
    "ephemeris_start: 2026-07-21 01:00:00 UTC ephemeris_stop: 2026-07-22 01:00:00 UTC step_size: 60",
    "ephemeris_source: test",
    "UVW",
    "2026202010000.000 7100 0 0 0 7.4 0",
    "1.0e-4 0 0",
    "2026202010100.000 7099 444 0 -0.5 7.39 0",
  ], minimumThreadedFixtureBytes),
  glonass: repeatToSize([
    "#dP2026  7 21  0  0  0.00000000      96 ORBIT IGS20 FIT IAC",
    "*  2026 07 21 00 00 00.00000000",
    "PR01  19123.000000  12000.000000  15000.000000  0.000000",
    "*  2026 07 21 00 15 00.00000000",
    "PR01  19000.000000  12100.000000  15100.000000  0.000000",
  ]),
  intelsat: repeatToSize([
    "ECF Ephemeris for Intelsat IS-21 / 302.00 deg E / test",
    "Date Time X Y Z",
    "2026/07/21 00:00:00.000 42164000.0 0.0 0.0",
    "2026/07/21 00:05:00.000 42163000.0 1000.0 0.0",
  ]),
  cpf: repeatToSize([
    "H1 CPF 2 DGF 2026 07 21 00 1 0 lageos1 test",
    "H2 7603901 1155 8820 2026 7 21 0 0 0 2026 7 22 0 0 0 60 1 1 0 0 0 1",
    "10 0 61242 0.000000 0 7000000.0 0.0 0.0",
    "10 0 61242 60.000000 0 6999000.0 1000.0 0.0",
    "99",
  ]),
  iss: repeatToSize([
    "CCSDS_OEM_VERS = 2.0",
    "CREATION_DATE = 2026-07-21T00:00:00.000",
    "META_START",
    "OBJECT_NAME = ISS",
    "META_STOP",
    "2026-07-21T00:00:00.000 7000 0 0 0 7.5 0",
    "2026-07-21T00:04:00.000 6990 450 0 -0.5 7.48 0",
  ]),
};

function epochCount(key, bytes) {
  const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
  if (key === "starlink") {
    return lines.filter((line) => /^\d{13,}(?:\.\d+)?\s/.test(line)).length;
  }
  if (key === "glonass") return lines.filter((line) => /^\*\s+\d{4}\s/.test(line)).length;
  if (key === "intelsat") return lines.filter((line) => /^\d{4}\/\d{2}\/\d{2}\s/.test(line)).length;
  if (key === "cpf") return lines.filter((line) => /^10\s/.test(line)).length;
  return lines.filter((line) => /^\d{4}-\d{2}-\d{2}T\S+\s+(?:[-+]?\d)/.test(line)).length;
}

const behaviorCases = {
  starlink: {
    config: {
      manifestUrl: `${fixtureOrigin}/starlink/MANIFEST.txt`,
      ephemerisBase: `${fixtureOrigin}/starlink/`,
      fetchConcurrency: 2,
      batchSize: 8,
    },
    responses: new Map([
      [
        `${fixtureOrigin}/starlink/MANIFEST.txt`,
        new TextEncoder().encode("MEME_10001_STARLINK-A_1_Operational_1_UNCLASSIFIED.txt\nMEME_10002_STARLINK-B_2_Operational_2_UNCLASSIFIED.txt\n"),
      ],
      [`${fixtureOrigin}/starlink/MEME_10001_STARLINK-A_1_Operational_1_UNCLASSIFIED.txt`, fixtureBodies.starlinkA],
      [`${fixtureOrigin}/starlink/MEME_10002_STARLINK-B_2_Operational_2_UNCLASSIFIED.txt`, fixtureBodies.starlinkB],
    ]),
    units: [fixtureBodies.starlinkA, fixtureBodies.starlinkB],
    metadata: [
      { schemaName: "MEME:10001:STARLINK-A", fileIdentifier: "MEME" },
      { schemaName: "MEME:10002:STARLINK-B", fileIdentifier: "MEME" },
    ],
    discoveryCalls: 1,
  },
  glonass: {
    config: {},
    responses: new Map([[codeGlonassSource, fixtureBodies.glonass]]),
    units: [fixtureBodies.glonass],
    metadata: [{ schemaName: "SP3", fileIdentifier: "SP3" }],
    discoveryCalls: 0,
  },
  intelsat: {
    config: {
      listingUrl: `${fixtureOrigin}/intelsat/public`,
      ephemerisBase: `${fixtureOrigin}/intelsat/files/`,
      target: "is-21",
    },
    responses: new Map([
      [
        `${fixtureOrigin}/intelsat/public`,
        new TextEncoder().encode('<option value="i_aor_e_302.00_is-21_20260721_000000">latest</option>'),
      ],
      [`${fixtureOrigin}/intelsat/files/i_aor_e_302.00_is-21_20260721_000000.txt`, fixtureBodies.intelsat],
    ]),
    units: [fixtureBodies.intelsat],
    metadata: [{ schemaName: "ECF", fileIdentifier: "ECF" }],
    discoveryCalls: 1,
  },
  cpf: {
    config: { listingUrl: `${fixtureOrigin}/cpf/2026/lageos1/`, target: "lageos1" },
    responses: new Map([
      [
        `${fixtureOrigin}/cpf/2026/lageos1/`,
        new TextEncoder().encode('<a href="lageos1_cpf_260721_0001.dgf">latest</a>'),
      ],
      [`${fixtureOrigin}/cpf/2026/lageos1/lageos1_cpf_260721_0001.dgf`, fixtureBodies.cpf],
    ]),
    units: [fixtureBodies.cpf],
    metadata: [{ schemaName: "CPF", fileIdentifier: "CPF" }],
    discoveryCalls: 1,
  },
  iss: {
    config: { sourceUrl: `${fixtureOrigin}/iss/current.txt` },
    responses: new Map([[`${fixtureOrigin}/iss/current.txt`, fixtureBodies.iss]]),
    units: [fixtureBodies.iss],
    metadata: [{ schemaName: "OEM", fileIdentifier: "OEM" }],
    discoveryCalls: 0,
  },
};

async function createHarness(key, hostcallDispatch) {
  const manifest = readJson(nodePath(key, "plugin-manifest.json"), `${key} manifest`);
  const wasmPath =
    key === "starlink" && process.env.SUPPLEMENTAL_OMM_STARLINK_TEST_WASM
      ? path.resolve(process.env.SUPPLEMENTAL_OMM_STARLINK_TEST_WASM)
      : nodePath(key, "dist/isomorphic/module.wasm");
  const signed = new Uint8Array(
    fs.readFileSync(wasmPath),
  );
  return createBrowserModuleHarness({
    wasmSource: signed,
    manifest,
    surface: "direct",
    hostcallDispatch,
  });
}

async function createWorkerHarness(key, hostcallDispatch, harnessOptions = {}) {
  const manifest = readJson(nodePath(key, "plugin-manifest.json"), `${key} manifest`);
  const wasmPath =
    key === "starlink" && process.env.SUPPLEMENTAL_OMM_STARLINK_TEST_WASM
      ? path.resolve(process.env.SUPPLEMENTAL_OMM_STARLINK_TEST_WASM)
      : nodePath(key, "dist/isomorphic/module.wasm");
  const signed = new Uint8Array(
    fs.readFileSync(wasmPath),
  );
  const worker = await createWorkerModuleHarness({
    wasmSource: signed,
    dispatchHost: hostcallDispatch,
    harnessOptions: {
      manifest,
      surface: "direct",
      maxThreads: 64,
      ...harnessOptions,
    },
  });
  return {
    ...worker,
    // Keep the worker boundary byte-only. Decoded PIV responses intentionally
    // carry an arena lease with methods, which structured clone cannot copy.
    invoke: async (request) =>
      decodePluginInvokeResponse(
        await worker.invokeRaw(encodePluginInvokeRequest(request)),
      ),
  };
}

test("GLONASS defaults to CODE's production HTTPS ultra-rapid SP3 alias", () => {
  const source = fs.readFileSync(nodePath("glonass", "src/node.cpp"), "utf8");
  assert.match(source, new RegExp(codeGlonassSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(source, /ftp:\/\//i);
  assert.doesNotMatch(source, /celestrak/i);
});

test("GLONASS aligned FSB input selects aligned FSB output with exact bytes", async (t) => {
  const calls = [];
  const harness = await createHarness("glonass", (operation, params) => {
    calls.push({ operation, params: structuredClone(params) });
    if (operation !== "http.request" || params.url !== codeGlonassSource) {
      return { status: 404, body: new Uint8Array() };
    }
    return { status: 200, body: new Uint8Array(fixtureBodies.glonass) };
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({}, "aligned-binary")],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(calls.length, 1);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].wireFormat, "aligned-binary");
  assert.equal(response.outputs[0].typeRef?.byteLength, fsbAlignedSize);
  assert.equal(response.outputs[0].typeRef?.requiredAlignment, 8);

  const output = decodeAlignedFsb(response.outputs[0].payload);
  assert.equal(output.chunkSequence, 0);
  assert.equal(output.final, true);
  assert.equal(output.totalBytes, BigInt(fixtureBodies.glonass.byteLength));
  assert.equal(output.recordCount, BigInt(epochCount("glonass", fixtureBodies.glonass)));
  assert.equal(output.schemaName, "SP3");
  assert.equal(output.fileIdentifier, "SP3");
  assert.deepEqual(output.data, fixtureBodies.glonass);
  assert.deepEqual(
    output.sha256,
    new Uint8Array(
      crypto.createHash("sha256").update(fixtureBodies.glonass).digest(),
    ),
  );
});

test("GLONASS no-input invocation retains canonical FSB fallback", async (t) => {
  const harness = await createHarness("glonass", (operation, params) => {
    if (operation !== "http.request" || params.url !== codeGlonassSource) {
      return { status: 404, body: new Uint8Array() };
    }
    return { status: 200, body: new Uint8Array(fixtureBodies.glonass) };
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.ok(response.outputs.length >= 1);
  for (const output of response.outputs) {
    assert.equal(output.wireFormat, "flatbuffer");
    assert.equal(output.typeRef?.fileIdentifier, "$FSB");
    decodeFsb(output.payload);
  }
});

test("provider SHA-256 streams full blocks and matches padding-boundary vectors", async (t) => {
  const runtime = fs.readFileSync(
    path.join(packageRoot, "nodes/providers/common/provider_runtime.hpp"),
    "utf8",
  );
  const implementation = runtime.slice(
    runtime.indexOf("void sha256("),
    runtime.indexOf("using RecordCounter"),
  );
  assert.ok(implementation.length > 0, "missing provider SHA-256 implementation");
  assert.doesNotMatch(
    implementation,
    /std::vector\s*<\s*uint8_t\s*>/,
    "SHA-256 must not allocate a whole-message copy",
  );
  assert.match(implementation, /uint8_t\s+tail\s*\[\s*128\s*\]/);
  assert.match(implementation, /data\s*\+\s*offset/);

  let body = new Uint8Array();
  const harness = await createHarness("glonass", (operation, params) => {
    assert.equal(operation, "http.request");
    assert.equal(params.url, codeGlonassSource);
    return { status: 200, body: body.slice() };
  });
  t.after(() => harness.destroy());

  const vectors = [
    new TextEncoder().encode("abc"),
    ...[1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 4097].map(
      (length) => Uint8Array.from(
        { length },
        (_, index) => (index * 131 + length * 17 + (index >>> 2)) & 0xff,
      ),
    ),
  ];
  for (const [index, value] of vectors.entries()) {
    body = value;
    const response = await harness.invoke({ methodId: "emit", inputs: [] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.outputs.length, 1);
    const fsb = decodeFsb(response.outputs[0].payload);
    const expected = new Uint8Array(
      crypto.createHash("sha256").update(value).digest(),
    );
    assert.deepEqual(
      fsb.sha256,
      expected,
      index === 0
        ? "the SHA-256 abc known vector must match"
        : `SHA-256 differential mismatch at ${value.byteLength} bytes`,
    );
    assert.deepEqual(fsb.data, value, "hashing cannot change provider bytes");
  }
});

test("provider response precondition rejection cannot consume the next numeric request ID", () => {
  const runtime = fs.readFileSync(
    path.join(packageRoot, "nodes/providers/common/provider_runtime.hpp"),
    "utf8",
  );
  const wrapper = runtime.slice(
    runtime.indexOf("int emit_complete_response("),
    runtime.indexOf("\nuint32_t output_frame_count"),
  );
  assert.ok(wrapper.length > 0, "missing provider response wrapper");
  const emptyGuard = wrapper.indexOf("if (bytes.empty()) return -1;");
  const alignedGuard = wrapper.indexOf("g_aligned_output_requested");
  const increment = wrapper.indexOf("++g_next_request_id");
  assert.ok(emptyGuard >= 0, "empty responses need a pre-increment guard");
  assert.ok(alignedGuard >= 0, "aligned metadata needs a pre-increment guard");
  assert.ok(increment >= 0, "missing numeric request-ID allocation");
  assert.ok(
    emptyGuard < increment && alignedGuard < increment,
    "rejected responses must leave the next numeric request ID unchanged",
  );
});

function streamingStarlinkFixture(count = 3, suffix = "") {
  const manifestUrl =
    `${fixtureOrigin}/starlink-streaming${suffix}/MANIFEST.txt`;
  const ephemerisBase =
    `${fixtureOrigin}/starlink-streaming${suffix}/`;
  const filenames = Array.from(
    { length: count },
    (_, index) =>
      `MEME_${91_000 + index}_STARLINK-STREAM-${index + 1}_${index + 1}_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const bodies = filenames.map((_, index) =>
    new TextEncoder().encode([
      `created: 2026-07-23 0${index}:00:00 UTC`,
      `ephemeris_start: 2026-07-23 0${index}:00:00 UTC ephemeris_stop: 2026-07-23 0${index + 1}:00:00 UTC step_size: 60`,
      "ephemeris_source: streaming-test",
      "UVW",
      `20262040${index}0000.000 ${7000 + index} 0 0 0 7.5 0`,
      "1.0e-4 0 0",
      `20262040${index}0100.000 ${6999 + index} 450 0 -0.5 7.48 0`,
      "",
    ].join("\n"))
  );
  return {
    manifestUrl,
    ephemerisBase,
    filenames,
    bodies,
    responses: new Map([
      [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
      ...filenames.map((filename, index) => [
        joinFixtureUrl(ephemerisBase, filename),
        bodies[index],
      ]),
    ]),
    config: {
      manifestUrl,
      ephemerisBase,
      fetchConcurrency: 4,
      batchSize: count,
    },
  };
}

function starlinkOemStreams(response) {
  const chunks = response.outputs
    .filter(({ portId }) => portId === "oem")
    .map(({ payload }) => decodeFsb(payload));
  return [...new Set(chunks.map(({ requestId }) => requestId.toString()))]
    .map((requestId) => ({
      requestId: BigInt(requestId),
      chunks: chunks.filter(
        ({ requestId: candidate }) => candidate === BigInt(requestId),
      ),
    }));
}

test("Starlink streaming contract declares paired FSO acknowledgements and forbids raw durable spooling", () => {
  const manifest = readJson(
    nodePath("starlink", "plugin-manifest.json"),
    "Starlink provider manifest",
  );
  assert.deepEqual(manifest.capabilities, ["http", "storage_adapter"]);
  const method = manifest.methods?.find(({ methodId }) => methodId === "emit");
  assert.ok(method);
  assert.deepEqual(
    method.inputPorts.map(({ portId }) => portId),
    ["config", "ack"],
  );
  assert.deepEqual(
    method.outputPorts.map(({ portId }) => portId),
    ["oem", "progress"],
  );
  assertFsbPair(method.inputPorts[0], "starlink.config");
  assertFsoPair(method.inputPorts[1], "starlink.ack");
  assert.equal(method.inputPorts[1].required, false);
  assert.equal(method.inputPorts[1].minStreams, 0);
  assert.equal(method.inputPorts[1].maxStreams, 64);
  assert.equal(method.maxBatch, 64);
  assert.equal(method.outputPorts[0].maxStreams, 256);

  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  assert.match(
    source,
    /'S',\s*'L',\s*'C',\s*'U',\s*'R',\s*'S',\s*'0',\s*'1'/,
  );
  assert.match(source, /storage\.adapter\.opaque\.replace/);
  assert.match(source, /storage\.adapter\.opaque\.sync/);
  assert.doesNotMatch(source, /SLSPOOL1|Phase::kDownloading|Phase::kDraining/);
  assert.doesNotMatch(
    source,
    /encode_opaque_chunk|decode_opaque_chunk|chunk_key|chunk_namespace/,
  );
  assert.doesNotMatch(source, /storage\.adapter\.opaque\.delete/);
  assert.match(
    source,
    /kMaxAcknowledgementFramesPerInvocation\s*=\s*64/,
  );
  const acknowledgements = source.slice(
    source.indexOf("bool consume_store_acknowledgements"),
    source.indexOf("\nint fail_invocation"),
  );
  assert.ok(acknowledgements.length > 0);
  const overflowGuard = acknowledgements.search(
    /plugin_find_input_index\s*\(\s*"ack",\s*kMaxAcknowledgementFramesPerInvocation\s*\)/,
  );
  const processingLoop = acknowledgements.indexOf(
    "for (uint32_t ordinal = 0;",
  );
  assert.ok(overflowGuard >= 0, "missing guest-owned 65th-ACK guard");
  assert.ok(
    overflowGuard < processingLoop,
    "the guest must reject the 65th ACK before processing any ACK frame",
  );
})

test("Starlink streaming build owns no retired raw-spool compression dependency", () => {
  const buildSource = fs.readFileSync(
    nodePath("starlink", "build.mjs"),
    "utf8",
  );
  assert.doesNotMatch(buildSource, /miniz|sourceFragments/);
  assert.equal(
    fs.existsSync(nodePath("starlink", "miniz-source.mjs")),
    false,
  );
  assert.equal(
    fs.existsSync(nodePath("starlink", "vendor/miniz-3.1.2")),
    false,
  );
});

test("Starlink streaming emits every complete first-wave file and persists no raw ephemeris bytes", async (t) => {
  const fixture = streamingStarlinkFixture(3, "-same-wave");
  const opaque = createOpaqueStateAdapter();
  const httpCalls = [];
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      httpCalls.push({ url: params.url, range: params.headers?.Range ?? null });
      return serveFixtureHttp(params, fixture.responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.yielded, true);
  const streams = starlinkOemStreams(response);
  assert.equal(streams.length, fixture.bodies.length);
  for (const [index, stream] of streams.entries()) {
    assert.deepEqual(
      Buffer.concat(stream.chunks.map(({ data }) => Buffer.from(data))),
      Buffer.from(fixture.bodies[index]),
    );
  }
  assert.deepEqual(
    httpCalls.map(({ url }) => url),
    [fixture.manifestUrl, ...fixture.filenames.map(
      (filename) => joinFixtureUrl(fixture.ephemerisBase, filename),
    )],
  );
  const cursorWrites = opaque.calls.filter(
    ({ operation }) => operation === "storage.adapter.opaque.replace",
  );
  assert.equal(cursorWrites.length, 1);
  assert.deepEqual(
    cursorWrites.map(({ params }) => [params.namespace, params.key]),
    [["primary", "starlink.cursor.v1"]],
  );
  assert.ok(
    cursorWrites.every(
      ({ params }) =>
        params.data.byteLength < fixture.bodies.reduce(
          (sum, body) => sum + body.byteLength,
          0,
        ),
    ),
    "the only write must be compact metadata, never the source ephemeris",
  );
  assert.equal(
    opaque.calls.filter(
      ({ operation }) => operation === "storage.adapter.opaque.delete",
    ).length,
    0,
  );
  const cursor = decodeStarlinkStreamingCursor(
    opaque.getDurable("starlink.cursor.v1"),
  );
  assert.equal(cursor.acknowledgedCount, 0);
  assert.deepEqual(cursor.units.map(({ filename }) => filename), fixture.filenames);
})

test("Starlink signed worker artifact completes the bounded first wave through the deterministic EAGAIN fallback", async (t) => {
  const fixture = streamingStarlinkFixture(9, "-worker-pthreads");
  fixture.config.fetchConcurrency = 3;
  fixture.config.batchSize = 9;
  const opaque = createOpaqueStateAdapter();
  let activeFileRequests = 0;
  let maxActiveFileRequests = 0;
  let completedFileRequests = 0;
  const harness = await createWorkerHarness("starlink", (operation, params) => {
    if (operation !== "http.request") {
      return opaque.dispatch(operation, params);
    }
    if (params.url === fixture.manifestUrl) {
      return serveFixtureHttp(params, fixture.responses);
    }
    activeFileRequests += 1;
    maxActiveFileRequests = Math.max(
      maxActiveFileRequests,
      activeFileRequests,
    );
    return new Promise((resolve) => {
      setTimeout(() => {
        const response = serveFixtureHttp(params, fixture.responses);
        activeFileRequests -= 1;
        completedFileRequests += 1;
        resolve(response);
      }, 12);
    });
  });
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.equal(first.yielded, true);
  assert.ok(
    fixture.filenames.length > fixture.config.fetchConcurrency,
    "the fixture must contain more entries than the configured fetch width",
  );
  assert.equal(completedFileRequests, fixture.filenames.length);
  assert.equal(
    maxActiveFileRequests,
    1,
    "the worker harness must use the SDK's deterministic EAGAIN fallback while hostcall-capable pthread workers are unavailable",
  );
  assert.equal(activeFileRequests, 0, "no delayed HTTP activity may leak");
  const firstStreams = starlinkOemStreams(first);
  assert.equal(
    firstStreams.length,
    fixture.filenames.length,
    "entries beyond the fetch width must still emit in the first configured wave",
  );
  const completed = await harness.invoke({
    methodId: "emit",
    inputs: firstStreams.map(({ requestId }) => ackFrame(requestId)),
  });
  assert.equal(completed.statusCode, 0, completed.errorMessage);
  assert.equal(completed.yielded, false);
  assert.equal(
    decodeStarlinkStreamingCursor(
      opaque.getDurable("starlink.cursor.v1"),
    ).acknowledgedCount,
    fixture.filenames.length,
  );
  await harness.destroy();
  assert.equal(activeFileRequests, 0, "worker teardown cannot leak HTTP work");
});

test("Starlink streaming derives identical source request IDs across fresh instances", async (t) => {
  const fixture = streamingStarlinkFixture(2, "-stable-id");
  const run = async () => {
    const opaque = createOpaqueStateAdapter();
    const harness = await createHarness("starlink", (operation, params) =>
      operation === "http.request"
        ? serveFixtureHttp(params, fixture.responses)
        : opaque.dispatch(operation, params)
    );
    const response = await harness.invoke({
      methodId: "emit",
      inputs: [configFrame(fixture.config)],
    });
    await harness.destroy();
    assert.equal(response.statusCode, 0, response.errorMessage);
    return starlinkOemStreams(response).map(({ requestId }) => requestId);
  };
  const first = await run();
  const second = await run();
  assert.equal(first.length, 2);
  assert.deepEqual(second, first);
  assert.ok(first.every((requestId) => requestId !== 0n));
  t.after(() => {});
})

test("Starlink streaming advances only a canonical-or-aligned contiguous FlatSQL acknowledgement prefix", async (t) => {
  const fixture = streamingStarlinkFixture(3, "-ack-prefix");
  const opaque = createOpaqueStateAdapter();
  const harness = await createHarness("starlink", (operation, params) =>
    operation === "http.request"
      ? serveFixtureHttp(params, fixture.responses)
      : opaque.dispatch(operation, params)
  );
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  const requestIds = starlinkOemStreams(first).map(({ requestId }) => requestId);
  assert.equal(requestIds.length, 3);
  const initialWrites = opaque.calls.filter(
    ({ operation }) => operation === "storage.adapter.opaque.replace",
  ).length;

  const outOfOrder = await harness.invoke({
    methodId: "emit",
    inputs: [ackFrame(requestIds[1])],
  });
  assert.equal(outOfOrder.statusCode, 0, outOfOrder.errorMessage);
  assert.equal(
    decodeStarlinkStreamingCursor(
      opaque.getDurable("starlink.cursor.v1"),
    ).acknowledgedCount,
    0,
  );
  assert.equal(
    opaque.calls.filter(
      ({ operation }) => operation === "storage.adapter.opaque.replace",
    ).length,
    initialWrites,
    "an out-of-order acknowledgement cannot dirty the durable cursor",
  );

  const duplicateAligned = await harness.invoke({
    methodId: "emit",
    inputs: [ackFrame(requestIds[1], "aligned-binary")],
  });
  assert.equal(duplicateAligned.statusCode, 0, duplicateAligned.errorMessage);
  assert.equal(
    decodeStarlinkStreamingCursor(
      opaque.getDurable("starlink.cursor.v1"),
    ).acknowledgedCount,
    0,
  );

  const closesGap = await harness.invoke({
    methodId: "emit",
    inputs: [ackFrame(requestIds[0])],
  });
  assert.equal(closesGap.statusCode, 0, closesGap.errorMessage);
  const afterGap = decodeStarlinkStreamingCursor(
    opaque.getDurable("starlink.cursor.v1"),
  );
  assert.equal(afterGap.acknowledgedCount, 2);
  assert.equal(afterGap.acknowledgedIdentity, afterGap.units[1].identity);

  const completes = await harness.invoke({
    methodId: "emit",
    inputs: [ackFrame(requestIds[2], "aligned-binary")],
  });
  assert.equal(completes.statusCode, 0, completes.errorMessage);
  assert.equal(completes.yielded, false);
  const finalCursor = decodeStarlinkStreamingCursor(
    opaque.getDurable("starlink.cursor.v1"),
  );
  assert.equal(finalCursor.acknowledgedCount, 3);
  assert.equal(finalCursor.acknowledgedIdentity, finalCursor.units[2].identity);
})

test("Starlink ignores canonical and aligned wrong-operation or zero-ID acknowledgements", async (t) => {
  const fixture = streamingStarlinkFixture(1, "-ignored-acks");
  const opaque = createOpaqueStateAdapter();
  const harness = await createHarness("starlink", (operation, params) =>
    operation === "http.request"
      ? serveFixtureHttp(params, fixture.responses)
      : opaque.dispatch(operation, params)
  );
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  const [requestId] = starlinkOemStreams(first)
    .map(({ requestId: candidate }) => candidate);
  assert.ok(requestId);
  const writesBeforeIgnored = opaque.calls.filter(
    ({ operation }) => operation === "storage.adapter.opaque.replace",
  ).length;

  const ignored = await harness.invoke({
    methodId: "emit",
    inputs: [
      ackFrame(requestId, "flatbuffer", {
        operation: flatSqlNodeOperation.CONFIGURE_INDEX,
      }),
      ackFrame(requestId, "aligned-binary", {
        operation: flatSqlNodeOperation.CONFIGURE_INDEX,
      }),
      ackFrame(0n),
      ackFrame(0n, "aligned-binary"),
    ],
  });
  assert.equal(ignored.statusCode, 0, ignored.errorMessage);
  assert.deepEqual(starlinkOemStreams(ignored), []);
  assert.equal(
    decodeStarlinkStreamingCursor(
      opaque.getDurable("starlink.cursor.v1"),
    ).acknowledgedCount,
    0,
  );
  assert.equal(
    opaque.calls.filter(
      ({ operation }) => operation === "storage.adapter.opaque.replace",
    ).length,
    writesBeforeIgnored,
    "ignored acknowledgements cannot dirty the durable cursor",
  );
});

test("Starlink guest rejects a 65th acknowledgement before advancing the cursor", async (t) => {
  const fixture = streamingStarlinkFixture(1, "-ack-bound");
  const opaque = createOpaqueStateAdapter();
  const harness = await createHarness("starlink", (operation, params) =>
    operation === "http.request"
      ? serveFixtureHttp(params, fixture.responses)
      : opaque.dispatch(operation, params)
  );
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  const [requestId] = starlinkOemStreams(first)
    .map(({ requestId: candidate }) => candidate);
  assert.ok(requestId);
  const writesBeforeOverflow = opaque.calls.filter(
    ({ operation }) => operation === "storage.adapter.opaque.replace",
  ).length;

  const overflow = await harness.invoke({
    methodId: "emit",
    inputs: Array.from({ length: 65 }, () => ackFrame(requestId)),
  });
  assert.notEqual(overflow.statusCode, 0);
  assert.match(overflow.errorMessage, /ack|64|limit|batch/i);
  assert.equal(
    decodeStarlinkStreamingCursor(
      opaque.getDurable("starlink.cursor.v1"),
    ).acknowledgedCount,
    0,
  );
  assert.equal(
    opaque.calls.filter(
      ({ operation }) => operation === "storage.adapter.opaque.replace",
    ).length,
    writesBeforeOverflow,
    "the overflow guard must run before any acknowledgement is processed",
  );
});

test("Starlink streaming retries an unacknowledged wave on the next config wakeup", async (t) => {
  const fixture = streamingStarlinkFixture(3, "-retry-wave");
  const opaque = createOpaqueStateAdapter();
  const httpCalls = [];
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      httpCalls.push(params.url);
      return serveFixtureHttp(params, fixture.responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  const firstIds = starlinkOemStreams(first).map(({ requestId }) => requestId);
  assert.equal(firstIds.length, 3);

  const advancesOne = await harness.invoke({
    methodId: "emit",
    inputs: [ackFrame(firstIds[0])],
  });
  assert.equal(advancesOne.statusCode, 0, advancesOne.errorMessage);
  assert.equal(
    decodeStarlinkStreamingCursor(
      opaque.getDurable("starlink.cursor.v1"),
    ).acknowledgedCount,
    1,
  );

  const callsBeforeWaiting = httpCalls.length;
  const waiting = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(waiting.statusCode, 0, waiting.errorMessage);
  assert.deepEqual(starlinkOemStreams(waiting), []);
  assert.equal(
    httpCalls.length,
    callsBeforeWaiting,
    "an acknowledgement-only continuation must wait without refetching",
  );

  const retry = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(retry.statusCode, 0, retry.errorMessage);
  assert.deepEqual(
    starlinkOemStreams(retry).map(({ requestId }) => requestId),
    firstIds.slice(1),
    "the next scheduled config wakeup must replay from the durable prefix",
  );
  assert.deepEqual(
    httpCalls.slice(callsBeforeWaiting),
    fixture.filenames.slice(1).map(
      (filename) => joinFixtureUrl(fixture.ephemerisBase, filename),
    ),
  );
});

test("Starlink incomplete run refuses manifest rollover and replays its persisted suffix", async (t) => {
  const fixture = streamingStarlinkFixture(2, "-incomplete-rollover");
  const opaque = createOpaqueStateAdapter();
  const httpCalls = [];
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      httpCalls.push(params.url);
      return serveFixtureHttp(params, fixture.responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  const firstIds = starlinkOemStreams(first).map(({ requestId }) => requestId);
  assert.equal(firstIds.length, 2);
  const advanced = await harness.invoke({
    methodId: "emit",
    inputs: [ackFrame(firstIds[0])],
  });
  assert.equal(advanced.statusCode, 0, advanced.errorMessage);

  const replacementFilename =
    "MEME_92999_STARLINK-ROLLOVER-B_2_Operational_2_UNCLASSIFIED.txt";
  fixture.responses.set(
    fixture.manifestUrl,
    new TextEncoder().encode(`${replacementFilename}\n`),
  );
  httpCalls.length = 0;
  const retry = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(retry.statusCode, 0, retry.errorMessage);
  assert.deepEqual(
    starlinkOemStreams(retry).map(({ requestId }) => requestId),
    [firstIds[1]],
    "an incomplete run must finish the durable run-A suffix",
  );
  assert.deepEqual(httpCalls, [
    joinFixtureUrl(fixture.ephemerisBase, fixture.filenames[1]),
  ]);
  const cursor = decodeStarlinkStreamingCursor(
    opaque.getDurable("starlink.cursor.v1"),
  );
  assert.equal(cursor.acknowledgedCount, 1);
  assert.deepEqual(
    cursor.units.map(({ filename }) => filename),
    fixture.filenames,
  );
});

test("Starlink completed run stays terminal for an unchanged manifest and rolls over once it changes", async (t) => {
  const fixture = streamingStarlinkFixture(1, "-completed-rollover");
  const opaque = createOpaqueStateAdapter();
  const httpCalls = [];
  const replacementFilename =
    "MEME_93999_STARLINK-COMPLETED-B_2_Operational_2_UNCLASSIFIED.txt";
  const replacementBody = new TextEncoder().encode(
    new TextDecoder().decode(fixture.bodies[0])
      .replaceAll("streaming-test", "completed-rollover-b")
      .replace("7000", "7200"),
  );
  fixture.responses.set(
    joinFixtureUrl(fixture.ephemerisBase, replacementFilename),
    replacementBody,
  );
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      httpCalls.push(params.url);
      return serveFixtureHttp(params, fixture.responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  const [firstId] = starlinkOemStreams(first)
    .map(({ requestId }) => requestId);
  const completed = await harness.invoke({
    methodId: "emit",
    inputs: [ackFrame(firstId)],
  });
  assert.equal(completed.statusCode, 0, completed.errorMessage);
  const runA = decodeStarlinkStreamingCursor(
    opaque.getDurable("starlink.cursor.v1"),
  );
  assert.equal(runA.acknowledgedCount, 1);
  const writesAfterRunA = opaque.calls.filter(
    ({ operation }) => operation === "storage.adapter.opaque.replace",
  ).length;

  httpCalls.length = 0;
  const unchanged = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({
      ...fixture.config,
      fetchConcurrency: 2,
    })],
  });
  assert.equal(unchanged.statusCode, 0, unchanged.errorMessage);
  assert.deepEqual(starlinkOemStreams(unchanged), []);
  assert.deepEqual(
    httpCalls,
    [fixture.manifestUrl],
    "a terminal wakeup may inspect the manifest but cannot refetch unchanged ephemeris bytes",
  );
  assert.equal(
    opaque.calls.filter(
      ({ operation }) => operation === "storage.adapter.opaque.replace",
    ).length,
    writesAfterRunA,
    "an unchanged completed plan must remain terminal without a cursor rewrite",
  );

  fixture.responses.set(
    fixture.manifestUrl,
    new TextEncoder().encode(`${replacementFilename}\n`),
  );
  httpCalls.length = 0;
  const runB = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(runB.statusCode, 0, runB.errorMessage);
  const [runBStream] = starlinkOemStreams(runB);
  assert.ok(runBStream, "the changed completed plan must emit run B");
  assert.deepEqual(
    Buffer.concat(runBStream.chunks.map(({ data }) => Buffer.from(data))),
    Buffer.from(replacementBody),
  );
  assert.deepEqual(httpCalls, [
    fixture.manifestUrl,
    joinFixtureUrl(fixture.ephemerisBase, replacementFilename),
  ]);
  const cursorB = decodeStarlinkStreamingCursor(
    opaque.getDurable("starlink.cursor.v1"),
  );
  assert.equal(cursorB.acknowledgedCount, 0);
  assert.deepEqual(
    cursorB.units.map(({ filename }) => filename),
    [replacementFilename],
  );
  assert.notDeepEqual(cursorB.runId, runA.runId);
});

test("Starlink streaming restart replays only the unacknowledged suffix and rejects a changed plan", async (t) => {
  const fixture = streamingStarlinkFixture(2, "-restart");
  const opaque = createOpaqueStateAdapter();
  const dispatch = (operation, params) =>
    operation === "http.request"
      ? serveFixtureHttp(params, fixture.responses)
      : opaque.dispatch(operation, params);
  const firstHarness = await createHarness("starlink", dispatch);
  const first = await firstHarness.invoke({
    methodId: "emit",
    inputs: [configFrame(fixture.config)],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  const firstIds = starlinkOemStreams(first).map(({ requestId }) => requestId);
  assert.equal(firstIds.length, 2);
  const advanced = await firstHarness.invoke({
    methodId: "emit",
    inputs: [ackFrame(firstIds[0])],
  });
  assert.equal(advanced.statusCode, 0, advanced.errorMessage);
  await firstHarness.destroy();
  opaque.crash();

  const replayCalls = [];
  const replayHarness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      replayCalls.push(params.url);
      return serveFixtureHttp(params, fixture.responses);
    }
    return opaque.dispatch(operation, params);
  });
  const replay = await replayHarness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(replay.statusCode, 0, replay.errorMessage);
  const replayStreams = starlinkOemStreams(replay);
  assert.deepEqual(replayStreams.map(({ requestId }) => requestId), [firstIds[1]]);
  assert.deepEqual(replayCalls, [
    fixture.manifestUrl,
    joinFixtureUrl(fixture.ephemerisBase, fixture.filenames[1]),
  ]);
  await replayHarness.destroy();

  const changedManifest = new Map(fixture.responses);
  changedManifest.set(
    fixture.manifestUrl,
    new TextEncoder().encode(`${[...fixture.filenames].reverse().join("\n")}\n`),
  );
  const mismatchFileCalls = [];
  const mismatchHarness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      if (params.url !== fixture.manifestUrl) mismatchFileCalls.push(params.url);
      return serveFixtureHttp(params, changedManifest);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => mismatchHarness.destroy());
  const mismatch = await mismatchHarness.invoke({ methodId: "emit", inputs: [] });
  assert.notEqual(mismatch.statusCode, 0);
  assert.match(mismatch.errorMessage, /plan|manifest|cursor/i);
  assert.deepEqual(mismatchFileCalls, []);
})

test("Starlink streaming preserves manifest order of latest-generation winners before object cap", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-latest/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-latest/`;
  const filenames = {
    aOld:
      "MEME_41001_STARLINK-A_2026001_Operational_100_UNCLASSIFIED.txt",
    aLatest:
      "MEME_41001_STARLINK-A_2026002_Operational_900_UNCLASSIFIED.txt",
    bOld:
      "MEME_41002_STARLINK-B_2026001_Operational_300_UNCLASSIFIED.txt",
    bLatest:
      "MEME_41002_STARLINK-B_2026002_Operational_600_UNCLASSIFIED.txt",
    cOld:
      "MEME_41003_STARLINK-C_2026001_Operational_400_UNCLASSIFIED.txt",
    cLatest:
      "MEME_41003_STARLINK-C_2026002_Operational_500_UNCLASSIFIED.txt",
  };
  const manifestOrder = [
    filenames.aOld,
    filenames.aLatest,
    filenames.cLatest,
    filenames.bOld,
    filenames.bLatest,
    filenames.cOld,
  ];
  const bodyFor = (filename) =>
    new TextEncoder().encode([
      "created: 2026-07-23 00:00:00 UTC",
      "ephemeris_start: 2026-07-23 00:00:00 UTC ephemeris_stop: 2026-07-24 00:00:00 UTC step_size: 60",
      `ephemeris_source: ${filename}`,
      "UVW",
      "2026204000000.000 7000 0 0 0 7.5 0",
      "2026204000100.000 6999 450 0 -0.5 7.48 0",
      "",
    ].join("\n"));
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${manifestOrder.join("\n")}\n`)],
    ...manifestOrder.map((filename) => [
      joinFixtureUrl(ephemerisBase, filename),
      bodyFor(filename),
    ]),
  ]);
  const calls = [];
  const opaque = createOpaqueStateAdapter();
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      calls.push(params.url);
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({
      manifestUrl,
      ephemerisBase,
      objectCap: 2,
    })],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const selected = [filenames.aLatest, filenames.cLatest];
  assert.deepEqual(
    decodeStarlinkStreamingCursor(
      opaque.getDurable("starlink.cursor.v1"),
    ).units.map(({ filename }) => filename),
    selected,
  );
  assert.deepEqual(
    starlinkOemStreams(response).map(({ chunks }) =>
      Buffer.concat(chunks.map(({ data }) => Buffer.from(data)))
    ),
    selected.map((filename) => Buffer.from(bodyFor(filename))),
  );
  assert.deepEqual(
    calls,
    [
      manifestUrl,
      ...selected.map((filename) => joinFixtureUrl(ephemerisBase, filename)),
    ],
  );
});

test("Starlink streaming rejects malformed MEME responses before OD output", async (t) => {
  const malformed = new Map([
    ["html", "<html><body>upstream error</body></html>"],
    ["non-finite", [
      "created: 2026-07-23 00:00:00 UTC",
      "ephemeris_start: 2026-07-23 00:00:00 UTC ephemeris_stop: 2026-07-24 00:00:00 UTC step_size: 60",
      "ephemeris_source: invalid",
      "UVW",
      "2026204000000.000 7000 0 0 0 NaN 0",
    ].join("\n")],
    ["invalid-timestamp", [
      "created: 2026-07-23 00:00:00 UTC",
      "ephemeris_start: 2026-07-23 00:00:00 UTC ephemeris_stop: 2026-07-24 00:00:00 UTC step_size: 60",
      "ephemeris_source: invalid",
      "UVW",
      "2026367000000.000 7000 0 0 0 7.5 0",
    ].join("\n")],
  ]);

  for (const [name, bodyText] of malformed) {
    await t.test(name, async (subtest) => {
      const manifestUrl =
        `${fixtureOrigin}/starlink-invalid-${name}/MANIFEST.txt`;
      const ephemerisBase =
        `${fixtureOrigin}/starlink-invalid-${name}/`;
      const filename =
        "MEME_42002_STARLINK-INVALID_2026204_Operational_701_UNCLASSIFIED.txt";
      const responses = new Map([
        [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
        [
          joinFixtureUrl(ephemerisBase, filename),
          new TextEncoder().encode(bodyText),
        ],
      ]);
      const opaque = createOpaqueStateAdapter();
      const harness = await createHarness("starlink", (operation, params) =>
        operation === "http.request"
          ? serveFixtureHttp(params, responses)
          : opaque.dispatch(operation, params)
      );
      subtest.after(() => harness.destroy());

      const response = await harness.invoke({
        methodId: "emit",
        inputs: [configFrame({ manifestUrl, ephemerisBase })],
      });
      assert.notEqual(response.statusCode, 0);
      assert.deepEqual(response.outputs, []);
      assert.equal(
        decodeStarlinkStreamingCursor(
          opaque.getDurable("starlink.cursor.v1"),
        ).acknowledgedCount,
        0,
      );
      assert.deepEqual(opaque.durableKeys(), ["starlink.cursor.v1"]);
    });
  }
});

test("Starlink streaming validates and emits the tracked real MEME fixture byte-exactly", async (t) => {
  const filename =
    "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt";
  const fixturePath = path.join(
    packageRoot,
    "../../data-source/spacex-starlink-source/test/fixtures/meme",
    filename,
  );
  const body = new Uint8Array(fs.readFileSync(fixturePath));
  assert.equal(body.byteLength, 5847);
  assert.equal(
    crypto.createHash("sha256").update(body).digest("hex"),
    "42615f12fee9be8072907fa0968871d6d60ef10678fa3d12dee994468c682db0",
  );
  assert.equal(epochCount("starlink", body), 12);

  const manifestUrl = `${fixtureOrigin}/starlink-real/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-real/`;
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
    [joinFixtureUrl(ephemerisBase, filename), body],
  ]);
  const opaque = createOpaqueStateAdapter();
  const harness = await createHarness("starlink", (operation, params) =>
    operation === "http.request"
      ? serveFixtureHttp(params, responses)
      : opaque.dispatch(operation, params)
  );
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const [stream] = starlinkOemStreams(response);
  assert.ok(stream);
  assert.equal(
    stream.chunks.reduce((sum, chunk) => sum + chunk.recordCount, 0n),
    12n,
  );
  assert.deepEqual(
    Buffer.concat(stream.chunks.map(({ data }) => Buffer.from(data))),
    Buffer.from(body),
  );
});

test("Starlink streaming rejects overlong identities before file fetch", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-long-identity/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-long-identity/`;
  const sharedPrefix = "STARLINK-" + "X".repeat(70);
  const filenames = [
    `MEME_42003_${sharedPrefix}A_2026204_Operational_702_UNCLASSIFIED.txt`,
    `MEME_42003_${sharedPrefix}B_2026204_Operational_703_UNCLASSIFIED.txt`,
  ];
  const opaque = createOpaqueStateAdapter();
  const calls = [];
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      calls.push(params.url);
      return params.url === manifestUrl
        ? {
            status: 200,
            body: new TextEncoder().encode(`${filenames.join("\n")}\n`),
          }
        : { status: 200, body: new Uint8Array([1]) };
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.deepEqual(calls, [manifestUrl]);
  assert.deepEqual(
    opaque.calls.map(({ operation }) => operation),
    ["storage.adapter.opaque.read"],
  );
  assert.doesNotMatch(
    fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8"),
    /identity\.resize\s*\(/,
  );
});

test("Starlink inactive zero-input invocation is idle without network work", async (t) => {
  const opaque = createOpaqueStateAdapter();
  const harness = await createHarness("starlink", (operation, params) => {
    assert.notEqual(operation, "http.request", "idle startup cannot fetch");
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(response.outputs, []);
  assert.equal(response.yielded, false);
  assert.equal(response.backlogRemaining, 0);
  assert.deepEqual(
    opaque.calls.map(({ operation }) => operation),
    ["storage.adapter.opaque.read"],
  );
});

test("Starlink rejects malformed initial Content-Range metadata and body lengths", async (t) => {
  const body = memeToExactSize([
    "created: 2026-07-23 00:00:00 UTC",
    "ephemeris_start: 2026-07-23 00:00:00 UTC ephemeris_stop: 2026-07-24 00:00:00 UTC step_size: 60",
    "ephemeris_source: malformed-range-test",
    "UVW",
    "2026204000000.000 7000 0 0 0 7.5 0",
    "2026204000100.000 6999 450 0 -0.5 7.48 0",
  ], 4096);
  const cases = [
    {
      name: "truncated-body",
      contentRange: `bytes 0-${body.byteLength - 1}/${body.byteLength}`,
      responseBody: body.subarray(0, body.byteLength - 1),
    },
    {
      name: "nonzero-start",
      contentRange: `bytes 1-${body.byteLength}/${body.byteLength + 1}`,
      responseBody: body,
    },
    {
      name: "trailing-garbage",
      contentRange: `bytes 0-${body.byteLength - 1}/${body.byteLength}x`,
      responseBody: body,
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async (subtest) => {
      const manifestUrl =
        `${fixtureOrigin}/starlink-malformed-range-${index}/MANIFEST.txt`;
      const ephemerisBase =
        `${fixtureOrigin}/starlink-malformed-range-${index}/`;
      const filename =
        `MEME_${42_100 + index}_STARLINK-RANGE-${index}_1_Operational_${index + 1}_UNCLASSIFIED.txt`;
      const fileUrl = joinFixtureUrl(ephemerisBase, filename);
      const opaque = createOpaqueStateAdapter();
      const fileRequests = [];
      const harness = await createHarness("starlink", (operation, params) => {
        if (operation !== "http.request") {
          return opaque.dispatch(operation, params);
        }
        if (params.url === manifestUrl) {
          return {
            status: 200,
            body: new TextEncoder().encode(`${filename}\n`),
          };
        }
        fileRequests.push(structuredClone(params));
        return {
          status: 206,
          headers: { "Content-Range": fixture.contentRange },
          body: fixture.responseBody.slice(),
        };
      });
      subtest.after(() => harness.destroy());

      const response = await harness.invoke({
        methodId: "emit",
        inputs: [configFrame({ manifestUrl, ephemerisBase })],
      });
      assert.notEqual(response.statusCode, 0);
      assert.deepEqual(response.outputs, []);
      assert.equal(fileRequests.length, 1);
      assert.equal(
        fileRequests[0].headers?.Range,
        `bytes=0-${starlinkInitialRangeBytes - 1}`,
      );
      assert.equal(
        decodeStarlinkStreamingCursor(
          opaque.getDurable("starlink.cursor.v1"),
        ).acknowledgedCount,
        0,
      );
    });
  }
});

test("Starlink safely falls back once to a complete GET after a partial data range", async (t) => {
  const manifestUrl =
    `${fixtureOrigin}/starlink-range-fallback/MANIFEST.txt`;
  const ephemerisBase =
    `${fixtureOrigin}/starlink-range-fallback/`;
  const filename =
    "MEME_25799_STARLINK-RANGE-FALLBACK_1_Operational_1_UNCLASSIFIED.txt";
  const fileUrl = joinFixtureUrl(ephemerisBase, filename);
  const body = memeToExactSize([
    "created: 2026-07-23 00:00:00 UTC",
    "ephemeris_start: 2026-07-23 00:00:00 UTC ephemeris_stop: 2026-07-24 00:00:00 UTC step_size: 60",
    "ephemeris_source: range-fallback-test",
    "UVW",
    "2026204000000.000 -2877.5 4075.1 -4706.3 -3.45 -6.03 -3.11",
    "2026204000100.000 -2878.5 4074.1 -4705.3 -3.44 -6.02 -3.10",
  ], 3 * 1024 * 1024);
  const opaque = createOpaqueStateAdapter();
  const fileRequests = [];
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation !== "http.request") {
      return opaque.dispatch(operation, params);
    }
    if (params.url === manifestUrl) {
      return {
        status: 200,
        body: new TextEncoder().encode(`${filename}\n`),
      };
    }
    assert.equal(params.url, fileUrl);
    fileRequests.push(structuredClone(params));
    if (params.headers?.Range !== undefined) {
      return {
        status: 206,
        headers: {
          "content-range":
            `bytes 0-${starlinkInitialRangeBytes - 1}/${body.byteLength}`,
        },
        body: body.subarray(0, starlinkInitialRangeBytes).slice(),
      };
    }
    return {
      status: 200,
      headers: { "Content-Length": String(body.byteLength) },
      body: body.slice(),
    };
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(fileRequests.length, 2);
  assert.equal(
    fileRequests[0].headers?.Range,
    `bytes=0-${starlinkInitialRangeBytes - 1}`,
  );
  assert.equal(fileRequests[0].max_bytes, starlinkInitialRangeBytes);
  assert.equal(fileRequests[1].headers?.Range, undefined);
  assert.equal(fileRequests[1].max_bytes, body.byteLength);
  const [stream] = starlinkOemStreams(response);
  assert.ok(stream);
  assert.deepEqual(
    Buffer.concat(stream.chunks.map(({ data }) => Buffer.from(data))),
    Buffer.from(body),
  );
  const expectedHash =
    crypto.createHash("sha256").update(body).digest("hex");
  assert.deepEqual(
    stream.chunks.map(({ sha256 }) =>
      Buffer.from(sha256).toString("hex")
    ),
    Array.from({ length: stream.chunks.length }, () => expectedHash),
  );
});

for (const [key, pluginId] of providers) {
  test(`${key} provider wrapper declares only paired canonical/aligned ports`, () => {
    const manifest = readJson(
      nodePath(key, "plugin-manifest.json"),
      `${key} provider manifest`,
    );
    assert.equal(manifest.pluginId, pluginId);
    assert.deepEqual(manifest.runtimeTargets, ["browser", "wasmedge"]);
    assert.deepEqual(manifest.invokeSurfaces, ["direct"]);
    assert.deepEqual(
      manifest.capabilities,
      key === "starlink" ? ["http", "storage_adapter"] : ["http"],
    );
    const method = manifest.methods?.find((candidate) => candidate.methodId === "emit");
    assert.ok(method, `${key} provider must expose emit`);
    assert.deepEqual(
      method.inputPorts.map((port) => port.portId),
      key === "starlink" ? ["config", "ack"] : ["config"],
    );
    assert.deepEqual(
      method.outputPorts.map((port) => port.portId),
      key === "starlink" ? ["oem", "progress"] : ["oem"],
    );
    assert.equal(
      method.inputPorts[0].required,
      false,
      `${key}.config must permit a yielded zero-input continuation`,
    );
    assert.equal(method.inputPorts[0].minStreams, 0);
    assertFsbPair(method.inputPorts[0], `${key}.config`);
    assertFsbPair(method.outputPorts[0], `${key}.oem`);
    if (key === "starlink") {
      assert.equal(method.inputPorts[1].required, false);
      assert.equal(method.inputPorts[1].minStreams, 0);
      assertFsoPair(method.inputPorts[1], `${key}.ack`);
      assert.equal(method.outputPorts[0].required, false);
      assert.equal(method.outputPorts[0].minStreams, 0);
      assertFsbPair(method.outputPorts[1], `${key}.progress`);
    }
    assert.doesNotMatch(JSON.stringify(manifest), /acceptsAnyFlatbuffer/i);
  });

  test(`${key} provider is an independently signed isomorphic artifact`, async () => {
    const artifactPath = nodePath(key, "dist/isomorphic/module.wasm");
    assert.ok(fs.existsSync(artifactPath), `${key} provider artifact is missing`);
    const publisher = readJson(
      nodePath(key, "publisher.json"),
      `${key} provider publisher`,
    );
    const bytes = new Uint8Array(fs.readFileSync(artifactPath));
    const verified = await verifyModuleArtifact(bytes, {
      trustedPublicKeys: [publisher.publicKeyHex],
      requireSignature: true,
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.signatureScope, "bundle");
    const analysis = analyzeWasmThreadFeatures(bytes);
    const expectsPthreads = key === "starlink";
    assert.equal(
      analysis.isIsomorphicPthreads,
      expectsPthreads,
      `${key} emitted an unexpected thread model`,
    );
    if (expectsPthreads) {
      assertPthreadArtifact(bytes, { source: artifactPath });
    }
    assert.equal(
      readJson(nodePath(key, "dist/isomorphic/artifact.json")).threadModel,
      expectsPthreads ? "wasi-threads" : "single-thread",
    );
    assert.doesNotMatch(Buffer.from(bytes).toString("latin1"), /celestrak/i);
  });

  test(`${key} exact artifact preserves complete provider-native responses in canonical FSB chunks`, async (t) => {
    const fixture = behaviorCases[key];
    const calls = [];
    const opaque = key === "starlink" ? createOpaqueStateAdapter() : null;
    const harness = await createHarness(key, (operation, params) => {
      if (operation === "http.request") {
        calls.push({ operation, params: structuredClone(params) });
        if (key === "starlink") {
          return serveFixtureHttp(params, fixture.responses);
        }
        const body = fixture.responses.get(params.url);
        return body
          ? { status: 200, body: new Uint8Array(body) }
          : { status: 404, body: new Uint8Array() };
      }
      assert.equal(key, "starlink", `${key} requested ${operation}`);
      return opaque.dispatch(operation, params);
    });
    t.after(() => harness.destroy());

    const invocations = [
      await harness.invoke({
        methodId: "emit",
        inputs: [configFrame(fixture.config)],
      }),
    ];
    if (key === "starlink") {
      const requestIds = starlinkOemStreams(invocations[0])
        .map(({ requestId }) => requestId);
      assert.equal(requestIds.length, fixture.units.length);
      invocations.push(await harness.invoke({
        methodId: "emit",
        inputs: requestIds.map((requestId) => ackFrame(requestId)),
      }));
      assert.deepEqual(
        invocations.map(({ backlogRemaining }) => backlogRemaining),
        [fixture.units.length, 0],
      );
      assert.deepEqual(
        invocations.map(({ yielded }) => yielded),
        [true, false],
      );
      assert.deepEqual(
        invocations.map(({ outputs }) =>
          [...new Set(outputs.map(({ portId }) => portId))]
        ),
        [
          ["oem", "progress"],
          ["progress"],
        ],
        "Starlink must stream a complete wave before awaiting FlatSQL acknowledgements",
      );
      const initialProgress = invocations[0].outputs.find(
        ({ portId }) => portId === "progress",
      );
      assert.ok(initialProgress);
      assert.deepEqual(decodeProgressDss(initialProgress), {
        status: 1,
        syncedRows: 0n,
        totalRows: BigInt(fixture.units.length),
        localRows: 0n,
        missingRows: BigInt(fixture.units.length),
        cachedBytes: 0n,
        downloadedBytes: BigInt(
          fixture.units.reduce((sum, bytes) => sum + bytes.byteLength, 0),
        ),
      });
    } else {
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].yielded, false);
      assert.equal(invocations[0].backlogRemaining, 0);
    }
    for (const response of invocations) {
      assert.equal(response.statusCode, 0, response.errorMessage);
    }
    assert.equal(
      harness.threadHost?.spawnCount() ?? 0,
      0,
      "the direct harness must select the deterministic sequential path without an owning worker broker",
    );
    assert.equal(
      calls.length,
      fixture.discoveryCalls + fixture.units.length,
    );
    for (const { params } of calls) {
      assert.equal(params.method, "GET");
      if (key === "starlink" && isStarlinkSizeProbe(params)) {
        assert.equal(
          params.headers.Range,
          `bytes=0-${starlinkInitialRangeBytes - 1}`,
        );
        assert.equal(params.max_bytes, starlinkInitialRangeBytes);
      } else {
        assert.equal(params.headers?.Range, undefined, "full fetches cannot use Range");
        assert.ok(
          params.max_bytes >= minimumFullFixtureBytes,
          "guest must request a full-response ceiling rather than a prefix window",
        );
      }
      assert.equal("concurrency" in params, false, "host must not own provider concurrency policy");
    }
    if (key === "starlink") {
      const [manifestUrl, ...fileUrls] = fixture.responses.keys();
      assert.equal(calls.filter(({ params }) => params.url === manifestUrl).length, 1);
      for (const url of fileUrls) {
        const urlCalls = calls.filter(({ params }) => params.url === url);
        assert.equal(urlCalls.length, 1, `${url} needs one bounded data Range`);
        assert.equal(urlCalls.filter(({ params }) => isStarlinkSizeProbe(params)).length, 1);
        assert.equal(urlCalls.filter(({ params }) => !isStarlinkSizeProbe(params)).length, 0);
      }
    }

    const outputs = invocations.flatMap(({ outputs: invocationOutputs }) =>
      invocationOutputs
        .filter(({ portId }) => portId === "oem")
        .map((output) => {
          assert.equal(output.wireFormat, "flatbuffer");
          assert.equal(output.typeRef?.fileIdentifier, "$FSB");
          return decodeFsb(output.payload);
        })
    );
    const requestIds = [...new Set(outputs.map((output) => output.requestId.toString()))];
    assert.equal(requestIds.length, fixture.units.length);

    for (let unitIndex = 0; unitIndex < fixture.units.length; unitIndex += 1) {
      const expected = fixture.units[unitIndex];
      assert.ok(expected.byteLength > 128 * 1024, "fixture must exceed the retired prefix window");
      if (key === "starlink") {
        assert.ok(
          expected.byteLength > 1024 * 1024,
          "Starlink fixture must cross the provider's threaded-response threshold",
        );
        assert.equal(fixture.config.fetchConcurrency, 2);
      }
      const chunks = outputs.filter(
        (output) => output.requestId.toString() === requestIds[unitIndex],
      );
      assert.equal(
        chunks.length,
        Math.ceil(expected.byteLength / fsbAlignedDataCapacity),
        "one full response must use the minimum number of bounded FSB frames",
      );
      assert.deepEqual(
        chunks.map((chunk) => chunk.chunkSequence),
        chunks.map((_, index) => index),
      );
      assert.deepEqual(
        chunks.map((chunk) => chunk.final),
        chunks.map((_, index) => index === chunks.length - 1),
      );
      for (const chunk of chunks) {
        assert.equal(chunk.totalBytes, BigInt(expected.byteLength));
        assert.equal(chunk.schemaName, fixture.metadata[unitIndex].schemaName);
        assert.equal(
          chunk.fileIdentifier,
          fixture.metadata[unitIndex].fileIdentifier,
        );
        assert.ok(
          chunk.data.byteLength > 0 &&
            chunk.data.byteLength <= fsbAlignedDataCapacity,
        );
        assert.equal(chunk.sha256.byteLength, 32);
        assert.deepEqual(
          chunk.sha256,
          new Uint8Array(crypto.createHash("sha256").update(expected).digest()),
        );
      }
      assert.deepEqual(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data))),
        Buffer.from(expected),
        "every upstream byte must survive ordered FSB chunking",
      );
      const records = chunks.reduce(
        (sum, chunk) => sum + chunk.recordCount,
        0n,
      );
      assert.equal(records, BigInt(epochCount(key, expected)));
      assert.ok(records > 1n, "fixture must prove multiple epoch-specific records");
    }
  });
}

test("Starlink bounded parallel fetch-to-OD streaming is authored in the WASM node", () => {
  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  assert.match(source, /kMaxFetchConcurrency\s*=\s*64/);
  assert.match(source, /kDefaultFetchConcurrency\s*=\s*64/);
  assert.match(source, /kDefaultBatchSize\s*=\s*64/);
  assert.match(
    source,
    /kMaxFetchWaveBytesPerInvocation\s*=\s*128ull\s*\*\s*1024\s*\*\s*1024/,
  );
  assert.match(source, /kMaxStreamingOutputFramesPerInvocation\s*=\s*256/);
  assert.match(source, /pthread_create\s*\(/);
  assert.match(source, /pthread_join\s*\(/);
  assert.match(source, /std::atomic\s*<\s*size_t\s*>/);
  assert.match(source, /fetch_concurrency/);
  assert.match(source, /download_complete_page/);
  assert.match(source, /finalize_download_admission/);
  assert.match(source, /emit_download_page\s*\(/);
  assert.match(source, /source_request_id\s*\(/);
  assert.match(source, /std::vector\s*<\s*InflightUnit\s*>\s+g_inflight/);
  assert.match(source, /storage\.adapter\.opaque\.read/);
  assert.match(source, /storage\.adapter\.opaque\.replace/);
  assert.match(source, /storage\.adapter\.opaque\.sync/);
  assert.doesNotMatch(source, /storage\.adapter\.opaque\.delete/);
  assert.doesNotMatch(source, /SLSPOOL1|Phase::kDownloading|Phase::kDraining/);
  assert.match(source, /\\"headers\\":\{\\"Range\\":\\"bytes=0-/);
  assert.match(source, /std::to_string\s*\(\s*kInitialRangeBytes\s*-\s*1\s*\)/);
});

test("Starlink confines one probe-and-GET pthread cohort to one bounded download page", () => {
  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  assert.match(source, /std::vector\s*<\s*pthread_t\s*>\s+workers/);
  assert.match(source, /pthread_create\s*\(/);
  assert.match(source, /pthread_join\s*\(/);
  assert.doesNotMatch(source, /FetchWorkerPool/);
  assert.doesNotMatch(source, /pthread_cond_/);
  assert.doesNotMatch(source, /pthread_mutex_/);
  assert.doesNotMatch(source, /pthread_(?:try|timed)join_np\s*\(/);
  assert.match(
    source,
    /kThreadBarrierTimeoutNanoseconds\s*=\s*600ull\s*\*\s*1'000'000'000ull/,
  );
  assert.doesNotMatch(source, /kThreadJoinTimeoutNanoseconds/);
  assert.match(source, /clock_gettime\s*\(\s*CLOCK_MONOTONIC/);
  assert.doesNotMatch(source, /sched_yield\s*\(/);
  assert.doesNotMatch(source, /nanosleep\s*\(/);
  assert.doesNotMatch(source, /kFetchWorkerIdleTimeoutSeconds/);
  assert.doesNotMatch(source, /retire_fetch_workers\s*\(/);
  const downloadPage = source.slice(
    source.indexOf("DownloadPage download_complete_page"),
    source.indexOf("bool meme_whitespace"),
  );
  assert.ok(downloadPage.length > 0, "missing bounded Starlink page download");
  assert.equal(
    [...downloadPage.matchAll(/pthread_create\s*\(/g)].length,
    1,
    "one page must create only one pthread cohort for probes and complete GETs",
  );
  assert.equal(
    [...source.matchAll(/pthread_join\s*\(/g)].length,
    1,
    "one page must join its single pthread cohort exactly once",
  );
  assert.match(downloadPage, /DownloadPageContext\s+context/);
  assert.match(
    downloadPage,
    /wait_for_count\s*\(context\.worker_ready_count,\s*workers\.size\(\)/,
    "the main lane must wait until every worker is parked before retirement",
  );
  assert.match(
    downloadPage,
    /context\.release_worker_count\.store\s*\(\s*index\s*\+\s*1,[\s\S]*?join_worker\s*\(workers\[index\]\)/,
    "workers must be released and joined one at a time",
  );
  assert.match(
    downloadPage,
    /for\s*\(\s*size_t\s+index\s*=\s*0;\s*index\s*<\s*workers\.size\(\);[\s\S]*?join_worker\s*\(workers\[index\]\)/,
    "every created pthread must be joined before the page invocation returns",
  );
  assert.match(
    downloadPage,
    /if\s*\(\s*!join_worker\s*\([^)]*\)\s*\)\s*\{[\s\S]*?fail_download_synchronization\s*\(\s*&context\s*\)[\s\S]*?all_workers_joined\s*=\s*false/,
    "a failed join must release the whole cohort while retaining the failure",
  );
  assert.match(
    downloadPage,
    /for\s*\([\s\S]*?join_worker\s*\(workers\[index\]\)[\s\S]*?\}\s*if\s*\(\s*!all_workers_joined\s*\)\s*\{\s*__builtin_trap\s*\(\s*\)/,
    "join failure may trap only after every created worker has been released and joined",
  );
  assert.match(
    downloadPage,
    /actionable_worker_count\s*=\s*std::max\s*\(\s*carried_count,\s*count\s*-\s*carried_count\s*\)/,
    "carried probes must reduce the steady-state runnable pthread cohort",
  );
  const tasks = source.slice(
    source.indexOf("void download_page_tasks"),
    source.indexOf("void* download_page_worker"),
  );
  assert.ok(tasks.indexOf("probe_complete_size") < tasks.indexOf("http_get_complete"));
});

test("Starlink parks barrier waiters with bounded timed atomic waits", () => {
  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  assert.match(
    source,
    /kThreadPollParkNanoseconds\s*=\s*1'000'000ll/,
    "barrier parking must use a finite one-millisecond polling bound",
  );
  const pause = source.slice(
    source.indexOf("bool thread_poll_pause()"),
    source.indexOf("\nvoid fail_download_synchronization"),
  );
  assert.ok(pause.length > 0, "missing bounded barrier parking helper");
  assert.match(pause, /__builtin_wasm_memory_atomic_wait32\s*\(/);
  assert.match(
    pause,
    /kThreadPollParkNanoseconds/,
    "the wait32 call must use the bounded timeout",
  );
  assert.doesNotMatch(pause, /sched_yield|nanosleep|pthread_cond|pthread_mutex/);
  assert.doesNotMatch(
    pause,
    /__builtin_wasm_memory_atomic_wait32\s*\([^)]*,\s*-1(?:ll)?\s*\)/,
    "barrier parking may never wait indefinitely",
  );
  for (const helper of ["wait_for_flag", "wait_for_count", "wait_for_worker_release"]) {
    const begin = source.indexOf(`bool ${helper}(`);
    const end = source.indexOf("\n}", begin);
    const implementation = source.slice(begin, end + 2);
    assert.ok(implementation.length > 0, `missing ${helper}`);
    assert.match(implementation, /deadline_expired\s*\(/);
    assert.match(implementation, /thread_poll_pause\s*\(\s*\)/);
  }
});

test("provider record counting cannot strand a one-worker pthread join", () => {
  const runtime = fs.readFileSync(
    path.join(packageRoot, "nodes/providers/common/provider_runtime.hpp"),
    "utf8",
  );
  const countRecords = runtime.slice(
    runtime.indexOf("uint64_t count_records_isomorphic"),
    runtime.indexOf("int emit_complete_response"),
  );
  assert.ok(countRecords.length > 0, "missing provider record-count helper");
  assert.doesNotMatch(countRecords, /pthread_create\s*\(/);
  assert.doesNotMatch(countRecords, /pthread_join\s*\(/);
  assert.doesNotMatch(runtime, /RecordCountTask|count_records_worker/);
  assert.match(
    countRecords,
    /return\s+counter\s*\(\s*bytes\s*\)\s*;/,
    "record counting must finish synchronously before emit releases its response bytes",
  );
});

test("production signing guard rejects development keys and accepts one release signer", async () => {
  const { resolveProviderSigning } = await import(
    "../nodes/providers/build-provider.mjs"
  );
  const developmentSigningSeed = "51".repeat(32);
  assert.throws(
    () =>
      resolveProviderSigning({
        environment: { NODE_ENV: "production" },
        developmentSigningSeed,
        defaultSigningKeyId: "supplemental-omm-starlink-provider-development",
      }),
    /SUPPLEMENTAL_OMM_SIGNING_SEED_HEX/,
  );
  assert.throws(
    () =>
      resolveProviderSigning({
        environment: {
          NODE_ENV: "production",
          SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: developmentSigningSeed,
          SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "release-provider",
        },
        developmentSigningSeed,
        defaultSigningKeyId: "supplemental-omm-starlink-provider-development",
      }),
    /development signing seed/i,
  );
  assert.deepEqual(
    resolveProviderSigning({
      environment: {
        NODE_ENV: "production",
        SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: "9a".repeat(32),
        SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "release-provider",
      },
      developmentSigningSeed,
      defaultSigningKeyId: "supplemental-omm-starlink-provider-development",
    }),
    {
      signingSeed: "9a".repeat(32),
      signingKeyId: "release-provider",
      developmentOnly: false,
    },
  );
});

test("provider wrapper package owns no local schema or Go control plane", () => {
  const providerRoot = path.join(packageRoot, "nodes/providers");
  const forbidden = [];
  if (fs.existsSync(providerRoot)) {
    const stack = [providerRoot];
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
  const packageText = fs
    .readdirSync(providerRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      fs.readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), "latin1"),
    )
    .join("\n");
  assert.doesNotMatch(packageText, /celestrak|storage_engine_link|hostcap/i);
});
