import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "plugin-manifest.json"), "utf8"),
);

test("search_trajectories consumes signed SLP and emits signed PSS carriers", () => {
  const method = manifest.methods.find(
    (candidate) => candidate.methodId === "search_trajectories",
  );
  assert.ok(method, "search_trajectories method is declared");

  const problem = method.inputPorts.find((port) => port.portId === "problem");
  const solutions = method.outputPorts.find((port) => port.portId === "solutions");
  assert.deepEqual(
    problem.acceptedTypeSets[0].allowedTypes.map((type) => type.fileIdentifier),
    ["$SLP"],
  );
  assert.deepEqual(
    solutions.acceptedTypeSets[0].allowedTypes.map((type) => type.fileIdentifier),
    ["$PSS"],
  );
  assert.equal(problem.required, true);
  assert.equal(solutions.maxStreams, 1);
  assert.doesNotMatch(solutions.description, /pending|blocked/i);
});
