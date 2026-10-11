// ndm_engine.test.mjs — the NDM engine, native, on every fixture.
//
// The engine is the part of the module that is not the frame around it: the
// pivot tree, the KVN and NDM/XML syntaxes, the bindings to the generated SDS
// records. tests/ndm_native.cpp wraps it in a program that reads one message,
// writes it as KVN and as XML, and reads each back; this compiles that program
// with the host C++ compiler and runs it over the fixtures, so the engine is
// measured without a WASM toolchain in the way. The compiled module is measured
// separately (ndm_module.test.mjs), on the same fixtures.
//
// What is asserted, per fixture and per syntax it is in:
//   - the message reads, and what it writes reads back to the very same record
//     bytes, as KVN and as XML;
//   - writing is a fixed point: write(read(write(record))) is write(record);
//   - the KVN fixture and its NDM/XML twin are one record.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const fixtures = path.join(packageRoot, "fixtures");

function findCompiler() {
  for (const candidate of ["clang++", "c++"]) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}

async function materialiseFlatbuffersRuntime(root) {
  const runner = await FlatcRunner.init();
  for (const [name, contents] of Object.entries(runner.getEmbeddedRuntime("cpp"))) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

// [type, KVN fixture, XML twin or null]
const MESSAGES = [
  ["OMM", "ndm/ndm-omm-sgp4-covariance.kvn", "ndm/ndm-omm-sgp4-covariance.xml"],
  ["OMM", "ndm/ndm-omm-sgp4xp.kvn", "ndm/ndm-omm-sgp4xp.xml"],
  ["OEM", "ndm/ndm-oem-two-segments.kvn", "ndm/ndm-oem-two-segments.xml"],
  ["OPM", "ndm/ndm-opm-two-maneuvers.kvn", "ndm/ndm-opm-two-maneuvers.xml"],
  ["OCM", "ndm/ndm-ocm-blocks.kvn", "ndm/ndm-ocm-blocks.xml"],
  ["CDM", "ndm/ndm-cdm-full-covariance.kvn", "ndm/ndm-cdm-full-covariance.xml"],
  ["APM", "ndm/ndm-apm-states.kvn", "ndm/ndm-apm-states.xml"],
  ["ACM", "ndm/ndm-acm-blocks.kvn", "ndm/ndm-acm-blocks.xml"],
  ["RDM", "ndm/ndm-rdm-prediction.kvn", "ndm/ndm-rdm-prediction.xml"],
];

const compiler = findCompiler();
let workdir = null;
let binary = null;
const skip = !compiler && "no host c++ compiler; the native NDM harness cannot be built";

test("the NDM engine builds natively", { skip }, async (t) => {
  workdir = mkdtempSync(path.join(tmpdir(), "ndm-engine-"));
  t.after(() => undefined);
  const runtime = path.join(workdir, "fb");
  await materialiseFlatbuffersRuntime(runtime);
  binary = path.join(workdir, "ndm_native");
  execFileSync(
    compiler,
    [
      "-std=c++17", "-O1",
      "-I", path.join(packageRoot, "src"),
      "-I", path.join(packageRoot, "src", "generated", "sds"),
      "-I", path.join(packageRoot, "third_party", "pugixml"),
      "-I", runtime,
      "-I", here,
      path.join(here, "ndm_native.cpp"),
      "-o", binary,
    ],
    { stdio: "pipe", maxBuffer: 16 * 1024 * 1024 },
  );
});

function run(type, file, out) {
  mkdirSync(out, { recursive: true });
  const r = spawnSync(binary, [type, path.join(fixtures, file), out], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const results = [...r.stdout.matchAll(/^RESULT (\S+)\s+(.*?)\s+(PASS|FAIL)$/gm)].map((m) => ({ name: m[1], line: m[2], pass: m[3] === "PASS" }));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, results, out };
}

for (const [type, kvn, xml] of MESSAGES) {
  test(`${type} ${path.basename(kvn)} round-trips through KVN and NDM/XML without changing the record`, { skip: skip || undefined }, () => {
    assert.ok(binary, "the harness did not build");
    const fromKvn = run(type, kvn, path.join(workdir, "kvn", path.basename(kvn)));
    assert.equal(fromKvn.status, 0, `${fromKvn.stdout}\n${fromKvn.stderr}`);
    const failed = fromKvn.results.filter((r) => !r.pass);
    assert.deepEqual(failed, [], failed.map((r) => `${r.name}: ${r.line}`).join("\n"));
    // Seven checks: read, then write, reread, identical record, fixed-point text for each syntax.
    assert.ok(fromKvn.results.length >= 11, `only ${fromKvn.results.length} checks ran`);

    if (xml) {
      const fromXml = run(type, xml, path.join(workdir, "xml", path.basename(xml)));
      assert.equal(fromXml.status, 0, `${fromXml.stdout}\n${fromXml.stderr}`);
      // The two syntaxes of the fixture are one message: the same record, byte for byte.
      assert.deepEqual(
        readFileSync(path.join(fromXml.out, `${type}.fb`)),
        readFileSync(path.join(fromKvn.out, `${type}.fb`)),
        `${xml} and ${kvn} are not the same record`,
      );
      // The twin is what the engine writes for the record: the committed file is a golden.
      assert.equal(
        readFileSync(path.join(fromKvn.out, `${type}.xml`), "utf8"),
        readFileSync(path.join(fixtures, xml), "utf8"),
        `${xml} is not what the engine writes for ${kvn}`,
      );
    }
  });
}

test.after(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});
