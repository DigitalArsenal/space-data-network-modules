import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const REPO_ROOT = new URL("..", import.meta.url);
const AUDIT_PATH = new URL("../docs/sds-schema-audit.json", import.meta.url);

function runChecker(args = []) {
  return spawnSync(
    process.execPath,
    ["scripts/check-sds-schema-audit.mjs", ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
}

function writeMutatedAudit(mutate) {
  const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, "utf8"));
  mutate(audit);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-sds-schema-audit-"));
  const file = path.join(dir, "sds-schema-audit.json");
  fs.writeFileSync(file, `${JSON.stringify(audit, null, 2)}\n`);
  return file;
}

test("SDS schema audit covers every Orekit/Basilisk parity record domain", () => {
  const result = runChecker();
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`);
  }
  assert.match(result.stdout, /validated 12 SDS schema audit domain/);
});

test("SDS schema audit fails closed for missing required domains", () => {
  const file = writeMutatedAudit((audit) => {
    audit.domains = audit.domains.filter((domain) => domain.id !== "thermal");
  });
  const result = runChecker(["--audit", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required domain thermal/i);
});

test("SDS schema audit fails closed for nonexistent schema references", () => {
  const file = writeMutatedAudit((audit) => {
    audit.domains[0].existingSchemas[0].schema = "ZZZ";
  });
  const result = runChecker(["--audit", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schema ZZZ does not exist/i);
});

test("SDS schema audit fails closed when partial domains omit gaps", () => {
  const file = writeMutatedAudit((audit) => {
    const domain = audit.domains.find((entry) => entry.id === "frames");
    domain.status = "partial";
    domain.gaps = [];
  });
  const result = runChecker(["--audit", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /partial domain frames must list gaps/i);
});
