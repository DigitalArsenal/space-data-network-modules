import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractPublicationRecordCollection,
  listWasmCustomSections,
  parseSingleFileBundle,
  verifyModuleArtifact,
} from "space-data-module-sdk";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const wasmPath = path.join(packageRoot, "dist/isomorphic/module.wasm");
const manifestPath = path.join(packageRoot, "dist/plugin-manifest.json");
const artifactPath = path.join(packageRoot, "dist/artifact.json");
const publisherPath = path.join(packageRoot, "dist/publisher.json");
const flowPath = path.join(packageRoot, "flow.json");
const universalAotCompilerPath = path.join(
  packageRoot,
  "scripts/compile-universal-aot.sh",
);
const artifactExists = [wasmPath, manifestPath, artifactPath, publisherPath].every(
  (candidate) => fs.existsSync(candidate),
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("the universal-AOT build profile is compatible with the production host", () => {
  const compiler = fs.readFileSync(universalAotCompilerPath, "utf8");
  assert.match(compiler, /WasmEdge-0\.14\.1/);
  const parentProfile = compiler.match(/compile_parent\(\) \{([\s\S]*?)\n\}/)?.[1];
  const childProfile = compiler.match(/compile_child\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(parentProfile, "missing explicit parent AOT profile");
  assert.ok(childProfile, "missing explicit child AOT profile");
  for (const profile of [parentProfile, childProfile]) {
    assert.match(profile, /--optimize 3/);
    assert.match(profile, /--interruptible/);
  }
  assert.doesNotMatch(
    parentProfile,
    /--enable-(?:gas-measuring|instruction-count|time-measuring|all-statistics)/,
  );
  assert.match(childProfile, /--enable-gas-measuring/);
});

test(
  "the outer bundle is a signed browser/WasmEdge isomorphic flow host",
  { skip: !artifactExists && "run npm run build before the artifact contract gate" },
  async () => {
    const published = new Uint8Array(fs.readFileSync(wasmPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const publisher = JSON.parse(fs.readFileSync(publisherPath, "utf8"));
    assert.deepEqual([...(manifest.runtimeTargets ?? [])].sort(), ["browser", "wasmedge"]);
    assert.doesNotMatch(
      JSON.stringify(manifest),
      /storage_engine_link|hostcap|host-cron|engineLinkage|linkedStore/i,
    );
    const verified = await verifyModuleArtifact(published, {
      trustedPublicKeys: [publisher.publicKeyHex],
      requireSignature: true,
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.signatureScope, "bundle");
  },
);

test(
  "the outer signature binds every exact independently signed child artifact",
  { skip: !artifactExists && "run npm run build before the artifact contract gate" },
  async () => {
    const published = new Uint8Array(fs.readFileSync(wasmPath));
    const parsed = await parseSingleFileBundle(published);
    const entries = new Map(parsed.entries.map((entry) => [entry.entryId, entry]));
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
    assert.equal(artifact.dispatchModel, "isomorphic");
    assert.equal(artifact.nodeArtifacts.length, flow.nodes.length);

    for (const node of flow.nodes) {
      assert.equal(node.dispatchModel, "isomorphic");
      const descriptor = artifact.nodeArtifacts.find(
        (candidate) => candidate.nodeId === node.nodeId,
      );
      assert.ok(descriptor, `missing descriptor for ${node.nodeId}`);
      assert.equal(descriptor.pluginId, node.pluginId);
      assert.equal(descriptor.methodId, node.methodId);
      assert.equal(descriptor.sha256, node.artifact.sha256);
      const child = entries.get(node.pluginId);
      assert.ok(child, `missing exact child ${node.nodeId}`);
      assert.equal(sha256(child.payloadBytes), node.artifact.sha256);
      const childBundle = await parseSingleFileBundle(child.payloadBytes);
      assert.ok(
        childBundle.entries.some((entry) => entry.sectionName === "sds.manifest"),
        `${node.nodeId} is missing its canonical sds.manifest entry`,
      );
      assert.ok(entries.has(`nodes/${node.nodeId}.publisher.json`));
    }
  },
);

test(
  "every signed child exports the same manifest bytes that its bundle authenticates",
  { skip: !artifactExists && "run npm run build before the artifact contract gate" },
  async (t) => {
    const outer = await parseSingleFileBundle(
      new Uint8Array(fs.readFileSync(wasmPath)),
    );
    const entries = new Map(outer.entries.map((entry) => [entry.entryId, entry]));
    const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));

    for (const node of flow.nodes) {
      const child = entries.get(node.pluginId);
      assert.ok(child, `missing exact child ${node.nodeId}`);
      const childBundle = await parseSingleFileBundle(child.payloadBytes);
      const authenticatedManifest = childBundle.entries.find(
        (entry) => entry.sectionName === "sds.manifest",
      )?.payloadBytes;
      assert.ok(authenticatedManifest, `${node.nodeId} has no signed manifest payload`);

      const harness = await createBrowserModuleHarness({
        wasmSource: child.payloadBytes,
        surface: "direct",
        hostcallDispatch() {
          return {};
        },
      });
      t.after(() => harness.destroy());
      assert.deepEqual(
        harness.readManifest(),
        authenticatedManifest,
        `${node.nodeId} guest-exported manifest differs from its signed bundle`,
      );
    }
  },
);

test(
  "the production bundle uses one release signer for the outer and every child",
  { skip: !artifactExists && "run npm run build before the artifact contract gate" },
  async () => {
    const parsed = await parseSingleFileBundle(
      new Uint8Array(fs.readFileSync(wasmPath)),
    );
    const entries = new Map(parsed.entries.map((entry) => [entry.entryId, entry]));
    const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
    const outerPublisher = JSON.parse(fs.readFileSync(publisherPath, "utf8"));
    assert.equal(outerPublisher.developmentOnly, false);
    for (const node of flow.nodes) {
      const childPublisher = entries.get(`nodes/${node.nodeId}.publisher.json`);
      assert.ok(childPublisher, `missing publisher for ${node.nodeId}`);
      const publisher = JSON.parse(new TextDecoder().decode(childPublisher.payloadBytes));
      assert.equal(publisher.developmentOnly, false);
      assert.equal(publisher.publicKeyHex, outerPublisher.publicKeyHex);
      const verified = await verifyModuleArtifact(
        entries.get(node.pluginId).payloadBytes,
        {
          trustedPublicKeys: [outerPublisher.publicKeyHex],
          requireSignature: true,
        },
      );
      assert.equal(verified.verified, true, `${node.nodeId} signature failed`);
    }
  },
);

test(
  "the outer runtime and every exact signed child are browser-valid WasmEdge universal-AOT modules",
  { skip: !artifactExists && "run npm run build before the artifact contract gate" },
  async () => {
    const published = new Uint8Array(fs.readFileSync(wasmPath));
    const parsed = await parseSingleFileBundle(published);
    const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
    const entries = new Map(parsed.entries.map((entry) => [entry.entryId, entry]));
    const modules = [
      ["outer runtime", extractPublicationRecordCollection(published)?.payloadBytes ?? published],
      ...flow.nodes.map((node) => {
        const child = entries.get(node.pluginId)?.payloadBytes;
        assert.ok(child, `missing exact child ${node.nodeId}`);
        return [
          node.nodeId,
          extractPublicationRecordCollection(child)?.payloadBytes ?? child,
        ];
      }),
    ];

    for (const [label, moduleBytes] of modules) {
      assert.equal(WebAssembly.validate(moduleBytes), true, `${label} is not browser-valid WASM`);
      const aotSections = listWasmCustomSections(moduleBytes).filter(
        (section) => section.name === "wasmedge",
      );
      assert.equal(aotSections.length, 1, `${label} must carry exactly one WasmEdge AOT section`);
      assert.ok(aotSections[0].dataBytes.byteLength > 0, `${label} has an empty WasmEdge AOT section`);
    }
  },
);
