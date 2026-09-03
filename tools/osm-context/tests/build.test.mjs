// build.mjs's parsers against saved planetiler output. No Java, no network.
//
// The fixtures are verbatim captures from planetiler 0.10.2 on 2026-09-03:
// planetiler-verify-pass.txt is `verify` on the committed profile,
// planetiler-verify-fail.txt the same on a copy with two `min_zoom: 8` lines
// changed to 9 (and it is the reason the exit code is not trusted: planetiler
// returned 0 for it), planetiler-version.txt is `--version`, and
// build-zuid-holland.log is the prototype's Zuid-Holland build log.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  expectedExampleCount,
  javaMajorVersion,
  MAX_ZOOM,
  parseArgs,
  parseBuildLog,
  parseMd5File,
  parseStateFile,
  parseVerifyOutput,
  parseVersionOutput,
  PLANETILER,
  planetilerBuildArgs,
  PROFILE,
  stripAnsi,
} from "../build.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const fixture = (name) => fs.readFileSync(path.join(HERE, "fixtures", name), "utf8");

test("verify output: 21 passed is 21 passed, and a failing run is named case by case", () => {
  const pass = parseVerifyOutput(fixture("planetiler-verify-pass.txt"));
  assert.deepEqual(pass, { passed: 21, failed: 0, total: 21, failures: [] });
  const fail = parseVerifyOutput(fixture("planetiler-verify-fail.txt"));
  assert.equal(fail.passed, 17);
  assert.equal(fail.failed, 4);
  assert.equal(fail.total, 21);
  assert.deepEqual(fail.failures.map((failure) => failure.name), [
    "primary road with lanes and width",
    "mainline rail",
    "aerodrome node",
    "lake",
  ]);
  assert.match(fail.failures[0].details[0], /feature\[0\]\.minzoom: expected <9> actual <8>/);
  assert.throws(() => parseVerifyOutput("OK\n\nValidating...\n"), /no pass\/fail summary/);
});

test("the profile carries as many examples as the verify run passed", () => {
  assert.equal(expectedExampleCount(fs.readFileSync(PROFILE, "utf8")), 21);
  assert.throws(() => expectedExampleCount("layers: []\n"), /no examples: block/);
});

test("planetiler --version output names the pinned version", () => {
  assert.equal(parseVersionOutput(fixture("planetiler-version.txt")), PLANETILER.version);
  assert.throws(() => parseVersionOutput("0:00:00 INF - argument: stats=use in-memory stats\n"), /did not print a build version/);
});

test("the build log summary is read back with its counts, sizes, timings and data errors", () => {
  const stats = parseBuildLog(fixture("build-zuid-holland.log"));
  assert.equal(stats.finished, true);
  assert.equal(stats.tiles, 5500);
  assert.equal(stats.features, 3512770);
  assert.deepEqual(stats.maxTile, { raw: "375k", gzipped: "221k" });
  assert.deepEqual(stats.avgTile, { raw: "38k", gzipped: "25k" });
  assert.deepEqual(stats.overall, { wall: "14s", cpu: "2m34s", avg: "11" });
  assert.deepEqual(stats.phases.osm_pass1, { wall: "2s", cpu: "26s", avg: "12.9" });
  assert.deepEqual(stats.phases.osm_pass2, { wall: "4s", cpu: "1m23s", avg: "21.2" });
  assert.deepEqual(stats.phases.ocean, { wall: "6s", cpu: "11s", avg: "1.7" });
  assert.deepEqual(stats.phases.sort, { wall: "0.5s", cpu: "7s", avg: "15.3" });
  assert.deepEqual(stats.phases.archive, { wall: "1s", cpu: "27s", avg: "22.7" });
  assert.deepEqual(stats.dataErrors, { render_snap_fix_input: 9914, osm_multipolygon_missing_way: 72 });
  const truncated = fixture("build-zuid-holland.log").split("FINISHED!")[0];
  assert.throws(() => parseBuildLog(truncated), /did not finish/);
});

test("Geofabrik state.txt and .md5 files parse, backslash escapes and all", () => {
  const state = parseStateFile("# original OSM minutely replication sequence number 7269936\ntimestamp=2026-09-02T20\\:20\\:51Z\nsequenceNumber=2839\n");
  assert.deepEqual(state, { timestamp: "2026-09-02T20:20:51Z", sequenceNumber: 2839, originalSequenceNumber: 7269936 });
  assert.throws(() => parseStateFile("timestamp=yesterday\nsequenceNumber=1\n"), /not YYYY-MM-DD/);
  assert.throws(() => parseStateFile("timestamp=2026-09-02T20\\:20\\:51Z\n"), /sequenceNumber/);
  assert.equal(parseMd5File("c7ee6d2cce54e7c981ed3b4e8a044cbd  zuid-holland-latest.osm.pbf\n", "zuid-holland-latest.osm.pbf"), "c7ee6d2cce54e7c981ed3b4e8a044cbd");
  assert.throws(() => parseMd5File("c7ee6d2cce54e7c981ed3b4e8a044cbd  hessen-latest.osm.pbf\n", "zuid-holland-latest.osm.pbf"), /names hessen-latest\.osm\.pbf, not zuid-holland/);
  assert.throws(() => parseMd5File("<html>", "x"), /does not hold/);
});

test("java -version is read for its major version, old and new styles", () => {
  assert.equal(javaMajorVersion('openjdk version "25.0.2" 2026-01-20\nOpenJDK Runtime Environment Homebrew (build 25.0.2)\n'), 25);
  assert.equal(javaMajorVersion('openjdk version "21" 2023-09-19\n'), 21);
  assert.equal(javaMajorVersion('java version "1.8.0_292"\n'), 8);
  assert.throws(() => javaMajorVersion("command not found"), /cannot read a Java version/);
  assert.equal(stripAnsi("\x1b[1m\x1b[32m21 passed\x1b[0m"), "21 passed");
});

test("the JVM argv for a build is exactly the prototype's command with absolute paths", () => {
  const args = planetilerBuildArgs({
    jar: "/b/planetiler-0.10.2.jar",
    xmx: "24g",
    region: "hessen",
    pbf: "/c/hessen-latest.osm.pbf",
    ocean: "/c/sources/water-polygons-split-3857.zip",
    archive: "/o/osm-context-hessen-20260902T202051Z.pmtiles",
    tmpdir: "/o/tmp/hessen",
    profile: "/p/osm-context.yml",
  });
  assert.deepEqual(args, [
    "-Xmx24g",
    "-jar", "/b/planetiler-0.10.2.jar",
    "generate-custom",
    "--schema=/p/osm-context.yml",
    "--area=hessen",
    "--osm_local_path=/c/hessen-latest.osm.pbf",
    "--ocean_local_path=/c/sources/water-polygons-split-3857.zip",
    "--output=/o/osm-context-hessen-20260902T202051Z.pmtiles",
    "--tmpdir=/o/tmp/hessen",
    "--force",
    `--maxzoom=${MAX_ZOOM}`,
    `--render_maxzoom=${MAX_ZOOM}`,
  ]);
  assert.equal(MAX_ZOOM, 14);
  assert.throws(() => planetilerBuildArgs({ jar: "planetiler.jar", xmx: "24g", region: "hessen", pbf: "/c/x.pbf", ocean: "/c/o.zip", archive: "/o/a.pmtiles", tmpdir: "/o/tmp" }), /jar must be an absolute path/);
  assert.throws(() => planetilerBuildArgs({ jar: "/b/p.jar", xmx: "lots", region: "hessen", pbf: "/c/x.pbf", ocean: "/c/o.zip", archive: "/o/a.pmtiles", tmpdir: "/o/tmp" }), /xmx must look like 24g/);
});

test("argv: --verify-only needs no region, a build does, and unknown flags are refused", () => {
  const verifyOnly = parseArgs(["--verify-only"]);
  assert.equal(verifyOnly.verifyOnly, true);
  assert.equal(verifyOnly.region, undefined);
  assert.ok(path.isAbsolute(verifyOnly.out) && path.isAbsolute(verifyOnly.bin) && path.isAbsolute(verifyOnly.cache));
  const build = parseArgs(["--region", "hessen", "--offline", "--xmx", "8g", "--cache", "/data/osm", "--ocean-sha256", "05BA9C22B108ADCAE9724946F6DA9B395119556C75CFAC12CDDC0F8079215435"]);
  assert.equal(build.region, "hessen");
  assert.equal(build.offline, true);
  assert.equal(build.xmx, "8g");
  assert.equal(build.cache, "/data/osm");
  assert.equal(build.oceanSha256, "05ba9c22b108adcae9724946f6da9b395119556c75cfac12cddc0f8079215435");
  assert.throws(() => parseArgs([]), /--region <name> is required/);
  assert.throws(() => parseArgs(["--region"]), /--region needs a value/);
  assert.throws(() => parseArgs(["--region", "Hessen"]), /lower-case/);
  assert.throws(() => parseArgs(["--region", "hessen", "--xmx", "24"]), /--xmx must look like 24g/);
  assert.throws(() => parseArgs(["--region", "hessen", "--ocean-sha256", "abc"]), /64 hex/);
  assert.throws(() => parseArgs(["--region", "hessen", "--planet"]), /unknown argument --planet/);
});
