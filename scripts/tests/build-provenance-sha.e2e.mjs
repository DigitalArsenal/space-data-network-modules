#!/usr/bin/env node
// E2E (modules-build-provenance-wasm-sha-check-20261106): scripts/check-artifact-ledger.mjs compares every module's build-provenance
// hash and every ledger entry's wasmSha256 with the sha256 of the dist's MODULE SECTION (the bytes before the publication trailer),
// and names the module when either disagrees.
//
// A scratch git repository holds one current module's dist (copied by reference), its build-provenance.json, a one-entry ledger
// and a one-row module index. The check passes on it; then a planted build-provenance wasmSha256 is refused naming the module; then
// a planted ledger wasmSha256 is refused naming the module; a byte appended to the dist (a trailer that is not one) is refused too.
//   node scripts/tests/build-provenance-sha.e2e.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, canonicalModuleBytes, currentDists, moduleSectionBytes, sha256Hex } from "../check-module-signatures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
assert.equal(path.resolve(here, "../.."), REPO_ROOT);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const check = path.join(REPO_ROOT, "scripts", "check-artifact-ledger.mjs");

// a current module with a build-provenance.json that names a wasmSha256
const index = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs", "current-module-parity-index.json"), "utf8"));
const subject = currentDists().find((d) => {
  const file = path.join(REPO_ROOT, d.modulePath, "dist", "build-provenance.json");
  return fs.existsSync(path.join(REPO_ROOT, d.rel)) && fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).wasmSha256;
});
assert.ok(subject, "no current module ships a build-provenance.json with wasmSha256");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "build-provenance-sha-"));
const put = (rel, content) => { fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true }); fs.writeFileSync(path.join(scratch, rel), content); };
const run = () => spawnSync(process.execPath, [check, "--root", scratch], { encoding: "utf8", env });
const refused = (result, what, needle) => {
  assert.equal(result.status, 1, `${what} was not refused (exit ${result.status}): ${result.stdout}${result.stderr}`);
  const lines = result.stderr.split("\n").filter((line) => line.startsWith("  - "));
  assert.ok(lines.length >= 1, `${what}: no disagreement line`);
  for (const line of lines) assert.ok(line.startsWith(`  - ${subject.modulePath}/`), `${what}: a line does not name ${subject.modulePath}: ${line}`);
  assert.ok(lines.some((line) => line.includes(needle)), `${what}: no line says "${needle}": ${lines.join(" | ")}`);
  return lines.length;
};

try {
  const distBytes = fs.readFileSync(path.join(REPO_ROOT, subject.rel));
  const section = sha256Hex(moduleSectionBytes(distBytes));
  const provenanceRel = `${subject.modulePath}/dist/build-provenance.json`;
  const provenance = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, provenanceRel), "utf8"));
  const claimed = provenance.signed ? provenance.canonicalWasmSha256 : provenance.wasmSha256;
  assert.equal(claimed, section, `${subject.modulePath}: this checkout's build-provenance disagrees with its dist; run the plain check first`);

  fs.mkdirSync(path.dirname(path.join(scratch, subject.rel)), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, subject.rel), path.join(scratch, subject.rel), fs.constants.COPYFILE_FICLONE);
  put(provenanceRel, `${JSON.stringify(provenance, null, 2)}\n`);
  const row = index.modules.find((m) => m.modulePath === subject.modulePath);
  put("docs/current-module-parity-index.json", JSON.stringify({ modules: [row] }));
  const ledgerEntry = { sha256: sha256Hex(distBytes), bytes: distBytes.length, wasmSha256: section, canonicalModuleSha256: sha256Hex(canonicalModuleBytes(distBytes)), module: subject.modulePath };
  const ledger = (entry) => JSON.stringify({ version: 1, artifacts: { [subject.rel]: entry } });
  put("scripts/artifact-provenance.json", ledger(ledgerEntry));
  put("scripts/trusted-publishers.json", fs.readFileSync(path.join(REPO_ROOT, "scripts", "trusted-publishers.json")));
  execFileSync("git", ["-C", scratch, "init", "-q"], { env });
  execFileSync("git", ["-C", scratch, "add", "-A"], { env });

  const clean = run();
  assert.equal(clean.status, 0, `the clean scratch tree was refused: ${clean.stdout}${clean.stderr}`);
  assert.ok(clean.stdout.startsWith("PASS artifact ledger: "), `no PASS line: ${clean.stdout}`);
  assert.ok(clean.stdout.includes("1 build-provenance files agree with the module section"), `the build-provenance file was not counted: ${clean.stdout}`);

  const wrong = "0".repeat(63) + "1";
  const planted = { ...provenance, ...(provenance.signed ? { canonicalWasmSha256: wrong } : { wasmSha256: wrong }) };
  put(provenanceRel, `${JSON.stringify(planted, null, 2)}\n`);
  const provenanceLines = refused(run(), "a planted build-provenance hash", "build-provenance says");
  put(provenanceRel, `${JSON.stringify(provenance, null, 2)}\n`);

  put("scripts/artifact-provenance.json", ledger({ ...ledgerEntry, wasmSha256: wrong }));
  const ledgerLines = refused(run(), "a planted ledger wasmSha256", "ledger wasmSha256");
  put("scripts/artifact-provenance.json", ledger(ledgerEntry));

  fs.appendFileSync(path.join(scratch, subject.rel), Buffer.from([0]));
  const appendedLines = refused(run(), "one byte appended to the dist", "dist is");

  console.log(
    `BUILD-PROVENANCE-SHA E2E PASS: ${subject.modulePath} module section ${section.slice(0, 12)} equals its build-provenance and ledger wasmSha256 ` +
      `(clean scratch tree passes); a planted build-provenance hash is refused naming the module (${provenanceLines} line(s)); a planted ledger ` +
      `wasmSha256 is refused (${ledgerLines}); one appended byte is refused (${appendedLines})`,
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
