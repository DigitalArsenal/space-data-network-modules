// Builds and runs the native finals2000A precision harness, and independently
// verifies the two identity claims it makes about the vendored published file:
// its SHA-256 (recorded in fixtures/PROVENANCE.md) and the CIDv1 the reader
// computes for $EOP.DATA_SET_CID.
//
// The CID is re-derived here from Node's own crypto and multiformats-style
// byte layout rather than compared against a string this repo also produced —
// a self-consistent identifier is not an identifier.

import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const fixturePath = path.join(packageRoot, "fixtures", "finals2000A.daily");
const sourcePath = path.join(here, "finals2000a_precision.cpp");
const includePath = path.join(packageRoot, "src");

// Recorded in fixtures/PROVENANCE.md alongside the source URL and retrieval date.
const FIXTURE_SHA256 =
  "9a496d8ea6a2efb84d5a10bee7ff5dd036bd3a6d5f23d6e092170e4303788bc2";

const BASE32_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

function base32LowerNoPad(bytes) {
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_LOWER[(buffer >> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_LOWER[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}

/// CIDv1, codec raw (0x55), multihash sha2-256 (0x12, 32 bytes), base32-lower
/// with the 'b' multibase prefix.
function cidV1RawSha256(bytes) {
  const digest = crypto.createHash("sha256").update(bytes).digest();
  const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  return `b${base32LowerNoPad(cidBytes)}`;
}

test("the vendored IERS fixture is the file PROVENANCE.md records", () => {
  const bytes = fs.readFileSync(fixturePath);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    digest,
    FIXTURE_SHA256,
    "the fixture changed without fixtures/PROVENANCE.md being updated",
  );
});

test("finals2000A reader meets the published-value tolerances", { concurrency: false }, (t) => {
  if (spawnSync("c++", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("no host c++ compiler available");
    return;
  }
  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-eop-"));
  try {
    const binaryPath = path.join(workDir, "finals");
    execFileSync("c++", ["-std=c++17", "-O2", "-I", includePath, "-o", binaryPath, sourcePath], {
      stdio: "pipe",
    });
    const run = spawnSync(binaryPath, [fixturePath], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (run.stdout) {
      console.log(run.stdout);
    }
    assert.equal(run.error, undefined, `harness failed to run: ${run.error?.message}`);
    assert.match(run.stdout, /, 0 failures\n/, "at least one precision check failed");
    assert.equal(run.status, 0, "harness exited non-zero");

    const match = run.stdout.match(/REFERENCE_JSON_BEGIN\n([\s\S]*?)\nREFERENCE_JSON_END/);
    assert.ok(match, "the harness printed no REFERENCE_JSON block");
    const reported = JSON.parse(match[1]);
    assert.equal(
      reported.dataSetCid,
      cidV1RawSha256(fs.readFileSync(fixturePath)),
      "the reader's DATA_SET_CID is not the CIDv1 of the bytes it read",
    );
    assert.equal(reported.rows, 181);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
