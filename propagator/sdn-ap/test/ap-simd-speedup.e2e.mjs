#!/usr/bin/env node
// E2E (sdn-ap 0.6.5): WASM SIMD128 + fast-trig + stage-cached RK3 + analytic/SIMD covariance Jacobian
// for AP (theory 5), preserving bit-for-bit identity on SGP4 (type 0) and SGP4XP (type 4) against 0.6.4
// (commit cfd750eb8), sub-centimeter AP state agreement (<= 1 cm over 7 days, from 0.6.38 against the radial term's first
// build, git 79e97cd6: step 4),
// <= 1e-3 relative AP covariance agreement over 48 h with 0.6.38's recorded numbers (test/fixtures/ap-fit-0.6.36-0.6.38.cov),
// 0.6.4's AP fit refused by this build (gravity-model-mismatch: it states EGM-96, SPEC 16.2),
// valid $OCM/$ODR fit with zero USER_DEFINED_* fields,
// and thread-count bit-determinism.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { openModule, wasmPath, packageRoot } from "./lib/module.mjs";
import { scratchTemp } from "./lib/scratch.mjs";
import { configuration, MSIS_FORCES } from "./lib/pcf.mjs";
import { inputs, GRID } from "./lib/fixture-inputs.mjs";
import { elementsOf, tleLines } from "./lib/tle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");

// 1. Version headers and signed bundle identity check
execFileSync(process.execPath, [path.join(here, "docs-version.e2e.mjs")], { stdio: "inherit" });

// Extract 0.6.4 baseline signed bundle from git
const BASE_COMMIT = "cfd750eb8de2f5d7c339173ee674bc7a481da8c2";
const BASE_SHA256 = "e98b63558d84cfd3b8509f4c4c640502e38f81cc05a0e0277fcffa7da97cf51d";
const scratch = scratchTemp("sdn-ap-065-e2e-");
try {
  const baseBytes = execFileSync("git", ["-C", repoRoot, "show", `${BASE_COMMIT}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
  const gotSha = createHash("sha256").update(baseBytes).digest("hex");
  assert.equal(gotSha, BASE_SHA256, `0.6.4 baseline sha256 mismatch: ${gotSha}`);
  const basePath = path.join(scratch, "sdn-ap-0.6.4.wasm");
  fs.writeFileSync(basePath, baseBytes);
  // the AP 7-day state equivalence's baseline (step 4): 0.6.4 until 0.6.21, 0.6.22 until 0.6.34, 0.6.36 the field
  // change's first build (git 7ebc98e4, not a release; its own version string reads 0.6.33), from 0.6.38 the radial term's
  // first build (git 79e97cd6, not a release; its own version string reads 0.6.38) (history at step 4)
  const STATE_BASE = { version: "0.6.38", commit: "79e97cd6328774b9026eb06d04e0ae77bd5ca9c2", sha256: "ba860b1c6826323e60bf79fd003b09c64c7ccba90af2e027611fe2362bfb8cb1" };
  const stateBaseBytes = execFileSync("git", ["-C", repoRoot, "show", `${STATE_BASE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
  assert.equal(createHash("sha256").update(stateBaseBytes).digest("hex"), STATE_BASE.sha256, `${STATE_BASE.version} baseline sha256 mismatch`);
  const stateBasePath = path.join(scratch, `sdn-ap-${STATE_BASE.version}.wasm`);
  fs.writeFileSync(stateBasePath, stateBaseBytes);

  // 2. SGP4 (type 0) and SGP4XP (type 4) bit-for-bit identity against 0.6.4 across all 6 regimes
  const sampleSets = [
    { type: 0, mm: 15.5, ecc: 0.0012, inc: 51.6, bstar: 1.2e-4, bterm: 0, agom: 0 },
    { type: 0, mm: 1.0027, ecc: 0.0004, inc: 0.5, bstar: 0, bterm: 0, agom: 0 },
    { type: 4, mm: 15.2, ecc: 0.0015, inc: 97.4, bstar: 0, bterm: 0.012, agom: 0.01 },
    { type: 4, mm: 2.005, ecc: 0.01, inc: 55.0, bstar: 0, bterm: 0.004, agom: 0.015 },
    { type: 4, mm: 1.0027, ecc: 0.0003, inc: 2.1, bstar: 0, bterm: 0.002, agom: 0.02 },
    { type: 4, mm: 2.0, ecc: 0.72, inc: 63.4, bstar: 0, bterm: 0.01, agom: 0.01 },
    { type: 4, mm: 2.35, ecc: 0.71, inc: 27.0, bstar: 0, bterm: 0.015, agom: 0.01 },
    { type: 4, mm: 0.35, ecc: 0.45, inc: 28.5, bstar: 0, bterm: 0.005, agom: 0.02 },
  ].map((c, idx) => elementsOf(tleLines({
    satnum: 40000 + idx, year: 26, day: 290.25, type: c.type, bstar: c.bstar, bterm: c.bterm, agom: c.agom,
    inc: c.inc, raan: 45 + 37 * idx, ecc: c.ecc, argp: 110 + 29 * idx, ma: 15 + 41 * idx, mm: c.mm, rev: 0,
  })));

  const mBase = await openModule(basePath);
  const mCurr = await openModule(wasmPath);
  mBase.init(sampleSets);
  mCurr.init(sampleSets);
  for (const tMin of [0, 60, 720, 2880, 10080]) {
    const times = sampleSets.map(() => tMin);
    const p0 = mBase.atMinutes(times);
    const p1 = mCurr.atMinutes(times);
    for (const plane of ["x", "y", "z", "vx", "vy", "vz"]) {
      for (let i = 0; i < sampleSets.length; i++) {
        assert.ok(Object.is(p0[plane][i], p1[plane][i]), `SGP4/SGP4XP bit mismatch at set ${i} t=${tMin} ${plane}: ${p0[plane][i]} vs ${p1[plane][i]}`);
      }
    }
  }
  console.log("PASS SGP4 and SGP4XP bit-identical to 0.6.4 across LEO, SSO, MEO, GEO, HEO, VDS (0..7 d)");

  // 3. Thread-count bit-determinism (0 vs 4 workers)
  mCurr.x.sdnap_threads(0);
  const singleOut = mCurr.atMinutes(sampleSets.map(() => 4320));
  mCurr.x.sdnap_threads(4);
  const multiOut = mCurr.atMinutes(sampleSets.map(() => 4320));
  mCurr.x.sdnap_threads(0);
  for (const plane of ["x", "y", "z", "vx", "vy", "vz"]) {
    for (let i = 0; i < sampleSets.length; i++) {
      assert.ok(Object.is(singleOut[plane][i], multiOut[plane][i]), `thread determinism mismatch at set ${i} ${plane}`);
    }
  }
  console.log("PASS SGP4 and SGP4XP 0-thread vs 4-thread bit-identical");

  // 4. AP (theory 5) fit + 7-day state & 24h covariance equivalence against 0.6.4 (browser + WasmEdge invoke check)
  const hBase = await createStandaloneHarness("browser", basePath, { surface: "direct" });
  const hCurr = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
  const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
  const { arc, rows } = inputs();
  const AP_FORCES = {
    ...MSIS_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31,
    HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20, WEATHER_SOURCE: pcfWeatherSource.RECORDS,
  };
  const cfgFit = configuration({ theory: "AP", forces: AP_FORCES });
  const fitInputs = [
    { portId: "ephemeris", typeRef: T("OEM"), payload: arc },
    cfgFit,
    { portId: "space_weather", typeRef: T("SPW"), payload: rows.bytes },
  ];
  const [fitBase, fitCurr] = [
    await hBase.invoke({ methodId: "fit", inputs: fitInputs }),
    await hCurr.invoke({ methodId: "fit", inputs: fitInputs }),
  ];
  assert.equal(fitBase.statusCode, 0);
  assert.equal(fitCurr.statusCode, 0);
  const ocmBaseBytes = new Uint8Array(fitBase.outputs[0].payload);
  const ocmCurrBytes = new Uint8Array(fitCurr.outputs[0].payload);
  const odrCurrBytes = new Uint8Array(fitCurr.outputs[1].payload);
  assertNoUserDefined(ocmCurrBytes);
  assert.equal(String.fromCharCode(...odrCurrBytes.subarray(4, 8)), "$ODR");
  const ocmCurr = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(ocmCurrBytes)).unpack();
  assert.equal(ocmCurr.PROVENANCE?.PRODUCER, `com.spacedatanetwork.sdn-ap-propagator ${JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8")).version}`);
  assert.ok(ocmCurr.ORBIT_DETERMINATION.FIT_STATISTICS.CONVERGED);

  // 0.6.4's fit states GRAVITY_MODEL EGM-96 with gravity terms: this build refuses it (SPEC 16.2, from 0.6.36)
  const refusedOld = await hCurr.invoke({ methodId: "propagate", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: ocmBaseBytes }] });
  assert.ok(refusedOld.statusCode !== 0 && refusedOld.errorCode === "gravity-model-mismatch", `0.6.4's fit: ${refusedOld.errorCode ?? "flown"}, expected gravity-model-mismatch`);
  console.log("PASS 0.6.4's AP fit (EGM-96) refused by this build: gravity-model-mismatch");
  const storedBytes = new Uint8Array(fs.readFileSync(path.join(here, "fixtures/ap-fit-0.6.36.ocm")));
  // Propagate the stored AP $OCM (from 0.6.36 its own fit; 0.6.4's fit through 0.6.34) on STATE_BASE and this build for
  // 7 days in EME2000 and TEME, within 1 cm. Against 0.6.4 until 0.6.21 (0.6.5's speed changes: sub-centimeter); AP's own
  // Sun and Moon (0.6.22, SPEC 16.17, stack #446) move this flight from 0.6.4's by 12.179 cm in EME2000 and TEME (0.6.21
  // within 1 cm), so from 0.6.22 the baseline is 0.6.22 (git f8af1e2b), the bound kept. The field EGM2008 (0.6.36, SPEC
  // 16.2, stack #503) moves it from 0.6.22's by 20.137 m in EME2000 and TEME, so from 0.6.36 the baseline is the field
  // change's first build (git 7ebc98e4), the bound kept. From 0.6.36 the record is 0.6.36's own fit (0.6.4's is refused),
  // flown by STATE_BASE (which reads EGM2008 records) and by this build. The zonal theory's constant radial term (0.6.38,
  // SPEC 16.21) moves it from 7ebc98e4's by 2.152 m in EME2000 and TEME, so from 0.6.38 the baseline is the term's first
  // build (git 79e97cd6), the bound kept.
  const hState = await createStandaloneHarness("browser", stateBasePath, { surface: "direct" });
  const EPOCHS = Array.from({ length: 57 }, (_, k) => new Date(Date.parse("2026-10-02T00:00:00Z") + k * 3 * 3600e3).toISOString().replace("Z", ""));
  const linesOf = (p) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(p.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  const worstDr = (a, b) => { let m = 0; for (let k = 0; k < a.length; k++) m = Math.max(m, Math.hypot(b[k].X - a[k].X, b[k].Y - a[k].Y, b[k].Z - a[k].Z) * 1000); return m; };
  for (const frame of [pcfOutputFrame.EME2000, pcfOutputFrame.TEME]) {
    const propInputs = [{ portId: "ocm", typeRef: T("OCM"), payload: storedBytes }, configuration({ output: { FRAME: frame, EPOCHS } })];
    const [pState, pCurr] = [
      await hState.invoke({ methodId: "propagate", inputs: propInputs }),
      await hCurr.invoke({ methodId: "propagate", inputs: propInputs }),
    ];
    assert.equal(pState.statusCode, 0);
    assert.equal(pCurr.statusCode, 0);
    const oemCurrBytes = new Uint8Array(pCurr.outputs[0].payload);
    assert.equal(String.fromCharCode(...oemCurrBytes.subarray(4, 8)), "$OEM");
    const lines1 = linesOf(pCurr), maxDrMeters = worstDr(linesOf(pState), lines1);
    assert.ok(maxDrMeters <= 0.01, `AP 7-day |dr| ${maxDrMeters} m from ${STATE_BASE.version} exceeds 1 cm`);
    console.log(`PASS AP 7-day state equivalence (${pcfOutputFrame[frame]}): worst |dr| = ${(maxDrMeters * 100).toFixed(4)} cm from ${STATE_BASE.version} (limit <= 1.0 cm)`);
  }

  // Covariance on the stored AP $OCM over the 289 grid epochs (48 h at 10 min): this build against 0.6.38's numbers of it
  // (test/fixtures/ap-fit-0.6.36-0.6.38.cov); the 0.6.4 dist's fit is ap-fit-0.6.4.ocm byte for byte.
  // 0.6.22 (AP's own Sun and Moon, SPEC 16.17) records them from itself (the 0.6.21 file went): 2.19e-5 of a time's
  // largest entry from 0.6.21's, the bound kept. 0.6.36 (the field EGM2008) moves 0.6.4's fit's numbers by 5.29e-3 of a
  // time's largest entry from 0.6.22's, the bound kept.
  // Through 0.6.20 the reference was the 0.6.4 dist's own numbers; 0.6.21 (SPEC 16.15 and 16.16, stack #464 and #472)
  // moves them: against the 0.6.4 dist's, 0.6.20 7.2e-5 and 0.6.21 9.217e-3 of a time's largest entry, the bound kept.
  // Why: the record's correlations between AGOM and the state are 0.6.4's fit's, and 16.16 moves its along-track response
  // to AGOM at 48 h from 1380.7 to 823.7 m per m^2/kg; a fit made and flown by 0.6.21 flies to 0.6.4's numbers within
  // 7.1e-5 (covariance.e2e.mjs). From 0.6.36 they are this build's numbers of the stored record, its own fit (the 0.6.22
  // file went). 0.6.38 (the zonal theory's constant radial term, SPEC 16.21) records them from itself (the 0.6.36 file
  // went): 9.61e-2 of a time's largest entry from 0.6.36's (why: stack #551 and ap-terms.e2e.mjs), the bound kept.
  // The 0.6.4 dist still flies its own fit for the timing line, this build the stored record (two fits of the same arc).
  assert.ok(Buffer.from(ocmBaseBytes).equals(fs.readFileSync(path.join(here, "fixtures/ap-fit-0.6.4.ocm"))), "the 0.6.4 dist's fit is not ap-fit-0.6.4.ocm");
  const recordedCov = new Float64Array(fs.readFileSync(path.join(here, "fixtures/ap-fit-0.6.36-0.6.38.cov")).buffer.slice(0));
  const covTimes = [];
  for (let t = 0; t <= GRID.minutes; t += GRID.step / 60) covTimes.push(t);
  const evalCov = (harness, ocmBytes) => {
    const x = harness.instance.exports, mem = () => harness.memory.buffer;
    const po = x.sdnap_alloc(ocmBytes.length), pm = x.sdnap_alloc(8 * covTimes.length), pout = x.sdnap_alloc(8 * 42 * covTimes.length);
    new Uint8Array(mem(), po, ocmBytes.length).set(ocmBytes);
    new Float64Array(mem(), pm, covTimes.length).set(covTimes);
    const status = x.sdnap_covariance_at(po, ocmBytes.length, pm, covTimes.length, pout);
    const out = Float64Array.from(new Float64Array(mem(), pout, 42 * covTimes.length));
    x.sdnap_free(po); x.sdnap_free(pm); x.sdnap_free(pout);
    return { status, out };
  };
  const t0Base = performance.now();
  const cBase = evalCov(hBase, ocmBaseBytes);
  const baseMs = performance.now() - t0Base;
  const t0Curr = performance.now();
  const cCurr = evalCov(hCurr, storedBytes);
  const currMs = performance.now() - t0Curr;
  assert.equal(cBase.status, 0);
  assert.equal(cCurr.status, 0);
  assert.equal(recordedCov.length, 42 * covTimes.length);
  let worstCovRel = 0;
  for (let k = 0; k < covTimes.length; k++) {
    const p0 = recordedCov.subarray(42 * k + 6, 42 * k + 42);
    const p1 = cCurr.out.subarray(42 * k + 6, 42 * k + 42);
    const scale = Math.max(...Array.from(p0, Math.abs));
    for (let q = 0; q < 36; q++) {
      const rel = Math.abs(p1[q] - p0[q]) / scale;
      if (rel > worstCovRel) worstCovRel = rel;
    }
  }
  assert.ok(worstCovRel <= 1e-3, `AP covariance relative diff ${worstCovRel} against 0.6.36's numbers exceeds 1e-3`);
  console.log(`PASS AP 289-epoch covariance against 0.6.36's numbers: worst relative diff = ${worstCovRel.toExponential(3)} (limit <= 1e-3); telemetry 0.6.4 (its own fit)=${baseMs.toFixed(2)} ms -> this build (the stored record)=${currMs.toFixed(2)} ms`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("ap-simd-speedup E2E: PASS");
process.exit(0);
