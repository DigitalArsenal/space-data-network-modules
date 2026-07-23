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
const fsbAlignedSize = 1_048_744;
const fsbAlignedDataCapacity = 1_048_576;

function nodePath(key, ...parts) {
  return path.join(packageRoot, "nodes/providers", key, ...parts);
}

function joinFixtureUrl(base, child) {
  return base.endsWith("/") ? `${base}${child}` : `${base}/${child}`;
}

function isStarlinkSizeProbe(params) {
  return params.headers?.Range === "bytes=0-0";
}

function serveFixtureHttp(params, responses) {
  const body = responses.get(params.url);
  if (!body) return { status: 404, body: new Uint8Array() };
  const bytes = new Uint8Array(body);
  if (isStarlinkSizeProbe(params)) {
    return {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-0/${bytes.byteLength}`,
        "Content-Length": "1",
      },
      body: bytes.subarray(0, 1).slice(),
    };
  }
  return {
    status: 200,
    headers: { "content-length": String(bytes.byteLength) },
    body: bytes.slice(),
  };
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

function createOpaqueStateAdapter({
  maxScopeBytes = Number.POSITIVE_INFINITY,
  maxScopeKeys = Number.POSITIVE_INFINITY,
} = {}) {
  let values = new Map();
  let durableValues = new Map();
  const calls = [];
  const failures = new Map();
  const keyFor = (params) => `${params.namespace}\0${params.key}`;
  const cloneValues = (source) =>
    new Map([...source].map(([key, value]) => [key, value.slice()]));
  const keysFrom = (source) =>
    [...source.keys()].map((key) => key.split("\0").at(-1)).sort();
  const scopeStatsFrom = (source, namespace) => {
    const prefix = `${namespace}\0`;
    let bytes = 0;
    let keys = 0;
    for (const [key, value] of source) {
      if (!key.startsWith(prefix)) continue;
      keys += 1;
      bytes += value.byteLength;
    }
    return { bytes, keys };
  };
  return {
    calls,
    keys() {
      return keysFrom(values);
    },
    durableKeys() {
      return keysFrom(durableValues);
    },
    namespaces() {
      return [...new Set([...values.keys()].map((key) => key.split("\0")[0]))]
        .sort();
    },
    scopeStats(namespace) {
      return scopeStatsFrom(values, namespace);
    },
    get(key, namespace = "primary") {
      return values.get(`${namespace}\0${key}`)?.slice();
    },
    getDurable(key, namespace = "primary") {
      return durableValues.get(`${namespace}\0${key}`)?.slice();
    },
    set(key, value, namespace = "primary") {
      const stored = new Uint8Array(value).slice();
      values.set(`${namespace}\0${key}`, stored.slice());
      durableValues.set(`${namespace}\0${key}`, stored);
    },
    deleteDurable(key, namespace = "primary") {
      values.delete(`${namespace}\0${key}`);
      durableValues.delete(`${namespace}\0${key}`);
    },
    commitVisible() {
      durableValues = cloneValues(values);
    },
    crash() {
      values = cloneValues(durableValues);
    },
    failAfter(
      operation,
      successfulCallsBeforeFailure,
      message = `injected ${operation} failure`,
    ) {
      const queued = failures.get(operation) ?? [];
      queued.push({ remaining: successfulCallsBeforeFailure, message });
      failures.set(operation, queued);
    },
    failNext(operation, message = `injected ${operation} failure`) {
      this.failAfter(operation, 0, message);
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
      const queued = failures.get(operation);
      if (queued?.length) {
        if (queued[0].remaining === 0) {
          const { message } = queued.shift();
          if (queued.length === 0) failures.delete(operation);
          throw new Error(message);
        }
        queued[0].remaining -= 1;
      }
      if (operation === "storage.adapter.opaque.read") {
        const value = values.get(keyFor(params));
        return {
          found: value !== undefined,
          bytes_b64: value?.slice() ?? new Uint8Array(),
        };
      }
      if (operation === "storage.adapter.opaque.replace") {
        assert.ok(params.data instanceof Uint8Array);
        const scoped = scopeStatsFrom(values, params.namespace);
        const existing = values.get(keyFor(params));
        const projectedBytes = scoped.bytes - (existing?.byteLength ?? 0) +
          params.data.byteLength;
        const projectedKeys = scoped.keys + (existing === undefined ? 1 : 0);
        if (projectedBytes > maxScopeBytes || projectedKeys > maxScopeKeys) {
          throw new Error(
            `opaque state scope quota exceeded: ${projectedBytes} bytes, ` +
              `${projectedKeys} keys`,
          );
        }
        values.set(keyFor(params), params.data.slice());
        return { stored_bytes: params.data.byteLength };
      }
      if (operation === "storage.adapter.opaque.delete") {
        values.delete(keyFor(params));
        return { deleted: true };
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
      if (operation === "storage.adapter.opaque.list") {
        return { keys: keysFrom(values) };
      }
      throw new Error(`unexpected opaque-state operation ${operation}`);
    },
  };
}

function dispatchOpaqueAsGoBase64(opaque, operation, params) {
  const response = opaque.dispatch(operation, params);
  if (
    operation !== "storage.adapter.opaque.read" ||
    !response.found ||
    !(response.bytes_b64 instanceof Uint8Array)
  ) {
    return response;
  }
  return {
    ...response,
    bytes_b64: Buffer.from(response.bytes_b64).toString("base64"),
  };
}

function decodeStarlinkCheckpoint(bytesLike) {
  const bytes = new Uint8Array(bytesLike ?? []);
  assert.ok(bytes.byteLength >= 153, "checkpoint is too short");
  const payloadEnd = bytes.byteLength - 32;
  assert.deepEqual(
    bytes.subarray(payloadEnd),
    new Uint8Array(crypto.createHash("sha256").update(bytes.subarray(0, payloadEnd)).digest()),
    "checkpoint checksum mismatch",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), "SLSPOOL1");
  const version = view.getUint16(8, true);
  assert.equal(version, 4);
  const phase = bytes[10];
  const flags = bytes[11];
  const unitCount = view.getUint32(12, true);
  const downloadedCount = view.getUint32(16, true);
  const drainIndex = view.getUint32(20, true);
  const downloadedBytes = view.getBigUint64(24, true);
  const objectCap = view.getUint32(32, true);
  const fetchConcurrency = view.getUint16(36, true);
  const batchSize = view.getUint16(38, true);
  const manifestUrlLength = view.getUint16(40, true);
  const ephemerisBaseLength = view.getUint16(42, true);
  const generation = bytes.subarray(44, 76).slice();
  let cursor = 76;
  const manifestUrl = new TextDecoder().decode(
    bytes.subarray(cursor, cursor + manifestUrlLength),
  );
  cursor += manifestUrlLength;
  const ephemerisBase = new TextDecoder().decode(
    bytes.subarray(cursor, cursor + ephemerisBaseLength),
  );
  cursor += ephemerisBaseLength;
  const units = [];
  for (let index = 0; index < unitCount; index += 1) {
    const headerOffset = cursor;
    const filenameLength = view.getUint16(cursor, true);
    cursor += 2;
    const byteLengthOffset = cursor;
    const byteLength = BigInt(view.getUint32(cursor, true));
    cursor += 4;
    const epochCountOffset = cursor;
    const epochCount = BigInt(view.getUint32(cursor, true));
    cursor += 4;
    const digestOffset = cursor;
    const digest = bytes.subarray(cursor, cursor + 32).slice();
    cursor += 32;
    const filenameOffset = cursor;
    const filenameCore = new TextDecoder().decode(
      bytes.subarray(cursor, cursor + filenameLength),
    );
    cursor += filenameLength;
    const filename = `MEME_${filenameCore}_UNCLASSIFIED.txt`;
    const fields = filename.split("_");
    const identity = `MEME:${fields[1]}:${fields[2]}`;
    const chunkCount = Number(
      (byteLength + BigInt(1024 * 1024) - 1n) / BigInt(1024 * 1024),
    );
    units.push({
      headerOffset,
      byteLengthOffset,
      epochCountOffset,
      digestOffset,
      filenameOffset,
      filenameLength,
      filename,
      identity,
      byteLength,
      chunkCount,
      epochCount,
      digest,
    });
  }
  assert.equal(cursor, payloadEnd, "checkpoint has trailing or truncated fields");
  return {
    bytes,
    version,
    phase,
    flags,
    cleanupPending: (flags & 1) !== 0,
    unitCount,
    downloadedCount,
    drainIndex,
    downloadedBytes,
    objectCap,
    fetchConcurrency,
    batchSize,
    manifestUrl,
    ephemerisBase,
    generation,
    units,
  };
}

function mutateCheckpoint(checkpoint, mutate) {
  const bytes = new Uint8Array(checkpoint).slice();
  const payloadEnd = bytes.byteLength - 32;
  mutate(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  bytes.set(
    new Uint8Array(
      crypto.createHash("sha256").update(bytes.subarray(0, payloadEnd)).digest(),
    ),
    payloadEnd,
  );
  return bytes;
}

function starlinkChunkNamespaceFromKey(key) {
  const match = /^catalog\.([0-9a-f]{64})\.f(\d+)\.c\d+\.bin$/.exec(key);
  assert.ok(match, `invalid Starlink chunk key ${key}`);
  return `starlink.${match[1]}.f${match[2]}`;
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

test("Starlink declares the signed 64-way opaque-spool and progress contract", () => {
  const manifest = readJson(
    nodePath("starlink", "plugin-manifest.json"),
    "Starlink provider manifest",
  );
  assert.deepEqual(manifest.capabilities, ["http", "storage_adapter"]);
  const method = manifest.methods?.find(({ methodId }) => methodId === "emit");
  assert.ok(method);
  assert.deepEqual(
    method.outputPorts.map(({ portId }) => portId),
    ["oem", "progress"],
  );
  assert.equal(method.outputPorts[0].required, false);
  assert.equal(method.outputPorts[0].minStreams, 0);
  assertFsbPair(method.outputPorts[0], "starlink.oem");
  assertFsbPair(method.outputPorts[1], "starlink.progress");
  assert.ok(
    manifest.schemasUsed?.some(
      ({ schemaName, fileIdentifier }) =>
        schemaName === "DSS.fbs" && fileIdentifier === "$DSS",
    ),
    "Starlink must declare the canonical nested DSS progress schema",
  );

  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  assert.match(source, /kMaxFetchConcurrency\s*=\s*64/);
  assert.match(source, /kDefaultFetchConcurrency\s*=\s*64/);
  assert.match(source, /kDefaultBatchSize\s*=\s*64/);
  assert.match(source, /kMaxCatalogUnits\s*=\s*100'000/);
  assert.match(source, /kMaxDurableFilesPerInvocation\s*=\s*16/);
  assert.match(source, /storage\.adapter\.opaque\.replace/);
  assert.match(source, /storage\.adapter\.opaque\.sync/);
  assert.doesNotMatch(source, /storage_engine_link|hostcap/i);
});

test("Starlink validates finite decimal ranges without libc numeric conversion", () => {
  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  const begin = source.indexOf("bool strict_finite_decimal(");
  const end = source.indexOf("\nuint32_t meme_timestamp_component(", begin);
  assert.ok(begin >= 0 && end > begin, "missing finite-decimal validator");
  const implementation = source.slice(begin, end);
  assert.doesNotMatch(
    implementation,
    /\b(?:strtod|strtof|strtold)\s*\(/,
    "MEME validation must not convert every numeric field through libc",
  );
  assert.doesNotMatch(
    implementation,
    /\b(?:double|float|long double)\b/,
    "the forwarding-only provider needs lexical range validation, not a value",
  );
  assert.doesNotMatch(
    implementation,
    /std::(?:string\b|vector\s*<)/,
    "finite-decimal validation must not allocate",
  );
});

test("Starlink finite-decimal grammar preserves normal/scientific values and rejects non-finite or out-of-range fields", async (t) => {
  const accepted = [
    "0",
    "-0.0e+9999",
    "1",
    "+1.",
    ".5",
    "-6.02214076e23",
    "2.2250738585072014e-308",
    "2.2250738585072012e-308",
    "1.7976931348623157e308",
    "1.7976931348623158e308",
  ];
  const rejected = [
    "NaN",
    "-Inf",
    ".",
    "1e",
    "1e+",
    "1.2.3",
    "--1",
    "1e-309",
    "1e309",
    "2.225073858507201e-308",
    "2.2250738585072011e-308",
    "1.797693134862316e308",
    "1.7976931348623159e308",
  ];
  for (const [index, token] of [...accepted, ...rejected].entries()) {
    const shouldAccept = index < accepted.length;
    await t.test(
      `${shouldAccept ? "accepts" : "rejects"} ${token}`,
      async (subtest) => {
        const manifestUrl =
          `${fixtureOrigin}/starlink-decimal-${index}/MANIFEST.txt`;
        const ephemerisBase =
          `${fixtureOrigin}/starlink-decimal-${index}/`;
        const filename =
          `MEME_${43000 + index}_STARLINK-DECIMAL-${index}_1_Operational_${index + 1}_UNCLASSIFIED.txt`;
        const body = new TextEncoder().encode([
          "created: 2026-07-22 00:00:00 UTC",
          "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
          "ephemeris_source: finite-decimal-test",
          "UVW",
          `2026203000000.000 ${token} 0 0 0 7.5 0`,
          "2026203000100.000 6999 450 0 -0.5 7.48 0",
        ].join("\n"));
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
        subtest.after(() => harness.destroy());
        const response = await harness.invoke({
          methodId: "emit",
          inputs: [configFrame({ manifestUrl, ephemerisBase })],
        });
        assert.equal(
          response.statusCode === 0,
          shouldAccept,
          response.errorMessage,
        );
        if (!shouldAccept) {
          assert.deepEqual(response.outputs, []);
          assert.equal(
            decodeStarlinkCheckpoint(
              opaque.getDurable("starlink.active.v1"),
            ).downloadedCount,
            0,
            "a rejected field cannot advance the durable catalog cursor",
          );
        }
      },
    );
  }
});

test("Starlink drain trusts only SHA-identical bytes from the already validated durable catalog", () => {
  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  const begin = source.indexOf("bool read_unit_body(");
  const end = source.indexOf("\nint fail_invocation(", begin);
  assert.ok(begin >= 0 && end > begin, "missing durable Starlink body reader");
  const implementation = source.slice(begin, end);
  assert.match(implementation, /\bsha256\s*\(/);
  assert.match(implementation, /std::memcmp\s*\(/);
  assert.doesNotMatch(
    implementation,
    /\bvalidate_meme_file\s*\(/,
    "a matching committed digest already establishes the exact validated bytes",
  );
});

test("Starlink bounds 64-way size preflight and fuel-safe retained download subwaves", async (t) => {
  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  assert.match(source, /kMaxStarlinkFileBytes\s*=\s*64\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /kMaxFetchWaveBytesPerInvocation\s*=\s*64ull\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /kMaxRetainedWaveBytes\s*=\s*288ull\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /kReservedTransientBytes\s*=\s*384ull\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /kWasmMemoryCeilingBytes\s*=\s*1024ull\s*\*\s*1024\s*\*\s*1024/);
  assert.match(
    source,
    /static_assert\s*\(\s*2\s*\*\s*kMaxRetainedWaveBytes\s*\+\s*kReservedTransientBytes\s*</,
  );
  assert.match(source, /probe\.byte_length\s*<=\s*kMaxFetchWaveBytesPerInvocation\s*-\s*retained_bytes/);
  assert.match(source, /download_complete_page\s*\(/);
  assert.match(source, /kMaxStorageSegments\s*=\s*1/);
  assert.match(source, /segment_count\s*>\s*kMaxStorageSegments/);

  const manifestUrl = `${fixtureOrigin}/starlink-bounds/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-bounds/`;
  const filename =
    "MEME_18001_STARLINK-BOUND_1_Operational_1_UNCLASSIFIED.txt";
  const opaque = createOpaqueStateAdapter();
  let probeMaxBytes = 0;
  let probeCalls = 0;
  let fullFetchCalls = 0;
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      if (params.url === manifestUrl) {
        return {
          status: 200,
          body: new TextEncoder().encode(`${filename}\n`),
        };
      }
      if (isStarlinkSizeProbe(params)) {
        probeCalls += 1;
        probeMaxBytes = params.max_bytes;
        return {
          status: 206,
          headers: { "Content-Range": `bytes 0-0/${64 * 1024 * 1024 + 1}` },
          body: new Uint8Array([65]),
        };
      }
      fullFetchCalls += 1;
      return { status: 500, body: new Uint8Array() };
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(probeMaxBytes, 1);
  assert.equal(probeCalls, 1);
  assert.equal(fullFetchCalls, 0);
  assert.equal(response.outputs.length, 0);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
    "the generation checkpoint must precede the first probe",
  );
  assert.deepEqual(
    opaque.durableKeys().filter((key) => key.startsWith("catalog.")),
    [],
    "an oversized advertised file must fail before a full GET or durable chunk",
  );
  assert.ok(harness.memory.buffer.byteLength < 1024 * 1024 * 1024);
});

test("Starlink owns the compact v4 per-file checkpoint and one-MiB opaque layout", () => {
  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  assert.match(source, /kCheckpointVersion\s*=\s*4/);
  assert.match(source, /kMaxCheckpointBytes\s*=\s*(?:1\s*\*\s*)?1024\s*\*\s*1024/);
  assert.match(source, /kOpaqueChunkBytes\s*=\s*1024\s*\*\s*1024/);
  assert.match(source, /kCompressedChunkMagic/);
  assert.match(source, /encode_opaque_chunk\s*\(/);
  assert.match(source, /decode_opaque_chunk\s*\(/);
  assert.match(source, /tdefl_compress_mem_to_mem\s*\(/);
  assert.match(source, /tinfl_decompress_mem_to_mem\s*\(/);
  assert.match(source, /chunk_namespace\s*\(/);
  assert.match(
    source,
    /catalog\."\s*\+\s*hex_digest\(state\.generation\)\s*\+\s*"\.f/,
  );
  assert.match(source, /filename_core\s*\(/);
  assert.match(source, /append_u32le\(&bytes,\s*static_cast<uint32_t>\(unit\.byte_length\)\)/);
  assert.match(source, /append_u32le\(&bytes,\s*static_cast<uint32_t>\(unit\.epoch_count\)\)/);
  assert.doesNotMatch(source, /append_u(?:32|64)le\(&bytes,\s*unit\.chunk_count\)/);
  assert.doesNotMatch(source, /starlink\.cursor|pack_begin|pack_offset/);
});

test("Starlink rejects overflowing or unterminated numeric config fields", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-numeric-config/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-numeric-config/`;
  const filename =
    "MEME_17001_STARLINK-NUMERIC-CONFIG_1_Operational_1_UNCLASSIFIED.txt";
  const body = new TextEncoder().encode([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: numeric-config-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ].join("\n"));
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

  const malformedConfig =
    `{"manifestUrl":${JSON.stringify(manifestUrl)},` +
    `"ephemerisBase":${JSON.stringify(ephemerisBase)},` +
    '"fetchConcurrency":18446744073709551617,' +
    '"batchSize":7oops,' +
    '"objectCap":18446744073709551617}';
  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configJsonFrame(malformedConfig)],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  const checkpoint = decodeStarlinkCheckpoint(
    opaque.getDurable("starlink.active.v1"),
  );
  assert.equal(checkpoint.fetchConcurrency, 64);
  assert.equal(checkpoint.batchSize, 64);
  assert.equal(checkpoint.objectCap, 0);
});

test("Starlink rejects any invalid size probe before every complete GET", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-invalid-late-probe/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-invalid-late-probe/`;
  const filenames = [
    "MEME_18011_STARLINK-VALID-PROBE_1_Operational_1_UNCLASSIFIED.txt",
    "MEME_18012_STARLINK-INVALID-PROBE_1_Operational_1_UNCLASSIFIED.txt",
  ];
  const opaque = createOpaqueStateAdapter();
  let fullFetchCalls = 0;
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation !== "http.request") {
      return opaque.dispatch(operation, params);
    }
    if (params.url === manifestUrl) {
      return {
        status: 200,
        body: new TextEncoder().encode(`${filenames.join("\n")}\n`),
      };
    }
    if (isStarlinkSizeProbe(params)) {
      if (params.url.endsWith(filenames[1])) {
        return { status: 206, headers: {}, body: new Uint8Array([0]) };
      }
      return {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-0/${fixtureBodies.starlinkA.byteLength}`,
        },
        body: fixtureBodies.starlinkA.subarray(0, 1),
      };
    }
    fullFetchCalls += 1;
    return { status: 200, body: fixtureBodies.starlinkA };
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase, fetchConcurrency: 2 })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(fullFetchCalls, 0);
  assert.equal(response.outputs.length, 0);
});

test("Starlink admits only one 64 MiB full GET per fuel-safe byte wave", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-large-subwave/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-large-subwave/`;
  const filenames = Array.from(
    { length: 5 },
    (_, index) =>
      `MEME_${18101 + index}_STARLINK-LARGE-${index + 1}_1_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const opaque = createOpaqueStateAdapter();
  const probeUrls = [];
  const fullUrls = [];
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation !== "http.request") {
      return opaque.dispatch(operation, params);
    }
    if (params.url === manifestUrl) {
      return {
        status: 200,
        body: new TextEncoder().encode(`${filenames.join("\n")}\n`),
      };
    }
    if (isStarlinkSizeProbe(params)) {
      probeUrls.push(params.url);
      return {
        status: 206,
        headers: { "Content-Range": `bytes 0-0/${64 * 1024 * 1024}` },
        body: new Uint8Array([65]),
      };
    }
    fullUrls.push(params.url);
    assert.equal(params.max_bytes, 64 * 1024 * 1024);
    return { status: 200, body: new Uint8Array([65]) };
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(probeUrls.length, 5, "the cheap size page retains 64-way policy");
  assert.deepEqual(
    fullUrls,
    filenames.slice(0, 1).map((filename) => joinFixtureUrl(ephemerisBase, filename)),
    "the 64 MiB fuel ceiling admits exactly one maximum-sized body",
  );
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
  );
  assert.deepEqual(
    opaque.durableKeys().filter((key) => key.startsWith("catalog.")),
    [],
  );
  assert.ok(harness.memory.buffer.byteLength < 1024 * 1024 * 1024);
});

test("Starlink preserves manifest order of latest-generation winners before object cap", async (t) => {
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
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      `ephemeris_source: ${filename}`,
      "UVW",
      "2026203000000.000 7000 0 0 0 7.5 0",
      "2026203000100.000 6999 450 0 -0.5 7.48 0",
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
      calls.push({ url: params.url, probe: isStarlinkSizeProbe(params) });
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const committed = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({
      manifestUrl,
      ephemerisBase,
      objectCap: 2,
    })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.deepEqual(decodeProgressDss(committed.outputs[0]), {
    status: 2,
    syncedRows: 2n,
    totalRows: 2n,
    localRows: 2n,
    missingRows: 0n,
    cachedBytes: BigInt(
      bodyFor(filenames.aLatest).byteLength + bodyFor(filenames.cLatest).byteLength,
    ),
    downloadedBytes: BigInt(
      bodyFor(filenames.aLatest).byteLength + bodyFor(filenames.cLatest).byteLength,
    ),
  });
  assert.deepEqual(calls.filter(({ url }) => url === manifestUrl), [
    { url: manifestUrl, probe: false },
  ]);
  const selected = [filenames.aLatest, filenames.cLatest];
  for (const filename of selected) {
    const url = joinFixtureUrl(ephemerisBase, filename);
    assert.deepEqual(calls.filter((call) => call.url === url), [
      { url, probe: true },
      { url, probe: false },
    ]);
  }
  for (const filename of manifestOrder.filter((value) => !selected.includes(value))) {
    assert.equal(
      calls.some(({ url }) => url === joinFixtureUrl(ephemerisBase, filename)),
      false,
      "objectCap must apply after latest-generation identity selection",
    );
  }

  const first = await harness.invoke({ methodId: "emit", inputs: [] });
  const second = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.deepEqual(
    [first, second].map(({ outputs }) => decodeFsb(outputs[0].payload).schemaName),
    ["MEME:41001:STARLINK-A", "MEME:41003:STARLINK-C"],
  );
});

test("Starlink checkpoint uses the exact approved durable codec and primary namespace", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-codec/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-codec/`;
  const filename =
    "MEME_42001_STARLINK-CODEC_2026203_Operational_700_UNCLASSIFIED.txt";
  const manifest = new TextEncoder().encode(`${filename}\n`);
  const body = new TextEncoder().encode([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: codec-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ].join("\n"));
  const responses = new Map([
    [manifestUrl, manifest],
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
    inputs: [configFrame({
      manifestUrl,
      ephemerisBase,
      objectCap: 17,
      fetchConcurrency: 7,
      batchSize: 5,
    })],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.ok(
    opaque.calls
      .filter(({ params }) => params.key === "starlink.active.v1")
      .every(({ params }) => params.namespace === "primary"),
    "the active checkpoint must remain in the approved primary namespace",
  );
  const checkpointBytes = opaque.get("starlink.active.v1");
  const checkpoint = decodeStarlinkCheckpoint(checkpointBytes);
  assert.equal(checkpoint.version, 4);
  assert.equal(
    checkpoint.phase,
    1,
    "final progress must remain durably replayable until a continuation proves delivery",
  );
  assert.equal(checkpoint.cleanupPending, false);
  assert.equal(checkpoint.downloadedCount, 1);
  assert.equal(checkpoint.drainIndex, 0);
  assert.equal(checkpoint.downloadedBytes, BigInt(body.byteLength));
  assert.equal(checkpoint.objectCap, 17);
  assert.equal(checkpoint.fetchConcurrency, 7);
  assert.equal(checkpoint.batchSize, 5);
  assert.equal(checkpoint.manifestUrl, manifestUrl);
  assert.equal(checkpoint.ephemerisBase, ephemerisBase);
  assert.deepEqual(
    checkpoint.generation,
    new Uint8Array(
      crypto
        .createHash("sha256")
        .update(manifest)
        .update(ephemerisBase)
        .digest(),
    ),
    "generation must hash exactly manifest bytes followed by the configured base URL",
  );
  assert.deepEqual(checkpoint.units.map(({ filename: value }) => value), [filename]);
  assert.deepEqual(checkpoint.units.map(({ identity }) => identity), [
    "MEME:42001:STARLINK-CODEC",
  ]);
  assert.equal(checkpoint.units[0].epochCount, BigInt(epochCount("starlink", body)));
  assert.equal(checkpoint.units[0].byteLength, BigInt(body.byteLength));
  assert.equal(checkpoint.units[0].chunkCount, 1);
  assert.deepEqual(
    checkpoint.units[0].digest,
    new Uint8Array(crypto.createHash("sha256").update(body).digest()),
  );
  assert.deepEqual(
    opaque.keys().filter((key) => key.startsWith("catalog.")),
    [`catalog.${Buffer.from(checkpoint.generation).toString("hex")}.f0.c0.bin`],
  );
  assert.ok(
    opaque.calls.some(
      ({ params }) =>
        params.key?.startsWith("catalog.") &&
        params.namespace ===
          `starlink.${Buffer.from(checkpoint.generation).toString("hex")}.f0`,
    ),
  );
});

test("Starlink v4 checkpoint keeps the exact 8,825-object live plan below one MiB", async (t) => {
  const manifestUrl =
    "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
  const ephemerisBase =
    "https://api.starlink.com/public-files/ephemerides/";
  // The 2026-07-22 production plan selected exactly 8,825 identities with
  // filename lengths {72: 2,605, 73: 6,140, 77: 80}. Recreate that exact
  // encoded-size profile without making the deterministic test network-bound.
  const filenames = Array.from({ length: 8_825 }, (_, index) => {
    const catalogId = 67_850 + index;
    const starlinkId = 36_840 + index;
    const finalGeneration = index < 2_605
      ? 463_017_380 + index
      : index < 8_745
        ? 1_463_017_380 + index
        : 14_630_173_800_000 + index;
    return `MEME_${catalogId}_STARLINK-${starlinkId}_${1_340_142 + index}_Operational_${finalGeneration}_UNCLASSIFIED.txt`;
  });
  const manifest = new TextEncoder().encode(`${filenames.join("\n")}\n`);
  const legacyV2Estimate =
    108 + manifestUrl.length + ephemerisBase.length +
    filenames.reduce((sum, filename) => {
      const fields = filename.split("_");
      const identity = `MEME:${fields[1]}:${fields[2]}`;
      return sum + 56 + filename.length + identity.length;
    }, 0);
  assert.ok(
    legacyV2Estimate > 1024 * 1024,
    "the exact live-shape test must exceed the retired v2 opaque-value limit",
  );

  const opaque = createOpaqueStateAdapter();
  let fileHttpCalls = 0;
  const dispatch = (operation, params) => {
    if (operation === "http.request") {
      if (params.url === manifestUrl) {
        return { status: 200, body: manifest.slice() };
      }
      fileHttpCalls += 1;
      return { status: 503, body: new Uint8Array() };
    }
    return opaque.dispatch(operation, params);
  };
  const harness = await createHarness("starlink", dispatch);
  const attempted = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  harness.destroy();
  assert.equal(attempted.statusCode, 0, attempted.errorMessage);
  assert.equal(attempted.yielded, true);
  assert.equal(attempted.outputs.length, 0);
  assert.equal(
    fileHttpCalls,
    0,
    "a production-sized manifest must durably checkpoint and yield before file probes",
  );

  const checkpointBytes = opaque.getDurable("starlink.active.v1");
  const expectedCheckpointBytes =
    76 + manifestUrl.length + ephemerisBase.length + 32 +
    filenames.reduce(
      (sum, filename) =>
        sum + 42 + filename.length - "MEME_".length - "_UNCLASSIFIED.txt".length,
      0,
    );
  assert.equal(expectedCheckpointBytes, 818_660);
  assert.equal(checkpointBytes.byteLength, expectedCheckpointBytes);
  assert.ok(checkpointBytes.byteLength <= 1024 * 1024);
  const checkpoint = decodeStarlinkCheckpoint(checkpointBytes);
  assert.equal(checkpoint.version, 4);
  assert.equal(checkpoint.unitCount, 8_825);
  assert.equal(checkpoint.downloadedCount, 0);
  assert.deepEqual(checkpoint.units.map(({ filename }) => filename), filenames);
  assert.ok(
    opaque.calls
      .filter(({ operation }) => operation === "storage.adapter.opaque.replace")
      .every(({ params }) => params.data.byteLength <= 1024 * 1024),
    "every generic opaque value must remain at or below one MiB",
  );

  const exactFileBytes = 2_045_241;
  const exactEpochCount = 4_305;
  const finalLike = mutateCheckpoint(checkpointBytes, (bytes, view) => {
    bytes[10] = 2;
    view.setUint32(16, checkpoint.unitCount, true);
    view.setUint32(20, 0, true);
    view.setBigUint64(
      24,
      BigInt(exactFileBytes) * BigInt(checkpoint.unitCount),
      true,
    );
    for (const [index, unit] of checkpoint.units.entries()) {
      view.setUint32(unit.byteLengthOffset, exactFileBytes, true);
      view.setUint32(unit.epochCountOffset, exactEpochCount, true);
      bytes.fill((index % 251) + 1, unit.digestOffset, unit.digestOffset + 32);
    }
  });
  assert.equal(finalLike.byteLength, checkpointBytes.byteLength);
  assert.ok(finalLike.byteLength <= 1024 * 1024);
  opaque.set("starlink.active.v1", finalLike);

  const resumed = await createHarness("starlink", (operation, params) => {
    assert.notEqual(operation, "http.request", "durable drain cannot refetch");
    return opaque.dispatch(operation, params);
  });
  t.after(() => resumed.destroy());
  const missingChunk = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.notEqual(missingChunk.statusCode, 0);
  assert.deepEqual(missingChunk.outputs, []);
});

test("Starlink checkpoints the full 17,650-candidate live manifest before a fuel-safe resumed wave", async (t) => {
  const manifestUrl =
    "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt";
  const ephemerisBase =
    "https://api.starlink.com/public-files/ephemerides/";
  const candidates = Array.from({ length: 8_825 }, (_, index) => {
    const catalogId = 67_850 + index;
    const starlinkId = 36_840 + index;
    const latestGeneration = 1_463_017_380 + index;
    return {
      old: `MEME_${catalogId}_STARLINK-${starlinkId}_${1_340_141 + index}_Operational_${latestGeneration - 1}_UNCLASSIFIED.txt`,
      latest: `MEME_${catalogId}_STARLINK-${starlinkId}_${1_340_142 + index}_Operational_${latestGeneration}_UNCLASSIFIED.txt`,
    };
  });
  const manifestLines = candidates.flatMap(({ old, latest }) => [old, latest]);
  assert.equal(manifestLines.length, 17_650);
  const manifest = new TextEncoder().encode(`${manifestLines.join("\n")}\n`);
  assert.ok(manifest.byteLength < 8 * 1024 * 1024);

  const opaque = createOpaqueStateAdapter();
  let manifestCalls = 0;
  let probeCalls = 0;
  let fullFetchCalls = 0;
  const initial = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      if (params.url === manifestUrl) {
        manifestCalls += 1;
        return { status: 200, body: manifest.slice() };
      }
      probeCalls += 1;
      return { status: 503, body: new Uint8Array() };
    }
    return opaque.dispatch(operation, params);
  });
  const planned = await initial.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  initial.destroy();
  assert.equal(planned.statusCode, 0, planned.errorMessage);
  assert.equal(planned.yielded, true);
  assert.equal(planned.backlogRemaining, 17_651);
  assert.deepEqual(planned.outputs, []);
  assert.equal(manifestCalls, 1);
  assert.equal(probeCalls, 0);
  assert.equal(fullFetchCalls, 0);

  const checkpointBytes = opaque.getDurable("starlink.active.v1");
  const checkpoint = decodeStarlinkCheckpoint(checkpointBytes);
  assert.equal(checkpoint.version, 4);
  assert.equal(checkpoint.unitCount, 8_825);
  assert.equal(checkpoint.downloadedCount, 0);
  assert.deepEqual(
    checkpoint.units.map(({ filename }) => filename),
    candidates.map(({ latest }) => latest),
    "each identity must retain its latest generation in latest-manifest order",
  );
  assert.deepEqual(
    checkpoint.generation,
    new Uint8Array(
      crypto
        .createHash("sha256")
        .update(manifest)
        .update(ephemerisBase)
        .digest(),
    ),
    "generation must cover every old and latest candidate byte",
  );

  const body = memeToExactSize([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: full-live-manifest-test",
    "UVW",
    "2026203000000.000 -2877.5130811997 4075.0989745008 -4706.3410523462 -3.4551274033 -6.0345187465 -3.1147385352",
    "4.5959389250e-07 -3.6857237948e-07 7.5138447296e-07 -7.6290988105e-12 1.6674071715e-10 1.1925957340e-06 8.0142362965e-10",
    "-8.7543694295e-10 -1.1494065075e-12 1.9048025297e-12 -4.5364226733e-10 3.9287303459e-10 1.4986973206e-12 -8.0112176320e-13",
    "4.9612561854e-13 1.4860258884e-13 -4.4812419975e-13 1.6101140992e-09 -2.9504360232e-16 1.6453353042e-15 5.4869916033e-12",
  ], 2_045_241);
  const resumed = await createWorkerHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      assert.notEqual(params.url, manifestUrl, "durable resume cannot refetch the manifest");
      if (isStarlinkSizeProbe(params)) {
        probeCalls += 1;
        return {
          status: 206,
          headers: { "Content-Range": `bytes 0-0/${body.byteLength}` },
          body: body.subarray(0, 1),
        };
      }
      fullFetchCalls += 1;
      return { status: 200, body };
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => resumed.destroy());

  const staged = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(staged.statusCode, 0, staged.errorMessage);
  assert.equal(staged.yielded, true);
  assert.deepEqual(staged.outputs, []);
  assert.equal(manifestCalls, 1);
  assert.equal(probeCalls, 64);
  assert.equal(fullFetchCalls, 32);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
  );

  const committed = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.deepEqual(committed.outputs.map(({ portId }) => portId), ["progress"]);
  const progress = decodeProgressDss(committed.outputs[0]);
  assert.equal(progress.status, 1);
  assert.equal(progress.syncedRows, 32n);
  assert.equal(progress.totalRows, 8_825n);
  assert.equal(manifestCalls, 1);
  assert.equal(probeCalls, 64);
  assert.equal(fullFetchCalls, 32);
});

test("Starlink reads Go-shaped base64 checkpoints and chunks at production sizes", async (t) => {
  await t.test("checkpoint metadata above 64 KiB", async () => {
    const manifestUrl = `${fixtureOrigin}/starlink-go-checkpoint/MANIFEST.txt`;
    const ephemerisBase = `${fixtureOrigin}/starlink-go-checkpoint/`;
    const filenames = Array.from(
      { length: 1000 },
      (_, index) => {
        const id = 43000 + index;
        return `MEME_${id}_STARLINK-GO-CHECKPOINT-${index + 1}_1_Operational_${index + 1}_UNCLASSIFIED.txt`;
      },
    );
    const body = new TextEncoder().encode([
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: go-checkpoint-test",
      "UVW",
      "2026203000000.000 7000 0 0 0 7.5 0",
      "2026203000100.000 6999 450 0 -0.5 7.48 0",
    ].join("\n"));
    const manifest = new TextEncoder().encode(`${filenames.join("\n")}\n`);
    const opaque = createOpaqueStateAdapter();
    const http = (params) => {
      if (params.url === manifestUrl) {
        return { status: 200, body: manifest.slice() };
      }
      if (!params.url.startsWith(ephemerisBase)) {
        return { status: 404, body: new Uint8Array() };
      }
      if (isStarlinkSizeProbe(params)) {
        return {
          status: 206,
          headers: { "Content-Range": `bytes 0-0/${body.byteLength}` },
          body: body.subarray(0, 1).slice(),
        };
      }
      return { status: 200, body: body.slice() };
    };
    const source = await createHarness("starlink", (operation, params) =>
      operation === "http.request"
        ? http(params)
        : opaque.dispatch(operation, params)
    );
    const first = await source.invoke({
      methodId: "emit",
      inputs: [configFrame({
        manifestUrl,
        ephemerisBase,
        fetchConcurrency: 1,
        batchSize: 1,
      })],
    });
    source.destroy();
    assert.equal(first.statusCode, 0, first.errorMessage);
    assert.equal(decodeProgressDss(first.outputs[0]).syncedRows, 1n);
    const checkpoint = opaque.getDurable("starlink.active.v1");
    assert.ok(checkpoint.byteLength > 64 * 1024);

    const resumed = await createHarness("starlink", (operation, params) =>
      operation === "http.request"
        ? http(params)
        : dispatchOpaqueAsGoBase64(opaque, operation, params)
    );
    const replayed = await resumed.invoke({ methodId: "emit", inputs: [] });
    assert.equal(replayed.statusCode, 0, replayed.errorMessage);
    assert.equal(decodeProgressDss(replayed.outputs[0]).syncedRows, 1n);
    const second = await resumed.invoke({ methodId: "emit", inputs: [] });
    resumed.destroy();
    assert.equal(second.statusCode, 0, second.errorMessage);
    assert.equal(decodeProgressDss(second.outputs[0]).syncedRows, 2n);
  });

  await t.test("one-MiB opaque chunk metadata", async () => {
    const manifestUrl = `${fixtureOrigin}/starlink-go-chunk/MANIFEST.txt`;
    const ephemerisBase = `${fixtureOrigin}/starlink-go-chunk/`;
    const filename =
      "MEME_44001_STARLINK-GO-CHUNK_1_Operational_1_UNCLASSIFIED.txt";
    const body = repeatToSize([
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: go-chunk-test",
      "UVW",
      "2026203000000.000 7000 0 0 0 7.5 0",
      "1.0e-4 0 0",
      "2026203000100.000 6999 450 0 -0.5 7.48 0",
    ], 1024 * 1024 + 17);
    const responses = new Map([
      [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
      [joinFixtureUrl(ephemerisBase, filename), body],
    ]);
    const opaque = createOpaqueStateAdapter();
    const initial = await createHarness("starlink", (operation, params) =>
      operation === "http.request"
        ? serveFixtureHttp(params, responses)
        : opaque.dispatch(operation, params)
    );
    const committed = await initial.invoke({
      methodId: "emit",
      inputs: [configFrame({ manifestUrl, ephemerisBase })],
    });
    initial.destroy();
    assert.equal(committed.statusCode, 0, committed.errorMessage);

    const resumed = await createHarness("starlink", (operation, params) => {
      assert.notEqual(operation, "http.request", "durable drain cannot refetch");
      return dispatchOpaqueAsGoBase64(opaque, operation, params);
    });
    const replayedProgress = await resumed.invoke({ methodId: "emit", inputs: [] });
    assert.equal(replayedProgress.statusCode, 0, replayedProgress.errorMessage);
    assert.deepEqual(replayedProgress.outputs.map(({ portId }) => portId), ["progress"]);
    const drained = await resumed.invoke({ methodId: "emit", inputs: [] });
    resumed.destroy();
    assert.equal(drained.statusCode, 0, drained.errorMessage);
    assert.deepEqual(
      Buffer.concat(
        drained.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data)),
      ),
      Buffer.from(body),
    );
  });
});

test("Starlink rejects a wrapped binary segment index in opaque metadata", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-bin-index/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-bin-index/`;
  const filename =
    "MEME_17101_STARLINK-BIN-INDEX_1_Operational_1_UNCLASSIFIED.txt";
  const body = new TextEncoder().encode([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: bin-index-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ].join("\n"));
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
    [joinFixtureUrl(ephemerisBase, filename), body],
  ]);
  const opaque = createOpaqueStateAdapter();
  const source = await createHarness("starlink", (operation, params) =>
    operation === "http.request"
      ? serveFixtureHttp(params, responses)
      : opaque.dispatch(operation, params)
  );
  const committed = await source.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  source.destroy();
  const checkpoint = opaque.getDurable("starlink.active.v1");

  const corrupted = await createHarness("starlink", (operation, params) => {
    if (operation === "storage.adapter.opaque.read") {
      return {
        found: true,
        bytes_b64: { $bin: 4_294_967_296 },
        decoy: checkpoint,
      };
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => corrupted.destroy());
  const rejected = await corrupted.invoke({ methodId: "emit", inputs: [] });
  assert.notEqual(rejected.statusCode, 0);
  assert.deepEqual(rejected.outputs, []);
});

test("Starlink rejects malformed HTTP 200 MEME bodies before durable writes", async (t) => {
  const cases = new Map([
    ["html", "<html><body>upstream error</body></html>"],
    ["missing required headers", [
      "UVW",
      "2026203000000.000 7000 0 0 0 7.5 0",
    ].join("\n")],
    ["fake epoch", [
      "created:2026-07-22 00:00:00 UTC",
      "ephemeris_start:2026-07-22 00:00:00 UTC ephemeris_stop:2026-07-23 00:00:00 UTC step_size:60",
      "ephemeris_source:blend",
      "UVW",
      "1234567890123 not-ephemeris",
    ].join("\n")],
    ["non-finite state", [
      "created:2026-07-22 00:00:00 UTC",
      "ephemeris_start:2026-07-22 00:00:00 UTC ephemeris_stop:2026-07-23 00:00:00 UTC step_size:60",
      "ephemeris_source:blend",
      "UVW",
      "2026203000000.000 7000 0 0 0 NaN 0",
    ].join("\n")],
    ["overflow state", [
      "created:2026-07-22 00:00:00 UTC",
      "ephemeris_start:2026-07-22 00:00:00 UTC ephemeris_stop:2026-07-23 00:00:00 UTC step_size:60",
      "ephemeris_source:blend",
      "UVW",
      "2026203000000.000 7000 0 0 0 1e999 0",
    ].join("\n")],
    ["invalid timestamp", [
      "created:2026-07-22 00:00:00 UTC",
      "ephemeris_start:2026-07-22 00:00:00 UTC ephemeris_stop:2026-07-23 00:00:00 UTC step_size:60",
      "ephemeris_source:blend",
      "UVW",
      "2026367000000.000 7000 0 0 0 7.5 0",
    ].join("\n")],
    ["nonnumeric covariance", [
      "created:2026-07-22 00:00:00 UTC",
      "ephemeris_start:2026-07-22 00:00:00 UTC ephemeris_stop:2026-07-23 00:00:00 UTC step_size:60",
      "ephemeris_source:blend",
      "UVW",
      "2026203000000.000 7000 0 0 0 7.5 0",
      "covariance unavailable",
    ].join("\n")],
  ]);
  for (const [name, bodyText] of cases) {
    await t.test(name, async () => {
      const manifestUrl = `${fixtureOrigin}/starlink-non-meme-${name}/MANIFEST.txt`;
      const ephemerisBase = `${fixtureOrigin}/starlink-non-meme-${name}/`;
      const filename =
        "MEME_42002_STARLINK-NON-MEME_2026203_Operational_701_UNCLASSIFIED.txt";
      const responses = new Map([
        [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
        [joinFixtureUrl(ephemerisBase, filename), new TextEncoder().encode(bodyText)],
      ]);
      const opaque = createOpaqueStateAdapter();
      const harness = await createHarness("starlink", (operation, params) =>
        operation === "http.request"
          ? serveFixtureHttp(params, responses)
          : opaque.dispatch(operation, params)
      );
      const response = await harness.invoke({
        methodId: "emit",
        inputs: [configFrame({ manifestUrl, ephemerisBase })],
      });
      harness.destroy();
      assert.notEqual(response.statusCode, 0);
      assert.deepEqual(response.outputs, []);
      const checkpoint = decodeStarlinkCheckpoint(
        opaque.getDurable("starlink.active.v1"),
      );
      assert.equal(checkpoint.phase, 1);
      assert.equal(checkpoint.downloadedCount, 0);
      assert.equal(checkpoint.downloadedBytes, 0n);
      assert.deepEqual(
        opaque.durableKeys().filter((key) => key.startsWith("catalog.")),
        [],
        "invalid provider bytes cannot reach the durable chunk catalog",
      );
    });
  }
});

test("Starlink validates and emits the tracked byte-exact real MEME fixture", async (t) => {
  const benchmarkFixture = process.env.SDN_STARLINK_BENCH_FIXTURE;
  const filename = benchmarkFixture
    ? path.basename(benchmarkFixture)
    : "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt";
  const fixturePath = benchmarkFixture ?? path.join(
    packageRoot,
    "../../data-source/spacex-starlink-source/test/fixtures/meme",
    filename,
  );
  const body = new Uint8Array(fs.readFileSync(fixturePath));
  const expected = benchmarkFixture
    ? {
        byteLength: 2_042_795,
        sha256: "c8d775f52efc51972ab2c1295b0fa63f46d74ebe9814057c7140ed92f5136dd4",
        epochs: 4321,
      }
    : {
        byteLength: 5847,
        sha256: "42615f12fee9be8072907fa0968871d6d60ef10678fa3d12dee994468c682db0",
        epochs: 12,
      };
  assert.equal(body.byteLength, expected.byteLength);
  assert.equal(
    crypto.createHash("sha256").update(body).digest("hex"),
    expected.sha256,
  );
  assert.equal(epochCount("starlink", body), expected.epochs);
  const manifestUrl = `${fixtureOrigin}/starlink-real-meme/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-real-meme/`;
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

  const stageStartedAt = performance.now();
  const committed = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.equal(decodeProgressDss(committed.outputs[0]).status, 2);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .units[0].epochCount,
    BigInt(expected.epochs),
  );
  const stagedAt = performance.now();
  const emitted = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(emitted.statusCode, 0, emitted.errorMessage);
  const chunks = emitted.outputs.map(({ payload }) => decodeFsb(payload));
  assert.equal(
    chunks.reduce((sum, chunk) => sum + chunk.recordCount, 0n),
    BigInt(expected.epochs),
  );
  assert.deepEqual(
    Buffer.concat(chunks.map(({ data }) => Buffer.from(data))),
    Buffer.from(body),
  );
  if (benchmarkFixture) {
    t.diagnostic(
      `${body.byteLength} bytes / ${expected.epochs} epochs: ` +
        `${(stagedAt - stageStartedAt).toFixed(1)} ms stage, ` +
        `${(performance.now() - stagedAt).toFixed(1)} ms drain, ` +
        `${harness.memory.buffer.byteLength} bytes monotonic WASM memory`,
    );
  }
});

test("Starlink rejects overlong identities instead of truncating them into collisions", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-long-identity/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-long-identity/`;
  const sharedPrefix = "STARLINK-" + "X".repeat(70);
  const filenames = [
    `MEME_42003_${sharedPrefix}A_2026203_Operational_702_UNCLASSIFIED.txt`,
    `MEME_42003_${sharedPrefix}B_2026203_Operational_703_UNCLASSIFIED.txt`,
  ];
  const opaque = createOpaqueStateAdapter();
  let httpCalls = 0;
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      httpCalls += 1;
      if (params.url === manifestUrl) {
        return {
          status: 200,
          body: new TextEncoder().encode(`${filenames.join("\n")}\n`),
        };
      }
      return { status: 200, body: new Uint8Array([1]) };
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.equal(httpCalls, 1, "rejected identities cannot be fetched");
  assert.deepEqual(
    opaque.calls.map(({ operation }) => operation),
    ["storage.adapter.opaque.read"],
  );
  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  assert.doesNotMatch(source, /identity\.resize\s*\(/);
});

test("Starlink rejects an unencodable zero-download checkpoint before file HTTP or storage", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-checkpoint-bound/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-checkpoint-bound/`;
  const filenames = Array.from(
    { length: 60_000 },
    (_, index) => {
      const catalogId = String(500_000 + index);
      return `MEME_${catalogId}_STARLINK-${catalogId}_2026203_Operational_${catalogId}_UNCLASSIFIED.txt`;
    },
  );
  const manifest = new TextEncoder().encode(`${filenames.join("\n")}\n`);
  assert.ok(manifest.byteLength < 8 * 1024 * 1024);
  const opaque = createOpaqueStateAdapter();
  const httpCalls = [];
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      httpCalls.push(structuredClone(params));
      if (params.url === manifestUrl) {
        return { status: 200, body: manifest.slice() };
      }
      return {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/128" },
        body: new Uint8Array([65]),
      };
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.deepEqual(response.outputs, []);
  assert.deepEqual(
    httpCalls.map(({ url }) => url),
    [manifestUrl],
    "checkpoint capacity must be proven before the first file size probe",
  );
  assert.deepEqual(
    opaque.calls.filter(({ operation }) =>
      operation !== "storage.adapter.opaque.read"
    ),
    [],
    "an unencodable catalog cannot write opaque chunks or a checkpoint",
  );
  assert.deepEqual(opaque.keys(), []);
});

test("Starlink scopes browser lowercase Content-Range lookup to result headers", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-browser-range/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-browser-range/`;
  const filename =
    "MEME_42005_STARLINK-BROWSER-RANGE_2026203_Operational_705_UNCLASSIFIED.txt";
  const body = new TextEncoder().encode([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: browser-range-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ].join("\n"));
  const fileUrl = joinFixtureUrl(ephemerisBase, filename);
  const opaque = createOpaqueStateAdapter();
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
    if (params.url !== fileUrl) {
      return { status: 404, body: new Uint8Array() };
    }
    if (isStarlinkSizeProbe(params)) {
      return {
        "Content-Range": "bytes 0-0/67108865",
        status: 206,
        headers: { "content-range": `bytes 0-0/${body.byteLength}` },
        body: body.subarray(0, 1).slice(),
      };
    }
    return { status: 200, body: body.slice() };
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(decodeProgressDss(response.outputs[0]).downloadedBytes, BigInt(body.byteLength));
});

test("Starlink emits aligned FSB progress with one exact canonical DSS", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-aligned-progress/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-aligned-progress/`;
  const filename =
    "MEME_42004_STARLINK-ALIGNED_2026203_Operational_704_UNCLASSIFIED.txt";
  const body = new TextEncoder().encode([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: aligned-progress-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ].join("\n"));
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
    inputs: [configFrame({ manifestUrl, ephemerisBase }, "aligned-binary")],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "progress");
  assert.equal(response.outputs[0].wireFormat, "aligned-binary");
  assert.equal(response.outputs[0].typeRef?.byteLength, fsbAlignedSize);
  assert.equal(response.outputs[0].typeRef?.requiredAlignment, 8);
  const envelope = decodeAlignedFsb(response.outputs[0].payload);
  assert.equal(envelope.schemaName, "DSS.fbs");
  assert.equal(envelope.fileIdentifier, "$DSS");
  assert.equal(envelope.final, true);
  assert.equal(envelope.recordCount, 1n);
  const view = new DataView(
    envelope.data.buffer,
    envelope.data.byteOffset,
    envelope.data.byteLength,
  );
  assert.equal(view.getUint32(0, true) + 4, envelope.data.byteLength);
  assert.equal(new TextDecoder().decode(envelope.data.subarray(8, 12)), "$DSS");
  const dss = DSS.getSizePrefixedRootAsDSS(new ByteBuffer(envelope.data));
  assert.equal(dss.STATUS(), 2);
  assert.equal(dss.SYNCED_ROWS(), 1n);
  assert.equal(dss.TOTAL_ROWS(), 1n);
  assert.equal(dss.CACHED_BYTES(), BigInt(body.byteLength));
});

test("Starlink durably downloads the whole manifest before storage-only ordered drain", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-spool/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-spool/`;
  const filenames = Array.from(
    { length: 5 },
    (_, index) =>
      `MEME_${19001 + index}_STARLINK-SPOOL-${index + 1}_${index + 1}_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const bodies = filenames.map((_, index) =>
    repeatToSize([
      `created: 2026-07-22 0${index}:00:00 UTC`,
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: durable-spool-test",
      "UVW",
      `2026203000000.000 ${7000 + index} 0 0 0 7.5 0`,
      "1.0e-4 0 0",
      `2026203000100.000 ${6999 + index} 450 0 -0.5 7.48 0`,
    ],
    256 * 1024 + index * 1024),
  );
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      bodies[index],
    ]),
  ]);
  const opaque = createOpaqueStateAdapter();
  const httpCalls = [];
  const dispatch = (operation, params) => {
    if (operation === "http.request") {
      httpCalls.push({ url: params.url, probe: isStarlinkSizeProbe(params) });
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  };

  const source = await createHarness("starlink", dispatch);
  const first = await source.invoke({
    methodId: "emit",
    inputs: [
      configFrame({
        manifestUrl,
        ephemerisBase,
        fetchConcurrency: 4,
        batchSize: 4,
      }),
    ],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.deepEqual(first.outputs.map(({ portId }) => portId), ["progress"]);
  assert.deepEqual(decodeProgressDss(first.outputs[0]), {
    status: 1,
    syncedRows: 4n,
    totalRows: 5n,
    localRows: 4n,
    missingRows: 1n,
    cachedBytes: BigInt(
      bodies.slice(0, 4).reduce((sum, body) => sum + body.byteLength, 0),
    ),
    downloadedBytes: BigInt(
      bodies.slice(0, 4).reduce((sum, body) => sum + body.byteLength, 0),
    ),
  });

  const committed = await source.invoke({ methodId: "emit", inputs: [] });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.deepEqual(committed.outputs.map(({ portId }) => portId), ["progress"]);
  assert.deepEqual(decodeProgressDss(committed.outputs[0]), {
    status: 2,
    syncedRows: 5n,
    totalRows: 5n,
    localRows: 5n,
    missingRows: 0n,
    cachedBytes: BigInt(
      bodies.reduce((sum, body) => sum + body.byteLength, 0),
    ),
    downloadedBytes: BigInt(
      bodies.reduce((sum, body) => sum + body.byteLength, 0),
    ),
  });
  assert.equal(
    httpCalls.filter(({ url, probe }) => url !== manifestUrl && !probe).length,
    filenames.length,
    "the complete catalog must be fetched before any OEM output",
  );
  assert.equal(
    httpCalls.filter(({ url, probe }) => url !== manifestUrl && probe).length,
    filenames.length,
    "every complete fetch must have an exact size preflight",
  );
  assert.ok(
    opaque.calls.some(
      ({ operation }) => operation === "storage.adapter.opaque.replace",
    ),
  );
  assert.ok(
    opaque.calls.some(
      ({ operation }) => operation === "storage.adapter.opaque.sync",
    ),
  );
  source.destroy();

  const httpCallsBeforeRestart = httpCalls.length;
  const resumed = await createHarness("starlink", dispatch);
  t.after(() => resumed.destroy());
  const replayedProgress = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(replayedProgress.statusCode, 0, replayedProgress.errorMessage);
  assert.deepEqual(replayedProgress.outputs.map(({ portId }) => portId), ["progress"]);
  assert.equal(decodeProgressDss(replayedProgress.outputs[0]).status, 2);
  assert.equal(
    httpCalls.length,
    httpCallsBeforeRestart,
    "final progress replay must use only the durable checkpoint",
  );
  const drained = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(drained.statusCode, 0, drained.errorMessage);
  assert.ok(drained.outputs.length > 0);
  assert.ok(drained.outputs.every(({ portId }) => portId === "oem"));
  assert.equal(httpCalls.length, httpCallsBeforeRestart, "drain must not refetch");
  const chunks = drained.outputs.map(({ payload }) => decodeFsb(payload));
  assert.deepEqual(
    Buffer.concat(chunks.map(({ data }) => Buffer.from(data))),
    Buffer.from(bodies[0]),
  );
});

test("Starlink fresh instance replays the last emitted file before advancing the durable drain cursor", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-crash-window/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-crash-window/`;
  const filenames = [
    "MEME_19401_STARLINK-CRASH-1_1_Operational_1_UNCLASSIFIED.txt",
    "MEME_19402_STARLINK-CRASH-2_2_Operational_2_UNCLASSIFIED.txt",
  ];
  const bodies = filenames.map((_, index) =>
    repeatToSize([
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: crash-window-test",
      "UVW",
      `2026203000000.000 ${7000 + index} 0 0 0 7.5 0`,
      `2026203000100.000 ${6999 + index} 450 0 -0.5 7.48 0`,
    ], 32 * 1024),
  );
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      bodies[index],
    ]),
  ]);
  const opaque = createOpaqueStateAdapter();
  const dispatch = (operation, params) => {
    if (operation === "http.request") {
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  };

  const source = await createHarness("starlink", dispatch);
  const committed = await source.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  const emitted = await source.invoke({ methodId: "emit", inputs: [] });
  assert.equal(emitted.statusCode, 0, emitted.errorMessage);
  assert.deepEqual(
    Buffer.concat(
      emitted.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data)),
    ),
    Buffer.from(bodies[0]),
  );
  assert.deepEqual(
    {
      drainIndex: decodeStarlinkCheckpoint(
        opaque.getDurable("starlink.active.v1"),
      ).drainIndex,
      cleanupPending: decodeStarlinkCheckpoint(
        opaque.getDurable("starlink.active.v1"),
      ).cleanupPending,
    },
    { drainIndex: 0, cleanupPending: false },
    "emitting cannot advance durable state before the host serializes the output",
  );

  // Model a crash after the handler emitted into guest output memory but before
  // the host could durably serialize and route that response. The committed
  // cursor must still name object zero, so a fresh exact instance replays it.
  source.destroy();
  const resumed = await createHarness("starlink", dispatch);
  t.after(() => resumed.destroy());
  const replay = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(replay.statusCode, 0, replay.errorMessage);
  assert.deepEqual(
    Buffer.concat(
      replay.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data)),
    ),
    Buffer.from(bodies[0]),
  );
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1")).drainIndex,
    0,
  );

  const next = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(next.statusCode, 0, next.errorMessage);
  assert.deepEqual(
    Buffer.concat(
      next.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data)),
    ),
    Buffer.from(bodies[1]),
  );
  assert.deepEqual(
    {
      drainIndex: decodeStarlinkCheckpoint(
        opaque.getDurable("starlink.active.v1"),
      ).drainIndex,
      cleanupPending: decodeStarlinkCheckpoint(
        opaque.getDurable("starlink.active.v1"),
      ).cleanupPending,
    },
    { drainIndex: 1, cleanupPending: true },
    "the acknowledged cursor is durable while idempotent cleanup remains replayable",
  );
});

test("Starlink resumes idempotently after a partially durable cleanup", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-partial-cleanup/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-partial-cleanup/`;
  const filenames = [
    "MEME_19403_STARLINK-CLEANUP-CRASH-1_1_Operational_1_UNCLASSIFIED.txt",
    "MEME_19404_STARLINK-CLEANUP-CRASH-2_2_Operational_2_UNCLASSIFIED.txt",
  ];
  const bodies = [
    repeatToSize([
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: partial-cleanup-test-0",
      "UVW",
      "2026203000000.000 7000 0 0 0 7.5 0",
      "2026203000100.000 6999 450 0 -0.5 7.48 0",
    ], 1024 * 1024 + 17),
    repeatToSize([
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: partial-cleanup-test-1",
      "UVW",
      "2026203000000.000 7100 0 0 0 7.4 0",
      "2026203000100.000 7099 440 0 -0.5 7.39 0",
    ], 32 * 1024),
  ];
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      bodies[index],
    ]),
  ]);
  const opaque = createOpaqueStateAdapter();
  const dispatch = (operation, params) =>
    operation === "http.request"
      ? serveFixtureHttp(params, responses)
      : opaque.dispatch(operation, params);
  const source = await createHarness("starlink", dispatch);
  const committed = await source.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  const first = await source.invoke({ methodId: "emit", inputs: [] });
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.deepEqual(
    Buffer.concat(first.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data))),
    Buffer.from(bodies[0]),
  );

  opaque.failAfter("storage.adapter.opaque.delete", 1);
  const interrupted = await source.invoke({ methodId: "emit", inputs: [] });
  source.destroy();
  assert.notEqual(interrupted.statusCode, 0);
  assert.deepEqual(interrupted.outputs, []);
  const pending = decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"));
  assert.deepEqual(
    { drainIndex: pending.drainIndex, cleanupPending: pending.cleanupPending },
    { drainIndex: 1, cleanupPending: true },
  );

  // A datastore implementation may make an individual Delete durable even
  // when the following namespace Sync fails. Preserve that worst-case partial
  // effect, then restart; cleanup must tolerate the missing first chunk.
  opaque.commitVisible();
  opaque.crash();
  const resumed = await createHarness("starlink", dispatch);
  t.after(() => resumed.destroy());
  const second = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(second.statusCode, 0, second.errorMessage);
  assert.deepEqual(
    Buffer.concat(second.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data))),
    Buffer.from(bodies[1]),
  );
  const reconciled = decodeStarlinkCheckpoint(
    opaque.getDurable("starlink.active.v1"),
  );
  assert.deepEqual(
    { drainIndex: reconciled.drainIndex, cleanupPending: reconciled.cleanupPending },
    { drainIndex: 1, cleanupPending: true },
    "restart cleanup stays durably replayable until the next acknowledged cursor",
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

test("Starlink fresh instance resumes only the undownloaded suffix before drain", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-resume/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-resume/`;
  const filenames = Array.from(
    { length: 6 },
    (_, index) =>
      `MEME_${19501 + index}_STARLINK-RESUME-${index + 1}_${index + 1}_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const bodies = filenames.map((_, index) =>
    repeatToSize([
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: restart-resume-test",
      "UVW",
      `2026203000000.000 ${7000 + index} 0 0 0 7.5 0`,
      `2026203000100.000 ${6999 + index} 450 0 -0.5 7.48 0`,
    ], 32 * 1024),
  );
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      bodies[index],
    ]),
  ]);
  const opaque = createOpaqueStateAdapter();
  const httpCalls = [];
  const dispatch = (operation, params) => {
    if (operation === "http.request") {
      httpCalls.push({ url: params.url, probe: isStarlinkSizeProbe(params) });
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  };

  const first = await createHarness("starlink", dispatch);
  const partial = await first.invoke({
    methodId: "emit",
    inputs: [
      configFrame({
        manifestUrl,
        ephemerisBase,
        fetchConcurrency: 4,
        batchSize: 4,
      }),
    ],
  });
  assert.equal(partial.statusCode, 0, partial.errorMessage);
  assert.equal(decodeProgressDss(partial.outputs[0]).status, 1);
  first.destroy();
  assert.ok(opaque.get("starlink.active.v1")?.byteLength > 0);

  const resumed = await createHarness("starlink", dispatch);
  const replayed = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(replayed.statusCode, 0, replayed.errorMessage);
  assert.deepEqual(decodeProgressDss(replayed.outputs[0]), {
    status: 1,
    syncedRows: 4n,
    totalRows: 6n,
    localRows: 4n,
    missingRows: 2n,
    cachedBytes: BigInt(bodies.slice(0, 4).reduce((sum, body) => sum + body.byteLength, 0)),
    downloadedBytes: BigInt(
      bodies.slice(0, 4).reduce((sum, body) => sum + body.byteLength, 0),
    ),
  });
  const completed = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(completed.statusCode, 0, completed.errorMessage);
  assert.deepEqual(decodeProgressDss(completed.outputs[0]), {
    status: 2,
    syncedRows: 6n,
    totalRows: 6n,
    localRows: 6n,
    missingRows: 0n,
    cachedBytes: BigInt(bodies.reduce((sum, body) => sum + body.byteLength, 0)),
    downloadedBytes: BigInt(
      bodies.reduce((sum, body) => sum + body.byteLength, 0),
    ),
  });
  resumed.destroy();
  assert.deepEqual(httpCalls.filter(({ url }) => url === manifestUrl), [
    { url: manifestUrl, probe: false },
  ]);
  for (const [index, filename] of filenames.entries()) {
    const url = joinFixtureUrl(ephemerisBase, filename);
    assert.deepEqual(
      httpCalls.filter((call) => call.url === url),
      [
        { url, probe: true },
        { url, probe: false },
      ],
      `resume must not refetch committed object ${index}`,
    );
  }

  const beforeDrainHttp = httpCalls.length;
  const drain = await createHarness("starlink", dispatch);
  t.after(() => drain.destroy());
  const replayedProgress = await drain.invoke({ methodId: "emit", inputs: [] });
  assert.equal(replayedProgress.statusCode, 0, replayedProgress.errorMessage);
  assert.deepEqual(replayedProgress.outputs.map(({ portId }) => portId), ["progress"]);
  assert.equal(decodeProgressDss(replayedProgress.outputs[0]).status, 2);
  assert.equal(httpCalls.length, beforeDrainHttp);
  const firstObject = await drain.invoke({ methodId: "emit", inputs: [] });
  assert.equal(firstObject.statusCode, 0, firstObject.errorMessage);
  assert.ok(firstObject.outputs.every(({ portId }) => portId === "oem"));
  assert.equal(httpCalls.length, beforeDrainHttp);
  assert.deepEqual(
    Buffer.concat(
      firstObject.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data)),
    ),
    Buffer.from(bodies[0]),
  );
});

test("Starlink replays non-final committed progress after output loss before the next HTTP wave", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-progress-replay/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-progress-replay/`;
  const filenames = Array.from(
    { length: 3 },
    (_, index) =>
      `MEME_${19520 + index}_STARLINK-PROGRESS-${index + 1}_1_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const bodies = filenames.map((_, index) =>
    repeatToSize([
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: progress-replay-test",
      "UVW",
      `2026203000000.000 ${7000 + index} 0 0 0 7.5 0`,
      `2026203000100.000 ${6999 + index} 450 0 -0.5 7.48 0`,
    ], 32 * 1024),
  );
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      bodies[index],
    ]),
  ]);
  const opaque = createOpaqueStateAdapter();
  const httpCalls = [];
  const dispatch = (operation, params) => {
    if (operation === "http.request") {
      httpCalls.push({ url: params.url, probe: isStarlinkSizeProbe(params) });
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  };
  const source = await createHarness("starlink", dispatch);
  const committed = await source.invoke({
    methodId: "emit",
    inputs: [configFrame({
      manifestUrl,
      ephemerisBase,
      fetchConcurrency: 2,
      batchSize: 2,
    })],
  });
  source.destroy();
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.equal(decodeProgressDss(committed.outputs[0]).syncedRows, 2n);

  // Model a failed output push / host crash before the committed snapshot was
  // serialized. A fresh instance must replay rows=2 without probing row 3.
  const callsBeforeReplay = httpCalls.length;
  const resumed = await createHarness("starlink", dispatch);
  t.after(() => resumed.destroy());
  const replayed = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(replayed.statusCode, 0, replayed.errorMessage);
  assert.deepEqual(replayed.outputs.map(({ portId }) => portId), ["progress"]);
  assert.deepEqual(decodeProgressDss(replayed.outputs[0]), {
    status: 1,
    syncedRows: 2n,
    totalRows: 3n,
    localRows: 2n,
    missingRows: 1n,
    cachedBytes: BigInt(bodies[0].byteLength + bodies[1].byteLength),
    downloadedBytes: BigInt(bodies[0].byteLength + bodies[1].byteLength),
  });
  assert.equal(
    httpCalls.length,
    callsBeforeReplay,
    "progress replay must happen before any suffix probe or full GET",
  );

  const completed = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(completed.statusCode, 0, completed.errorMessage);
  assert.equal(decodeProgressDss(completed.outputs[0]).status, 2);
  assert.equal(decodeProgressDss(completed.outputs[0]).syncedRows, 3n);
});

test("Starlink chunks deterministically and retains each emitted file until the next invocation", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-cleanup/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-cleanup/`;
  const filenames = [
    "MEME_19601_STARLINK-CLEANUP-1_1_Operational_1_UNCLASSIFIED.txt",
    "MEME_19602_STARLINK-CLEANUP-2_2_Operational_2_UNCLASSIFIED.txt",
  ];
  const bodies = filenames.map((_, index) =>
    memeToExactSize([
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: cleanup-test",
      "UVW",
      `2026203000000.000 ${7000 + index} 0 0 0 7.5 0`,
      `2026203000100.000 ${6999 + index} 450 0 -0.5 7.48 0`,
    ], 1024 * 1024 + 17),
  );
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      bodies[index],
    ]),
  ]);
  const opaque = createOpaqueStateAdapter();
  const dispatch = (operation, params) => {
    if (operation === "http.request") {
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  };
  const harness = await createHarness("starlink", dispatch);
  t.after(() => harness.destroy());

  const committed = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.deepEqual(committed.outputs.map(({ portId }) => portId), ["progress"]);
  const chunkKeys = opaque
    .keys()
    .filter((key) => key.startsWith("catalog."));
  assert.equal(chunkKeys.length, 4);
  assert.ok(
    chunkKeys.every((key) =>
      /^catalog\.[0-9a-f]{64}\.f[01]\.c[01]\.bin$/.test(key),
    ),
  );
  for (const key of chunkKeys) {
    const stored = opaque.get(key, starlinkChunkNamespaceFromKey(key));
    assert.ok(
      stored.byteLength <= 1024 * 1024,
    );
    if (/\.c0\.bin$/.test(key)) {
      assert.equal(
        new TextDecoder().decode(stored.subarray(0, 8)),
        "SLCMP001",
        "compressible full-size chunks must use the versioned WASM-owned frame",
      );
      assert.equal(
        new DataView(stored.buffer, stored.byteOffset).getUint32(8, true),
        1024 * 1024,
      );
      assert.equal(
        new DataView(stored.buffer, stored.byteOffset).getUint32(12, true),
        stored.byteLength - 16,
      );
      assert.ok(stored.byteLength < 1024 * 1024);
    } else {
      assert.equal(
        stored.byteLength,
        17,
        "a non-beneficial tiny chunk must retain the exact raw fallback",
      );
    }
  }
  assert.ok(
    chunkKeys.reduce(
      (sum, key) =>
        sum + opaque.get(key, starlinkChunkNamespaceFromKey(key)).byteLength,
      0,
    ) < bodies.reduce((sum, body) => sum + body.byteLength, 0) / 2,
    "WASM-owned compression must materially reduce opaque payload bytes",
  );
  const commitOperations = opaque.calls.map(({ operation, params }) => [
    operation,
    params.key ?? null,
  ]);
  assert.deepEqual(commitOperations.slice(-3), [
    ["storage.adapter.opaque.sync", null],
    ["storage.adapter.opaque.replace", "starlink.active.v1"],
    ["storage.adapter.opaque.sync", null],
  ]);

  const first = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.ok(first.outputs.every(({ portId }) => portId === "oem"));
  assert.equal(
    opaque.keys().filter((key) => /\.f0\./.test(key)).length,
    2,
    "object zero remains durable until the next invocation",
  );
  const checkpointWritesBeforeAcknowledgement = opaque.calls.filter(
    ({ operation, params }) =>
      operation === "storage.adapter.opaque.replace" &&
      params.namespace === "primary" &&
      params.key === "starlink.active.v1",
  ).length;

  const second = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(second.statusCode, 0, second.errorMessage);
  assert.equal(
    opaque.calls.filter(
      ({ operation, params }) =>
        operation === "storage.adapter.opaque.replace" &&
        params.namespace === "primary" &&
        params.key === "starlink.active.v1",
    ).length - checkpointWritesBeforeAcknowledgement,
    1,
    "one acknowledgement must write one checkpoint, not a redundant cleanup-complete checkpoint",
  );
  assert.equal(
    opaque.keys().filter((key) => /\.f0\./.test(key)).length,
    0,
  );
  assert.equal(
    opaque.keys().filter((key) => /\.f1\./.test(key)).length,
    2,
    "the last emitted object remains for the cleanup continuation",
  );
  assert.equal(second.yielded, true);

  const cleanup = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(cleanup.statusCode, 0, cleanup.errorMessage);
  assert.deepEqual(cleanup.outputs, []);
  assert.equal(cleanup.yielded, false);
  assert.equal(cleanup.backlogRemaining, 0);
  assert.deepEqual(opaque.keys(), []);
});

test("Starlink rejects checkpoint corruption, chunk truncation, and chunk hash corruption", async (t) => {
  const cases = ["checkpoint", "truncated-chunk", "hash-mismatch"];
  for (const corruption of cases) {
    await t.test(corruption, async () => {
      const manifestUrl = `${fixtureOrigin}/starlink-corrupt-${corruption}/MANIFEST.txt`;
      const ephemerisBase = `${fixtureOrigin}/starlink-corrupt-${corruption}/`;
      const filename =
        "MEME_19701_STARLINK-CORRUPT_1_Operational_1_UNCLASSIFIED.txt";
      const body = repeatToSize([
        "created: 2026-07-22 00:00:00 UTC",
        "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
        "ephemeris_source: corruption-test",
        "UVW",
        "2026203000000.000 7000 0 0 0 7.5 0",
        "2026203000100.000 6999 450 0 -0.5 7.48 0",
      ], 64 * 1024);
      const responses = new Map([
        [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
        [joinFixtureUrl(ephemerisBase, filename), body],
      ]);
      const opaque = createOpaqueStateAdapter();
      let httpCalls = 0;
      const dispatch = (operation, params) => {
        if (operation === "http.request") {
          httpCalls += 1;
          return serveFixtureHttp(params, responses);
        }
        return opaque.dispatch(operation, params);
      };
      const source = await createHarness("starlink", dispatch);
      const committed = await source.invoke({
        methodId: "emit",
        inputs: [configFrame({ manifestUrl, ephemerisBase })],
      });
      assert.equal(committed.statusCode, 0, committed.errorMessage);
      source.destroy();
      if (corruption === "checkpoint") {
        const checkpoint = opaque.get("starlink.active.v1");
        checkpoint[12] ^= 0xff;
        opaque.set("starlink.active.v1", checkpoint);
      } else {
        const key = opaque.keys().find((candidate) => /\.f0\.c0\.bin$/.test(candidate));
        const namespace = starlinkChunkNamespaceFromKey(key);
        const chunk = opaque.get(key, namespace);
        if (corruption === "truncated-chunk") {
          opaque.set(key, chunk.subarray(0, chunk.byteLength - 1), namespace);
        } else {
          chunk[0] ^= 0xff;
          opaque.set(key, chunk, namespace);
        }
      }
      const callsBeforeRead = httpCalls;
      const resumed = await createHarness("starlink", dispatch);
      let response = await resumed.invoke({ methodId: "emit", inputs: [] });
      if (corruption !== "checkpoint") {
        assert.equal(response.statusCode, 0, response.errorMessage);
        assert.deepEqual(response.outputs.map(({ portId }) => portId), ["progress"]);
        assert.equal(decodeProgressDss(response.outputs[0]).status, 2);
        response = await resumed.invoke({ methodId: "emit", inputs: [] });
      }
      resumed.destroy();
      assert.notEqual(response.statusCode, 0);
      assert.deepEqual(response.outputs, []);
      assert.equal(httpCalls, callsBeforeRead);
    });
  }
});

test("Starlink fails closed on an exact nth chunk read and safely replays from the durable cursor", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-nth-read/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-nth-read/`;
  const filename =
    "MEME_19705_STARLINK-NTH-READ_1_Operational_1_UNCLASSIFIED.txt";
  const body = repeatToSize([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: nth-read-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "1.0e-4 0 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ], 1024 * 1024 + 17);
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
    [joinFixtureUrl(ephemerisBase, filename), body],
  ]);
  const opaque = createOpaqueStateAdapter();
  const dispatch = (operation, params) =>
    operation === "http.request"
      ? serveFixtureHttp(params, responses)
      : opaque.dispatch(operation, params);
  const source = await createHarness("starlink", dispatch);
  const committed = await source.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.equal(decodeProgressDss(committed.outputs[0]).status, 2);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .units[0].chunkCount,
    2,
  );

  const callsBeforeDrain = opaque.calls.length;
  opaque.failAfter("storage.adapter.opaque.read", 1);
  const interrupted = await source.invoke({ methodId: "emit", inputs: [] });
  source.destroy();
  assert.notEqual(interrupted.statusCode, 0);
  assert.deepEqual(interrupted.outputs, []);
  assert.deepEqual(
    opaque.calls
      .slice(callsBeforeDrain)
      .filter(({ operation }) => operation === "storage.adapter.opaque.read")
      .map(({ params }) => params.key),
    [
      opaque.keys().find((key) => /\.f0\.c0\.bin$/.test(key)),
      opaque.keys().find((key) => /\.f0\.c1\.bin$/.test(key)),
    ],
  );
  const cursor = decodeStarlinkCheckpoint(
    opaque.getDurable("starlink.active.v1"),
  );
  assert.equal(cursor.phase, 2);
  assert.equal(cursor.drainIndex, 0);
  assert.equal(cursor.cleanupPending, false);

  const resumed = await createHarness("starlink", dispatch);
  t.after(() => resumed.destroy());
  const replay = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(replay.statusCode, 0, replay.errorMessage);
  assert.ok(replay.outputs.every(({ portId }) => portId === "oem"));
  assert.deepEqual(
    Buffer.concat(
      replay.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data)),
    ),
    Buffer.from(body),
  );
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1")).drainIndex,
    0,
  );
});

test("Starlink rejects checksum-valid structural checkpoint mutations", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-structural-checkpoint/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-structural-checkpoint/`;
  const filenames = [
    "MEME_19702_STARLINK-STRUCTURAL-A_1_Operational_1_UNCLASSIFIED.txt",
    "MEME_19702_STARLINK-STRUCTURAL-B_1_Operational_1_UNCLASSIFIED.txt",
  ];
  const body = repeatToSize([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: structural-checkpoint-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ], 32 * 1024);
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename) => [joinFixtureUrl(ephemerisBase, filename), body]),
  ]);
  const opaque = createOpaqueStateAdapter();
  let httpCalls = 0;
  const dispatch = (operation, params) => {
    if (operation === "http.request") {
      httpCalls += 1;
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  };
  const source = await createHarness("starlink", dispatch);
  const committed = await source.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  source.destroy();
  const valid = opaque.get("starlink.active.v1");
  const decoded = decodeStarlinkCheckpoint(valid);
  const cases = [
    ["unknown flags", (bytes) => { bytes[11] = 0x80; }],
    ["download cursor", (_bytes, view) => {
      view.setUint32(16, decoded.unitCount + 1, true);
    }],
    ["cleanup without advanced cursor", (bytes, view) => {
      bytes[11] = 1;
      view.setUint32(20, 0, true);
    }],
    ["missing manifest URL", (_bytes, view) => {
      view.setUint16(40, 0, true);
    }],
    ["zero epoch count", (_bytes, view) => {
      view.setUint32(decoded.units[0].epochCountOffset, 0, true);
    }],
    ["non-reconstructable chunk layout", (_bytes, view) => {
      view.setUint32(
        decoded.units[0].byteLengthOffset,
        64 * 1024 * 1024 + 1,
        true,
      );
    }],
    ["truncated filename core", (_bytes, view) => {
      view.setUint16(decoded.units[0].headerOffset, 0xffff, true);
    }],
    ["path-bearing filename core", (bytes) => {
      bytes[decoded.units[0].filenameOffset] = "/".charCodeAt(0);
    }],
    ["duplicate identity", (bytes) => {
      assert.equal(
        decoded.units[0].filenameLength,
        decoded.units[1].filenameLength,
      );
      bytes.copyWithin(
        decoded.units[1].filenameOffset,
        decoded.units[0].filenameOffset,
        decoded.units[0].filenameOffset + decoded.units[0].filenameLength,
      );
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      opaque.set("starlink.active.v1", mutateCheckpoint(valid, mutate));
      const before = httpCalls;
      const resumed = await createHarness("starlink", dispatch);
      const response = await resumed.invoke({ methodId: "emit", inputs: [] });
      resumed.destroy();
      assert.notEqual(response.statusCode, 0);
      assert.deepEqual(response.outputs, []);
      assert.equal(httpCalls, before);
    });
  }
});

test("Starlink download transaction fails closed at every exact commit boundary", async (t) => {
  const cases = [
    "http",
    "chunk-replace",
    "pre-checkpoint-sync",
    "checkpoint-replace",
    "post-checkpoint-sync",
  ];
  for (const failure of cases) {
    await t.test(failure, async () => {
      const manifestUrl = `${fixtureOrigin}/starlink-commit-${failure}/MANIFEST.txt`;
      const ephemerisBase = `${fixtureOrigin}/starlink-commit-${failure}/`;
      const filename =
        "MEME_19703_STARLINK-COMMIT_1_Operational_1_UNCLASSIFIED.txt";
      const body = repeatToSize([
        "created: 2026-07-22 00:00:00 UTC",
        "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
        "ephemeris_source: exact-commit-failure-test",
        "UVW",
        "2026203000000.000 7000 0 0 0 7.5 0",
        "2026203000100.000 6999 450 0 -0.5 7.48 0",
      ], 1024 * 1024 + 17);
      const responses = new Map([
        [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
        [joinFixtureUrl(ephemerisBase, filename), body],
      ]);
      const opaque = createOpaqueStateAdapter();
      let failureArmed = false;
      let manifestFetches = 0;
      const dispatch = (operation, params) => {
        if (operation === "http.request") {
          if (params.url === manifestUrl) manifestFetches += 1;
          if (params.url !== manifestUrl && !isStarlinkSizeProbe(params) &&
              !failureArmed) {
            failureArmed = true;
            if (failure === "http") {
              return { status: 503, body: new Uint8Array() };
            }
            if (failure === "chunk-replace") {
              opaque.failNext("storage.adapter.opaque.replace");
            } else if (failure === "pre-checkpoint-sync") {
              opaque.failNext("storage.adapter.opaque.sync");
            } else if (failure === "checkpoint-replace") {
              opaque.failAfter("storage.adapter.opaque.replace", 2);
            } else if (failure === "post-checkpoint-sync") {
              opaque.failAfter("storage.adapter.opaque.sync", 1);
            }
          }
          return serveFixtureHttp(params, responses);
        }
        return opaque.dispatch(operation, params);
      };
      const source = await createHarness("starlink", dispatch);
      const response = await source.invoke({
        methodId: "emit",
        inputs: [configFrame({ manifestUrl, ephemerisBase })],
      });
      source.destroy();
      assert.notEqual(response.statusCode, 0);
      assert.deepEqual(response.outputs, []);

      const storageCalls = opaque.calls.filter(({ operation }) =>
        operation.startsWith("storage.adapter.opaque.")
      );
      const replaceCalls = storageCalls.filter(
        ({ operation }) => operation === "storage.adapter.opaque.replace",
      );
      const syncCalls = storageCalls.filter(
        ({ operation }) => operation === "storage.adapter.opaque.sync",
      );
      const checkpointReplaces = replaceCalls.filter(
        ({ params }) => params.key === "starlink.active.v1",
      );
      if (failure === "http") {
        assert.equal(replaceCalls.length, 1);
        assert.equal(syncCalls.length, 1);
        assert.equal(checkpointReplaces.length, 1);
      } else if (failure === "chunk-replace") {
        assert.equal(replaceCalls.length, 2);
        assert.equal(syncCalls.length, 1);
        assert.equal(checkpointReplaces.length, 1);
      } else if (failure === "pre-checkpoint-sync") {
        assert.equal(replaceCalls.length, 3);
        assert.equal(syncCalls.length, 2);
        assert.equal(checkpointReplaces.length, 1);
      } else if (failure === "checkpoint-replace") {
        assert.equal(replaceCalls.length, 4);
        assert.equal(syncCalls.length, 2);
        assert.equal(checkpointReplaces.length, 2);
      } else {
        assert.equal(replaceCalls.length, 4);
        assert.equal(syncCalls.length, 3);
        assert.equal(checkpointReplaces.length, 2);
      }

      const durableZero = decodeStarlinkCheckpoint(
        opaque.getDurable("starlink.active.v1"),
      );
      assert.equal(durableZero.phase, 1);
      assert.equal(durableZero.downloadedCount, 0);
      assert.equal(durableZero.downloadedBytes, 0n);

      if (failure === "post-checkpoint-sync") {
        opaque.failNext("storage.adapter.opaque.sync");
        const visibleRetry = await createHarness("starlink", dispatch);
        const rejectedVisibleCheckpoint = await visibleRetry.invoke({
          methodId: "emit",
          inputs: [],
        });
        visibleRetry.destroy();
        assert.notEqual(rejectedVisibleCheckpoint.statusCode, 0);
        assert.deepEqual(rejectedVisibleCheckpoint.outputs, []);
      }

      opaque.crash();
      assert.equal(
        decodeStarlinkCheckpoint(opaque.get("starlink.active.v1"))
          .downloadedCount,
        0,
        "every failed first wave must retain its generation checkpoint",
      );
      if (failure === "checkpoint-replace" || failure === "post-checkpoint-sync") {
        assert.equal(
          opaque.durableKeys().filter((key) => key.startsWith("catalog.")).length,
          2,
          "synced chunks remain reachable through the zero-download generation",
        );
      } else {
        assert.deepEqual(
          opaque.durableKeys().filter((key) => key.startsWith("catalog.")),
          [],
        );
      }

      const recovered = await createHarness("starlink", dispatch);
      const recoveredResponse = await recovered.invoke({
        methodId: "emit",
        inputs: [],
      });
      recovered.destroy();
      assert.equal(recoveredResponse.statusCode, 0, recoveredResponse.errorMessage);
      assert.equal(decodeProgressDss(recoveredResponse.outputs[0]).status, 2);
      assert.equal(
        decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
          .downloadedCount,
        1,
      );
      assert.equal(manifestFetches, 1, "recovery must not refetch the manifest");
    });
  }
});

test("Starlink fails closed for opaque read, replace, sync, and delete failures", async (t) => {
  const operations = [
    "storage.adapter.opaque.read",
    "storage.adapter.opaque.replace",
    "storage.adapter.opaque.sync",
    "storage.adapter.opaque.delete",
  ];
  for (const failedOperation of operations) {
    await t.test(failedOperation, async () => {
      const manifestUrl = `${fixtureOrigin}/starlink-storage-fail-${failedOperation}/MANIFEST.txt`;
      const ephemerisBase = `${fixtureOrigin}/starlink-storage-fail-${failedOperation}/`;
      const filename =
        "MEME_19801_STARLINK-STORAGE-FAIL_1_Operational_1_UNCLASSIFIED.txt";
      const body = repeatToSize([
        "created: 2026-07-22 00:00:00 UTC",
        "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
        "ephemeris_source: storage-failure-test",
        "UVW",
        "2026203000000.000 7000 0 0 0 7.5 0",
        "2026203000100.000 6999 450 0 -0.5 7.48 0",
      ], 32 * 1024);
      const responses = new Map([
        [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
        [joinFixtureUrl(ephemerisBase, filename), body],
      ]);
      const opaque = createOpaqueStateAdapter();
      const dispatch = (operation, params) => {
        if (operation === "http.request") {
          return serveFixtureHttp(params, responses);
        }
        return opaque.dispatch(operation, params);
      };

      if (failedOperation === "storage.adapter.opaque.read") {
        opaque.failNext(failedOperation);
        const source = await createHarness("starlink", dispatch);
        const failed = await source.invoke({
          methodId: "emit",
          inputs: [configFrame({ manifestUrl, ephemerisBase })],
        });
        source.destroy();
        assert.notEqual(failed.statusCode, 0);
        assert.deepEqual(failed.outputs, []);
        return;
      }

      if (failedOperation === "storage.adapter.opaque.replace" ||
          failedOperation === "storage.adapter.opaque.sync") {
        opaque.failNext(failedOperation);
        const source = await createHarness("starlink", dispatch);
        const failed = await source.invoke({
          methodId: "emit",
          inputs: [configFrame({ manifestUrl, ephemerisBase })],
        });
        source.destroy();
        assert.notEqual(failed.statusCode, 0);
        assert.deepEqual(failed.outputs, []);
        return;
      }

      const source = await createHarness("starlink", dispatch);
      const committed = await source.invoke({
        methodId: "emit",
        inputs: [configFrame({ manifestUrl, ephemerisBase })],
      });
      assert.equal(committed.statusCode, 0, committed.errorMessage);
      const drained = await source.invoke({ methodId: "emit", inputs: [] });
      assert.equal(drained.statusCode, 0, drained.errorMessage);
      opaque.failNext(failedOperation);
      const failed = await source.invoke({ methodId: "emit", inputs: [] });
      source.destroy();
      assert.notEqual(failed.statusCode, 0);
      assert.deepEqual(failed.outputs, []);
    });
  }
});

test("Starlink preserves bounded sanitized host storage failure details", async (t) => {
  for (const failedOperation of [
    "storage.adapter.opaque.read",
    "storage.adapter.opaque.replace",
    "storage.adapter.opaque.sync",
  ]) {
    await t.test(failedOperation, async () => {
      const manifestUrl = `${fixtureOrigin}/starlink-storage-detail-${failedOperation}/MANIFEST.txt`;
      const ephemerisBase = `${fixtureOrigin}/starlink-storage-detail-${failedOperation}/`;
      const filename =
        "MEME_19851_STARLINK-STORAGE-DETAIL_1_Operational_1_UNCLASSIFIED.txt";
      const body = new TextEncoder().encode([
        "created: 2026-07-22 00:00:00 UTC",
        "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
        "ephemeris_source: storage-detail-test",
        "UVW",
        "2026203000000.000 7000 0 0 0 7.5 0",
        "2026203000100.000 6999 450 0 -0.5 7.48 0",
      ].join("\n"));
      const responses = new Map([
        [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
        [joinFixtureUrl(ephemerisBase, filename), body],
      ]);
      const opaque = createOpaqueStateAdapter();
      const marker = `host quota exceeded for ${failedOperation}`;
      opaque.failNext(
        failedOperation,
        `${marker}\n\u007f${"x".repeat(800)}`,
      );
      const harness = await createHarness("starlink", (operation, params) =>
        operation === "http.request"
          ? serveFixtureHttp(params, responses)
          : opaque.dispatch(operation, params)
      );
      const failed = await harness.invoke({
        methodId: "emit",
        inputs: [configFrame({ manifestUrl, ephemerisBase })],
      });
      harness.destroy();
      assert.notEqual(failed.statusCode, 0);
      assert.match(failed.errorMessage, new RegExp(marker.replaceAll(".", "\\.")));
      assert.doesNotMatch(failed.errorMessage, /[\u0000-\u001f\u007f]/);
      assert.ok(failed.errorMessage.length <= 640);
    });
  }
});

test("Starlink drain checkpoint failure permits only the current object to replay", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-replay/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-replay/`;
  const filenames = [
    "MEME_19901_STARLINK-REPLAY-1_1_Operational_1_UNCLASSIFIED.txt",
    "MEME_19902_STARLINK-REPLAY-2_2_Operational_2_UNCLASSIFIED.txt",
  ];
  const bodies = filenames.map((_, index) =>
    repeatToSize([
      "created: 2026-07-22 00:00:00 UTC",
      "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
      "ephemeris_source: replay-test",
      "UVW",
      `2026203000000.000 ${7000 + index} 0 0 0 7.5 0`,
      `2026203000100.000 ${6999 + index} 450 0 -0.5 7.48 0`,
    ], 32 * 1024),
  );
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      bodies[index],
    ]),
  ]);
  const opaque = createOpaqueStateAdapter();
  const dispatch = (operation, params) => {
    if (operation === "http.request") {
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  };
  const source = await createHarness("starlink", dispatch);
  const committed = await source.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  const emitted = await source.invoke({ methodId: "emit", inputs: [] });
  assert.equal(emitted.statusCode, 0, emitted.errorMessage);
  assert.deepEqual(
    Buffer.concat(emitted.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data))),
    Buffer.from(bodies[0]),
  );
  opaque.failNext("storage.adapter.opaque.replace");
  const uncertain = await source.invoke({ methodId: "emit", inputs: [] });
  assert.notEqual(uncertain.statusCode, 0);
  assert.deepEqual(uncertain.outputs, []);
  source.destroy();

  const resumed = await createHarness("starlink", dispatch);
  t.after(() => resumed.destroy());
  const replay = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(replay.statusCode, 0, replay.errorMessage);
  assert.deepEqual(
    Buffer.concat(replay.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data))),
    Buffer.from(bodies[0]),
  );
  const next = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(next.statusCode, 0, next.errorMessage);
  assert.deepEqual(
    Buffer.concat(next.outputs.map(({ payload }) => Buffer.from(decodeFsb(payload).data))),
    Buffer.from(bodies[1]),
  );
});

test("Starlink emits progress-only download waves before ordered yielded drain", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-continuation/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-continuation/`;
  const filenames = Array.from(
    { length: 5 },
    (_, index) =>
      `MEME_${20001 + index}_STARLINK-${index + 1}_${index + 1}_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const units = filenames.map((filename, index) => ({
    filename,
    identity: `MEME:${20001 + index}:STARLINK-${index + 1}`,
    body: repeatToSize([
      `created: 2026-07-21 0${index}:00:00 UTC`,
      "ephemeris_start: 2026-07-21 00:00:00 UTC ephemeris_stop: 2026-07-22 00:00:00 UTC step_size: 60",
      "ephemeris_source: continuation-test",
      "UVW",
      `20262020${index}0000.000 ${7000 + index} 0 0 0 7.5 0`,
      "1.0e-4 0 0",
      `20262020${index}0100.000 ${6999 + index} 450 0 -0.5 7.48 0`,
    ]),
  }));
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...units.map((unit) => [joinFixtureUrl(ephemerisBase, unit.filename), unit.body]),
  ]);
  const calls = [];
  const opaque = createOpaqueStateAdapter();
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      calls.push({ url: params.url, probe: isStarlinkSizeProbe(params) });
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const invocations = [];
  for (let index = 0; index < filenames.length * 2 + 2; index += 1) {
    const response = await harness.invoke({
      methodId: "emit",
      inputs:
        index === 0
          ? [
              configFrame({
                manifestUrl,
                ephemerisBase,
                fetchConcurrency: 2,
                batchSize: 2,
              }),
            ]
          : [],
    });
    invocations.push(response);
    if (!response.yielded) break;
  }
  for (const response of invocations) {
    assert.equal(response.statusCode, 0, response.errorMessage);
  }
  assert.deepEqual(
    invocations.map(({ yielded }) => yielded),
    [true, true, true, true, true, true, true, true, false],
  );
  assert.deepEqual(
    invocations.map(({ backlogRemaining }) => backlogRemaining),
    [9, 7, 6, 5, 4, 3, 2, 1, 0],
  );
  assert.deepEqual(
    invocations.map(({ outputs }) => [...new Set(outputs.map(({ portId }) => portId))]),
    [
      ["progress"],
      ["progress"],
      ["progress"],
      ["oem"],
      ["oem"],
      ["oem"],
      ["oem"],
      ["oem"],
      [],
    ],
  );
  assert.deepEqual(
    invocations.slice(0, 3).map(({ outputs }) => decodeProgressDss(outputs[0]).status),
    [1, 1, 2],
  );
  assert.deepEqual(calls.filter(({ url }) => url === manifestUrl), [
    { url: manifestUrl, probe: false },
  ]);
  for (const unit of units) {
    const url = joinFixtureUrl(ephemerisBase, unit.filename);
    assert.deepEqual(
      calls.filter((call) => call.url === url),
      [
        { url, probe: true },
        { url, probe: false },
      ],
      `${unit.filename} must be fetched exactly once`,
    );
  }

  const decoded = invocations.flatMap(({ outputs }) =>
    outputs
      .filter(({ portId }) => portId === "oem")
      .map((output) => decodeFsb(output.payload)),
  );
  for (const unit of units) {
    const chunks = decoded.filter((output) => output.schemaName === unit.identity);
    assert.equal(
      chunks.length,
      Math.ceil(unit.body.byteLength / fsbAlignedDataCapacity),
      `${unit.identity} must retain its complete response in bounded frames`,
    );
    assert.deepEqual(
      chunks.map((chunk) => chunk.chunkSequence),
      chunks.map((_, index) => index),
    );
    assert.equal(chunks.at(-1).final, true);
    assert.deepEqual(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data))),
      Buffer.from(unit.body),
    );
  }
  assert.equal(new Set(decoded.map((output) => output.schemaName)).size, units.length);
});

test("Starlink exact artifact downloads a complete 64-file page before the remainder", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-default-width/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-default-width/`;
  const filenames = Array.from(
    { length: 65 },
    (_, index) =>
      `MEME_${25001 + index}_STARLINK-${index + 1}_${index + 1}_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      new TextEncoder().encode([
        `created: 2026-07-21 0${index}:00:00 UTC`,
        "ephemeris_start: 2026-07-21 00:00:00 UTC ephemeris_stop: 2026-07-22 00:00:00 UTC step_size: 60",
        "ephemeris_source: default-width-test",
        "UVW",
        `2026202000000.000 ${7000 + index} 0 0 0 7.5 0`,
        "1.0e-4 0 0",
        `2026202000100.000 ${6999 + index} 450 0 -0.5 7.48 0`,
      ].join("\n")),
    ]),
  ]);
  const calls = [];
  const opaque = createOpaqueStateAdapter();
  let probeCalls = 0;
  let fullFetchCalls = 0;
  const harness = await createWorkerHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      calls.push({ url: params.url, probe: isStarlinkSizeProbe(params) });
      if (params.url === manifestUrl) {
        return serveFixtureHttp(params, responses);
      }
      if (isStarlinkSizeProbe(params)) {
        probeCalls += 1;
        return serveFixtureHttp(params, responses);
      }
      fullFetchCalls += 1;
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.deepEqual(first.outputs, []);
  assert.equal(first.yielded, true);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
  );
  assert.equal(probeCalls, 64);
  assert.equal(fullFetchCalls, 64);

  for (const provisionalCount of [32, 48]) {
    const continuation = await harness.invoke({ methodId: "emit", inputs: [] });
    assert.equal(continuation.statusCode, 0, continuation.errorMessage);
    assert.deepEqual(continuation.outputs, []);
    assert.equal(continuation.yielded, true);
    assert.equal(
      decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
        .downloadedCount,
      0,
      `${provisionalCount} staged files cannot advance the durable cursor`,
    );
    assert.equal(probeCalls, 64);
    assert.equal(fullFetchCalls, 64);
  }

  const committedWave = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(committedWave.statusCode, 0, committedWave.errorMessage);
  assert.deepEqual(committedWave.outputs.map(({ portId }) => portId), ["progress"]);
  assert.equal(decodeProgressDss(committedWave.outputs[0]).syncedRows, 64n);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    64,
  );
  assert.equal(probeCalls, 64);
  assert.equal(fullFetchCalls, 64);

  const final = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(final.statusCode, 0, final.errorMessage);
  assert.deepEqual(final.outputs.map(({ portId }) => portId), ["progress"]);
  assert.equal(decodeProgressDss(final.outputs[0]).status, 2);
  assert.equal(decodeProgressDss(final.outputs[0]).syncedRows, 65n);
  assert.equal(probeCalls, 65);
  assert.equal(fullFetchCalls, 65);
  assert.deepEqual(calls.filter(({ url }) => url === manifestUrl), [
    { url: manifestUrl, probe: false },
  ]);
  for (const filename of filenames) {
    const url = joinFixtureUrl(ephemerisBase, filename);
    assert.deepEqual(
      calls.filter((call) => call.url === url),
      [
        { url, probe: true },
        { url, probe: false },
      ],
      `${filename} must be fetched exactly once`,
    );
  }
});

test("Starlink crosses one size-preflight barrier before its complete GET wave", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-one-cohort/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-one-cohort/`;
  const filenames = Array.from(
    { length: 8 },
    (_, index) =>
      `MEME_${30501 + index}_STARLINK-ONE-COHORT-${index + 1}_1_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const body = new TextEncoder().encode([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: one-cohort-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "1.0e-4 0 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ].join("\n"));
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename) => [joinFixtureUrl(ephemerisBase, filename), body]),
  ]);
  const opaque = createOpaqueStateAdapter();
  let fullFetchStartedBeforeAllProbesFinished = false;
  let probeCalls = 0;
  let fullFetchCalls = 0;
  const harness = await createWorkerHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      if (params.url === manifestUrl) return serveFixtureHttp(params, responses);
      if (isStarlinkSizeProbe(params)) {
        probeCalls += 1;
      } else {
        fullFetchCalls += 1;
        if (probeCalls < filenames.length) {
          fullFetchStartedBeforeAllProbesFinished = true;
        }
      }
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [
      configFrame({
        manifestUrl,
        ephemerisBase,
        fetchConcurrency: 8,
        batchSize: 8,
      }),
    ],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(probeCalls, 8);
  assert.equal(fullFetchCalls, 8);
  assert.equal(
    fullFetchStartedBeforeAllProbesFinished,
    false,
    "the retained-byte ceiling must be resolved before any complete GET starts",
  );
});

test("Starlink advances across every 64-file wave instead of truncating the catalog", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-multiple-waves/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-multiple-waves/`;
  const filenames = Array.from(
    { length: 130 },
    (_, index) =>
      `MEME_${31001 + index}_STARLINK-MULTIWAVE-${index + 1}_1_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const body = new TextEncoder().encode([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: multiple-wave-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "1.0e-4 0 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ].join("\n"));
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename) => [joinFixtureUrl(ephemerisBase, filename), body]),
  ]);
  const opaque = createOpaqueStateAdapter();
  let probeCalls = 0;
  let fullFetchCalls = 0;
  const harness = await createWorkerHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      if (params.url !== manifestUrl) {
        if (isStarlinkSizeProbe(params)) probeCalls += 1;
        else fullFetchCalls += 1;
      }
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  let response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  const expectedInvocations = [
    { progress: null, durable: 0 },
    { progress: null, durable: 0 },
    { progress: null, durable: 0 },
    { progress: 64n, durable: 64 },
    { progress: null, durable: 64 },
    { progress: null, durable: 64 },
    { progress: null, durable: 64 },
    { progress: 128n, durable: 128 },
    { progress: 130n, durable: 130 },
  ];
  const progressRows = [];
  for (const [index, expected] of expectedInvocations.entries()) {
    assert.equal(response.statusCode, 0, response.errorMessage);
    if (expected.progress === null) {
      assert.deepEqual(response.outputs, []);
      assert.equal(response.yielded, true);
    } else {
      assert.deepEqual(response.outputs.map(({ portId }) => portId), ["progress"]);
      const progress = decodeProgressDss(response.outputs[0]);
      assert.equal(progress.syncedRows, expected.progress);
      assert.equal(progress.totalRows, 130n);
      progressRows.push(progress.syncedRows);
    }
    assert.equal(
      decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
        .downloadedCount,
      expected.durable,
    );
    if (index + 1 < expectedInvocations.length) {
      response = await harness.invoke({ methodId: "emit", inputs: [] });
    }
  }
  assert.deepEqual(progressRows, [64n, 128n, 130n]);
  assert.equal(probeCalls, 130);
  assert.equal(fullFetchCalls, 130);
});

test("Starlink shards catalog files across WASM-owned opaque namespaces below host scope quotas", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-opaque-quota/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-opaque-quota/`;
  const filenames = Array.from(
    { length: 12 },
    (_, index) =>
      `MEME_${31701 + index}_STARLINK-QUOTA-${index + 1}_1_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const body = repeatToSize([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: opaque-quota-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ], 64 * 1024);
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename) => [joinFixtureUrl(ephemerisBase, filename), body]),
  ]);
  const maxScopeBytes = 128 * 1024;
  const maxScopeKeys = 4;
  assert.ok(body.byteLength * filenames.length > maxScopeBytes);
  const opaque = createOpaqueStateAdapter({ maxScopeBytes, maxScopeKeys });
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") return serveFixtureHttp(params, responses);
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const committed = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({
      manifestUrl,
      ephemerisBase,
      fetchConcurrency: filenames.length,
      batchSize: filenames.length,
    })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.deepEqual(committed.outputs.map(({ portId }) => portId), ["progress"]);
  assert.equal(decodeProgressDss(committed.outputs[0]).syncedRows, 12n);

  const catalogWrites = opaque.calls.filter(
    ({ operation, params }) =>
      operation === "storage.adapter.opaque.replace" &&
      params.key?.startsWith("catalog."),
  );
  assert.equal(catalogWrites.length, filenames.length);
  const catalogNamespaces = [...new Set(
    catalogWrites.map(({ params }) => params.namespace),
  )].sort();
  assert.equal(catalogNamespaces.length, filenames.length);
  for (const namespace of catalogNamespaces) {
    assert.match(namespace, /^starlink\.[a-f0-9]{64}\.f\d+$/);
    const stats = opaque.scopeStats(namespace);
    assert.ok(stats.bytes <= maxScopeBytes, `${namespace} exceeds byte quota`);
    assert.ok(stats.keys <= maxScopeKeys, `${namespace} exceeds key quota`);
    assert.equal(
      opaque.calls.filter(
        ({ operation, params }) =>
          operation === "storage.adapter.opaque.sync" &&
          params.namespace === namespace,
      ).length,
      1,
      `${namespace} must sync before the primary checkpoint advances`,
    );
  }
  assert.equal(opaque.scopeStats("primary").keys, 1);
  assert.ok(opaque.scopeStats("primary").bytes <= maxScopeBytes);
  assert.equal(
    catalogWrites.some(({ params }) => params.namespace === "primary"),
    false,
    "catalog bytes must never consume the checkpoint namespace quota",
  );
});

test("Starlink validates all 64 worker results before writing any catalog chunk", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-wave-validation/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-wave-validation/`;
  const filenames = Array.from(
    { length: 64 },
    (_, index) =>
      `MEME_${31801 + index}_STARLINK-WAVE-VALIDATION-${index + 1}_1_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const validBody = new TextEncoder().encode([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: full-wave-validation-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ].join("\n"));
  const invalidBody = new TextEncoder().encode("not a MEME file\n");
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      index === filenames.length - 1 ? invalidBody : validBody,
    ]),
  ]);
  const opaque = createOpaqueStateAdapter();
  let probeCalls = 0;
  let fullFetchCalls = 0;
  const harness = await createWorkerHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      if (params.url !== manifestUrl) {
        if (isStarlinkSizeProbe(params)) probeCalls += 1;
        else fullFetchCalls += 1;
      }
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.notEqual(response.statusCode, 0);
  assert.deepEqual(response.outputs, []);
  assert.equal(probeCalls, 64);
  assert.equal(fullFetchCalls, 64);
  assert.deepEqual(
    opaque.calls.filter(
      ({ operation, params }) =>
        operation === "storage.adapter.opaque.replace" &&
        params.key?.startsWith("catalog."),
    ),
    [],
    "a malformed final response must prevent every provisional chunk write",
  );
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
  );
});

test("Starlink completes production-shaped files in parallel fuel-safe byte waves", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-production-memory/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-production-memory/`;
  const filenames = Array.from(
    { length: 64 },
    (_, index) =>
      `MEME_${26001 + index}_STARLINK-MEMORY-${index + 1}_1_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const body = memeToExactSize([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: production-memory-test",
    "UVW",
    "2026203000000.000 -2877.5130811997 4075.0989745008 -4706.3410523462 -3.4551274033 -6.0345187465 -3.1147385352",
    "4.5959389250e-07 -3.6857237948e-07 7.5138447296e-07 -7.6290988105e-12 1.6674071715e-10 1.1925957340e-06 8.0142362965e-10",
    "-8.7543694295e-10 -1.1494065075e-12 1.9048025297e-12 -4.5364226733e-10 3.9287303459e-10 1.4986973206e-12 -8.0112176320e-13",
    "4.9612561854e-13 1.4860258884e-13 -4.4812419975e-13 1.6101140992e-09 -2.9504360232e-16 1.6453353042e-15 5.4869916033e-12",
  ], 2_045_241);
  assert.equal(body.byteLength, 2_045_241);
  assert.equal(epochCount("starlink", body), 4305);
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename) => [joinFixtureUrl(ephemerisBase, filename), body]),
  ]);
  const opaque = createOpaqueStateAdapter();
  let probeCalls = 0;
  let fullFetchCalls = 0;
  const wasmMemory = new WebAssembly.Memory({
    initial: 18,
    maximum: 16_384,
    shared: true,
  });
  const harness = await createWorkerHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      if (params.url !== manifestUrl) {
        if (isStarlinkSizeProbe(params)) {
          probeCalls += 1;
        } else {
          fullFetchCalls += 1;
        }
      }
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  }, { memory: wasmMemory });
  t.after(() => harness.destroy());

  const startedAt = performance.now();
  let response = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(response.outputs, []);
  assert.equal(response.yielded, true);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
    "a provisional half-wave cannot advance the durable catalog cursor",
  );
  assert.equal(probeCalls, 64);
  assert.equal(fullFetchCalls, 32);
  response = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(response.outputs.map(({ portId }) => portId), ["progress"]);
  let progress = decodeProgressDss(response.outputs[0]);
  assert.equal(progress.status, 1);
  assert.equal(progress.syncedRows, 32n);
  assert.equal(progress.totalRows, 64n);
  assert.equal(probeCalls, 64, "a retained wave must not be probed twice");
  assert.equal(fullFetchCalls, 32, "a retained wave must not be downloaded twice");

  response = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(response.outputs, []);
  assert.equal(response.yielded, true);
  assert.equal(
    probeCalls,
    64,
    "valid unadmitted size probes must carry into the next retained wave",
  );
  assert.equal(fullFetchCalls, 64);

  response = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(response.outputs.map(({ portId }) => portId), ["progress"]);
  progress = decodeProgressDss(response.outputs[0]);
  assert.equal(progress.status, 2);
  assert.equal(progress.syncedRows, 64n);
  assert.equal(progress.totalRows, 64n);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    64,
  );
  const wasmMemoryBytes = wasmMemory.buffer.byteLength;
  assert.ok(
    wasmMemoryBytes < 1024 * 1024 * 1024,
    `monotonic WASM memory reached ${wasmMemoryBytes} bytes`,
  );
  t.diagnostic(
    `64 x ${body.byteLength} bytes in two parallel byte waves ` +
      `(${epochCount("starlink", body)} epochs/file): ` +
      `${(performance.now() - startedAt).toFixed(1)} ms, ` +
      `${wasmMemoryBytes} bytes monotonic WASM memory`,
  );
});

test("Starlink drains a production-shaped SHA-verified body byte-exactly", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-production-drain/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-production-drain/`;
  const filename =
    "MEME_28000_STARLINK-PRODUCTION-DRAIN_1_Operational_1_UNCLASSIFIED.txt";
  const body = memeToExactSize([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: production-drain-test",
    "UVW",
    "2026203000000.000 -2877.5130811997 4075.0989745008 -4706.3410523462 -3.4551274033 -6.0345187465 -3.1147385352",
    "4.5959389250e-07 -3.6857237948e-07 7.5138447296e-07 -7.6290988105e-12 1.6674071715e-10 1.1925957340e-06 8.0142362965e-10",
    "-8.7543694295e-10 -1.1494065075e-12 1.9048025297e-12 -4.5364226733e-10 3.9287303459e-10 1.4986973206e-12 -8.0112176320e-13",
    "4.9612561854e-13 1.4860258884e-13 -4.4812419975e-13 1.6101140992e-09 -2.9504360232e-16 1.6453353042e-15 5.4869916033e-12",
  ], 2_045_241);
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filename}\n`)],
    [joinFixtureUrl(ephemerisBase, filename), body],
  ]);
  const opaque = createOpaqueStateAdapter();
  const harness = await createWorkerHarness("starlink", (operation, params) =>
    operation === "http.request"
      ? serveFixtureHttp(params, responses)
      : opaque.dispatch(operation, params)
  );
  t.after(() => harness.destroy());

  const committed = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(committed.statusCode, 0, committed.errorMessage);
  assert.deepEqual(committed.outputs.map(({ portId }) => portId), ["progress"]);

  const startedAt = performance.now();
  const drained = await harness.invoke({ methodId: "emit", inputs: [] });
  const elapsed = performance.now() - startedAt;
  assert.equal(drained.statusCode, 0, drained.errorMessage);
  assert.ok(drained.outputs.every(({ portId }) => portId === "oem"));
  const frames = drained.outputs.map(({ payload }) => decodeFsb(payload));
  assert.deepEqual(
    Buffer.concat(frames.map(({ data }) => Buffer.from(data))),
    Buffer.from(body),
  );
  assert.deepEqual(
    frames.map(({ sha256 }) => Buffer.from(sha256).toString("hex")),
    Array.from(
      { length: frames.length },
      () => crypto.createHash("sha256").update(body).digest("hex"),
    ),
  );
  t.diagnostic(
    `${body.byteLength}-byte, ${epochCount("starlink", body)}-epoch ` +
      `SHA-verified drain: ${elapsed.toFixed(1)} ms`,
  );
});

test("Starlink bounds each durable slice by bytes without refetching its retained wave", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-durable-byte-slice/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-durable-byte-slice/`;
  const filenames = [
    "MEME_28001_STARLINK-BYTE-SLICE-1_1_Operational_1_UNCLASSIFIED.txt",
    "MEME_28002_STARLINK-BYTE-SLICE-2_1_Operational_2_UNCLASSIFIED.txt",
  ];
  const body = memeToExactSize([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: durable-byte-slice-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "1.0e-4 0 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ], 20 * 1024 * 1024);
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename) => [joinFixtureUrl(ephemerisBase, filename), body]),
  ]);
  const opaque = createOpaqueStateAdapter();
  let probeCalls = 0;
  let fullFetchCalls = 0;
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      if (params.url !== manifestUrl) {
        if (isStarlinkSizeProbe(params)) probeCalls += 1;
        else fullFetchCalls += 1;
      }
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase, batchSize: 2 })],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.deepEqual(first.outputs, []);
  assert.equal(first.yielded, true);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
  );
  assert.equal(probeCalls, 2);
  assert.equal(fullFetchCalls, 2);

  const second = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(second.statusCode, 0, second.errorMessage);
  assert.deepEqual(second.outputs.map(({ portId }) => portId), ["progress"]);
  assert.equal(decodeProgressDss(second.outputs[0]).syncedRows, 2n);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    2,
  );
  assert.equal(probeCalls, 2, "the retained wave must not be probed twice");
  assert.equal(fullFetchCalls, 2, "the retained wave must not be downloaded twice");
});

test("Starlink restarts from the durable slice when an in-memory 64-file wave is lost", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-durable-slice/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-durable-slice/`;
  const filenames = Array.from(
    { length: 20 },
    (_, index) =>
      `MEME_${29001 + index}_STARLINK-SLICE-${index + 1}_1_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const body = new TextEncoder().encode([
    "created: 2026-07-22 00:00:00 UTC",
    "ephemeris_start: 2026-07-22 00:00:00 UTC ephemeris_stop: 2026-07-23 00:00:00 UTC step_size: 60",
    "ephemeris_source: durable-slice-test",
    "UVW",
    "2026203000000.000 7000 0 0 0 7.5 0",
    "1.0e-4 0 0",
    "2026203000100.000 6999 450 0 -0.5 7.48 0",
  ].join("\n"));
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename) => [joinFixtureUrl(ephemerisBase, filename), body]),
  ]);
  const opaque = createOpaqueStateAdapter();
  const calls = [];
  const dispatch = (operation, params) => {
    if (operation === "http.request") {
      calls.push({ url: params.url, probe: isStarlinkSizeProbe(params) });
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  };

  const firstInstance = await createHarness("starlink", dispatch);
  const first = await firstInstance.invoke({
    methodId: "emit",
    inputs: [configFrame({ manifestUrl, ephemerisBase })],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.deepEqual(first.outputs, []);
  assert.equal(first.yielded, true);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
  );
  opaque.crash();
  firstInstance.destroy();
  const callsBeforeRestart = calls.length;

  const resumed = await createHarness("starlink", dispatch);
  t.after(() => resumed.destroy());
  const restartedStage = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(restartedStage.statusCode, 0, restartedStage.errorMessage);
  assert.deepEqual(restartedStage.outputs, []);
  assert.equal(restartedStage.yielded, true);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
  );
  assert.equal(
    calls.length,
    callsBeforeRestart + 40,
    "restart must probe and refetch all 20 files from the uncommitted wave",
  );
  const callsBeforeCommit = calls.length;

  const completed = await resumed.invoke({ methodId: "emit", inputs: [] });
  assert.equal(completed.statusCode, 0, completed.errorMessage);
  assert.deepEqual(completed.outputs.map(({ portId }) => portId), ["progress"]);
  assert.equal(decodeProgressDss(completed.outputs[0]).status, 2);
  assert.equal(decodeProgressDss(completed.outputs[0]).syncedRows, 20n);
  assert.equal(calls.length, callsBeforeCommit, "committing the retained wave must not refetch");
  assert.equal(
    calls.filter(({ url, probe }) => url !== manifestUrl && !probe).length,
    40,
    "every body from the uncommitted wave must be downloaded again",
  );
  for (const filename of filenames) {
    const url = joinFixtureUrl(ephemerisBase, filename);
    assert.deepEqual(
      calls.filter((call) => call.url === url),
      [
        { url, probe: true },
        { url, probe: false },
        { url, probe: true },
        { url, probe: false },
      ],
      `${filename} restart fetch count`,
    );
  }
});

test("Starlink clamps oversized wave requests to 64 complete files", async (t) => {
  const manifestUrl = `${fixtureOrigin}/starlink-frame-bound/MANIFEST.txt`;
  const ephemerisBase = `${fixtureOrigin}/starlink-frame-bound/`;
  const filenames = Array.from(
    { length: 65 },
    (_, index) =>
      `MEME_${30001 + index}_STARLINK-${index + 1}_${index + 1}_Operational_${index + 1}_UNCLASSIFIED.txt`,
  );
  const seedLines = [
    "created: 2026-07-21 00:00:00 UTC",
    "ephemeris_start: 2026-07-21 00:00:00 UTC ephemeris_stop: 2026-07-22 00:00:00 UTC step_size: 60",
    "ephemeris_source: frame-bound-test",
    "UVW",
    "2026202000000.000 7000 0 0 0 7.5 0",
    "1.0e-4 0 0",
    "2026202000100.000 6999 450 0 -0.5 7.48 0",
  ];
  const responseBodies = filenames.map(() =>
    new TextEncoder().encode(`${seedLines.join("\n")}\n`),
  );
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      responseBodies[index],
    ]),
  ]);
  const calls = [];
  const opaque = createOpaqueStateAdapter();
  const harness = await createHarness("starlink", (operation, params) => {
    if (operation === "http.request") {
      calls.push({ url: params.url, probe: isStarlinkSizeProbe(params) });
      return serveFixtureHttp(params, responses);
    }
    return opaque.dispatch(operation, params);
  });
  t.after(() => harness.destroy());

  const first = await harness.invoke({
    methodId: "emit",
    inputs: [configFrame({
      manifestUrl,
      ephemerisBase,
      fetchConcurrency: 999,
      batchSize: 999,
    })],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.deepEqual(first.outputs, []);
  assert.equal(first.yielded, true);
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    0,
  );
  assert.equal(
    calls.filter(({ url, probe }) => url !== manifestUrl && probe).length,
    64,
  );
  assert.equal(
    calls.filter(({ url, probe }) => url !== manifestUrl && !probe).length,
    64,
  );

  for (const provisionalCount of [32, 48]) {
    const continuation = await harness.invoke({ methodId: "emit", inputs: [] });
    assert.equal(continuation.statusCode, 0, continuation.errorMessage);
    assert.deepEqual(continuation.outputs, []);
    assert.equal(continuation.yielded, true);
    assert.equal(
      decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
        .downloadedCount,
      0,
      `${provisionalCount} staged files cannot advance the durable cursor`,
    );
    assert.equal(
      calls.filter(({ url, probe }) => url !== manifestUrl && probe).length,
      64,
    );
    assert.equal(
      calls.filter(({ url, probe }) => url !== manifestUrl && !probe).length,
      64,
    );
  }

  const committedWave = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(committedWave.statusCode, 0, committedWave.errorMessage);
  assert.deepEqual(committedWave.outputs.map(({ portId }) => portId), ["progress"]);
  assert.deepEqual(decodeProgressDss(committedWave.outputs[0]), {
    status: 1,
    syncedRows: 64n,
    totalRows: 65n,
    localRows: 64n,
    missingRows: 1n,
    cachedBytes: BigInt(
      responseBodies.slice(0, 64).reduce((sum, body) => sum + body.byteLength, 0),
    ),
    downloadedBytes: BigInt(
      responseBodies.slice(0, 64).reduce((sum, body) => sum + body.byteLength, 0),
    ),
  });
  assert.equal(
    decodeStarlinkCheckpoint(opaque.getDurable("starlink.active.v1"))
      .downloadedCount,
    64,
  );
  assert.equal(
    calls.filter(({ url, probe }) => url !== manifestUrl && probe).length,
    64,
  );
  assert.equal(
    calls.filter(({ url, probe }) => url !== manifestUrl && !probe).length,
    64,
  );

  const final = await harness.invoke({ methodId: "emit", inputs: [] });
  assert.equal(final.statusCode, 0, final.errorMessage);
  assert.deepEqual(final.outputs.map(({ portId }) => portId), ["progress"]);
  assert.equal(decodeProgressDss(final.outputs[0]).status, 2);
  assert.equal(decodeProgressDss(final.outputs[0]).syncedRows, 65n);
  assert.deepEqual(calls.filter(({ url }) => url === manifestUrl), [
    { url: manifestUrl, probe: false },
  ]);
  for (const filename of filenames) {
    const url = joinFixtureUrl(ephemerisBase, filename);
    assert.deepEqual(
      calls.filter((call) => call.url === url),
      [
        { url, probe: true },
        { url, probe: false },
      ],
      `${filename} must be fetched exactly once`,
    );
  }
});

for (const [key, pluginId] of providers) {
  test(`${key} provider wrapper is a strict dual-FSB node`, () => {
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
    assert.deepEqual(method.inputPorts.map((port) => port.portId), ["config"]);
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
      while (invocations.at(-1).yielded) {
        assert.ok(
          invocations.length < fixture.units.length + 2,
          "Starlink yielded more continuations than complete fixture objects",
        );
        invocations.push(await harness.invoke({ methodId: "emit", inputs: [] }));
      }
      assert.deepEqual(
        invocations.map(({ backlogRemaining }) => backlogRemaining),
        Array.from(
          { length: fixture.units.length + 2 },
          (_, index) => fixture.units.length + 1 - index,
        ),
      );
      assert.deepEqual(
        invocations.map(({ yielded }) => yielded),
        Array.from(
          { length: fixture.units.length + 2 },
          (_, index) => index + 1 < fixture.units.length + 2,
        ),
      );
      assert.deepEqual(
        invocations.map(({ outputs }) =>
          [...new Set(outputs.map(({ portId }) => portId))]
        ),
        [
          ["progress"],
          ...fixture.units.map(() => ["oem"]),
          [],
        ],
        "Starlink must commit progress before emitting one complete object per drain invocation",
      );
      assert.deepEqual(decodeProgressDss(invocations[0].outputs[0]), {
        status: 2,
        syncedRows: BigInt(fixture.units.length),
        totalRows: BigInt(fixture.units.length),
        localRows: BigInt(fixture.units.length),
        missingRows: 0n,
        cachedBytes: BigInt(
          fixture.units.reduce((sum, bytes) => sum + bytes.byteLength, 0),
        ),
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
      fixture.discoveryCalls + fixture.units.length * (key === "starlink" ? 2 : 1),
    );
    for (const { params } of calls) {
      assert.equal(params.method, "GET");
      if (key === "starlink" && isStarlinkSizeProbe(params)) {
        assert.equal(params.headers.Range, "bytes=0-0");
        assert.equal(params.max_bytes, 1);
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
        assert.equal(urlCalls.length, 2, `${url} needs one probe and one full GET`);
        assert.equal(urlCalls.filter(({ params }) => isStarlinkSizeProbe(params)).length, 1);
        assert.equal(urlCalls.filter(({ params }) => !isStarlinkSizeProbe(params)).length, 1);
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

test("Starlink bounded parallel planning is authored in the WASM node", () => {
  const source = fs.readFileSync(nodePath("starlink", "src/node.cpp"), "utf8");
  assert.match(source, /kMaxFetchConcurrency\s*=\s*64/);
  assert.match(source, /kDefaultFetchConcurrency\s*=\s*64/);
  assert.match(source, /kDefaultBatchSize\s*=\s*64/);
  assert.match(source, /kMaxDurableFilesPerInvocation\s*=\s*16/);
  assert.match(source, /kMaxDurableBytesPerInvocation\s*=\s*32ull\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /pthread_create\s*\(/);
  assert.match(source, /pthread_join\s*\(/);
  assert.match(source, /std::atomic\s*<\s*size_t\s*>/);
  assert.match(source, /fetch_concurrency/);
  assert.match(source, /download_complete_page/);
  assert.match(source, /finalize_download_admission/);
  assert.match(source, /kMaxDownstreamObjectsPerInvocation\s*=\s*1/);
  assert.match(
    source,
    /g_pending_wave_begin\s*=\s*static_cast<uint32_t>\(begin\);\s*g_pending_wave\s*=\s*std::move\(page\.responses\)/,
    "the durable wave marker must publish before the retained response vector",
  );
  assert.doesNotMatch(
    source,
    /g_pending_wave_begin\s*=\s*0;\s*g_pending_wave\.clear\(\);/,
    "retained responses must clear before their durable wave marker",
  );
  assert.match(source, /storage\.adapter\.opaque\.read/);
  assert.match(source, /storage\.adapter\.opaque\.replace/);
  assert.match(source, /storage\.adapter\.opaque\.delete/);
  assert.match(source, /storage\.adapter\.opaque\.sync/);
  assert.match(source, /Phase::kDownloading/);
  assert.match(source, /Phase::kDraining/);
  assert.match(source, /\\"headers\\":\{\\"Range\\":\\"bytes=0-0\\"\}/);
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
  assert.match(source, /sched_yield\s*\(/);
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
