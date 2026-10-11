// ndm_xsd.test.mjs — what the module writes is NDM/XML that an independent validator accepts.
//
// libxml2's xmllint validates against the NDM/XML 4.0.0 schemas that CCSDS publishes at
// https://sanaregistry.org/r/ndmxml_unqualified/. They are not redistributed here (the
// repository keeps data it has no licence for outside the tree; tests/lib/privateFixtures.mjs),
// so the test reads them from
//
//   $SDN_MODULES_PRIVATE_FIXTURES/files/ccsds-messages/fixtures/xsd/ndmxml-4.0.0-*.xsd
//
// and skips, saying so, when they are not there or xmllint is not installed.
//
// What is validated: every NDM/XML twin in fixtures/ (what the module wrote), and the
// XML the module writes now, from the KVN fixtures and from records of shapes no fixture
// has: a record with several states in the OCM's single-trajectory fields, a CDM whose
// numbers do not survive multiplication.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { privatePath, privateSkip } from "../../../tests/lib/privateFixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "fixtures");
const MASTER = "files/ccsds-messages/fixtures/xsd/ndmxml-4.0.0-master-4.0.xsd";

const hasXmllint = spawnSync("xmllint", ["--version"], { stdio: "ignore" }).status === 0;
const skip = (!hasXmllint && "xmllint is not installed") || privateSkip(MASTER);

function validate(xmlPath) {
  const r = spawnSync("xmllint", ["--noout", "--schema", privatePath(MASTER), xmlPath], { encoding: "utf8" });
  return { ok: r.status === 0, report: `${r.stdout}${r.stderr}`.trim() };
}

function twins() {
  const found = [];
  for (const dir of [fixtures, path.join(fixtures, "ndm")]) {
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".xml")) found.push(path.join(dir, f));
  }
  return found.sort();
}

for (const file of twins()) {
  test(`${path.relative(fixtures, file)} validates against the NDM/XML 4.0.0 schemas`, { skip: skip || undefined }, () => {
    const result = validate(file);
    assert.ok(result.ok, result.report);
  });
}

test("the committed twins cover every message the module writes", () => {
  const types = new Set(twins().map((f) => fs.readFileSync(f, "utf8").match(/<(\w+) [^>]*id="CCSDS_(\w+)_VERS"/)?.[2]));
  assert.deepEqual([...types].sort(), ["ACM", "AEM", "APM", "CDM", "OCM", "OEM", "OMM", "OPM", "RDM", "TDM"]);
});

test("XML written from records of other shapes validates too", { skip: skip || undefined }, async () => {
  // The module is exercised in ndm_module.test.mjs; here its writer feeds the validator.
  const dir = mkdtempSync(path.join(tmpdir(), "ndm-xsd-"));
  try {
    const { writeShapes } = await import("./lib/ndm_shapes.mjs");
    for (const [name, xml] of await writeShapes()) {
      const file = path.join(dir, `${name}.xml`);
      writeFileSync(file, xml);
      const result = validate(file);
      assert.ok(result.ok, `${name}: ${result.report}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
