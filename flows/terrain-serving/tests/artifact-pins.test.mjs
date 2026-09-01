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
// It is not, by itself, the tri-runtime acceptance Janus set — and the earlier
// claim here that NO SUCH LANE EXISTS FOR A FLOW RUNTIME WAS WRONG. It does:
// `space-data-module parity-gate`, the SDK's own "isomorphism acceptance gate:
// certified artifact set x real lanes". Run against this flow with the lane's
// own manifest it exits 0:
//
//   npx space-data-module parity-gate --gate-manifest ./parity/terrain-flow-gate.json --json
//
// It reads declaredRuntimeTargets ["browser","wasmedge"] out of the embedded
// $PLG, classifies the import set as `in-surface (WASI + declared
// capabilities: 3)` with forbidden [] and outsideSurface [], INSTANTIATES the
// runtime in real headless Chrome behind COOP/COEP (contractVerdict
// "satisfied", crossOriginIsolated true), and under the real native and
// containerised WasmEdge at the 0.16.4 pin answers the NAMED verdict
// `runner-cannot-supply-declared-capability` — a class parityGate.js models
// explicitly for this case ("Composed flows derive their runtimeTargets from
// their parts, so a WasmEdge-only flow is legitimate") and which its own doc
// comment says is "never silently counted as a pass, never conflated with a
// divergence". The stock gate manifest reports artifact-missing here because
// it names the SDK's own example artifacts, which is why this lane commits its
// own manifest rather than concluding the instrument does not exist.
//
// What is genuinely unavailable for a flow runtime is only the BEHAVIORAL
// byte-diff half: the gate byte-diffs command-profile artifacts and a flow
// runtime is library-profile. The encoder inside it HAS that half —
// `space-data-module parity --lanes browser,wasmedge,docker-wasmedge` over
// tests/fixtures/terrain-parity.json, 19 cases including the $DTT catalogue
// surface — so the escalation asking Janus to build a lane or amend the
// acceptance is WITHDRAWN.

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

// The gate manifest is committed, so "the acceptance gate runs on this flow"
// is reproducible rather than a claim in a report. This does not RUN the gate
// (it needs Docker, a native WasmEdge at the pin and headless Chrome); it
// holds the manifest to naming THIS flow's runtime and the encoder it links,
// so the two cannot drift apart silently.
test("the committed parity-gate manifest names this flow's own artifacts", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(HERE, "..", "parity", "terrain-flow-gate.json"), "utf8"),
  );
  assert.equal(manifest.name, "terrain-serving-tri-runtime");
  const byId = new Map(manifest.artifacts.map((a) => [a.id, a]));
  const runtime = byId.get("terrain-serving-flow-runtime");
  const encoder = byId.get("terrain-source-encoder");
  assert.ok(runtime && encoder, "both artifacts are declared");
  // Manifest paths resolve inside the SDK package directory, so they are
  // spelled from there. Resolve them the way the gate does and assert they
  // land on the bytes this checkout ships.
  const sdkRoot = path.join(HERE, "..", "node_modules", "space-data-module-sdk");
  assert.equal(
    path.resolve(sdkRoot, runtime.path),
    path.join(DIST, "runtime.wasm"),
    "the gate measures the runtime this package builds",
  );
  assert.equal(
    path.resolve(sdkRoot, encoder.path),
    path.resolve(MODULES_ROOT, "data-source/terrain-source/dist/isomorphic/module.wasm"),
    "and the encoder it links",
  );
});
