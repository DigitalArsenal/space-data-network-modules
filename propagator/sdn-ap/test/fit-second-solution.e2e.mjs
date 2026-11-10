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
//   truth, argp 270, 72 h arc; its fit takes the finite-difference fall-back): BTERM 0.04461633761935712 and FIT_RMS_KM
//   0.021800715473184688 bit for bit; every grid lookup of the fit a fit set's; no fit grid held after it.
// - Below e 0.3 the fit emits the 0.6.2 dist's bytes (git, modules c82160de7, its SHA-256 checked),
//   PRODUCER's version read as 0.6.2: the LEO fixture (test/lib/fixture-inputs.mjs, 24 h of propagator/ffm's 550 km
//   trajectory) under AP's forces with NRLMSISE-00 rows and under stock SGP4XP, and a GEO arc (an AP set, caps 31 and 20,
//   flown by this module 72 h at 300 s in GCRF, refitted under the same forces).
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
  bterm: 0.04461633761935712, fitRmsKm: 0.021800715473184688,
};
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
    check(Object.is(m.b, MOLNIYA.bterm), `Molniya start 0: BTERM ${m.b}, expected ${MOLNIYA.bterm}`);
    check(Object.is(m.rms, MOLNIYA.fitRmsKm), `Molniya start 0: FIT_RMS_KM ${m.rms}, expected ${MOLNIYA.fitRmsKm}`);
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
for (const [name, oem, config, spw] of cases) {
  const c = await fit(cand, oem, config, spw), b = await fit(base, oem, config, spw);
  const same = Buffer.compare(asBase(c), Buffer.from(b)) === 0;
  check(same, `${name}: the $OCM differs from 0.6.2's (${stats(c).rms} km, BTERM ${stats(c).b} against ${stats(b).rms} km, ${stats(b).b})`);
  console.log(`${name}: ${c.length} bytes, ${same ? "byte-identical to 0.6.2" : "differs"}; FIT_RMS ${(stats(c).rms * 1000).toFixed(2)} m, BTERM ${stats(c).b}`);
}
if (geo) console.log(`GEO arc: ${OEM.getRootAsOEM(new flatbuffers.ByteBuffer(geo)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES.length} states`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("PASS");
process.exit(0);
