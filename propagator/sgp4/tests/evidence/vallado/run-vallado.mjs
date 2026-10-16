// Vallado's SGP4 verification set against propagator/sgp4.
//
//   node tests/evidence/vallado/run-vallado.mjs [--data <dir>] [--out <dir>]
//
// --data holds SGP4-VER.TLE and tcppver.out as python-sgp4 2.27 ships them
// (tools.json pins the sdist). The script compiles sgp4_vallado_native.cpp
// against the module's src/cpp/src/SGP4.cpp into --out (default: a temporary
// directory) and writes summary-vallado.json beside itself.
//
// Rows, at every time tcppver.out prints (33 sets, TEME, km and km/s):
//   source     the module's SGP4.cpp, native, on Vallado's own path
//              (twoline2rv, WGS-72, opsmode 'i') against tcppver.out;
//   afspc      the same with opsmode 'a', for the record;
//   elements   the module's path (OMM text -> one Julian-date double ->
//              sgp4init) against Vallado's path, both native, at the tsince
//              the module uses: element and epoch rounding;
//   fastMath   Vallado's path compiled with -O3 -ffast-math (the wasm's
//              flags) against the same without it, both native;
//   emccFast   Vallado's path compiled to wasm by emcc with the module's
//              CMake flags (-O3 -flto -ffast-math -msimd128) against the
//              native path without fast-math (skipped without emcc);
//   emccStrict the same wasm build without -ffast-math against the native
//              path: what the module's flags change, isolated;
//   build      the shipped wasm through propagate_state (TEME) against the
//              native module path at the same request: the build;
//   module     the shipped wasm against Vallado's path at the tsince the
//              module uses (the request's Julian date less the set's epoch,
//              both doubles);
//   timeOnly   Vallado's path at that tsince against Vallado's path at the
//              intended tsince: the request time's rounding alone;
//   wasm       the shipped wasm against tcppver.out at the request
//              epoch_jd + tsince / 1440 (one double, as a host forms it).
// Error codes: Vallado's path must stop where tcppver.out stops, with the
// codes python-sgp4's own tcppver test expects; the wasm must refuse a set
// that fails at its epoch and flag the state invalid at the stopping time.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { invokePiv, loadRawSgp4Module } from "../../lib/pivInvokeHelper.mjs";
import {
  ReferenceFrame,
  decodePropagatorState,
  encodeOmmPayload,
  encodePropagatorBatchRequest,
} from "../../lib/payloadEncoders.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "../../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const dataDir = arg("--data", "/Users/tj/software/tools/xval/sgp4-vallado/src/sgp4-2.27/sgp4");
const outDir = arg("--out", fs.mkdtempSync(path.join(os.tmpdir(), "sgp4-vallado-")));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// python-sgp4's test_legacy_against_tcppver: the error codes, in order, that
// Vallado's code returns while generating tcppver.out.
const EXPECTED_ERRORS = [1, 1, 6, 6, 4, 3, 6];
// tcppver.out prints positions with %16.8f km and velocities with %12.9f km/s.
const PRINT_R_KM = 5e-9;
const PRINT_V_KMS = 5e-10;

// ---------------------------------------------------------------- inputs
const tleText = fs.readFileSync(path.join(dataDir, "SGP4-VER.TLE"), "latin1").replace(/\r/g, "");
const verText = fs.readFileSync(path.join(dataDir, "tcppver.out"), "latin1").replace(/\r/g, "");

const sets = [];
{
  const lines = tleText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("1 ")) sets.push({ line1: lines[i], line2: lines[i + 1] });
  }
}
const blocks = [];
for (const line of verText.split("\n")) {
  if (/^\s*\d+ xx\s*$/.test(line)) blocks.push({ satnum: Number(line.trim().split(/\s+/)[0]), rows: [] });
  else if (line.trim()) {
    const f = line.trim().split(/\s+/).slice(0, 7).map(Number);
    blocks.at(-1).rows.push({ tsince: f[0], r: f.slice(1, 4), v: f.slice(4, 7) });
  }
}
if (sets.length !== blocks.length) throw new Error(`${sets.length} sets, ${blocks.length} tcppver blocks`);

// The time grid of python-sgp4's generate_satellite_output (and testcpp):
// t = 0, then start..stop by step (t = 0 not twice), then stop if missed.
function grid(line2) {
  const [tstart, tend, tstep] = line2.slice(69).trim().split(/\s+/).map(Number);
  const times = [0];
  let t = tstart;
  while (t <= tend) {
    if (!(t === tstart && tstart === 0)) times.push(t);
    t += tstep;
  }
  if (t - tend < tstep - 1e-6) times.push(tend);
  return times;
}

// An OMM from the TLE text, decimal-exact: the epoch's seconds are the day
// fraction times 86400 written out in full.
function ommFromTle({ line1, line2 }) {
  const yy = Number(line1.slice(18, 20));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const [dayText, fracText = "0"] = line1.slice(20, 32).trim().split(".");
  const doy = Number(dayText);
  const date = new Date(Date.UTC(year, 0, doy));
  const scaled = BigInt(fracText) * 86400n;
  const unit = 10n ** BigInt(fracText.length);
  const whole = scaled / unit;
  const rest = (scaled % unit).toString().padStart(fracText.length, "0");
  const hh = whole / 3600n, mm = (whole % 3600n) / 60n, ss = whole % 60n;
  const two = (x) => x.toString().padStart(2, "0");
  const iso = `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}T${two(hh)}:${two(mm)}:${two(ss)}.${rest}`;
  const expo = (text) => {
    const s = text.trim();
    const sign = s[0] === "-" ? "-" : "";
    const body = s.replace(/^[+-]/, "");
    const m = body.match(/^(\d+)([+-]\d)$/);
    return Number(`${sign}0.${m[1]}e${m[2]}`);
  };
  return {
    noradId: Number(line1.slice(2, 7)),
    epoch: iso,
    meanMotionDot: Number(line1.slice(33, 43).trim()),
    meanMotionDdot: expo(line1.slice(44, 52)),
    bstar: expo(line1.slice(53, 61)),
    inclination: Number(line2.slice(8, 16)),
    raan: Number(line2.slice(17, 25)),
    eccentricity: Number(`0.${line2.slice(26, 33).trim()}`),
    argPericenter: Number(line2.slice(34, 42)),
    meanAnomaly: Number(line2.slice(43, 51)),
    meanMotion: Number(line2.slice(52, 63)),
  };
}

// ---------------------------------------------------------------- native oracle
const exe = path.join(outDir, "sgp4_vallado_native");
const exeFast = path.join(outDir, "sgp4_vallado_native_fastmath");
const compiler = "/usr/bin/clang++";
const sources = [`-I${path.join(pkg, "src/cpp/src")}`, path.join(here, "sgp4_vallado_native.cpp"), path.join(pkg, "src/cpp/src/SGP4.cpp"), "-w"];
const compileArgs = ["-std=c++17", "-O2", "-ffp-contract=off", ...sources, "-o", exe];
const compileFastArgs = ["-std=c++17", "-O3", "-ffast-math", ...sources, "-o", exeFast];
execFileSync(compiler, compileArgs);
execFileSync(compiler, compileFastArgs);
const emcc = spawnSync("emcc", ["--version"]).status === 0 ? "emcc" : null;
const emccFlags = { emccFast: ["-O3", "-flto", "-ffast-math", "-msimd128"], emccStrict: ["-O3", "-flto", "-msimd128"] };
const emccBuilds = {};
if (emcc) {
  for (const [key, flags] of Object.entries(emccFlags)) {
    const js = path.join(outDir, `sgp4_vallado_${key}.js`);
    execFileSync(emcc, ["-std=c++17", ...flags, ...sources, "-sENVIRONMENT=node", "-sNODERAWFS=1", "-o", js]);
    emccBuilds[key] = [process.execPath, js];
  }
}
const emccVersion = emcc ? execFileSync(emcc, ["--version"]).toString().split("\n")[0] : null;
const compilerVersion = execFileSync(compiler, ["--version"]).toString().split("\n")[0];

function native(script, binary = exe) {
  const [cmd, ...cmdArgs] = Array.isArray(binary) ? binary : [binary];
  const run = spawnSync(cmd, cmdArgs, { input: script, maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`native harness: ${run.stderr}`);
  const out = [];
  let cur = null;
  for (const line of run.stdout.toString().split("\n")) {
    const f = line.split(" ");
    if (f[0] === "E") { cur = { init: 0, method: f.at(-1), epoch: f.slice(1, -1).map(Number), samples: [] }; out.push(cur); }
    else if (f[0] === "I") { cur = { init: Number(f[1]), samples: [] }; out.push(cur); }
    else if (f[0] === "S") {
      const n = f.slice(1).map(Number);
      cur.samples.push({ tsince: n[0], requestJd: n[1], tsinceUsed: n[2], error: n[3], r: n.slice(4, 7), v: n.slice(7, 10) });
    }
  }
  return out;
}
const fmt = (x) => (Object.is(x, -0) ? "-0" : String(x));
const vallado = (set, opsmode, times) => `V ${opsmode}\n${set.line1}\n${set.line2}\nT ${times.map(fmt).join(" ")}\n`;
const modulePath = (o, times) =>
  `M ${o.noradId} ${o.epoch} ${[o.meanMotion, o.eccentricity, o.inclination, o.raan, o.argPericenter, o.meanAnomaly, o.bstar, o.meanMotionDot, o.meanMotionDdot].map(fmt).join(" ")}\nT ${times.map(fmt).join(" ")}\n`;

// ---------------------------------------------------------------- per set
const sub = (a, b) => a.map((x, i) => x - b[i]);
const norm = (a) => Math.hypot(...a);
const maxAbs = (a) => Math.max(...a.map(Math.abs));
const OMM_TYPE = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const PROP_TYPE = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };

const perSet = [];
const errorsSeen = [];
for (let k = 0; k < sets.length; k++) {
  const set = sets[k];
  const block = blocks[k];
  const omm = ommFromTle(set);
  const times = grid(set.line2);
  const printed = block.rows.length;
  const record = { satnum: block.satnum, line1: set.line1, line2: set.line2, omm, tcppverRows: printed, gridTimes: times.length };

  const src = native(vallado(set, "i", times))[0];
  record.method = src.method ?? null;
  if (src.init !== 0) {
    // tcppver.out repeats the previous data line for a set that fails to start.
    errorsSeen.push(src.init);
    record.vallado = { initError: src.init };
  } else {
    // Vallado's path must print exactly tcppver's rows, then stop on an error.
    const stop = src.samples.findIndex((s) => s.error !== 0);
    const valid = stop < 0 ? src.samples : src.samples.slice(0, stop);
    if (stop >= 0) errorsSeen.push(src.samples[stop].error);
    if (valid.length !== printed) throw new Error(`${block.satnum}: ${valid.length} valid samples, tcppver prints ${printed}`);
    for (let i = 0; i < printed; i++) {
      if (Math.abs(valid[i].tsince - block.rows[i].tsince) > 5e-9) throw new Error(`${block.satnum}: time ${valid[i].tsince} vs ${block.rows[i].tsince}`);
    }
    record.vallado = { stopError: stop >= 0 ? src.samples[stop].error : 0, stopTsince: stop >= 0 ? src.samples[stop].tsince : null };
    const afspc = native(vallado(set, "a", valid.map((s) => s.tsince)))[0];
    const row = (s, ref) => ({ dr: sub(s.r, ref.r), dv: sub(s.v, ref.v) });
    record.source = valid.map((s, i) => row(s, block.rows[i]));
    record.afspc = afspc.samples.map((s, i) => row(s, block.rows[i]));
    const fast = native(vallado(set, "i", valid.map((s) => s.tsince)), exeFast)[0];
    record.fastMath = fast.samples.map((s, i) => row(s, valid[i]));
    for (const [key, command] of Object.entries(emccBuilds)) {
      const w = native(vallado(set, "i", valid.map((s) => s.tsince)), command)[0];
      record[key] = w.samples.map((s, i) => row(s, valid[i]));
    }

    const askTimes = stop >= 0 ? src.samples.slice(0, stop + 1).map((s) => s.tsince) : valid.map((s) => s.tsince);
    const mod = native(modulePath(omm, askTimes))[0];
    if (mod.init !== 0) throw new Error(`${block.satnum}: module path refuses (${mod.init}) where Vallado's starts`);
    record.moduleEpoch = { ommEpochJd: mod.epoch[0], jdsatepoch: mod.epoch[1], jdsatepochF: mod.epoch[2], valladoJdsatepoch: src.epoch[0], valladoJdsatepochF: src.epoch[1] };
    const atUsed = native(vallado(set, "i", mod.samples.map((s) => s.tsinceUsed)))[0];
    record.elements = mod.samples.slice(0, printed).map((s, i) => row(s, atUsed.samples[i]));
    record.timeOnly = atUsed.samples.slice(0, printed).map((s, i) => row(s, valid[i]));
    // The epoch the module keeps (jdsatepoch + jdsatepochF after one double)
    // against Vallado's split epoch, in seconds.
    record.epochRoundingSeconds = (((mod.epoch[1] + mod.epoch[2]) - src.epoch[0]) - src.epoch[1]) * 86400;
    record.timeShiftSeconds = mod.samples.slice(0, printed).map((s, i) => (s.tsinceUsed - valid[i].tsince) * 60);

    // The wasm: one fresh instance per set (two sets share NORAD 20413).
    const module = await loadRawSgp4Module();
    try {
      const ingest = invokePiv(module, { methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: OMM_TYPE, payload: encodeOmmPayload({ ...omm, objectId: "VALLADO", objectName: `SGP4-VER ${omm.noradId}` }) }] });
      if (ingest.response.STATUS_CODE !== 0) throw new Error(`${block.satnum}: ingest refused: ${ingest.response.ERROR_MESSAGE}`);
      const wasm = mod.samples.map((s) => {
        const res = invokePiv(module, {
          methodId: "propagate_state",
          inputs: [{ portId: "request", typeRef: PROP_TYPE, payload: encodePropagatorBatchRequest({ epoch: s.requestJd, catalogNumbers: [omm.noradId], outputFrame: ReferenceFrame.TEME }) }],
          outputStreamCap: 1,
        });
        if (res.response.STATUS_CODE !== 0) return { status: res.response.STATUS_CODE, message: res.response.ERROR_MESSAGE, valid: false };
        const st = decodePropagatorState(res.outputPayloads[0].bytes);
        return { status: 0, valid: st.valid, r: st.position.map((x) => x / 1000), v: st.velocity.map((x) => x / 1000) };
      });
      record.wasmStop = stop >= 0 ? { valid: wasm[printed].valid, status: wasm[printed].status, message: wasm[printed].message ?? null } : null;
      for (let i = 0; i < printed; i++) if (!wasm[i].valid) throw new Error(`${block.satnum}: wasm state invalid at ${valid[i].tsince} min`);
      record.build = wasm.slice(0, printed).map((w, i) => row(w, mod.samples[i]));
      record.module = wasm.slice(0, printed).map((w, i) => row(w, atUsed.samples[i]));
      record.wasm = wasm.slice(0, printed).map((w, i) => row(w, block.rows[i]));
    } finally {
      module._plugin_destroy();
    }
  }
  perSet.push(record);
}

// Sets that fail at their epoch: the wasm must refuse them at ingestion.
for (const record of perSet.filter((r) => r.vallado.initError)) {
  const module = await loadRawSgp4Module();
  try {
    const ingest = invokePiv(module, { methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: OMM_TYPE, payload: encodeOmmPayload({ ...record.omm, objectId: "VALLADO", objectName: `SGP4-VER ${record.omm.noradId}` }) }] });
    const res = invokePiv(module, {
      methodId: "propagate_state",
      inputs: [{ portId: "request", typeRef: PROP_TYPE, payload: encodePropagatorBatchRequest({ epoch: 2451545, catalogNumbers: [record.omm.noradId], outputFrame: ReferenceFrame.TEME }) }],
      outputStreamCap: 1,
    });
    record.wasmIngest = { status: ingest.response.STATUS_CODE, message: ingest.response.ERROR_MESSAGE ?? null, propagateStatus: res.response.STATUS_CODE, propagateMessage: res.response.ERROR_MESSAGE ?? null };
  } finally {
    module._plugin_destroy();
  }
}

// ---------------------------------------------------------------- scoring
const KEYS = ["source", "afspc", "fastMath", "emccFast", "emccStrict", "elements", "build", "module", "timeOnly", "wasm"];
function score(records) {
  const out = {};
  for (const key of KEYS) {
    let r3 = 0, v3 = 0, rc = 0, vc = 0, n = 0, worst = null;
    for (const rec of records) for (const [i, d] of (rec[key] ?? []).entries()) {
      n++;
      const a = norm(d.dr), b = norm(d.dv);
      if (a > r3) { r3 = a; worst = { satnum: rec.satnum, tsince: rec.source[i] ? blocks[perSet.indexOf(rec)].rows[i].tsince : null }; }
      v3 = Math.max(v3, b); rc = Math.max(rc, maxAbs(d.dr)); vc = Math.max(vc, maxAbs(d.dv));
    }
    const beyond = records.flatMap((rec) => (rec[key] ?? []).filter((d) => maxAbs(d.dr) > PRINT_R_KM || maxAbs(d.dv) > PRINT_V_KMS)).length;
    out[key] = { samples: n, maxPosition3dM: r3 * 1000, maxVelocity3dMs: v3 * 1000, maxPositionComponentKm: rc, maxVelocityComponentKms: vc, samplesBeyondPrinting: beyond, worst };
  }
  return out;
}
const started = perSet.filter((r) => !r.vallado.initError);
const regimes = {
  "near-Earth (SGP4)": started.filter((r) => r.method === "n"),
  "deep space (SDP4)": started.filter((r) => r.method === "d"),
  all: started,
};
const tables = Object.fromEntries(Object.entries(regimes).map(([k, v]) => [k, { sets: v.length, ...score(v) }]));
const shifts = started.flatMap((r) => r.timeShiftSeconds);
const errorCheck = {
  expected: EXPECTED_ERRORS,
  vallado: errorsSeen,
  match: JSON.stringify(errorsSeen) === JSON.stringify(EXPECTED_ERRORS),
  wasmStops: started.filter((r) => r.wasmStop).map((r) => ({ satnum: r.satnum, tsince: r.vallado.stopTsince, code: r.vallado.stopError, wasmValid: r.wasmStop.valid, status: r.wasmStop.status, message: r.wasmStop.message })),
  wasmRefusals: perSet.filter((r) => r.vallado.initError).map((r) => ({ satnum: r.satnum, code: r.vallado.initError, ...r.wasmIngest })),
};
const withinPrint = (k) => tables.all[k].maxPositionComponentKm <= PRINT_R_KM && tables.all[k].maxVelocityComponentKms <= PRINT_V_KMS;

const summary = {
  about: "Vallado's SGP4 verification set (SGP4-VER.TLE, tcppver.out) against propagator/sgp4: TEME km and km/s at every time tcppver.out prints. Generated by run-vallado.mjs; rows explained in its header.",
  inputs: {
    "SGP4-VER.TLE": sha256(path.join(dataDir, "SGP4-VER.TLE")),
    "tcppver.out": sha256(path.join(dataDir, "tcppver.out")),
  },
  module: {
    version: JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version,
    "dist/browser/module.wasm": sha256(path.join(pkg, "dist/browser/module.wasm")),
    "dist/isomorphic/module.wasm": sha256(path.join(pkg, "dist/isomorphic/module.wasm")),
    "src/cpp/src/SGP4.cpp": sha256(path.join(pkg, "src/cpp/src/SGP4.cpp")),
  },
  native: { compiler: compilerVersion, flags: compileArgs.filter((a) => a.startsWith("-") && !a.startsWith("-I") && a !== "-o"), fastMathFlags: compileFastArgs.filter((a) => a.startsWith("-") && !a.startsWith("-I") && a !== "-o"), emcc: emccVersion, emccFlags: emcc ? emccFlags : null, harnessSha256: sha256(path.join(here, "sgp4_vallado_native.cpp")) },
  printing: { positionKm: PRINT_R_KM, velocityKms: PRINT_V_KMS },
  tables,
  sourceWithinPrinting: withinPrint("source"),
  afspcWithinPrinting: withinPrint("afspc"),
  requestTimeShiftSeconds: { maxAbs: Math.max(...shifts.map(Math.abs)) },
  epochRoundingSeconds: { maxAbs: Math.max(...started.map((r) => Math.abs(r.epochRoundingSeconds))) },
  errors: errorCheck,
  sets: perSet.map((r) => ({
    satnum: r.satnum, method: r.method, rows: r.tcppverRows, ...r.vallado,
    epochIso: r.omm.epoch,
    moduleEpoch: r.moduleEpoch ?? null,
    maxTimeShiftSeconds: r.timeShiftSeconds ? Math.max(...r.timeShiftSeconds.map(Math.abs)) : null,
    epochRoundingSeconds: r.epochRoundingSeconds ?? null,
    ...Object.fromEntries(KEYS.filter((k) => r[k]).map((k) => [k, {
      position3dM: Math.max(...r[k].map((d) => norm(d.dr))) * 1000,
      velocity3dMs: Math.max(...r[k].map((d) => norm(d.dv))) * 1000,
    }])),
  })),
};
fs.writeFileSync(path.join(here, "summary-vallado.json"), JSON.stringify(summary, null, 1) + "\n");

const mm = (m) => (m >= 1 ? `${m.toFixed(3)} m` : m >= 1e-3 ? `${(m * 1e3).toFixed(3)} mm` : `${(m * 1e6).toFixed(3)} um`);
for (const [k, t] of Object.entries(tables)) {
  console.log(`${k} (${t.sets} sets)`);
  for (const key of KEYS) console.log(`  ${key.padEnd(10)} ${String(t[key].samples).padStart(4)} samples  r ${mm(t[key].maxPosition3dM).padStart(12)}  v ${(t[key].maxVelocity3dMs).toExponential(2)} m/s  beyond print ${t[key].samplesBeyondPrinting}  worst ${JSON.stringify(t[key].worst)}`);
}
console.log("errors", JSON.stringify(errorCheck));
console.log("time shift max", summary.requestTimeShiftSeconds.maxAbs, "s; epoch rounding max", summary.epochRoundingSeconds.maxAbs, "s; source within printing", summary.sourceWithinPrinting, "afspc", summary.afspcWithinPrinting);
