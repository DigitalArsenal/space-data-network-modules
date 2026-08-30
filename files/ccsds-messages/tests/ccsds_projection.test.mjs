// ccsds_projection.test.mjs — compiles and runs the native `$AEM` / `$TDM`
// projection harness, then cross-checks the JSON it emits against the IDL.
//
// WHERE THE FLATBUFFERS C++ RUNTIME COMES FROM
//
// From `flatc-wasm`, this package's pinned devDependency, whose embedded C++
// tree is written to a temp directory for the length of the compile and deleted
// with it. That is the same source the module SDK's own compiler uses
// (space-data-module-sdk/src/compiler/flatcSupport.js), so the headers this
// harness measures against are byte-for-byte the ones the WASM artifact will be
// built with. It is NOT a sibling `flatbuffers` checkout: a repo path does not
// resolve from a task worktree and would break the published-deps law (owner
// 2026-08-21). Nothing is written into the repo — not the runtime, not the
// binary.
//
// THE JSON KEY CHECK
//
// The harness prints one `JSON <id> <TYPE> <object>` line per fixture. Every key
// in those objects was produced in C++ by stringizing the identifier the field
// access compiles against, so no key was ever typed by hand. This wrapper closes
// the loop at the other end: it parses
// node_modules/spacedatastandards.org/schema/{AEM,TDM}/main.fbs and requires the
// emitted key set of each table to be exactly that table's IDL field set,
// case-exact. A schema rename fails the suite instead of drifting silently.
// Same shape as foundation/omm-json's own drift guard.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const sourcePath = path.join(here, "ccsds_projection_native.cpp");
const includePath = path.join(packageRoot, "src");
const fixturePath = path.join(packageRoot, "fixtures");
const schemaRoot = path.join(packageRoot, "node_modules", "spacedatastandards.org", "schema");
const generatedPath = path.join(includePath, "generated", "sds");

function findCompiler() {
  for (const candidate of ["clang++", "c++"]) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) {
      return candidate;
    }
  }
  return null;
}

async function materialiseFlatbuffersRuntime(root) {
  const runner = await FlatcRunner.init();
  const files = runner.getEmbeddedRuntime("cpp");
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return Object.keys(files).length;
}

// Field identifiers per table, straight out of the IDL. Deliberately not a
// hand-written list: the point of the check is that nobody maintains one.
function idlTables(family) {
  const idl = readFileSync(path.join(schemaRoot, family, "main.fbs"), "utf8");
  const tables = new Map();
  for (const match of idl.matchAll(/table\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\n\}/g)) {
    const fields = [...match[2].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
    tables.set(match[1], new Set(fields));
  }
  return tables;
}

// Which IDL table each emitted object belongs to. The KEYS come from the IDL;
// only this nesting does not, and it is four edges.
const NESTING = {
  AEM: { SEGMENTS: "AEMSegment" },
  AEMSegment: { ATTITUDE_DATA_LINES: "attitudeDataLine" },
  TDM: { SEGMENTS: "TDMSegment", OBSERVATIONS: "TDMObservation", TRANSMIT_RAMPS: "TDMTransmitRamp" },
  TDMSegment: { OBSERVATIONS: "TDMObservation", TRANSMIT_RAMPS: "TDMTransmitRamp" },
};

// $RFM union tables have no JSON-trivial form and this projection never
// populates them — a CCSDS TDM states its frame in the REFERENCE_FRAME keyword,
// carried as the string the file wrote. Same treatment foundation/omm-json gives
// the same union.
const OMITTED = new Set(["OBSERVER_POSITION_REFERENCE_FRAME", "OBS_REFERENCE_FRAME"]);

function checkObject(object, tableName, tables, seen) {
  const fields = tables.get(tableName);
  assert.ok(fields, `IDL has no table ${tableName}`);
  seen.add(tableName);
  for (const key of Object.keys(object)) {
    assert.ok(
      fields.has(key),
      `emitted key ${JSON.stringify(key)} is not a ${tableName} field name (case-exact)`,
    );
    assert.ok(
      !/[a-z]/.test(key) || fields.has(key),
      `emitted key ${JSON.stringify(key)} is not schema-cased`,
    );
  }
  for (const field of fields) {
    if (OMITTED.has(field)) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(object, field),
      `${tableName} field ${field} is missing from the emitted JSON`,
    );
  }
  const children = NESTING[tableName] ?? {};
  for (const [key, childTable] of Object.entries(children)) {
    for (const child of object[key] ?? []) {
      if (child) checkObject(child, childTable, tables, seen);
    }
  }
}

test("the $AEM/$TDM projection round-trips the published Blue Book examples", async (t) => {
  const compiler = findCompiler();
  if (!compiler) {
    t.skip("no host c++ compiler; the native CCSDS projection harness cannot be built");
    return;
  }
  // The generated headers are a build product of generate-sds-headers.mjs and
  // are committed; without them there is nothing to measure and a silent skip
  // would look identical to a pass.
  for (const family of ["AEM", "TDM", "RFM"]) {
    assert.ok(
      existsSync(path.join(generatedPath, `${family}_generated.h`)),
      `src/generated/sds/${family}_generated.h is missing; run generate-sds-headers.mjs`,
    );
  }
  assert.equal(
    readdirSync(fixturePath).filter((name) => name.endsWith(".txt")).length,
    5,
    "expected the five published fixture messages",
  );

  const workDir = mkdtempSync(path.join(tmpdir(), "sdn-ccsds-projection-"));
  const runtimeDir = path.join(workDir, "flatbuffers-runtime");
  const binaryPath = path.join(workDir, "ccsds_projection_native");
  let run;
  try {
    const headerCount = await materialiseFlatbuffersRuntime(runtimeDir);
    assert.ok(headerCount > 10, `flatc-wasm supplied only ${headerCount} C++ runtime headers`);
    execFileSync(
      compiler,
      [
        "-std=c++17",
        "-O2",
        "-I", includePath,
        "-I", here,
        "-I", runtimeDir,
        sourcePath,
        "-o", binaryPath,
      ],
      { stdio: "pipe" },
    );
    run = spawnSync(binaryPath, [fixturePath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const stdout = run.stdout ?? "";
  // Only the RESULT lines and the tally: the JSON lines are the key check's
  // input, not a report, and one of them is 7 KB.
  const results = stdout.split("\n").filter((line) => line.startsWith("RESULT "));
  const tally = stdout.split("\n").filter((line) => /^\d+ checks, \d+ failures$/.test(line));
  if (results.length) {
    console.log([...results, "", ...tally].join("\n"));
  }
  if (run.stderr) {
    console.error(run.stderr);
  }
  assert.equal(run.error, undefined, `projection harness failed to run: ${run.error?.message}`);

  const failed = results.filter((line) => line.trimEnd().endsWith("FAIL"));
  // A harness that printed nothing would otherwise satisfy "no FAIL lines".
  assert.ok(results.length >= 100, `only ${results.length} RESULT lines were reported`);
  assert.equal(failed.length, 0, `checks missed their bound:\n${failed.join("\n")}`);
  assert.match(stdout, /\n\d+ checks, 0 failures\n/, "the harness did not report zero failures");
  assert.equal(run.status, 0, "the CCSDS projection harness exited non-zero");

  // ---- JSON keys, cross-checked against the IDL itself ----
  const tables = new Map([...idlTables("AEM"), ...idlTables("TDM")]);
  assert.ok(
    tables.get("AEM")?.has("CCSDS_AEM_VERS") && tables.get("TDM")?.has("OBSERVATIONS"),
    "IDL field extraction failed to find canonical $AEM/$TDM fields",
  );

  const emitted = stdout
    .split("\n")
    .filter((line) => line.startsWith("JSON "))
    .map((line) => {
      const [, id, type, ...rest] = line.split(" ");
      return { id, type, object: JSON.parse(rest.join(" ")) };
    });
  assert.ok(emitted.length >= 6, `only ${emitted.length} JSON records were emitted`);

  const seen = new Set();
  for (const record of emitted) {
    checkObject(record.object, record.type, tables, seen);
  }
  // Vacuity guard: a nested table nobody emitted proves nothing about its keys.
  for (const table of ["AEM", "AEMSegment", "attitudeDataLine", "TDM", "TDMSegment",
                       "TDMObservation", "TDMTransmitRamp"]) {
    assert.ok(seen.has(table), `no ${table} object was emitted, so its keys were never checked`);
  }
});
