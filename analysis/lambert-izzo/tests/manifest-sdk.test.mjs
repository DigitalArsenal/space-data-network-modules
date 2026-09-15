import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodePlgManifest,
  decodePluginManifest,
  encodePlgManifest,
  encodePluginManifest,
  legacyManifestToPlg,
} from "space-data-module-sdk/manifest";
import { validateManifestWithStandards } from "space-data-module-sdk/compliance";

const manifestPath = new URL("../plugin-manifest.json", import.meta.url);
const standardsRoot = fileURLToPath(
  new URL("../node_modules/spacedatastandards.org/", import.meta.url),
);

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
    "LMS.fbs",
  );
  assert.equal(
    findPortType(decoded, "inputPorts", "request").fileIdentifier,
    "$LMS",
  );
  assert.equal(
    findPortType(decoded, "outputPorts", "solutions").schemaName,
    "LMO.fbs",
  );
  assert.equal(
    findPortType(decoded, "outputPorts", "solutions").fileIdentifier,
    "$LMO",
  );
});

test("Lambert manifest maps to canonical PLG codec without local schema aliases", () => {
  const manifest = readManifest();
  const plgManifest = legacyManifestToPlg(manifest);

  assert.deepEqual(plgManifest.requiredSchemas, [
    "LMS.fbs",
    "LMO.fbs",
    "PCE.fbs",
  ]);
  assert.deepEqual(plgManifest.entryFunctions.slice(0, 1), [
    {
      name: "solve_lambert",
      description:
        "Solves single- and multi-revolution Lambert boundary-value transfer cases with Izzo's revisited algorithm.",
      inputSchemas: ["LMS.fbs"],
      outputSchema: "LMO.fbs",
    },
  ]);

  const plgDecoded = decodePlgManifest(encodePlgManifest(plgManifest));
  assert.equal(plgDecoded.pluginId, manifest.pluginId);
  assert.deepEqual(plgDecoded.requiredSchemas, [
    "LMS.fbs",
    "LMO.fbs",
    "PCE.fbs",
  ]);

  const decoded = decodePluginManifest(encodePlgManifest(plgManifest));
  assert.equal(
    findPortType(decoded, "inputPorts", "request").fileIdentifier,
    "$LMS",
  );
  assert.equal(
    findPortType(decoded, "outputPorts", "solutions").fileIdentifier,
    "$LMO",
  );
});

test("Lambert manifest resolves LMS, LMO and PCE through SDK standards validation", async () => {
  const report = await validateManifestWithStandards(readManifest(), {
    standardsRoot,
  });

  assert.equal(
    report.issues.filter((issue) => issue.code === "unresolved-standards-type")
      .length,
    0,
    JSON.stringify(report.issues, null, 2),
  );
});


test("grid search has a PCE stream and best-cell port after manifest round-trip", () => {
  const decoded = decodePluginManifest(encodePluginManifest(readManifest()));
  const method = decoded.methods.find(m => m.methodId === "grid_search");
  assert.ok(method);
  assert.deepEqual(method.outputPorts.map(p => p.portId), ["mesh", "best"]);
  for (const port of [...method.inputPorts, ...method.outputPorts]) {
    assert.equal(port.acceptedTypeSets[0].allowedTypes[0].schemaName, "PCE.fbs");
    assert.equal(port.acceptedTypeSets[0].allowedTypes[0].fileIdentifier, "$PCE");
  }
});
