#!/usr/bin/env node
// E2E (tasks modules-sdn-ap-epoch-store-blend-20261025, modules-sdn-ap-ocm-epochs-20261103): the epoch store (SPEC 14)
// on $OCM streams.
// The $OCM part (modules-sdn-ap-ocm-epochs-20261103):
// - Series keyed on (NORAD_CAT_ID, INTERNATIONAL_DESIGNATOR, MEAN_ELEMENT_THEORY, ORIGINATOR): the AP fixture set
//   and the same set under another designator, theory or originator are four series.
// - Two sets of one series with different forces (a gravity cap): series-forces-differ; with different forecast rows
//   (the second set's rows moved): they load and blend.
// - propagate_epochs of the stored AP record (test/fixtures/ap-fit-0.6.42.ocm, 0.6.42's fit of the 0.4.0 inputs) within
//   STORE_FLIGHT of 0.6.49's flight of it (ap-fit-0.6.42.epochs-0.6.49.oem), and of this build's own fit of the arc within
//   STORE_FIT of this build's propagate_epochs of 0.6.49's fit (ap-fit-0.6.49.ocm) (the flight and the fit apart; history,
//   the fresh-bake reference and sizes at the check); 0.6.36's fit (ap-fit-0.6.36.ocm) is stored without its covariance and
//   its states within STORE_FLIGHT of this build's flight of 0.6.39's fit (the same mean elements); 0.6.4's fit
//   (ap-fit-0.6.4.ocm, the stored record through 0.6.34) states EGM-96 with gravity terms and is refused by the store
//   (gravity-model-mismatch, SPEC 16.2). The store's output differs from propagate's (ap-fit-0.6.42-0.6.49.oem) in the
//   store's time arithmetic, which this record leaves as it was.
// - A store $PCF with a FORCES table: configuration-refused FORCES; propagate_epochs without OUTPUT times:
//   configuration-refused OUTPUT.START_TIME; a request past a set's last row: weather-rows-short:2026-11-01.
// - The covariance from COVARIANCE_DATA and COV_PROPAGATION: the fixture $OEM above carries the store's covariance line
//   at every grid time, so it equals the 0.4.0 store's to the last bit; the resident store's covariance of the XP
//   fixture $OCM against the 0.4.0 sdnap_covariance_at numbers (test/fixtures/xp-fit-0.4.0.cov) within 1e-6 of the
//   matrix's largest entry (the store counts minutes from J2000, about 1e-7 s of rounding at a time).
// - The store's bytes: 100 series sharing one row series hold it once (100 sets with distinct rows hold 99 more,
//   exactly 99 times one series' copy).
// Synthetic history: an SGP4XP series (a truth set's own mean elements, from sdnap_mean_elements_at, every 6 h over 3
// days, the mean anomaly of every other set moved by 0.0115 deg so that each handover is a jump the blend must
// remove, each set with the XP fixture's covariance), an SGP4 series (sets every 12 h, entering through ingest_omm),
// an aged set and a same-epoch duplicate, loaded by load_epochs.
// - The load's counts: records, kept, aged, duplicates; MAX_SETS_PER_OBJECT and THEORIES applied.
// - Selection against brute force over 400 times (NEAREST and LATEST_BEFORE): the dominant set (the blend weight
//   below 1/2: a, else b) is the nearest set, or the latest at or before the time.
// - Every handover, SMOOTHSTEP and HERMITE, NEAREST and LATEST_BEFORE, sampled every second across its window: no
//   position or velocity discontinuity (the velocity against the central difference of the positions, the second
//   difference of the velocity), where the same switch without a blend jumps by the sets' difference.
// - The covariance inside a window is symmetric and positive definite.
// - propagate_epochs (a snapshot given with the call) gives the resident store's states bit for bit.
// Real history (local; Space-Track GP daily snapshots, licensed: nothing written but these numbers): seven days of the
// catalog entered through ingest_omm and loaded, the store's bytes per series measured, selection against brute force
// and continuity across a handover on a sample. Without the archive the real part prints NOT MEASURED.
// JS only moves bytes and compares numbers the module produced.
//   node test/epoch-store.e2e.mjs
import fs from "node:fs";
import { recordReference } from "./lib/record.mjs";
import zlib from "node:zlib";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { ephemerisDataBlockT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { pcfTheory } from "spacedatastandards.org/lib/js/PCF/pcfTheory.js";
import { jdOf } from "./lib/frames.mjs";
import { openModule, THEORY, wasmPath } from "./lib/module.mjs";
import { configuration, XP_FORCES } from "./lib/pcf.mjs";
import { T, fixtureSets, repackOcm, GRID_OUTPUT } from "./lib/ocm.mjs";
import { oemDistance } from "./lib/oem-distance.mjs";
import { GRID } from "./lib/fixture-inputs.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const m = await openModule();
const x = m.x, mem = () => m.harness.memory.buffer;
const command = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const ommType = T("OMM"), ocmType = T("OCM");
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().replace("Z", "");
const T0 = Date.parse("2026-10-20T00:00:00Z");
const prefixed = (plain) => { const b = Buffer.alloc(4 + plain.length); b.writeUInt32LE(plain.length, 0); Buffer.from(plain).copy(b, 4); return b; };
const stream = (records) => new Uint8Array(Buffer.concat(records));
const store = (cfg, more = {}) => configuration({ epochStore: cfg, ...more });
const fixtures = await fixtureSets(command);
/** The $OCM of each SGP4 $OMM, through the one $OMM boundary. */
async function ingested(omms) {
  const out = [];
  for (let k = 0; k < omms.length; k += 4000) {
    const r = await command.invoke({ methodId: "ingest_omm", inputs: omms.slice(k, k + 4000).map((payload) => ({ portId: "omm", typeRef: ommType, payload })) });
    if (r.statusCode !== 0) throw new Error(`ingest_omm: ${r.errorCode} ${r.errorMessage}`);
    out.push(...r.outputs.map((o) => new Uint8Array(o.payload)));
  }
  return out;
}

// --- the synthetic history
/** An SGP4XP $OCM: the XP fixture's record (its covariance and COV_PROPAGATION) with these elements and identity. */
const xpSet = (fields) => repackOcm(fixtures.xp, (t) => {
  Object.assign(t.MEAN_ELEMENTS, { EPOCH: iso(fields.epoch), MEAN_MOTION: fields.mm, ECCENTRICITY: fields.ecc, INCLINATION: fields.inc, RA_OF_ASC_NODE: fields.raan,
    ARG_OF_PERICENTER: fields.argp, MEAN_ANOMALY: fields.ma, BTERM: 0.02, AGOM: 0.01 });
  t.METADATA.NORAD_CAT_ID = 90011;
  t.METADATA.OBJECT_DESIGNATOR = "90011";
  t.METADATA.INTERNATIONAL_DESIGNATOR = null;
  t.METADATA.OBJECT_NAME = null;
  t.HEADER.ORIGINATOR = "SDN-AP E2E";
  t.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS[0].VALUE = 0.02;
  t.ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS[1].VALUE = 0.01;
  // a 6 x 6 epoch covariance of the state alone, no floor and no process noise
  t.COVARIANCE_DATA = COV;
  t.COV_SIZE = 6;
  t.COV_PARAMETER_KINDS = [];
  t.COV_PARAMETERS = [];
  t.COV_UNITS = ["km", "km", "km", "km/s", "km/s", "km/s"];
  for (const k of Object.keys(t.COV_PROPAGATION)) t.COV_PROPAGATION[k] = 0;
});
const COV = [1e-2, 1e-3, 2e-2, 1e-4, 2e-4, 3e-2, 1e-6, 2e-6, 3e-6, 1e-8, 2e-6, 1e-6, 4e-6, 1e-9, 2e-8, 3e-6, 2e-6, 1e-6, 1e-9, 1e-9, 3e-8];
// the truth set (epoch a day before the first set) and, at each set's epoch, its own mean elements
const truthEpoch = T0 - DAY;
{
  const j = jdOf(iso(truthEpoch));
  m.init([{ epochWhole: j.whole, epochFrac: j.frac, meanMotion: 15.5, ecc: 0.0011, inc: 51.6, raan: 120, argp: 90, ma: 30, bterm: 0.02, agom: 0.01, norad: 90011, theory: THEORY.SGP4XP }]);
}
const meanSet = (epoch, k) => {
  const q = x.sdnap_alloc(48);
  if (x.sdnap_mean_elements_at(0, (epoch - truthEpoch) / 60000, q) !== 0) throw new Error("mean elements of the truth set");
  const [a, ecc, inc, raan, argp, ma] = Array.from(new Float64Array(mem(), q, 6));
  const mm = x.sdnap_mean_motion_of(a, ecc, inc);
  x.sdnap_free(q);
  return xpSet({ epoch, mm, ecc, inc, raan, argp, ma: (ma + (k % 2 ? 0.0115 : 0) + 360) % 360 });
};
/** The k-th set of the series at `epoch`, carrying the covariance. */
const seriesSet = (epoch, k) => meanSet(epoch, k);
const xpRecords = [prefixed(seriesSet(T0 - 7 * DAY, 0))];  // an aged set, 7 days before the first epoch
for (let k = 0; k < 13; ++k) xpRecords.push(prefixed(seriesSet(T0 + k * 6 * 3600000, k)));
xpRecords.push(prefixed(seriesSet(T0 + 5 * 6 * 3600000, 5)));  // a same-epoch duplicate of set 5
const sgp4Records = (await ingested(Array.from({ length: 7 }, (_, k) => {
  const b = new flatbuffers.Builder(256);
  const e = b.createString(iso(T0 + k * 12 * 3600000)), id = b.createString("1998-067A"), orig = b.createString("18 SPCS");
  OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addObjectId(b, id); OMM.addOriginator(b, orig);
  OMM.addMeanMotion(b, 15.49 + 1e-4 * k); OMM.addEccentricity(b, 0.0005); OMM.addInclination(b, 51.64); OMM.addRaOfAscNode(b, 200 - 2.5 * k);
  OMM.addArgOfPericenter(b, 80); OMM.addMeanAnomaly(b, (40 + 268.2 * k) % 360); OMM.addBstar(b, 1e-4); OMM.addNoradCatId(b, 25544); OMM.addMeanElementTheory(b, 0);
  OMM.finishOMMBuffer(b, OMM.endOMM(b));
  return b.asUint8Array().slice();
}))).map(prefixed);
const snapshot = { portId: "ocm", typeRef: ocmType, payload: stream([...sgp4Records, ...xpRecords]) };
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
  const r = await command.invoke({ methodId: "propagate_epochs", inputs: [store({}, { output: { EPOCHS: times.map(iso) } }), snapshot] });
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

// --- the $OCM store: series key, forces, rows, the fixture bytes, refusals, covariance, interning
{
  const ap = fixtures.ap;
  const one = (records) => ({ portId: "ocm", typeRef: ocmType, payload: stream(records.map(prefixed)) });
  const loadSets = (records, cfg = {}) => m.harness.invoke({ methodId: "load_epochs", inputs: [store(cfg), one(records)] });
  const refused = (label, r, code, field = null) =>
    check(r.statusCode !== 0 && r.errorCode === code && (field === null || String(r.errorMessage).startsWith(field)),
      `${label}: expected ${code}${field ? ` ${field}` : ""}, got ${r.statusCode === 0 ? "success" : `${r.errorCode} ${r.errorMessage}`}`);
  // the series key
  const keyed = await loadSets([ap, repackOcm(ap, (t) => { t.METADATA.INTERNATIONAL_DESIGNATOR = "2026-904B"; }), repackOcm(ap, (t) => { t.HEADER.ORIGINATOR = "OTHER"; }), fixtures.xp]);
  check(keyed.statusCode === 0 && x.sdnap_epochs_count() === 4, `the series key: ${keyed.errorCode} ${keyed.errorMessage}, ${x.sdnap_epochs_count()} series of 4`);
  // forces differ; rows differ
  const later = (edit) => repackOcm(ap, (t) => { t.MEAN_ELEMENTS.EPOCH = "2026-10-01T06:00:00.000000"; t.TRAJ_FRAME_EPOCH = t.MEAN_ELEMENTS.EPOCH; edit(t); });
  refused("two sets, two force models", await loadSets([ap, later((t) => { t.PERTURBATIONS.MAXIMUM_TESSERAL_DEGREE = 12; })]), "series-forces-differ");
  const blended = await loadSets([ap, later((t) => { for (const r of t.PERTURBATIONS.SPACE_WEATHER) r.F107_OBS += 20; })]);
  const mid = Date.parse("2026-10-01T03:00:00Z"), sel = blended.statusCode === 0 ? select(0, mid) : [0, -1, 0];
  console.log(`two sets of one series, rows moved: ${blended.statusCode === 0 ? `${x.sdnap_epochs_count()} series, ${seriesOf(0).epochs.length} sets; at 03:00 sets ${sel[0]} and ${sel[1]}, weight ${sel[2]}` : blended.errorCode}`);
  check(blended.statusCode === 0 && x.sdnap_epochs_count() === 1 && seriesOf(0).epochs.length === 2 && sel[1] === 1 && sel[2] > 0 && sel[2] < 1 && at(0, mid).status === 0,
    "two sets with different rows do not load and blend");
  // the flight of the stored AP record (0.6.42's fit) against 0.6.42's propagate_epochs of it (ap-fit-0.6.42.epochs-0.6.42.oem),
  // and this build's own fit against this build's of 0.6.42's fit (the same record). History: 0.6.4's own flight of it (ap-fit-0.6.4.epochs.oem, the
  // expected flight through 0.6.17) equals ap-fit-0.4.0.epochs.oem (the 0.4.18 dist's) in its states bit for bit through
  // 0.6.4, its covariance moved at 0.6.1 (637228fb, the AP DRAG noise row re-fitted, SPEC 12.4); 0.6.5 (24d7d75f, SPEC
  // 16.8) moves the stored record's flight by 0.629 mm and 0.796 um/s and its covariance by 7.2e-5 of a line's largest
  // entry; this build's own fit stops about 3 cm away along the grid (the fit inside its tolerance, ap-terms.e2e.mjs).
  // 0.6.18 (the per-set caches, SPEC 9) records the expected flight from itself, the bounds kept. Against a fresh-bake
  // reference of its own sources (every tesseral, resonance and m-daily bake taken at the state on every call; the
  // third-body bracket, drag-pass and half-day caches never reused), position, velocity, covariance of a line's largest:
  //   0.6.17 against 0.6.4's flight        0.629 mm  0.796 um/s  7.16e-5
  //   0.6.18 against 0.6.4's flight        1.533 mm  1.531 um/s  7.22e-5
  //   reference against 0.6.4's flight     1.349 mm  1.314 um/s  7.20e-5
  //   0.6.17 against the reference         0.856 mm  0.939 um/s  2.25e-5
  //   0.6.18 against the reference         0.841 mm  0.816 um/s  2.88e-6
  //   0.6.17 against 0.6.18                1.289 mm  1.409 um/s  2.47e-5
  // Both builds are within 1 mm of the reference and equally close to it; 0.6.4's flight is 1.35 mm from it.
  // 0.6.21 (SPEC 16.15 and 16.16, stack #464 and #472) records it from itself again (ap-fit-0.6.4.epochs-0.6.21.oem; the
  // 0.6.18 file went), the bounds kept. Against the 0.6.18 file, 0.6.20 / 0.6.21: byte-equal / position 0.000 mm,
  // velocity 0.000 um/s, covariance 9.162e-3 of a line's largest entry. Why: the record's correlations between AGOM and
  // the state are 0.6.4's fit's, and 16.16 moves its along-track response to AGOM at 48 h from 1380.7 to 823.7 m per
  // m^2/kg; a fit made and flown by 0.6.21 flies to 0.6.4's numbers within 7.1e-5 (covariance.e2e.mjs). 0.6.22 (AP's own
  // Sun and Moon, SPEC 16.17, stack #446) records it from itself again (ap-fit-0.6.4.epochs-0.6.22.oem; the 0.6.21 file
  // went), the bounds kept: against the 0.6.21 file 34.763 mm, 38.304 um/s, covariance 2.19e-5 of a line's largest entry.
  // 0.6.36 (the field EGM2008, SPEC 16.2) moves it from the 0.6.22 file by 7,140.574 mm, 7,584.418 um/s and a covariance of
  // 5.32e-3 of a line's largest entry.
  // 0.6.36 refuses a record whose GRAVITY_MODEL is not the embedded field (SPEC 16.2): 0.6.4's fit states EGM-96, so from
  // 0.6.36 the stored record is 0.6.36's own fit (ap-fit-0.6.36.ocm) with its flight (ap-fit-0.6.36.epochs-0.6.36.oem; the
  // 0.6.22 file went), the bounds kept.
  // This build's fit: against the stored record's flight until 0.6.21; from 0.6.22 against this build's propagate_epochs
  // of 0.6.22's own fit (ap-fit-0.6.22.ocm), the bounds kept. AP's own Sun and Moon move the fit: 117.72 mm and 130.37
  // um/s from the 0.6.21 file and, both flown by 0.6.22, 92.33 mm and 101.49 um/s from the stored record's flight.
  const storedFlight = fs.readFileSync(new URL("fixtures/ap-fit-0.6.42.epochs-0.6.49.oem", import.meta.url));
  const STORE_FLIGHT = { posM: 0.001, velMmS: 0.001, covOfLargest: 1e-4 }, STORE_FIT = { posM: 0.1, velMmS: 0.1 };
  // 0.6.25 (the slow set, SPEC 16.18) moves the fit, which now carries the slow tesseral terms at 550 km: 17.7 m and
  // 19.4 mm/s from 0.6.22's fit (both flown by 0.6.25), FIT_RMS 40.049 against 41.126 m. Against the fixture's own
  // truth (propagator/ffm's 550 km trajectory) the error 48 to 72 h past the arc goes from 114 m (0.6.24) to 43 m, over
  // the arc 24.0 to 23.9 m. So the own fit is 0.6.25's (ap-fit-0.6.25.ocm; 0.6.22's went), the bounds kept.
  // 0.6.27 (the slow set's terms of q other than 0, SPEC 16.18) moves the fit: 77.4 m and 45.1 mm/s from 0.6.25's fit
  // (both flown by 0.6.27), FIT_RMS 40.260 against 40.049 m. Against the fixture's own truth (propagator/ffm's 550 km
  // trajectory) the error 48 to 72 h past the arc stays at 43 m, and over the arc it goes from 23.9 to 24.1 m. So the
  // own fit is 0.6.27's (ap-fit-0.6.27.ocm; 0.6.25's went), the bounds kept.
  // 0.6.36 (the field EGM2008 in place of EGM-96, SPEC 16.2) moves the fit: 154.6 m and 133.1 mm/s from 0.6.27's fit
  // (both flown by 0.6.36), FIT_RMS 40.153 against 40.260 m. Against the fixture's own truth (propagator/ffm's 550 km
  // trajectory) the error 48 to 72 h past the arc goes from 43 to 42 m, and over the arc from 24.1 to 24.3 m. So the
  // own fit is 0.6.36's (ap-fit-0.6.36.ocm; 0.6.27's went), the bounds kept.
  // 0.6.39 (SPEC 12.4, stack #551: an AP set's epoch floor put on and taken off at the two-body state of its own mean
  // elements) refuses the covariance of an AP record written before it (cov-floor-at-theory-state; its states fly), 0.6.36's
  // fit among them. So from 0.6.39 the stored record is 0.6.39's own fit of the same inputs (ap-fit-0.6.39.ocm: 0.6.36's mean
  // elements bit for bit, its COVARIANCE_DATA's state block carrying the floor at the two-body state), and its flight is
  // held against 0.6.36's flight of 0.6.36's fit, which it equals to rounding (a set's own flight is as it was); 0.6.36's fit
  // flies its states as 0.6.36 flew them, its covariance refused by name.
  // 0.6.42 (the low table's fast side, SPEC 16.1, stack #477: the output table to the record's tesseral degree) moves this
  // 550 km set, which is in the low table at tesseral 31. Main 0.6.41 (git afdd1568, wasm bec591fe) flies 0.6.39's fit
  // within STORE_FLIGHT of 0.6.36's flight; on 0.6.42 (git b7a7191e, wasm f771420f; the final 0.6.42, git 61048ba9, wasm 3c389abf, flies the same bits) it is 59,929.895 mm and 47,483.254
  // um/s from it, the covariance 2.07e-5 of a line's largest entry. Its own fit is 10,706.088 mm and 11,917.659 um/s from
  // 0.6.39's fit (both flown by 0.6.42), the covariance 1.92e-1 of a line's largest entry: the fast side fits the arc
  // closer (FIT_RMS 37.27 against 40.15 m), the floor is the fit's own residual covariance (SPEC 12.4), and the low
  // table's radial floor takes exp(0.095) (SPEC 12.5). A base before the fast side holds these to another theory's flight,
  // so from 0.6.42 the stored record is 0.6.42's own fit (ap-fit-0.6.42.ocm) with its flight
  // (ap-fit-0.6.42.epochs-0.6.42.oem; ap-fit-0.6.36.epochs-0.6.36.oem went), and the own fit is the same record, the bounds
  // kept. 0.6.36's fit is held against this build's flight of 0.6.39's fit, a record with the same mean elements.
  // 0.6.43 (the zonal theory's constant radial term at the same osculating energy, SPEC 16.23) moves the stored
  // record's flight by 2,151.662 mm, 2,360.668 um/s and a covariance of 2.28e-6 of a line's largest entry, and records
  // it from itself (ap-fit-0.6.42.epochs-0.6.43.oem; the 0.6.42 file went), the bounds kept. It moves the fit: 317.33
  // mm and 347.12 um/s on the grid from 0.6.42's fit (both flown by 0.6.43), FIT_RMS 37.286 against 37.273 m. So the
  // own fit is 0.6.43's (ap-fit-0.6.43.ocm); the stored record stays 0.6.42's fit.
  // 0.6.49 (the output table keeps a line whole, SPEC 16.1, stack #572) moves the stored record's flight by 29,933.804
  // mm, 16,307.027 um/s and a covariance of 2.81e-5 of a line's largest entry, and records it from itself
  // (ap-fit-0.6.42.epochs-0.6.49.oem; the 0.6.43 file went), the bounds kept. It moves the fit: 5,313.04 mm and 5,516.49
  // um/s on the grid from 0.6.43's fit (both flown by 0.6.49), FIT_RMS 35.182 against 37.286 m. So the own fit is 0.6.49's
  // (ap-fit-0.6.49.ocm); the stored record stays 0.6.42's fit.
  const storedRecord = new Uint8Array(fs.readFileSync(new URL("fixtures/ap-fit-0.6.42.ocm", import.meta.url)));
  const fitRecord = new Uint8Array(fs.readFileSync(new URL("fixtures/ap-fit-0.6.49.ocm", import.meta.url)));
  const fitRecordFlight = await command.invoke({ methodId: "propagate_epochs", inputs: [store({}, { output: GRID_OUTPUT }), one([fitRecord])] });
  check(fitRecordFlight.statusCode === 0, `propagate_epochs 0.6.49's fit: ${fitRecordFlight.errorCode} ${fitRecordFlight.errorMessage}`);
  for (const [what, record, bound, reference, against] of [
    ["the stored AP record", storedRecord, STORE_FLIGHT, storedFlight, "0.6.49's of the stored record"],
    ["this build's fit", ap, STORE_FIT, new Uint8Array(fitRecordFlight.outputs?.[0]?.payload ?? []), "this build's of 0.6.49's fit"]]) {
    const pe = await command.invoke({ methodId: "propagate_epochs", inputs: [store({}, { output: GRID_OUTPUT }), one([record])] });
    check(pe.statusCode === 0, `propagate_epochs ${what}: ${pe.errorCode} ${pe.errorMessage}`);
    if (pe.statusCode !== 0 || fitRecordFlight.statusCode !== 0) continue;
    if (what === "the stored AP record") recordReference("ap-fit-0.6.42.epochs", "oem", new Uint8Array(pe.outputs[0].payload));
    const d = oemDistance(new Uint8Array(pe.outputs[0].payload), reference);
    console.log(`propagate_epochs of ${what} against ${against}: ${d.bytesEqual ? "byte-equal" : "differs"}; position ${(1000 * d.posM).toFixed(3)} mm, velocity ${(1000 * d.velMmS).toFixed(3)} um/s, covariance ${d.covOfLargest.toExponential(2)} of a line's largest entry`);
    check(d.states === 289 && d.covLines === 289 && d.epochsDiffer === 0, `${what}: ${d.states} states and ${d.covLines} covariance lines of 289, ${d.epochsDiffer} epochs differ`);
    check(d.posM <= bound.posM && d.velMmS <= bound.velMmS && (bound.covOfLargest === undefined || d.covOfLargest <= bound.covOfLargest),
      `propagate_epochs of ${what} moved: ${JSON.stringify(d)} against ${JSON.stringify(bound)}`);
  }
  const oldField = await command.invoke({ methodId: "propagate_epochs", inputs: [store({}, { output: GRID_OUTPUT }),
    one([new Uint8Array(fs.readFileSync(new URL("fixtures/ap-fit-0.6.4.ocm", import.meta.url)))])] });
  check(oldField.statusCode !== 0 && oldField.errorCode === "gravity-model-mismatch",
    `propagate_epochs of 0.6.4's fit (GRAVITY_MODEL EGM-96 with gravity terms): ${oldField.statusCode === 0 ? "flown" : `${oldField.errorCode} ${oldField.errorMessage}`}, expected gravity-model-mismatch`);
  // SPEC 12.4: 0.6.36's fit is stored without its covariance (its floor at 0.6.36's theory state); its states fly as this
  // build flies 0.6.39's fit, a record with the same mean elements bit for bit and its floor at the two-body state
  const preFloor = await command.invoke({ methodId: "propagate_epochs", inputs: [store({}, { output: GRID_OUTPUT }),
    one([new Uint8Array(fs.readFileSync(new URL("fixtures/ap-fit-0.6.36.ocm", import.meta.url)))])] });
  const same39 = await command.invoke({ methodId: "propagate_epochs", inputs: [store({}, { output: GRID_OUTPUT }),
    one([new Uint8Array(fs.readFileSync(new URL("fixtures/ap-fit-0.6.39.ocm", import.meta.url)))])] });
  check(preFloor.statusCode === 0 && same39.statusCode === 0, `propagate_epochs of 0.6.36's fit: ${preFloor.errorCode ?? "ok"} ${preFloor.errorMessage ?? ""} | of 0.6.39's fit: ${same39.errorCode ?? "ok"}`);
  if (preFloor.statusCode === 0 && same39.statusCode === 0) {
    const d = oemDistance(new Uint8Array(preFloor.outputs[0].payload), new Uint8Array(same39.outputs[0].payload));
    console.log(`propagate_epochs of 0.6.36's fit: ${d.states} states, ${d.covLines} covariance lines in common with this build's flight of 0.6.39's fit, position ${(1000 * d.posM).toFixed(3)} mm`);
    check(d.states === 289 && d.epochsDiffer === 0 && d.posM <= STORE_FLIGHT.posM && d.velMmS <= STORE_FLIGHT.velMmS && d.covLines === 0 && d.covLinesDiffer === true,
      `propagate_epochs of 0.6.36's fit: ${JSON.stringify(d)} (its states as 0.6.39's fit's, no covariance)`);
  }
  refused("a store $PCF with FORCES", await loadSets([ap], {}).then(() => m.harness.invoke({ methodId: "load_epochs", inputs: [configuration({ forces: XP_FORCES }), one([ap])] })), "configuration-refused", "FORCES");
  refused("propagate_epochs with FORCES", await command.invoke({ methodId: "propagate_epochs", inputs: [store({}, { output: GRID_OUTPUT, forces: XP_FORCES }), one([ap])] }), "configuration-refused", "FORCES");
  refused("propagate_epochs without times", await command.invoke({ methodId: "propagate_epochs", inputs: [store({}), one([ap])] }), "configuration-refused", "OUTPUT.START_TIME");
  refused("a request past the last row", await command.invoke({ methodId: "propagate_epochs", inputs: [store({}, { output: { START_TIME: "2026-10-31T12:00:00", STOP_TIME: "2026-11-01T12:00:00", STEP_SECONDS: 3600 } }), one([ap])] }),
    "weather-rows-short:2026-11-01");
  refused("an $OMM in the snapshot", await m.harness.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: ocmType, payload: fs.readFileSync(new URL("fixtures/xp-fit-0.4.0.omm", import.meta.url)) }] }), "omm-not-flown");
  // the covariance against the 0.4.0 numbers
  check((await loadSets([fixtures.xp])).statusCode === 0, "load the XP fixture");
  const recorded = fs.readFileSync(new URL("fixtures/xp-fit-0.4.0.cov", import.meta.url));
  const rec = new Float64Array(recorded.buffer, recorded.byteOffset, recorded.length / 8);
  const t0 = Date.parse(`${GRID.start}Z`);
  let worst = 0, n = 0;
  for (let k = 0; k * GRID.step / 60 <= GRID.minutes; ++k, ++n) {
    const s = at(0, t0 + k * GRID.step * 1000, true);
    const want = rec.subarray(42 * k + 6, 42 * k + 42), top = Math.max(...want.map(Math.abs));
    s.P.forEach((v, q) => { worst = Math.max(worst, Math.abs(v - want[q]) / top); });
  }
  console.log(`the store's covariance of the XP fixture at ${n} grid times against the 0.4.0 numbers: worst ${worst.toExponential(2)} of the largest entry`);
  check(worst <= 1e-6, `the store's covariance is ${worst} of the largest entry from the 0.4.0 numbers`);
  // one copy of a row series shared by 100 sets
  const sharing = Array.from({ length: 100 }, (_, k) => repackOcm(ap, (t) => { t.METADATA.NORAD_CAT_ID = 91000 + k; }));
  const distinct = Array.from({ length: 100 }, (_, k) => repackOcm(ap, (t) => { t.METADATA.NORAD_CAT_ID = 91000 + k; t.PERTURBATIONS.SPACE_WEATHER[0].AP_AVG += k; }));
  check((await loadSets(sharing)).statusCode === 0, "load 100 sets sharing rows");
  const shared = stats()[7];
  check((await loadSets(distinct)).statusCode === 0, "load 100 sets with distinct rows");
  const separate = stats()[7];
  check((await loadSets([ap])).statusCode === 0, "load one set");
  const single = stats()[7];
  check((await loadSets([ap, repackOcm(ap, (t) => { t.METADATA.NORAD_CAT_ID = 91999; t.PERTURBATIONS.SPACE_WEATHER[0].AP_AVG += 1; })])).statusCode === 0, "load two sets, two row series");
  const copy = stats()[7] - single - (shared - single) / 99;  // one more row series beyond one more set
  console.log(`store bytes: 100 sets sharing one row series ${shared}, with 100 row series ${separate}; one series' rows ${copy} B; 99 extra copies ${separate - shared} B`);
  check(copy > 32 * 56 && separate - shared === 99 * copy, `interning: ${separate - shared} B for 99 more row series against ${copy} B a copy`);
}

// --- real history: seven days of the catalog (local, licensed; numbers only)
{
  const GP = process.env.SDNAP_GP_ARCHIVE ?? "/opt/data/sdn-archive/spacetrack/gp/2026";
  const days = ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"];
  if (!days.every((d) => fs.existsSync(`${GP}/${d}.json.gz`))) {
    console.log("real history: NOT MEASURED (no Space-Track GP snapshots at SDNAP_GP_ARCHIVE)");
  } else {
    const omms = [];
    for (const d of days) {
      for (const g of JSON.parse(zlib.gunzipSync(fs.readFileSync(`${GP}/${d}.json.gz`)))) {
        if (g.MEAN_ELEMENT_THEORY !== "SGP4" || !(+g.MEAN_MOTION > 0)) continue;
        const b = new flatbuffers.Builder(256);
        const e = b.createString(g.EPOCH), id = b.createString(g.OBJECT_ID ?? ""), orig = b.createString(g.ORIGINATOR ?? "");
        OMM.startOMM(b); OMM.addEpoch(b, e); OMM.addObjectId(b, id); OMM.addOriginator(b, orig);
        OMM.addMeanMotion(b, +g.MEAN_MOTION); OMM.addEccentricity(b, +g.ECCENTRICITY); OMM.addInclination(b, +g.INCLINATION); OMM.addRaOfAscNode(b, +g.RA_OF_ASC_NODE);
        OMM.addArgOfPericenter(b, +g.ARG_OF_PERICENTER); OMM.addMeanAnomaly(b, +g.MEAN_ANOMALY); OMM.addBstar(b, +g.BSTAR); OMM.addMeanMotionDot(b, +g.MEAN_MOTION_DOT);
        OMM.addMeanMotionDdot(b, +g.MEAN_MOTION_DDOT); OMM.addNoradCatId(b, +g.NORAD_CAT_ID); OMM.addMeanElementTheory(b, 0);
        OMM.finishOMMBuffer(b, OMM.endOMM(b));
        omms.push(b.asUint8Array().slice());
      }
    }
    const records = (await ingested(omms)).map(prefixed);
    // frames of at most 4 MiB, as the sync module writes them
    const frames = [];
    let cur = [], size = 0;
    for (const r of records) { if (size + r.length > 4 * 1024 * 1024) { frames.push(stream(cur)); cur = []; size = 0; } cur.push(r); size += r.length; }
    if (cur.length) frames.push(stream(cur));
    const t0 = performance.now();
    const r = await m.harness.invoke({ methodId: "load_epochs", inputs: [store({}), ...frames.map((payload) => ({ portId: "ocm", typeRef: ocmType, payload }))] });
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
