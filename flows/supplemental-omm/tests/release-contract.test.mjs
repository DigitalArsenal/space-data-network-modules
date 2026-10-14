// The release contract of the Supplemental OMM bundle (scripts/release.mjs): one key signs every child and the
// bundle; every node of the flow is an exact, independently signed isomorphic child, bound by SHA-256 in the parent
// runtime and carried in the bundle; the children are the typed source modules, hostcap/http-request,
// hostcap/storage-ingest and the flow's OD and status nodes; a production release also carries a WasmEdge
// universal-AOT section in every child and the parent. The real release key is never here: the release is built with a
// key generated for the test and thrown away (tests/lib/flow.mjs).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeAppManifest, extractPublicationRecordCollection, listWasmCustomSections, verifyModuleArtifact } from "space-data-module-sdk";
import { createFlowRuntimeHost } from "space-data-module-sdk/flow";

import { isEmbeddedDevelopmentSigningSeed, resolveReleaseSigning } from "../nodes/signing.mjs";
import { openRelease, packageRoot, sha256 } from "./lib/flow.mjs";

const flow = JSON.parse(fs.readFileSync(path.join(packageRoot, "flow.json"), "utf8"));
const deps = JSON.parse(fs.readFileSync(path.join(packageRoot, "deps.json"), "utf8"));
const CHILDREN = [
  "com.orbpro.spacex-starlink-source",
  "com.orbpro.glonass-source",
  "com.orbpro.intelsat-source",
  "com.orbpro.cpf-source",
  "com.orbpro.iss-source",
  "com.digitalarsenal.hostcap.http-request",
  "com.digitalarsenal.hostcap.storage-ingest",
  "org.sdn.flows.supplemental-omm.od",
  "org.sdn.flows.supplemental-omm.status",
].sort();
// The legacy flow's own provider copies, timer, FlatSQL and publication nodes: retired.
const RETIRED = /^org\.sdn\.flows\.supplemental-omm\.(provider-|timer|publication)|^com\.digitalarsenal\.flatsql\.store$/;
const LEGACY_RELEASE_SIGNER = "d4b97660cea81cff7db4bccc8be327efb259ec7b48cf8bf6c0d7d9819b1537fd";

test("the release key comes only from the environment, never an embedded development seed", () => {
  assert.throws(() => resolveReleaseSigning({}), /SUPPLEMENTAL_OMM_SIGNING_SEED_HEX and SUPPLEMENTAL_OMM_SIGNING_KEY_ID/);
  assert.throws(() => resolveReleaseSigning({ SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: "9a".repeat(32) }), /SUPPLEMENTAL_OMM_SIGNING_KEY_ID/);
  assert.throws(() => resolveReleaseSigning({ SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: "9a", SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "k" }), /32-byte Ed25519 seed/);
  for (const byte of ["43", "44", "45", "51", "52", "53", "54", "55"]) {
    assert.ok(isEmbeddedDevelopmentSigningSeed(byte.repeat(32)));
    assert.throws(() => resolveReleaseSigning({ SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: byte.repeat(32), SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "k" }), /development signing seed/);
  }
  assert.deepEqual(resolveReleaseSigning({ NODE_ENV: "production", SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: "9a".repeat(32), SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "release" }), {
    signingSeed: "9a".repeat(32), signingKeyId: "release", productionMode: true,
  });
  assert.equal(resolveReleaseSigning({ SUPPLEMENTAL_OMM_BUILD_MODE: "production", SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: "9a".repeat(32), SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "r" }).productionMode, true);
  assert.equal(resolveReleaseSigning({ SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: "9a".repeat(32), SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "r" }).productionMode, false);
});

test("what the release signs is the unsigned build of every child package", () => {
  for (const pluginId of CHILDREN) {
    const dir = path.resolve(packageRoot, deps[pluginId]);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin-manifest.json"), "utf8"));
    assert.equal(manifest.pluginId, pluginId);
    const wasm = new Uint8Array(fs.readFileSync(path.join(dir, "dist/isomorphic/module.wasm")));
    assert.ok(WebAssembly.validate(wasm), pluginId);
    assert.equal(extractPublicationRecordCollection(wasm), null, `${pluginId}: built unsigned; the release signs it`);
  }
  assert.deepEqual([...new Set(flow.nodes.map((n) => n.pluginId))].filter((id) => id !== "sdn.flow.egress").sort(), CHILDREN);
  assert.deepEqual(Object.keys(deps).sort(), CHILDREN);
});

test("one key signs the bundle and every exact child; the parent binds each child by SHA-256", async () => {
  const { bundle, summary, entries, artifact } = await openRelease();
  assert.equal((await verifyModuleArtifact(bundle, { trustedPublicKeys: [summary.publicKeyHex], requireSignature: true })).signatureScope, "bundle");
  await assert.rejects(verifyModuleArtifact(bundle, { trustedPublicKeys: [LEGACY_RELEASE_SIGNER], requireSignature: true }));

  assert.deepEqual([...entries.keys()].sort(), [...artifact.bundle.requiredEntries].sort());
  assert.deepEqual(summary.children.map((c) => c.pluginId).sort(), CHILDREN);
  const runtime = await createFlowRuntimeHost({ wasmSource: extractPublicationRecordCollection(bundle).payloadBytes, runtimeTarget: "browser" });
  const descriptors = Array.from({ length: runtime.dependencyCount }, (_, i) => runtime.getDependencyDescriptor(i));
  assert.deepEqual(descriptors.map((d) => d.pluginId).sort(), CHILDREN);
  for (const descriptor of descriptors) {
    const child = entries.get(descriptor.dependencyId).payloadBytes;
    assert.equal(sha256(child), descriptor.sha256, descriptor.pluginId);
    const verified = await verifyModuleArtifact(child, { trustedPublicKeys: [summary.publicKeyHex], requireSignature: true });
    assert.equal(verified.signatureScope, "bundle", descriptor.pluginId);
  }
  const publisher = JSON.parse(new TextDecoder().decode(entries.get("nodes/publisher.json").payloadBytes));
  assert.equal(publisher.publicKeyHex, summary.publicKeyHex);

  // Every flow node but the host's egress is an isomorphic child; nothing retired is in the bundle.
  assert.deepEqual(artifact.nodeArtifacts.map((n) => n.nodeId).sort(), flow.nodes.filter((n) => n.pluginId !== "sdn.flow.egress").map((n) => n.nodeId).sort());
  assert.ok(artifact.nodeArtifacts.every((n) => n.dispatchModel === "isomorphic" && /^[0-9a-f]{64}$/.test(n.sha256)));
  const ids = [...entries.keys(), ...artifact.nodeArtifacts.map((n) => n.pluginId)];
  assert.deepEqual(ids.filter((id) => RETIRED.test(id)), []);
  assert.doesNotMatch(new TextDecoder().decode(bundle), /org\.sdn\.flows\.supplemental-omm\.provider-|com\.digitalarsenal\.flatsql\.store/);

  // The APP names the bundle's portable runtime and reads the status node's routes.
  const app = decodeAppManifest(entries.get("app.app").payloadBytes);
  assert.equal(app.modules[0].contentHash, summary.portableWasmSha256);
  assert.deepEqual(artifact.runtimeNodeRoutes.map((r) => `${r.nodeId}:${r.portId}`).sort(), flow.runtimeNodeRoutes.map((r) => `status:${r.key}`).sort());
});

test("a production release carries a WasmEdge universal-AOT section in every child and the parent, from the pinned compiler", () => {
  const compiler = fs.readFileSync(path.join(packageRoot, "scripts/compile-universal-aot.sh"), "utf8");
  assert.match(compiler, /wasmedgePin\.json/, "the compiler version is the SDK's pin, not a literal");
  assert.doesNotMatch(compiler, /version 0\.\d+\.\d+/);
  const parentProfile = compiler.match(/compile_parent\(\) \{([\s\S]*?)\n\}/)?.[1];
  const childProfile = compiler.match(/compile_child\(\) \{([\s\S]*?)\n\}/)?.[1];
  for (const profile of [parentProfile, childProfile]) {
    assert.match(profile, /--optimize 3/);
    assert.match(profile, /--interruptible/);
    assert.match(profile, /--generic-binary/);
  }
  assert.doesNotMatch(parentProfile, /--enable-(?:gas-measuring|instruction-count|time-measuring|all-statistics)/);
  assert.match(childProfile, /--enable-gas-measuring/);
});

test("a production release refuses to sign without the pinned WasmEdge compiler; with it, every artifact has its AOT section", async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "supplemental-omm-production-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const env = { ...process.env, NODE_ENV: "production", SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: randomBytes(32).toString("hex"), SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "throwaway-test-key" };
  const pin = JSON.parse(fs.readFileSync(path.join(packageRoot, "node_modules/space-data-module-sdk/src/testing/wasmedgePin.json"), "utf8")).wasmedgeVersion;
  const compiler = spawnSync(process.env.WASMEDGEC_BIN ?? "wasmedgec", ["--version"], { encoding: "utf8" });
  if (compiler.status !== 0 || !compiler.stdout.includes(`version ${pin}`)) {
    const refused = spawnSync(process.execPath, [path.join(packageRoot, "scripts/release.mjs"), "--out", out], { env: { ...env, WASMEDGEC_BIN: path.join(out, "no-wasmedgec") }, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.ok(!fs.existsSync(path.join(out, "isomorphic/module.wasm")), "nothing signed is written");
    return t.skip(`WasmEdge ${pin} (wasmedgec) is not installed here: the AOT sections are the release machine's`);
  }
  execFileSync(process.execPath, [path.join(packageRoot, "scripts/release.mjs"), "--out", out], { env, stdio: "ignore" });
  const aot = (bytes) => listWasmCustomSections(extractPublicationRecordCollection(bytes).payloadBytes).filter((s) => s.name === "wasmedge").length;
  assert.equal(aot(new Uint8Array(fs.readFileSync(path.join(out, "isomorphic/module.wasm")))), 1);
  for (const pluginId of CHILDREN) assert.equal(aot(new Uint8Array(fs.readFileSync(path.join(out, "nodes", `${pluginId}.wasm`)))), 1, pluginId);
});
