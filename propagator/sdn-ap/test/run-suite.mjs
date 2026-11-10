#!/usr/bin/env node
// Every E2E of this package (test/*.e2e.mjs) in parallel, each to its own log under the test scratch root
// (test/lib/scratch.mjs), then a table of exit code, time and result per test. Exit 0 only when every test passes,
// apart from those test/known-defects.json lists: a listed test that fails is reported as "KNOWN DEFECT <issue>, still
// failing" and does not fail the suite; a listed test that passes fails it (remove it from the list); an entry naming
// no test fails it. The site's release notes print the same file, so the page and the suite name the same defects.
// The longest tests of the previous run start first (their times are kept in the scratch root).
//   node test/run-suite.mjs [--jobs N] [test ...]
// --jobs N: at most N tests at once (default 14). test ...: only these (names without .e2e.mjs).
// The E2Es need what they need alone: SDN_AP_ORACLE_ROOT for conformance.e2e.mjs, the model truth's FFM build. A
// preflight checks the installs and the oracle before any test starts (exit 2 when one is missing).
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRoot, scratchDir } from "./lib/scratch.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(testDir);
const args = process.argv.slice(2);
let jobs = 14;
const only = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--jobs") jobs = Number(args[++i]);
  else only.push(args[i].replace(/\.e2e\.mjs$/, ""));
}
if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs needs a whole number of at least 1`);

const all = fs.readdirSync(testDir).filter((f) => f.endsWith(".e2e.mjs")).map((f) => f.slice(0, -".e2e.mjs".length)).sort();
for (const t of only) if (!all.includes(t)) throw new Error(`no test/${t}.e2e.mjs`);
const tests = only.length ? only : all;

// Preflight, before any test starts: every install the tests' hosts load, resolved the way the hosts resolve it
// (createRequire(<folder>/package.json).resolve(<entry>), so a package the repository root's node_modules supplies
// counts). A missing one stops the run in a second, one line each with its fix. A test that loads another folder's
// install adds it here.
const repoRoot = path.resolve(packageRoot, "../..");
const INSTALLS = [
  ["propagator/sdn-ap", "space-data-module-sdk/testing/isomorphic", "every test's module host"],
  ["propagator/sgp4", "space-data-module-sdk/host/browser-module", "the archive replays' SGP4 host (test/vendor/.../xp-atmosphere-merit/lib/modules.mjs)"],
  ["analysis/gp-error-model", "space-data-module-sdk/host/browser-module", "the archive replays' scorer and density-calibration hosts"],
  ["foundation/frames", "space-data-module-sdk/host/browser-module", "the archive replays' frames host"],
  ["propagator/ffm", "flatbuffers", "the model truth's codec (propagator/ffm/tests/lib/prwCodec.mjs)"],
];
const missing = [];
for (const [rel, entry, who] of INSTALLS) {
  const dir = path.join(repoRoot, rel);
  try { createRequire(path.join(dir, "package.json")).resolve(entry); }
  catch { missing.push(`missing install: ${rel} cannot resolve ${entry} (${who}); fix: npm ci --prefix ${dir}`); }
}
if (tests.includes("conformance") && !process.env.SDN_AP_ORACLE_ROOT)
  missing.push("missing oracle: conformance.e2e.mjs needs SDN_AP_ORACLE_ROOT, the SGP4-XP oracle's harness directory");
if (missing.length) {
  for (const line of missing) console.log(line);
  console.log(`preflight: ${missing.length} missing; no test started`);
  process.exit(2);
}

const defects = JSON.parse(fs.readFileSync(path.join(testDir, "known-defects.json"), "utf8"));
const known = new Map(defects.map((d) => [d.test, d]));
const strays = defects.filter((d) => !all.includes(d.test));

const timesFile = path.join(scratchRoot, "run-suite-times.json");
let previous = {};
try { previous = JSON.parse(fs.readFileSync(timesFile, "utf8")); } catch {}
// unknown tests first, then the longest
const order = [...tests].sort((a, b) => (previous[b] ?? Infinity) - (previous[a] ?? Infinity) || a.localeCompare(b));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logs = scratchDir(`run-suite-${stamp}`);
console.log(`${tests.length} tests, ${jobs} at a time; logs in ${logs}`);

const children = new Set();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const c of children) c.kill(sig); process.exit(130); });

const results = new Map();
const started = Date.now();
function run(name) {
  return new Promise((resolve) => {
    const log = fs.openSync(path.join(logs, `${name}.log`), "w");
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(testDir, `${name}.e2e.mjs`)], { cwd: packageRoot, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    children.add(child);
    child.on("close", (code, signal) => {
      children.delete(child);
      const r = { code, signal, seconds: Math.round((Date.now() - t0) / 1000) };
      results.set(name, r);
      console.log(`${name}: ${code === 0 ? "pass" : `exit ${code ?? signal}`} in ${r.seconds} s`);
      resolve();
    });
  });
}
const queue = [...order];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) await run(queue.shift());
}));
const wall = Math.round((Date.now() - started) / 1000);

try {
  for (const [name, r] of results) previous[name] = r.seconds;
  fs.writeFileSync(timesFile, JSON.stringify(previous, null, 1));
} catch {}

let failed = 0, stillFailing = 0, passed = 0;
const rows = tests.map((name) => {
  const r = results.get(name), ok = r.code === 0, d = known.get(name);
  let result;
  if (d && !ok) { result = `KNOWN DEFECT ${d.issue}, still failing`; stillFailing++; }
  else if (d && ok) { result = `FAIL: listed as a known defect (${d.issue}) but passes: remove it from test/known-defects.json`; failed++; }
  else if (ok) { result = "PASS"; passed++; }
  else { result = "FAIL"; failed++; }
  return [name, r.code ?? r.signal, `${r.seconds} s`, result];
});
for (const d of strays) { rows.push([d.test, "-", "-", `FAIL: test/known-defects.json names no test ${d.test}.e2e.mjs`]); failed++; }
const width = [0, 1, 2].map((j) => Math.max(...rows.map((row) => String(row[j]).length), ["test", "exit", "time"][j].length));
console.log("");
console.log(["test".padEnd(width[0]), "exit".padStart(width[1]), "time".padStart(width[2]), "result"].join("  "));
for (const row of rows) console.log([row[0].padEnd(width[0]), String(row[1]).padStart(width[1]), row[2].padStart(width[2]), row[3]].join("  "));
console.log(`\n${tests.length} tests: ${passed} passed, ${stillFailing} known defects still failing, ${failed} failed; wall ${wall} s; logs in ${logs}`);
for (const name of tests) if (results.get(name).code !== 0 && !known.has(name)) console.log(`  ${name}: ${path.join(logs, `${name}.log`)}`);
process.exit(failed ? 1 : 0);
