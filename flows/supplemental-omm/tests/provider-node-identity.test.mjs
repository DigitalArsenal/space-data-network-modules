// The provider nodes are flow-owned: their built artifacts carry
// org.sdn.flows.supplemental-omm.provider-<name>, never the plugin ID of a
// standalone data-source module (com.orbpro.*-source), whose contract they do
// not implement. Checked on the built bytes: every file under a dist/
// directory of this package, and the signed manifest of each provider as
// shipped alone and inside the outer bundle.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodePluginManifest,
  parseSingleFileBundle,
} from "space-data-module-sdk";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const standalonePluginId = /com\.orbpro\.[A-Za-z0-9._-]*-source/;
const providers = ["starlink", "glonass", "intelsat", "cpf", "iss"];

function distFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist") {
        const walk = (root) => {
          for (const child of fs.readdirSync(root, { withFileTypes: true })) {
            const childPath = path.join(root, child.name);
            if (child.isDirectory()) walk(childPath);
            else files.push(childPath);
          }
        };
        walk(fullPath);
      } else {
        files.push(...distFiles(fullPath));
      }
    }
  }
  return files;
}

async function signedManifest(artifactBytes) {
  const bundle = await parseSingleFileBundle(artifactBytes);
  const entry = bundle.entries.find(
    ({ sectionName }) => sectionName === "sds.manifest",
  );
  assert.ok(entry, "artifact has no signed sds.manifest entry");
  return decodePluginManifest(entry.payloadBytes);
}

test("no built artifact of the flow embeds a standalone com.orbpro.*-source plugin ID", () => {
  const files = distFiles(packageRoot);
  for (const provider of providers) {
    assert.ok(
      files.includes(
        path.join(packageRoot, "nodes/providers", provider, "dist/isomorphic/module.wasm"),
      ),
      `${provider} provider artifact was not scanned`,
    );
  }
  assert.ok(files.includes(path.join(packageRoot, "dist/isomorphic/module.wasm")));
  for (const file of files) {
    const match = fs.readFileSync(file).toString("latin1").match(standalonePluginId);
    assert.equal(
      match?.[0] ?? null,
      null,
      `${path.relative(packageRoot, file)} embeds ${match?.[0]}`,
    );
  }
});

test("each provider's signed manifest names its flow-owned ID, alone and inside the outer bundle", async () => {
  const outer = await parseSingleFileBundle(
    new Uint8Array(
      fs.readFileSync(path.join(packageRoot, "dist/isomorphic/module.wasm")),
    ),
  );
  const outerEntries = new Map(
    outer.entries.map((entry) => [entry.entryId, entry]),
  );
  for (const provider of providers) {
    const pluginId = `org.sdn.flows.supplemental-omm.provider-${provider}`;
    const standalone = new Uint8Array(
      fs.readFileSync(
        path.join(packageRoot, "nodes/providers", provider, "dist/isomorphic/module.wasm"),
      ),
    );
    const bundled = outerEntries.get(pluginId)?.payloadBytes;
    assert.ok(bundled, `outer bundle has no ${pluginId} entry`);
    assert.deepEqual(bundled, standalone, `${pluginId} bundled bytes differ`);
    const manifest = await signedManifest(standalone);
    assert.equal(manifest.pluginId, pluginId);
    assert.equal(manifest.version, "1.0.0");
  }
});
