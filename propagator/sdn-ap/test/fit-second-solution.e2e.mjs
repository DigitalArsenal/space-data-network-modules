#!/usr/bin/env node
// E2E (task modules-sdn-ap-fit-second-solution-robustness-20261106; experiments FIT-SECOND-SOLUTION.md, Amendment 2): the
// fit's second solution, a regression guard on the tesseral grid (SPEC 16.11). With each perturbed set its own grid, the fit's
// finite-difference partials jump and THEMIS A 2013-02-15 stalls at 249.75 m with BTERM 4.506; the grid's sharing within a
// set's perturbed copies converges (ripple 6b60710fe: 104.77 m, BTERM 0.012028, days 1 / 3 / 7 201.1 / 294.3 / 421.8 m;
// 0.6.2: 109.52 m, 0.012046, 211.7 / 314.1 / 419.9 m).
// - THEMIS A, cutoff 2013-02-15 (test/fixtures/themis-a-2013-02-15-fit-72h.oem, SHA-256 pinned: the 72 h fit $OEM the
//   experiment's run.mjs --save writes, NAIF's public kernel in GCRF at 300 s), AP vacuum (FORCES caps 31 and 20, Jacchia 1970 on the theory's flux model): FIT_RMS_KM at
//   most 1.1 times the 0.6.2 base's 109.5 m (0.1205 km) and BTERM within 2 times the base's 0.0120 (0.0060 to 0.0240).
// - Molniya start 0, fitted drag (test/fixtures/molniya-start0-fit-72h.oem, .pcf, .spw, SHA-256 pinned; the pinned FFM model
//   truth, argp 270, 72 h arc; its fit takes the finite-difference fall-back): FIT_RMS at most 0.6.12's 21.911 m plus 1 m
//   (the fit has two solutions, stack #392; the history at MOLNIYA); every grid lookup of the fit a fit set's; no fit grid
//   held after it.
// - Below e 0.3 the fit's record flown 4 days within NO_HARM of the 0.6.2 dist's (git, modules c82160de7, its SHA-256
//   checked; byte identity until 0.6.5; LEO AP from 0.6.27 against its own fit, ap-fit-0.6.27.ocm, at NO_HARM) and its
//   FIT_RMS within 0.01 m: the LEO fixture (test/lib/fixture-inputs.mjs, 24 h of
//   propagator/ffm's 550 km trajectory) under AP's forces with NRLMSISE-00 rows and under stock SGP4XP. A GEO arc (an AP
//   set, caps 31 and 20, flown by this module 72 h at 300 s in GCRF, refitted under the same forces) is held against its
//   own truth, the set it was flown from (GEO_AP): FIT_RMS and the fit flown 4 days against the set's flight, and no
//   farther from it than 0.6.2's fit.
// JS only moves bytes and compares numbers the module produced.
//   node test/fit-second-solution.e2e.mjs
import fs from "node:fs";
import { scratchTemp } from "./lib/scratch.mjs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { ensureBuilt, wasmPath, packageRoot } from "./lib/module.mjs";
import { configuration, MSIS_FORCES, XP_FORCES, pcfAtmosphereFamily } from "./lib/pcf.mjs";
import { inputs } from "./lib/fixture-inputs.mjs";
import { T, ocmOf, seedOcm, flight } from "./lib/ocm.mjs";
import { oemDistance } from "./lib/oem-distance.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const BASE = { version: "0.6.2", commit: "c82160de7", sha256: "84d50dca4efdfea87eff7e3b4618d795c26a7d0a6df0e877341e69bc73161f41" };
const THEMIS_A = { baseRmsKm: 0.1095, baseBterm: 0.0120, rmsRatio: 1.1, btermRatio: 2 };
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const baseBytes = execFileSync("git", ["-C", packageRoot, "show", `${BASE.commit}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
if (sha256(baseBytes) !== BASE.sha256) throw new Error(`sdn-ap ${BASE.version} at ${BASE.commit} is ${sha256(baseBytes)}`);
const basePath = path.join(scratchTemp("sdn-ap-second-start-"), "module-0.6.2.wasm");
fs.writeFileSync(basePath, baseBytes);
const cand = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const base = await createStandaloneHarness("browser", basePath, { surface: "direct" });
const now = JSON.parse(fs.readFileSync(`${packageRoot}plugin-manifest.json`, "utf8")).version;
const producer = (v) => Buffer.from(`com.spacedatanetwork.sdn-ap-propagator ${v}`);
const asBase = (bytes) => { const b = Buffer.from(bytes); for (let at = b.indexOf(producer(now)); at >= 0; at = b.indexOf(producer(now), at + 1)) producer(BASE.version).copy(b, at); return b; };
const fit = async (h, oem, config, spw) => {
  const r = await h.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: oem }, config,
    ...(spw ? [{ portId: "space_weather", typeRef: T("SPW"), payload: spw }] : [])] });
  if (r.statusCode !== 0) throw new Error(`fit: ${r.errorCode}: ${r.errorMessage}`);
  return new Uint8Array(r.outputs.find((o) => o.portId === "elements").payload);
};
const VACUUM_AP = { EPHEMERIS_SOURCE: "", ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31,
  HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20 };
const stats = (bytes) => { const o = ocmOf(bytes); return { rms: o.ORBIT_DETERMINATION.FIT_STATISTICS.FIT_RMS_KM, b: o.MEAN_ELEMENTS.BTERM, it: o.ORBIT_DETERMINATION.FIT_STATISTICS.ITERATIONS }; };

// --- THEMIS A 2013-02-15
const ARC = { file: "themis-a-2013-02-15-fit-72h.oem", sha256: "719cc63dffdd795d5a702bb83bf25dd4699ffe2363729fdb50445eb13a9ff351" };
const arc = fs.readFileSync(new URL(`fixtures/${ARC.file}`, import.meta.url));
check(sha256(arc) === ARC.sha256, `${ARC.file} is ${sha256(arc)}, pinned ${ARC.sha256}`);
if (sha256(arc) === ARC.sha256) {
  const config = configuration({ theory: "AP", forces: VACUUM_AP });
  // SPEC 16.11: the fit's grid lookups (sdnap_wide_grid_stats: [0] by sets outside a fit, [1] by a fit's sets), reset before the
  // fit, read after it; the grid cache (sdnap_wide_grid_cache: held grids, bytes) before and after it
  const x = cand.instance.exports, statsPtr = x.sdnap_alloc(16), cachePtr = x.sdnap_alloc(16);
  const cache = () => { x.sdnap_wide_grid_cache(cachePtr); return Array.from(new Float64Array(cand.memory.buffer, cachePtr, 2)); };
  x.sdnap_wide_grid_stats(1, statsPtr);
  const held0 = cache();
  const c = stats(await fit(cand, arc, config));
  const held1 = cache();
  x.sdnap_wide_grid_stats(1, statsPtr);
  const [outside, inside] = Array.from(new Float64Array(cand.memory.buffer, statsPtr, 2));
  x.sdnap_free(statsPtr);
  x.sdnap_free(cachePtr);
  check(outside === 0 && inside > 0, `THEMIS A fit: ${outside} grid lookups by sets outside a fit and ${inside} by the fit's sets`);
  check(held1[0] === held0[0] && held1[1] === held0[1], `THEMIS A fit: grid cache ${held0.join(" / ")} before, ${held1.join(" / ")} after (a fit grid retained)`);
  console.log(`THEMIS A fit grid lookups: ${outside} outside a fit, ${inside} by the fit's sets; cache ${held0[0]} grids / ${held0[1]} bytes before, ${held1[0]} / ${held1[1]} after`);
  const b = stats(await fit(base, arc, config));
  const rmsBound = THEMIS_A.rmsRatio * THEMIS_A.baseRmsKm, bLow = THEMIS_A.baseBterm / THEMIS_A.btermRatio, bHigh = THEMIS_A.baseBterm * THEMIS_A.btermRatio;
  check(c.rms <= rmsBound, `THEMIS A: FIT_RMS_KM ${c.rms} above ${rmsBound}`);
  check(c.b >= bLow && c.b <= bHigh, `THEMIS A: BTERM ${c.b} outside ${bLow} to ${bHigh}`);
  console.log(`THEMIS A 2013-02-15: FIT_RMS ${(c.rms * 1000).toFixed(1)} m (bound ${(rmsBound * 1000).toFixed(1)}), BTERM ${c.b.toPrecision(4)} (bounds ${bLow} to ${bHigh}), ITERATIONS ${c.it}; ` +
    `0.6.2: ${(b.rms * 1000).toFixed(1)} m, BTERM ${b.b.toPrecision(4)}`);
}

// --- Molniya start 0, fitted drag (the ripple lane's fixture; it takes the finite-difference fall-back): one fit call with its
// three frames; BTERM and FIT_RMS_KM bit-equal to the exact-grid fit's (the fall-back's copies reading the nominal's grid gave
// 0.04571376917240479 and 0.021225197279760338); every grid lookup a fit set's, none retained after the fit
const MOLNIYA = {
  frames: [["ephemeris", "OEM", "molniya-start0-fit-72h.oem", "608697e99920e5a699d330a457f4ef74444a8301d186213696cb040b4b235ae2"],
    ["configuration", "PCF", "molniya-start0-fit.pcf", "21ca6686ac0f24f2e8bd7e7bd5e86f055392099e562b62a95fabf8eb3ad176ea"],
    ["space_weather", "SPW", "molniya-start0-fit.spw", "647760dfb43168f4b0c9e98cf9b86e91a108f725edfd918f6be2b870a5919ebb"]],
  // The fit has two solutions that small numerical changes move it between (stack #392): BTERM 0.044623127 and FIT_RMS
  // 21.911 m on 0.6.12; 0.045722497 and 21.337 m with the E-grid read C1 (#420). Both lie within the record's own stated
  // sigma of the truth (0.12 and 0.34 sigma, test/third-body-short-period-eccentric.e2e.mjs holds that), so this test
  // keeps what it is about (every grid lookup a fit set's, no fit grid held after it) and bounds FIT_RMS from above by
  // 0.6.12's value plus 1 m. Pinned before: 0.6.12 re-recorded (perigee passes, SPEC 16.12) from 0.6.11's 0.04461830424914888
  // and 0.02180476515880898 km (0.6.5 to 0.6.11; bit for bit before 0.6.5 at 0.04461633761935712 and 0.021800715473184688 km)
  fitRmsKm: 0.021910711160895126, fitRmsM: 1,
};
// the no-harm fits' flights against 0.6.2's (m over 4 days; byte identity until 0.6.5), measured 2026-11-10 on 0.6.8:
// LEO AP 0.446 m (0.6.5's fit stops at another point inside its tolerance, FIT_RMS 41.127 against 41.130 m), LEO SGP4XP
// byte-identical.
// 0.6.25 (the slow set, SPEC 16.18) moves LEO AP's fit, which now carries the slow tesseral terms at 550 km: 38.6 m from
// 0.6.2's over the 4 days, FIT_RMS 1.08 m lower. Against the fixture's own truth (propagator/ffm's 550 km trajectory) the
// error 48 to 72 h past the arc goes from 114 m (0.6.20) to 43 m (ap-terms.e2e.mjs prints both). So LEO AP is held against
// the slow set's fit (test/fixtures/ap-fit-0.6.25.ocm), the bounds kept; LEO SGP4XP stays against 0.6.2's.
// 0.6.27 (the slow set's terms of q other than 0) moves LEO AP's fit: 84.4 m from 0.6.25's over the 4 days, FIT_RMS
// 0.21 m higher; against the fixture's own truth the error 48 to 72 h past the arc stays at 43 m. So LEO AP is held
// against 0.6.27's fit (test/fixtures/ap-fit-0.6.27.ocm), the bounds kept.
const NO_HARM = { "LEO AP": 1, "LEO SGP4XP": 0.001 };
const PINNED = { "LEO AP": new Uint8Array(fs.readFileSync(new URL("fixtures/ap-fit-0.6.27.ocm", import.meta.url))) };
// The GEO arc is this module's own flight of a set with AGOM 0.01 (geoSet), so a fit can reach zero residual and the set
// is the truth. Through 0.6.12 the fit weighed it at 1 km against the AGOM prior and left FIT_RMS 1.050 m, its flight
// 0.12 mm from 0.6.2's fit's over 4 days (then pinned at 0.01 m against 0.6.2). From 0.6.13 a set above the drag is fitted
// at the data's own sigma (SPEC 12.1, stack issue 324) and the comparison is with the truth: the fit's FIT_RMS at most
// fitRmsM, its flight over the 4 days (the 72 h arc and a day after it) at most truthM from geoSet's flight, and not
// farther from it than 0.6.2's fit flown the same way. Measured on 0.6.13: FIT_RMS 0.0096 m and 2.177 m from the truth,
// against 0.6.2's fit's 1.0501 m and 5.400 m.
const GEO_AP = { fitRmsM: 0.02, truthM: 2.3 };
{
  const inputs = MOLNIYA.frames.map(([portId, type, file, pin]) => {
    const payload = fs.readFileSync(new URL(`fixtures/${file}`, import.meta.url));
    check(sha256(payload) === pin, `${file} is ${sha256(payload)}, pinned ${pin}`);
    return { portId, typeRef: T(type), payload };
  });
  const x = cand.instance.exports, statsPtr = x.sdnap_alloc(16), cachePtr = x.sdnap_alloc(16);
  const cache = () => { x.sdnap_wide_grid_cache(cachePtr); return Array.from(new Float64Array(cand.memory.buffer, cachePtr, 2)); };
  x.sdnap_wide_grid_stats(1, statsPtr);
  const held0 = cache();
  const r = await cand.invoke({ methodId: "fit", inputs });
  const held1 = cache();
  x.sdnap_wide_grid_stats(1, statsPtr);
  const [outside, inside] = Array.from(new Float64Array(cand.memory.buffer, statsPtr, 2));
  x.sdnap_free(statsPtr);
  x.sdnap_free(cachePtr);
  check(r.statusCode === 0, `Molniya start 0 fit: ${r.errorCode} ${r.errorMessage}`);
  if (r.statusCode === 0) {
    const m = stats(new Uint8Array(r.outputs.find((o) => o.portId === "elements").payload));
    // the fit has two solutions (MOLNIYA): the fit RMS bounded from above, not pinned
    check(m.rms * 1000 <= MOLNIYA.fitRmsKm * 1000 + MOLNIYA.fitRmsM, `Molniya start 0: FIT_RMS_KM ${m.rms} above ${MOLNIYA.fitRmsKm} + ${MOLNIYA.fitRmsM} m`);
    console.log(`Molniya start 0: BTERM ${m.b}, FIT_RMS_KM ${m.rms}, ITERATIONS ${m.it}`);
  }
  check(outside === 0 && inside > 0, `Molniya start 0 fit: ${outside} grid lookups by sets outside a fit and ${inside} by the fit's sets`);
  check(held1[0] === held0[0] && held1[1] === held0[1], `Molniya start 0 fit: grid cache ${held0.join(" / ")} before, ${held1.join(" / ")} after (a fit grid retained)`);
  console.log(`Molniya start 0 fit grid lookups: ${outside} outside a fit, ${inside} by the fit's sets; cache ${held0[0]} / ${held0[1]} before, ${held1[0]} / ${held1[1]} after`);
}

// --- no harm: the LEO fixture and a GEO arc, byte-identical to 0.6.2
const { arc: leo, rows } = inputs();
const AP_FORCES = { ...MSIS_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  WEATHER_SOURCE: pcfWeatherSource.RECORDS };
const t0 = Date.parse("2026-10-01T00:00:00Z"), iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const geoSet = seedOcm({ epoch: iso(t0), n: 1.0027, e: 0.0002, i: 0.1, raan: 40, argp: 30, ma: 20, bterm: 0.01, agom: 0.01, norad: 99002, name: "GEO", tesseral: 31, zonal: 20 });
const flown = await cand.invoke({ methodId: "propagate", inputs: flight([geoSet], { output: { EPOCHS: Array.from({ length: 865 }, (_, k) => iso(t0 + k * 300000)), FRAME: pcfOutputFrame.GCRF } }) });
check(flown.statusCode === 0, `GEO flight: ${flown.errorCode} ${flown.errorMessage}`);
const geo = flown.statusCode === 0 ? new Uint8Array(flown.outputs.find((o) => o.portId === "ephemeris").payload) : null;
const cases = [["LEO AP", leo, configuration({ theory: "AP", forces: AP_FORCES }), rows.bytes], ["LEO SGP4XP", leo, configuration({ theory: "SGP4XP", forces: XP_FORCES }), null],
  ...(geo ? [["GEO AP", geo, configuration({ theory: "AP", forces: VACUUM_AP }), null]] : [])];
// the two builds' fitted records flown by this build from the arc's start for 4 days at 1 h: what a consumer sees of the fit
const span = { START_TIME: iso(t0), STOP_TIME: iso(t0 + 4 * 86400000), STEP_SECONDS: 3600 };
// the GEO arc's truth, its own set flown the same way
const geoTruth = await cand.invoke({ methodId: "propagate", inputs: flight([geoSet], { output: span }) });
check(geoTruth.statusCode === 0, `GEO truth flight: ${geoTruth.errorCode} ${geoTruth.errorMessage}`);
const geoTruthOem = geoTruth.statusCode === 0 ? new Uint8Array(geoTruth.outputs.find((o) => o.portId === "ephemeris").payload) : null;
for (const [name, oem, config, spw] of cases) {
  const c = await fit(cand, oem, config, spw), b = PINNED[name] ?? await fit(base, oem, config, spw);
  const same = Buffer.compare(asBase(c), Buffer.from(b)) === 0;
  const [fc, fb] = [await cand.invoke({ methodId: "propagate", inputs: flight([c], { output: span }) }), await cand.invoke({ methodId: "propagate", inputs: flight([b], { output: span }) })];
  check(fc.statusCode === 0 && fb.statusCode === 0, `${name}: flights of the two fits ${fc.errorCode ?? "ok"} | ${fb.errorCode ?? "ok"}`);
  const d = fc.statusCode === 0 && fb.statusCode === 0
    ? oemDistance(new Uint8Array(fc.outputs.find((o) => o.portId === "ephemeris").payload), new Uint8Array(fb.outputs.find((o) => o.portId === "ephemeris").payload)) : null;
  const dRms = Math.abs(stats(c).rms - stats(b).rms) * 1000;
  console.log(`${name}: ${c.length} bytes, ${same ? "byte-identical to 0.6.2" : "differs"}; the fits flown 4 days ${d ? `${(1000 * d.posM).toFixed(2)} mm` : "-"} apart; FIT_RMS ${(stats(c).rms * 1000).toFixed(3)} m against ${(stats(b).rms * 1000).toFixed(3)} m, BTERM ${stats(c).b} against ${stats(b).b}`);
  if (name === "GEO AP") {
    const oemOf = (r) => new Uint8Array(r.outputs.find((o) => o.portId === "ephemeris").payload);
    const [tc, tb] = d && geoTruthOem ? [oemDistance(oemOf(fc), geoTruthOem).posM, oemDistance(oemOf(fb), geoTruthOem).posM] : [NaN, NaN];
    console.log(`GEO AP against its truth over 4 days: this build's fit ${tc.toFixed(4)} m (FIT_RMS ${(stats(c).rms * 1000).toFixed(4)} m), 0.6.2's ${tb.toFixed(4)} m (FIT_RMS ${(stats(b).rms * 1000).toFixed(4)} m)`);
    check(stats(c).rms * 1000 <= GEO_AP.fitRmsM && tc <= GEO_AP.truthM && tc <= tb,
      `${name}: FIT_RMS ${stats(c).rms * 1000} m (at most ${GEO_AP.fitRmsM} m); the fit flown 4 days ${tc} m from its truth (at most ${GEO_AP.truthM} m, and not above 0.6.2's ${tb} m)`);
  } else
    check(d && d.posM <= NO_HARM[name] && dRms <= 0.01, `${name}: the fit flown 4 days ${d?.posM} m from ${PINNED[name] ? "0.6.27's fit" : "0.6.2's"} (within ${NO_HARM[name]} m), FIT_RMS ${dRms} m apart (within 0.01 m)`);
}
if (geo) console.log(`GEO arc: ${OEM.getRootAsOEM(new flatbuffers.ByteBuffer(geo)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.length} states`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("PASS");
process.exit(0);
