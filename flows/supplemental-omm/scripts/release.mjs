#!/usr/bin/env node
/**
 * The Supplemental OMM release: one signed single-file bundle whose every child is an exact, independently signed
 * isomorphic WASM artifact.
 *
 *   SUPPLEMENTAL_OMM_SIGNING_SEED_HEX=<seed> SUPPLEMENTAL_OMM_SIGNING_KEY_ID=<id> \
 *   [NODE_ENV=production] node scripts/release.mjs [--out <dir>]          (default --out ./dist)
 *
 * 1. Every plugin flow.json names is taken UNSIGNED and portable from its package (deps.json: the five source
 *    modules, hostcap/http-request, hostcap/storage-ingest, this flow's nodes/od and nodes/status), its
 *    dist/isomorphic/module.wasm. A production release compiles each one's WasmEdge universal-AOT section (child
 *    profile: gas measuring) first; every one is then signed, bundle scope, with the release key:
 *    <out>/nodes/<pluginId>.wasm, and <out>/publisher.json names the key.
 * 2. flow.json is compiled by the SDK flow compiler with each node an isomorphic child bound to its signed artifact
 *    by SHA-256 (the compiler verifies every signature).
 * 3. The parent runtime (AOT parent profile in production), the flow PLG, the artifact metadata, the APP and every
 *    child with its publisher record become one single-file bundle, signed bundle scope with the same key:
 *    <out>/isomorphic/module.wasm (and runtime.wasm, flow.plg, app.app, artifact.json, flow.json,
 *    plugin-manifest.json, publisher.json).
 *
 * The key comes only from the environment (nodes/signing.mjs); nothing here holds one. The tests run this script with
 * a key they generate and throw away, into a temporary directory.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
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
  listWasmCustomSections,
  parseSingleFileBundle,
  signModuleArtifact,
  verifyModuleArtifact,
} from "space-data-module-sdk";
import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

import { resolveReleaseSigning } from "../nodes/signing.mjs";
import { compileUniversalAot } from "../nodes/universal-aot.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The standards the manifests are validated against: SPACE_DATA_STANDARDS_ROOT, else the spacedatastandards.org package
// this flow pins (package.json devDependencies).
process.env.SPACE_DATA_STANDARDS_ROOT ??= path.dirname(createRequire(import.meta.url).resolve("spacedatastandards.org/package.json"));
// --flow-dir <dir under this package>: another flow of the package (its flow.json, deps.json and app/); default the package.
const flowArg = process.argv.indexOf("--flow-dir");
const flowRoot = flowArg > 0 ? path.resolve(packageRoot, process.argv[flowArg + 1]) : packageRoot;
const outArg = process.argv.indexOf("--out");
const outRoot = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(packageRoot, "dist"));
const stageRoot = path.join(outRoot, ".release");
const { signingSeed, signingKeyId, productionMode } = resolveReleaseSigning(process.env);
const EGRESS = "sdn.flow.egress";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function assertUniversalAotArtifact(label, signedBytes) {
  const executable = extractPublicationRecordCollection(signedBytes)?.payloadBytes ?? signedBytes;
  if (!WebAssembly.validate(executable)) throw new Error(`${label} is not browser-valid WASM.`);
  const aot = listWasmCustomSections(executable).filter((section) => section.name === "wasmedge");
  if (aot.length !== 1 || aot[0].dataBytes.byteLength === 0) {
    throw new Error(`${label} must contain exactly one non-empty WasmEdge universal-AOT section.`);
  }
}

fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(stageRoot, "compiled"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(outRoot, "nodes"), { recursive: true });

// 1. The children.
const flowSource = readJson(path.join(flowRoot, "flow.json"));
const depsMap = readJson(path.join(flowRoot, "deps.json"));
const pluginIds = [...new Set(flowSource.nodes.map((node) => node.pluginId).filter((id) => id !== EGRESS))];
const children = new Map();
let publicKeyHex = null;
for (const pluginId of pluginIds) {
  if (!depsMap[pluginId]) throw new Error(`deps.json names no package for ${pluginId}.`);
  const dir = path.resolve(flowRoot, depsMap[pluginId]);
  const manifest = readJson(path.join(dir, "plugin-manifest.json"));
  if (manifest.pluginId !== pluginId) throw new Error(`${dir} is ${manifest.pluginId}, not ${pluginId}.`);
  const portable = new Uint8Array(fs.readFileSync(path.join(dir, "dist/isomorphic/module.wasm")));
  if (extractPublicationRecordCollection(portable)) {
    throw new Error(`${pluginId}: dist/isomorphic/module.wasm is already signed; a release signs the unsigned build.`);
  }
  const executable = await compileUniversalAot({
    wasmBytes: portable,
    stagingDirectory: path.join(stageRoot, "aot", pluginId),
    mode: "child",
    productionMode,
  });
  const signed = await signModuleArtifact(executable, { privateKeySeedHex: signingSeed, keyId: signingKeyId, signatureScope: "bundle" });
  if (productionMode) assertUniversalAotArtifact(pluginId, signed.wasmBytes);
  publicKeyHex = signed.signature.publicKeyHex;
  const file = path.join(outRoot, "nodes", `${pluginId}.wasm`);
  fs.writeFileSync(file, signed.wasmBytes);
  children.set(pluginId, { pluginId, dir, file, wasmBytes: signed.wasmBytes, sha256: sha256(signed.wasmBytes) });
}
const publisherBytes = new TextEncoder().encode(
  `${JSON.stringify({ algorithm: "ed25519", keyId: signingKeyId, publicKeyHex, developmentOnly: false }, null, 2)}\n`,
);
const publisherPath = path.join(outRoot, "publisher.json");
fs.writeFileSync(publisherPath, publisherBytes);

// 2. The flow, every node an isomorphic child bound to its signed artifact.
const releaseFlow = {
  ...flowSource,
  nodes: flowSource.nodes.map((node) => {
    if (node.pluginId === EGRESS) return node;
    const child = children.get(node.pluginId);
    return { ...node, dispatchModel: "isomorphic", artifact: { path: child.file, publisher: publisherPath, sha256: child.sha256 } };
  }),
};
const releaseFlowPath = path.join(stageRoot, "flow.json");
fs.writeFileSync(releaseFlowPath, `${JSON.stringify(releaseFlow, null, 2)}\n`);
const releaseDepsPath = path.join(stageRoot, "deps.json");
fs.writeFileSync(releaseDepsPath, `${JSON.stringify(Object.fromEntries(pluginIds.map((id) => [id, children.get(id).dir])), null, 2)}\n`);
execFileSync(
  process.execPath,
  [
    path.join(packageRoot, "node_modules/space-data-module-sdk/bin/space-data-module.js"),
    "flow", "compile", releaseFlowPath, "--deps", releaseDepsPath, "--out", path.join(stageRoot, "compiled"),
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
const compiled = (name) => path.join(stageRoot, "compiled", name);

// 3. The bundle.
const rawWasm = await compileUniversalAot({
  wasmBytes: new Uint8Array(fs.readFileSync(compiled("isomorphic/module.wasm"))),
  stagingDirectory: path.join(stageRoot, "aot", "parent"),
  mode: "parent",
  productionMode,
});
const flowManifest = readJson(compiled("plugin-manifest.json"));
const flowPLG = encodePluginManifest(flowManifest);

const runtime = await createFlowRuntimeHost({ wasmSource: rawWasm, runtimeTarget: "wasmedge" });
const dependencies = new Map();
for (let index = 0; index < runtime.dependencyCount; index += 1) {
  const descriptor = runtime.getDependencyDescriptor(index);
  const child = children.get(descriptor.pluginId);
  if (!child || descriptor.sha256 !== child.sha256 || dependencies.has(descriptor.pluginId) || !descriptor.dependencyId) {
    throw new Error(`Parent runtime dependency ${index} (${descriptor.pluginId}) does not bind an exact signed child.`);
  }
  dependencies.set(descriptor.pluginId, descriptor);
}
if (dependencies.size !== children.size) {
  throw new Error(`Parent runtime declares ${dependencies.size} dependencies for ${children.size} signed children.`);
}

const portableWasmSha256 = (await computeCanonicalModuleHash(rawWasm)).hashHex;
const appBytes = await (async () => {
  const appRoot = path.join(flowRoot, "app");
  const app = readJson(path.join(appRoot, "app.json"));
  if (!Array.isArray(app.modules) || app.modules.length !== 1) throw new Error("The APP must reference exactly one composed module.");
  app.modules[0].contentHash = portableWasmSha256;
  for (const page of app.pages ?? []) {
    const file = path.resolve(appRoot, page.contentFile);
    if (!file.startsWith(`${appRoot}${path.sep}`)) throw new Error(`APP page contentFile escapes the app directory: ${page.contentFile}`);
    page.content = fs.readFileSync(file, "utf8").replaceAll("__MODULE_CONTENT_HASH__", portableWasmSha256);
    page.contentSha256 = sha256(new TextEncoder().encode(page.content));
    delete page.contentFile;
  }
  for (const flow of app.dataflow ?? []) {
    if (typeof flow.locator === "string") flow.locator = flow.locator.replaceAll("{contentHash}", portableWasmSha256);
  }
  if (JSON.stringify(app).includes("{contentHash}")) throw new Error("APP manifest retains an unresolved contentHash placeholder.");
  const bytes = encodeAppManifest(app);
  if (decodeAppManifest(bytes).modules[0]?.contentHash !== portableWasmSha256) throw new Error("APP module identity does not match the portable WASM hash.");
  return bytes;
})();

const artifact = readJson(compiled("artifact.json"));
artifact.dispatchModel = "isomorphic";
artifact.nodeArtifacts = releaseFlow.nodes
  .filter((node) => node.pluginId !== EGRESS)
  .map((node) => ({
    nodeId: node.nodeId,
    pluginId: node.pluginId,
    methodId: node.methodId,
    dispatchModel: "isomorphic",
    sha256: children.get(node.pluginId).sha256,
    entryId: dependencies.get(node.pluginId).dependencyId,
  }));
artifact.runtimeNodeRoutes = flowSource.runtimeNodeRoutes.map((route) => {
  const node = flowSource.nodes.find((candidate) => candidate.nodeId === route.nodeId);
  const manifest = node && readJson(path.join(children.get(node.pluginId).dir, "plugin-manifest.json"));
  const method = manifest?.methods.find((candidate) => candidate.methodId === node.methodId);
  if (!method?.outputPorts.some((port) => port.portId === route.portId)) {
    throw new Error(`Runtime route ${route.key} references undeclared output ${route.nodeId}.${route.portId}.`);
  }
  return { key: route.key, nodeId: route.nodeId, portId: route.portId, mediaType: route.mediaType };
});
const childEntries = [...children.values()].flatMap((child) => [
  {
    entryId: dependencies.get(child.pluginId).dependencyId,
    role: "auxiliary",
    sectionName: `sdn.flow.child.${child.pluginId}`,
    payloadEncoding: "raw",
    mediaType: "application/wasm",
    payload: child.wasmBytes,
    description: `Exact independently signed WASM artifact of ${child.pluginId}.`,
  },
]);
childEntries.push({
  entryId: "nodes/publisher.json",
  role: "auxiliary",
  sectionName: "sdn.flow.child-publisher",
  payloadEncoding: "json-utf8",
  mediaType: "application/json",
  payload: publisherBytes,
  description: "Publisher trust record of every child artifact.",
});
artifact.bundle = {
  version: 3,
  portableWasmSha256,
  flowPlgSha256: sha256(flowPLG),
  appSha256: sha256(appBytes),
  signatureHashAlgorithm: BUNDLE_SIGNATURE_HASH_ALGORITHM,
  requiredEntries: ["manifest", "flow.plg", "artifact.json", "app.app", ...childEntries.map((entry) => entry.entryId), "signature"],
};
const artifactBytes = new TextEncoder().encode(`${JSON.stringify(artifact, null, 2)}\n`);

const unsigned = await createSingleFileBundle({
  wasmBytes: rawWasm,
  manifestBytes: flowPLG,
  entries: [
    { entryId: "flow.plg", role: "auxiliary", sectionName: "sdn.flow.plg", payloadEncoding: "flatbuffer", typeRef: { schemaName: "PLG.fbs", fileIdentifier: "$PLG" }, payload: flowPLG, description: "Canonical flow plugin manifest." },
    { entryId: "artifact.json", role: "auxiliary", sectionName: "sdn.flow.artifact", payloadEncoding: "json-utf8", mediaType: "application/json", payload: artifactBytes, description: "Flow artifact metadata: the isomorphic children and the runtime routes." },
    { entryId: "app.app", role: "auxiliary", sectionName: "sdn.app.record", payloadEncoding: "flatbuffer", typeRef: { schemaName: "APP.fbs", fileIdentifier: "$APP" }, payload: appBytes, description: "Canonical application manifest and inline entry page." },
    ...childEntries,
  ],
});
const signed = await signModuleArtifact(unsigned.wasmBytes, { privateKeySeedHex: signingSeed, keyId: signingKeyId, signatureScope: "bundle" });
const verified = await verifyModuleArtifact(signed.wasmBytes, { trustedPublicKeys: [publicKeyHex], requireSignature: true });
if (!verified.verified || verified.signatureScope !== "bundle") throw new Error("The bundle failed whole-bundle signature verification.");
const parsed = await parseSingleFileBundle(signed.wasmBytes);
const expectedEntries = [...artifact.bundle.requiredEntries].sort();
const actualEntries = parsed.entries.map((entry) => entry.entryId).sort();
if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
  throw new Error(`Bundle entry set mismatch: expected ${expectedEntries.join(", ")}; received ${actualEntries.join(", ")}.`);
}
const trailer = extractPublicationRecordCollection(signed.wasmBytes);
if (!trailer || (await computeCanonicalModuleHash(trailer.payloadBytes)).hashHex !== portableWasmSha256) {
  throw new Error("The bundle's trailer-stripped WASM does not match the APP module identity.");
}
if (productionMode) assertUniversalAotArtifact("parent", signed.wasmBytes);

fs.mkdirSync(path.join(outRoot, "isomorphic"), { recursive: true });
fs.writeFileSync(path.join(outRoot, "isomorphic/module.wasm"), signed.wasmBytes);
fs.writeFileSync(path.join(outRoot, "runtime.wasm"), signed.wasmBytes);
fs.writeFileSync(path.join(outRoot, "flow.json"), fs.readFileSync(compiled("flow.json")));
fs.writeFileSync(path.join(outRoot, "plugin-manifest.json"), fs.readFileSync(compiled("plugin-manifest.json")));
fs.writeFileSync(path.join(outRoot, "flow.plg"), flowPLG);
fs.writeFileSync(path.join(outRoot, "app.app"), appBytes);
fs.writeFileSync(path.join(outRoot, "artifact.json"), artifactBytes);
fs.rmSync(stageRoot, { recursive: true, force: true });

console.log(JSON.stringify({
  artifact: path.join(outRoot, "isomorphic/module.wasm"),
  productionMode,
  portableWasmSha256,
  children: [...children.values()].map(({ pluginId, sha256: hash }) => ({ pluginId, sha256: hash })),
  publicKeyHex,
  keyId: signingKeyId,
}));
