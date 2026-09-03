// tools/osm-context/build.mjs — the OFF-FLEET OSM context tileset builder.
//
// PLACEMENT, AS FOR TERRAIN. The tileset is built here, on the build machine,
// never on a node: a planet build is hours of CPU and a hundred gigabytes of
// scratch, and the archive it produces is a release artifact — cut once per
// epoch, byte-identical for every consumer, published by CID. This script is
// not a node and holds no identity; it runs planetiler and writes a directory.
// It is the Node port of the prototype's build.sh (evidence/BUILD-EVIDENCE.md)
// so the tool has one runtime and no shell-quoting of URLs.
//
// WHAT IT DOES, in order, refusing at the first thing it cannot prove:
//
//   1. planetiler in bin/ — downloaded if missing, sha256 checked against the
//      pin below whether it was downloaded or not; a Java >= 21 found and its
//      version recorded; planetiler's own `--version` checked against the pin.
//   2. The profile's own test cases (`planetiler verify`, no data needed).
//      planetiler exits 0 even when cases fail (observed with 0.10.2), so the
//      output is parsed, and "<n> passed" with n equal to the number of
//      examples in the profile is the only acceptable result. `--verify-only`
//      stops here.
//   3. Inputs in cache/: the Geofabrik extract, its .md5 (integrity) and its
//      replication state file (the epoch), and the osmdata ocean polygons —
//      sha256-pinned in regions.json, and see there for why a fresh download
//      will not match. A cached extract whose bytes do not match the .md5 is
//      downloaded again and refused if it still does not.
//   4. `planetiler generate-custom` with the profile, writing
//      out/osm-context-<region>-<epoch>.pmtiles and out/build-<region>.log.
//   5. The archive header and metadata are read back natively
//      (write-record.mjs); the replication epoch and sequence in the metadata
//      are checked against the state file and the layer ids against the
//      profile; `pmtiles show` is printed when the go-pmtiles CLI is available;
//      and two files land beside the archive — the tileset record
//      (<name>.vtt.json) and the run report (<name>.run.json) with every
//      input's URL, byte count, digest and retrieval time.
//
//   node tools/osm-context/build.mjs --verify-only
//   node tools/osm-context/build.mjs --region hessen
//   node tools/osm-context/build.mjs --region zuid-holland --offline --cache <dir>
//   ... [--out <dir>] [--bin <dir>] [--cache <dir>] [--java <path>] [--xmx 24g]
//       [--planetiler-jar <path>] [--pmtiles <path>] [--ocean-sha256 <hex>]
//
// bin/, cache/ and out/ are gitignored; nothing this writes is meant to be
// committed except what an operator copies into evidence/ by hand.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { fetchWithRetry } from "../terrain-pyramid/build-support.mjs";
import { buildTilesetRecord, compactEpoch, formatRecord, readPmtilesArchive, REPLICATION_TIME_KEY } from "./write-record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
export const PROFILE = path.join(HERE, "profile", "osm-context.yml");
export const REGIONS_FILE = path.join(HERE, "regions.json");
export const MAX_ZOOM = 14;

// The pinned processor. The URL and digest are the v0.10.2 GitHub release
// (planetiler.jar.sha256 published beside the jar); Apache-2.0.
export const PLANETILER = Object.freeze({
  version: "0.10.2",
  url: "https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar",
  sha256: "f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d",
  sha256Url: "https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar.sha256",
  gitHash: "0e5588c4a6e8c29a270a33afe8df62027d889604",
  license: "Apache-2.0",
  javaMajorMin: 21,
});

// Optional: the go-pmtiles CLI, used only for an independent `pmtiles show`
// beside the native header read. Not downloaded (one zip per OS/arch); the
// prototype's build is the one digest known so far. BSD-3-Clause.
export const GO_PMTILES = Object.freeze({
  version: "1.31.2",
  releases: "https://github.com/protomaps/go-pmtiles/releases/tag/v1.31.2",
  knownSha256: Object.freeze({
    "go-pmtiles-1.31.2_Darwin_arm64.zip": "40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d",
  }),
});

const USER_AGENT = "space-data-network-modules tools/osm-context build.mjs";
const GEOFABRIK = "https://download.geofabrik.de/";
const OSMDATA = "https://osmdata.openstreetmap.de/";
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REGION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HEX_MD5 = /^[0-9a-f]{32}$/;
// .md5 and state.txt are a line or three; anything bigger is not them.
const MAX_SMALL_DOWNLOAD_BYTES = 64 * 1024;
const OCEAN_FILE_NAME = "water-polygons-split-3857.zip";

// ── pure helpers (tested without Java or network) ───────────────────────────

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** "openjdk version \"25.0.2\"" -> 25; "java version \"1.8.0_292\"" -> 8. */
export function javaMajorVersion(text) {
  const match = /\bversion "(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) throw new Error(`cannot read a Java version from ${JSON.stringify(stripAnsi(text).trim())}`);
  const major = Number(match[1]);
  return major === 1 ? Number(match[2]) : major;
}

/** planetiler --version prints "Planetiler build version: 0.10.2" among its argument dump. */
export function parseVersionOutput(text) {
  const match = /Planetiler build version:\s*(\S+)/.exec(stripAnsi(text));
  if (!match) throw new Error("planetiler --version did not print a build version");
  return match[1];
}

/**
 * planetiler verify prints one " PASS "/" FAIL " line per example and a
 * summary of "21 passed" or "4 failed, 17 passed, 21 total". The process exit
 * code is 0 either way, so this is the check.
 */
export function parseVerifyOutput(text) {
  const clean = stripAnsi(text);
  const summary = /^(?:(\d+) failed, )?(\d+) passed(?:, (\d+) total)?\s*$/m.exec(clean);
  if (!summary) throw new Error("planetiler verify printed no pass/fail summary");
  const failed = summary[1] === undefined ? 0 : Number(summary[1]);
  const passed = Number(summary[2]);
  const total = summary[3] === undefined ? passed + failed : Number(summary[3]);
  // Each failing case is printed in the run and again under "Summary of
  // failures:", so failures are keyed by name.
  const failures = new Map();
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^ FAIL {2}(.+?)\s*$/.exec(lines[i]);
    if (!match) continue;
    const details = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j += 1) details.push(lines[j].trim());
    if (!failures.has(match[1])) failures.set(match[1], { name: match[1], details });
  }
  assert.equal(failures.size, failed, `verify summary says ${failed} failed but ${failures.size} distinct FAIL cases were printed`);
  return { passed, failed, total, failures: [...failures.values()] };
}

/** Everything after `examples:` in the profile; one `- name:` per case. */
export function expectedExampleCount(profileText) {
  const start = profileText.search(/^examples:\s*$/m);
  if (start < 0) throw new Error("profile has no examples: block");
  const count = (profileText.slice(start).match(/^\s+- name:/gm) ?? []).length;
  assert.ok(count > 0, "profile examples: block has no cases");
  return count;
}

/**
 * The layers of the profile as [{ id, block }], block being the YAML text of
 * that layer. A line-oriented slice rather than a YAML parse: the repository
 * carries no YAML dependency, and the checks that read this (the tests, the
 * post-build layer cross-check) need the layer ids and the `- key:` lines,
 * which planetiler's `verify` then validates for real.
 */
export function profileLayers(profileText) {
  const start = profileText.search(/^layers:\s*$/m);
  if (start < 0) throw new Error("profile has no layers: block");
  let end = profileText.search(/^examples:\s*$/m);
  if (end < start) end = profileText.length;
  const section = profileText.slice(start, end);
  const heads = [...section.matchAll(/^ {2}- id: (\S+)\s*$/gm)];
  assert.ok(heads.length > 0, "profile layers: block has no `- id:` entries");
  return heads.map((head, index) => ({
    id: head[1],
    block: section.slice(head.index, index + 1 < heads.length ? heads[index + 1].index : section.length),
  }));
}

/** The archive-summary block planetiler prints at the end of a build log. */
export function parseBuildLog(text) {
  const clean = stripAnsi(text);
  const count = (re) => {
    const match = re.exec(clean);
    return match ? Number(match[1].replace(/,/g, "")) : null;
  };
  const sizes = (re) => {
    const match = re.exec(clean);
    return match ? { raw: match[1], gzipped: match[2] } : null;
  };
  const timing = (name) => {
    const match = new RegExp(`\\t${name}\\s+(\\S+)\\s+cpu:(\\S+)\\s+avg:(\\S+)`).exec(clean);
    return match ? { wall: match[1], cpu: match[2], avg: match[3] } : null;
  };
  const dataErrors = {};
  const errorsBlock = /data errors:\n([\s\S]*?)\n[^\n]*-{10,}/.exec(clean);
  if (errorsBlock) {
    for (const line of errorsBlock[1].split("\n")) {
      const match = /\t(\w+)\t([\d,]+)\s*$/.exec(line);
      if (match) dataErrors[match[1]] = Number(match[2].replace(/,/g, ""));
    }
  }
  const stats = {
    finished: /\bFINISHED!/.test(clean),
    tiles: count(/#\s*tiles:\s*([\d,]+)/),
    features: count(/#\s*features:\s*([\d,]+)/),
    maxTile: sizes(/Max tile:\s*(\S+)\s*\(gzipped:\s*(\S+)\)/),
    avgTile: sizes(/Avg tile:\s*(\S+)\s*\(gzipped:\s*(\S+)\)/),
    overall: timing("overall"),
    phases: Object.fromEntries(["osm_pass1", "osm_pass2", "ocean", "sort", "archive"].map((name) => [name, timing(name)])),
    dataErrors,
  };
  if (!stats.finished || stats.tiles === null || stats.features === null || !stats.overall) {
    throw new Error("build log has no archive summary; planetiler did not finish");
  }
  return stats;
}

/** Geofabrik state.txt: `timestamp=2026-09-02T20\:20\:51Z`, `sequenceNumber=4890`, and a comment naming the planet sequence. */
export function parseStateFile(text) {
  const values = {};
  let originalSequenceNumber = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) {
      const match = /sequence number (\d+)/.exec(line);
      if (match) originalSequenceNumber = Number(match[1]);
      continue;
    }
    const eq = line.indexOf("=");
    assert.ok(eq > 0, `state.txt line ${JSON.stringify(line)} is not key=value`);
    values[line.slice(0, eq)] = line.slice(eq + 1).replace(/\\(.)/g, "$1");
  }
  assert.ok(typeof values.timestamp === "string" && ISO_SECONDS.test(values.timestamp), `state.txt timestamp ${JSON.stringify(values.timestamp)} is not YYYY-MM-DDTHH:MM:SSZ`);
  assert.match(values.sequenceNumber ?? "", /^\d+$/, "state.txt has no integer sequenceNumber");
  return { timestamp: values.timestamp, sequenceNumber: Number(values.sequenceNumber), originalSequenceNumber };
}

/** Geofabrik .md5: `<hex>  <file name>`. Returns the hex; the name must be the extract's. */
export function parseMd5File(text, expectedName) {
  const match = /^([0-9a-f]{32})\s+(\S+)\s*$/m.exec(text.trim());
  if (!match) throw new Error(`.md5 file does not hold "<md5>  <name>": ${JSON.stringify(text.trim())}`);
  if (expectedName !== undefined && match[2] !== expectedName) {
    throw new Error(`.md5 file names ${match[2]}, not ${expectedName}`);
  }
  return match[1];
}

export function validateRegions(json) {
  assert.ok(json && typeof json === "object" && !Array.isArray(json), "regions.json must be an object");
  const { ocean, regions } = json;
  assert.ok(ocean && typeof ocean === "object", "regions.json needs an `ocean` block");
  assert.ok(typeof ocean.url === "string" && ocean.url.startsWith(OSMDATA) && ocean.url.endsWith(`/${OCEAN_FILE_NAME}`), `ocean.url must be ${OSMDATA}.../${OCEAN_FILE_NAME}`);
  assert.ok(typeof ocean.sha256 === "string" && HEX_SHA256.test(ocean.sha256), "ocean.sha256 must be a 64-hex sha256 pin");
  assert.ok(Number.isSafeInteger(ocean.bytes) && ocean.bytes > 0, "ocean.bytes must be a positive integer");
  assert.ok(typeof ocean.files_dated === "string" && ISO_SECONDS.test(ocean.files_dated), "ocean.files_dated must be YYYY-MM-DDTHH:MM:SSZ");
  assert.equal(ocean.license, "ODbL-1.0", "ocean.license must be ODbL-1.0");
  assert.ok(regions && typeof regions === "object" && !Array.isArray(regions), "regions.json needs a `regions` object");
  assert.ok(Object.keys(regions).length > 0, "regions.json names no regions");
  for (const [name, region] of Object.entries(regions)) {
    assert.ok(REGION_NAME.test(name), `region name ${JSON.stringify(name)} must be lower-case words joined by hyphens`);
    assert.ok(region && typeof region === "object" && !Array.isArray(region), `region ${name} must be an object`);
    const { pbf, md5, state } = region;
    const extractName = `${name}-latest.osm.pbf`;
    assert.ok(typeof pbf === "string" && pbf.startsWith(GEOFABRIK) && pbf.endsWith(`/${extractName}`), `${name}.pbf must be ${GEOFABRIK}<path>/${extractName}`);
    assert.equal(md5, `${pbf}.md5`, `${name}.md5 must be the extract URL plus .md5`);
    const directory = pbf.slice(0, pbf.length - extractName.length);
    assert.equal(state, `${directory}${name}-updates/state.txt`, `${name}.state must be ${directory}${name}-updates/state.txt`);
    const unknown = Object.keys(region).filter((key) => !["pbf", "md5", "state", "//"].includes(key));
    assert.deepEqual(unknown, [], `region ${name} has unknown keys: ${unknown.join(", ")}`);
  }
  return json;
}

export function loadRegions(file = REGIONS_FILE) {
  return validateRegions(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Where a region/epoch build lands. */
export function outputPaths({ out, region, epoch }) {
  assert.ok(REGION_NAME.test(region), `region ${JSON.stringify(region)} must be lower-case words joined by hyphens`);
  const stem = path.join(out, `osm-context-${region}-${compactEpoch(epoch)}`);
  return {
    archive: `${stem}.pmtiles`,
    record: `${stem}.vtt.json`,
    report: `${stem}.run.json`,
    log: path.join(out, `build-${region}.log`),
    tmpdir: path.join(out, "tmp", region),
  };
}

/** The exact argv the JVM gets for a build; asserted by the tests. */
export function planetilerBuildArgs({ jar, xmx, region, pbf, ocean, archive, tmpdir, profile = PROFILE }) {
  for (const [name, value] of Object.entries({ jar, pbf, ocean, archive, tmpdir, profile })) {
    assert.ok(path.isAbsolute(value), `${name} must be an absolute path (planetiler resolves relative paths against its cwd)`);
  }
  assert.match(xmx, /^\d+[gGmM]$/, "xmx must look like 24g");
  assert.ok(REGION_NAME.test(region), `region ${JSON.stringify(region)} must be lower-case words joined by hyphens`);
  return [
    `-Xmx${xmx}`,
    "-jar", jar,
    "generate-custom",
    `--schema=${profile}`,
    `--area=${region}`,
    `--osm_local_path=${pbf}`,
    `--ocean_local_path=${ocean}`,
    `--output=${archive}`,
    `--tmpdir=${tmpdir}`,
    "--force",
    `--maxzoom=${MAX_ZOOM}`,
    `--render_maxzoom=${MAX_ZOOM}`,
  ];
}

// ── processes, files, downloads ─────────────────────────────────────────────

export function run(command, args, { cwd = HERE, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const collect = (chunk) => {
      chunks.push(chunk);
      onChunk?.(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

export function digestFile(file, algorithms = ["sha256"]) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(handle, { bigint: true });
    assert.ok(stat.isFile(), `${file} is not a regular file`);
    assert.ok(stat.size <= BigInt(Number.MAX_SAFE_INTEGER), `${file} exceeds JavaScript's safe byte range`);
    const bytes = Number(stat.size);
    const hashes = algorithms.map((algorithm) => createHash(algorithm));
    const chunk = Buffer.alloc(1 << 20);
    let offset = 0;
    while (offset < bytes) {
      const read = fs.readSync(handle, chunk, 0, Math.min(chunk.length, bytes - offset), offset);
      assert.ok(read > 0, `${file} ended while being digested`);
      for (const hash of hashes) hash.update(chunk.subarray(0, read));
      offset += read;
    }
    const result = { bytes };
    algorithms.forEach((algorithm, index) => { result[algorithm] = hashes[index].digest("hex"); });
    return result;
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Stream a URL to `dest` through a `.part` file, digesting as it goes; the
 * final rename happens only after the whole body arrived and its length
 * matched the announced Content-Length. Retries and backoff are the terrain
 * lane's (build-support.mjs); GitHub release URLs redirect, so redirects are
 * followed there.
 */
export async function download(url, dest, { maxBytes = Infinity, fetchImpl = fetch } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  fs.rmSync(partial, { force: true });
  const requestedAt = nowIso();
  const response = await fetchWithRetry(url, {
    fetchImpl: (target, init) => fetchImpl(target, { ...init, headers: { "user-agent": USER_AGENT } }),
  });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  const announced = response.headers.get("content-length");
  if (announced !== null) {
    assert.match(announced, /^\d+$/, `${url}: Content-Length ${JSON.stringify(announced)} is not a byte count`);
    assert.ok(Number(announced) <= maxBytes, `${url}: Content-Length ${announced} exceeds the ${maxBytes}-byte cap`);
  }
  assert.ok(response.body, `${url}: response has no body`);
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(new Error(`${url}: body exceeds the ${maxBytes}-byte cap`));
      sha256.update(chunk);
      md5.update(chunk);
      return callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(partial, { flags: "wx", mode: 0o644 }));
    if (announced !== null && Number(announced) !== bytes) {
      throw new Error(`${url}: received ${bytes} bytes, Content-Length said ${announced}`);
    }
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.renameSync(partial, dest);
  return {
    url,
    dest,
    bytes,
    sha256: sha256.digest("hex"),
    md5: md5.digest("hex"),
    status: response.status,
    lastModified: response.headers.get("last-modified"),
    etag: response.headers.get("etag"),
    requestedAt,
    retrievedAt: nowIso(),
  };
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fileMtimeIso(file) {
  return new Date(fs.statSync(file).mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── the steps ───────────────────────────────────────────────────────────────

export async function findJava(override) {
  const explicit = override ?? process.env.JAVA;
  const candidates = explicit ? [explicit] : ["java", "/opt/homebrew/opt/openjdk/bin/java"];
  const tried = [];
  for (const candidate of candidates) {
    let result;
    try {
      result = await run(candidate, ["-version"]);
    } catch (error) {
      tried.push(`${candidate}: ${error.message}`);
      continue;
    }
    if (result.code !== 0) {
      tried.push(`${candidate}: exit ${result.code}`);
      continue;
    }
    const major = javaMajorVersion(result.output);
    if (major < PLANETILER.javaMajorMin) {
      tried.push(`${candidate}: Java ${major} is older than ${PLANETILER.javaMajorMin}`);
      continue;
    }
    return { path: candidate, major, version: stripAnsi(result.output).trim().split("\n")[0] };
  }
  throw new Error(`no Java >= ${PLANETILER.javaMajorMin} found (${tried.join("; ")}); pass --java <path> or set JAVA`);
}

export async function ensurePlanetiler({ bin, jarOverride, offline }) {
  const jar = jarOverride ? path.resolve(jarOverride) : path.join(bin, `planetiler-${PLANETILER.version}.jar`);
  let downloaded = null;
  if (!fs.existsSync(jar)) {
    if (jarOverride) throw new Error(`--planetiler-jar ${jar} does not exist`);
    if (offline) throw new Error(`${jar} is missing and --offline was given; drop --offline to download planetiler ${PLANETILER.version}`);
    console.log(`== downloading planetiler ${PLANETILER.version} from ${PLANETILER.url}`);
    downloaded = await download(PLANETILER.url, jar);
  }
  const digest = digestFile(jar);
  if (digest.sha256 !== PLANETILER.sha256) {
    throw new Error(`${jar}: sha256 ${digest.sha256} is not planetiler ${PLANETILER.version}'s pinned ${PLANETILER.sha256}; delete it and re-run, or pass the right jar`);
  }
  return { jar, ...digest, downloaded };
}

export async function checkPlanetilerVersion({ java, jar }) {
  const result = await run(java.path, ["-jar", jar, "--version"]);
  if (result.code !== 0) throw new Error(`planetiler --version exited ${result.code}:\n${stripAnsi(result.output)}`);
  const version = parseVersionOutput(result.output);
  if (version !== PLANETILER.version) throw new Error(`${jar} reports planetiler ${version}, pinned ${PLANETILER.version}`);
  return version;
}

export async function verifyProfile({ java, jar, xmx = "4g", profile = PROFILE }) {
  const expected = expectedExampleCount(fs.readFileSync(profile, "utf8"));
  const result = await run(java.path, [`-Xmx${xmx}`, "-jar", jar, "verify", profile]);
  const parsed = parseVerifyOutput(result.output);
  if (result.code !== 0 || parsed.failed > 0 || parsed.passed !== expected) {
    const failures = parsed.failures.map((failure) => `  FAIL ${failure.name}${failure.details.map((line) => `\n    ${line}`).join("")}`);
    throw new Error(`profile verification failed: exit ${result.code}, ${parsed.passed} passed, ${parsed.failed} failed, ${expected} expected${failures.length ? `\n${failures.join("\n")}` : ""}`);
  }
  return { passed: parsed.passed, expected, exitCode: result.code, output: stripAnsi(result.output) };
}

export async function ensureOcean({ cache, offline, ocean, pinOverride }) {
  const file = path.join(cache, "sources", OCEAN_FILE_NAME);
  const sidecar = `${file}.retrieved.json`;
  const pin = pinOverride ?? ocean.sha256;
  const pinSource = pinOverride ? "--ocean-sha256" : "regions.json";
  let downloaded = null;
  if (!fs.existsSync(file)) {
    if (offline) throw new Error(`${file} is missing and --offline was given; drop --offline to download ${ocean.url}`);
    console.log(`== downloading ocean polygons from ${ocean.url} (about ${Math.round(ocean.bytes / 1e6)} MB)`);
    downloaded = await download(ocean.url, file);
    fs.writeFileSync(sidecar, `${JSON.stringify(downloaded, null, 2)}\n`);
  }
  const digest = digestFile(file);
  if (digest.sha256 !== pin) {
    throw new Error(
      `${file}: sha256 ${digest.sha256} is not the pinned ${pin} (${pinSource}). osmdata replaces this file daily; ` +
      `if the new file is the one you mean to build with, re-run with --ocean-sha256 ${digest.sha256} ` +
      `(recorded in the run report) or update regions.json. The file is kept.`,
    );
  }
  const retrieved = downloaded ?? readJsonIfPresent(sidecar);
  return {
    path: file,
    url: ocean.url,
    ...digest,
    pinnedSha256: pin,
    pinSource,
    filesDated: ocean.files_dated,
    lastModified: retrieved?.lastModified ?? null,
    retrievedAt: retrieved?.retrievedAt ?? fileMtimeIso(file),
    retrievedAtSource: retrieved ? "download record" : "file mtime",
    downloaded: downloaded !== null,
  };
}

export async function ensureExtract({ cache, region, spec, offline }) {
  const extractName = `${region}-latest.osm.pbf`;
  const pbf = path.join(cache, extractName);
  const md5File = `${pbf}.md5`;
  const stateFile = path.join(cache, `${region}-updates-state.txt`);
  const sidecar = `${pbf}.retrieved.json`;
  if (!offline) {
    await download(spec.md5, md5File, { maxBytes: MAX_SMALL_DOWNLOAD_BYTES });
    await download(spec.state, stateFile, { maxBytes: MAX_SMALL_DOWNLOAD_BYTES });
  }
  for (const required of [md5File, stateFile]) {
    if (!fs.existsSync(required)) throw new Error(`${required} is missing and --offline was given`);
  }
  const expectedMd5 = parseMd5File(fs.readFileSync(md5File, "utf8"), extractName);
  const state = parseStateFile(fs.readFileSync(stateFile, "utf8"));

  let downloaded = null;
  let digest = fs.existsSync(pbf) ? digestFile(pbf, ["md5"]) : null;
  if (digest && digest.md5 !== expectedMd5) {
    if (offline) throw new Error(`${pbf}: md5 ${digest.md5} does not match ${md5File} (${expectedMd5}) and --offline was given`);
    console.log(`== cached ${extractName} md5 ${digest.md5} is not the published ${expectedMd5}; the extract has rolled, downloading again`);
    digest = null;
  }
  if (!digest) {
    if (offline) throw new Error(`${pbf} is missing and --offline was given; drop --offline to download ${spec.pbf}`);
    console.log(`== downloading ${spec.pbf}`);
    downloaded = await download(spec.pbf, pbf);
    if (downloaded.md5 !== expectedMd5) {
      throw new Error(`${pbf}: downloaded md5 ${downloaded.md5} is not the published ${expectedMd5}; the extract rolled during the download, re-run`);
    }
    fs.writeFileSync(sidecar, `${JSON.stringify(downloaded, null, 2)}\n`);
    digest = { bytes: downloaded.bytes, md5: downloaded.md5 };
  }
  const retrieved = downloaded ?? readJsonIfPresent(sidecar);
  return {
    region,
    pbf,
    sourceUrl: spec.pbf,
    md5Url: spec.md5,
    stateUrl: spec.state,
    bytes: digest.bytes,
    md5: digest.md5,
    state,
    retrievedAt: retrieved?.retrievedAt ?? fileMtimeIso(pbf),
    retrievedAtSource: retrieved ? "download record" : "file mtime",
    downloaded: downloaded !== null,
  };
}

export async function buildArchive({ java, jar, xmx, region, pbf, ocean, paths }) {
  fs.mkdirSync(path.dirname(paths.archive), { recursive: true });
  fs.rmSync(paths.tmpdir, { recursive: true, force: true });
  fs.mkdirSync(paths.tmpdir, { recursive: true });
  const args = planetilerBuildArgs({ jar, xmx, region, pbf, ocean, archive: paths.archive, tmpdir: paths.tmpdir });
  const log = fs.openSync(paths.log, "w");
  const started = Date.now();
  let result;
  try {
    result = await run(java.path, args, { onChunk: (chunk) => fs.writeSync(log, chunk) });
  } finally {
    fs.closeSync(log);
  }
  const wallSeconds = Math.round((Date.now() - started) / 1000);
  if (result.code !== 0) throw new Error(`planetiler exited ${result.code}${result.signal ? ` (${result.signal})` : ""}; see ${paths.log}`);
  const stats = parseBuildLog(result.output);
  if (!fs.existsSync(paths.archive)) throw new Error(`planetiler finished but ${paths.archive} does not exist`);
  fs.rmSync(paths.tmpdir, { recursive: true, force: true });
  return { command: [java.path, ...args], wallSeconds, stats };
}

/** What the archive says about itself must agree with what went in. */
export function crossCheckArchive({ archive, extract, version, profileText }) {
  const { header, metadata } = archive;
  const problems = [];
  if (header.tile_type !== "mvt") problems.push(`tile type ${header.tile_type}, expected mvt`);
  if (header.max_zoom !== MAX_ZOOM) problems.push(`max zoom ${header.max_zoom}, expected ${MAX_ZOOM}`);
  if (header.tile_compression !== "gzip") problems.push(`tile compression ${header.tile_compression}, expected gzip`);
  if (metadata["planetiler:version"] !== version) problems.push(`metadata planetiler:version ${metadata["planetiler:version"]}, expected ${version}`);
  if (metadata[REPLICATION_TIME_KEY] !== extract.state.timestamp) {
    problems.push(`metadata ${REPLICATION_TIME_KEY} ${metadata[REPLICATION_TIME_KEY]}, state.txt says ${extract.state.timestamp}`);
  }
  const seq = metadata["planetiler:osm:osmosisreplicationseq"];
  if (String(seq) !== String(extract.state.sequenceNumber)) {
    problems.push(`metadata planetiler:osm:osmosisreplicationseq ${seq}, state.txt says ${extract.state.sequenceNumber}`);
  }
  const archiveLayers = (metadata.vector_layers ?? []).map((layer) => layer.id).sort();
  const profileIds = profileLayers(profileText).map((layer) => layer.id).sort();
  if (JSON.stringify(archiveLayers) !== JSON.stringify(profileIds)) {
    problems.push(`archive layers [${archiveLayers.join(", ")}] are not the profile's [${profileIds.join(", ")}]`);
  }
  if (problems.length) throw new Error(`archive does not match its inputs:\n  ${problems.join("\n  ")}`);
}

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export async function pmtilesShow({ bin, override, archive }) {
  let cli = null;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`--pmtiles ${override} does not exist`);
    cli = path.resolve(override);
  } else if (fs.existsSync(path.join(bin, "pmtiles"))) {
    cli = path.join(bin, "pmtiles");
  } else {
    cli = findOnPath("pmtiles");
  }
  if (!cli) return null;
  const version = await run(cli, ["version"]);
  const show = await run(cli, ["show", archive]);
  if (show.code !== 0) throw new Error(`${cli} show exited ${show.code}:\n${show.output}`);
  return { cli, version: version.output.trim(), output: show.output.trimEnd() };
}

export function describeHeader(header) {
  const bounds = [header.min_lon_e7, header.min_lat_e7, header.max_lon_e7, header.max_lat_e7].map((e7) => (e7 / 1e7).toFixed(6));
  return `spec v${header.version} ${header.tile_type} z${header.min_zoom}-${header.max_zoom} bounds [${bounds.join(", ")}] ` +
    `tiles addressed/entries/contents ${header.addressed_tiles_count}/${header.tile_entries_count}/${header.tile_contents_count} ` +
    `compression internal=${header.internal_compression} tile=${header.tile_compression}`;
}

// ── argv, main ──────────────────────────────────────────────────────────────

function usage() {
  return `usage:
  node tools/osm-context/build.mjs --verify-only
  node tools/osm-context/build.mjs --region <name> [--offline] [--out <dir>] [--bin <dir>] [--cache <dir>]
        [--java <path>] [--xmx 24g] [--planetiler-jar <path>] [--pmtiles <path>] [--ocean-sha256 <hex>]
regions: ${Object.keys(loadRegions().regions).join(", ")}`;
}

export function parseArgs(argv) {
  const args = {
    out: path.join(HERE, "out"),
    bin: path.join(HERE, "bin"),
    cache: path.join(HERE, "cache"),
    xmx: "24g",
    offline: false,
    verifyOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--region") args.region = value();
    else if (flag === "--out") args.out = path.resolve(value());
    else if (flag === "--bin") args.bin = path.resolve(value());
    else if (flag === "--cache") args.cache = path.resolve(value());
    else if (flag === "--java") args.java = value();
    else if (flag === "--xmx") args.xmx = value();
    else if (flag === "--planetiler-jar") args.planetilerJar = value();
    else if (flag === "--pmtiles") args.pmtiles = value();
    else if (flag === "--ocean-sha256") args.oceanSha256 = value().toLowerCase();
    else if (flag === "--offline") args.offline = true;
    else if (flag === "--verify-only") args.verifyOnly = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (args.help) return args;
  if (!args.verifyOnly && !args.region) throw new Error("--region <name> is required (or --verify-only)");
  if (args.region !== undefined && !REGION_NAME.test(args.region)) throw new Error(`--region ${JSON.stringify(args.region)} must be lower-case words joined by hyphens`);
  if (!/^\d+[gGmM]$/.test(args.xmx)) throw new Error("--xmx must look like 24g");
  if (args.oceanSha256 !== undefined && !HEX_SHA256.test(args.oceanSha256)) throw new Error("--ocean-sha256 must be 64 hex characters");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const startedAt = nowIso();
  const started = Date.now();
  const regions = loadRegions();
  const profileText = fs.readFileSync(PROFILE, "utf8");

  const java = await findJava(args.java);
  console.log(`== java: ${java.version} (${java.path})`);
  const planetiler = await ensurePlanetiler({ bin: args.bin, jarOverride: args.planetilerJar, offline: args.offline });
  const version = await checkPlanetilerVersion({ java, jar: planetiler.jar });
  console.log(`== planetiler ${version}: ${planetiler.jar} (${planetiler.bytes} B, sha256 ${planetiler.sha256})`);
  const verify = await verifyProfile({ java, jar: planetiler.jar });
  console.log(`== verify profile: ${verify.passed}/${verify.expected} passed (planetiler exit ${verify.exitCode})`);
  if (args.verifyOnly) return;

  const spec = regions.regions[args.region];
  if (!spec) throw new Error(`unknown region ${args.region}; regions.json knows ${Object.keys(regions.regions).join(", ")}`);
  const ocean = await ensureOcean({ cache: args.cache, offline: args.offline, ocean: regions.ocean, pinOverride: args.oceanSha256 });
  console.log(`== ocean: ${ocean.path} (${ocean.bytes} B, sha256 ${ocean.sha256}, pin from ${ocean.pinSource}, files dated ${ocean.filesDated})`);
  const extract = await ensureExtract({ cache: args.cache, region: args.region, spec, offline: args.offline });
  console.log(`== extract: ${extract.pbf} (${extract.bytes} B, md5 ${extract.md5}) epoch ${extract.state.timestamp} seq ${extract.state.sequenceNumber} retrieved ${extract.retrievedAt} (${extract.retrievedAtSource})`);

  const paths = outputPaths({ out: args.out, region: args.region, epoch: extract.state.timestamp });
  console.log(`== build ${nowIso()} -> ${paths.archive}`);
  const built = await buildArchive({ java, jar: planetiler.jar, xmx: args.xmx, region: args.region, pbf: extract.pbf, ocean: ocean.path, paths });
  const { stats } = built;
  console.log(`== built in ${built.wallSeconds} s wall; planetiler overall ${stats.overall.wall} cpu:${stats.overall.cpu} avg:${stats.overall.avg}`);
  console.log(`   tiles ${stats.tiles.toLocaleString("en-US")}, features ${stats.features.toLocaleString("en-US")}, ` +
    `max tile ${stats.maxTile?.raw} (gzipped ${stats.maxTile?.gzipped}), avg tile ${stats.avgTile?.raw} (gzipped ${stats.avgTile?.gzipped})`);
  for (const [name, timing] of Object.entries(stats.phases)) if (timing) console.log(`   ${name.padEnd(9)} ${timing.wall} cpu:${timing.cpu}`);

  const archive = readPmtilesArchive(paths.archive);
  crossCheckArchive({ archive, extract, version, profileText });
  console.log(`== archive: ${archive.sizeBytes} B sha256 ${archive.sha256}`);
  console.log(`== header: ${describeHeader(archive.header)}`);
  console.log(`   ${REPLICATION_TIME_KEY} ${archive.metadata[REPLICATION_TIME_KEY]} (state.txt agrees)`);
  const show = await pmtilesShow({ bin: args.bin, override: args.pmtiles, archive: paths.archive });
  if (show) console.log(`== ${show.cli} show (${show.version}):\n${show.output}`);
  else console.log(`== pmtiles CLI not found (looked in ${args.bin} and PATH); header read natively above. go-pmtiles ${GO_PMTILES.version}: ${GO_PMTILES.releases}`);

  const processor = `planetiler ${version}`;
  const record = buildTilesetRecord({ ...archive, region: args.region, sourceUrl: spec.pbf, epoch: extract.state.timestamp, retrievedAt: extract.retrievedAt, processor });
  fs.writeFileSync(paths.record, formatRecord(record));
  const relative = (file) => path.relative(REPO, file);
  const report = {
    tool: "tools/osm-context/build.mjs",
    region: args.region,
    epoch: extract.state.timestamp,
    tileset_id: record.TILESET_ID,
    started_at: startedAt,
    finished_at: nowIso(),
    wall_seconds: Math.round((Date.now() - started) / 1000),
    java: { path: java.path, version: java.version },
    planetiler: { version, jar: planetiler.jar, bytes: planetiler.bytes, sha256: planetiler.sha256, url: PLANETILER.url, git_hash: PLANETILER.gitHash, downloaded: planetiler.downloaded },
    profile: { file: relative(PROFILE), sha256: createHash("sha256").update(profileText).digest("hex"), verify: { passed: verify.passed, expected: verify.expected, planetiler_exit_code: verify.exitCode } },
    inputs: {
      extract: {
        url: extract.sourceUrl, md5_url: extract.md5Url, state_url: extract.stateUrl, path: extract.pbf,
        bytes: extract.bytes, md5: extract.md5, retrieved_at: extract.retrievedAt, retrieved_at_source: extract.retrievedAtSource,
        downloaded_this_run: extract.downloaded, state: extract.state,
      },
      ocean: {
        url: ocean.url, path: ocean.path, bytes: ocean.bytes, sha256: ocean.sha256, pinned_sha256: ocean.pinnedSha256, pin_source: ocean.pinSource,
        files_dated: ocean.filesDated, last_modified: ocean.lastModified, retrieved_at: ocean.retrievedAt, retrieved_at_source: ocean.retrievedAtSource,
        downloaded_this_run: ocean.downloaded,
      },
    },
    build: { command: built.command, log: paths.log, wall_seconds: built.wallSeconds, planetiler: stats },
    archive: { path: paths.archive, bytes: archive.sizeBytes, sha256: archive.sha256, header: archive.header, metadata: archive.metadata },
    pmtiles_show: show ? { cli: show.cli, version: show.version, output: show.output } : null,
    record: paths.record,
  };
  fs.writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`== record: ${paths.record}\n== report: ${paths.report}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`build: ${error.message}\n`);
    process.exit(1);
  });
}
