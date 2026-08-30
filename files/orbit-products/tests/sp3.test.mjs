// Drives the native SP3-d acceptance harness and fails the suite on any check
// that misses its bound.
//
// Three things happen here that cannot happen inside the C++ harness:
//
//   * the independent parser is LOCATED. Orekit 13.1 is a Java library and its
//     jars, its orekit-data bundle and the Sp3Dump driver live outside this
//     repo (they are authority material, not source). When they are present the
//     harness measures against them; when they are not, the Orekit checks print
//     SKIP and this suite says so out loud rather than reporting a green run
//     that proved less than it claims.
//
//   * the EXISTING in-repo SP3-d reader is exercised on a file this writer
//     produced. That reader is `parse_sp3` in
//     data-source/glonass-source/src/glonass_source.cpp — a static function in
//     an anonymous namespace inside a plugin translation unit that also needs
//     the host hooks and the OEM FlatBuffers headers, so it cannot be included
//     as a header. Its source is sliced out verbatim and compiled with a
//     driver, which is what makes this a test against the SHIPPING reader
//     rather than against a second copy of it. Nothing in that file is
//     modified.
//
//   * the harness binary and every temporary file are kept out of the repo.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const includePath = path.join(here, "..", "src");
const fixturesPath = path.join(here, "..", "fixtures");
const nativeSource = path.join(here, "sp3_native.cpp");

// The shipping SP3-d reader, four directories up and deliberately untouched.
const EXISTING_READER = path.join(
  here, "..", "..", "..", "data-source", "glonass-source", "src", "glonass_source.cpp",
);

function hasCompiler() {
  return spawnSync("c++", ["--version"], { stdio: "ignore" }).status === 0;
}

// Authority material (Orekit jars, orekit-data, the Sp3Dump driver) lives
// outside the repo. GMAT09_AUTHORITY names it; the fallback is the location the
// task's authority set was fetched to.
function findAuthority() {
  const root = process.env.GMAT09_AUTHORITY
    ?? path.join(homedir(), "software", "gmat09-authority");
  const jars = path.join(root, "jars");
  const data = path.join(root, "orekit-data", "orekit-data-main");
  const driver = path.join(root, "java-sp3");
  if (!existsSync(jars) || !existsSync(data) || !existsSync(path.join(driver, "Sp3Dump.java"))) {
    return null;
  }
  if (spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
    return null;
  }
  const classpath = readdirSync(jars)
    .filter((name) => name.endsWith(".jar"))
    .map((name) => path.join(jars, name))
    .concat([driver])
    .join(":");
  if (!existsSync(path.join(driver, "Sp3Dump.class"))) {
    const javac = spawnSync("javac", ["-cp", classpath, "-d", driver,
      path.join(driver, "Sp3Dump.java")], { stdio: "pipe" });
    if (javac.status !== 0) {
      return null;
    }
  }
  return { classpath, data };
}

let cached;

function runHarness() {
  if (cached !== undefined) {
    return cached;
  }
  if (!hasCompiler()) {
    cached = null;
    return cached;
  }
  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-orbit-sp3-"));
  const binaryPath = path.join(workDir, "sp3_native");
  const authority = findAuthority();
  try {
    execFileSync("c++", ["-std=c++17", "-O2", "-I", includePath, "-o", binaryPath, nativeSource], {
      stdio: "pipe",
    });
    const env = { ...process.env, SP3_TMPDIR: workDir };
    if (authority) {
      env.SP3_OREKIT_CP = authority.classpath;
      env.SP3_OREKIT_DATA = authority.data;
    } else {
      delete env.SP3_OREKIT_CP;
      delete env.SP3_OREKIT_DATA;
    }
    const run = spawnSync(binaryPath, ["--fixtures", fixturesPath], {
      encoding: "utf8",
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    cached = {
      status: run.status,
      stdout: run.stdout ?? "",
      stderr: run.stderr ?? "",
      workDir,
      hasOrekit: authority !== null,
      // The harness leaves the file it wrote here; the existing-reader check
      // below reads exactly those bytes.
      writtenPath: path.join(workDir, "sp3_written_d.sp3"),
    };
    return cached;
  } finally {
    // The work directory holds the harness output the later tests read, so it
    // is removed by the process exit hook rather than here.
  }
}

// One shared work directory, cleaned when the suite ends.
process.on("exit", () => {
  if (cached?.workDir) {
    rmSync(cached.workDir, { recursive: true, force: true });
  }
});

function parseResults(stdout) {
  const rows = [];
  for (const line of stdout.split("\n")) {
    const m = /^RESULT (\S+) (\S+) (\S+) (PASS|FAIL|SKIP)$/.exec(line);
    if (m) {
      rows.push({ name: m[1], value: Number(m[2]), bound: Number(m[3]), verdict: m[4] });
    }
  }
  return rows;
}

test("SP3-d writer and reader meet the specification and an independent parser",
  { concurrency: false }, (t) => {
    const run = runHarness();
    if (!run) {
      t.skip("no host c++ compiler");
      return;
    }
    if (run.stdout) {
      console.log(run.stdout);
    }
    if (run.stderr) {
      console.error(run.stderr);
    }
    const rows = parseResults(run.stdout);
    assert.ok(rows.length >= 40, `harness printed only ${rows.length} RESULT lines`);

    const failed = rows.filter((r) => r.verdict === "FAIL");
    assert.deepEqual(failed.map((r) => `${r.name}=${r.value} (bound ${r.bound})`), [],
      "SP3-d acceptance checks missed their bounds");

    const skipped = rows.filter((r) => r.verdict === "SKIP").map((r) => r.name);
    if (run.hasOrekit) {
      assert.deepEqual(skipped, [],
        "Orekit is available, so nothing may be skipped");
      // The claim the acceptance actually cares about: somebody else's parser
      // read our bytes and got our numbers back.
      const orekit = rows.find((r) => r.name === "orekit_position_rel");
      assert.ok(orekit && orekit.verdict === "PASS",
        "Orekit did not agree with the written file's coordinates");
    } else {
      console.warn(
        `Orekit authority not found; ${skipped.length} independent-parser checks were skipped. `
        + "Set GMAT09_AUTHORITY to a directory holding jars/, orekit-data/ and java-sp3/.",
      );
    }
    assert.equal(run.status, 0, "SP3-d acceptance harness exited non-zero");
  });

// ---------------------------------------------------------------------------

// Slices `parse_sp3` and its helpers out of the shipping plugin source. The
// markers are the section banner it opens with and the first line of the next
// section, so the extraction fails loudly if that file is reorganised instead
// of silently testing half a parser.
function extractExistingReader() {
  const source = readFileSync(EXISTING_READER, "utf8");
  const start = source.indexOf("// ── SP3 parsing");
  const end = source.indexOf("// Build a schema-exact verbose OEM record");
  if (start < 0 || end <= start) {
    return null;
  }
  return source.slice(start, end);
}

const EXISTING_READER_DRIVER = `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <vector>
namespace {
__SLICE__
}  // namespace
int main(int argc, char** argv) {
  if (argc < 2) return 2;
  FILE* f = fopen(argv[1], "rb");
  if (!f) return 2;
  std::string content; char buf[65536]; size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) content.append(buf, n);
  fclose(f);
  Sp3Meta meta; std::vector<SatEphem> sats;
  parse_sp3(content, &meta, &sats);
  printf("META\\t%s\\t%s\\t%s\\t%s\\t%s\\t%ld\\n", meta.version.c_str(),
         meta.coord_system.c_str(), meta.time_system.c_str(), meta.orbit_type.c_str(),
         meta.agency.c_str(), meta.gps_week);
  for (size_t i = 0; i < sats.size(); ++i)
    for (size_t j = 0; j < sats[i].states.size(); ++j)
      printf("ROW\\t%s\\t%s\\t%.9f\\t%.9f\\t%.9f\\n", sats[i].sat_id.c_str(),
             sats[i].states[j].epoch.c_str(), sats[i].states[j].x, sats[i].states[j].y,
             sats[i].states[j].z);
  return 0;
}
`;

// The literal kilometre columns of every GLONASS P record, read straight off
// the bytes and grouped per satellite in file order. Comparing the existing
// reader against THESE rather than against sp3::read is the point: two readers
// that share a misreading would agree with each other and with nothing else.
//
// The grouping matters because the two sides disagree about layout, not about
// content: SP3 is epoch-major, and the existing reader returns one
// insertion-ordered state list per satellite.
function glonassColumnsOf(text) {
  const bySat = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line[0] !== "P" || line[1] !== "R") {
      continue;
    }
    const sat = line.slice(1, 4).trim();
    if (!bySat.has(sat)) {
      bySat.set(sat, []);
    }
    bySat.get(sat).push({
      x: Number(line.slice(4, 18)),
      y: Number(line.slice(18, 32)),
      z: Number(line.slice(32, 46)),
    });
  }
  return bySat;
}

test("a written SP3-d file is read back by the repo's existing SP3-d reader",
  { concurrency: false }, (t) => {
    const run = runHarness();
    if (!run) {
      t.skip("no host c++ compiler");
      return;
    }
    if (!existsSync(run.writtenPath)) {
      t.skip("the harness produced no written SP3-d file");
      return;
    }
    const slice = extractExistingReader();
    if (slice === null) {
      t.skip(`could not locate parse_sp3 in ${EXISTING_READER}`);
      return;
    }

    const driverPath = path.join(run.workDir, "existing_reader.cpp");
    const driverBin = path.join(run.workDir, "existing_reader");
    writeFileSync(driverPath, EXISTING_READER_DRIVER.replace("__SLICE__", slice));
    execFileSync("c++", ["-std=c++17", "-O2", "-o", driverBin, driverPath], { stdio: "pipe" });

    const parsed = spawnSync(driverBin, [run.writtenPath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(parsed.status, 0, "the existing SP3-d reader failed on our written file");

    const rows = [];
    let meta = null;
    for (const line of parsed.stdout.split("\n")) {
      const f = line.split("\t");
      if (f[0] === "META") {
        meta = {
          version: f[1], coordinateSystem: f[2], timeSystem: f[3], orbitType: f[4],
          agency: f[5], gpsWeek: Number(f[6]),
        };
      } else if (f[0] === "ROW") {
        rows.push({ sat: f[1], epoch: f[2], x: Number(f[3]), y: Number(f[4]), z: Number(f[5]) });
      }
    }

    assert.equal(meta?.version, "d", "the existing reader did not see an SP3-d file");
    assert.equal(meta.coordinateSystem, "IGS20");
    assert.equal(meta.timeSystem, "GPS");
    assert.equal(meta.orbitType, "FIT");
    assert.equal(meta.gpsWeek, 2350);

    const expected = glonassColumnsOf(readFileSync(run.writtenPath, "utf8"));
    assert.ok(expected.size > 0, "the written file carried no GLONASS records");
    const total = [...expected.values()].reduce((n, states) => n + states.length, 0);
    assert.equal(rows.length, total,
      "the existing reader recovered a different number of GLONASS states");

    let maxRel = 0;
    const cursor = new Map();
    for (const row of rows) {
      const states = expected.get(row.sat);
      assert.ok(states, `the existing reader invented satellite ${row.sat}`);
      const k = cursor.get(row.sat) ?? 0;
      cursor.set(row.sat, k + 1);
      assert.ok(k < states.length, `too many states for ${row.sat}`);
      const want = states[k];
      const scale = Math.hypot(want.x, want.y, want.z);
      for (const axis of ["x", "y", "z"]) {
        maxRel = Math.max(maxRel, Math.abs(row[axis] - want[axis]) / scale);
      }
    }
    assert.equal(cursor.size, expected.size,
      "the existing reader missed a satellite the file declares");
    // Epochs must arrive in order within each satellite, which is what makes
    // the positional pairing above legitimate.
    const seen = new Map();
    for (const row of rows) {
      const prev = seen.get(row.sat);
      assert.ok(prev === undefined || row.epoch > prev,
        `epochs for ${row.sat} are not increasing`);
      seen.set(row.sat, row.epoch);
    }
    console.log(
      `RESULT existing_reader_position_rel ${maxRel} 1e-9 ${maxRel <= 1e-9 ? "PASS" : "FAIL"}`,
    );
    assert.ok(maxRel <= 1e-9,
      `existing SP3-d reader disagrees with the written columns by ${maxRel}`);
  });
