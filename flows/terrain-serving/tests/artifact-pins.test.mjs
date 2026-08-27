// WHAT THIS FLOW ACTUALLY SHIPS, AND WHETHER IT IS WHAT THE REPO BUILT.
//
// A compiled flow is not one artifact: it is a scheduler (runtime.wasm) with
// every node module LINKED INTO it, and dist/artifact.json states the sha256
// of each one it linked. Nothing checked those statements, and the lane has
// now been bitten by the same class of staleness twice in one week — a flow
// carrying a module build that no checkout holds, and a downstream fixture
// pinning an encoder that had been rebuilt three commits earlier. Both are
// invisible to every behavioural test, because a stale artifact behaves
// perfectly; it just is not the thing that was measured.
//
// So the pins are a gate. Rebuild the module, and this goes red until the flow
// is recompiled — which is the correct order, and the only way "the flow ships
// the encoder in this checkout" is a fact rather than an assumption.
//
// It is NOT the tri-runtime parity lane Janus set as acceptance. That lane
// does not exist for a flow runtime: the SDK's parity lanes invoke a methodId
// on a module artifact, a flow runtime exports a scheduler instead, and every
// lane runs `wasmedge module.wasm` with no host module to link — which a
// runtime importing space_data_module_host cannot survive. terrain-source
// clears that by compiling a bridge-free twin from the same source
// (build-parity.mjs); a flow runtime is SDK-generated and has no such knob, so
// no flow in this repo has ever had a parity fixture. That gap is Janus's and
// is stated in the task's GAPS list rather than papered over here.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");
const MODULES_ROOT = path.resolve(HERE, "..", "..", "..");
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const artifact = JSON.parse(fs.readFileSync(path.join(DIST, "artifact.json"), "utf8"));

test("artifact.json states the runtime it sits next to", () => {
  const runtime = path.join(DIST, artifact.artifact.file);
  assert.equal(sha256(runtime), artifact.artifact.sha256);
  assert.equal(fs.statSync(runtime).size, artifact.artifact.bytes);
});

test("dist/isomorphic/module.wasm IS the runtime, not a second build of it", () => {
  // The host mounts runtime.wasm; the SDK's module-shaped consumers read
  // dist/isomorphic/module.wasm. Two files that are meant to be one artifact
  // are two artifacts the moment one of them is rebuilt alone.
  const a = fs.readFileSync(path.join(DIST, "runtime.wasm"));
  const b = fs.readFileSync(path.join(DIST, "isomorphic", "module.wasm"));
  assert.ok(a.equals(b), "runtime.wasm and isomorphic/module.wasm have diverged");
});

test("every linked node module is the build this checkout holds", () => {
  // Where each dependency's built artifact lives in this repo. A dependency
  // that is not resolvable here is REPORTED rather than skipped: an unchecked
  // pin is what let a stale encoder ship.
  const built = {
    "com.digitalarsenal.data-source.terrain-source": path.join(
      MODULES_ROOT, "data-source", "terrain-source", "dist", "isomorphic", "module.wasm",
    ),
    "com.digitalarsenal.hostcap.flatsql-query": path.join(
      MODULES_ROOT, "hostcap", "flatsql-query", "dist", "isomorphic", "module.wasm",
    ),
  };
  const unresolved = [];
  let checked = 0;
  for (const dependency of artifact.dependencies ?? []) {
    const file = built[dependency.pluginId];
    if (!file || !fs.existsSync(file)) {
      unresolved.push(`${dependency.pluginId} (${file ?? "no path known"})`);
      continue;
    }
    assert.equal(
      sha256(file),
      dependency.sha256,
      `${dependency.pluginId}: the flow links ${dependency.sha256.slice(0, 16)}… and this ` +
        `checkout builds ${sha256(file).slice(0, 16)}… — recompile the flow ` +
        "(npm --prefix flows/terrain-serving run build) before measuring anything through it",
    );
    checked += 1;
  }
  assert.deepEqual(unresolved, [], "every linked dependency must be checkable");
  assert.ok(checked > 0, "the flow links at least one node module");
});

test("the flow declares the capability set it is approved for, and no more", () => {
  // storage_query and nothing else: the serving lane reads the store and never
  // writes it, and a capability that appears here has to be approved on the
  // host by hash before the flow will start.
  assert.deepEqual(artifact.capabilities, ["storage_query"]);
  assert.equal(artifact.threadModel, "single-thread");
});
