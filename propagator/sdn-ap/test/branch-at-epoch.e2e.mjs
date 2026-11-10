#!/usr/bin/env node
// E2E (review 0, finding M5): an AP set's branch (resonance class, the 1,100-minute regime, the eccentricity switches;
// SPEC 16.7) is decided at its epoch for the whole flight, and nothing differences or blends two branches.
// - Continuity in time (the referee's math/rerun/09-output-continuity.mjs): one seeded AP record (caps 31 and 20, e 0.001,
//   i 55 deg, node 80, perigee 30, mean anomaly 10 deg, epoch 2026-10-01) at each of the five mean motions that decide a
//   class (0.8022, 1.2033, 1.6045, 2.4067 and 3.6100 rev/day, the SPEC 6 limits to the last digit) and at the 1,100-minute
//   regime limit, flown 2 days in GCRF every 10 s: the second difference of the position less h^2 times the two-body
//   acceleration (mu 398600.4415 km^3/s^2) stays at or below 0.05 m. In 0.6.5 the class followed the current mean
//   motion and the 0.8022 and 1.2033 records jumped by 46 to 136 m several times a day, the 1.6045 one by 13.7 m.
// - Covariance (SPEC 12.3): a fitted AP record repacked to a mean motion 2e-8 above the one-day / sixteen-hour limit
//   (its -1e-7 n column's moved set lies across it) and to 3e-7 above (no moved set across): sdnap_covariance_at at 0, 1
//   and 3 days agrees between the two within 1e-3 of the largest position variance (0.6.5, its class following the
//   current mean motion: 0.70). The moved sets take their nominal's branch; with the class held at the epoch, moved sets
//   on their own branches give the same numbers to 1e-4 (a branch's offset maps through the columns like an element
//   change, which the Cartesian covariance does not see), so this part guards the class, not the pinning.
// - Fit (SPEC 16.7): an AP truth on the sixteen-hour side 3e-8 above the limit, flown 24 h every 10 min, fits back on
//   its own side (the fitted mean motion within 1e-9 of the truth's, the arc RMS below 1 cm); a truth half on each side
//   (the mean of the two flights of one set at the 0.8022 limit) is refused fit-at-branch-limit, its message naming the
//   switch.
// - Epoch store (SPEC 14.3): two AP sets 6 h apart on either side of the 1.2033 limit are not blended: inside the window
//   of their switch sdnap_epochs_select gives b = -2 and weight 0, the state is the chosen set's bit for bit, and
//   propagate_epochs names the switch time in the block's COMMENT; two sets on one side blend (b = 1, weight in (0, 1)) and
//   their block has no COMMENT.
// - Epoch store and carried forecasts (SPEC 14.3, 18.3): a record carrying its forecast (test/lib/carried.mjs, the "LEO
//   500 km" class, span 0 to 24 h) followed 12 h later by the plain record: at the switch by epoch (6 h after the record's
//   epoch, inside the span) the carried set flies alone on both sides (b = -3, weight 0, its forecast bit for bit), and
//   after the span's end the later set alone (b = -1, its theory bit for bit); propagate_epochs labels the states
//   CARRIED FORECAST inside the span and THEORY after it, with no "Not blended" text. The carried record followed by
//   itself 12 h later (both forecasts cover the switch): the later set's forecast alone (b = -3), never a blend. The
//   plain record placed so the switch by epoch falls on the span's end (to the record's epoch's sub-millisecond digits):
//   the same labels, then ". Not blended (SPEC 14.3): " with that time (SPEC 18.8's grammar).
// Made-up orbits only. JS only moves bytes and compares numbers the module produced.
//   node test/branch-at-epoch.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM, OEMT } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { CATT } from "spacedatastandards.org/lib/js/OEM/CAT.js";
import { ephemerisDataBlockT as Block } from "spacedatastandards.org/lib/js/OEM/ephemerisDataBlock.js";
import { ephemerisDataLineT as Line } from "spacedatastandards.org/lib/js/OEM/ephemerisDataLine.js";
import { timingStandard } from "spacedatastandards.org/lib/js/OEM/timingStandard.js";
import { pcfAtmosphereFamily } from "spacedatastandards.org/lib/js/PCF/pcfAtmosphereFamily.js";
import { pcfWeatherSource } from "spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { openModule, wasmPath } from "./lib/module.mjs";
import { configuration, prior, pcfPriorForm } from "./lib/pcf.mjs";
import { T, seedOcm, rowsThrough, spwStream, flight, ocmOf, repackOcm } from "./lib/ocm.mjs";
import { packOem, rfm, jdOf } from "./lib/frames.mjs";
import { CLASSES, carriedRecord, sourcesOf, EPOCH as CARRIED_EPOCH } from "./lib/carried.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const m = await openModule();
const x = m.x, mem = () => m.harness.memory.buffer;
const h = await createStandaloneHarness("browser", wasmPath, { surface: "command" });
const DAY = 86400000, MU = 398600.4415, REV = 1440 / (2 * Math.PI);
const EPOCH = Date.parse("2026-10-01T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace("Z", "");
const L08 = 0.0035003818 * REV, L12 = 0.0052505727 * REV, L16 = 0.0070007636 * REV, L24 = 0.0105011454 * REV, L36 = 0.015751718 * REV;
const L1100 = 1440 / 1100;
const rows = rowsThrough(Array.from({ length: 49 }, (_, k) => ({ DATE: new Date(EPOCH + (k - 3) * DAY).toISOString().slice(0, 10), F107_OBS: 150, F107_OBS_CENTER81: 150, AP_AVG: 15, F107_DATA_TYPE: 0 })));
const seed = (n, { epochMs = EPOCH, norad = 99001, e = 0.001 } = {}) =>
  seedOcm({ epoch: iso(epochMs), n, e, i: 55, raan: 80, argp: 30, ma: 10, norad, records: true, tesseral: 31, zonal: 20, rows });
const call = async (methodId, inputs) => {
  const r = await h.invoke({ methodId, inputs });
  if (r.statusCode !== 0) throw Object.assign(new Error(`${methodId}: ${r.errorCode}: ${r.errorMessage}`), { code: r.errorCode, text: r.errorMessage });
  return r.outputs;
};
const blocks = (payload) => OEM.getRootAsOEM(new flatbuffers.ByteBuffer(payload)).unpack().EPHEMERIS_DATA_BLOCK;
const fly = async (record, times) => {
  const out = await call("propagate", flight([record], { output: { EPOCHS: times.map(iso), FRAME: pcfOutputFrame.GCRF } }));
  return blocks(out.find((v) => v.portId === "ephemeris").payload)[0].EPHEMERIS_DATA_LINES.map((l) => [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT]);
};

// --- continuity in time at each limit
{
  const step = 10, K = Math.round(2 * 86400 / step), times = Array.from({ length: K + 1 }, (_, k) => EPOCH + k * step * 1000);
  for (const [label, n] of [["0.8022", L08], ["1.2033", L12], ["1.6045", L16], ["2.4067", L24], ["3.6100", L36], ["1100 min", L1100]]) {
    const s = await fly(seed(n), times);
    let worst = 0;
    for (let k = 1; k < K; ++k) {
      const r = s[k], rn = Math.hypot(r[0], r[1], r[2]);
      const d = [0, 1, 2].map((c) => s[k + 1][c] - 2 * r[c] + s[k - 1][c] + step * step * MU * r[c] / rn ** 3);
      worst = Math.max(worst, 1000 * Math.hypot(...d));
    }
    console.log(`continuity at ${label} rev/day (n ${n.toFixed(10)}): worst second-difference residual ${worst.toFixed(4)} m over 2 days at 10 s`);
    check(worst <= 0.05, `continuity at ${label}: ${worst} m`);
  }
}

// --- fit and covariance near a limit
const oemOf = (states, times) => {
  const lines = states.map((q, k) => Object.assign(new Line(), { EPOCH: iso(times[k]), X: q[0], Y: q[1], Z: q[2], X_DOT: q[3], Y_DOT: q[4], Z_DOT: q[5] }));
  const b = Object.assign(new Block(), { OBJECT: Object.assign(new CATT(), { NORAD_CAT_ID: 99001, OBJECT_NAME: "BRANCH E2E" }), CENTER_NAME: "EARTH", REFERENCE_FRAME: rfm("GCRF"),
    TIME_SYSTEM: timingStandard.UTC, START_TIME: lines[0].EPOCH, STOP_TIME: lines.at(-1).EPOCH, USEABLE_START_TIME: lines[0].EPOCH, USEABLE_STOP_TIME: lines.at(-1).EPOCH, EPHEMERIS_DATA_LINES: lines });
  return packOem(Object.assign(new OEMT(), { EPHEMERIS_DATA_BLOCK: [b] }));
};
const fitCfg = configuration({ forces: { EPHEMERIS_SOURCE: "", HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  ATMOSPHERE_MODEL: pcfAtmosphereFamily.JACCHIA70, WEATHER_SOURCE: pcfWeatherSource.RECORDS },
  fit: { DRAG_PRIOR: prior(0, 1e-10), DRAG_PRIOR_FORM: pcfPriorForm.GAUSSIAN_SIGNED, SRP_PRIOR: prior(0, 1e-10) } });
const fit = async (states, times) => new Uint8Array((await call("fit", [fitCfg, { portId: "space_weather", typeRef: T("SPW"), payload: spwStream(rows) },
  { portId: "ephemeris", typeRef: T("OEM"), payload: oemOf(states, times) }])).find((v) => v.portId === "elements").payload);
const arc = Array.from({ length: 145 }, (_, k) => EPOCH + k * 600000);
{
  // a truth 3e-8 above the one-day / sixteen-hour limit fits back on its side
  const nTruth = L12 * (1 + 3e-8);
  const rec = await fit(await fly(seed(nTruth), arc), arc);
  const nFit = ocmOf(rec).MEAN_ELEMENTS.MEAN_MOTION;
  const back = await fly(rec, arc), truth = await fly(seed(nTruth), arc);
  const arcRms = Math.sqrt(back.reduce((s, q, k) => s + (q[0] - truth[k][0]) ** 2 + (q[1] - truth[k][1]) ** 2 + (q[2] - truth[k][2]) ** 2, 0) / arc.length) * 1000;
  console.log(`fit 3e-8 above the 1.2033 limit: fitted n ${nFit} (truth ${nTruth}, relative ${(nFit / nTruth - 1).toExponential(2)}), arc RMS ${arcRms.toFixed(5)} m`);
  check(Math.abs(nFit / nTruth - 1) <= 1e-9 && nFit > L12 && arcRms < 0.01, `fit at the 1.2033 limit: n ${nFit}, arc RMS ${arcRms} m`);

  // covariance: the record moved to 2e-8 and to 3e-7 above the limit
  const moved = (n) => repackOcm(rec, (t) => { t.MEAN_ELEMENTS.MEAN_MOTION = n; });
  const covAt = (bytes, minutes) => {
    const pr = x.sdnap_alloc(bytes.length), pt = x.sdnap_alloc(8 * minutes.length), po = x.sdnap_alloc(8 * 42 * minutes.length);
    new Uint8Array(mem(), pr, bytes.length).set(bytes);
    new Float64Array(mem(), pt, minutes.length).set(minutes);
    const rc = x.sdnap_covariance_at(pr, bytes.length, pt, minutes.length, po);
    const out = Array.from(new Float64Array(mem(), po, 42 * minutes.length));
    x.sdnap_free(pr); x.sdnap_free(pt); x.sdnap_free(po);
    return { rc, out };
  };
  const minutes = [0, 1440, 4320];
  const near = covAt(moved(L12 * (1 + 2e-8)), minutes), far = covAt(moved(L12 * (1 + 3e-7)), minutes);
  let worst = 0;
  if (near.rc === 0 && far.rc === 0) {
    for (let k = 0; k < minutes.length; ++k) {
      const a = near.out.slice(42 * k + 6, 42 * k + 42), b = far.out.slice(42 * k + 6, 42 * k + 42);
      const scale = Math.max(a[0], a[7], a[14]);
      worst = Math.max(worst, ...a.map((v, q) => Math.abs(v - b[q]) / scale));
    }
  }
  console.log(`covariance 2e-8 against 3e-7 above the 1.2033 limit (0, 1, 3 days): worst difference ${worst.toExponential(2)} of the largest position variance (codes ${near.rc}, ${far.rc})`);
  check(near.rc === 0 && far.rc === 0 && worst <= 1e-3, `covariance across a moved set's branch: ${worst} (codes ${near.rc}, ${far.rc})`);
}
{
  // a truth half on each side of the 0.8022 limit: the mean of the two flights of one set there
  const below = await fly(seed(L08 * (1 - 1e-12)), arc), above = await fly(seed(L08 * (1 + 1e-12)), arc);
  const mixed = below.map((q, k) => q.map((v, c) => 0.5 * (v + above[k][c])));
  let refused = null;
  try { await fit(mixed, arc); } catch (error) { refused = error; }
  console.log(`fit of a truth half on each side of the 0.8022 limit: ${refused ? `${refused.code}: ${refused.text}` : "fitted"}`);
  check(refused?.code === "fit-at-branch-limit" && /resonance class limit/.test(refused.text), `half on each side: ${refused ? refused.code : "fitted"}`);
}

// --- the epoch store across a branch
{
  const prefixed = (plain) => { const b = Buffer.alloc(4 + plain.length); b.writeUInt32LE(plain.length, 0); Buffer.from(plain).copy(b, 4); return b; };
  const six = EPOCH + 6 * 3600000, sw = EPOCH + 3 * 3600000;
  const across = [seed(L12 * (1 - 1e-7), { norad: 99011 }), seed(L12 * (1 + 1e-7), { epochMs: six, norad: 99011 })];
  const oneSide = [seed(L12 * (1 - 1e-7), { norad: 99012 }), seed(L12 * (1 - 2e-7), { epochMs: six, norad: 99012 })];
  const snapshot = { portId: "ocm", typeRef: T("OCM"), payload: new Uint8Array(Buffer.concat([...across, ...oneSide].map(prefixed))) };
  const loaded = await m.harness.invoke({ methodId: "load_epochs", inputs: [configuration({ epochStore: {} }), snapshot] });
  check(loaded.statusCode === 0 && x.sdnap_epochs_count() === 2, `load_epochs: ${loaded.errorCode} ${loaded.errorMessage}`);
  const p = x.sdnap_alloc(4096), f64 = (o, n) => Array.from(new Float64Array(mem(), p + o, n));
  const select = (i, t) => { const j = jdOf(iso(t)); x.sdnap_epochs_select(i, j.whole, j.frac, p); return f64(0, 3); };
  const state = (i, t) => { const j = jdOf(iso(t)); x.sdnap_epochs_at(j.whole, j.frac, i, 1, 0, p + 64, p + 512, 0); return f64(64, 6); };
  const setAt = (i, k, t) => { const j = jdOf(iso(t)); x.sdnap_epochs_set_at(i, k, j.whole, j.frac, p + 1024); return f64(1024, 6); };
  const norads = [0, 1].map((i) => { x.sdnap_epochs_series(i, p, 0, 0); return f64(0, 1)[0]; });
  const iAcross = norads.indexOf(99011), iOne = norads.indexOf(99012);
  const before = sw - 600000, after = sw + 600000;
  const sa = select(iAcross, before), sb = select(iAcross, after), so = select(iOne, before);
  const same = (u, v) => u.every((q, c) => q === v[c]);
  console.log(`store across the 1.2033 limit, 10 min each side of the switch: select ${JSON.stringify(sa)} / ${JSON.stringify(sb)}; one side: ${JSON.stringify(so)}`);
  check(sa[1] === -2 && sa[2] === 0 && sa[0] === 0 && sb[1] === -2 && sb[0] === 1, `across: select ${sa} ${sb}`);
  check(same(state(iAcross, before), setAt(iAcross, 0, before)) && same(state(iAcross, after), setAt(iAcross, 1, after)), "across: the state is the chosen set's");
  check(so[1] === 1 && so[2] > 0 && so[2] < 1, `one side: select ${so}`);
  const pe = await call("propagate_epochs", [configuration({ epochStore: {}, output: { START_TIME: iso(EPOCH + 2 * 3600000), STOP_TIME: iso(EPOCH + 4 * 3600000), STEP_SECONDS: 600 } }), snapshot]);
  const comments = Object.fromEntries(pe.map((o) => blocks(o.payload)[0]).map((b) => [b.OBJECT.NORAD_CAT_ID, b.COMMENT]));
  console.log(`propagate_epochs COMMENT: across ${JSON.stringify(comments[99011])}; one side ${JSON.stringify(comments[99012])}`);
  check(typeof comments[99011] === "string" && comments[99011].includes("2026-10-01T03:00:00") && /SPEC 14\.3/.test(comments[99011]) &&
    /different branches/.test(comments[99011]) && comments[99012] == null, `propagate_epochs COMMENT: ${JSON.stringify(comments)}`);
}

// --- the epoch store between a carried forecast and the theory (SPEC 14.3, 18.3)
{
  const c = CLASSES.find((q) => q.name === "LEO 500 km");
  const rec = await carriedRecord(h, c, { norad: 99320 });
  // the second set 12 h after the record's epoch, the switch by epoch half way (inside the span); the span ends at `end`
  const T0 = Date.parse(`${CARRIED_EPOCH}Z`), E0 = Date.parse(`${ocmOf(rec.ocm).MEAN_ELEMENTS.EPOCH.replace(/Z$/, "")}Z`);
  const twelve = E0 + 12 * 3600000, sw = E0 + 6 * 3600000, end = T0 + rec.span * 1000;
  const moved = (bytes, to = twelve) => repackOcm(bytes, (t) => { t.MEAN_ELEMENTS.EPOCH = iso(to); if (t.TRAJ_FRAME_EPOCH) t.TRAJ_FRAME_EPOCH = iso(to); });
  const prefixed = (plain) => { const b = Buffer.alloc(4 + plain.length); b.writeUInt32LE(plain.length, 0); Buffer.from(plain).copy(b, 4); return b; };
  // one series: the carried record (span 0 to 24 h), then the plain record 12 h later; the switch at 6 h lies in the span
  const mixed = { portId: "ocm", typeRef: T("OCM"), payload: new Uint8Array(Buffer.concat([rec.ocm, moved(rec.plain)].map(prefixed))) };
  // one series: the carried record, then the same record 12 h later (its forecast covers the switch too)
  const carried = { portId: "ocm", typeRef: T("OCM"), payload: new Uint8Array(Buffer.concat([rec.ocm, moved(rec.ocm)].map(prefixed))) };
  const p = x.sdnap_alloc(4096), f64 = (o, n) => Array.from(new Float64Array(mem(), p + o, n));
  const select = (t) => { const j = jdOf(iso(t)); x.sdnap_epochs_select(0, j.whole, j.frac, p); return f64(0, 3); };
  const state = (t) => { const j = jdOf(iso(t)); x.sdnap_epochs_at(j.whole, j.frac, 0, 1, 0, p + 64, p + 512, 0); return f64(64, 6); };
  const setAt = (k, t) => { const j = jdOf(iso(t)); x.sdnap_epochs_set_at(0, k, j.whole, j.frac, p + 1024); return f64(1024, 6); };
  const same = (u, v) => u.every((q, k) => q === v[k]);
  const before = sw - 600000, after = sw + 600000, past = end + 600000;
  const lm = await m.harness.invoke({ methodId: "load_epochs", inputs: [configuration({ epochStore: {} }), mixed] });
  const sm = lm.statusCode === 0 ? [select(before), select(after), select(past)] : null;
  const flies = lm.statusCode === 0 && same(state(before), setAt(0, before)) && same(state(after), setAt(0, after)) && same(state(past), setAt(1, past));
  console.log(`store, a carried forecast then the theory, 10 min each side of the switch by epoch and 10 min past the span: ${lm.statusCode === 0 ? `select ${JSON.stringify(sm)}` : lm.errorCode}`);
  check(lm.statusCode === 0 && sm[0][0] === 0 && sm[0][1] === -3 && sm[0][2] === 0 && sm[1][0] === 0 && sm[1][1] === -3 && sm[1][2] === 0 &&
    sm[2][0] === 1 && sm[2][1] === -1 && flies, `carried then theory: ${JSON.stringify(sm)}, each the chosen set's state ${flies}`);
  const lc = await m.harness.invoke({ methodId: "load_epochs", inputs: [configuration({ epochStore: {} }), carried] });
  const sc = lc.statusCode === 0 ? select(before) : null;
  const later = lc.statusCode === 0 && same(state(before), setAt(1, before));
  console.log(`store, two carried forecasts: ${lc.statusCode === 0 ? `select ${JSON.stringify(sc)}` : lc.errorCode}`);
  check(lc.statusCode === 0 && sc[0] === 1 && sc[1] === -3 && sc[2] === 0 && later, `two carried: ${JSON.stringify(sc)}, the later set's forecast ${later}`);
  // the states about the switch by epoch (inside the span), and across the span's end off the grid's points
  const grid = (from) => configuration({ epochStore: {}, output: { START_TIME: iso(from), STOP_TIME: iso(from + 2 * 3600000), STEP_SECONDS: 600 } });
  const runs = async (from, input) => {
    const cm = blocks((await call("propagate_epochs", [grid(from), input]))[0].payload)[0].COMMENT;
    return { cm, runs: sourcesOf(cm)?.map((r) => `${r.source} ${r.first}-${r.last}`) };
  };
  const inside = [await runs(T0 + 5 * 3600000, mixed), await runs(T0 + 5 * 3600000, carried)], across = await runs(end - 55 * 60000, mixed);
  // the plain record placed so the switch by epoch falls on the span's end: its window holds the end, a step named
  // after the runs (SPEC 18.8: SOURCES, then ". " and 14.3's text)
  const onEnd = { portId: "ocm", typeRef: T("OCM"), payload: new Uint8Array(Buffer.concat([rec.ocm, moved(rec.plain, 2 * end - E0)].map(prefixed))) };
  const atEnd = await runs(end - 55 * 60000, onEnd);
  console.log(`propagate_epochs COMMENT: inside the span ${JSON.stringify(inside.map((q) => q.cm))}; across its end ${JSON.stringify(across.cm)}; switch on its end ${JSON.stringify(atEnd.cm)}`);
  check(inside.every((q) => JSON.stringify(q.runs) === JSON.stringify(["CARRIED FORECAST 0-12"]) && !/Not blended/.test(q.cm)) &&
    JSON.stringify(across.runs) === JSON.stringify(["CARRIED FORECAST 0-5", "THEORY 6-12"]) && !/Not blended/.test(across.cm),
    `carried COMMENT: ${JSON.stringify([...inside.map((q) => q.cm), across.cm])}`);
  check(JSON.stringify(atEnd.runs) === JSON.stringify(["CARRIED FORECAST 0-5", "THEORY 6-12"]) &&
    typeof atEnd.cm === "string" && atEnd.cm.includes(`. Not blended (SPEC 14.3): ${iso(end).slice(0, 22)}`) && atEnd.cm.endsWith(" (a carried forecast and the theory)"),
    `switch on the span's end, COMMENT: ${JSON.stringify(atEnd.cm)}`);
}

m.destroy?.();
await h.close?.();
if (failures.length) {
  console.error(`FAIL\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Branch at epoch E2E: PASS");
process.exit(0);
