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

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeRoot = path.join(packageRoot, "nodes/od");
const inputPorts = ["starlink", "glonass", "intelsat", "cpf", "iss"];
const recordOutputPorts = ["omm", "ocm", "obd"];
const outputPorts = ["control", ...recordOutputPorts];
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
}) {
  const builder = new Builder(data.byteLength + 512);
  const schemaName = builder.createString("MEME:67850:STARLINK-36840");
  const fileIdentifier = builder.createString("MEME");
  const dataVector = FSB.createDataVector(builder, data);
  const checksumVector = FSB.createSha256Vector(builder, checksum);
  FSB.startFSB(builder);
  FSB.addRequestId(builder, requestId);
  FSB.addChunkSequence(builder, sequence);
  FSB.addFinal(builder, final);
  FSB.addTotalBytes(builder, BigInt(totalBytes));
  FSB.addRecordCount(builder, 12n);
  FSB.addSchemaName(builder, schemaName);
  FSB.addFileIdentifier(builder, fileIdentifier);
  FSB.addData(builder, dataVector);
  FSB.addSha256(builder, checksumVector);
  const root = FSB.endFSB(builder);
  FSB.finishFSBBuffer(builder, root);
  return builder.asUint8Array();
}

function inputFrame(payload) {
  return {
    portId: "starlink",
    wireFormat: "flatbuffer",
    typeRef: {
      ...fsbType,
      schemaHash: [...Buffer.from(fsbType.schemaHash, "hex")],
    },
    payload,
  };
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
  for (const port of [...method.inputPorts, ...method.outputPorts.filter((port) => port.portId !== "control")]) {
    assertFsbPair(port, `fit.${port.portId}`);
  }
  const control = method.outputPorts.find((port) => port.portId === "control");
  const controlTypes = control?.acceptedTypeSets?.[0]?.allowedTypes ?? [];
  assert.deepEqual(
    controlTypes.map((type) => type.wireFormat).sort(),
    ["aligned-binary", "flatbuffer"],
  );
  assert.ok(controlTypes.every((type) => type.schemaName === "FSO.fbs"));
  assert.ok(controlTypes.every((type) => type.fileIdentifier === "$FSO"));
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

test("OD retains native chunks across invocations and fits only the complete response", async (t) => {
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

  const fixture = new Uint8Array(
    fs.readFileSync(
      path.join(
        packageRoot,
        "../../data-source/spacex-starlink-source/test/fixtures/meme/MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
      ),
    ),
  );
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

  const complete = await harness.invoke({
    methodId: "fit",
    inputs: [
      inputFrame(chunks[2]),
      ...Array.from({ length: 1_399 }, (_, index) =>
        inputFrame(
          makeChunk({
            data: fixture,
            sequence: 0,
            final: true,
            totalBytes: fixture.byteLength,
            checksum,
            requestId: 67851n + BigInt(index),
          }),
        ),
      ),
    ],
  });
  assert.equal(complete.statusCode, 0, complete.errorMessage);
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
  let multiChunkStreamSeen = false;
  for (const portId of recordOutputPorts) {
    const matches = outputs
      .filter((output) => output.portId === portId)
      .sort((left, right) => left.sequence - right.sequence);
    assert.ok(matches.length >= 1, `missing fitted ${portId}`);
    multiChunkStreamSeen ||= matches.length > 1;
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
  assert.equal(
    multiChunkStreamSeen,
    true,
    `the large fit batch must exercise FSB chunking: ${JSON.stringify(
      outputs.map((output) => ({
        portId: output.portId,
        recordCount: output.recordCount.toString(),
        bytes: output.data.byteLength,
      })),
    )}`,
  );

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
    inputs: complete.outputs.map((output) => ({
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
