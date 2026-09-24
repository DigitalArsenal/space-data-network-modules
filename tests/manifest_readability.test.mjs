// EMBEDDED-MANIFEST READABILITY — can a host on today's SDK read what the
// artifact declares about itself?
//
// Graph task: modules-shipped-artifact-resign-wave.
//
// The class this exists for was invisible to every other check in this repo,
// because they all ask whether an artifact can be REPRODUCED. Seven artifacts —
// six of them CORE, DEFAULT_ENABLED and serving live on sdn.spaceaware.io —
// carried a `$PLG` manifest in an encoding the current SDK decodes into garbage.
// Valid wasm, valid signature, sha256 matching the ledger, thread-model
// declaration agreeing with the bytes, and no current host would load them: the
// loader gate read `runtimeTargets` as one entry of raw FlatBuffer and refused
// browser AND wasmedge.
//
// The two positive controls below are therefore the interesting ones: a repaired
// artifact and a signed artifact. The second is here because the first version of
// the section walker stopped at section id 12 and cut every exception-handling
// module mid-body, which reported a corrupt artifact instead of a short walker.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectEmbeddedManifest, moduleProperEnd } from "../scripts/lib/manifest-readability.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEDGER = path.join(REPO_ROOT, "scripts", "artifact-provenance.json");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel));

test("a repaired artifact declares runtime targets the current SDK can read", () => {
  const verdict = inspectEmbeddedManifest(read("foundation/frames/dist/isomorphic/module.wasm"), "frames");
  assert.equal(verdict.ok, true, verdict.reason ?? "");
  assert.deepEqual(verdict.targets, ["browser", "wasmedge"]);
});

test("a SIGNED artifact is read through its detached publication trailer, not refused by it", () => {
  const rel = "propagator/sgp4/dist/isomorphic/module.wasm";
  const bytes = read(rel);
  const end = moduleProperEnd(bytes);
  // signModuleArtifact appends an SDS `$REC` publication record past the end of
  // the module proper. The node's own pmm.HashArtifact strips exactly this before
  // hashing, which is why the live CONTENT_HASH is over the PORTABLE bytes.
  assert.equal(bytes.length - end, 964, "the publication trailer is 964 bytes");
  assert.equal(bytes.subarray(end + 4, end + 8).toString("latin1"), "$REC");
  assert.throws(() => new WebAssembly.Module(bytes), "raw signed bytes do not compile");
  assert.equal(inspectEmbeddedManifest(bytes, rel).ok, true, "the portable bytes do");
});

test("the section walker crosses the exception-handling tag section", () => {
  // Section id 13 is the tag section. Stopping at 12 truncated propagator/sgp4 at
  // offset 2,192 — 1.17 MB short — and produced "function count is 1260, but code
  // section…", which reads like a corrupt artifact and is not one.
  const bytes = read("propagator/sgp4/dist/isomorphic/module.wasm");
  assert.equal(bytes[2192], 13, "sgp4's tag section begins at 2192");
  assert.ok(moduleProperEnd(bytes) > 1_000_000, "the walk must reach the end of the module");
});

test("DETECTION: the artifact still carrying the old $PLG encoding is REFUSED", () => {
  // The real defect, on real bytes, rather than a synthesised one. Tampering is
  // the wrong control here: corrupting the section until it will not decode
  // produces "declares nothing", which this check deliberately ALLOWS — absent is
  // unconstrained. The defect is narrower and worse than that. The section decodes
  // fine; it just decodes into a runtimeTargets array holding raw FlatBuffer, so
  // the gate refuses every leg while the artifact looks healthy from every other
  // angle. Only bytes from the era that produced it have that shape.
  //
  // When it is finally repaired, this test must be deleted rather than relaxed —
  // its whole value is that it names bytes known to fail. foundation/orbits was
  // repaired by its OCM rebuild at the current SDK pin.
  for (const rel of ["analysis/dop/dist/isomorphic/module.wasm"]) {
    const verdict = inspectEmbeddedManifest(read(rel), rel);
    assert.equal(verdict.ok, false, `${rel} should still be carrying the old encoding`);
    assert.match(verdict.reason, /DECODES INTO GARBAGE/);
    assert.deepEqual(verdict.targets, [], "a refused artifact reports no usable targets");
  }
});

test("an artifact that declares NO manifest is unconstrained, not refused", () => {
  // The gate skips its runtime-target rule on an absent field, and several lanes
  // legitimately ship an artifact with no embedded declaration. A check that
  // failed those would be demanding something the contract does not.
  const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  const silent = Object.keys(ledger.artifacts).find((rel) => {
    const v = inspectEmbeddedManifest(read(rel), rel);
    return v.ok && v.targets.length === 0;
  });
  assert.ok(silent, "the repo carries artifacts with no embedded declaration");
  assert.equal(inspectEmbeddedManifest(read(silent), silent).ok, true);
});

test("the loadability census is a ratchet with every survivor named", () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  assert.equal(typeof ledger.manifestUnreadableBaseline, "number");
  const measured = Object.keys(ledger.artifacts).filter(
    (rel) => !inspectEmbeddedManifest(read(rel), rel).ok,
  );
  assert.equal(
    measured.length,
    ledger.manifestUnreadableBaseline,
    `the recorded baseline must equal what the tree actually carries; unreadable now:\n  ${measured.join("\n  ")}`,
  );
  // Every survivor has a written reason. analysis/dop is refused at the current
  // pin by MANIFEST VALIDATION, so a rebuild cannot repair it; that is a
  // $PLG-byte-changing contract move and belongs to Themis/Janus.
  // foundation/orbits left the census with its OCM manifest rewrite.
  for (const rel of measured) {
    const moduleDir = rel.slice(0, rel.indexOf("/dist/"));
    assert.ok(
      ledger.unreproducibleReasons?.[moduleDir],
      `${rel} is unloadable and unexplained — record why in unreproducibleReasons[${moduleDir}]`,
    );
  }
});

test("NEGATIVE CONTROL: the checker's loadability lane fails when the census grows", () => {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  const original = fs.readFileSync(LEDGER);
  try {
    fs.writeFileSync(LEDGER, `${JSON.stringify({ ...ledger, manifestUnreadableBaseline: -1 }, null, 2)}\n`);
    let output = "";
    try {
      execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "check-artifact-reproducibility.mjs")], {
        cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      assert.fail("the checker must refuse a loadability census above its baseline");
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.match(output, /EMBEDDED MANIFEST UNREADABLE AT THE CURRENT SDK/);
  } finally {
    fs.writeFileSync(LEDGER, original);
  }
});
