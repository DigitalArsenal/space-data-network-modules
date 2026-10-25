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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { openModule } from "./lib/module.mjs";
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

// One process per thread count (each opens the module once; the pool's
// threads live until the process exits).
if (process.argv.includes("--child")) {
  const row = await run(THREADS[0]);
  console.log(JSON.stringify(row));
  process.exit(0);
}
const rows = [];
for (const threads of THREADS) {
  const args = [fileURLToPath(import.meta.url), "--child", "--threads", String(threads), "--catalog", GP, "--limit", String(LIMIT)];
  const out = execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 24 });
  const row = JSON.parse(out.trim().split("\n").pop());
  row.speedupPerStepVsBaseline = [+(BASELINE.stepMs[0] / row.stepMs).toFixed(1), +(BASELINE.stepMs[1] / row.stepMs).toFixed(1)];
  row.speedupJump7dVsBaseline = +(BASELINE.jump7dUsPerObject / row.jump7dUsPerObject).toFixed(0);
  console.log(JSON.stringify(row));
  rows.push(row);
}
const summary = { task: "modules-sdn-gp-propagator-20261023", theory: "SGP4XP as implemented (public base + applied SPEC sections; see README)", baseline: BASELINE, rows };
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 1)}\n`);
