#!/usr/bin/env node
// E2E (task modules-sdn-ap-epoch-store-blend-20261025): the epoch store (SPEC 14).
// Synthetic history: an SDN-AP series (opm_set of an SGP4XP trajectory's states every 6 h over 3 days, each with a
// COVARIANCE), an SGP4 series (sets every 12 h), an aged set and a same-epoch duplicate, loaded by load_epochs.
// - The load's counts: records, kept, aged, duplicates; MAX_SETS_PER_OBJECT and THEORIES applied.
// - Selection against brute force over 400 times (NEAREST and LATEST_BEFORE): the dominant set (the blend weight
//   below 1/2: a, else b) is the nearest set, or the latest at or before the time.
// - Every handover, SMOOTHSTEP and HERMITE, NEAREST and LATEST_BEFORE, sampled every second across its window: no
//   position or velocity discontinuity (the velocity against the central difference of the positions, the second
//   difference of the velocity), where the same switch without a blend jumps by the sets' difference.
// - The covariance inside a window is symmetric and positive definite.
// - propagate_epochs (a snapshot given with the call) gives the resident store's states bit for bit.
// Real history (local; Space-Track GP daily snapshots, licensed: nothing written but these numbers): seven days of the
// catalog loaded, the store's bytes per series measured, selection against brute force and continuity across a
// handover on a sample. Without the archive the real part prints NOT MEASURED.
// JS only moves bytes and compares numbers the module produced.
//   node test/epoch-store.e2e.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { OPM, OPMT } from "spacedatastandards.org/lib/js/OPM/OPM.js";
import { pcfTheory } from "spacedatastandards.org/lib/js/PCF/pcfTheory.js";
import { jdOf, rfm } from "./lib/frames.mjs";
import { openModule, wasmPath } from "./lib/module.mjs";
import { configuration } from "./lib/pcf.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const m = await openModule();
const x = m.x, mem = () => m.harness.memory.buffer;
const command = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const ommType = { schemaName: "OMM.fbs", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const oemType = { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM" };
const opmType = { schemaName: "OPM.fbs", fileIdentifier: "$OPM", rootTypeName: "OPM" };
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().replace("Z", "");
const T0 = Date.parse("2026-10-20T00:00:00Z");
const prefixed = (plain) => { const b = Buffer.alloc(4 + plain.length); b.writeUInt32LE(plain.length, 0); Buffer.from(plain).copy(b, 4); return b; };
const stream = (records) => new Uint8Array(Buffer.concat(records));
const store = (cfg) => configuration({ epochStore: cfg });

// --- the synthetic history
function gridOem(frame, times) {
  const block = new ephemerisDataBlockT();
  block.CENTER_NAME = "EARTH"; block.REFERENCE_FRAME = rfm(frame); block.TIME_SYSTEM = timingStandard.UTC;
  block.START_TIME = iso(times[0]); block.STOP_TIME = iso(times.at(-1));
  block.EPHEMERIS_DATA_LINES = times.map((t) => new ephemerisDataLineT(iso(t)));
  const o = new OEMT(); o.CCSDS_OEM_VERS = 3.0; o.ORIGINATOR = "SDN-AP epoch store E2E"; o.EPHEMERIS_DATA_BLOCK = [block];
  const b = new flatbuffers.Builder(1 << 16); OEM.finishOEMBuffer(b, o.pack(b));
  return b.asUint8Array();
}
const truthSet = (() => {
  const b = new flatbuffers.Builder(256);
  const e = b.createString(iso(T0 - DAY));
  OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addMeanMotion(b, 15.5); OMM.addEccentricity(b, 0.0011); OMM.addInclination(b, 51.6);
  OMM.addRaOfAscNode(b, 120); OMM.addArgOfPericenter(b, 90); OMM.addMeanAnomaly(b, 30); OMM.addBstar(b, 0.02); OMM.addMeanMotionDdot(b, 0.01);
  OMM.addNoradCatId(b, 90011); OMM.addMeanElementTheory(b, 1);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array();
})();
const epochs6h = Array.from({ length: 13 }, (_, k) => T0 + k * 6 * 3600000);
const truth = await command.invoke({ methodId: "propagate", inputs: [configuration({}), { portId: "omm", typeRef: ommType, payload: truthSet }, { portId: "grid", typeRef: oemType, payload: gridOem("TEME", [T0 - 8 * DAY, ...epochs6h]) }] });
if (truth.statusCode !== 0) throw new Error(`truth: ${truth.errorCode} ${truth.errorMessage}`);
const truthLines = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(truth.outputs[0].payload)).unpack().EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
const COV = [1e-2, 1e-3, 2e-2, 1e-4, 2e-4, 3e-2, 1e-6, 2e-6, 3e-6, 1e-8, 2e-6, 1e-6, 4e-6, 1e-9, 2e-8, 3e-6, 2e-6, 1e-6, 1e-9, 1e-9, 3e-8];
async function sdnapSet(L, extra = {}) {
  const t = Object.assign(new OPMT(), { CCSDS_OPM_VERS: "2.0", ORIGINATOR: "SDN-AP E2E", OBJECT_NAME: "EPOCH STORE E2E", OBJECT_ID: "2026-911A", CENTER_NAME: "EARTH", REF_FRAME: "TEME",
    TIME_SYSTEM: "UTC", EPOCH: L.EPOCH, X: L.X, Y: L.Y, Z: L.Z, X_DOT: L.X_DOT, Y_DOT: L.Y_DOT, Z_DOT: L.Z_DOT, GM: 398600.4418, COV_REF_FRAME: "TEME", COVARIANCE: COV, ...extra });
  const b = new flatbuffers.Builder(1024); OPM.finishSizePrefixedOPMBuffer(b, t.pack(b));
  const r = await command.invoke({ methodId: "opm_set", inputs: [configuration({ theory: "SDNAP" }), { portId: "opm", typeRef: opmType, payload: b.asUint8Array() }] });
  if (r.statusCode !== 0) throw new Error(`opm_set: ${r.errorCode} ${r.errorMessage}`);
  // the set as the sync module carries it: NORAD number added (the $OPM has none)
  const o = OMM.getRootAsOMM(new flatbuffers.ByteBuffer(r.outputs[0].payload)).unpack();
  o.NORAD_CAT_ID = 90011;
  const bb = new flatbuffers.Builder(4096); OMM.finishOMMBuffer(bb, o.pack(bb));
  return bb.asUint8Array();
}
const sdnapRecords = [];
for (const L of truthLines) sdnapRecords.push(prefixed(await sdnapSet(L)));
sdnapRecords.push(prefixed(await sdnapSet(truthLines[5])));  // a same-epoch duplicate of set 4
const sgp4Records = Array.from({ length: 7 }, (_, k) => {
  const b = new flatbuffers.Builder(256);
  const e = b.createString(iso(T0 + k * 12 * 3600000)), id = b.createString("1998-067A"), orig = b.createString("18 SPCS");
  OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addObjectId(b, id); OMM.addOriginator(b, orig);
  OMM.addMeanMotion(b, 15.49 + 1e-4 * k); OMM.addEccentricity(b, 0.0005); OMM.addInclination(b, 51.64); OMM.addRaOfAscNode(b, 200 - 2.5 * k);
  OMM.addArgOfPericenter(b, 80); OMM.addMeanAnomaly(b, (40 + 268.2 * k) % 360); OMM.addBstar(b, 1e-4); OMM.addNoradCatId(b, 25544); OMM.addMeanElementTheory(b, 0);
  OMM.finishSizePrefixedOMMBuffer(b, OMM.endOMM(b));
  return Buffer.from(b.asUint8Array());
});
const snapshot = { portId: "omm", typeRef: ommType, payload: stream([...sgp4Records, ...sdnapRecords]) };
const load = async (cfg) => {
  const r = await m.harness.invoke({ methodId: "load_epochs", inputs: [store(cfg), snapshot] });
  if (r.statusCode !== 0) throw new Error(`load_epochs: ${r.errorCode} ${r.errorMessage}`);
};
const p = x.sdnap_alloc(1 << 20), f64 = (o, n) => new Float64Array(mem(), p + o, n);
const stats = () => { x.sdnap_epochs_stats(p); return Array.from(f64(0, 8)); };
const seriesOf = (i) => { x.sdnap_epochs_series(i, p, p + 64, 4096); const info = Array.from(f64(0, 3)); return { norad: info[0], theory: info[1], epochs: Array.from({ length: info[2] }, (_, k) => { const w = f64(64 + 16 * k, 2); return (w[0] - 2440587.5 + w[1]) * DAY; }) }; };
const at = (i, t, withCov = false) => {
  const j = jdOf(iso(t)), out = p + 1024, st = p + 2048, cov = p + 4096;
  x.sdnap_epochs_at(j.whole, j.frac, i, 1, 0, out, st, withCov ? cov : 0);
  const o = Array.from(new Float64Array(mem(), out, 6));
  return { r: o.slice(0, 3), v: o.slice(3), status: new Int32Array(mem(), st, 1)[0], P: withCov ? Array.from(new Float64Array(mem(), cov, 36)) : null };
};
const select = (i, t) => { const j = jdOf(iso(t)); x.sdnap_epochs_select(i, j.whole, j.frac, p); return Array.from(f64(0, 3)); };

// --- load, counts
await load({});
{
  const [records, kept, aged, capped, theory, segment, duplicate, bytes] = stats();
  console.log(`load_epochs: ${records} records, ${kept} kept, ${aged} aged out, ${duplicate} duplicate replaced, ${x.sdnap_epochs_count()} series, ${bytes} bytes`);
  check(records === 7 + 15 && kept === 7 + 13 && aged === 1 && duplicate === 1 && capped === 0 && theory === 0 && segment === 0 && x.sdnap_epochs_count() === 2, `counts ${stats()}`);
  await load({ MAX_SETS_PER_OBJECT: 3, THEORIES: [pcfTheory.SGP4] });
  const s2 = stats();
  check(x.sdnap_epochs_count() === 1 && s2[1] === 3 && s2[3] === 4 && s2[4] === 15, `cap and theories: ${s2}`);
  console.log(`MAX_SETS_PER_OBJECT 3, THEORIES [SGP4]: ${x.sdnap_epochs_count()} series, ${s2[1]} kept, ${s2[3]} capped, ${s2[4]} by theory`);
}

// --- selection against brute force; continuity across every handover
let seed = 7;
const u = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const norm = (a) => Math.hypot(...a);
const sub = (a, b) => a.map((v, k) => v - b[k]);
const setAt = (i, k, t) => { const j = jdOf(iso(t)), o = p + 8192; x.sdnap_epochs_set_at(i, k, j.whole, j.frac, o); const v = Array.from(new Float64Array(mem(), o, 6)); return { r: v.slice(0, 3), v: v.slice(3) }; };
// The residual of a state source: its velocity less its positions' central difference over +-1 ms (a theory's velocity
// is not exactly its position's derivative). Across a window [t0, t1] of the switch from set a to set b, every `step`:
// the blend's residual against the sets' own (SMOOTHSTEP: (1 - w) e_a + w e_b; HERMITE: e_a), so the blend adds none
// of its own (what remains, tens of micrometers over 2 ms, is the theory's own interpolation); and at both edges the
// change over +-1 ms against the change of the set in force there.
function residual(f, t) { const a = f(t - 1), b = f(t + 1), c = f(t); return sub(c.v, sub(b.r, a.r).map((d) => d / 0.002)); }
function continuity(i, t0, t1, shape, step = 10000) {
  let deriv = 0, rJump = 0, vJump = 0;
  for (let t = t0; t <= t1; t += step) {
    const [a, b, w] = select(i, t);
    const eBlend = residual((q) => at(i, q), t);
    const eA = residual((q) => setAt(i, a, q), t);
    const eB = b >= 0 ? residual((q) => setAt(i, b, q), t) : eA;
    const expect = shape === 1 || b < 0 ? eA : eA.map((v, c) => (1 - w) * v + w * eB[c]);
    deriv = Math.max(deriv, norm(sub(eBlend, expect)));
  }
  // the edges: the change over +-1 ms against the change of the set in force there (a at t0, b at t1), whose own motion
  // it must be (a jump would add to it)
  const [ia, ib] = select(i, (t0 + t1) / 2);
  for (const [e, k] of [[t0, ia], [t1, ib]]) {
    const a = at(i, e - 1), b = at(i, e + 1), sa = setAt(i, k, e - 1), sb = setAt(i, k, e + 1);
    rJump = Math.max(rJump, norm(sub(sub(b.r, a.r), sub(sb.r, sa.r))));
    vJump = Math.max(vJump, norm(sub(sub(b.v, a.v), sub(sb.v, sa.v))));
  }
  return { deriv, rJump, vJump };
}
for (const [label, cfg] of [["NEAREST, SMOOTHSTEP", {}], ["NEAREST, HERMITE", { BLEND_SHAPE: 1 }], ["LATEST_BEFORE, SMOOTHSTEP", { SELECTION: 1 }], ["LATEST_BEFORE, HERMITE", { SELECTION: 1, BLEND_SHAPE: 1 }]]) {
  await load(cfg);
  let mismatched = 0, deriv = 0, rJump = 0, vJump = 0, handovers = 0, unblendedR = 0, unblendedV = 0;
  for (let i = 0; i < x.sdnap_epochs_count(); ++i) {
    const s = seriesOf(i), E = s.epochs;
    for (let n = 0; n < 200; ++n) {
      const t = E[0] - DAY / 2 + u() * (E.at(-1) - E[0] + DAY);
      const [a, b, w] = select(i, t);
      const dominant = b >= 0 && w >= 0.5 ? b : a;
      let brute;
      if (cfg.SELECTION === 1) { brute = 0; E.forEach((e, k) => { if (e <= t) brute = k; }); }
      else { brute = 0; E.forEach((e, k) => { if (Math.abs(e - t) <= Math.abs(E[brute] - t)) brute = k; }); }
      if (dominant !== brute) ++mismatched;
    }
    for (let k = 0; k + 1 < E.length; ++k) {
      const tau = cfg.SELECTION === 1 ? E[k + 1] : (E[k] + E[k + 1]) / 2;
      const h = Math.min(1800000, (E[k + 1] - E[k]) / 2, cfg.SELECTION === 1 && k + 2 < E.length ? (E[k + 2] - E[k + 1]) / 2 : Infinity);
      const c = continuity(i, tau - h, tau + h, cfg.BLEND_SHAPE ?? 0);
      deriv = Math.max(deriv, c.deriv); rJump = Math.max(rJump, c.rJump); vJump = Math.max(vJump, c.vJump); ++handovers;
    }
  }
  // the same switches without a blend: the jump the blend removes
  await load({ ...cfg, BLEND_WINDOW_SECONDS: 0 });
  for (let i = 0; i < x.sdnap_epochs_count(); ++i) {
    const E = seriesOf(i).epochs;
    for (let k = 0; k + 1 < E.length; ++k) {
      const tau = cfg.SELECTION === 1 ? E[k + 1] : (E[k] + E[k + 1]) / 2;
      const a = at(i, tau - 1), b = at(i, tau + 1);
      unblendedR = Math.max(unblendedR, norm(sub(b.r, a.r)) - norm(a.v) * 0.002);
      unblendedV = Math.max(unblendedV, norm(sub(b.v, a.v)));
    }
  }
  console.log(`${label}: selection vs brute force ${mismatched} of 400 differ; ${handovers} handovers: the blend's own velocity residual worst ${(deriv * 1e6).toFixed(3)} mm/s; at the window edges, beyond the set's own change over 2 ms: position ${(rJump * 1e6).toFixed(4)} mm, velocity ${(vJump * 1e6).toFixed(4)} mm/s; the same switches unblended: ${unblendedR.toFixed(1)} km, ${(unblendedV * 1e3).toFixed(1)} m/s`);
  check(mismatched === 0, `${label}: selection ${mismatched}`);
  check(deriv < 1e-4 && rJump < 1e-6 && vJump < 1e-6, `${label}: continuity ${deriv} km/s, ${rJump} km, ${vJump} km/s`);
  check(unblendedR > 1 && unblendedV > 1e-3, `${label}: the unblended switch shows no jump (${unblendedR} km): the test would not see one`);
}

// --- covariance inside a window; propagate_epochs against the resident store
{
  await load({});
  const i = [0, 1].find((k) => seriesOf(k).norad === 90011);
  const E = seriesOf(i).epochs;
  const tmid = (E[2] + E[3]) / 2;
  const P = at(i, tmid, true).P;
  let sym = 0; for (let a = 0; a < 6; ++a) for (let b = 0; b < 6; ++b) sym = Math.max(sym, Math.abs(P[a * 6 + b] - P[b * 6 + a]));
  const L = Array(36).fill(0); let pd = true;
  for (let j = 0; j < 6 && pd; ++j) { let d = P[j * 6 + j]; for (let k = 0; k < j; ++k) d -= L[j * 6 + k] ** 2; if (!(d > 0)) { pd = false; break; } L[j * 6 + j] = Math.sqrt(d); for (let r = j + 1; r < 6; ++r) { let s = P[r * 6 + j]; for (let k = 0; k < j; ++k) s -= L[r * 6 + k] * L[j * 6 + k]; L[r * 6 + j] = s / L[j * 6 + j]; } }
  console.log(`covariance at a handover's midpoint: position sigma ${(Math.sqrt(P[0] + P[7] + P[14]) * 1e3).toFixed(1)} m, symmetric to ${sym.toExponential(1)}, positive definite ${pd}`);
  check(sym === 0 && pd, "blended covariance");
  const times = Array.from({ length: 49 }, (_, k) => T0 + k * 1800000 + 17000);
  const r = await command.invoke({ methodId: "propagate_epochs", inputs: [store({}), snapshot, { portId: "grid", typeRef: oemType, payload: gridOem("TEME", times) }] });
  check(r.statusCode === 0 && r.outputs.length === 2, `propagate_epochs: ${r.errorCode} ${r.errorMessage}`);
  let worst = 0;
  for (const out of r.outputs ?? []) {
    const blk = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(out.payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
    const k = [0, 1].find((q) => seriesOf(q).norad === blk.OBJECT.NORAD_CAT_ID);
    blk.EPHEMERIS_DATA_LINES.forEach((Ln, n) => { const s = at(k, times[n]); worst = Math.max(worst, ...[Ln.X - s.r[0], Ln.Y - s.r[1], Ln.Z - s.r[2], Ln.X_DOT - s.v[0]].map(Math.abs)); });
    if (blk.OBJECT.NORAD_CAT_ID === 90011) check(blk.COVARIANCE_MATRIX_LINES.length === times.length, "propagate_epochs covariance lines");
  }
  console.log(`propagate_epochs against the resident store: worst difference ${worst} km`);
  check(worst === 0, `propagate_epochs vs resident: ${worst}`);
}

// --- real history: seven days of the catalog (local, licensed; numbers only)
{
  const GP = process.env.SDNAP_GP_ARCHIVE ?? "/opt/data/sdn-archive/spacetrack/gp/2026";
  const days = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"];
  if (!days.every((d) => fs.existsSync(`${GP}/${d}.json.gz`))) {
    console.log("real history: NOT MEASURED (no Space-Track GP snapshots at SDNAP_GP_ARCHIVE)");
  } else {
    const records = [];
    for (const d of days) {
      for (const g of JSON.parse(zlib.gunzipSync(fs.readFileSync(`${GP}/${d}.json.gz`)))) {
        if (g.MEAN_ELEMENT_THEORY !== "SGP4" || !(+g.MEAN_MOTION > 0)) continue;
        const b = new flatbuffers.Builder(256);
        const e = b.createString(g.EPOCH), id = b.createString(g.OBJECT_ID ?? ""), orig = b.createString(g.ORIGINATOR ?? "");
        OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addObjectId(b, id); OMM.addOriginator(b, orig);
        OMM.addMeanMotion(b, +g.MEAN_MOTION); OMM.addEccentricity(b, +g.ECCENTRICITY); OMM.addInclination(b, +g.INCLINATION); OMM.addRaOfAscNode(b, +g.RA_OF_ASC_NODE);
        OMM.addArgOfPericenter(b, +g.ARG_OF_PERICENTER); OMM.addMeanAnomaly(b, +g.MEAN_ANOMALY); OMM.addBstar(b, +g.BSTAR); OMM.addMeanMotionDot(b, +g.MEAN_MOTION_DOT);
        OMM.addMeanMotionDdot(b, +g.MEAN_MOTION_DDOT); OMM.addNoradCatId(b, +g.NORAD_CAT_ID); OMM.addMeanElementTheory(b, 0);
        OMM.finishSizePrefixedOMMBuffer(b, OMM.endOMM(b));
        records.push(Buffer.from(b.asUint8Array()));
      }
    }
    // frames of at most 4 MiB, as the sync module writes them
    const frames = [];
    let cur = [], size = 0;
    for (const r of records) { if (size + r.length > 4 * 1024 * 1024) { frames.push(stream(cur)); cur = []; size = 0; } cur.push(r); size += r.length; }
    if (cur.length) frames.push(stream(cur));
    const t0 = performance.now();
    const r = await m.harness.invoke({ methodId: "load_epochs", inputs: [store({}), ...frames.map((payload) => ({ portId: "omm", typeRef: ommType, payload }))] });
    const loadMs = performance.now() - t0;
    check(r.statusCode === 0, `real load: ${r.errorCode} ${r.errorMessage}`);
    const [nrec, kept, aged, , , , duplicate, bytes] = stats();
    const nseries = x.sdnap_epochs_count();
    console.log(`real history: ${days[0]} .. ${days.at(-1)}, ${nrec} records in ${frames.length} frames, ${kept} sets kept in ${nseries} series (${aged} aged, ${duplicate} same-epoch), loaded in ${(loadMs / 1000).toFixed(1)} s; store ${(bytes / 1048576).toFixed(1)} MiB, ${(bytes / nseries).toFixed(0)} bytes per series`);
    check(nseries > 20000 && kept > nseries, `real history: ${nseries} series, ${kept} sets`);
    // selection and continuity on a sample with several sets
    let mismatched = 0, deriv = 0, rJump = 0, vJump = 0, sampled = 0;
    for (let i = 0; i < nseries && sampled < 100; i += 97) {
      const s = seriesOf(i), E = s.epochs;
      if (E.length < 3) continue;
      ++sampled;
      for (let n = 0; n < 4; ++n) {
        const t = E[0] + u() * (E.at(-1) - E[0]);
        const [a, b, w] = select(i, t);
        const dominant = b >= 0 && w >= 0.5 ? b : a;
        let brute = 0; E.forEach((e, k) => { if (Math.abs(e - t) <= Math.abs(E[brute] - t)) brute = k; });
        if (dominant !== brute) ++mismatched;
      }
      const tau = (E[0] + E[1]) / 2, h = Math.min(1800000, (E[1] - E[0]) / 2);
      if (at(i, tau).status !== 0) continue;
      const c = continuity(i, tau - h, tau + h, 0, 60000);
      deriv = Math.max(deriv, c.deriv); rJump = Math.max(rJump, c.rJump); vJump = Math.max(vJump, c.vJump);
    }
    console.log(`real history, ${sampled} sampled series: selection vs brute force ${mismatched} of ${sampled * 4} differ; first handover: the blend's own velocity residual worst ${(deriv * 1e6).toFixed(3)} mm/s, at the edges beyond the set's own change: position ${(rJump * 1e6).toFixed(4)} mm, velocity ${(vJump * 1e6).toFixed(4)} mm/s`);
    check(mismatched === 0 && deriv < 1e-4 && rJump < 1e-6 && vJump < 1e-6, `real history: ${mismatched}, ${deriv}, ${rJump}, ${vJump}`);
  }
}

console.log(failures.length === 0 ? "\nepoch store E2E: PASS" : `\nepoch store E2E: FAIL\n  ${failures.join("\n  ")}`);
m.destroy();
process.exit(failures.length === 0 ? 0 : 1);
