#!/usr/bin/env node
// E2E, task modules-artifact-ledger-check-landed-list-20261104 (after modules-artifact-ledger-refresh-20261104):
// the ledger files describe the committed dists exactly, and this script names no module, version or hash.
//   1. every ledger entry names a committed dist whose sha256 and byte count equal the entry's;
//   2. every committed dist wasm has an entry (so every module with a dist has one);
//   3. a dist that carries a build-provenance file agrees with it (sha256 of the wasm it describes);
//   4. a dist plugin manifest at <module>/dist, where docs/current-module-parity-index.json lists the module, has the version
//      the index records (a landing regenerates the index with the ledger, so a bumped manifest the index does not follow disagrees).
//   node scripts/check-artifact-ledger.mjs               the four checks on this checkout (the gauntlet runs this on a dist diff)
//   node scripts/check-artifact-ledger.mjs --self-test   this script, run on a temporary copy of the tracked tree (never in this checkout):
//                                                        it passes on the clean copy, and fails naming the module when one byte is
//                                                        appended to a committed dist, and when a dist manifest's version is bumped
//                                                        with the module index unchanged
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trackedFiles } from "./lib/current-module-index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (base, ...parts) => JSON.parse(fs.readFileSync(path.join(base, ...parts), "utf8"));

// The plugin manifest of a committed dist wasm: the nearest plugin-manifest.json from the wasm's directory up to its dist directory (null when the dist commits none).
function manifestBeside(rel, tracked) {
  for (let dir = path.posix.dirname(rel); ; dir = path.posix.dirname(dir)) {
    const manifest = path.posix.join(dir, "plugin-manifest.json");
    if (tracked.has(manifest)) return manifest;
    if (path.posix.basename(dir) === "dist") return null;
  }
}

// What the tree at `base` says about its dists: the disagreements and the counts the report prints.
function measure(base) {
  const ledger = readJson(base, "scripts", "artifact-provenance.json").artifacts;
  const tracked = new Set(trackedFiles(base));
  const committed = [...tracked].filter((f) => f.endsWith(".wasm") && f.includes("/dist/"));

  const problems = [];
  let matched = 0;
  for (const [rel, entry] of Object.entries(ledger)) {
    if (!committed.includes(rel)) { problems.push(`${rel}: ledger entry names no committed dist`); continue; }
    const bytes = fs.readFileSync(path.join(base, rel));
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) problems.push(`${rel}: dist is ${sha256(bytes)} (${bytes.length} B), ledger ${entry.sha256} (${entry.bytes} B)`);
    else matched++;
  }
  const missing = committed.filter((rel) => !(rel in ledger));
  for (const rel of missing) problems.push(`${rel}: committed dist with no ledger entry`);

  // a dist's own build-provenance file describes its isomorphic module.wasm
  let provenanceFiles = 0;
  for (const rel of committed.filter((f) => f.endsWith("/dist/isomorphic/module.wasm"))) {
    const dist = path.dirname(path.dirname(path.join(base, rel)));
    const json = path.join(dist, "build-provenance.json");
    const txt = path.join(dist, "build-provenance.txt");
    const bytes = fs.readFileSync(path.join(base, rel));
    const claimed = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, "utf8")).sha256
      : fs.existsSync(txt) ? fs.readFileSync(txt, "utf8").match(/^sha256 (\S+)$/m)?.[1] : null;
    if (claimed == null) continue;
    provenanceFiles++;
    if (claimed !== sha256(bytes)) problems.push(`${rel}: build-provenance says ${claimed}, dist is ${sha256(bytes)}`);
  }

  // a dist manifest's version is the one the module index records for its module; only a manifest directly at <module>/dist,
  // for a module the index lists, has a recorded version (a flow's baked node or a nested build directory has none)
  const indexed = new Map(readJson(base, "docs", "current-module-parity-index.json").modules.map((row) => [row.modulePath, row.version]));
  const versions = [];
  let unrecorded = 0;
  for (const manifest of [...new Set(committed.map((rel) => manifestBeside(rel, tracked)))].filter(Boolean).sort()) {
    const distDir = path.posix.dirname(manifest);
    const moduleDir = path.posix.dirname(distDir);
    if (path.posix.basename(distDir) !== "dist" || !indexed.has(moduleDir)) { unrecorded++; continue; }
    const version = readJson(base, manifest).version;
    if (version !== indexed.get(moduleDir)) problems.push(`${moduleDir}: dist manifest is ${version}, the module index records ${indexed.get(moduleDir)}`);
    else versions.push({ moduleDir, manifest, version });
  }

  return { problems, ledgerKeys: Object.keys(ledger), matched, committed: committed.length, provenanceFiles, versions, unrecorded };
}

// The self-test runs this script itself, as the gauntlet runs it, in a copy of the tracked tree registered as a git repository (the way
// scripts/check-current-module-index.mjs plants its leftovers), so the proof is of the exit status and the report and not of a helper.
// A git environment a calling hook selected must not redirect the copy's repository, so every git call and the child run without it.
function selfTest() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const base = measure(root);
  assert.deepEqual(base.problems, [], "this checkout disagrees with its ledger: run the plain check first");
  assert.ok(base.versions.some((recorded) => typeof recorded.version === "string"), "no dist manifest has a recorded version to bump");
  const files = trackedFiles(root);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-ledger-"));
  const run = () => spawnSync(process.execPath, [path.join(copy, "scripts", "check-artifact-ledger.mjs")], { encoding: "utf8", env });
  const moduleOf = (rel) => rel.slice(0, rel.indexOf("/dist/"));
  // a refusal names the module on every disagreement line, and nothing else
  const refusal = (result, what, moduleDir) => {
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("  - "));
    assert.equal(result.status, 1, `${what} was not refused (exit ${result.status}): ${result.stdout}${result.stderr}`);
    assert.ok(lines.length > 0, `${what}: no disagreement line in ${result.stderr}`);
    for (const line of lines) assert.ok(line.startsWith(`  - ${moduleDir}/`) || line.startsWith(`  - ${moduleDir}:`), `${what}: a disagreement line does not name ${moduleDir}: ${line}`);
    return lines.length;
  };
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(copy, file), fs.constants.COPYFILE_FICLONE);
    }
    execFileSync("git", ["-C", copy, "init", "-q"], { env });
    execFileSync("git", ["-C", copy, "update-index", "--add", "--info-only", "-z", "--stdin"], { input: `${files.join("\0")}\0`, maxBuffer: 1 << 28, env });

    const clean = run();
    assert.equal(clean.status, 0, `the clean copy was refused (exit ${clean.status}): ${clean.stdout}${clean.stderr}`);
    assert.ok(clean.stdout.startsWith("PASS artifact ledger: "), `the clean copy's report is not a PASS line: ${clean.stdout}`);

    const dist = base.ledgerKeys[0];
    const distFile = path.join(copy, dist);
    const size = fs.statSync(distFile).size;
    fs.appendFileSync(distFile, Buffer.from([0]));
    const appended = refusal(run(), `one byte appended to ${dist}`, moduleOf(dist));
    fs.truncateSync(distFile, size);

    const { moduleDir, manifest, version } = base.versions.filter((recorded) => typeof recorded.version === "string").at(-1);
    const manifestFile = path.join(copy, manifest);
    const original = fs.readFileSync(manifestFile, "utf8");
    const bumped = `${version}-selftest`;
    const literal = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const edited = original.replace(new RegExp(`("version"\\s*:\\s*)"${literal}"`), (_, head) => `${head}"${bumped}"`);
    assert.equal(JSON.parse(edited).version, bumped, `${manifest}: the text edit did not reach the manifest's own version`);
    fs.writeFileSync(manifestFile, edited);
    const bumpedLines = refusal(run(), `${manifest} bumped to ${bumped}`, moduleDir);
    assert.equal(bumpedLines, 1, `${manifest} bumped to ${bumped}: expected the module index disagreement alone`);

    const disagreements = (count) => `${count} disagreement${count === 1 ? "" : "s"}`;
    return `PASS artifact ledger: self-test on a copy of ${files.length} tracked files: the clean copy passes; one byte appended to ${dist} is refused naming ${moduleOf(dist)} (${disagreements(appended)}); ${manifest} bumped ${version} to ${bumped} with the module index unchanged is refused naming ${moduleDir} (${disagreements(bumpedLines)})`;
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) {
  console.log(selfTest());
} else {
  const result = measure(root);
  if (result.problems.length) { console.error(`FAIL artifact ledger: ${result.problems.length} disagreements\n${result.problems.map((p) => `  - ${p}`).join("\n")}`); process.exit(1); }
  console.log(`PASS artifact ledger: ${result.matched}/${result.ledgerKeys.length} entries equal their dist sha256, ${result.committed} committed dists all ledgered, ${result.provenanceFiles} build-provenance files agree, ${result.versions.length} dist manifest versions equal the module index (${result.unrecorded} dist manifests have no module row)`);
}
