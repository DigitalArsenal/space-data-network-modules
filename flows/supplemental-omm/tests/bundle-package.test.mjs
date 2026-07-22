import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUNDLE_SIGNATURE_HASH_ALGORITHM,
  decodeAppManifest,
  decodePlgManifest,
  extractPublicationRecordCollection,
  parseSingleFileBundle,
  verifyModuleArtifact,
} from "../../../node_modules/space-data-module-sdk/src/index.js";
import { sha256Bytes } from "../../../node_modules/space-data-module-sdk/src/utils/crypto.js";
import { bytesToHex } from "../../../node_modules/space-data-module-sdk/src/utils/encoding.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(packageRoot, "dist");
const flowSource = JSON.parse(fs.readFileSync(path.join(packageRoot, "flow.json"), "utf8"));
const expectedEntries = [
  "app.app",
  "artifact.json",
  "flow.plg",
  "manifest",
  ...flowSource.nodes.flatMap((node) => [
    `nodes/${node.nodeId}.publisher.json`,
    `nodes/${node.nodeId}.wasm`,
  ]),
  "signature",
].sort();

function read(relativePath) {
  return new Uint8Array(fs.readFileSync(path.join(packageRoot, relativePath)));
}

test("the publishable output carries canonical flow.plg and size-prefixed app.app", async () => {
  const flowPLG = read("dist/flow.plg");
  const appBytes = read("dist/app.app");
  const flow = decodePlgManifest(flowPLG);
  const app = decodeAppManifest(appBytes);

  assert.equal(flow.pluginId, "org.sdn.flows.od-supplemental-omm");
  assert.equal(app.id, "io.spaceaware.supplemental-omm");
  assert.equal(app.modules.length, 1);
  assert.equal(app.modules[0].pluginId, flow.pluginId);
  assert.match(app.modules[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(app.pages.length, 1);
  assert.equal(app.pages[0].entry, true);
  assert.match(app.pages[0].content, /data-provider=["']starlink["']/);
  assert.doesNotMatch(app.pages[0].content, /\/api\/v1\/stats/);
  assert.doesNotMatch(app.pages[0].content, /celestrak/i);
  assert.match(
    app.pages[0].content,
    new RegExp(`/sdn/v1/artifacts/${app.modules[0].contentHash}`),
  );
  assert.match(app.pages[0].content, /\/runtime\/nodes\//);
});

test("one bundle-scoped signature binds wasm, PLG, metadata, APP, and exact child artifacts", async () => {
  const artifactBytes = read("dist/isomorphic/module.wasm");
  const parsed = await parseSingleFileBundle(artifactBytes);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.entryId).sort(),
    expectedEntries,
  );
  const signatureEntry = parsed.entries.find(
    (entry) => entry.entryId === "signature",
  );
  assert.equal(
    signatureEntry.decodedPayload.signedHashAlgorithm,
    BUNDLE_SIGNATURE_HASH_ALGORITHM,
  );
  const verified = await verifyModuleArtifact(artifactBytes, {
    trustedPublicKeys: [signatureEntry.decodedPayload.publicKeyHex],
    requireSignature: true,
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.signatureScope, "bundle");

  const runtimeBytes = read("dist/runtime.wasm");
  assert.deepEqual(runtimeBytes, artifactBytes);
  assert.deepEqual(
    parsed.entries.find((entry) => entry.entryId === "flow.plg").payloadBytes,
    read("dist/flow.plg"),
  );
  assert.deepEqual(
    parsed.entries.find((entry) => entry.entryId === "app.app").payloadBytes,
    read("dist/app.app"),
  );

  for (const node of flowSource.nodes) {
    assert.equal(node.dispatchModel, "isomorphic");
    assert.match(node.artifact?.sha256 ?? "", /^[a-f0-9]{64}$/);
    const childBytes = new Uint8Array(
      fs.readFileSync(path.resolve(packageRoot, node.artifact.path)),
    );
    assert.equal(
      createHash("sha256").update(childBytes).digest("hex"),
      node.artifact.sha256,
    );
    assert.deepEqual(
      parsed.entries.find((entry) => entry.entryId === `nodes/${node.nodeId}.wasm`)
        ?.payloadBytes,
      childBytes,
    );
    assert.deepEqual(
      parsed.entries.find(
        (entry) => entry.entryId === `nodes/${node.nodeId}.publisher.json`,
      )?.payloadBytes,
      new Uint8Array(
        fs.readFileSync(path.resolve(packageRoot, node.artifact.publisher)),
      ),
    );
  }
});

test("APP module identity and artifact metadata hash the exact trailer-stripped bytes", async () => {
  const published = read("dist/isomorphic/module.wasm");
  const portable = extractPublicationRecordCollection(published).payloadBytes;
  const portableHash = bytesToHex(await sha256Bytes(portable));
  const app = decodeAppManifest(read("dist/app.app"));
  const artifact = JSON.parse(fs.readFileSync(path.join(dist, "artifact.json"), "utf8"));

  assert.equal(app.modules[0].contentHash, portableHash);
  assert.equal(artifact.bundle.portableWasmSha256, portableHash);
  assert.equal(
    artifact.bundle.flowPlgSha256,
    bytesToHex(await sha256Bytes(read("dist/flow.plg"))),
  );
  assert.equal(
    artifact.bundle.appSha256,
    bytesToHex(await sha256Bytes(read("dist/app.app"))),
  );
  assert.equal(
    artifact.bundle.signatureHashAlgorithm,
    BUNDLE_SIGNATURE_HASH_ALGORITHM,
  );
  assert.equal(artifact.dispatchModel, "isomorphic");
  assert.deepEqual(
    artifact.nodeArtifacts.map(({ nodeId, sha256, dispatchModel }) => ({
      nodeId,
      sha256,
      dispatchModel,
    })),
    flowSource.nodes.map((node) => ({
      nodeId: node.nodeId,
      sha256: node.artifact.sha256,
      dispatchModel: "isomorphic",
    })),
  );
});

test("signing-key admission runs before unsigned staging can replace the publishable artifact", () => {
  const before = read("dist/isomorphic/module.wasm");
  const env = { ...process.env };
  delete env.SDM_BUNDLE_SIGNING_SEED_HEX;
  delete env.SDM_BUNDLE_SIGNING_KEY_ID;

  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, "scripts/package-bundle.mjs"), "--prepare"],
    { cwd: packageRoot, env, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SDM_BUNDLE_SIGNING_SEED_HEX/);
  assert.deepEqual(read("dist/isomorphic/module.wasm"), before);
  assert.equal(fs.existsSync(path.join(dist, ".unsigned")), false);
});
