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
  Builder,
  ByteBuffer,
} from "../../../../spacedatastandards.org/node_modules/flatbuffers/js/flatbuffers.js";
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

function configFrame(config, wireFormat = "flatbuffer") {
  const encoded = new TextEncoder().encode(JSON.stringify(config));
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
  const seed = `${seedLines.join("\n")}\n`;
  let value = seed;
  while (Buffer.byteLength(value) <= minimumBytes) value += seed;
  return new TextEncoder().encode(value);
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
  const signed = new Uint8Array(
    fs.readFileSync(nodePath(key, "dist/isomorphic/module.wasm")),
  );
  return createBrowserModuleHarness({
    wasmSource: signed,
    manifest,
    surface: "direct",
    hostcallDispatch,
  });
}

async function createWorkerHarness(key, hostcallDispatch) {
  const manifest = readJson(nodePath(key, "plugin-manifest.json"), `${key} manifest`);
  const signed = new Uint8Array(
    fs.readFileSync(nodePath(key, "dist/isomorphic/module.wasm")),
  );
  return createWorkerModuleHarness({
    wasmSource: signed,
    dispatchHost: hostcallDispatch,
    harnessOptions: {
      manifest,
      surface: "direct",
      maxThreads: 64,
    },
  });
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

test("Starlink exact artifact drains one full manifest across yielded continuations without duplication", async (t) => {
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
  const harness = await createHarness("starlink", (operation, params) => {
    assert.equal(operation, "http.request");
    calls.push(params.url);
    const body = responses.get(params.url);
    return body
      ? { status: 200, body: new Uint8Array(body) }
      : { status: 404, body: new Uint8Array() };
  });
  t.after(() => harness.destroy());

  const invocations = [];
  for (let index = 0; index < 3; index += 1) {
    invocations.push(
      await harness.invoke({
        methodId: "emit",
        inputs: [
          configFrame({
            manifestUrl,
            ephemerisBase,
            fetchConcurrency: 2,
            batchSize: 2,
          }),
        ],
      }),
    );
  }
  for (const response of invocations) {
    assert.equal(response.statusCode, 0, response.errorMessage);
  }
  assert.deepEqual(invocations.map(({ yielded }) => yielded), [true, true, false]);
  assert.deepEqual(
    invocations.map(({ backlogRemaining }) => backlogRemaining),
    [3, 1, 0],
  );
  assert.deepEqual(
    invocations.map(({ outputs }) =>
      new Set(outputs.map((output) => decodeFsb(output.payload).requestId.toString())).size,
    ),
    [2, 2, 1],
  );
  assert.equal(calls.filter((url) => url === manifestUrl).length, 1);
  for (const unit of units) {
    assert.equal(
      calls.filter((url) => url === joinFixtureUrl(ephemerisBase, unit.filename)).length,
      1,
      `${unit.filename} must be fetched exactly once`,
    );
  }

  const decoded = invocations.flatMap(({ outputs }) =>
    outputs.map((output) => decodeFsb(output.payload)),
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

test("Starlink keeps 64-way fetch pages but emits at most 64 FSB frames per invocation", async (t) => {
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
  const responseBodies = filenames.map((_, index) => {
    const uniqueLines = [...seedLines, `object-index: ${index}`];
    return index < 4
      ? repeatToSize(uniqueLines, 1024 * 1024 + 8192)
      : new TextEncoder().encode(`${uniqueLines.join("\n")}\n`);
  });
  const responses = new Map([
    [manifestUrl, new TextEncoder().encode(`${filenames.join("\n")}\n`)],
    ...filenames.map((filename, index) => [
      joinFixtureUrl(ephemerisBase, filename),
      responseBodies[index],
    ]),
  ]);
  const calls = [];
  let activeEphemerisCalls = 0;
  let maxConcurrentEphemerisCalls = 0;
  let ephemerisCallsStarted = 0;
  let releaseFirstEphemerisCall = null;
  let firstEphemerisGateTimer = null;
  const harness = await createWorkerHarness("starlink", async (operation, params) => {
    assert.equal(operation, "http.request");
    calls.push(params.url);
    const body = responses.get(params.url);
    if (params.url !== manifestUrl) {
      activeEphemerisCalls += 1;
      ephemerisCallsStarted += 1;
      maxConcurrentEphemerisCalls = Math.max(
        maxConcurrentEphemerisCalls,
        activeEphemerisCalls,
      );
      try {
        if (ephemerisCallsStarted === 1) {
          await new Promise((resolve, reject) => {
            releaseFirstEphemerisCall = resolve;
            firstEphemerisGateTimer = setTimeout(
              () => reject(new Error("no concurrent pthread HTTP request arrived")),
              2_000,
            );
          });
        } else if (ephemerisCallsStarted === 2) {
          clearTimeout(firstEphemerisGateTimer);
          releaseFirstEphemerisCall?.();
        }
      } finally {
        activeEphemerisCalls -= 1;
      }
    }
    return body
      ? { status: 200, body: new Uint8Array(body) }
      : { status: 404, body: new Uint8Array() };
  });
  t.after(() => harness.destroy());

  const invocations = [];
  for (let index = 0; index < 10; index += 1) {
    const response = await harness.invoke({
      methodId: "emit",
      inputs: [configFrame({
        manifestUrl,
        ephemerisBase,
        fetchConcurrency: 64,
        batchSize: 64,
      })],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.ok(
      response.outputs.length <= 64,
      `invocation ${index} emitted ${response.outputs.length} frames`,
    );
    invocations.push(response);
    if (!response.yielded) break;
  }
  assert.equal(invocations.at(-1)?.yielded, false, "Starlink did not drain");
  assert.ok(
    maxConcurrentEphemerisCalls > 1,
    `expected overlapping worker HTTP requests, observed ${maxConcurrentEphemerisCalls}`,
  );
  assert.equal(calls.filter((url) => url === manifestUrl).length, 1);
  for (const filename of filenames) {
    assert.equal(
      calls.filter((url) => url === joinFixtureUrl(ephemerisBase, filename)).length,
      1,
      `${filename} must be fetched exactly once`,
    );
  }
  const decoded = invocations.flatMap(({ outputs }) =>
    outputs.map((output) => decodeFsb(output.payload)),
  );
  assert.equal(
    new Set(decoded.map((output) => output.requestId.toString())).size,
    filenames.length,
  );
  for (let index = 0; index < filenames.length; index += 1) {
    const identity = `MEME:${30001 + index}:STARLINK-${index + 1}`;
    const chunks = decoded
      .filter((output) => output.schemaName === identity)
      .sort((left, right) => left.chunkSequence - right.chunkSequence);
    assert.deepEqual(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data))),
      Buffer.from(responseBodies[index]),
      `${identity} received another pthread request's response bytes`,
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
    assert.deepEqual(manifest.capabilities, ["http"]);
    const method = manifest.methods?.find((candidate) => candidate.methodId === "emit");
    assert.ok(method, `${key} provider must expose emit`);
    assert.deepEqual(method.inputPorts.map((port) => port.portId), ["config"]);
    assert.deepEqual(method.outputPorts.map((port) => port.portId), ["oem"]);
    assertFsbPair(method.inputPorts[0], `${key}.config`);
    assertFsbPair(method.outputPorts[0], `${key}.oem`);
    assert.doesNotMatch(JSON.stringify(manifest), /acceptsAnyFlatbuffer/i);
  });

  test(`${key} provider is an independently signed wasi-threads artifact`, async () => {
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
    assert.equal(
      analysis.isIsomorphicPthreads,
      true,
      `${key} is not a browser/WasmEdge wasi-threads artifact`,
    );
    assertPthreadArtifact(bytes, { source: artifactPath });
    assert.doesNotMatch(Buffer.from(bytes).toString("latin1"), /celestrak/i);
  });

  test(`${key} exact artifact preserves complete provider-native responses in canonical FSB chunks`, async (t) => {
    const fixture = behaviorCases[key];
    const calls = [];
    const harness = await createHarness(key, (operation, params) => {
      assert.equal(operation, "http.request");
      calls.push({ operation, params: structuredClone(params) });
      const body = fixture.responses.get(params.url);
      if (!body) return { status: 404, body: new Uint8Array() };
      return { status: 200, body: new Uint8Array(body) };
    });
    t.after(() => harness.destroy());

    const response = await harness.invoke({
      methodId: "emit",
      inputs: [configFrame(fixture.config)],
    });
    assert.equal(response.statusCode, 0, response.errorMessage);
    assert.equal(response.yielded, false);
    assert.equal(response.backlogRemaining, 0);
    assert.equal(
      harness.threadHost.spawnCount(),
      0,
      "the direct harness must select the deterministic sequential path without an owning worker broker",
    );
    assert.equal(calls.length, fixture.units.length + fixture.discoveryCalls);
    for (const { params } of calls) {
      assert.equal(params.method, "GET");
      assert.equal(params.headers?.Range, undefined, "full fetches cannot use Range");
      assert.ok(
        params.max_bytes >= minimumFullFixtureBytes,
        "guest must request a full-response ceiling rather than a prefix window",
      );
      assert.equal("concurrency" in params, false, "host must not own provider concurrency policy");
    }

    const outputs = response.outputs.map((output) => {
      assert.equal(output.portId, "oem");
      assert.equal(output.wireFormat, "flatbuffer");
      assert.equal(output.typeRef?.fileIdentifier, "$FSB");
      return decodeFsb(output.payload);
    });
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
  assert.match(source, /pthread_create\s*\(/);
  assert.match(source, /pthread_join\s*\(/);
  assert.match(source, /fetch_concurrency/);
  assert.match(source, /fetch_complete_page/);
  assert.doesNotMatch(source, /Range\s*:/i);
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
