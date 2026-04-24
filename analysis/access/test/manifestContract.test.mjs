import test from "node:test";
import assert from "node:assert/strict";

import { createAccessAnalyzer } from "../index.js";
import {
  InvokeSurface,
  PluginFamily,
} from "space-data-module-sdk/manifest";

test("Access analyzer exposes the expected manifest metadata", async function () {
  const analyzer = await createAccessAnalyzer();

  try {
    assert.equal(analyzer.manifestSource, "embedded-flatbuffer");
    assert.equal(analyzer.manifest.pluginId, "com.orbpro.access");
    assert.equal(analyzer.manifest.name, "Access Analysis");
    assert.equal(analyzer.manifest.pluginFamily, PluginFamily.ANALYSIS);
    assert.equal(analyzer.manifest.methods.length, 1);
    assert.equal(analyzer.manifest.methods[0].methodId, "compute_access_windows");
    assert.equal(analyzer.manifest.capabilities.length, 0);
    assert.equal(analyzer.manifest.timers.length, 0);
    assert.equal(analyzer.manifest.protocols.length, 0);
    assert.equal(analyzer.manifest.schemasUsed.length, 2);
    assert.equal(analyzer.manifest.buildArtifacts.length, 1);
    assert.equal(analyzer.manifest.buildArtifacts[0].artifactId, "access-runtime");
    assert.equal(analyzer.manifest.buildArtifacts[0].kind, "javascript-runtime");
    assert.equal(analyzer.manifest.buildArtifacts[0].path, "index.js");
    assert.equal(analyzer.manifest.buildArtifacts[0].target, "web,worker,node");
    assert.deepEqual(analyzer.manifest.invokeSurfaces, [InvokeSurface.DIRECT]);
    assert.deepEqual(analyzer.manifest.runtimeTargets, ["browser", "node"]);
    assert.equal(analyzer.metadata.id, "com.orbpro.access");
    assert.equal(analyzer.metadata.name, "Access Analysis");
  } finally {
    analyzer.destroy();
  }
});
