import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  decodePlgManifest,
  decodePluginManifest,
  encodePlgManifest,
  encodePluginManifest,
  legacyManifestToPlg,
} from "space-data-module-sdk/manifest";

const manifestPath = new URL("../plugin-manifest.json", import.meta.url);

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function findPortType(decoded, portsKey, portId) {
  const method = decoded.methods.find((entry) => entry.methodId === "solve_lambert");
  assert.ok(method, "solve_lambert method is present");
  const port = method[portsKey].find((entry) => entry.portId === portId);
  assert.ok(port, `${portId} port is present`);
  return port.acceptedTypeSets[0].allowedTypes[0];
}

test("Lambert manifest round-trips through SDK PMAN codec", () => {
  const manifest = readManifest();
  const decoded = decodePluginManifest(encodePluginManifest(manifest));

  assert.equal(decoded.pluginId, "com.orbpro.lambert-izzo");
  assert.deepEqual(decoded.runtimeTargets, ["browser", "wasmedge"]);
  assert.deepEqual(decoded.invokeSurfaces, ["direct", "command"]);
  assert.equal(
    findPortType(decoded, "inputPorts", "request").schemaName,
    "spacedata.LMS",
  );
  assert.equal(
    findPortType(decoded, "inputPorts", "request").fileIdentifier,
    "LMS",
  );
  assert.equal(
    findPortType(decoded, "outputPorts", "solutions").schemaName,
    "spacedata.LMO",
  );
  assert.equal(
    findPortType(decoded, "outputPorts", "solutions").fileIdentifier,
    "LMO",
  );
});

test("Lambert manifest maps to canonical PLG codec without local schema aliases", () => {
  const manifest = readManifest();
  const plgManifest = legacyManifestToPlg(manifest);

  assert.deepEqual(plgManifest.requiredSchemas, [
    "spacedata.LMS",
    "spacedata.LMO",
  ]);
  assert.deepEqual(plgManifest.entryFunctions, [
    {
      name: "solve_lambert",
      description:
        "Solves single- and multi-revolution Lambert boundary-value transfer cases with Izzo's revisited algorithm.",
      inputSchemas: ["spacedata.LMS"],
      outputSchema: "spacedata.LMO",
    },
  ]);

  const plgDecoded = decodePlgManifest(encodePlgManifest(plgManifest));
  assert.equal(plgDecoded.pluginId, manifest.pluginId);
  assert.deepEqual(plgDecoded.requiredSchemas, [
    "spacedata.LMS",
    "spacedata.LMO",
  ]);

  const decoded = decodePluginManifest(encodePlgManifest(plgManifest));
  assert.deepEqual(findPortType(decoded, "inputPorts", "input-1"), {
    schemaName: "spacedata.LMS",
  });
  assert.deepEqual(findPortType(decoded, "outputPorts", "output-1"), {
    schemaName: "spacedata.LMO",
  });
});
