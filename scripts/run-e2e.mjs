#!/usr/bin/env node
// Runs E2E files, one node process each, from the directory of the module that holds the file (the nearest package.json),
// in the order given; prints each file's last output line and its verdict; exits 1 when any file fails.
//
//   node scripts/run-e2e.mjs <file.e2e.mjs> [...]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/run-e2e.mjs <file.e2e.mjs> [...]");
  process.exit(2);
}

function moduleDir(file) {
  for (let dir = path.dirname(file); dir.startsWith(repo) && dir !== repo; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
  }
  return repo;
}

let failed = 0;
for (const name of files) {
  const file = path.resolve(repo, name);
  if (!fs.existsSync(file)) {
    console.log(`FAIL ${name}: no such file`);
    failed++;
    continue;
  }
  const cwd = moduleDir(file);
  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const last = (r.stdout || "").trim().split("\n").pop();
  if (r.status === 0) {
    console.log(`PASS ${name} (${seconds} s): ${last}`);
  } else {
    failed++;
    console.log(`FAIL ${name} (${seconds} s, exit ${r.status ?? r.signal})`);
    process.stdout.write(r.stdout || "");
    process.stdout.write(r.stderr || "");
  }
}
console.log(`E2E: ${files.length - failed} of ${files.length} passed`);
process.exit(failed ? 1 : 0);
