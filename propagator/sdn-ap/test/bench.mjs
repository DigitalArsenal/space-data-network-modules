#!/usr/bin/env node
// Bench: the whole catalog live in the module, against the US Space Force
// library's measured baseline (32,770 objects: 48.6 KiB per object, 175-276 ms
// per 60 s step single-threaded). Memory per object, and microseconds per
// object for the first propagation to now (each object from its epoch), a
// 60 s step, a 1-day jump and a 7-day jump, at 0 (calling thread only) and N
// pool threads. Same element sets as the baseline: every object of the
// 2026-10-23 Space-Track GP catalog as an SGP4XP set (BTERM from |B*|, AGOM
// 0.01). The catalog is read locally and never written anywhere.
//
//   node test/bench.mjs [--threads 0,4,8] [--limit N] [--json FILE]
//
// Task modules-sdn-ap-long-horizon-cost-20261025, two more sections (SDN-AP, whose drag reads the shared density kernel):
//   --long-horizon   one SDN-AP set per regime (GEO, MEO, HEO, LEO; B_eff 0.012 m^2/kg) propagated 1, 7 and 21 days on a
//                    60 s grid in one `propagate` call: CPU seconds and the digest of the output bytes. Run it on the
//                    build before a change and on the build after, and the digests tell whether any byte moved.
//   --kernel-memory  the density kernel's memory: one SDN-AP set per regime (B_eff 0.012) propagated 1, 7, 21, 28 and 40 days from its
//                    epoch in one instance, the wasm memory growth after each (the kernel holds a 64.2 KiB grid per 3 hours,
//                    allocated when a drag node first reads it, up to 28 days).
//   --sdnap N        the first N objects of the catalog as SDN-AP sets (theory 16, BTERM from |B*|) at each thread count of
//                    --threads: the density kernel's memory, CPU per object for jumps of --days (1,7,21) from T0 and the
//                    digest of every state of each jump. The digests must agree across thread counts (a cell of the
//                    kernel is evaluated by whichever thread reads it first); the run fails otherwise.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OMMUserDefinedParameter } from "spacedatastandards.org/lib/js/OMM/OMMUserDefinedParameter.js";
import { packOem, rfm } from "./lib/frames.mjs";
import { openModule, wasmPath } from "./lib/module.mjs";
import { configuration, withConfiguration } from "./lib/pcf.mjs";
import { elementsOf, tleLines } from "./lib/tle.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const GP = arg("--catalog", "/opt/data/sdn-archive/spacetrack/gp/2026/2026-10-23.json.gz");
const LIMIT = Number(arg("--limit", 1e9));
const THREADS = arg("--threads", "0,4,8").split(",").map(Number);
const JSON_OUT = arg("--json", null);
const T0 = Date.parse("2026-10-23T18:30:00Z");
const LONG_HORIZON = process.argv.includes("--long-horizon");
const KERNEL_MEMORY = process.argv.includes("--kernel-memory");
const SDNAP_N = Number(arg("--sdnap", 0));
const SDNAP_DAYS = arg("--days", "1,7,21").split(",").map(Number);
const BASELINE = { source: "USSF Sgp4Prop 9.1.1.0 XP, Node, single-threaded, measured 2026-10-23", objects: 32770,
  kibPerObject: 48.6, stepMs: [175, 276], firstPropagationUsPerObject: 347.4, jump1dUsPerObject: 266.9, jump7dUsPerObject: 1707.8 };

const catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(GP))).slice(0, LIMIT);
const sets = catalog.map((o, i) => {
  const epochMs = Date.parse(`${o.EPOCH}Z`);
  const d = new Date(epochMs);
  const day = 1 + (epochMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000;
  const bterm = Math.min(0.1, Math.max(1e-5, Math.abs(Number(o.BSTAR)) * 12.741621));
  const lines = tleLines({ satnum: (1 + i) % 100000, year: d.getUTCFullYear() % 100, day, type: 4, agom: 0.01, bterm,
    inc: Number(o.INCLINATION), raan: Number(o.RA_OF_ASC_NODE), ecc: Number(o.ECCENTRICITY),
    argp: Number(o.ARG_OF_PERICENTER), ma: Number(o.MEAN_ANOMALY), mm: Number(o.MEAN_MOTION), rev: 0 });
  return elementsOf(lines);
});
const JD_UNIX = 2440587.5;
const jdOf = (ms) => {
  const days = ms / 86400000;
  const whole = Math.floor(days) + JD_UNIX;  // integer + 0.5
  return [whole, days - Math.floor(days)];
};

async function run(threads) {
  const module = await openModule({ threads });
  const before = module.memoryBytes();
  let t = performance.now();
  module.init(sets);
  const initMs = performance.now() - t;
  const afterInit = module.memoryBytes();
  const n = sets.length;
  const errors = (p) => p.status.reduce((a, s) => a + (s !== 0 ? 1 : 0), 0);
  // Wall time and this process's CPU time (user + system), both per call: the machine is shared, so CPU time is
  // reported beside wall time and the load average.
  const cpu = { firstUs: 0, stepUs: 0, jump1Us: 0, jump7Us: 0 };
  const cpuNow = () => { const u = process.cpuUsage(); return u.user + u.system; };
  let lastCpu = 0;
  const time = (ms) => { const [w, f] = jdOf(ms); const c0 = cpuNow(); const s = performance.now(); module.atJd(w, f, 0, { raw: true }); const dt = performance.now() - s; lastCpu = cpuNow() - c0; return dt; };

  const firstMs = time(T0);
  cpu.firstUs = lastCpu;
  for (let k = 0; k < 20; k += 1) time(T0);  // warm-up (engine tier-up) at the same time, not timed
  const steps = [];
  for (let k = 1; k <= 10; k += 1) { steps.push(time(T0 + k * 60000)); cpu.stepUs += lastCpu / 10; }
  const stepMs = steps.reduce((a, b) => a + b, 0) / steps.length;
  const jump1Ms = time(T0 + 86400000);
  cpu.jump1Us = lastCpu;
  const jump7Ms = time(T0 + 7 * 86400000);
  cpu.jump7Us = lastCpu;
  const [w, f] = jdOf(T0 + 7 * 86400000);
  const failed = errors(module.atJd(w, f));
  const afterRun = module.memoryBytes();
  const row = {
    threads: module.threads, objects: n,
    storeKibPerObject: +(module.storeBytes() / 1024 / n).toFixed(3), recordBytes: module.recordBytes(),
    memoryGrowthKibPerObjectAtInit: +((afterInit - before) / 1024 / n).toFixed(3),
    memoryGrowthWhilePropagatingBytes: afterRun - afterInit,
    initUsPerObject: +((initMs * 1000) / n).toFixed(2),
    firstPropagationUsPerObject: +((firstMs * 1000) / n).toFixed(3),
    stepMs: +stepMs.toFixed(2), stepUsPerObject: +((stepMs * 1000) / n).toFixed(3),
    jump1dUsPerObject: +((jump1Ms * 1000) / n).toFixed(3), jump7dUsPerObject: +((jump7Ms * 1000) / n).toFixed(3),
    failedAt7d: failed,
    cpuUsPerObject: { step: +(cpu.stepUs / n).toFixed(3), jump1d: +(cpu.jump1Us / n).toFixed(3), jump7d: +(cpu.jump7Us / n).toFixed(3) },
    loadAverage: os.loadavg().map((x) => +x.toFixed(1)),
  };
  module.destroy();
  return row;
}

// SDN-AP as a catalog: the first N objects as SDN-AP sets. The density kernel's memory, CPU per object for jumps of 1,
// 7 and 21 days from the epoch, and the digest of every state (and status) of the 7- and 21-day jumps.
async function runSdnap(threads, n) {
  const module = await openModule({ threads });
  const rows = sets.slice(0, n).map((e) => ({ ...e, theory: 16, bterm: e.bterm ?? 0, agom: e.agom ?? 0.01 }));
  const before = module.memoryBytes();
  module.init(rows);
  const afterInit = module.memoryBytes();
  const cpuNow = () => { const u = process.cpuUsage(); return u.user + u.system; };
  const jump = (days, digest = true) => {
    const [w, f] = jdOf(T0 + days * 86400000);
    const c0 = cpuNow(), t0 = performance.now();
    const p = module.atJd(w, f, 0, { raw: !digest });
    const out = { cpuUsPerObject: +((cpuNow() - c0) / rows.length).toFixed(1), wallUsPerObject: +(((performance.now() - t0) * 1000) / rows.length).toFixed(1) };
    if (digest) {
      const h = createHash("sha256");
      for (const plane of [p.x, p.y, p.z, p.vx, p.vy, p.vz, p.status]) h.update(new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength));
      out.sha256 = h.digest("hex");
      out.failed = p.status.reduce((a, v) => a + (v !== 0 ? 1 : 0), 0);
    }
    return out;
  };
  const jumps = [];
  let afterFirst = afterInit;
  for (const days of SDNAP_DAYS) {
    jumps.push({ days, ...jump(days, true) });
    if (jumps.length === 1) afterFirst = module.memoryBytes();
  }
  const row = { threads: module.threads, objects: rows.length, initGrowthKib: +((afterInit - before) / 1024).toFixed(0),
    firstJumpGrowthKib: +((afterFirst - afterInit) / 1024).toFixed(0), jumps, loadAverage: os.loadavg().map((x) => +x.toFixed(1)) };
  row.growthAfterAllJumpsKib = Math.round((module.memoryBytes() - afterFirst) / 1024);
  module.destroy();
  return row;
}

// The density kernel's memory: one set per regime, jumps of growing span from its epoch in one instance.
async function kernelMemory() {
  const epochMs = Date.parse("2026-10-20T12:00:00Z");
  const [whole, frac] = jdOf(epochMs);
  const out = [];
  for (const [regime, r] of Object.entries(REGIMES)) {
    const module = await openModule({ threads: 0 });
    module.init([{ norad: 90050, theory: 16, epochWhole: whole, epochFrac: frac, meanMotion: r.mm, ecc: r.e, inc: r.i, raan: r.raan, argp: r.argp, ma: r.ma, bterm: 0.012, agom: 0.01 }]);
    const base = module.memoryBytes();
    const growthKibAtDays = {};
    for (const days of [1, 7, 21, 28, 40]) {
      const [w, f] = jdOf(epochMs + days * 86400000);
      module.atJd(w, f, 0, { raw: true });
      growthKibAtDays[days] = Math.round((module.memoryBytes() - base) / 1024);
    }
    module.destroy();
    out.push({ regime, growthKibAtDays });
  }
  return { bEffM2PerKg: 0.012, gridKib: 64.2, gridsPerDay: 9, slots: 252, maxMib: +((252 * 65728) / 1048576).toFixed(1), rows: out };
}

// One SDN-AP set per regime through `propagate` on a 60 s grid: CPU seconds and the digest of the output bytes.
const REGIMES = {
  GEO: { mm: 1.0027, e: 0.0003, i: 0.05, raan: 80, argp: 200, ma: 100 },
  MEO: { mm: 2.0059, e: 0.0005, i: 55, raan: 120, argp: 90, ma: 30 },
  HEO: { mm: 2.0058, e: 0.7, i: 63.4, raan: 40, argp: 270, ma: 10 },
  LEO: { mm: 15.2, e: 0.0008, i: 51.6, raan: 120, argp: 90, ma: 30 },
};
async function longHorizon() {
  const EPOCH = "2026-10-20T12:00:00.000000", epochMs = Date.parse(`${EPOCH}Z`);
  const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
  const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
  const ENV = JSON.parse(fs.readFileSync(process.env.SDNAP_FFM_ENVIRONMENT ?? "/opt/data/sdn-archive/sdn-gp-starlink-ffm-match/environment/environment.json", "utf8"));
  const weather = { portId: "space_weather_table", typeRef: { schemaName: "PRW.fbs", fileIdentifier: "$PRW", rootTypeName: "PRW" }, payload: new Uint8Array(Buffer.from(ENV.inputs.space_weather, "base64")) };
  const base = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
  const command = withConfiguration({ invoke: (req) => base.invoke(req.methodId === "propagate" ? { ...req, inputs: [...req.inputs, weather] } : req) });
  const SDNAP = configuration({ theory: "SDNAP" });
  const BEFF = 0.012;
  const setOf = (r) => {
    const b = new flatbuffers.Builder(256);
    const params = [["SDNAP_B_EFF", String(BEFF)]].map(([k, v]) => OMMUserDefinedParameter.createOMMUserDefinedParameter(b, b.createString(k), b.createString(v)));
    const vec = OMM.createUserDefinedParametersVector(b, params);
    const epoch = b.createString(EPOCH);
    OMM.startOMM(b);
    OMM.addUserDefinedParameters(b, vec);
    OMM.addEpoch(b, epoch);
    OMM.addMeanMotion(b, r.mm); OMM.addEccentricity(b, r.e); OMM.addInclination(b, r.i);
    OMM.addRaOfAscNode(b, r.raan); OMM.addArgOfPericenter(b, r.argp); OMM.addMeanAnomaly(b, r.ma);
    OMM.addNoradCatId(b, 90050); OMM.addMeanElementTheory(b, 4); OMM.addBstar(b, BEFF); OMM.addMeanMotionDdot(b, 0.01);
    OMM.finishOMMBuffer(b, OMM.endOMM(b));
    return b.asUint8Array();
  };
  const rows = [];
  for (const [regime, r] of Object.entries(REGIMES)) {
    const omm = setOf(r);
    const template = (await command.invoke({ methodId: "propagate", inputs: [SDNAP, { portId: "omm", typeRef: ommType, payload: omm }] })).outputs[0].payload;
    for (const days of [1, 7, 21]) {
      const n = days * 1440;
      const t = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(template)).unpack();
      const blk = t.EPHEMERIS_DATA_BLOCK[0];
      blk.START_TIME = blk.STOP_TIME = blk.USEABLE_START_TIME = blk.USEABLE_STOP_TIME = null;
      blk.REFERENCE_FRAME = rfm("TEME", "both");
      blk.EPHEMERIS_DATA_LINES = Array.from({ length: n + 1 }, (_, k) => new ephemerisDataLineT(new Date(epochMs + k * 60000).toISOString().replace("Z", "000"), 0, 0, 0, 0, 0, 0));
      t.EPHEMERIS_DATA_BLOCK = [blk];
      const grid = { portId: "grid", typeRef: oemType, payload: packOem(t) };
      const c0 = process.cpuUsage();
      const res = await command.invoke({ methodId: "propagate", inputs: [SDNAP, { portId: "omm", typeRef: ommType, payload: omm }, grid] });
      const c1 = process.cpuUsage(c0);
      if (res.statusCode !== 0) throw new Error(`${regime} ${days} d: ${res.errorCode} ${res.errorMessage}`);
      const bytes = res.outputs[0].payload;
      rows.push({ regime, days, states: n + 1, cpuSeconds: +((c1.user + c1.system) / 1e6).toFixed(2), outputBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16) });
    }
  }
  return { bEffM2PerKg: BEFF, gridSeconds: 60, wasm: createHash("sha256").update(fs.readFileSync(wasmPath)).digest("hex").slice(0, 12), loadAverage: os.loadavg().map((x) => +x.toFixed(1)), rows };
}

// One process per thread count (each opens the module once; the pool's
// threads live until the process exits).
if (process.argv.includes("--child-sdnap")) {
  console.log(JSON.stringify(await runSdnap(THREADS[0], SDNAP_N)));
  process.exit(0);
}
if (process.argv.includes("--child")) {
  const row = await run(THREADS[0]);
  console.log(JSON.stringify(row));
  process.exit(0);
}
const SKIP_SGP4XP = process.argv.includes("--skip-sgp4xp");
const rows = [];
for (const threads of SKIP_SGP4XP ? [] : THREADS) {
  const args = [fileURLToPath(import.meta.url), "--child", "--threads", String(threads), "--catalog", GP, "--limit", String(LIMIT)];
  const out = execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 24 });
  const row = JSON.parse(out.trim().split("\n").pop());
  row.speedupPerStepVsBaseline = [+(BASELINE.stepMs[0] / row.stepMs).toFixed(1), +(BASELINE.stepMs[1] / row.stepMs).toFixed(1)];
  row.speedupJump7dVsBaseline = +(BASELINE.jump7dUsPerObject / row.jump7dUsPerObject).toFixed(0);
  console.log(JSON.stringify(row));
  rows.push(row);
}
const summary = SKIP_SGP4XP && JSON_OUT && fs.existsSync(JSON_OUT) ? JSON.parse(fs.readFileSync(JSON_OUT, "utf8"))
  : { task: "modules-sdn-gp-propagator-20261023", theory: "SGP4XP as implemented (public base + applied SPEC sections; see README)", baseline: BASELINE, rows };
let failed = false;
if (SDNAP_N > 0) {
  const sdnapRows = [];
  for (const threads of THREADS) {
    const args = [fileURLToPath(import.meta.url), "--child-sdnap", "--threads", String(threads), "--catalog", GP, "--limit", String(LIMIT), "--sdnap", String(SDNAP_N)];
    const row = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 24 }).trim().split("\n").pop());
    console.log(JSON.stringify(row));
    sdnapRows.push(row);
  }
  const same = sdnapRows.every((r) => r.jumps.every((j, k) => j.sha256 === sdnapRows[0].jumps[k].sha256));
  console.log(`SDN-AP catalog, ${SDNAP_N} objects, thread counts ${THREADS.join(", ")}: the ${SDNAP_DAYS.join(", ")}-day states are ${same ? "identical" : "NOT IDENTICAL"} across thread counts`);
  failed ||= !same;
  summary.sdnapCatalog = { objects: SDNAP_N, source: "the first objects of the 2026-10-23 Space-Track GP catalog as SDN-AP sets (theory 16, BTERM from |B*|, AGOM 0.01)", wasm: createHash("sha256").update(fs.readFileSync(wasmPath)).digest("hex").slice(0, 12), identicalAcrossThreadCounts: same, rows: sdnapRows };
}
if (KERNEL_MEMORY) {
  summary.kernelMemory = await kernelMemory();
  for (const r of summary.kernelMemory.rows) console.log(`kernel memory ${r.regime}: growth after ${Object.entries(r.growthKibAtDays).map(([d, k]) => `${d} d ${k} KiB`).join(", ")}`);
}
if (LONG_HORIZON) {
  summary.longHorizon = await longHorizon();
  for (const r of summary.longHorizon.rows) console.log(`${r.regime} ${r.days} d: ${r.cpuSeconds} s CPU, ${r.states} states, ${r.outputBytes} B, sha ${r.sha256}`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 1)}\n`);
process.exit(failed ? 1 : 0);
