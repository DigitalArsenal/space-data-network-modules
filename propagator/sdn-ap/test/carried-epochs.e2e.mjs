#!/usr/bin/env node
// E2E (issue 316, SPEC 18): a record that carries a forecast round-trips through the epoch store. A GTO record (e 0.72,
// AP's flight on the theory's flux model is SGP4XP here) carrying its forecast, loaded by load_epochs beside the low-orbit
// record without one (a second object, size-prefixed records end to end in one frame):
// - sdnap_epochs_set_at, sdnap_epochs_at (TEME) and propagate_epochs (TEME) give propagate's states of the same record
//   at 200 times inside the span to 1e-9 km (the store times the forecast by the call's split Julian date), at 20 after
//   it to 1e-5 km (the theory, which the store times in minutes from J2000), and there the plain record's state;
// - every state labeled (SPEC 18.8): propagate_epochs writes one block per series, its COMMENT's runs (parsed by the
//   grammar) CARRIED FORECAST inside the span and THEORY after it, as propagate's, and sdnap_epochs_source_at 1 and 0
//   at the same times;
// - records split by day (one object's forecast carried by two records, each half its span): the store flies, at every
//   time, the set whose span holds it, as propagate flies that record (to 1e-9 km), labeled carried;
// - the record unpacked and packed again by the SDS bindings flies the same, bit for bit;
// - the store's bytes count the forecast it holds (sdnap_epochs_stats).
// JS only moves bytes and compares numbers the module produced.
//   node test/carried-epochs.e2e.mjs
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { wasmPath } from "./lib/module.mjs";
import { CLASSES, harness, carriedRecord, fly, dist, isoAt } from "./lib/carried.mjs";
import { T, repackOcm } from "./lib/ocm.mjs";
import { configuration } from "./lib/pcf.mjs";
import { jdOf } from "./lib/frames.mjs";

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await harness();
const gto = await carriedRecord(h, CLASSES.find((q) => q.name.startsWith("GTO")));
const leo = await carriedRecord(h, CLASSES.find((q) => q.name === "LEO 500 km"), { norad: 99301 });
const sizePrefixed = (bytes) => { const b = new Uint8Array(4 + bytes.length); new DataView(b.buffer).setUint32(0, bytes.length, true); b.set(bytes, 4); return b; };
const stream = new Uint8Array([...sizePrefixed(gto.ocm), ...sizePrefixed(leo.plain)]);

const inside = Array.from({ length: 200 }, (_, k) => (gto.span * (k + 0.37)) / 200);
const outside = Array.from({ length: 20 }, (_, k) => gto.span + 60 + 900 * k);
const times = [...inside, ...outside];
const ref = await fly(h, gto.ocm, times, pcfOutputFrame.TEME);
const plain = await fly(h, gto.plain, outside, pcfOutputFrame.TEME);

const d = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const x = d.instance.exports;
const r = await d.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: stream }] });
check(r.statusCode === 0, `load_epochs: ${r.errorCode} ${r.errorMessage}`);
check(x.sdnap_epochs_count() === 2, `the store holds ${x.sdnap_epochs_count()} series, not 2`);
const p = x.sdnap_alloc(8 * 64);
// the carried record's series: NORAD 99300 (the low-orbit record is 99301)
let gi = -1;
for (let i = 0; i < 2; i++) { x.sdnap_epochs_series(i, p, 0, 0); if (new Float64Array(d.memory.buffer, p, 1)[0] === 99300) gi = i; }
check(gi >= 0, "the carried record is not in the store");
// inside the span to 1e-9 km; outside it the theory, whose store counts minutes from J2000 (about 1e-7 s of rounding,
// 1 mm at the transfer orbit's perigee speed): to 1e-5 km
const bound = (k) => (k < inside.length ? 1e-9 : 1e-5);
let worstSet = 0, worstAt = 0;
for (let k = 0; k < times.length && gi >= 0; k++) {
  const { whole, frac } = jdOf(ref[k].epoch);
  check(x.sdnap_epochs_set_at(gi, 0, whole, frac, p) === 0, `sdnap_epochs_set_at at ${times[k]} s refused`);
  const s = Array.from(new Float64Array(d.memory.buffer, p, 6));
  const es = Math.max(dist(s, ref[k].r), dist(s.slice(3), ref[k].v));
  x.sdnap_epochs_at(whole, frac, gi, 1, 0, p, 0, 0);
  const a = Array.from(new Float64Array(d.memory.buffer, p, 6));
  const ea = Math.max(dist(a, ref[k].r), dist(a.slice(3), ref[k].v));
  check(es < bound(k) && ea < bound(k), `${times[k]} s: the store is ${es} / ${ea} km from propagate's state`);
  if (k < inside.length) { worstSet = Math.max(worstSet, es); worstAt = Math.max(worstAt, ea); }
}
// outside the span, the theory
for (let k = 0; k < outside.length; k++) check(dist(ref[inside.length + k].r, plain[k].r) < 1e-12, `${outside[k]} s, after the span: not the theory's state`);
// propagate_epochs on the carried record alone
{
  const o = await d.invoke({ methodId: "propagate_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: gto.ocm }, configuration({ output: { EPOCHS: times.map(isoAt), FRAME: pcfOutputFrame.TEME } })] });
  check(o.statusCode === 0, `propagate_epochs: ${o.errorCode} ${o.errorMessage}`);
  if (o.statusCode === 0) {
    const blocks = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(new Uint8Array(o.outputs[0].payload))).unpack().EPHEMERIS_DATA_BLOCK;
    check(blocks.length === 1, `propagate_epochs writes ${blocks.length} blocks for one series, not 1`);
    const { oemLines } = await import("./lib/carried.mjs");
    const lines = oemLines(o.outputs[0].payload);
    const over = Math.max(...lines.map((l, k) => Math.max(dist([l.X, l.Y, l.Z], ref[k].r), dist([l.X_DOT, l.Y_DOT, l.Z_DOT], ref[k].v)) / bound(k)));
    check(over < 1, `propagate_epochs is farther from propagate's states than the bound (${over} of it)`);
    // SPEC 18.8: every state labeled, as propagate labels it
    check(lines.length === times.length && lines.every((l, k) => l.source === (k < inside.length ? "CARRIED FORECAST" : "THEORY") && l.source === ref[k].source),
      `propagate_epochs' labels: ${[...new Set(lines.map((l) => l.source))].join(", ")} in ${blocks.length} blocks`);
    // and sdnap_epochs_source_at at the same times
    const codes = times.map((t, k) => { const { whole, frac } = jdOf(ref[k].epoch); x.sdnap_epochs_source_at(whole, frac, gi, 1, p); return new Int32Array(d.memory.buffer, p, 1)[0]; });
    check(codes.every((c, k) => c === (k < inside.length ? 1 : 0)), "sdnap_epochs_source_at does not label the store's states as carried inside the span and theory after it");
  }
}
// unpacked and packed again
{
  const again = repackOcm(gto.ocm, () => {});
  const a = await fly(h, again, times.slice(0, 50), pcfOutputFrame.TEME);
  check(a.every((s, k) => s.r.every((v, j) => Object.is(v, ref[k].r[j])) && s.v.every((v, j) => Object.is(v, ref[k].v[j]))), "the record repacked by the SDS bindings flies otherwise");
}
// records split by day (SPEC 18.3): one object's forecast carried by two records, its first half and its second, one
// series of two sets; at every time the store flies the set whose span holds it (the later set's where both do), as
// propagate flies that record, labeled carried
{
  const { fitCarried } = await import("./lib/carried.mjs");
  const c = CLASSES.find((q) => q.name.startsWith("GTO"));
  const half = gto.span / 2;
  const a = (await fitCarried(h, c, gto.oem, [0, half])).ocm, b = (await fitCarried(h, c, gto.oem, [half, gto.span])).ocm;
  const r2 = await d.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: new Uint8Array([...sizePrefixed(a), ...sizePrefixed(b)]) }] });
  check(r2.statusCode === 0 && x.sdnap_epochs_count() === 1, `two day records of one object: ${r2.errorCode ?? ""} ${x.sdnap_epochs_count()} series`);
  const ts = Array.from({ length: 40 }, (_, k) => (gto.span * (k + 0.5)) / 40);
  const ra = await fly(h, a, ts, pcfOutputFrame.TEME), rb = await fly(h, b, ts, pcfOutputFrame.TEME);
  let worst = 0, labels = true;
  for (let k = 0; k < ts.length; k++) {
    const want = ts[k] <= half ? ra[k] : rb[k];
    const { whole, frac } = jdOf(want.epoch);
    x.sdnap_epochs_at(whole, frac, 0, 1, 0, p, 0, 0);
    const s = Array.from(new Float64Array(d.memory.buffer, p, 6));
    worst = Math.max(worst, dist(s, want.r), dist(s.slice(3), want.v));
    x.sdnap_epochs_source_at(whole, frac, 0, 1, p);
    labels = labels && new Int32Array(d.memory.buffer, p, 1)[0] === 1;
  }
  check(worst < 1e-9, `two day records: the store is ${worst} km from the record whose span holds the time`);
  check(labels, "two day records: a state inside a span not labeled carried");
}
// the store's bytes
{
  const stats = (records) => d.invoke({ methodId: "load_epochs", inputs: records.map((payload) => ({ portId: "ocm", typeRef: T("OCM"), payload })) }).then(() => { x.sdnap_epochs_stats(p); return new Float64Array(d.memory.buffer, p, 8)[7]; });
  const withForecast = await stats([gto.ocm]), without = await stats([gto.plain]);
  const segments = gto.ocm.length - gto.plain.length;
  check(withForecast - without > segments * 0.5, `the store counts ${withForecast - without} bytes for a forecast of ${segments} record bytes`);
  console.log(`store: ${withForecast} bytes with the forecast, ${without} without (the record carries ${segments} bytes of it)`);
}
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`CARRIED-EPOCHS FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`CARRIED-EPOCHS PASS: load_epochs, sdnap_epochs_set_at, sdnap_epochs_at and propagate_epochs fly the carried record as propagate does (to ${Math.max(worstSet, worstAt).toExponential(1)} km); repacked, it flies bit for bit`);
process.exit(0);
