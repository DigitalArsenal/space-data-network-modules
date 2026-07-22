import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseSingleFileBundle,
  verifyModuleArtifact,
} from "../../../node_modules/space-data-module-sdk/src/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const flatSqlPluginId = "com.digitalarsenal.flatsql.store";
const timerPluginId = "org.sdn.flows.supplemental-omm.timer";
const statusPluginId = "org.sdn.flows.supplemental-omm.status";
const publicationPluginId = "org.sdn.flows.supplemental-omm.publication";
const independentlyPackagedPluginIds = [
  flatSqlPluginId,
  timerPluginId,
  statusPluginId,
  publicationPluginId,
];

const forbiddenSourceMarkers = new Map([
  ["hostcap FlatSQL store", /com\.digitalarsenal\.hostcap\.flatsql-store/i],
  ["storage_engine_link capability", /storage_engine_link/i],
  ["engineLinkage compiler switch", /engineLinkage/i],
  ["linkedStore descriptor", /linkedStore/i],
  ["FlatSQL link shim", /flatsql[-_]link[-_]shim/i],
  ["host-authored cron", /host-cron/i],
]);

const sourceContractFiles = [
  "flow.json",
  "deps.json",
  "package.json",
  "scripts/package-bundle.mjs",
];

function readText(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function findNode(flow, pluginId) {
  return (flow.nodes ?? []).find((node) => node.pluginId === pluginId);
}

function resolveArtifactDescriptor(node, label) {
  assert.ok(node, `${label} must be an explicit graph node`);
  assert.equal(
    typeof node.artifact?.path,
    "string",
    `${label} must declare artifact.path`,
  );
  assert.match(
    node.artifact?.sha256 ?? "",
    /^[0-9a-f]{64}$/,
    `${label} must bind the exact signed artifact sha256`,
  );
  assert.equal(
    typeof node.artifact?.publisher,
    "string",
    `${label} must declare its publisher trust record`,
  );
  return {
    artifactPath: path.resolve(packageRoot, node.artifact.path),
    publisherPath: path.resolve(packageRoot, node.artifact.publisher),
    expectedSha256: node.artifact.sha256,
  };
}

function loadDependencyManifest(deps, pluginId) {
  const packagePath = deps[pluginId];
  assert.equal(
    typeof packagePath,
    "string",
    `deps.json must map ${pluginId} to an independently packaged module directory`,
  );
  const manifestPath = path.resolve(packageRoot, packagePath, "plugin-manifest.json");
  assert.ok(fs.existsSync(manifestPath), `missing dependency manifest ${manifestPath}`);
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function methodForNode(node, manifests) {
  const manifest = manifests.get(node.pluginId);
  assert.ok(manifest, `missing manifest for ${node.pluginId}`);
  const method = (manifest.methods ?? []).find(
    (candidate) => candidate.methodId === node.methodId,
  );
  assert.ok(method, `missing method ${node.pluginId}:${node.methodId}`);
  return method;
}

function schemaIdentity(type) {
  return {
    schemaName: type?.schemaName ?? null,
    fileIdentifier: type?.fileIdentifier ?? null,
    schemaVersion: type?.schemaVersion ?? null,
    schemaHash: type?.schemaHash ?? null,
    rootTypeName: type?.rootTypeName ?? null,
  };
}

function pairedTypes(port, location) {
  assert.equal(
    port?.acceptedTypeSets?.length,
    1,
    `${location} must declare exactly one accepted SDS type set`,
  );
  const types = port.acceptedTypeSets[0]?.allowedTypes ?? [];
  assert.equal(
    types.length,
    2,
    `${location} must declare exactly two representations`,
  );
  assert.equal(
    types.some((type) => type?.acceptsAnyFlatbuffer === true),
    false,
    `${location} must not use a wildcard type`,
  );
  const canonical = types.find(
    (type) => (type.wireFormat ?? "flatbuffer") === "flatbuffer",
  );
  const aligned = types.find((type) => type.wireFormat === "aligned-binary");
  assert.ok(canonical, `${location} is missing canonical FlatBuffer fallback`);
  assert.ok(aligned, `${location} is missing aligned-binary representation`);
  assert.deepEqual(
    schemaIdentity(aligned),
    schemaIdentity(canonical),
    `${location} representations must have identical schema identity`,
  );
  assert.equal(
    Number.isSafeInteger(aligned.byteLength) && aligned.byteLength > 0,
    true,
    `${location} aligned representation must declare byteLength`,
  );
  assert.equal(
    Number.isSafeInteger(aligned.requiredAlignment) &&
      aligned.requiredAlignment > 0,
    true,
    `${location} aligned representation must declare requiredAlignment`,
  );
  return { canonical, aligned };
}

for (const [label, pattern] of forbiddenSourceMarkers) {
  test(`authored Supplemental sources reject ${label}`, () => {
    for (const relativePath of sourceContractFiles) {
      assert.doesNotMatch(
        readText(relativePath),
        pattern,
        `${relativePath} contains forbidden ${label}`,
      );
    }
  });
}

test("FlatSQL, timer, status, and publication are explicit child nodes", () => {
  const flow = readJson("flow.json");
  assert.ok(findNode(flow, flatSqlPluginId), "missing independent FlatSQL node");
  assert.ok(findNode(flow, timerPluginId), "missing independent timer node");
  assert.ok(findNode(flow, statusPluginId), "missing independent status node");
  assert.ok(
    findNode(flow, publicationPluginId),
    "missing independent publication node",
  );
  assert.deepEqual(
    flow.triggers ?? [],
    [
      {
        triggerId: "startup",
        kind: "manual",
        source: "generic-lifecycle",
        acceptedTypes: (loadDependencyManifest(
          readJson("deps.json"),
          timerPluginId,
        ).methods.find((method) => method.methodId === "on_wakeup")?.inputPorts ?? [])
          .find((port) => port.portId === "wakeup")
          ?.acceptedTypeSets?.[0]?.allowedTypes,
        description: "Generic lifecycle ingress for the timer policy node.",
      },
    ],
    "only a non-scheduling generic startup ingress is permitted",
  );
  assert.deepEqual(
    flow.triggerBindings ?? [],
    [
      {
        triggerId: "startup",
        targetNodeId: "timer",
        targetPortId: "wakeup",
        backpressurePolicy: "queue",
        queueDepth: 1,
      },
    ],
    "startup may target only the timer; provider fan-out must use typed edges",
  );
  assert.equal(
    JSON.stringify(flow).includes("storage_engine_link"),
    false,
  );
});

for (const pluginId of independentlyPackagedPluginIds) {
  test(`${pluginId} is bound by exact hash to a valid independent signature`, async () => {
    const flow = readJson("flow.json");
    const node = findNode(flow, pluginId);
    const descriptor = resolveArtifactDescriptor(node, pluginId);
    assert.ok(
      fs.existsSync(descriptor.artifactPath),
      `${pluginId} artifact is missing: ${descriptor.artifactPath}`,
    );
    assert.ok(
      fs.existsSync(descriptor.publisherPath),
      `${pluginId} publisher record is missing: ${descriptor.publisherPath}`,
    );
    const bytes = fs.readFileSync(descriptor.artifactPath);
    assert.equal(
      sha256(bytes),
      descriptor.expectedSha256,
      `${pluginId} exact artifact hash changed without updating the flow lock`,
    );
    const publisher = JSON.parse(fs.readFileSync(descriptor.publisherPath, "utf8"));
    assert.match(publisher.publicKeyHex ?? "", /^[0-9a-f]{64}$/);
    const verified = await verifyModuleArtifact(bytes, {
      trustedPublicKeys: [publisher.publicKeyHex],
      requireSignature: true,
    });
    assert.equal(verified.verified, true, `${pluginId} signature did not verify`);
    assert.equal(
      verified.signatureScope,
      "bundle",
      `${pluginId} signature must bind its complete artifact`,
    );
  });
}

test("every graph edge has mutually compatible canonical and aligned SDS representations", () => {
  const flow = readJson("flow.json");
  const deps = readJson("deps.json");
  const manifests = new Map(
    Object.keys(deps).map((pluginId) => [
      pluginId,
      loadDependencyManifest(deps, pluginId),
    ]),
  );
  const nodes = new Map((flow.nodes ?? []).map((node) => [node.nodeId, node]));

  assert.ok((flow.edges ?? []).length > 0, "Supplemental graph must declare typed edges");
  for (const edge of flow.edges ?? []) {
    const producer = nodes.get(edge.fromNodeId);
    const consumer = nodes.get(edge.toNodeId);
    assert.ok(producer, `unknown producer ${edge.fromNodeId}`);
    assert.ok(consumer, `unknown consumer ${edge.toNodeId}`);
    const producerMethod = methodForNode(producer, manifests);
    const consumerMethod = methodForNode(consumer, manifests);
    const producerPort = (producerMethod.outputPorts ?? []).find(
      (port) => port.portId === edge.fromPortId,
    );
    const consumerPort = (consumerMethod.inputPorts ?? []).find(
      (port) => port.portId === edge.toPortId,
    );
    const edgeLabel = `${edge.fromNodeId}.${edge.fromPortId}->${edge.toNodeId}.${edge.toPortId}`;
    assert.ok(producerPort, `${edgeLabel} has no producer output port`);
    assert.ok(consumerPort, `${edgeLabel} has no consumer input port`);
    const producerTypes = pairedTypes(producerPort, `${edgeLabel} producer`);
    const consumerTypes = pairedTypes(consumerPort, `${edgeLabel} consumer`);
    assert.deepEqual(
      schemaIdentity(producerTypes.canonical),
      schemaIdentity(consumerTypes.canonical),
      `${edgeLabel} canonical representations are incompatible`,
    );
    assert.equal(
      producerTypes.aligned.byteLength,
      consumerTypes.aligned.byteLength,
      `${edgeLabel} aligned byte lengths differ`,
    );
    assert.equal(
      producerTypes.aligned.requiredAlignment,
      consumerTypes.aligned.requiredAlignment,
      `${edgeLabel} aligned requirements differ`,
    );
  }
});

test("the outer signed bundle contains exact independently signed child artifacts", async () => {
  const flow = readJson("flow.json");
  const publishedPath = path.join(packageRoot, "dist/isomorphic/module.wasm");
  assert.ok(fs.existsSync(publishedPath), "missing publishable flow bundle");
  const parsed = await parseSingleFileBundle(fs.readFileSync(publishedPath));
  const entries = new Map(parsed.entries.map((entry) => [entry.entryId, entry]));
  assert.equal(entries.has("flatsql-link-shim.wasm"), false);

  for (const pluginId of independentlyPackagedPluginIds) {
    const node = findNode(flow, pluginId);
    const descriptor = resolveArtifactDescriptor(node, pluginId);
    const entryId = `nodes/${node.nodeId}.wasm`;
    const entry = entries.get(entryId);
    assert.ok(entry, `bundle is missing child artifact entry ${entryId}`);
    const expected = fs.readFileSync(descriptor.artifactPath);
    assert.deepEqual(
      entry.payloadBytes,
      new Uint8Array(expected),
      `${entryId} does not contain the exact locked artifact bytes`,
    );
  }
});
