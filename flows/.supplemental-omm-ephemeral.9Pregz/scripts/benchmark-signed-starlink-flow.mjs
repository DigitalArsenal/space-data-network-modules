#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseSingleFileBundle,
  verifyModuleArtifact,
} from "space-data-module-sdk";
import { createFlowRuntimeHost } from "space-data-module-sdk/flow";
import { createWorkerModuleHarness } from "space-data-module-sdk/testing";
import {
  Builder,
  ByteBuffer,
} from "../../../../spacedatastandards.org/node_modules/flatbuffers/js/flatbuffers.js";
import { DSS } from "../../../../spacedatastandards.org/lib/js/DSS/DSS.js";
import { FSB } from "../../../../spacedatastandards.org/lib/js/FSB/FSB.js";
import { FSO } from "../../../../spacedatastandards.org/lib/js/FSO/FSO.js";
import { OCM } from "../../../../spacedatastandards.org/lib/js/OCM/OCM.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/OMM.js";
import { trajectoryType } from "../../../../spacedatastandards.org/lib/js/OCM/trajectoryType.js";
import { flatSqlNodeOperation } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeOperation.js";
import { flatSqlNodeStatus } from "../../../../spacedatastandards.org/lib/js/FSO/flatSqlNodeStatus.js";

const STARLINK_RESPONSE_BUFFER_BYTES = 72 * 1024 * 1024;
const STARLINK_HOSTCALL_TIMEOUT_MS = 650_000;
const DEFAULT_CHILD_INVOKE_TIMEOUT_MS = STARLINK_HOSTCALL_TIMEOUT_MS + 60_000;
const DEFAULT_CURSOR_LIMIT_BYTES = 1024 * 1024 - 1;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_ROUTE_TIMEOUT_MS = 15_000;
const MAX_DSS_ROUTE_BYTES = 1024 * 1024;
const DEFAULT_LOCAL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RELOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_RELOAD_INVOKE_TIMEOUT_MS = 30_000;
const DEFAULT_RELOAD_PAGE_SIZE = 128;
const MAX_RELOAD_PAGE_SIZE = 1024;
const MAX_RELOAD_RECORDS = 5_000_000;
const DSS_SYNCED = 2;
const DSS_ERROR = 4;
const TERMINAL_REENTRY_TRAJECTORY_DESCRIPTION =
  "TERMINAL_REENTRY_SOURCE_TRAJECTORY_TEME";
const RETIRED_PRODUCT_PATTERN = /(^|[^a-z0-9])obd([^a-z0-9]|$)/iu;
const RAW_EPHEMERIS_PATTERNS = [
  /ephemeris_start:/iu,
  /ephemeris_stop:/iu,
  /number_of_ephemeris_points/iu,
  /meta_start/iu,
  /meta_stop/iu,
];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const publicationCorrelationIndexes = new WeakMap();

const canonicalFsoType = Object.freeze({
  schemaName: "FSO.fbs",
  fileIdentifier: "$FSO",
  schemaVersion: "1.158.2",
  schemaHash:
    "a298ef96af29624073edf749848e8ff1e5b8f45e56966c2e210cb719f3c5e821",
  rootTypeName: "FSO",
  wireFormat: "flatbuffer",
});

const applicationCapabilities = new Map([
  [
    "timer",
    new Set(["clock.now", "timers.arm", "timers.cancel"]),
  ],
  [
    "provider-starlink",
    new Set([
      "http.request",
      "storage.adapter.opaque.read",
      "storage.adapter.opaque.replace",
      "storage.adapter.opaque.sync",
    ]),
  ],
  ["provider-glonass", new Set(["http.request"])],
  ["provider-intelsat", new Set(["http.request"])],
  ["provider-cpf", new Set(["http.request"])],
  ["provider-iss", new Set(["http.request"])],
  ["od", new Set()],
  [
    "store",
    new Set([
      "storage.adapter.opaque.read",
      "storage.adapter.opaque.replace",
      "storage.adapter.opaque.delete",
      "storage.adapter.opaque.sync",
      "storage.adapter.opaque.list",
    ]),
  ],
  ["publication", new Set(["pubsub.publish"])],
  ["status", new Set()],
]);

function toBytes(value, label = "value") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${label} must be Uint8Array-compatible.`);
}

function sha256(bytes) {
  return createHash("sha256").update(toBytes(bytes)).digest("hex");
}

function exactHex(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new TypeError(`${label} must be a 64-character lowercase hex value.`);
  }
  return normalized;
}

function exactNonEmptyString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(textDecoder.decode(toBytes(bytes, label)));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("expected an object");
    }
    return value;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function containsRetiredProduct(value) {
  const text =
    typeof value === "string"
      ? value
      : textDecoder.decode(toBytes(value, "retired-product input"));
  return RETIRED_PRODUCT_PATTERN.test(text);
}

function normalizedTrustedKeys(values) {
  const items =
    typeof values === "string"
      ? values.split(",")
      : Array.isArray(values)
        ? values
        : [];
  const keys = [...new Set(items.map((value) => exactHex(value, "trusted key")))];
  if (keys.length === 0) {
    throw new TypeError("At least one trusted Ed25519 public key is required.");
  }
  return keys;
}

function artifactTreeFor(loaded) {
  return {
    outerSha256: loaded.outerSha256,
    portableWasmSha256: loaded.portableWasmSha256,
    signerPublicKeyHex: loaded.verification.publicKeyHex,
    children: Object.fromEntries(
      [...loaded.children]
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
        .map((child) => [
          child.nodeId,
          {
            pluginId: child.pluginId,
            entryId: child.entryId,
            sha256: child.sha256,
            signerPublicKeyHex: child.verification.publicKeyHex,
          },
        ]),
    ),
  };
}

function readExpectedTree(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    return JSON.parse(fs.readFileSync(path.resolve(value), "utf8"));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expectedTree must be an object or a JSON file path.");
  }
  return value;
}

function assertTreeParity(actual, expectedInput) {
  const expected = readExpectedTree(expectedInput);
  if (!expected) return;
  const failures = [];
  for (const field of [
    "outerSha256",
    "portableWasmSha256",
    "signerPublicKeyHex",
  ]) {
    if (
      expected[field] !== undefined &&
      String(expected[field]).toLowerCase() !== String(actual[field]).toLowerCase()
    ) {
      failures.push(`${field}: expected ${expected[field]}, received ${actual[field]}`);
    }
  }
  if (expected.children !== undefined) {
    const expectedChildren = expected.children ?? {};
    const actualChildren = actual.children ?? {};
    const expectedIds = Object.keys(expectedChildren).sort();
    const actualIds = Object.keys(actualChildren).sort();
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
      failures.push(
        `children: expected [${expectedIds.join(", ")}], received [${actualIds.join(", ")}]`,
      );
    }
    for (const nodeId of expectedIds) {
      const expectedChild = expectedChildren[nodeId];
      const actualChild = actualChildren[nodeId];
      if (!actualChild) continue;
      if (typeof expectedChild === "string") {
        if (expectedChild.toLowerCase() !== actualChild.sha256) {
          failures.push(
            `${nodeId}.sha256: expected ${expectedChild}, received ${actualChild.sha256}`,
          );
        }
        continue;
      }
      for (const field of [
        "pluginId",
        "entryId",
        "sha256",
        "signerPublicKeyHex",
      ]) {
        if (
          expectedChild?.[field] !== undefined &&
          String(expectedChild[field]).toLowerCase() !==
            String(actualChild[field]).toLowerCase()
        ) {
          failures.push(
            `${nodeId}.${field}: expected ${expectedChild[field]}, received ${actualChild[field]}`,
          );
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Artifact tree parity mismatch:\n${failures.join("\n")}`);
  }
}

/**
 * Load and verify one exact signed outer flow. Child bytes are taken only from
 * the signed MBL entries; descriptor paths and sibling files are never read.
 */
export async function loadVerifiedSignedFlow({
  artifactPath,
  artifactBytes,
  trustedPublicKeys,
  expectedTree,
} = {}) {
  const trustedKeys = normalizedTrustedKeys(trustedPublicKeys);
  const outerBytes =
    artifactBytes === undefined
      ? new Uint8Array(fs.readFileSync(path.resolve(artifactPath)))
      : new Uint8Array(toBytes(artifactBytes, "artifactBytes"));
  const outerSha256 = sha256(outerBytes);
  const verification = await verifyModuleArtifact(outerBytes, {
    trustedPublicKeys: trustedKeys,
    requireSignature: true,
  });
  if (!verification.verified || verification.signatureScope !== "bundle") {
    throw new Error("Outer artifact failed whole-bundle signature verification.");
  }

  const parsed = await parseSingleFileBundle(outerBytes);
  const entries = new Map();
  for (const entry of parsed.entries) {
    if (entries.has(entry.entryId)) {
      throw new Error(`Signed outer bundle duplicates entry ${entry.entryId}.`);
    }
    entries.set(entry.entryId, entry);
  }
  const artifactEntry = entries.get("artifact.json");
  if (!artifactEntry) throw new Error("Signed outer bundle has no artifact.json.");
  const artifact = parseJson(artifactEntry.payloadBytes, "artifact.json");
  if (artifact.dispatchModel !== "isomorphic") {
    throw new Error(
      `Signed flow dispatch model must be isomorphic; received ${artifact.dispatchModel}.`,
    );
  }
  const flowEntry = entries.get("flow.plg");
  if (!flowEntry) throw new Error("Signed outer bundle has no flow.plg.");
  if (
    containsRetiredProduct(flowEntry.payloadBytes) ||
    containsRetiredProduct(JSON.stringify(artifact))
  ) {
    throw new Error("Signed flow still contains the retired OBD product.");
  }

  const requiredEntries = artifact.bundle?.requiredEntries;
  if (Array.isArray(requiredEntries)) {
    const missing = requiredEntries.filter((entryId) => !entries.has(entryId));
    const unexpected = [...entries.keys()].filter(
      (entryId) => !requiredEntries.includes(entryId),
    );
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Signed bundle entry mismatch; missing=[${missing.join(", ")}] ` +
          `unexpected=[${unexpected.join(", ")}].`,
      );
    }
  }

  const portableWasmSha256 = exactHex(
    artifact.bundle?.portableWasmSha256 ?? parsed.canonicalModuleHashHex,
    "artifact portable WASM SHA-256",
  );
  if (portableWasmSha256 !== parsed.canonicalModuleHashHex) {
    throw new Error(
      `Portable WASM hash ${portableWasmSha256} does not match signed outer ` +
        `canonical hash ${parsed.canonicalModuleHashHex}.`,
    );
  }

  const descriptors = Array.isArray(artifact.nodeArtifacts)
    ? artifact.nodeArtifacts
    : [];
  if (descriptors.length === 0) {
    throw new Error("Signed flow carries no independently signed child artifacts.");
  }
  const nodeIds = new Set();
  const pluginIds = new Set();
  const entryIds = new Set();
  const children = [];
  for (const descriptor of descriptors) {
    const nodeId = exactNonEmptyString(descriptor.nodeId, "child nodeId");
    const pluginId = exactNonEmptyString(descriptor.pluginId, `${nodeId} pluginId`);
    const entryId = exactNonEmptyString(descriptor.entryId, `${nodeId} entryId`);
    const publisherEntryId = exactNonEmptyString(
      descriptor.publisherEntryId,
      `${nodeId} publisherEntryId`,
    );
    if (
      nodeIds.has(nodeId) ||
      pluginIds.has(pluginId) ||
      entryIds.has(entryId)
    ) {
      throw new Error(`Signed child identity is duplicated for node ${nodeId}.`);
    }
    nodeIds.add(nodeId);
    pluginIds.add(pluginId);
    entryIds.add(entryId);
    const childEntry = entries.get(entryId);
    const publisherEntry = entries.get(publisherEntryId);
    if (!childEntry || !publisherEntry) {
      throw new Error(
        `Signed child ${nodeId} is missing embedded artifact or publisher entry.`,
      );
    }
    const wasmBytes = new Uint8Array(childEntry.payloadBytes);
    const childSha256 = sha256(wasmBytes);
    const declaredSha256 = exactHex(descriptor.sha256, `${nodeId} SHA-256`);
    if (childSha256 !== declaredSha256) {
      throw new Error(
        `Embedded child ${nodeId} hash mismatch: expected ${declaredSha256}, ` +
          `received ${childSha256}.`,
      );
    }
    const publisher = parseJson(
      publisherEntry.payloadBytes,
      `${nodeId} publisher record`,
    );
    const publisherKey = exactHex(
      publisher.publicKeyHex,
      `${nodeId} publisher public key`,
    );
    if (
      descriptor.publisherPublicKeyHex !== undefined &&
      publisherKey !==
        exactHex(
          descriptor.publisherPublicKeyHex,
          `${nodeId} descriptor publisher public key`,
        )
    ) {
      throw new Error(`${nodeId} publisher record does not match its descriptor.`);
    }
    const childVerification = await verifyModuleArtifact(wasmBytes, {
      trustedPublicKeys: trustedKeys,
      requireSignature: true,
    });
    if (
      !childVerification.verified ||
      childVerification.signatureScope !== "bundle" ||
      childVerification.publicKeyHex !== publisherKey
    ) {
      throw new Error(
        `Embedded child ${nodeId} failed independent whole-bundle verification.`,
      );
    }
    children.push({
      ...descriptor,
      nodeId,
      pluginId,
      entryId,
      publisherEntryId,
      sha256: childSha256,
      publisher,
      verification: childVerification,
      wasmBytes,
    });
  }

  const loaded = {
    artifactPath: artifactPath ? path.resolve(artifactPath) : null,
    outerBytes,
    outerSha256,
    portableWasmSha256,
    verification,
    parsed,
    entries,
    artifact,
    children,
    trustedPublicKeys: trustedKeys,
  };
  loaded.tree = artifactTreeFor(loaded);
  assertTreeParity(loaded.tree, expectedTree);
  return loaded;
}

function encodedPathPart(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function decodedPathPart(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function ensureSafeStoragePart(value, label) {
  const normalized = exactNonEmptyString(value, label);
  if (normalized.length > 1024 || normalized.includes("\0")) {
    throw new TypeError(`${label} is outside the bounded opaque adapter contract.`);
  }
  return normalized;
}

function cloneBytes(value, label) {
  return new Uint8Array(toBytes(value, label));
}

function validateStarlinkStorage(nodeId, operation, params, cursorLimit) {
  if (nodeId !== "provider-starlink") return;
  const namespace = ensureSafeStoragePart(params?.namespace, "Starlink namespace");
  if (namespace !== "primary") {
    throw new Error("Starlink may only persist primary/starlink.cursor.v1.");
  }
  if (
    operation !== "storage.adapter.opaque.sync" &&
    operation !== "storage.adapter.opaque.list"
  ) {
    const key = ensureSafeStoragePart(params?.key, "Starlink key");
    if (key !== "starlink.cursor.v1") {
      throw new Error("Starlink may only persist primary/starlink.cursor.v1.");
    }
  }
  if (operation !== "storage.adapter.opaque.replace") return;
  const data = cloneBytes(params?.data, "Starlink cursor");
  if (data.byteLength > cursorLimit) {
    throw new Error(
      `Starlink cursor exceeds ${cursorLimit} byte benchmark bound.`,
    );
  }
  if (
    data.byteLength < 8 ||
    textDecoder.decode(data.subarray(0, 8)) !== "SLCURS01"
  ) {
    throw new Error("Starlink opaque state is not an SLCURS01 cursor.");
  }
  const sample = textDecoder.decode(data);
  if (RAW_EPHEMERIS_PATTERNS.some((pattern) => pattern.test(sample))) {
    throw new Error("Raw Starlink ephemeris bytes may not enter opaque state.");
  }
}

/**
 * A bounded, namespaced byte adapter used by the benchmark only. It gives the
 * independently signed FlatSQL and Starlink children opaque persistence
 * without implementing either node's policy in the host.
 */
export function createFileBackedOpaqueAdapter({
  stateDir,
  maxStarlinkCursorBytes = DEFAULT_CURSOR_LIMIT_BYTES,
} = {}) {
  if (
    !Number.isSafeInteger(maxStarlinkCursorBytes) ||
    maxStarlinkCursorBytes < 8 ||
    maxStarlinkCursorBytes >= 1024 * 1024
  ) {
    throw new RangeError(
      "maxStarlinkCursorBytes must be an integer from 8 through 1 MiB - 1.",
    );
  }
  const root = path.resolve(exactNonEmptyString(stateDir, "stateDir"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const metrics = {
    reads: 0,
    readBytes: 0,
    replaces: 0,
    replacedBytes: 0,
    deletes: 0,
    syncs: 0,
    lists: 0,
    byNode: {},
  };

  function namespaceDirectory(nodeId, namespace) {
    return path.join(
      root,
      encodedPathPart(ensureSafeStoragePart(nodeId, "nodeId")),
      encodedPathPart(ensureSafeStoragePart(namespace, "namespace")),
    );
  }

  function keyPath(nodeId, namespace, key) {
    return path.join(
      namespaceDirectory(nodeId, namespace),
      `${encodedPathPart(ensureSafeStoragePart(key, "key"))}.bin`,
    );
  }

  async function dispatch(nodeIdInput, operationInput, params = {}) {
    const nodeId = ensureSafeStoragePart(nodeIdInput, "nodeId");
    const operation = exactNonEmptyString(operationInput, "opaque operation");
    if (!operation.startsWith("storage.adapter.opaque.")) {
      throw new Error(`Opaque adapter rejects non-storage operation ${operation}.`);
    }
    validateStarlinkStorage(
      nodeId,
      operation,
      params,
      maxStarlinkCursorBytes,
    );
    const namespace = ensureSafeStoragePart(params.namespace, "namespace");
    const directory = namespaceDirectory(nodeId, namespace);
    const nodeMetrics = (metrics.byNode[nodeId] ??= {
      reads: 0,
      readBytes: 0,
      replaces: 0,
      replacedBytes: 0,
      deletes: 0,
      syncs: 0,
      lists: 0,
    });

    if (operation === "storage.adapter.opaque.read") {
      metrics.reads += 1;
      nodeMetrics.reads += 1;
      const filename = keyPath(nodeId, namespace, params.key);
      try {
        const data = new Uint8Array(await fs.promises.readFile(filename));
        metrics.readBytes += data.byteLength;
        nodeMetrics.readBytes += data.byteLength;
        return { found: true, bytes_b64: data };
      } catch (error) {
        if (error?.code === "ENOENT") {
          return { found: false, bytes_b64: new Uint8Array() };
        }
        throw error;
      }
    }
    if (operation === "storage.adapter.opaque.replace") {
      const data = cloneBytes(params.data, "opaque replacement data");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const filename = keyPath(nodeId, namespace, params.key);
      const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
      const handle = await fs.promises.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.promises.rename(temporary, filename);
      } catch (error) {
        await fs.promises.rm(temporary, { force: true });
        throw error;
      }
      metrics.replaces += 1;
      metrics.replacedBytes += data.byteLength;
      nodeMetrics.replaces += 1;
      nodeMetrics.replacedBytes += data.byteLength;
      return { stored_bytes: data.byteLength };
    }
    if (operation === "storage.adapter.opaque.delete") {
      await fs.promises.rm(keyPath(nodeId, namespace, params.key), {
        force: true,
      });
      metrics.deletes += 1;
      nodeMetrics.deletes += 1;
      return { deleted: true };
    }
    if (operation === "storage.adapter.opaque.sync") {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const handle = await fs.promises.open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      metrics.syncs += 1;
      nodeMetrics.syncs += 1;
      return { synced: true };
    }
    if (operation === "storage.adapter.opaque.list") {
      metrics.lists += 1;
      nodeMetrics.lists += 1;
      let names;
      try {
        names = await fs.promises.readdir(directory);
      } catch (error) {
        if (error?.code === "ENOENT") return { keys: [] };
        throw error;
      }
      const keys = names
        .filter((name) => name.endsWith(".bin"))
        .map((name) => decodedPathPart(name.slice(0, -4)))
        .sort();
      return { keys };
    }
    throw new Error(`Unsupported opaque adapter operation ${operation}.`);
  }

  return { root, metrics, dispatch };
}

function ensureMetrics(metrics = {}) {
  metrics.http ??= {
    requests: 0,
    responseBytes: 0,
    requestElapsedMs: 0,
    byNode: {},
  };
  metrics.storage ??= {
    reads: 0,
    readBytes: 0,
    replaces: 0,
    replacedBytes: 0,
    deletes: 0,
    syncs: 0,
    lists: 0,
  };
  metrics.publications ??= {
    OMM: 0,
    OCM: 0,
    OBD: 0,
    terminalOcmOnlyObjects: 0,
    bytes: { OMM: 0, OCM: 0 },
    rmsKm: [],
    iterations: [],
  };
  metrics.publications.OMM ??= 0;
  metrics.publications.OCM ??= 0;
  metrics.publications.OBD ??= 0;
  metrics.publications.terminalOcmOnlyObjects ??= 0;
  metrics.publications.bytes ??= {};
  metrics.publications.bytes.OMM ??= 0;
  metrics.publications.bytes.OCM ??= 0;
  metrics.publications.rmsKm ??= [];
  metrics.publications.iterations ??= [];
  metrics.publications.recordHashes ??= { OMM: [], OCM: [] };
  metrics.publications.correlationHashes ??= { OMM: [], OCM: [] };
  metrics.publications.sources ??= { OMM: [], OCM: [] };
  metrics.publications.terminalOcmOnlyCorrelationHashes ??= [];
  metrics.publications.terminalOcmOnlySources ??= [];
  metrics.hostcalls ??= {};
  metrics.resources ??= [];
  metrics.milestones ??= {};
  return metrics;
}

function publicationCorrelationIndex(publications) {
  let index = publicationCorrelationIndexes.get(publications);
  if (!index) {
    index = {
      accepted: {
        OMM: new Set(publications.correlationHashes.OMM),
        OCM: new Set(publications.correlationHashes.OCM),
      },
      inFlight: {
        OMM: new Set(),
        OCM: new Set(),
      },
    };
    publicationCorrelationIndexes.set(publications, index);
  }
  return index;
}

function eventEmitter(sink) {
  return (event) => {
    if (typeof sink !== "function") return;
    sink({ at: new Date().toISOString(), ...event });
  };
}

async function readBoundedResponse(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (
    Number.isSafeInteger(declared) &&
    declared > 0 &&
    declared > maxBytes
  ) {
    throw new Error(
      `HTTP response declares ${declared} bytes, exceeding ${maxBytes}.`,
    );
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(
        `HTTP response is ${bytes.byteLength} bytes, exceeding ${maxBytes}.`,
      );
    }
    return bytes;
  }
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const bytes = toBytes(value ?? new Uint8Array(), "HTTP response chunk");
    length += bytes.byteLength;
    if (length > maxBytes) {
      await reader.cancel("bounded benchmark response exceeded max_bytes");
      throw new Error(`HTTP response exceeds bounded max_bytes ${maxBytes}.`);
    }
    chunks.push(new Uint8Array(bytes));
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function responseHeaders(response) {
  return Object.fromEntries(
    [...response.headers.entries()].map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
}

function splitSizePrefixedRecords(value) {
  const bytes = toBytes(value, "record stream");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) {
      throw new Error("Record stream ends inside a size prefix.");
    }
    const size = view.getUint32(offset, true);
    const end = offset + 4 + size;
    if (size < 8 || end > bytes.byteLength) {
      throw new Error("Record stream contains an invalid size-prefixed record.");
    }
    records.push(bytes.slice(offset, end));
    offset = end;
  }
  return records;
}

function decodeText(value) {
  return typeof value === "string"
    ? value
    : textDecoder.decode(value ?? new Uint8Array());
}

function normalizedRecordText(value) {
  return decodeText(value).trim();
}

function publicationRecordIdentity(standard, record) {
  let sourceKey;
  let epoch;
  if (standard === "OMM") {
    const norad = Number(record.NORAD_CAT_ID());
    const objectId = normalizedRecordText(record.OBJECT_ID());
    const objectName = normalizedRecordText(record.OBJECT_NAME());
    sourceKey =
      Number.isSafeInteger(norad) && norad > 0
        ? `norad:${norad}`
        : objectId
          ? `object:${objectId}`
          : objectName
            ? `name:${objectName}`
            : "";
    epoch = normalizedRecordText(record.EPOCH());
  } else {
    const metadata = record.METADATA();
    const determination = record.ORBIT_DETERMINATION();
    const catalogName = normalizedRecordText(metadata?.CATALOG_NAME());
    const objectDesignator = normalizedRecordText(
      metadata?.OBJECT_DESIGNATOR(),
    );
    const internationalDesignator = normalizedRecordText(
      metadata?.INTERNATIONAL_DESIGNATOR(),
    );
    const objectName = normalizedRecordText(metadata?.OBJECT_NAME());
    sourceKey = /^\d+$/u.test(catalogName) && Number(catalogName) > 0
      ? `norad:${BigInt(catalogName).toString()}`
      : objectDesignator
        ? `object:${objectDesignator}`
        : internationalDesignator
          ? `object:${internationalDesignator}`
          : objectName
            ? `name:${objectName}`
            : "";
    epoch =
      normalizedRecordText(determination?.OD_EPOCH()) ||
      normalizedRecordText(metadata?.EPOCH_TZERO());
  }
  if (!sourceKey || !epoch) {
    throw new Error(
      `${standard} publication lacks the source identity or epoch required for per-source pairing.`,
    );
  }
  const correlationHash = sha256(
    textEncoder.encode(JSON.stringify([sourceKey, epoch])),
  );
  return { sourceKey, epoch, correlationHash };
}

export function parseOdQualityText({
  residuals = "",
  convergenceCriteria = "",
} = {}) {
  const rmsMatch = String(residuals).match(
    /(?:^|[;\s])WRMS=([0-9.eE+-]+)\s+km(?:;|$)/u,
  );
  const iterationsMatch = String(convergenceCriteria).match(
    /(?:^|;\s*)iterations=(\d+)(?:;|$)/u,
  );
  const convergenceMatches = [
    ...String(convergenceCriteria).matchAll(
      /(?:^|;)\s*converged=(true|false|1|0)\s*(?=;|$)/giu,
    ),
  ];
  const rmsKm = rmsMatch ? Number(rmsMatch[1]) : null;
  const iterations = iterationsMatch ? Number(iterationsMatch[1]) : null;
  const normalizedConvergence = convergenceMatches.length === 1
    ? convergenceMatches[0][1].toLowerCase()
    : undefined;
  return {
    rmsKm: Number.isFinite(rmsKm) ? rmsKm : null,
    iterations: Number.isSafeInteger(iterations) ? iterations : null,
    converged: normalizedConvergence === undefined
      ? null
      : normalizedConvergence === "true" || normalizedConvergence === "1",
  };
}

function isValidatedTerminalReentryOcm(record) {
  if (
    normalizedRecordText(record.TRAJ_TYPE_DESCRIPTION()) !==
    TERMINAL_REENTRY_TRAJECTORY_DESCRIPTION
  ) {
    return false;
  }
  const metadata = record.METADATA();
  const epoch = normalizedRecordText(metadata?.EPOCH_TZERO());
  const start = normalizedRecordText(metadata?.START_TIME());
  const stop = normalizedRecordText(metadata?.STOP_TIME());
  const startMilliseconds = Date.parse(start);
  const stopMilliseconds = Date.parse(stop);
  const stateStepSeconds = Number(record.STATE_STEP_SIZE());
  const stateValueCount = record.stateDataLength();
  const stateCount = stateValueCount / 6;
  const durationSeconds = (stateCount - 1) * stateStepSeconds;
  const timeSpanSeconds = Number(metadata?.TIME_SPAN()) * 86_400;
  const states = record.stateDataArray();
  const terminalStateOffset = stateValueCount - 6;
  const terminalRadiusKm = states
    ? Math.hypot(
        states[terminalStateOffset],
        states[terminalStateOffset + 1],
        states[terminalStateOffset + 2],
      )
    : Number.NaN;
  const maximumTerminalRadiusKm = 6_378.135 + 120;
  if (
    record.TRAJ_TYPE() !== trajectoryType.CARTESIAN_PV ||
    record.STATE_VECTOR_SIZE() !== 6 ||
    !Number.isFinite(stateStepSeconds) ||
    stateStepSeconds <= 0 ||
    stateValueCount < 18 ||
    stateValueCount % 6 !== 0 ||
    !states?.every(Number.isFinite) ||
    record.covarianceDataLength() !== 0 ||
    record.ORBIT_DETERMINATION() !== null ||
    !epoch ||
    epoch !== start ||
    !Number.isFinite(startMilliseconds) ||
    !Number.isFinite(stopMilliseconds) ||
    stopMilliseconds <= startMilliseconds ||
    !Number.isFinite(timeSpanSeconds) ||
    timeSpanSeconds <= 0 ||
    !Number.isFinite(terminalRadiusKm) ||
    terminalRadiusKm > maximumTerminalRadiusKm + 1e-6 ||
    Math.abs(
      (stopMilliseconds - startMilliseconds) / 1_000 - durationSeconds,
    ) > 0.001 ||
    Math.abs(timeSpanSeconds - durationSeconds) > 0.001
  ) {
    throw new Error(
      "Terminal reentry OCM requires complete Cartesian-PV state metadata, " +
        "a final state at or below the WGS-72 120 km reentry interface, " +
        "no covariance, and no orbit-determination block.",
    );
  }
  return true;
}

function inspectPublication(standardInput, payload) {
  const standard = String(standardInput ?? "").trim().toUpperCase();
  if (standard === "OBD") {
    throw new Error("OBD is retired and must never be published.");
  }
  if (standard !== "OMM" && standard !== "OCM") {
    throw new Error(`Unexpected Supplemental OMM publication standard ${standard}.`);
  }
  const records = splitSizePrefixedRecords(payload);
  const expectedIdentifier = `$${standard}`;
  const rmsKm = [];
  const iterations = [];
  const details = [];
  let terminalOcmOnlyObjects = 0;
  for (const recordBytes of records) {
    const buffer = new ByteBuffer(recordBytes);
    buffer.setPosition(4);
    if (!buffer.__has_identifier(expectedIdentifier)) {
      throw new Error(
        `${standard} publication contains a record without ${expectedIdentifier}.`,
      );
    }
    buffer.setPosition(0);
    if (standard === "OMM") {
      const record = OMM.getSizePrefixedRootAsOMM(buffer);
      details.push({
        ...publicationRecordIdentity(standard, record),
        recordHash: sha256(recordBytes),
      });
      continue;
    }
    const record = OCM.getSizePrefixedRootAsOCM(buffer);
    if (isValidatedTerminalReentryOcm(record)) {
      terminalOcmOnlyObjects += 1;
      details.push({
        ...publicationRecordIdentity(standard, record),
        recordHash: sha256(recordBytes),
        terminalOcmOnly: true,
      });
      continue;
    }
    const quality = parseOdQualityText({
      residuals: decodeText(record.ORBIT_DETERMINATION()?.OD_RESIDUALS()),
      convergenceCriteria: decodeText(
        record.ORBIT_DETERMINATION()?.OD_CONVERGENCE_CRITERIA(),
      ),
    });
    if (
      quality.rmsKm === null ||
      quality.rmsKm < 0 ||
      quality.iterations === null ||
      quality.iterations < 0 ||
      quality.iterations > 60
    ) {
      throw new Error(
        "Every published OCM requires finite WRMS and iteration metrics within the 60-iteration fit cap.",
      );
    }
    if (quality.rmsKm >= 12) {
      throw new Error("Every published OCM requires WRMS below 12 km.");
    }
    if (quality.converged !== true) {
      throw new Error(
        "Every published nonterminal OCM requires converged=true.",
      );
    }
    rmsKm.push(quality.rmsKm);
    iterations.push(quality.iterations);
    details.push({
      ...publicationRecordIdentity(standard, record),
      recordHash: sha256(recordBytes),
    });
  }
  return {
    standard,
    records: records.length,
    rmsKm,
    iterations,
    details,
    terminalOcmOnlyObjects,
  };
}

/**
 * Build the only host dispatcher used by the local benchmark. Capabilities are
 * explicit per signed node; there is no general application control plane.
 */
export function createMeasuredDispatch({
  nodeId,
  opaqueAdapter,
  metrics: metricsInput,
  fetchImpl = globalThis.fetch,
  publishImpl,
  now = Date.now,
  eventSink,
  signal,
} = {}) {
  const allowed = applicationCapabilities.get(nodeId);
  if (!allowed) {
    throw new Error(`Benchmark has no application-scoped capability set for ${nodeId}.`);
  }
  const metrics = ensureMetrics(metricsInput);
  const emit = eventEmitter(eventSink);
  return async function dispatch(operation, params = {}) {
    signal?.throwIfAborted();
    if (!allowed.has(operation)) {
      throw new Error(`Operation ${operation} is not allowed for signed node ${nodeId}.`);
    }
    metrics.hostcalls[operation] = (metrics.hostcalls[operation] ?? 0) + 1;

    if (operation === "clock.now") return Number(now());
    if (operation === "timers.arm" || operation === "timers.cancel") {
      return { accepted: true };
    }
    if (operation === "http.request") {
      if (typeof fetchImpl !== "function") {
        throw new TypeError("A fetch implementation is required for HTTP nodes.");
      }
      const url = exactNonEmptyString(params.url, "HTTP URL");
      const method = String(params.method ?? "GET").toUpperCase();
      const maxBytes = Number(params.max_bytes ?? params.maxBytes ?? 64 * 1024 * 1024);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new RangeError("HTTP max_bytes must be a positive safe integer.");
      }
      const startedAt = performance.now();
      const response = await fetchImpl(url, {
        method,
        headers: params.headers,
        ...(params.body instanceof Uint8Array ? { body: params.body } : {}),
        ...(signal ? { signal } : {}),
      });
      const body = await readBoundedResponse(response, maxBytes);
      const elapsedMs = performance.now() - startedAt;
      metrics.http.requests += 1;
      metrics.http.responseBytes += body.byteLength;
      metrics.http.requestElapsedMs += elapsedMs;
      const perNode = (metrics.http.byNode[nodeId] ??= {
        requests: 0,
        responseBytes: 0,
        elapsedMs: 0,
      });
      perNode.requests += 1;
      perNode.responseBytes += body.byteLength;
      perNode.elapsedMs += elapsedMs;
      if (nodeId === "provider-starlink") {
        const isManifest = /\/MANIFEST\.txt(?:[?#]|$)/u.test(url);
        if (isManifest) {
          metrics.milestones.starlinkManifestFetchedAtMs ??= Date.now();
        } else {
          metrics.milestones.firstStarlinkEphemerisFetchedAtMs ??= Date.now();
          metrics.milestones.lastStarlinkEphemerisFetchedAtMs = Date.now();
          metrics.starlinkHttpFiles = (metrics.starlinkHttpFiles ?? 0) + 1;
        }
      }
      emit({
        kind: "http",
        nodeId,
        url,
        status: response.status,
        bytes: body.byteLength,
        elapsedMs,
      });
      return {
        status: response.status,
        headers: responseHeaders(response),
        body,
      };
    }
    if (operation.startsWith("storage.adapter.opaque.")) {
      if (!opaqueAdapter?.dispatch) {
        throw new Error("Opaque persistence adapter is required.");
      }
      const result = await opaqueAdapter.dispatch(nodeId, operation, params);
      Object.assign(metrics.storage, opaqueAdapter.metrics);
      emit({
        kind: "storage",
        nodeId,
        operation,
        namespace: params.namespace ?? null,
        key: params.key ?? null,
        bytes: params.data?.byteLength ?? result?.bytes_b64?.byteLength ?? 0,
      });
      return result;
    }
    if (operation === "pubsub.publish") {
      const data = cloneBytes(params.data, "publication data");
      const inspected = inspectPublication(params.standard, data);
      const correlationIndex =
        publicationCorrelationIndex(metrics.publications);
      const acceptedCorrelations =
        correlationIndex.accepted[inspected.standard];
      const inFlightCorrelations =
        correlationIndex.inFlight[inspected.standard];
      const pendingCorrelations = new Set();
      for (const detail of inspected.details) {
        if (
          acceptedCorrelations.has(detail.correlationHash) ||
          inFlightCorrelations.has(detail.correlationHash) ||
          pendingCorrelations.has(detail.correlationHash)
        ) {
          throw new Error(
            `Duplicate ${inspected.standard} publication for one source and epoch.`,
          );
        }
        pendingCorrelations.add(detail.correlationHash);
      }
      for (const correlationHash of pendingCorrelations) {
        inFlightCorrelations.add(correlationHash);
      }
      try {
        const published =
          typeof publishImpl === "function"
            ? await publishImpl(params, inspected)
            : true;
        if (published !== true) return published;
        metrics.publications[inspected.standard] += inspected.records;
        metrics.publications.terminalOcmOnlyObjects +=
          inspected.terminalOcmOnlyObjects;
        metrics.publications.bytes[inspected.standard] += data.byteLength;
        metrics.publications.rmsKm.push(...inspected.rmsKm);
        metrics.publications.iterations.push(...inspected.iterations);
        metrics.publications.recordHashes[inspected.standard].push(
          ...inspected.details.map((detail) => detail.recordHash),
        );
        metrics.publications.correlationHashes[inspected.standard].push(
          ...inspected.details.map((detail) => detail.correlationHash),
        );
        metrics.publications.sources[inspected.standard].push(
          ...inspected.details.map(({ sourceKey, epoch }) => ({
            sourceKey,
            epoch,
          })),
        );
        const terminalDetails = inspected.details.filter(
          ({ terminalOcmOnly }) => terminalOcmOnly === true,
        );
        metrics.publications.terminalOcmOnlyCorrelationHashes.push(
          ...terminalDetails.map(({ correlationHash }) => correlationHash),
        );
        metrics.publications.terminalOcmOnlySources.push(
          ...terminalDetails.map(({ sourceKey, epoch }) => ({
            sourceKey,
            epoch,
          })),
        );
        for (const correlationHash of pendingCorrelations) {
          acceptedCorrelations.add(correlationHash);
        }
        emit({
          kind: "publication",
          nodeId,
          standard: inspected.standard,
          records: inspected.records,
          bytes: data.byteLength,
          maxRmsKm:
            inspected.rmsKm.length > 0 ? Math.max(...inspected.rmsKm) : null,
          maxIterations:
            inspected.iterations.length > 0
              ? Math.max(...inspected.iterations)
              : null,
        });
        return true;
      } finally {
        for (const correlationHash of pendingCorrelations) {
          inFlightCorrelations.delete(correlationHash);
        }
      }
    }
    throw new Error(`Unhandled allowed operation ${operation}.`);
  };
}

function frameU32(value, label) {
  const numeric = Number(value ?? 0);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0xffffffff) {
    throw new RangeError(`${label} must fit an unsigned 32-bit integer.`);
  }
  return numeric;
}

function childRequestFrame(frame) {
  if (frame?.wireFormat === "aligned-binary") {
    throw new Error(
      "Separate worker children require canonical FlatBuffer fallback.",
    );
  }
  return {
    portId: frame.portId,
    typeRef: frame.typeRef,
    payload: frame.bytes,
    streamId: frameU32(frame.streamId, "input streamId"),
    sequence: frameU32(frame.sequence, "input sequence"),
    endOfStream: frame.endOfStream,
    frameId: frame.frameId,
    ownership: "host-owned",
    mutability: "immutable",
  };
}

function flowOutputFrame(frame) {
  const wireFormat = frame?.typeRef?.wireFormat ?? frame?.wireFormat ?? "flatbuffer";
  if (wireFormat === "aligned-binary") {
    throw new Error(
      "Separate worker children must emit canonical FlatBuffer fallback.",
    );
  }
  return {
    portId: frame.portId,
    typeRef: frame.typeRef,
    bytes: frame.payload,
    wireFormat,
    streamId: frameU32(frame.streamId, "output streamId"),
    sequence: frameU32(frame.sequence, "output sequence"),
    endOfStream: frame.endOfStream,
    frameId: frame.frameId,
    ownership: "host-owned",
    mutability: "immutable",
  };
}

function destroyWorkerRecord(record) {
  record.destroyPromise ??= Promise.resolve().then(() =>
    record.harness.destroy(),
  );
  return record.destroyPromise;
}

async function destroyWorkerRecords(records) {
  const results = await Promise.allSettled(
    [...records].map((record) => destroyWorkerRecord(record)),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Multiple worker harnesses failed to destroy.");
  }
}

/**
 * Instantiate the compiled parent and every exact embedded child in a worker.
 * The parent retains all graph/scheduling policy; handlers only translate
 * canonical frames and dispatch explicitly granted host capabilities.
 */
export async function instantiateWorkerChildren(
  verifiedFlow,
  {
    createParentHost = createFlowRuntimeHost,
    createWorkerHarness = createWorkerModuleHarness,
    dispatchFactory,
    observer,
    invocationTimeoutMs = DEFAULT_CHILD_INVOKE_TIMEOUT_MS,
    signal: suppliedSignal,
    abortController: suppliedAbortController,
  } = {},
) {
  positiveDeadline(invocationTimeoutMs, "child invocationTimeoutMs");
  const abortController = suppliedAbortController ?? new AbortController();
  const signal = suppliedSignal ?? abortController.signal;
  signal.throwIfAborted();
  const parent = await createParentHost({
    wasmSource: verifiedFlow.outerBytes,
    signal,
  });
  const declared = new Map();
  for (let index = 0; index < parent.dependencyCount; index += 1) {
    const descriptor = parent.getDependencyDescriptor(index);
    if (declared.has(descriptor.pluginId)) {
      throw new Error(`Parent duplicates dependency ${descriptor.pluginId}.`);
    }
    declared.set(descriptor.pluginId, descriptor);
  }
  const children = new Map();
  const handlers = {};
  let fatalError = null;
  try {
    for (const child of verifiedFlow.children) {
      const descriptor = declared.get(child.pluginId);
      if (!descriptor || descriptor.sha256 !== child.sha256) {
        throw new Error(
          `Parent dependency mismatch for embedded child ${child.nodeId}.`,
        );
      }
      const dispatch =
        typeof dispatchFactory === "function"
          ? dispatchFactory(child)
          : undefined;
      const workerOptions = {
        wasmSource: child.wasmBytes,
        signal,
        harnessOptions: {
          verifySignature: {
            trustedPublicKeys: verifiedFlow.trustedPublicKeys,
            requireSignature: true,
          },
        },
        ...(dispatch ? { dispatchHost: dispatch } : {}),
        ...(child.nodeId === "provider-starlink"
          ? {
              maxHostcallResponseBytes: STARLINK_RESPONSE_BUFFER_BYTES,
              hostcallTimeoutMs: STARLINK_HOSTCALL_TIMEOUT_MS,
            }
          : {}),
      };
      const harness = await createWorkerHarness(workerOptions);
      const record = { ...child, harness, destroyPromise: null };
      children.set(child.pluginId, record);
      handlers[child.pluginId] = async (invocation) => {
        try {
          await observer?.onInvocationStart?.({
            child,
            ...invocation,
          });
          const startedAt = performance.now();
          const response = await withDeadline(
            `${child.nodeId} child invocation`,
            invocationTimeoutMs,
            () =>
              harness.invoke({
                methodId: invocation.methodId,
                inputs: invocation.frames.map(childRequestFrame),
                signal,
              }),
            {
              signal,
              onTimeout(error) {
                if (!abortController.signal.aborted) {
                  abortController.abort(error);
                }
                return destroyWorkerRecord(record);
              },
            },
          );
          if (response.statusCode !== 0) {
            throw new Error(
              `${child.nodeId} returned status ${response.statusCode}: ` +
                `${response.errorCode ?? ""} ${response.errorMessage ?? ""}`,
            );
          }
          await observer?.onInvocationEnd?.({
            child,
            ...invocation,
            elapsedMs: performance.now() - startedAt,
            response,
          });
          return {
            statusCode: response.statusCode,
            yielded: response.yielded,
            backlogRemaining: response.backlogRemaining,
            outputs: response.outputs.map(flowOutputFrame),
            errorCode: response.errorCode,
            errorMessage: response.errorMessage,
          };
        } catch (error) {
          fatalError ??= error;
          throw error;
        }
      };
    }
    for (let index = 0; index < parent.nodeCount; index += 1) {
      const descriptor = parent.getNodeDispatchDescriptor(index);
      if (
        descriptor.dispatchModel === "isomorphic" &&
        !children.has(descriptor.pluginId)
      ) {
        throw new Error(
          `Parent node ${descriptor.nodeId} lacks its exact embedded child.`,
        );
      }
    }
  } catch (error) {
    try {
      await destroyWorkerRecords(children.values());
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Worker child initialization cleanup failed.",
      );
    }
    throw error;
  }

  return {
    ...parent,
    parent,
    children,
    async drain(options = {}) {
      if (fatalError) throw fatalError;
      const result = await parent.drain(handlers, options);
      if (fatalError) throw fatalError;
      return result;
    },
    async destroy() {
      await destroyWorkerRecords(children.values());
    },
  };
}

export function sampleSelfResources() {
  const memory = process.memoryUsage();
  const usage = process.resourceUsage();
  const cpu = process.cpuUsage();
  return {
    atMs: Date.now(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    highWaterRssBytes: usage.maxRSS * 1024,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
  };
}

function parseKeyValueFile(text) {
  const values = {};
  for (const line of String(text).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function parseKiB(value) {
  const match = String(value ?? "").match(/^(\d+)\s+kB$/u);
  return match ? Number(match[1]) * 1024 : null;
}

export async function sampleLinuxProcess({ pid, procRoot = "/proc" } = {}) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid < 1) {
    throw new RangeError("Linux process pid must be a positive integer.");
  }
  const directory = path.join(path.resolve(procRoot), String(numericPid));
  const [statText, statusText, ioText] = await Promise.all([
    fs.promises.readFile(path.join(directory, "stat"), "utf8"),
    fs.promises.readFile(path.join(directory, "status"), "utf8"),
    fs.promises.readFile(path.join(directory, "io"), "utf8"),
  ]);
  const close = statText.lastIndexOf(")");
  if (close < 0) throw new Error(`Invalid ${numericPid}/stat process name.`);
  const stat = statText.slice(close + 1).trim().split(/\s+/u);
  if (stat.length < 13) throw new Error(`Invalid ${numericPid}/stat field count.`);
  const status = parseKeyValueFile(statusText);
  const io = parseKeyValueFile(ioText);
  return {
    atMs: Date.now(),
    pid: numericPid,
    state: stat[0],
    cpuUserTicks: Number(stat[11]),
    cpuSystemTicks: Number(stat[12]),
    rssBytes: parseKiB(status.VmRSS),
    highWaterRssBytes: parseKiB(status.VmHWM),
    threads: Number(status.Threads),
    io: {
      rchar: Number(io.rchar ?? 0),
      wchar: Number(io.wchar ?? 0),
      readBytes: Number(io.read_bytes ?? 0),
      writeBytes: Number(io.write_bytes ?? 0),
    },
  };
}

export function decodeDssRoutePayload(value) {
  const bytes = toBytes(value, "DSS route payload");
  const fsbBuffer = new ByteBuffer(bytes);
  if (!FSB.bufferHasIdentifier(fsbBuffer)) {
    throw new Error("Runtime DSS route is not a canonical $FSB frame.");
  }
  const envelope = FSB.getRootAsFSB(fsbBuffer);
  if (
    envelope.SCHEMA_NAME() !== "DSS.fbs" ||
    envelope.FILE_IDENTIFIER() !== "$DSS"
  ) {
    throw new Error("Runtime route does not carry canonical DSS data.");
  }
  const dssBytes = new Uint8Array(envelope.dataArray() ?? []);
  if (textDecoder.decode(dssBytes.subarray(8, 12)) !== "$DSS") {
    throw new Error("Runtime route DSS identifier mismatch.");
  }
  const record = DSS.getSizePrefixedRootAsDSS(new ByteBuffer(dssBytes));
  return {
    status: record.STATUS(),
    syncedRows: record.SYNCED_ROWS(),
    totalRows: record.TOTAL_ROWS(),
    localRows: record.LOCAL_ROWS(),
    pinnedRows: record.PINNED_ROWS(),
    missingRows: record.MISSING_ROWS(),
    downloadedBytes: record.DOWNLOADED_BYTES(),
    cachedBytes: record.CACHED_BYTES(),
    lastSyncedAt: record.LAST_SYNCED_AT() ?? "",
    error: record.ERROR() ?? "",
  };
}

function finiteSummary(values) {
  const finite = (values ?? []).filter(Number.isFinite);
  if (finite.length === 0) return { count: 0, min: null, mean: null, max: null };
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    count: finite.length,
    min: Math.min(...finite),
    mean: total / finite.length,
    max: Math.max(...finite),
  };
}

function numericBigInt(value) {
  const candidate = typeof value === "bigint" ? value : BigInt(value ?? 0);
  return candidate <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(candidate)
    : candidate.toString();
}

function finiteDelta(first, last, field) {
  const left = Number(first?.[field]);
  const right = Number(last?.[field]);
  return Number.isFinite(left) && Number.isFinite(right) ? right - left : null;
}

function publicationProductTotals(
  publications,
  { requireOutput = false } = {},
) {
  const OMM = Number(publications?.OMM ?? 0);
  const OCM = Number(publications?.OCM ?? 0);
  const terminalOcmOnlyObjects = Number(
    publications?.terminalOcmOnlyObjects ?? 0,
  );
  if (
    !Number.isSafeInteger(OMM) ||
    OMM < 0 ||
    !Number.isSafeInteger(OCM) ||
    OCM < 0 ||
    !Number.isSafeInteger(terminalOcmOnlyObjects) ||
    terminalOcmOnlyObjects < 0 ||
    OCM !== OMM + terminalOcmOnlyObjects ||
    (requireOutput && OCM < 1)
  ) {
    throw new Error(
      "Publication totals must contain one OCM per paired OMM plus each " +
        "validated terminal OCM-only object.",
    );
  }
  return { OMM, OCM, terminalOcmOnlyObjects };
}

export function assertPublicationPairing(
  publications,
  { requireDetails = false } = {},
) {
  const totals = publicationProductTotals(publications);
  const omm = [...(publications?.correlationHashes?.OMM ?? [])].sort();
  const ocm = [...(publications?.correlationHashes?.OCM ?? [])].sort();
  const terminal = [
    ...(publications?.terminalOcmOnlyCorrelationHashes ?? []),
  ].sort();
  const ommSet = new Set(omm);
  const ocmSet = new Set(ocm);
  const terminalSet = new Set(terminal);
  const pairedOcm = ocm.filter((hash) => !terminalSet.has(hash));
  const terminalSources = (publications?.terminalOcmOnlySources ?? []).map(
    ({ sourceKey }) =>
      exactNonEmptyString(sourceKey, "terminal OCM-only publication source"),
  );
  const ommSources = new Set(
    (publications?.sources?.OMM ?? []).map(({ sourceKey }) => sourceKey),
  );
  if (
    (requireDetails &&
      (omm.length !== totals.OMM ||
        ocm.length !== totals.OCM ||
        terminal.length !== totals.terminalOcmOnlyObjects ||
        terminalSources.length !== totals.terminalOcmOnlyObjects)) ||
    ommSet.size !== omm.length ||
    ocmSet.size !== ocm.length ||
    terminalSet.size !== terminal.length ||
    terminal.some((hash) => !ocmSet.has(hash) || ommSet.has(hash)) ||
    new Set(terminalSources).size !== terminalSources.length ||
    terminalSources.some((sourceKey) => ommSources.has(sourceKey)) ||
    omm.length !== pairedOcm.length ||
    omm.some((value, index) => value !== pairedOcm[index])
  ) {
    throw new Error(
      "OMM/OCM source/epoch pairing is incomplete, duplicated, or mismatched.",
    );
  }
  const uniqueSources = new Set(
    [
      ...(publications?.sources?.OMM ?? []),
      ...(publications?.sources?.OCM ?? []),
    ].map((entry) => entry.sourceKey),
  );
  return {
    pairedRecords: omm.length,
    terminalOcmOnlyObjects: terminal.length,
    totalOcmRecords: ocm.length,
    uniqueSources: uniqueSources.size,
    correlationDigest:
      ocm.length > 0 ? sha256(textEncoder.encode(ocm.join("\n"))) : null,
  };
}

function starlinkSourceKey(schemaNameInput) {
  const schemaName = String(schemaNameInput ?? "").trim();
  const match = /^MEME:([1-9]\d*):(.+)$/u.exec(schemaName);
  if (!match) {
    throw new Error(
      `Starlink provider emitted an invalid source identity ${schemaName || "<empty>"}.`,
    );
  }
  const norad = BigInt(match[1]);
  if (norad > 0xffffffffn || !match[2].trim()) {
    throw new Error(`Starlink provider source identity is outside its bounds: ${schemaName}.`);
  }
  return `norad:${norad.toString()}`;
}

function publicationSourceSet(publications, standard) {
  return new Set(
    (publications?.sources?.[standard] ?? []).map(({ sourceKey }) =>
      exactNonEmptyString(sourceKey, `${standard} publication source`),
    ),
  );
}

function assertStarlinkSourceCoverage({
  expectedSources,
  incompleteStreams = 0,
  publications,
  totalRows,
}) {
  const expected = [...expectedSources].sort();
  const planned = BigInt(totalRows ?? 0);
  if (
    planned < 1n ||
    planned > BigInt(Number.MAX_SAFE_INTEGER) ||
    incompleteStreams !== 0 ||
    expected.length !== Number(planned)
  ) {
    throw new Error(
      "Starlink source coverage does not contain one complete provider-derived identity per planned source.",
    );
  }
  const ommSources = publicationSourceSet(publications, "OMM");
  const ocmSources = publicationSourceSet(publications, "OCM");
  const terminalSources = new Set(
    (publications?.terminalOcmOnlySources ?? []).map(({ sourceKey }) =>
      exactNonEmptyString(sourceKey, "terminal OCM-only publication source"),
    ),
  );
  const invalidTerminalSource = [...terminalSources].find(
    (source) => !ocmSources.has(source) || ommSources.has(source),
  );
  const missingOmm = expected.filter(
    (source) => !ommSources.has(source) && !terminalSources.has(source),
  );
  const missingOcm = expected.filter((source) => !ocmSources.has(source));
  if (invalidTerminalSource || missingOmm.length > 0 || missingOcm.length > 0) {
    throw new Error(
      "Starlink source coverage is incomplete: " +
        `missing OMM=${missingOmm.length}, missing OCM=${missingOcm.length}.`,
    );
  }
  return {
    expectedSources: expected.length,
    coveredOmmSources: expected.filter((source) => ommSources.has(source))
      .length,
    coveredOcmSources: expected.length - missingOcm.length,
    terminalOcmOnlySources: expected.filter((source) =>
      terminalSources.has(source)
    ).length,
    sourceIdentityDigest: sha256(textEncoder.encode(expected.join("\n"))),
  };
}

export function summarizeBenchmark(metricsInput = {}) {
  const metrics = ensureMetrics(metricsInput);
  const hasCorrelationDetails =
    metrics.publications.correlationHashes.OMM.length > 0 ||
    metrics.publications.correlationHashes.OCM.length > 0;
  const publicationPairing = hasCorrelationDetails
    ? assertPublicationPairing(metrics.publications)
    : null;
  const elapsedMs = Math.max(
    0,
    Number(metrics.finishedAtMs ?? Date.now()) -
      Number(metrics.startedAtMs ?? Date.now()),
  );
  const elapsedSeconds = elapsedMs / 1000;
  const starlink = metrics.starlink ?? {};
  const syncedRows = BigInt(starlink.syncedRows ?? 0);
  const downloadedBytes = BigInt(starlink.downloadedBytes ?? 0);
  const baseline = metrics.starlinkBaseline ?? {};
  const baselineSyncedRows = BigInt(baseline.syncedRows ?? 0);
  const baselineDownloadedBytes = BigInt(baseline.downloadedBytes ?? 0);
  const observedSyncedRows = syncedRows - baselineSyncedRows;
  const observedDownloadedBytes = downloadedBytes - baselineDownloadedBytes;
  if (observedSyncedRows < 0n || observedDownloadedBytes < 0n) {
    throw new Error("Starlink counters regressed below the observed benchmark baseline.");
  }
  const throughputElapsedMs = Math.max(
    0,
    Number(metrics.finishedAtMs ?? Date.now()) -
      Number(metrics.throughputStartedAtMs ?? metrics.startedAtMs ?? Date.now()),
  );
  const throughputElapsedSeconds = throughputElapsedMs / 1000;
  const resources = metrics.resources ?? [];
  const firstResource = resources[0] ?? null;
  const lastResource = resources.at(-1) ?? null;
  return {
    mode: metrics.mode ?? "local",
    artifact: metrics.artifact ?? null,
    startedAtMs: metrics.startedAtMs ?? null,
    finishedAtMs: metrics.finishedAtMs ?? null,
    elapsedMs,
    elapsedSeconds,
    milestones: metrics.milestones ?? {},
    starlink: {
      syncedRows: numericBigInt(syncedRows),
      totalRows: numericBigInt(starlink.totalRows ?? 0),
      missingRows: numericBigInt(starlink.missingRows ?? 0),
      downloadedBytes: numericBigInt(downloadedBytes),
      baselineSyncedRows: numericBigInt(baselineSyncedRows),
      baselineDownloadedBytes: numericBigInt(baselineDownloadedBytes),
      observedSyncedRows: numericBigInt(observedSyncedRows),
      observedDownloadedBytes: numericBigInt(observedDownloadedBytes),
      throughputElapsedMs,
      throughputElapsedSeconds,
      runClassification: metrics.runClassification ?? "fresh-run",
      freshRunThroughput: metrics.freshRunThroughput ?? true,
      filesPerSecond:
        throughputElapsedSeconds > 0
          ? Number(observedSyncedRows) / throughputElapsedSeconds
          : 0,
      bytesPerSecond:
        throughputElapsedSeconds > 0
          ? Number(observedDownloadedBytes) / throughputElapsedSeconds
          : 0,
    },
    publications: {
      OMM: metrics.publications.OMM,
      OCM: metrics.publications.OCM,
      OBD: metrics.publications.OBD,
      terminalOcmOnlyObjects:
        metrics.publications.terminalOcmOnlyObjects,
      bytes: metrics.publications.bytes,
      rmsKm: finiteSummary(metrics.publications.rmsKm),
      iterations: finiteSummary(metrics.publications.iterations),
      pairing: publicationPairing,
      starlinkSourceCoverage: metrics.starlinkSourceCoverage ?? null,
    },
    http: metrics.http,
    storage: metrics.storage,
    resources: {
      samples: resources.length,
      maxRssBytes:
        resources.length > 0
          ? Math.max(...resources.map((sample) => sample.rssBytes ?? 0))
          : null,
      highWaterRssBytes:
        resources.length > 0
          ? Math.max(
              ...resources.map((sample) => sample.highWaterRssBytes ?? 0),
            )
          : null,
      cpuUserDeltaMicros: finiteDelta(
        firstResource,
        lastResource,
        "cpuUserMicros",
      ),
      cpuSystemDeltaMicros: finiteDelta(
        firstResource,
        lastResource,
        "cpuSystemMicros",
      ),
      cpuUserDeltaTicks: finiteDelta(
        firstResource,
        lastResource,
        "cpuUserTicks",
      ),
      cpuSystemDeltaTicks: finiteDelta(
        firstResource,
        lastResource,
        "cpuSystemTicks",
      ),
      ioReadBytesDelta:
        Number.isFinite(Number(firstResource?.io?.readBytes)) &&
        Number.isFinite(Number(lastResource?.io?.readBytes))
          ? Number(lastResource.io.readBytes) - Number(firstResource.io.readBytes)
          : null,
      ioWriteBytesDelta:
        Number.isFinite(Number(firstResource?.io?.writeBytes)) &&
        Number.isFinite(Number(lastResource?.io?.writeBytes))
          ? Number(lastResource.io.writeBytes) -
            Number(firstResource.io.writeBytes)
          : null,
      last: lastResource,
    },
    flatsqlReload: metrics.flatsqlReload ?? null,
    flow: metrics.flow ?? null,
    telemetryLimitations: [...(metrics.telemetryLimitations ?? [])],
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveDeadline(value, label) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new RangeError(`${label} must be a positive finite number.`);
  }
  return milliseconds;
}

export async function withDeadline(
  label,
  timeoutMs,
  operation,
  {
    onTimeout,
    onAbort,
    onLateResolve,
    onLateCleanupError,
    signal,
  } = {},
) {
  const name = exactNonEmptyString(label, "deadline label");
  const milliseconds = positiveDeadline(timeoutMs, `${name} deadline`);
  const cleanupTimeoutMs = Math.max(50, Math.min(1_000, milliseconds));
  if (typeof operation !== "function") {
    throw new TypeError(`${name} deadline operation must be a function.`);
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError(`${name} deadline signal must be an AbortSignal.`);
  }
  let timer;
  let abortListener;
  let cancelled = false;
  let completed = false;
  let rejectCancellation;
  let lateCleanupPromise;
  const cancellation = new Promise((_, reject) => {
    rejectCancellation = reject;
  });
  const operationPromise = Promise.resolve().then(() => operation(signal));
  const guardedOperation = operationPromise.then(
    (value) => {
      if (cancelled) return new Promise(() => {});
      completed = true;
      return value;
    },
    (error) => {
      if (cancelled) return new Promise(() => {});
      completed = true;
      throw error;
    },
  );
  const reportDetachedCleanupError = (context, cleanupError) => {
    if (typeof onLateCleanupError === "function") {
      try {
        onLateCleanupError(cleanupError);
      } catch (reportError) {
        process.emitWarning(
          `${name} ${context} reporter failed: ` +
            `${reportError?.message ?? reportError}`,
        );
      }
      return;
    }
    process.emitWarning(
      `${name} ${context} failed after its bounded teardown: ` +
        `${cleanupError?.message ?? cleanupError}`,
    );
  };
  const awaitCancellationCleanup = async (cleanup, error) => {
    if (typeof cleanup !== "function") return;
    const timeoutMarker = Symbol("cancellation cleanup timeout");
    const cleanupPromise = Promise.resolve().then(() => cleanup(error));
    let cleanupTimer;
    let outcome;
    try {
      outcome = await Promise.race([
        cleanupPromise.then(() => null),
        new Promise((resolve) => {
          cleanupTimer = setTimeout(
            () => resolve(timeoutMarker),
            cleanupTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
    if (outcome !== timeoutMarker) return;
    cleanupPromise.catch((cleanupError) =>
      reportDetachedCleanupError("cancellation cleanup", cleanupError),
    );
    throw new Error(
      `${name} cancellation cleanup did not settle within ` +
        `${cleanupTimeoutMs} ms.`,
    );
  };
  const runLateCleanup = () => {
    lateCleanupPromise ??= (async () => {
      let value;
      try {
        value = await operationPromise;
      } catch {
        return;
      }
      await onLateResolve(value);
    })();
    return lateCleanupPromise;
  };
  const awaitLateCleanup = async () => {
    if (typeof onLateResolve !== "function") return;
    const timeoutMarker = Symbol("late cleanup timeout");
    let cleanupTimer;
    let outcome;
    try {
      outcome = await Promise.race([
        runLateCleanup().then(() => null),
        new Promise((resolve) => {
          cleanupTimer = setTimeout(
            () => resolve(timeoutMarker),
            cleanupTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
    if (outcome !== timeoutMarker) return;
    runLateCleanup().catch((lateError) =>
      reportDetachedCleanupError("late cleanup", lateError),
    );
    throw new Error(
      `${name} late initialization did not settle within ` +
        `${cleanupTimeoutMs} ms after cancellation.`,
    );
  };
  const cancel = async (error, cleanup) => {
    if (cancelled || completed) return;
    cancelled = true;
    try {
      await awaitCancellationCleanup(cleanup, error);
      await awaitLateCleanup();
      rejectCancellation(error);
    } catch (cleanupError) {
      rejectCancellation(
        new AggregateError(
          [error, cleanupError],
          `${error.message} ${name} cancellation cleanup failed: ` +
            `${cleanupError?.message ?? cleanupError}`,
        ),
      );
    }
  };
  timer = setTimeout(() => {
    const error = new Error(
      `${name} exceeded its ${milliseconds} ms deadline.`,
    );
    void cancel(error, onTimeout);
  }, milliseconds);
  if (signal) {
    abortListener = () => {
      const reason =
        signal.reason instanceof Error
          ? signal.reason
          : new Error(`${name} was aborted.`);
      void cancel(reason, onAbort);
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  }
  try {
    return await Promise.race([guardedOperation, cancellation]);
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function assertHealthyDssStatus(status, key) {
  if (!Number.isSafeInteger(status.status) || status.status < 0 || status.status > DSS_ERROR) {
    throw new Error(`${key} returned an unknown DSS status ${status.status}.`);
  }
  const error = String(status.error ?? "").trim();
  if (status.status === DSS_ERROR || error) {
    throw new Error(`${key} returned a DSS error: ${error || "unspecified error"}.`);
  }
  if (
    status.totalRows < 0n ||
    status.syncedRows < 0n ||
    status.missingRows < 0n ||
    status.syncedRows > status.totalRows
  ) {
    throw new Error(`${key} returned inconsistent DSS row counters.`);
  }
  return status;
}

/**
 * Observe an SDN/WasmEdge run without walking its data directory. The signed
 * local artifact supplies the portable route hash and route allow-list.
 */
export async function observeSdnRuntime({
  verifiedFlow,
  artifactPath,
  trustedPublicKeys,
  expectedTree,
  baseUrl,
  pid,
  procRoot = "/proc",
  pollMs = DEFAULT_POLL_MS,
  maxPolls = Number.POSITIVE_INFINITY,
  maxDurationMs = DEFAULT_LOCAL_TIMEOUT_MS,
  routeTimeoutMs = DEFAULT_ROUTE_TIMEOUT_MS,
  expectFiles,
  allowResume = false,
  fetchImpl = globalThis.fetch,
  eventSink,
} = {}) {
  const loaded =
    verifiedFlow ??
    (await loadVerifiedSignedFlow({
      artifactPath,
      trustedPublicKeys,
      expectedTree,
    }));
  const normalizedBase = exactNonEmptyString(baseUrl, "baseUrl").replace(
    /\/+$/u,
    "",
  );
  if (!Number.isFinite(pollMs) || pollMs < 0) {
    throw new RangeError("pollMs must be a non-negative number.");
  }
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new RangeError("maxDurationMs must be positive.");
  }
  positiveDeadline(routeTimeoutMs, "routeTimeoutMs");
  if (
    maxPolls !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxPolls) || maxPolls < 1)
  ) {
    throw new RangeError("maxPolls must be a positive integer or Infinity.");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("observe mode requires a fetch implementation.");
  }
  const routes = (loaded.artifact.runtimeNodeRoutes ?? [])
    .filter((route) => String(route.key ?? "").endsWith(".dss"))
    .map((route) => exactNonEmptyString(route.key, "runtime DSS route"));
  if (!routes.includes("provider-starlink.dss")) {
    throw new Error("Signed artifact exposes no provider-starlink.dss route.");
  }
  const emit = eventEmitter(eventSink);
  const startedAtMs = Date.now();
  const statuses = {};
  const resources = [];
  let polls = 0;
  let terminal = false;
  let starlinkBaseline = null;
  let throughputStartedAtMs = null;
  let runClassification = "fresh-observation";
  while (polls < maxPolls && Date.now() - startedAtMs < maxDurationMs) {
    polls += 1;
    for (const key of routes) {
      const url =
        `${normalizedBase}/sdn/v1/artifacts/${loaded.portableWasmSha256}` +
        `/runtime/nodes/${encodeURIComponent(key)}`;
      const remainingMs = maxDurationMs - (Date.now() - startedAtMs);
      if (remainingMs <= 0) break;
      const controller = new AbortController();
      const status = await withDeadline(
        `DSS route ${key}`,
        Math.min(routeTimeoutMs, remainingMs),
        async () => {
          const response = await fetchImpl(url, {
            headers: { Accept: "application/x-flatbuffers" },
            signal: controller.signal,
          });
          if (!response?.ok) {
            const responseStatus = Number(response?.status ?? 0);
            throw new Error(
              `DSS route ${key} returned HTTP ${responseStatus || "failure"}.`,
            );
          }
          const body = await readBoundedResponse(response, MAX_DSS_ROUTE_BYTES);
          return assertHealthyDssStatus(decodeDssRoutePayload(body), key);
        },
        {
          onTimeout(error) {
            controller.abort(error);
          },
        },
      );
      statuses[key] = status;
      if (key === "provider-starlink.dss" && !starlinkBaseline) {
        const hasObservedWork =
          status.syncedRows > 0n || status.downloadedBytes > 0n;
        if (hasObservedWork && !allowResume) {
          throw new Error(
            "Observe mode attached to a mid-run Starlink state; pass --allow-resume to collect explicitly labeled delta-only telemetry.",
          );
        }
        starlinkBaseline = {
          syncedRows: status.syncedRows,
          downloadedBytes: status.downloadedBytes,
        };
        throughputStartedAtMs = Date.now();
        if (hasObservedWork) runClassification = "resumed-observation";
      }
      emit({
        kind: "observe-dss",
        key,
        status: status.status,
        syncedRows: status.syncedRows.toString(),
        totalRows: status.totalRows.toString(),
        missingRows: status.missingRows.toString(),
        downloadedBytes: status.downloadedBytes.toString(),
      });
    }
    if (pid !== undefined) {
      const sample = await sampleLinuxProcess({ pid, procRoot });
      resources.push(sample);
      emit({ kind: "observe-resource", ...sample });
    }
    const starlink = statuses["provider-starlink.dss"];
    const expectedMatches =
      expectFiles === undefined || starlink?.totalRows === BigInt(expectFiles);
    if (
      expectedMatches &&
      starlink?.status === DSS_SYNCED &&
      starlink?.totalRows > 0n &&
      starlink.syncedRows === starlink.totalRows &&
      starlink.missingRows === 0n
    ) {
      terminal = true;
      break;
    }
    const remainingMs = maxDurationMs - (Date.now() - startedAtMs);
    if (polls < maxPolls && pollMs > 0 && remainingMs > 0) {
      await sleep(Math.min(pollMs, remainingMs));
    }
  }
  if (!terminal) {
    throw new Error(
      `Observe mode exhausted ${polls} poll(s) or its duration before a verified terminal Starlink DSS state.`,
    );
  }
  const finishedAtMs = Date.now();
  const telemetryLimitations = [
    "DSS routes expose aggregate progress, not individual OMM/OCM publication payloads.",
    "RMS and iteration distributions are unavailable remotely unless the signed flow publishes them through an explicit runtime route.",
    "Host resource samples describe the selected Linux PID; child worker attribution depends on the SDN process model.",
    "No /data directory scan is performed during polling.",
    "The --expect-tree check is local-only and does not attest the remote outer or child tree.",
  ];
  const acceptanceReason =
    "The runtime route is keyed only by portable WASM hash; no exact signed outer/child-tree attestation was available.";
  const remoteEvidence = {
    scope: "portable-runtime-only",
    portableWasmSha256: loaded.portableWasmSha256,
    exactSignedTreeVerified: false,
    acceptanceReason,
  };
  const result = {
    mode: "observe",
    accepted: false,
    remoteEvidence,
    portableWasmSha256: loaded.portableWasmSha256,
    startedAtMs,
    finishedAtMs,
    polls,
    statuses,
    resources,
    starlinkBaseline,
    throughputStartedAtMs,
    runClassification,
    freshRunThroughput: runClassification === "fresh-observation",
    dataDirectoryScans: 0,
    telemetryLimitations,
  };
  result.summary = summarizeBenchmark({
    mode: "observe",
    startedAtMs,
    finishedAtMs,
    artifact: {
      portableWasmSha256: loaded.portableWasmSha256,
      evidenceScope: "portable-runtime-only",
      exactSignedTreeVerified: false,
    },
    starlink: statuses["provider-starlink.dss"] ?? {},
    starlinkBaseline,
    throughputStartedAtMs,
    runClassification,
    freshRunThroughput: runClassification === "fresh-observation",
    resources,
    telemetryLimitations,
  });
  return result;
}

function decodeFsbEnvelope(payload) {
  const buffer = new ByteBuffer(toBytes(payload, "FSB payload"));
  if (!FSB.bufferHasIdentifier(buffer)) {
    throw new Error("FlatSQL records output is not a canonical $FSB frame.");
  }
  const envelope = FSB.getRootAsFSB(buffer);
  return {
    requestId: envelope.REQUEST_ID(),
    kind: envelope.KIND(),
    sequence: envelope.CHUNK_SEQUENCE(),
    final: envelope.FINAL(),
    totalBytes: envelope.TOTAL_BYTES(),
    columnCount: envelope.COLUMN_COUNT(),
    schemaName: envelope.SCHEMA_NAME() ?? "",
    fileIdentifier: envelope.FILE_IDENTIFIER() ?? "",
    recordCount: envelope.RECORD_COUNT(),
    data: new Uint8Array(envelope.dataArray() ?? []),
    sha256: new Uint8Array(envelope.sha256Array() ?? []),
  };
}

function decodeFsoStatus(payload) {
  const value = FSO.getRootAsFSO(
    new ByteBuffer(toBytes(payload, "FSO status")),
  );
  return {
    operation: value.OPERATION(),
    requestId: value.REQUEST_ID(),
    status: value.STATUS(),
    affectedRecords: value.AFFECTED_RECORDS(),
    resultBytes: value.RESULT_BYTES(),
    errorCode: value.ERROR_CODE() ?? "",
    message: decodeText(value.messageArray()),
  };
}

export function isFlatSqlAppendCompletePayload(payload) {
  const status = decodeFsoStatus(payload);
  return (
    status.operation === flatSqlNodeOperation.APPEND_RECORDS &&
    status.status === flatSqlNodeStatus.COMPLETE
  );
}

function flowQueueState(parent) {
  const nodes = Array.from({ length: parent.nodeCount }, (_, index) => {
    const descriptor = parent.getNodeDispatchDescriptor(index);
    return {
      nodeId: descriptor.nodeId,
      ...parent.getNodeState(index),
    };
  });
  const edges = Array.from({ length: parent.edgeCount }, (_, index) => ({
    index,
    ...parent.getIngressState(index),
  }));
  return {
    nodes,
    edges,
    empty:
      nodes.every(
        (node) =>
          !node.ready &&
          node.queuedFrames === 0 &&
          node.backlogRemaining === 0,
      ) &&
      edges.every((edge) => edge.queuedFrames === 0),
    droppedFrames: edges.reduce(
      (total, edge) => total + BigInt(edge.totalDropped),
      0n,
    ),
  };
}

function cloneInvocationFrame(frame) {
  return {
    portId: frame.portId,
    typeRef: structuredClone(frame.typeRef),
    payload: new Uint8Array(frame.bytes),
  };
}

function makeFsoQuery({ databaseName, requestId, query }) {
  const builder = new Builder(512);
  const database = builder.createString(databaseName);
  const queryBytes = builder.createByteVector(textEncoder.encode(query));
  FSO.startFSO(builder);
  FSO.addOperation(builder, flatSqlNodeOperation.QUERY_RECORDS);
  FSO.addRequestId(builder, BigInt(requestId));
  FSO.addDatabaseName(builder, database);
  FSO.addQuery(builder, queryBytes);
  const root = FSO.endFSO(builder);
  FSO.finishFSOBuffer(builder, root);
  return builder.asUint8Array();
}

function assertCompleteFso(response, operation) {
  if (response.statusCode !== 0) {
    throw new Error(
      `${operation} failed: ${response.errorCode ?? ""} ${response.errorMessage ?? ""}`,
    );
  }
  const statusOutput = response.outputs.find(
    (output) => output.portId === "status",
  );
  if (!statusOutput) throw new Error(`${operation} emitted no status output.`);
  const status = decodeFsoStatus(statusOutput.payload);
  if (status.status !== flatSqlNodeStatus.COMPLETE) {
    throw new Error(
      `${operation} did not complete: ${status.errorCode} ${status.message}`,
    );
  }
  return status;
}

function pageRecordsFromFlatSqlResponse({
  response,
  status,
  standard,
  requestId,
  pageSize,
}) {
  const frames = response.outputs
    .filter((output) => output.portId === "records")
    .map((output) => decodeFsbEnvelope(output.payload))
    .sort((left, right) => left.sequence - right.sequence);
  const affectedRecords = Number(status.affectedRecords);
  if (
    !Number.isSafeInteger(affectedRecords) ||
    affectedRecords < 0 ||
    affectedRecords > pageSize
  ) {
    throw new Error(
      `FlatSQL ${standard} page reported an invalid affected-record count.`,
    );
  }
  if (frames.length === 0) {
    if (affectedRecords !== 0) {
      throw new Error(
        `FlatSQL ${standard} page claimed records without record frames.`,
      );
    }
    return [];
  }
  const first = frames[0];
  const firstDigest =
    first.sha256.byteLength === 32
      ? Buffer.from(first.sha256).toString("hex")
      : null;
  if (
    first.requestId !== requestId ||
    first.kind !== 2 ||
    first.columnCount !== 1 ||
    (first.schemaName !== "" && first.schemaName !== `${standard}.fbs`) ||
    (first.fileIdentifier !== "" && first.fileIdentifier !== `$${standard}`) ||
    first.recordCount !== BigInt(affectedRecords) ||
    (first.sha256.byteLength !== 0 && first.sha256.byteLength !== 32)
  ) {
    throw new Error(`FlatSQL ${standard} page metadata is inconsistent.`);
  }
  for (const [index, frame] of frames.entries()) {
    if (
      frame.sequence !== index ||
      frame.requestId !== first.requestId ||
      frame.totalBytes !== first.totalBytes ||
      frame.kind !== first.kind ||
      frame.columnCount !== first.columnCount ||
      frame.recordCount !== first.recordCount ||
      frame.schemaName !== first.schemaName ||
      frame.fileIdentifier !== first.fileIdentifier ||
      (frame.sha256.byteLength === 32
        ? Buffer.from(frame.sha256).toString("hex")
        : null) !== firstDigest ||
      frame.final !== (index === frames.length - 1)
    ) {
      throw new Error(`FlatSQL ${standard} page chunks are inconsistent.`);
    }
  }
  const stream = new Uint8Array(
    frames.reduce((total, frame) => total + frame.data.byteLength, 0),
  );
  let offset = 0;
  for (const frame of frames) {
    stream.set(frame.data, offset);
    offset += frame.data.byteLength;
  }
  if (
    BigInt(stream.byteLength) !== first.totalBytes ||
    (firstDigest !== null && sha256(stream) !== firstDigest)
  ) {
    throw new Error(`FlatSQL ${standard} page content digest is invalid.`);
  }
  const records = splitSizePrefixedRecords(stream);
  if (records.length !== affectedRecords) {
    throw new Error(
      `FlatSQL ${standard} page record framing differs from its status.`,
    );
  }
  return records;
}

function exactHashMultiset(values, label) {
  return (values ?? [])
    .map((value) => exactHex(value, label))
    .sort();
}

export async function reloadAndQueryFlatSql({
  verifiedFlow,
  opaqueAdapter,
  metrics,
  capturedControl,
  createWorkerHarness = createWorkerModuleHarness,
  eventSink,
  pageSize = DEFAULT_RELOAD_PAGE_SIZE,
  timeoutMs = DEFAULT_RELOAD_TIMEOUT_MS,
  invokeTimeoutMs = DEFAULT_RELOAD_INVOKE_TIMEOUT_MS,
  signal: suppliedSignal,
  abortController: suppliedAbortController,
}) {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_RELOAD_PAGE_SIZE
  ) {
    throw new RangeError(
      `FlatSQL reload pageSize must be between 1 and ${MAX_RELOAD_PAGE_SIZE}.`,
    );
  }
  const overallTimeoutMs = positiveDeadline(
    timeoutMs,
    "FlatSQL reload timeoutMs",
  );
  const perInvokeTimeoutMs = positiveDeadline(
    invokeTimeoutMs,
    "FlatSQL reload invokeTimeoutMs",
  );
  const abortController = suppliedAbortController ?? new AbortController();
  const signal = suppliedSignal ?? abortController.signal;
  signal.throwIfAborted();
  const abortReload = (error) => {
    if (!abortController.signal.aborted) abortController.abort(error);
  };
  const startedAtMs = Date.now();
  const remainingDeadline = (label) => {
    const remaining = overallTimeoutMs - (Date.now() - startedAtMs);
    if (remaining <= 0) {
      throw new Error(`${label} exceeded the FlatSQL reload deadline.`);
    }
    return Math.min(remaining, perInvokeTimeoutMs);
  };
  if (!capturedControl) {
    throw new Error("FlatSQL reload proof has no captured CONFIGURE_INDEX frame.");
  }
  const store = verifiedFlow.children.find((child) => child.nodeId === "store");
  if (!store) throw new Error("Signed flow has no independent FlatSQL child.");
  const dispatch = createMeasuredDispatch({
    nodeId: "store",
    opaqueAdapter,
    metrics,
    eventSink,
    signal,
  });
  const harness = await withDeadline(
    "FlatSQL reload worker creation",
    remainingDeadline("FlatSQL reload worker creation"),
    () =>
      createWorkerHarness({
        wasmSource: store.wasmBytes,
        signal,
        harnessOptions: {
          verifySignature: {
            trustedPublicKeys: verifiedFlow.trustedPublicKeys,
            requireSignature: true,
          },
        },
        dispatchHost: dispatch,
      }),
    {
      signal,
      onTimeout: abortReload,
      onLateResolve: (lateHarness) => lateHarness.destroy(),
    },
  );
  try {
    const configureResponse = await withDeadline(
      "FlatSQL reload configure",
      remainingDeadline("FlatSQL reload configure"),
      () =>
        harness.invoke({
          methodId: "configure_index",
          inputs: [capturedControl],
          signal,
        }),
      {
        signal,
        onTimeout: abortReload,
      },
    );
    assertCompleteFso(configureResponse, "FlatSQL reload configure");
    const control = FSO.getRootAsFSO(
      new ByteBuffer(new Uint8Array(capturedControl.payload)),
    );
    const databaseName = control.DATABASE_NAME() ?? "supplemental-omm";
    const publicationMetrics = ensureMetrics(metrics).publications;
    const productCounts = publicationProductTotals(publicationMetrics, {
      requireOutput: true,
    });
    const recordCounts = {};
    const recordHashes = {};
    let requestId = 9_000_000n;
    for (const table of ["OMM", "OCM"]) {
      const expectedCount = Number(publicationMetrics[table]);
      if (
        !Number.isSafeInteger(expectedCount) ||
        expectedCount < 0 ||
        expectedCount > MAX_RELOAD_RECORDS
      ) {
        throw new Error(
          `FlatSQL ${table} reload expected count is outside the benchmark bound.`,
        );
      }
      const maxPages = Math.ceil(expectedCount / pageSize) + 1;
      const hashes = [];
      let offset = 0;
      let reachedTerminalPage = false;
      for (let page = 0; page < maxPages; page += 1) {
        const pageRequestId = requestId++;
        const response = await withDeadline(
          `FlatSQL ${table} reload page ${page}`,
          remainingDeadline(`FlatSQL ${table} reload page ${page}`),
          () =>
            harness.invoke({
              methodId: "query_records",
              signal,
              inputs: [
                {
                  portId: "query",
                  typeRef: canonicalFsoType,
                  payload: makeFsoQuery({
                    databaseName,
                    requestId: pageRequestId,
                    query:
                      `SELECT _data FROM ${table} ORDER BY rowid ` +
                      `LIMIT ${pageSize} OFFSET ${offset}`,
                  }),
                },
              ],
            }),
          {
            signal,
            onTimeout: abortReload,
          },
        );
        const status = assertCompleteFso(
          response,
          `FlatSQL ${table} reload page ${page}`,
        );
        const records = pageRecordsFromFlatSqlResponse({
          response,
          status,
          standard: table,
          requestId: pageRequestId,
          pageSize,
        });
        hashes.push(...records.map((record) => sha256(record)));
        offset += records.length;
        if (offset > expectedCount) {
          throw new Error(
            `FlatSQL ${table} reload contains more records than were published.`,
          );
        }
        if (records.length < pageSize) {
          reachedTerminalPage = true;
          break;
        }
      }
      if (!reachedTerminalPage || hashes.length !== expectedCount) {
        throw new Error(
          `FlatSQL ${table} reload did not reach an exact bounded terminal page.`,
        );
      }
      const expectedHashes = exactHashMultiset(
        publicationMetrics.recordHashes[table],
        `${table} publication record hash`,
      );
      const actualHashes = exactHashMultiset(
        hashes,
        `${table} reload record hash`,
      );
      if (
        expectedHashes.length !== expectedCount ||
        actualHashes.some(
          (value, index) => value !== expectedHashes[index],
        )
      ) {
        throw new Error(
          `FlatSQL ${table} reload content parity differs from signed publications.`,
        );
      }
      recordCounts[table] = hashes.length;
      recordHashes[table] = hashes;
    }
    return {
      verified: true,
      exactChildSha256: store.sha256,
      databaseName,
      recordCounts,
      recordHashes,
      productCounts,
      pageSize,
    };
  } finally {
    await withDeadline(
      "FlatSQL reload worker destroy",
      perInvokeTimeoutMs,
      () => harness.destroy(),
    );
  }
}

function assertFlatSqlReloadParity(reloadResult, publications) {
  publicationProductTotals(publications, { requireOutput: true });
  for (const table of ["OMM", "OCM"]) {
    const expectedCount = Number(publications[table]);
    const actualCount = Number(reloadResult?.recordCounts?.[table]);
    const expectedHashes = exactHashMultiset(
      publications.recordHashes?.[table],
      `${table} publication record hash`,
    );
    const actualHashes = exactHashMultiset(
      reloadResult?.recordHashes?.[table],
      `${table} reload record hash`,
    );
    if (
      actualCount !== expectedCount ||
      expectedHashes.length !== expectedCount ||
      actualHashes.length !== expectedCount ||
      actualHashes.some(
        (value, index) => value !== expectedHashes[index],
      )
    ) {
      throw new Error(
        `FlatSQL reload content parity for ${table} differs from exact signed publications.`,
      );
    }
  }
}

function makeLocalObserver(metrics, emit) {
  let capturedStoreControl = null;
  const starlinkStreams = new Map();
  const completedStarlinkRequests = new Set();
  const expectedStarlinkSources = new Set();

  function observeStarlinkOem(payload) {
    const envelope = decodeFsbEnvelope(payload);
    const requestId = BigInt(envelope.requestId ?? 0);
    const requestKey = requestId.toString();
    const sourceKey = starlinkSourceKey(envelope.schemaName);
    if (
      requestId === 0n ||
      envelope.fileIdentifier !== "MEME" ||
      completedStarlinkRequests.has(requestKey)
    ) {
      throw new Error("Starlink provider emitted an invalid or repeated OEM stream.");
    }
    let stream = starlinkStreams.get(requestKey);
    if (envelope.sequence === 0) {
      if (stream) {
        throw new Error("Starlink provider repeated OEM sequence zero.");
      }
      stream = { sourceKey, nextSequence: 0 };
      starlinkStreams.set(requestKey, stream);
    }
    if (
      !stream ||
      stream.sourceKey !== sourceKey ||
      envelope.sequence !== stream.nextSequence
    ) {
      throw new Error("Starlink provider OEM stream identity or ordering changed.");
    }
    stream.nextSequence += 1;
    if (envelope.final) {
      expectedStarlinkSources.add(sourceKey);
      completedStarlinkRequests.add(requestKey);
      starlinkStreams.delete(requestKey);
    }
  }

  return {
    get capturedStoreControl() {
      return capturedStoreControl;
    },
    get expectedStarlinkSources() {
      return new Set(expectedStarlinkSources);
    },
    get incompleteStarlinkStreams() {
      return starlinkStreams.size;
    },
    async onInvocationStart({ child, frames }) {
      const invocationMetrics = (metrics.invocations ??= {});
      const node = (invocationMetrics[child.nodeId] ??= {
        count: 0,
        elapsedMs: 0,
      });
      node.count += 1;
      if (
        child.nodeId === "od" &&
        frames.some((frame) => frame.portId === "starlink")
      ) {
        metrics.milestones.firstOdInputAtMs ??= Date.now();
      }
      if (child.nodeId === "store" && !capturedStoreControl) {
        const control = frames.find((frame) => frame.portId === "control");
        if (control) capturedStoreControl = cloneInvocationFrame(control);
      }
    },
    async onInvocationEnd({ child, elapsedMs, response }) {
      metrics.invocations[child.nodeId].elapsedMs += elapsedMs;
      if (response.statusCode !== 0) {
        throw new Error(
          `${child.nodeId} failed: ${response.errorCode ?? ""} ` +
            `${response.errorMessage ?? ""}`,
        );
      }
      if (
        response.outputs.some(
          (output) =>
            output.portId === "obd" ||
            String(output.typeRef?.schemaName ?? "").toUpperCase() === "OBD",
        )
      ) {
        metrics.publications.OBD += 1;
        throw new Error("Signed child emitted retired OBD output.");
      }
      if (child.nodeId === "provider-starlink") {
        for (const output of response.outputs) {
          if (output.portId === "oem") {
            observeStarlinkOem(output.payload);
            metrics.milestones.firstStarlinkOemAtMs ??= Date.now();
          }
          if (output.portId === "progress") {
            const status = assertHealthyDssStatus(
              decodeDssRoutePayload(output.payload),
              "provider-starlink progress",
            );
            if (!metrics.starlinkBaseline) {
              metrics.starlinkBaseline = {
                syncedRows: status.syncedRows,
                downloadedBytes: status.downloadedBytes,
              };
              metrics.throughputStartedAtMs = Date.now();
            }
            metrics.starlink = status;
            emit({
              kind: "starlink-progress",
              syncedRows: status.syncedRows.toString(),
              totalRows: status.totalRows.toString(),
              missingRows: status.missingRows.toString(),
              downloadedBytes: status.downloadedBytes.toString(),
              cachedBytes: status.cachedBytes.toString(),
            });
            if (
              status.totalRows > 0n &&
              status.syncedRows === status.totalRows &&
              status.missingRows === 0n
            ) {
              metrics.milestones.starlinkCompleteAtMs ??= Date.now();
            }
          }
        }
      }
      if (child.nodeId === "od") {
        if (
          response.outputs.some(
            (output) => output.portId === "omm" || output.portId === "ocm",
          )
        ) {
          metrics.milestones.firstOdOutputAtMs ??= Date.now();
        }
      }
      if (child.nodeId === "store") {
        for (const output of response.outputs.filter(
          (candidate) => candidate.portId === "status",
        )) {
          if (isFlatSqlAppendCompletePayload(output.payload)) {
            metrics.milestones.firstFlatSqlCompleteAtMs ??= Date.now();
          }
        }
      }
      emit({
        kind: "node-invocation",
        nodeId: child.nodeId,
        elapsedMs,
        outputs: response.outputs.length,
        backlogRemaining: response.backlogRemaining ?? 0,
      });
    },
  };
}

function classifyLocalStateDirectory(stateDir) {
  const resolved = path.resolve(exactNonEmptyString(stateDir, "stateDir"));
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { resolved, resumed: false };
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Local benchmark stateDir must be a real directory.");
  }
  const resumed = fs.readdirSync(resolved).length > 0;
  if (resumed) {
    throw new Error(
      "Local benchmark stateDir is nonempty; local measurements are fresh-only.",
    );
  }
  return { resolved, resumed: false };
}

/**
 * Run the exact signed outer and embedded children locally. This is a logical
 * parity/quality benchmark; the reference JS wasi.thread-spawn adapter does
 * not provide the WasmEdge guest-thread throughput lane.
 */
export async function runLocalExactFlow({
  verifiedFlow,
  artifactPath,
  trustedPublicKeys,
  expectedTree,
  stateDir,
  allowResume = false,
  expectFiles,
  timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  eventSink,
  createWorkerHarness = createWorkerModuleHarness,
  createParentHost = createFlowRuntimeHost,
  instantiateRuntime = instantiateWorkerChildren,
  reloadFlatSql = reloadAndQueryFlatSql,
  sampleResources = sampleSelfResources,
} = {}) {
  const runTimeoutMs = positiveDeadline(timeoutMs, "local timeoutMs");
  const loaded =
    verifiedFlow ??
    (await loadVerifiedSignedFlow({
      artifactPath,
      trustedPublicKeys,
      expectedTree,
    }));
  const stateMode = classifyLocalStateDirectory(stateDir);
  const runClassification = "fresh-local";
  const startedAtMs = Date.now();
  const runController = new AbortController();
  const signal = runController.signal;
  const abortRun = (error) => {
    if (!signal.aborted) runController.abort(error);
  };
  const remainingRunDeadline = (label) => {
    const remaining = runTimeoutMs - (Date.now() - startedAtMs);
    if (remaining <= 0) {
      throw new Error(`${label} exceeded the local benchmark deadline.`);
    }
    return remaining;
  };
  const metrics = ensureMetrics({
    mode: "local",
    startedAtMs,
    runClassification,
    freshRunThroughput: true,
    starlinkBaseline: {
      syncedRows: 0n,
      downloadedBytes: 0n,
    },
    throughputStartedAtMs: startedAtMs,
    artifact: {
      outerSha256: loaded.outerSha256,
      portableWasmSha256: loaded.portableWasmSha256,
      signerPublicKeyHex: loaded.verification.publicKeyHex,
      children: Object.fromEntries(
        loaded.children.map((child) => [child.nodeId, child.sha256]),
      ),
    },
    telemetryLimitations: [
      "The Node worker harness executes the exact signed bytes, but its reference wasi.thread-spawn adapter does not reproduce WasmEdge guest-thread throughput.",
      "Use observe mode against the SDN/WasmEdge process for release CPU/RSS/thread/I/O sizing.",
    ],
  });
  const emit = eventEmitter(eventSink);
  emit({ kind: "artifact-verified", ...metrics.artifact });
  const opaqueAdapter = createFileBackedOpaqueAdapter({
    stateDir: stateMode.resolved,
  });
  let clockMs = Date.now();
  const observer = makeLocalObserver(metrics, emit);
  let runtime;
  let reloadResult;
  try {
    runtime = await withDeadline(
      "Local exact runtime initialization",
      remainingRunDeadline("Local exact runtime initialization"),
      () =>
        instantiateRuntime(loaded, {
          createParentHost,
          createWorkerHarness,
          observer,
          signal,
          abortController: runController,
          invocationTimeoutMs: Math.min(
            DEFAULT_CHILD_INVOKE_TIMEOUT_MS,
            runTimeoutMs,
          ),
          dispatchFactory(child) {
            return createMeasuredDispatch({
              nodeId: child.nodeId,
              opaqueAdapter,
              metrics,
              fetchImpl,
              now: () => clockMs,
              eventSink,
              signal,
            });
          },
        }),
      {
        signal,
        onTimeout: abortRun,
        onLateResolve: (lateRuntime) => lateRuntime.destroy(),
      },
    );
    metrics.resources.push(sampleResources());
    metrics.milestones.bootstrapTriggeredAtMs = Date.now();
    runtime.parent.enqueueTrigger(0);
    const bootstrap = await withDeadline(
      "Local bootstrap drain",
      remainingRunDeadline("Local bootstrap drain"),
      () =>
        runtime.drain({
          maxIterations: 20_000,
          frameBudget: 64,
        }),
      {
        signal,
        onTimeout: abortRun,
      },
    );
    metrics.milestones.bootstrapDrainedAtMs = Date.now();
    emit({ kind: "bootstrap-drained", ...bootstrap });

    clockMs += 30_000;
    metrics.milestones.fetchTriggeredAtMs = Date.now();
    runtime.parent.enqueueTrigger(0);
    let drains = 0;
    const aggregateDrain = {
      iterations: bootstrap.iterations,
      nodesInvoked: bootstrap.nodesInvoked,
      handlersSkipped: bootstrap.handlersSkipped,
    };
    for (;;) {
      const result = await withDeadline(
        "Local flow drain",
        remainingRunDeadline("Local flow drain"),
        () =>
          runtime.drain({
            maxIterations: 1_000_000,
            frameBudget: 64,
          }),
        {
          signal,
          onTimeout: abortRun,
        },
      );
      drains += 1;
      aggregateDrain.iterations += result.iterations;
      aggregateDrain.nodesInvoked += result.nodesInvoked;
      aggregateDrain.handlersSkipped += result.handlersSkipped;
      metrics.resources.push(sampleResources());
      const progress = metrics.starlink;
      const starlinkComplete =
        progress?.status === DSS_SYNCED &&
        progress?.totalRows > 0n &&
        progress.syncedRows === progress.totalRows &&
        progress.missingRows === 0n;
      if (starlinkComplete) {
        metrics.publications.pairing = assertPublicationPairing(
          metrics.publications,
          { requireDetails: true },
        );
        metrics.starlinkSourceCoverage = assertStarlinkSourceCoverage({
          expectedSources: observer.expectedStarlinkSources,
          incompleteStreams: observer.incompleteStarlinkStreams,
          publications: metrics.publications,
          totalRows: progress.totalRows,
        });
        break;
      }
      if (result.nodesInvoked === 0) {
        clockMs += 30_000;
        runtime.parent.enqueueTrigger(0);
      }
      if (drains > 100_000) {
        throw new Error("Local exact flow exceeded its bounded drain count.");
      }
    }

    if (
      expectFiles !== undefined &&
      metrics.starlink.totalRows !== BigInt(expectFiles)
    ) {
      throw new Error(
        `Starlink plan contains ${metrics.starlink.totalRows} files; ` +
          `expected ${expectFiles}.`,
      );
    }
    if (metrics.starlink.cachedBytes !== 0n) {
      throw new Error("Starlink progress reports a forbidden raw ephemeris cache.");
    }
    if (metrics.publications.OBD !== 0) {
      throw new Error(
        "Local exact flow emitted a retired OBD product.",
      );
    }
    publicationProductTotals(metrics.publications, { requireOutput: true });
    metrics.publications.pairing = assertPublicationPairing(
      metrics.publications,
      { requireDetails: true },
    );
    metrics.starlinkSourceCoverage = assertStarlinkSourceCoverage({
      expectedSources: observer.expectedStarlinkSources,
      incompleteStreams: observer.incompleteStarlinkStreams,
      publications: metrics.publications,
      totalRows: metrics.starlink.totalRows,
    });
    const queueState = flowQueueState(runtime.parent);
    if (!queueState.empty || queueState.droppedFrames !== 0n) {
      throw new Error(
        `Flow did not drain losslessly: empty=${queueState.empty} ` +
          `dropped=${queueState.droppedFrames}.`,
      );
    }
    if (
      queueState.nodes.some((node) => node.lastStatus !== 0) ||
      aggregateDrain.handlersSkipped !== 0
    ) {
      throw new Error(
        "Exact signed flow ended with a failed node or an unserviced isomorphic handler.",
      );
    }
    const routing = runtime.parent.getRoutingState();
    if (routing.rejectedFrames !== 0n) {
      throw new Error(
        `Exact signed flow rejected ${routing.rejectedFrames} routed frames.`,
      );
    }
    metrics.flow = {
      drain: aggregateDrain,
      queuesEmpty: queueState.empty,
      droppedFrames: numericBigInt(queueState.droppedFrames),
      routing,
    };
    const reloadTimeoutMs = remainingRunDeadline("Local FlatSQL reload");
    reloadResult = await withDeadline(
      "Local FlatSQL reload",
      reloadTimeoutMs,
      () =>
        reloadFlatSql({
          verifiedFlow: loaded,
          opaqueAdapter,
          metrics,
          capturedControl: observer.capturedStoreControl,
          createWorkerHarness,
          eventSink,
          timeoutMs: reloadTimeoutMs,
          signal,
          abortController: runController,
        }),
      {
        signal,
        onTimeout: abortRun,
      },
    );
    assertFlatSqlReloadParity(reloadResult, metrics.publications);
    metrics.flatsqlReload = reloadResult;
  } finally {
    if (runtime) {
      await withDeadline(
        "Local exact runtime destroy",
        Math.max(25, Math.min(30_000, runTimeoutMs)),
        () => runtime.destroy(),
      );
    }
  }
  metrics.finishedAtMs = Date.now();
  metrics.resources.push(sampleResources());
  const summary = summarizeBenchmark(metrics);
  emit({ kind: "benchmark-summary", summary });
  return { metrics, summary, tree: loaded.tree };
}

function parseInteger(value, label, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`${label} must be an integer >= ${minimum}.`);
  }
  return parsed;
}

export function parseCli(argv) {
  const [mode, ...rest] = argv;
  if (mode !== "local" && mode !== "observe") {
    throw new Error("Usage: benchmark-signed-starlink-flow.mjs local|observe [options]");
  }
  const options = { mode, trustedPublicKeys: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const next = rest[index + 1];
    const take = () => {
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for ${flag}.`);
      }
      index += 1;
      return next;
    };
    if (flag === "--artifact") options.artifactPath = take();
    else if (flag === "--trusted-key") options.trustedPublicKeys.push(take());
    else if (flag === "--expect-tree") options.expectedTree = take();
    else if (flag === "--expect-files") {
      options.expectFiles = parseInteger(take(), flag, { minimum: 1 });
    } else if (flag === "--state-dir") options.stateDir = take();
    else if (flag === "--out") options.out = take();
    else if (flag === "--base-url") options.baseUrl = take();
    else if (flag === "--pid") {
      options.pid = parseInteger(take(), flag, { minimum: 1 });
    } else if (flag === "--poll-ms") {
      options.pollMs = parseInteger(take(), flag);
    } else if (flag === "--max-polls") {
      options.maxPolls = parseInteger(take(), flag, { minimum: 1 });
    } else if (flag === "--route-timeout-ms") {
      options.routeTimeoutMs = parseInteger(take(), flag, { minimum: 1 });
    } else if (flag === "--allow-resume") {
      options.allowResume = true;
    } else if (flag === "--timeout-ms") {
      options.maxDurationMs = parseInteger(take(), flag, { minimum: 1 });
      options.timeoutMs = options.maxDurationMs;
    } else {
      throw new Error(`Unknown argument ${flag}.`);
    }
  }
  if (!options.artifactPath) throw new Error("--artifact is required.");
  if (options.trustedPublicKeys.length === 0) {
    throw new Error("At least one --trusted-key is required.");
  }
  if (mode === "local" && !options.stateDir) {
    throw new Error("local mode requires --state-dir.");
  }
  if (mode === "observe" && !options.baseUrl) {
    throw new Error("observe mode requires --base-url.");
  }
  return options;
}

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return { byteLength: value.byteLength, sha256: sha256(value) };
  }
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]),
    );
  }
  return value;
}

export function createNdjsonSink(filename) {
  if (!filename) {
    const sink = (event) => {
      process.stdout.write(`${JSON.stringify(jsonSafe(event))}\n`);
    };
    sink.close = () => {};
    return sink;
  }
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(resolved, "wx", 0o600);
  let closed = false;
  const sink = (event) => {
    if (closed) throw new Error("NDJSON output sink is closed.");
    fs.writeSync(descriptor, `${JSON.stringify(jsonSafe(event))}\n`);
  };
  sink.close = () => {
    if (closed) return;
    fs.closeSync(descriptor);
    closed = true;
  };
  return sink;
}

async function main(argv) {
  const options = parseCli(argv);
  const sink = createNdjsonSink(options.out);
  try {
    if (options.mode === "local") {
      const result = await runLocalExactFlow({ ...options, eventSink: sink });
      if (options.out) {
        process.stdout.write(`${JSON.stringify(jsonSafe(result.summary), null, 2)}\n`);
      }
      return;
    }
    const result = await observeSdnRuntime({ ...options, eventSink: sink });
    sink({ kind: "observe-summary", result });
    if (options.out) {
      process.stdout.write(`${JSON.stringify(jsonSafe(result), null, 2)}\n`);
    }
  } finally {
    sink.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
