// spk.test.mjs — the DAF/SPK reader and writer, measured against CSPICE.
//
// This compiles tests/spk_native.cpp against the headers in src/ and asserts the
// RESULT lines it prints. The numbers themselves are produced natively because
// the authority they are compared to — spiceypy/CSPICE_N0067 — cannot be linked
// into a WASM module or into node; fixtures/spk_reference.txt carries CSPICE's
// answers across as IEEE-754 bit patterns and fixtures/PROVENANCE.md names the
// kernel, URL and SHA-256 behind every one.
//
// Same shape as foundation/frames/tests/coordinate_systems.test.mjs: build the
// native harness once into a temp directory, never into the repo, and treat a
// missing host compiler as a SKIP (a provisioning gap) rather than a failure
// (a physics gap).
//
// Every assertion here restates a bound the native harness already enforces.
// That duplication is deliberate: a bound quietly deleted from the C++ would
// otherwise turn into a silently passing suite, and these are the numbers the
// task was accepted on.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "spk_native.cpp");
const includePath = path.join(here, "..", "src");
const fixturePath = path.join(here, "..", "fixtures");

function hasNativeToolchain() {
  return spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;
}

let cached;

function runNativeHarness() {
  if (cached !== undefined) return cached;
  if (!hasNativeToolchain() || !existsSync(fixturePath)) {
    cached = null;
    return cached;
  }
  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-orbit-products-spk-"));
  const binaryPath = path.join(workDir, "spk_native");
  try {
    execFileSync(
      "c++",
      ["-std=c++17", "-O2", "-I", includePath, "-o", binaryPath, sourcePath],
      { stdio: "pipe" },
    );
    const run = spawnSync(binaryPath, [fixturePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    cached = { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status };
    return cached;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// `RESULT <name> <value> <bound> <PASS|FAIL>` — the harness's whole output
// contract, so a renamed or dropped assertion shows up as a missing key rather
// than as a quiet pass.
function parseResults(stdout) {
  const results = new Map();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^RESULT\s+(\S+)\s+(\S+)\s+(\S+)\s+(PASS|FAIL)\s*$/);
    if (!match) continue;
    results.set(match[1], {
      value: Number(match[2]),
      bound: Number(match[3]),
      pass: match[4] === "PASS",
    });
  }
  return results;
}

test("DAF/SPK types 8, 9 and 13 against CSPICE", { concurrency: false }, async (t) => {
  const run = runNativeHarness();
  if (!run) {
    t.skip("no host C++ compiler, or fixtures/ is absent; the native harness cannot run");
    return;
  }
  const results = parseResults(run.stdout);
  assert.ok(results.size > 0, `the harness printed no RESULT lines:\n${run.stdout}${run.stderr}`);

  const get = (name) => {
    const r = results.get(name);
    assert.ok(r, `the harness did not report ${name}`);
    return r;
  };
  const within = (name) => {
    const r = get(name);
    console.log(`  ${name.padEnd(42)} ${r.value.toExponential(4)} (bound ${r.bound})`);
    assert.ok(r.pass, `${name} = ${r.value}, bound ${r.bound}`);
    return r;
  };
  const zero = (name) => {
    const r = get(name);
    assert.equal(r.value, 0, `${name} = ${r.value}, expected 0`);
    return r;
  };

  await t.test("every reference kernel parses as a DAF", () => {
    zero("daf.parse_failures");
    zero("daf.segment_count_mismatches");
    // Both byte orders and both ID words are represented: msl_atls_gc120806_v1
    // is a published BIG-IEEE NAIF/DAF, cspice_t13_big_endian is a byte-reversed
    // kernel CSPICE agrees with, and the rest are LTL-IEEE DAF/SPK.
    zero("daf.endian_mismatches");
    // With LOCFMT blanked the file record alone must reach the same decision.
    zero("daf.endian_heuristic_failures");
    // At least one fixture's summaries spill past the 25 a single summary
    // record holds, so the forward-link traversal is measured, not assumed.
    assert.ok(get("daf.multi_record_summary_chains").value >= 1,
      "no fixture exercises a multi-record summary chain");
  });

  await t.test("every descriptor field matches CSPICE exactly", () => {
    const compared = get("daf.descriptor_fields_compared");
    console.log(`  descriptor fields compared: ${compared.value}`);
    assert.ok(compared.value >= 200, `only ${compared.value} descriptor fields compared`);
    // dc[] is compared bit-for-bit and ic[] as integers: these are copied out of
    // the file, so a tolerance would hide a wrong offset.
    zero("daf.descriptor_field_mismatches");
    // The comment area is 1000 usable characters per record, not 1024; this
    // hashes the reader's text against CSPICE dafec's.
    zero("daf.comment_area_mismatches");
  });

  await t.test("segment evaluation agrees with CSPICE", () => {
    zero("spk.evaluate_failures");
    for (const type of ["8", "9", "13"]) {
      assert.ok(get(`spk${type}.node.samples`).value >= 1, `no type ${type} node samples`);
      assert.ok(get(`spk${type}.interior.samples`).value >= 1, `no type ${type} interior samples`);
      within(`spk${type}.node.max_pos_km`);
      within(`spk${type}.node.max_vel_km_s`);
      within(`spk${type}.interior.max_pos_km`);
      within(`spk${type}.interior.max_vel_km_s`);
    }
  });

  await t.test("an unsupported segment type is refused, not approximated", () => {
    // A type-5 kernel, a truncated buffer and a non-DAF buffer must each come
    // back as their own status code.
    zero("spk.refusal_failures");
  });

  await t.test("a segment materialises into the ephemeris spine", () => {
    assert.ok(get("spk.to_series.rows").value >= 1, "to_series produced no rows");
    within("spk.to_series.node_max_pos_km");
  });

  await t.test("a written type-13 segment reads back as what went in", () => {
    zero("spkwrite.failures");
    within("spkwrite.t13.roundtrip_max_pos_km");
    within("spkwrite.t13.roundtrip_max_vel_km_s");
  });

  await t.test("the written container is byte-identical to the toolkit's", () => {
    // The strongest statement available without linking CSPICE: rewriting a
    // kernel the official toolkit produced, from our own reader's Series,
    // reproduces every byte. Our reader and writer could share a bug; neither
    // can share one with spkw13.
    zero("spkwrite.t13.cspice_size_delta_bytes");
    zero("spkwrite.t13.cspice_byte_differences");
  });

  await t.test("the harness itself reports no failure", () => {
    const failed = [...results.entries()].filter(([, r]) => !r.pass).map(([n]) => n);
    assert.deepEqual(failed, [], `failing assertions: ${failed.join(", ")}`);
    assert.equal(run.status, 0, `harness exited ${run.status}\n${run.stdout}${run.stderr}`);
  });
});
