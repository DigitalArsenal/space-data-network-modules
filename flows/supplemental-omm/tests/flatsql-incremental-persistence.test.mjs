import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { Builder, ByteBuffer } from "flatbuffers";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const flowDirectory = path.resolve(testDirectory, "..");
const nodeDirectory = process.env.FLATSQL_INCREMENTAL_NODE_ROOT
  ? path.resolve(process.env.FLATSQL_INCREMENTAL_NODE_ROOT)
  : path.resolve(flowDirectory, "nodes/flatsql");
const sdkDirectory = path.dirname(createRequire(import.meta.url).resolve("space-data-module-sdk/package.json"));

const manifest = JSON.parse(
  await readFile(path.join(nodeDirectory, "plugin-manifest.json"), "utf8"),
);
const publisher = JSON.parse(
  await readFile(path.join(nodeDirectory, "publisher.json"), "utf8"),
);
const artifactBytes = new Uint8Array(
  await readFile(path.join(nodeDirectory, "dist/isomorphic/module.wasm")),
);

const FSO_OPERATION = Object.freeze({
  APPEND_RECORDS: 1,
  QUERY_RECORDS: 2,
  CONFIGURE_INDEX: 3,
  SNAPSHOT: 7,
  RELOAD: 8,
});
const FSO_STATUS_COMPLETE = 4;
const FSO_STATUS_INVALID_ARGUMENT = 5;
const FSB_KIND_RECORD_STREAM = 1;

const USER_SCHEMA = `
table User {
  id: int (id);
  name: string;
  email: string (key);
  age: int;
}
`;

function createOpaqueStateAdapter() {
  let working = new Map();
  let durable = new Map();
  let dirty = new Map();
  let failure = null;
  const calls = [];
  const storageKey = (params) => `${params.namespace}\0${params.key}`;
  const clone = (values) => new Map(
    [...values].map(([key, value]) => [key, value.slice()]),
  );
  const visibleKeys = () => [...working.keys()]
    .map((key) => key.split("\0").at(-1))
    .sort();
  return {
    calls,
    armFailure({ operation, phase, keyPattern = null, occurrence = 1 }) {
      assert.ok(phase === "before" || phase === "after");
      failure = {
        operation,
        phase,
        keyPattern,
        occurrence,
        matches: 0,
      };
    },
    clearFailure() {
      failure = null;
    },
    durableKeys() {
      return [...durable.keys()]
        .map((key) => key.split("\0").at(-1))
        .sort();
    },
    durableValue(key) {
      return durable.get(`primary\0${key}`)?.slice();
    },
    setDurableValue(key, value) {
      assert.ok(value instanceof Uint8Array);
      const namespaced = `primary\0${key}`;
      working.set(namespaced, value.slice());
      durable.set(namespaced, value.slice());
      dirty.delete(namespaced);
    },
    seedDurableKeys(count) {
      for (let index = 0; index < count; index += 1) {
        const key = `primary\0bound.${index}`;
        working.set(key, new Uint8Array());
        durable.set(key, new Uint8Array());
        dirty.delete(key);
      }
    },
    crash() {
      working = clone(durable);
      dirty = new Map();
    },
    dispatch(operation, params) {
      const matchesFailure = failure &&
        failure.operation === operation &&
        (!failure.keyPattern || failure.keyPattern.test(params.key ?? ""));
      let trip = false;
      if (matchesFailure) {
        failure.matches += 1;
        trip = failure.matches === failure.occurrence;
      }
      if (trip && failure.phase === "before") {
        failure = null;
        throw new Error(`injected ${operation} failure before operation`);
      }
      calls.push({
        operation,
        params: {
          ...params,
          data: params.data instanceof Uint8Array ? params.data.slice() : params.data,
        },
      });
      const key = storageKey(params);
      let result;
      if (operation === "storage.adapter.opaque.read") {
        const value = working.get(key);
        result = {
          found: value !== undefined,
          bytes_b64: value?.slice() ?? new Uint8Array(),
        };
      } else if (operation === "storage.adapter.opaque.replace") {
        assert.ok(params.data instanceof Uint8Array);
        working.set(key, params.data.slice());
        dirty.set(key, params.data.slice());
        result = { stored_bytes: params.data.byteLength };
      } else if (operation === "storage.adapter.opaque.append") {
        assert.ok(params.data instanceof Uint8Array);
        const prior = working.get(key) ?? new Uint8Array();
        const next = new Uint8Array(prior.byteLength + params.data.byteLength);
        next.set(prior);
        next.set(params.data, prior.byteLength);
        working.set(key, next);
        dirty.set(key, next.slice());
        result = { stored_bytes: params.data.byteLength };
      } else if (operation === "storage.adapter.opaque.sync") {
        for (const [dirtyKey, value] of dirty) {
          if (value === null) {
            durable.delete(dirtyKey);
          } else {
            durable.set(dirtyKey, value.slice());
          }
        }
        dirty.clear();
        result = { synced: true };
      } else if (operation === "storage.adapter.opaque.list") {
        result = { keys: visibleKeys() };
      } else if (operation === "storage.adapter.opaque.delete") {
        working.delete(key);
        dirty.set(key, null);
        result = { deleted: true };
      } else {
        throw new Error(`unexpected opaque-state operation: ${operation}`);
      }
      if (trip && failure.phase === "after") {
        failure = null;
        throw new Error(`injected ${operation} failure after operation`);
      }
      return result;
    },
  };
}

async function createHarness(opaqueState) {
  return createBrowserModuleHarness({
    wasmSource: artifactBytes,
    manifest,
    surface: "direct",
    hostcallDispatch: opaqueState.dispatch,
    verifySignature: {
      trustedPublicKeys: [publisher.publicKeyHex],
      requireSignature: true,
    },
  });
}

function methodType(methodId, direction, portId) {
  const method = manifest.methods.find((candidate) => candidate.methodId === methodId);
  assert.ok(method, `manifest method ${methodId} exists`);
  const ports = direction === "input" ? method.inputPorts : method.outputPorts;
  const port = ports.find((candidate) => candidate.portId === portId);
  assert.ok(port, `${methodId} ${direction} port ${portId} exists`);
  const type = port.acceptedTypeSets
    .flatMap((set) => set.allowedTypes)
    .find((candidate) => candidate.wireFormat === "flatbuffer");
  assert.ok(type, `${methodId} ${portId} supports canonical FlatBuffers`);
  return type;
}

function createString(builder, value) {
  return value ? builder.createString(value) : 0;
}

function createBytes(builder, value) {
  const bytes = value instanceof Uint8Array
    ? value
    : new TextEncoder().encode(value ?? "");
  return bytes.byteLength > 0 ? builder.createByteVector(bytes) : 0;
}

function createTableBinding(builder, fileIdentifier, tableName) {
  const file = createString(builder, fileIdentifier);
  const table = createString(builder, tableName);
  builder.startObject(2);
  builder.addFieldOffset(0, file, 0);
  builder.addFieldOffset(1, table, 0);
  return builder.endObject();
}

function buildFso({ operation, requestId, schemaIdl, query }) {
  const builder = new Builder(1024);
  const databaseName = createString(builder, "incremental-test");
  const schema = createBytes(builder, schemaIdl);
  const queryBytes = createBytes(builder, query);
  const binding = schemaIdl
    ? createTableBinding(builder, "USER", "User")
    : 0;
  let bindings = 0;
  if (binding) {
    builder.startVector(4, 1, 4);
    builder.addOffset(binding);
    bindings = builder.endVector();
  }
  builder.startObject(21);
  builder.addFieldInt8(0, operation, 0);
  builder.addFieldInt64(1, BigInt(requestId), 0n);
  builder.addFieldOffset(2, databaseName, 0);
  builder.addFieldOffset(3, schema, 0);
  builder.addFieldOffset(4, bindings, 0);
  builder.addFieldOffset(9, queryBytes, 0);
  const root = builder.endObject();
  builder.finish(root, "$FSO");
  return builder.asUint8Array();
}

function buildFsb({ requestId, data, recordCount }) {
  const builder = new Builder(Math.max(1024, data.byteLength + 256));
  const schemaName = createString(builder, "User");
  const fileIdentifier = createString(builder, "USER");
  const bytes = createBytes(builder, data);
  builder.startObject(11);
  builder.addFieldInt64(0, BigInt(requestId), 0n);
  builder.addFieldInt8(1, FSB_KIND_RECORD_STREAM, 0);
  builder.addFieldInt32(2, 0, 0);
  builder.addFieldInt8(3, 1, 0);
  builder.addFieldInt64(4, BigInt(data.byteLength), 0n);
  builder.addFieldInt64(5, BigInt(recordCount), 0n);
  builder.addFieldOffset(7, schemaName, 0);
  builder.addFieldOffset(8, fileIdentifier, 0);
  builder.addFieldOffset(9, bytes, 0);
  const root = builder.endObject();
  builder.finish(root, "$FSB");
  return builder.asUint8Array();
}

function createUserRecord(id, valueBytes) {
  const builder = new Builder(valueBytes.byteLength + 256);
  const name = builder.createString(`User ${id}`);
  const email = builder.createString(Buffer.from(valueBytes).toString("hex"));
  builder.startObject(4);
  builder.addFieldInt32(0, id, 0);
  builder.addFieldOffset(1, name, 0);
  builder.addFieldOffset(2, email, 0);
  builder.addFieldInt32(3, id % 100, 0);
  const root = builder.endObject();
  builder.finishSizePrefixed(root, "USER");
  return builder.asUint8Array();
}

function flatbufferRoot(bytes, identifier) {
  const buffer = new ByteBuffer(bytes);
  assert.equal(buffer.__has_identifier(identifier), true, `expected ${identifier}`);
  const position = buffer.position();
  return { buffer, table: position + buffer.readInt32(position) };
}

function fieldOffset(buffer, table, slot) {
  return buffer.__offset(table, 4 + slot * 2);
}

function readVector(buffer, table, slot) {
  const offset = fieldOffset(buffer, table, slot);
  if (!offset) return new Uint8Array();
  const start = buffer.__vector(table + offset);
  const length = buffer.__vector_len(table + offset);
  return buffer.bytes().subarray(start, start + length).slice();
}

function decodeStatus(bytes) {
  const { buffer, table } = flatbufferRoot(bytes, "$FSO");
  const statusOffset = fieldOffset(buffer, table, 16);
  const errorOffset = fieldOffset(buffer, table, 19);
  return {
    status: statusOffset ? buffer.readUint8(table + statusOffset) : 0,
    errorCode: errorOffset ? buffer.__string(table + errorOffset) : null,
    message: new TextDecoder().decode(readVector(buffer, table, 20)),
  };
}

function decodeFsb(bytes) {
  const { buffer, table } = flatbufferRoot(bytes, "$FSB");
  const sequenceOffset = fieldOffset(buffer, table, 2);
  return {
    sequence: sequenceOffset ? buffer.readUint32(table + sequenceOffset) : 0,
    data: readVector(buffer, table, 9),
  };
}

function assertComplete(response) {
  assert.equal(response.statusCode, 0, response.errorMessage ?? response.errorCode);
  const frame = response.outputs.find((output) => output.portId === "status");
  assert.ok(frame, "operation emits status");
  const status = decodeStatus(frame.payload);
  assert.equal(
    status.status,
    FSO_STATUS_COMPLETE,
    status.message || status.errorCode,
  );
}

function assertFailed(response) {
  const frame = response.outputs.find((output) => output.portId === "status");
  assert.ok(frame, "failed operation emits status");
  const status = decodeStatus(frame.payload);
  assert.notEqual(status.status, FSO_STATUS_COMPLETE, status.message);
}

async function configure(harness) {
  const response = await invokeConfigure(harness);
  assertComplete(response);
  return response;
}

async function invokeConfigure(harness) {
  return harness.invoke({
    methodId: "configure_index",
    inputs: [{
      portId: "control",
      typeRef: methodType("configure_index", "input", "control"),
      payload: buildFso({
        operation: FSO_OPERATION.CONFIGURE_INDEX,
        requestId: 1,
        schemaIdl: USER_SCHEMA,
      }),
    }],
  });
}

async function append(harness, requestId, record) {
  const response = await invokeAppend(harness, requestId, record);
  assertComplete(response);
  return response;
}

async function invokeAppend(harness, requestId, record) {
  return harness.invoke({
    methodId: "append_records",
    inputs: [{
      portId: "records",
      typeRef: methodType("append_records", "input", "records"),
      payload: buildFsb({ requestId, data: record, recordCount: 1 }),
    }],
  });
}

async function queryAll(harness, requestId) {
  const response = await harness.invoke({
    methodId: "query_records",
    inputs: [{
      portId: "query",
      typeRef: methodType("query_records", "input", "query"),
      payload: buildFso({
        operation: FSO_OPERATION.QUERY_RECORDS,
        requestId,
        query: "SELECT _data FROM User ORDER BY id",
      }),
    }],
  });
  assertComplete(response);
  const chunks = response.outputs
    .filter((output) => output.portId === "records")
    .map((output) => decodeFsb(output.payload))
    .sort((left, right) => left.sequence - right.sequence);
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return result;
}

async function snapshot(harness, requestId) {
  const response = await invokeSnapshot(harness, requestId);
  assertComplete(response);
  return response.outputs.filter((output) => output.portId === "snapshot");
}

async function invokeSnapshot(harness, requestId) {
  return harness.invoke({
    methodId: "snapshot",
    inputs: [{
      portId: "control",
      typeRef: methodType("snapshot", "input", "control"),
      payload: buildFso({
        operation: FSO_OPERATION.SNAPSHOT,
        requestId,
      }),
    }],
  });
}

async function reload(harness, requestId, snapshotFrames) {
  const response = await invokeReload(harness, snapshotFrames);
  assertComplete(response);
  return response;
}

async function invokeReload(harness, snapshotFrames) {
  const typeRef = methodType("reload", "input", "snapshot");
  return harness.invoke({
    methodId: "reload",
    inputs: snapshotFrames.map((frame) => ({
      portId: "snapshot",
      typeRef,
      payload: frame.payload,
    })),
  });
}

function concatenate(records) {
  const output = new Uint8Array(
    records.reduce((sum, record) => sum + record.byteLength, 0),
  );
  let offset = 0;
  for (const record of records) {
    output.set(record, offset);
    offset += record.byteLength;
  }
  return output;
}

test("one-record drains persist bounded deltas and replay identically after restart", async (t) => {
  const opaqueState = createOpaqueStateAdapter();
  const source = await createHarness(opaqueState);
  const records = [];
  const recordPayloadBytes = 24 * 1024;
  try {
    await configure(source);
    const mutationCallOffset = opaqueState.calls.length;
    for (let index = 0; index < 24; index += 1) {
      const payload = new Uint8Array(recordPayloadBytes);
      payload.fill(65 + (index % 26));
      const record = createUserRecord(index + 1, payload);
      records.push(record);
      await append(source, index + 2, record);
    }

    const mutationCalls = opaqueState.calls.slice(mutationCallOffset);
    const writes = mutationCalls.filter(({ operation }) =>
      operation === "storage.adapter.opaque.replace" ||
      operation === "storage.adapter.opaque.append"
    );
    const snapshotRewrites = writes.filter(({ params }) =>
      /^snapshot\.g\d+\.c\d+\.bin$/.test(params.key)
    );
    const inputBytes = records.reduce((sum, record) => sum + record.byteLength, 0);
    const persistedBytes = writes.reduce(
      (sum, { params }) => sum + (params.data?.byteLength ?? 0),
      0,
    );
    t.diagnostic(
      `steady-state opaque writes: ${persistedBytes} bytes for ${inputBytes} input bytes`,
    );
    assert.equal(
      snapshotRewrites.length,
      0,
      "steady-state appends must not rewrite growing snapshot generations",
    );
    assert.ok(
      persistedBytes <= inputBytes * 3 + records.length * 1024,
      `steady-state persisted ${persistedBytes} bytes for ${inputBytes} input bytes`,
    );
  } finally {
    source.destroy();
  }

  opaqueState.crash();
  const restarted = await createHarness(opaqueState);
  let snapshotFrames;
  let expected;
  try {
    const actual = await queryAll(restarted, 1000);
    expected = new Uint8Array(
      records.reduce((sum, record) => sum + record.byteLength, 0),
    );
    let offset = 0;
    for (const record of records) {
      expected.set(record, offset);
      offset += record.byteLength;
    }
    assert.deepEqual(actual, expected);
    snapshotFrames = await snapshot(restarted, 1001);
    assert.equal(
      opaqueState.durableKeys().some((key) => key.startsWith("wal.")),
      false,
      "explicit snapshot must compact and retire its WAL generation",
    );
  } finally {
    restarted.destroy();
  }

  const importedState = createOpaqueStateAdapter();
  const imported = await createHarness(importedState);
  try {
    await reload(imported, 1002, snapshotFrames);
    assert.deepEqual(await queryAll(imported, 1003), expected);
  } finally {
    imported.destroy();
  }

  importedState.crash();
  const importedRestart = await createHarness(importedState);
  try {
    assert.deepEqual(await queryAll(importedRestart, 1004), expected);
    await append(importedRestart, 2, records[0]);
    assert.deepEqual(await queryAll(importedRestart, 1005), expected);
  } finally {
    importedRestart.destroy();
  }
});

test("append request ids are strict durable idempotency keys", async () => {
  const opaqueState = createOpaqueStateAdapter();
  const record = createUserRecord(1, new TextEncoder().encode("response-loss"));
  const recycledIdRecord = createUserRecord(
    2,
    new TextEncoder().encode("recycled-od-request-id"),
  );
  const source = await createHarness(opaqueState);
  try {
    await configure(source);
    await append(source, 42, record);
    // The caller lost the first successful response and retries the same token.
    await append(source, 42, record);
    assert.deepEqual(await queryAll(source, 43), record);
    const conflict = await invokeAppend(source, 42, recycledIdRecord);
    const conflictStatus = decodeStatus(
      conflict.outputs.find((output) => output.portId === "status").payload,
    );
    assert.equal(conflictStatus.status, FSO_STATUS_INVALID_ARGUMENT);
    assert.equal(conflictStatus.errorCode, "receipt-conflict");
    assert.deepEqual(await queryAll(source, 44), record);
  } finally {
    source.destroy();
  }

  opaqueState.crash();
  const restarted = await createHarness(opaqueState);
  try {
    await append(restarted, 42, record);
    const conflict = await invokeAppend(restarted, 42, recycledIdRecord);
    const conflictStatus = decodeStatus(
      conflict.outputs.find((output) => output.portId === "status").payload,
    );
    assert.equal(conflictStatus.status, FSO_STATUS_INVALID_ARGUMENT);
    assert.equal(conflictStatus.errorCode, "receipt-conflict");
    assert.deepEqual(await queryAll(restarted, 45), record);
  } finally {
    restarted.destroy();
  }
});

test("a WAL commit trap cannot let the next append overwrite the committed slot", async () => {
  const opaqueState = createOpaqueStateAdapter();
  const first = createUserRecord(1, new TextEncoder().encode("committed-before-ingest"));
  const second = createUserRecord(2, new TextEncoder().encode("next-request"));
  const source = await createHarness(opaqueState);
  try {
    await configure(source);
    opaqueState.armFailure({
      operation: "storage.adapter.opaque.sync",
      phase: "after",
      occurrence: 2,
    });
    assertFailed(await invokeAppend(source, 50, first));
    await append(source, 51, second);
  } finally {
    source.destroy();
  }

  opaqueState.crash();
  const restarted = await createHarness(opaqueState);
  try {
    assert.deepEqual(await queryAll(restarted, 52), concatenate([first, second]));
    await append(restarted, 50, first);
    assert.deepEqual(await queryAll(restarted, 53), concatenate([first, second]));
  } finally {
    restarted.destroy();
  }
});

test("an indeterminate WAL manifest replace is synchronized before retry response", async () => {
  const opaqueState = createOpaqueStateAdapter();
  const record = createUserRecord(1, new TextEncoder().encode("manifest-replace"));
  const source = await createHarness(opaqueState);
  try {
    await configure(source);
    opaqueState.armFailure({
      operation: "storage.adapter.opaque.replace",
      keyPattern: /^wal\.g\d+\.s1\.manifest$/,
      phase: "after",
    });
    assertFailed(await invokeAppend(source, 55, record));
    await append(source, 55, record);
  } finally {
    source.destroy();
  }

  opaqueState.crash();
  const restarted = await createHarness(opaqueState);
  try {
    assert.deepEqual(await queryAll(restarted, 56), record);
  } finally {
    restarted.destroy();
  }
});

test("a base-manifest commit trap cannot append into the obsolete generation", async () => {
  const opaqueState = createOpaqueStateAdapter();
  const first = createUserRecord(1, new TextEncoder().encode("before-reload"));
  const second = createUserRecord(2, new TextEncoder().encode("after-reload"));
  const source = await createHarness(opaqueState);
  let snapshotFrames;
  try {
    await configure(source);
    await append(source, 60, first);
    snapshotFrames = await snapshot(source, 61);
    opaqueState.armFailure({
      operation: "storage.adapter.opaque.sync",
      phase: "after",
      occurrence: 2,
    });
    assertFailed(await invokeReload(source, snapshotFrames));
    const appendCallOffset = opaqueState.calls.length;
    await append(source, 62, second);
    const activeManifest = opaqueState.durableValue("snapshot.manifest");
    assert.ok(activeManifest);
    const generation = Number(
      new DataView(activeManifest.buffer, activeManifest.byteOffset).getBigUint64(4, true),
    );
    const appendWalKeys = opaqueState.calls
      .slice(appendCallOffset)
      .filter(({ operation, params }) =>
        operation === "storage.adapter.opaque.replace" &&
        /^wal\.g\d+\./.test(params.key ?? "")
      )
      .map(({ params }) => params.key);
    assert.ok(appendWalKeys.length > 0, "the successor uses incremental WAL");
    assert.equal(
      appendWalKeys.every((key) =>
        new RegExp(`^wal\\.g${generation}\\.`).test(key)
      ),
      true,
      "no append may target the superseded base generation",
    );
  } finally {
    source.destroy();
  }

  opaqueState.crash();
  const restarted = await createHarness(opaqueState);
  try {
    assert.deepEqual(await queryAll(restarted, 63), concatenate([first, second]));
  } finally {
    restarted.destroy();
  }
});

test("an indeterminate base-manifest replace is synchronized before successor WAL", async () => {
  const opaqueState = createOpaqueStateAdapter();
  const first = createUserRecord(1, new TextEncoder().encode("base-before"));
  const second = createUserRecord(2, new TextEncoder().encode("base-after"));
  const source = await createHarness(opaqueState);
  try {
    await configure(source);
    await append(source, 64, first);
    const snapshotFrames = await snapshot(source, 65);
    opaqueState.armFailure({
      operation: "storage.adapter.opaque.replace",
      keyPattern: /^snapshot\.manifest$/,
      phase: "after",
    });
    assertFailed(await invokeReload(source, snapshotFrames));
    const appendCallOffset = opaqueState.calls.length;
    await append(source, 66, second);
    const manifest = opaqueState.durableValue("snapshot.manifest");
    assert.ok(manifest);
    const generation = Number(
      new DataView(manifest.buffer, manifest.byteOffset).getBigUint64(4, true),
    );
    const successorWalKeys = opaqueState.calls
      .slice(appendCallOffset)
      .filter(({ operation, params }) =>
        operation === "storage.adapter.opaque.replace" &&
        /^wal\.g\d+\./.test(params.key ?? "")
      )
      .map(({ params }) => params.key);
    assert.ok(successorWalKeys.length > 0);
    assert.ok(successorWalKeys.every((key) =>
      new RegExp(`^wal\\.g${generation}\\.`).test(key)
    ));
  } finally {
    source.destroy();
  }

  opaqueState.crash();
  const restarted = await createHarness(opaqueState);
  try {
    assert.deepEqual(await queryAll(restarted, 67), concatenate([first, second]));
  } finally {
    restarted.destroy();
  }
});

const walCommitBoundaries = [
  {
    name: "chunk replace",
    failure: {
      operation: "storage.adapter.opaque.replace",
      keyPattern: /^wal\.g\d+\.s1\.c0\.bin$/,
    },
  },
  {
    name: "chunk sync",
    failure: {
      operation: "storage.adapter.opaque.sync",
      occurrence: 1,
    },
  },
  {
    name: "manifest replace",
    failure: {
      operation: "storage.adapter.opaque.replace",
      keyPattern: /^wal\.g\d+\.s1\.manifest$/,
    },
  },
  {
    name: "manifest sync",
    failure: {
      operation: "storage.adapter.opaque.sync",
      occurrence: 2,
    },
  },
];

test("every WAL replace/sync boundary recovers without omission or duplication", async (t) => {
  for (const boundary of walCommitBoundaries) {
    for (const phase of ["before", "after"]) {
      await t.test(`${boundary.name} ${phase}`, async () => {
        const opaqueState = createOpaqueStateAdapter();
        const first = createUserRecord(1, new TextEncoder().encode(`${boundary.name}-${phase}`));
        const second = createUserRecord(2, new TextEncoder().encode("successor"));
        const source = await createHarness(opaqueState);
        try {
          await configure(source);
          opaqueState.armFailure({ ...boundary.failure, phase });
          assertFailed(await invokeAppend(source, 70, first));
        } finally {
          source.destroy();
        }

        opaqueState.crash();
        const restarted = await createHarness(opaqueState);
        try {
          await append(restarted, 70, first);
          await append(restarted, 71, second);
        } finally {
          restarted.destroy();
        }

        opaqueState.crash();
        const verified = await createHarness(opaqueState);
        try {
          assert.deepEqual(
            await queryAll(verified, 72),
            concatenate([first, second]),
          );
          await append(verified, 70, first);
          assert.deepEqual(
            await queryAll(verified, 73),
            concatenate([first, second]),
          );
        } finally {
          verified.destroy();
        }
      });
    }
  }
});

const baseCommitBoundaries = [
  {
    name: "chunk replace",
    failure: {
      operation: "storage.adapter.opaque.replace",
      keyPattern: /^snapshot\.g1\.c0\.bin$/,
    },
  },
  {
    name: "chunk sync",
    failure: {
      operation: "storage.adapter.opaque.sync",
      occurrence: 1,
    },
  },
  {
    name: "manifest replace",
    failure: {
      operation: "storage.adapter.opaque.replace",
      keyPattern: /^snapshot\.manifest$/,
    },
  },
  {
    name: "manifest sync",
    failure: {
      operation: "storage.adapter.opaque.sync",
      occurrence: 2,
    },
  },
];

test("every base replace/sync boundary selects one complete generation", async (t) => {
  for (const boundary of baseCommitBoundaries) {
    for (const phase of ["before", "after"]) {
      await t.test(`${boundary.name} ${phase}`, async () => {
        const opaqueState = createOpaqueStateAdapter();
        const record = createUserRecord(1, new TextEncoder().encode(`${boundary.name}-${phase}`));
        const source = await createHarness(opaqueState);
        try {
          assertFailed(await invokeSnapshot(source, 79));
          opaqueState.armFailure({ ...boundary.failure, phase });
          assertFailed(await invokeConfigure(source));
        } finally {
          source.destroy();
        }

        opaqueState.crash();
        const restarted = await createHarness(opaqueState);
        try {
          await configure(restarted);
          await append(restarted, 80, record);
        } finally {
          restarted.destroy();
        }

        opaqueState.crash();
        const verified = await createHarness(opaqueState);
        try {
          assert.deepEqual(await queryAll(verified, 81), record);
          await append(verified, 80, record);
          assert.deepEqual(await queryAll(verified, 82), record);
        } finally {
          verified.destroy();
        }
      });
    }
  }
});

test("the audited full Starlink catalog fits one bounded WAL generation", async (t) => {
  const opaqueState = createOpaqueStateAdapter();
  const source = await createHarness(opaqueState);
  let firstRecord;
  const starlinkFiles = 8_825;
  const persistedStreamsPerFile = 3;
  const expectedAppends = starlinkFiles * persistedStreamsPerFile;
  const fittedBytesPerFile = 7_360 + 17_848 + 4_600;
  const projectedCatalogBytes = starlinkFiles * fittedBytesPerFile;
  assert.equal(projectedCatalogBytes, 263_055_600);
  assert.ok(
    projectedCatalogBytes < 512 * 1024 * 1024,
    "audited fitted Starlink bytes must remain below the bounded WAL/base byte cap",
  );
  try {
    await configure(source);
    for (let index = 0; index < expectedAppends; index += 1) {
      const record = createUserRecord(
        index + 1,
        new Uint8Array([65 + (index % 26)]),
      );
      if (index === 0) firstRecord = record;
      await append(source, 10_000 + index, record);
    }
    const manifest = opaqueState.durableValue("snapshot.manifest");
    assert.ok(manifest);
    const generation = Number(
      new DataView(manifest.buffer, manifest.byteOffset).getBigUint64(4, true),
    );
    assert.equal(
      generation,
      1,
      "the audited full catalog must not force an intermediate base rewrite",
    );
    const durableKeys = opaqueState.durableKeys();
    const walManifestKeys = durableKeys.filter((key) =>
      /^wal\.g\d+\.s\d+\.manifest$/.test(key)
    );
    assert.equal(walManifestKeys.length, expectedAppends);
    assert.ok(durableKeys.length <= 65_536);
    assert.equal(
      durableKeys.some((key) => /^wal\.g2\./.test(key)),
      false,
      "the audited full catalog stays within generation one",
    );
    t.diagnostic(
      `audited Starlink projection ${projectedCatalogBytes} bytes, generation ${generation}, ${walManifestKeys.length} WAL entries, ${durableKeys.length} opaque keys`,
    );
    await snapshot(source, 20_000);
    assert.equal(
      opaqueState.durableKeys().some((key) => key.startsWith("wal.")),
      false,
      "the explicit end-of-run snapshot retires the bounded WAL",
    );
  } finally {
    source.destroy();
  }

  opaqueState.crash();
  const restarted = await createHarness(opaqueState);
  try {
    const retryCallOffset = opaqueState.calls.length;
    await append(restarted, 10_000, firstRecord);
    const retryMutations = opaqueState.calls.slice(retryCallOffset).filter(
      ({ operation }) => operation === "storage.adapter.opaque.replace" ||
        operation === "storage.adapter.opaque.append" ||
        operation === "storage.adapter.opaque.delete",
    );
    assert.deepEqual(
      retryMutations,
      [],
      "the restart-stable first transaction remains an exact no-op after the full run",
    );
  } finally {
    restarted.destroy();
  }
});

test("snapshot and opaque-list read bounds fail closed", async (t) => {
  for (const mutation of ["oversize", "chunk-count"]) {
    await t.test(mutation, async () => {
      const opaqueState = createOpaqueStateAdapter();
      const source = await createHarness(opaqueState);
      try {
        await configure(source);
      } finally {
        source.destroy();
      }
      const manifest = opaqueState.durableValue("snapshot.manifest");
      assert.ok(manifest);
      const view = new DataView(
        manifest.buffer,
        manifest.byteOffset,
        manifest.byteLength,
      );
      if (mutation === "oversize") {
        view.setBigUint64(12, 512n * 1024n * 1024n + 1n, true);
      } else {
        view.setUint32(24, view.getUint32(24, true) + 1, true);
      }
      opaqueState.setDurableValue("snapshot.manifest", manifest);
      opaqueState.crash();
      const restarted = await createHarness(opaqueState);
      try {
        assertFailed(await invokeSnapshot(restarted, 30_000));
      } finally {
        restarted.destroy();
      }
    });
  }

  await t.test("key-list", async () => {
    const opaqueState = createOpaqueStateAdapter();
    const source = await createHarness(opaqueState);
    try {
      await configure(source);
    } finally {
      source.destroy();
    }
    opaqueState.seedDurableKeys(131_072);
    opaqueState.crash();
    const restarted = await createHarness(opaqueState);
    try {
      assertFailed(await invokeSnapshot(restarted, 30_001));
    } finally {
      restarted.destroy();
    }
  });
});

test("persist and replay bounds are explicit and the build rejects non-local Emscripten", async () => {
  const source = await readFile(
    path.join(nodeDirectory, "src/sdn_node.cpp"),
    "utf8",
  );
  assert.match(source, /kMaxOpaqueSnapshotBytes\s*=\s*512ull\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /snapshot_bytes\.size\(\)\s*>\s*kMaxOpaqueSnapshotBytes/);
  assert.match(source, /manifest->chunk_count\s*!=\s*expected_chunks/);
  assert.match(source, /kMaxOpaqueWalEntries\s*=\s*32768/);
  assert.match(source, /kMaxOpaqueWalKeys\s*=\s*65536/);
  assert.match(source, /kMaxOpaqueListKeys\s*=\s*131072/);
  const appendBody = source.slice(
    source.indexOf('extern "C" int append_records(void)'),
    source.indexOf('extern "C" int query_records(void)'),
  );
  const walCommit = appendBody.indexOf("persistDurableAppend(");
  const ingest = appendBody.indexOf("flatsql_ingest(", walCommit);
  const stateCurrent = appendBody.indexOf(
    "g_durable_state_checked = true;",
    ingest,
  );
  const response = appendBody.lastIndexOf("return pushStatus(");
  assert.ok(walCommit >= 0 && walCommit < ingest, "WAL commits before live ingest");
  assert.ok(ingest < stateCurrent, "live state remains unchecked through ingest");
  assert.ok(stateCurrent < response, "state becomes current before response emission");
  assert.match(source, /std::map<uint64_t, AppendReceipt>\s+g_append_receipts/);

  const build = await readFile(path.join(nodeDirectory, "build.mjs"), "utf8");
  assert.doesNotMatch(build, /run\(["']emcmake["']/);
  assert.match(build, /SDN_LOCAL_EMSDK_DIR/);
  assert.match(build, /must resolve inside/);
  const rejected = spawnSync(process.execPath, [path.join(nodeDirectory, "build.mjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      FLATSQL_NODE_BUILD_MODE: "development",
      SDN_LOCAL_EMSDK_DIR: path.join(nodeDirectory, "missing-external-toolchain"),
      SPACE_DATA_MODULE_SDK_ROOT: sdkDirectory,
    },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(
    `${rejected.stdout}\n${rejected.stderr}`,
    /repo-local Emscripten is unavailable/,
  );

  const externalRoot = await mkdtemp(path.join(tmpdir(), "flatsql-emsdk-escape-"));
  const externalEmsdk = path.join(externalRoot, "emsdk");
  const externalEmscripten = path.join(externalEmsdk, "upstream/emscripten");
  const linkedEmsdk = path.join(
    nodeDirectory,
    `.test-emsdk-symlink-escape-${process.pid}`,
  );
  try {
    await mkdir(externalEmscripten, { recursive: true });
    await Promise.all([
      writeFile(path.join(externalEmscripten, "emcmake"), ""),
      writeFile(path.join(externalEmscripten, "em++"), ""),
      writeFile(path.join(externalEmsdk, ".emscripten"), ""),
    ]);
    await symlink(externalEmsdk, linkedEmsdk);
    const escaped = spawnSync(
      process.execPath,
      [path.join(nodeDirectory, "build.mjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FLATSQL_NODE_BUILD_MODE: "development",
          SDN_LOCAL_EMSDK_DIR: linkedEmsdk,
          SPACE_DATA_MODULE_SDK_ROOT: sdkDirectory,
        },
      },
    );
    assert.notEqual(escaped.status, 0);
    assert.match(
      `${escaped.stdout}\n${escaped.stderr}`,
      /must resolve inside/,
      "an in-repository symlink must not escape to an external Emscripten toolchain",
    );
  } finally {
    await rm(linkedEmsdk, { force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});
