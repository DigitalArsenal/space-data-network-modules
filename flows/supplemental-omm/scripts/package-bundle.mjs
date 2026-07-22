import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUNDLE_SIGNATURE_HASH_ALGORITHM,
  computeCanonicalModuleHash,
  createSingleFileBundle,
  decodeAppManifest,
  encodeAppManifest,
  encodePluginManifest,
  extractPublicationRecordCollection,
  parseSingleFileBundle,
  signModuleArtifact,
  verifyModuleArtifact,
} from "../../../node_modules/space-data-module-sdk/src/index.js";
import { sha256Bytes } from "../../../node_modules/space-data-module-sdk/src/utils/crypto.js";
import { bytesToHex } from "../../../node_modules/space-data-module-sdk/src/utils/encoding.js";
import { resolveSupplementalSigning } from "../nodes/signing.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const unsignedRoot = path.join(distRoot, ".unsigned");
const appRoot = path.join(packageRoot, "app");
const {
  signingSeed,
  signingKeyId,
  developmentOnly,
  productionMode,
} = resolveSupplementalSigning({
  environment: process.env,
  environmentPrefix: "SDM_BUNDLE",
  developmentSigningSeed: "",
  defaultSigningKeyId: "",
});

if (process.argv.includes("--prepare")) {
  fs.rmSync(unsignedRoot, { recursive: true, force: true });
  fs.mkdirSync(unsignedRoot, { recursive: true, mode: 0o700 });
  console.log("Prepared isolated unsigned build staging.");
  process.exit(0);
}

function readBuildBytes(relativePath) {
  return new Uint8Array(fs.readFileSync(path.join(unsignedRoot, relativePath)));
}

function readBuildJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(unsignedRoot, relativePath), "utf8"));
}

function readPackageBytes(relativePath) {
  return new Uint8Array(fs.readFileSync(path.resolve(packageRoot, relativePath)));
}

function readPackageJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(packageRoot, relativePath), "utf8"));
}

async function sha256Hex(bytes) {
  return bytesToHex(await sha256Bytes(bytes));
}

function sha256HexSync(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveContentFile(relativePath) {
  const candidate = path.resolve(appRoot, relativePath);
  const prefix = `${appRoot}${path.sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new Error(`APP page contentFile escapes the app directory: ${relativePath}`);
  }
  return candidate;
}

async function materializeApp(portableWasmSha256) {
  const app = readPackageJson("app/app.json");
  if (!Array.isArray(app.modules) || app.modules.length !== 1) {
    throw new Error("Supplemental OMM APP must reference exactly one composed module.");
  }
  app.modules[0].contentHash = portableWasmSha256;

  for (const page of app.pages ?? []) {
    if (typeof page.contentFile !== "string" || page.contentFile.length === 0) {
      throw new Error(`APP page ${JSON.stringify(page.id)} must own a contentFile.`);
    }
    const source = fs.readFileSync(resolveContentFile(page.contentFile), "utf8");
    page.content = source.replaceAll("__MODULE_CONTENT_HASH__", portableWasmSha256);
    if (page.content.includes("__MODULE_CONTENT_HASH__")) {
      throw new Error(`APP page ${JSON.stringify(page.id)} retains a module hash placeholder.`);
    }
    page.contentSha256 = await sha256Hex(new TextEncoder().encode(page.content));
    delete page.contentFile;
  }

  for (const flow of app.dataflow ?? []) {
    if (typeof flow.locator === "string") {
      flow.locator = flow.locator.replaceAll("{contentHash}", portableWasmSha256);
    }
  }
  if (JSON.stringify(app).includes("{contentHash}")) {
    throw new Error("APP manifest retains an unresolved contentHash placeholder.");
  }

  const bytes = encodeAppManifest(app);
  const decoded = decodeAppManifest(bytes);
  if (decoded.modules[0]?.contentHash !== portableWasmSha256) {
    throw new Error("Encoded APP module identity does not match the portable WASM hash.");
  }
  return bytes;
}

async function loadSignedChildren(flow) {
  const nodes = flow.nodes ?? [];
  if (nodes.length === 0) {
    throw new Error("The Supplemental OMM flow must contain independently packaged nodes.");
  }

  const childArtifacts = [];
  for (const node of nodes) {
    if (node.dispatchModel !== "isomorphic") {
      throw new Error(
        `Node ${node.nodeId} must use dispatchModel \"isomorphic\"; received ${JSON.stringify(node.dispatchModel)}.`,
      );
    }
    if (
      typeof node.artifact?.path !== "string" ||
      typeof node.artifact?.publisher !== "string" ||
      !/^[0-9a-f]{64}$/.test(node.artifact?.sha256 ?? "")
    ) {
      throw new Error(
        `Node ${node.nodeId} must bind artifact.path, artifact.publisher, and an exact sha256.`,
      );
    }

    const wasmBytes = readPackageBytes(node.artifact.path);
    const actualSha256 = sha256HexSync(wasmBytes);
    if (actualSha256 !== node.artifact.sha256) {
      throw new Error(
        `Node ${node.nodeId} artifact hash mismatch: expected ${node.artifact.sha256}; received ${actualSha256}.`,
      );
    }

    const publisherBytes = readPackageBytes(node.artifact.publisher);
    const publisher = JSON.parse(new TextDecoder().decode(publisherBytes));
    if (!/^[0-9a-f]{64}$/.test(publisher.publicKeyHex ?? "")) {
      throw new Error(`Node ${node.nodeId} publisher record has no Ed25519 public key.`);
    }
    const verified = await verifyModuleArtifact(wasmBytes, {
      trustedPublicKeys: [publisher.publicKeyHex],
      requireSignature: true,
    });
    if (!verified.verified || verified.signatureScope !== "bundle") {
      throw new Error(`Node ${node.nodeId} failed whole-artifact signature verification.`);
    }
    if (productionMode && publisher.developmentOnly !== false) {
      throw new Error(
        `Production bundle rejects development publisher for node ${node.nodeId}.`,
      );
    }

    childArtifacts.push({
      nodeId: node.nodeId,
      pluginId: node.pluginId,
      methodId: node.methodId,
      dispatchModel: node.dispatchModel,
      sha256: actualSha256,
      entryId: `nodes/${node.nodeId}.wasm`,
      publisherEntryId: `nodes/${node.nodeId}.publisher.json`,
      publisherKeyId: publisher.keyId ?? null,
      publisherPublicKeyHex: publisher.publicKeyHex,
      wasmBytes,
      publisherBytes,
    });
  }
  return childArtifacts;
}

function childBundleEntries(children) {
  return children.flatMap((child) => [
    {
      entryId: child.entryId,
      role: "auxiliary",
      sectionName: `sdn.flow.node.${child.nodeId}`,
      payloadEncoding: "raw",
      mediaType: "application/wasm",
      payload: child.wasmBytes,
      description: `Exact independently signed WASM artifact for ${child.pluginId}.`,
    },
    {
      entryId: child.publisherEntryId,
      role: "auxiliary",
      sectionName: `sdn.flow.node-publisher.${child.nodeId}`,
      payloadEncoding: "json-utf8",
      mediaType: "application/json",
      payload: child.publisherBytes,
      description: `Publisher trust record for ${child.pluginId}.`,
    },
  ]);
}

const rawWasm = readBuildBytes("isomorphic/module.wasm");
const flowManifest = readBuildJson("plugin-manifest.json");
const flowSource = readPackageJson("flow.json");
const flowPLG = encodePluginManifest(flowManifest);
const children = await loadSignedChildren(flowSource);
const canonical = await computeCanonicalModuleHash(rawWasm);
const portableWasmSha256 = canonical.hashHex;
const appAPP = await materializeApp(portableWasmSha256);

const artifact = readBuildJson("artifact.json");
if (artifact.dispatchModel && artifact.dispatchModel !== "isomorphic") {
  throw new Error(
    `Compiler emitted forbidden flow dispatch model ${JSON.stringify(artifact.dispatchModel)}.`,
  );
}
artifact.dispatchModel = "isomorphic";
artifact.nodeArtifacts = children.map(
  ({ wasmBytes, publisherBytes, ...descriptor }) => descriptor,
);
const childByNodeId = new Map(children.map((child) => [child.nodeId, child]));
const nodeById = new Map(
  (flowSource.nodes ?? []).map((node) => [node.nodeId, node]),
);
const runtimeRouteKeys = new Set();
artifact.runtimeNodeRoutes = (flowSource.runtimeNodeRoutes ?? []).map((route) => {
  if (
    typeof route?.key !== "string" ||
    route.key.length === 0 ||
    runtimeRouteKeys.has(route.key)
  ) {
    throw new Error(
      `Every runtime node route requires a unique non-empty opaque key; received ${JSON.stringify(route?.key)}.`,
    );
  }
  runtimeRouteKeys.add(route.key);
  const node = nodeById.get(route.nodeId);
  if (!node || !childByNodeId.has(route.nodeId)) {
    throw new Error(
      `Runtime route ${route.key} references missing signed node ${JSON.stringify(route.nodeId)}.`,
    );
  }
  const manifest = readPackageJson(
    path.join(path.dirname(node.artifact.path), "..", "..", "plugin-manifest.json"),
  );
  const method = (manifest.methods ?? []).find(
    (candidate) => candidate.methodId === node.methodId,
  );
  if (!(method?.outputPorts ?? []).some((port) => port.portId === route.portId)) {
    throw new Error(
      `Runtime route ${route.key} references undeclared output ${route.nodeId}.${route.portId}.`,
    );
  }
  if (typeof route.mediaType !== "string" || route.mediaType.length === 0) {
    throw new Error(`Runtime route ${route.key} requires a mediaType.`);
  }
  return {
    key: route.key,
    nodeId: route.nodeId,
    portId: route.portId,
    mediaType: route.mediaType,
  };
});
if (artifact.runtimeNodeRoutes.length === 0) {
  throw new Error("The Supplemental OMM artifact must declare runtime node routes.");
}
const childEntryIds = children.flatMap((child) => [
  child.entryId,
  child.publisherEntryId,
]);
artifact.bundle = {
  version: 2,
  portableWasmSha256,
  flowPlgSha256: await sha256Hex(flowPLG),
  appSha256: await sha256Hex(appAPP),
  signatureHashAlgorithm: BUNDLE_SIGNATURE_HASH_ALGORITHM,
  requiredEntries: [
    "manifest",
    "flow.plg",
    "artifact.json",
    "app.app",
    ...childEntryIds,
    "signature",
  ],
};
const artifactBytes = new TextEncoder().encode(`${JSON.stringify(artifact, null, 2)}\n`);

const unsigned = await createSingleFileBundle({
  wasmBytes: rawWasm,
  manifestBytes: flowPLG,
  entries: [
    {
      entryId: "flow.plg",
      role: "auxiliary",
      sectionName: "sdn.flow.plg",
      payloadEncoding: "flatbuffer",
      typeRef: { schemaName: "PLG.fbs", fileIdentifier: "$PLG" },
      payload: flowPLG,
      description: "Canonical flow plugin manifest.",
    },
    {
      entryId: "artifact.json",
      role: "auxiliary",
      sectionName: "sdn.flow.artifact",
      payloadEncoding: "json-utf8",
      mediaType: "application/json",
      payload: artifactBytes,
      description: "Deterministic independently dispatched flow artifact metadata.",
    },
    {
      entryId: "app.app",
      role: "auxiliary",
      sectionName: "sdn.app.record",
      payloadEncoding: "flatbuffer",
      typeRef: { schemaName: "APP.fbs", fileIdentifier: "$APP" },
      payload: appAPP,
      description: "Canonical application manifest and inline entry page.",
    },
    ...childBundleEntries(children),
  ],
});
const signed = await signModuleArtifact(unsigned.wasmBytes, {
  privateKeySeedHex: signingSeed,
  keyId: signingKeyId,
  signatureScope: "bundle",
});
if (
  productionMode &&
  children.some(
    (child) => child.publisherPublicKeyHex !== signed.signature.publicKeyHex,
  )
) {
  throw new Error(
    "Production bundle requires every exact child and the outer bundle to use the shared release signer.",
  );
}
const verified = await verifyModuleArtifact(signed.wasmBytes, {
  trustedPublicKeys: [signed.signature.publicKeyHex],
  requireSignature: true,
});
if (!verified.verified || verified.signatureScope !== "bundle") {
  throw new Error("The packaged module failed whole-bundle signature verification.");
}

const parsed = await parseSingleFileBundle(signed.wasmBytes);
const expectedEntryIds = artifact.bundle.requiredEntries.toSorted();
const actualEntryIds = parsed.entries.map((entry) => entry.entryId).toSorted();
if (JSON.stringify(actualEntryIds) !== JSON.stringify(expectedEntryIds)) {
  throw new Error(
    `Packaged entry set mismatch: expected ${expectedEntryIds.join(", ")}; received ${actualEntryIds.join(", ")}.`,
  );
}
const protectedArtifact = extractPublicationRecordCollection(signed.wasmBytes);
if (!protectedArtifact) {
  throw new Error("Signed output is missing its REC/MBL publication trailer.");
}
if ((await sha256Hex(protectedArtifact.payloadBytes)) !== portableWasmSha256) {
  throw new Error("Published trailer-stripped WASM does not match APP module identity.");
}

fs.mkdirSync(path.join(distRoot, "isomorphic"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(distRoot, "flow.json"), readBuildBytes("flow.json"));
fs.writeFileSync(
  path.join(distRoot, "plugin-manifest.json"),
  readBuildBytes("plugin-manifest.json"),
);
fs.writeFileSync(path.join(distRoot, "flow.plg"), flowPLG);
fs.writeFileSync(path.join(distRoot, "app.app"), appAPP);
fs.writeFileSync(path.join(distRoot, "artifact.json"), artifactBytes);
fs.writeFileSync(path.join(distRoot, "isomorphic", "module.wasm"), signed.wasmBytes);
fs.writeFileSync(path.join(distRoot, "runtime.wasm"), signed.wasmBytes);
fs.writeFileSync(
  path.join(distRoot, "publisher.json"),
  `${JSON.stringify(
    {
      algorithm: "ed25519",
      keyId: signingKeyId,
      publicKeyHex: signed.signature.publicKeyHex,
      developmentOnly,
    },
    null,
    2,
  )}\n`,
);
fs.rmSync(unsignedRoot, { recursive: true, force: true });

console.log(
  JSON.stringify({
    artifact: "dist/isomorphic/module.wasm",
    portableWasmSha256,
    childArtifacts: children.map(({ nodeId, pluginId, sha256 }) => ({
      nodeId,
      pluginId,
      sha256,
    })),
    signedHashAlgorithm: signed.signature.signedHashAlgorithm,
    signedHashHex: signed.signature.signedHashHex,
    publicKeyHex: signed.signature.publicKeyHex,
    keyId: signed.signature.keyId,
  }),
);
