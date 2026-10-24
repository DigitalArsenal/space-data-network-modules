// The interchange E2E: Sentinel EOF orbit files to $OEM, NAIF CK type 3 to and from $AEM, RINEX observations to $GNO.
//
//   node files/rinex/tests/interchange.e2e.mjs        (from the modules checkout, or from anywhere)
//
// What it holds the modules to, each against an authority that is not the module:
//
//   Sentinel EOF   the states of three real ESA files (Sentinel-1A AUX_POEORB twice, AUX_RESORB once) equal, to the bit,
//                  what Python's xml.etree reads from the same bytes; adjacent-day precise orbits agree on their
//                  two-hour overlap; the restituted orbit lies within its accuracy of the precise one.
//   NAIF CK        30 records of NAIF-published MSL and InSight kernels read to the bit CSPICE's raw read gives; time
//                  agrees with NAIF's formula exactly; q2m's C-matrix equals CCSDS 504.0-B-2 annex F's matrix of the
//                  CCSDS quaternion to 3.3e-16. A kernel this module writes is read back by CSPICE (spiceypy) to 1e-12
//                  rad and by the module.
//   RINEX          every observation of an IGS station file (RINEX 3.05, six constellations) equals georinex's, value
//                  and indicators, to the bit. Navigation is refused by name (SDS has no broadcast-ephemeris record).
//   Options        every request option (window, satellite systems, segments, the spacecraft clock) is a field of
//                  an $NCD or of the record; the tests build them with the SDS FlatBuffers, never a JSON options file.
//   Parity         the committed tri-runtime records (browser and native WasmEdge; the Docker leg is waived by the
//                  owner) are for the artifacts in dist/ now. INTERCHANGE_PARITY=run reruns them (the browser leg is
//                  headless Chrome: run it under /Users/tj/software/terrain-work/lanes/headless-run).
//
// The suites are the packages' own test files; this runs them as separate processes, prints the numbers they measured
// and refuses to pass if any suite failed, any parity record is stale, or any measurement line is missing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const filesRoot = path.resolve(here, "..", "..");
const SUITES = [
  { pkg: "orbit-products", tests: ["tests/sentinel_eof.test.mjs", "tests/naif_ck.test.mjs"],
    measured: [/S1A POEORB adjacent days/, /RESORB .* against POEORB/, /NAIF-published CK records read/, /module round trip/, /CSPICE .* read \d+ records/] },
  { pkg: "rinex", tests: ["tests/rinex_obs.test.mjs"], measured: [/observations in \d+ epochs.*identical to georinex/] },
];

let failed = false;
const report = (line) => console.log(line);
const fail = (line) => { failed = true; console.log(`FAIL ${line}`); };

const printedBy = new Map(); // package -> every "# " measurement its suites printed
for (const suite of SUITES) {
  const cwd = path.join(filesRoot, suite.pkg);
  const measurements = [];
  for (const file of suite.tests) {
    const started = Date.now();
    const run = spawnSync(process.execPath, ["--test", file], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = `${run.stdout}${run.stderr}`;
    const count = (name) => Number((new RegExp(`^ℹ ${name} (\\d+)`, "m").exec(out) ?? [0, NaN])[1]);
    const [tests, pass, failures, skipped] = [count("tests"), count("pass"), count("fail"), count("skipped")];
    const ok = run.status === 0 && failures === 0 && pass === tests && skipped === 0;
    report(`${ok ? "ok  " : "FAIL"} files/${suite.pkg}/${file}: ${pass}/${tests} tests, ${skipped} skipped (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    if (!ok) {
      failed = true;
      console.log(out.split("\n").filter((l) => /^(✖|\s+(Assertion|Error)|\s+at )/.test(l)).slice(0, 30).join("\n"));
    }
    for (const line of out.split("\n").filter((l) => l.startsWith("# "))) {
      report(`     ${line.slice(2)}`);
      measurements.push(line);
    }
  }
  printedBy.set(suite.pkg, measurements.join("\n"));
}
// Every measurement the acceptance names must have been printed.
for (const suite of SUITES) {
  for (const pattern of suite.measured) {
    if (!pattern.test(printedBy.get(suite.pkg))) fail(`files/${suite.pkg}: no measurement line matching ${pattern}`);
  }
}

// The tri-runtime records.
for (const pkg of ["orbit-products", "rinex"]) {
  const base = path.join(filesRoot, pkg);
  if (process.env.INTERCHANGE_PARITY === "run") {
    const run = spawnSync(process.execPath, ["tests/parity.mjs"], { cwd: base, encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.wasmedge/bin:${process.env.PATH}` } });
    if (run.status !== 0) fail(`files/${pkg} parity rerun:\n${run.stdout}${run.stderr}`);
  }
  const record = JSON.parse(fs.readFileSync(path.join(base, "conformance", "parity.json"), "utf8"));
  const sha = createHash("sha256").update(fs.readFileSync(path.join(base, "dist", "isomorphic", "module.wasm"))).digest("hex");
  const lanes = record.lanes.map((l) => l.lane);
  const current = record.ok === true && record.artifactSha256 === sha && lanes.includes("browser") && lanes.includes("wasmedge") && record.failures.length === 0;
  (current ? report : fail)(`${current ? "ok  " : ""} files/${pkg} tri-runtime parity: ${record.lanes.map((l) => `${l.lane} ${l.runs} runs`).join(", ")}; ${record.cases.length} cases byte-identical; ` +
    `artifact ${sha.slice(0, 16)} ${record.artifactSha256 === sha ? "is the one measured" : "IS NOT the one measured"}; Docker leg waived by the owner (2026-10-22)`);
}

console.log(failed ? "\nINTERCHANGE E2E: FAIL" : "\nINTERCHANGE E2E: PASS");
process.exit(failed ? 1 : 0);
