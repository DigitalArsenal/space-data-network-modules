#!/usr/bin/env node
// E2E (stack #599; SPEC 14.4): one record's covariance is answered one way by every entry. Eight of the synthetic set's
// fitted AP records, all fitted on sdn-ap 0.6.50 at tesseral 31 and zonal 70 and each carrying its covariance
// (test/fixtures/synthetic-*.ocm):
// - class 0: 300 km circular at i 70; 200 km at e 0.01 and i 70; 400 km at e 0.001 and i 0.5; 200 km at e 0.05 and i 98;
// - the half-day class: 20,200 km at e 0.01, i 55;
// - the one-day class: 35,786 km circular, i 0.5;
// - above e 0.3 at a high perigee: 20,200 km at e 0.5 and i 20; 5,000 km at e 0.7 and i 70.
// Each is flown at its epoch and every 30 minutes for 120 hours, TEME, by propagate and by three other entries:
//   - the epoch store (load_epochs, sdnap_epochs_at with its covariance), given the split Julian date propagate makes from its
//     ISO text (the day's 0h and the seconds of the day over 86400: omm::epoch);
//   - sdnap_covariance_at and sdnap_covariance_full_at, given the minutes from the epoch propagate computes from them.
// Every covariance element of the store and of sdnap_covariance_at equals propagate's to the bit at every instant, and
// sdnap_covariance_full_at's state block equals sdnap_covariance_at's. The four records above e 0.3 and in the resonant
// classes show what that holds against: through 0.6.52 the store's and those exports' nominal was built again from the
// parameter vector, and on the 5,000 km record at e 0.7 the store's covariance was 0.35 of the largest element away from
// propagate's. With another time arithmetic for the same instant (a split Julian date made from milliseconds, up to 0.16 µs
// away) that record's covariance moves by up to 1.4e-3 of its largest element on any build: stack #624.
// The same store on two pool threads, and a test build whose store bank keeps tables of its own (set 0 outside the slot's
// TableShareScope), give every state and covariance element to the bit.
// JS moves bytes and compares numbers the module produced.
//   node test/store-covariance.e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { buildDiagnostic } from "./lib/ap-diagnostic.mjs";
import { T, flight, ocmOf } from "./lib/ocm.mjs";
import { configuration } from "./lib/pcf.mjs";

ensureBuilt();
const IDS = ["grid-hp300-e0-i70", "grid-hp200-e0.01-i70", "grid-hp400-e0.001-i0.5", "grid-hp200-e0.05-i98",
  "grid-hp20200-e0.01-i55", "grid-hp35786-e0-i0.5", "grid-hp20200-e0.5-i20", "grid-hp5000-e0.7-i70"];
const RECORDS = IDS.map((id) => ({ id, bytes: new Uint8Array(fs.readFileSync(new URL(`fixtures/synthetic-${id}.ocm`, import.meta.url))) }));
const DAY = 86400000, STEP = 1800000, COUNT = 241;
// omm::epoch's split of a whole-second ISO time: the day's 0h, the seconds of the day over 86400
const split = (ms) => { const day = Math.floor(ms / DAY); return [2440587.5 + day, ((ms - day * DAY) / 1000) / 86400]; };
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
const FIELDS = ["CX_X", "CY_X", "CY_Y", "CZ_X", "CZ_Y", "CZ_Z", "CX_DOT_X", "CX_DOT_Y", "CX_DOT_Z", "CX_DOT_X_DOT", "CY_DOT_X", "CY_DOT_Y", "CY_DOT_Z",
  "CY_DOT_X_DOT", "CY_DOT_Y_DOT", "CZ_DOT_X", "CZ_DOT_Y", "CZ_DOT_Z", "CZ_DOT_X_DOT", "CZ_DOT_Y_DOT", "CZ_DOT_Z_DOT"];
const LOWER = []; for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) LOWER.push(6 * i + j);
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));

async function open(file, threads = 0) {
  const h = await createStandaloneHarness("browser", file, { surface: "direct", maxThreads: Math.max(1, threads), enableBrowserWasiThreads: threads > 0 });
  const x = h.instance.exports;
  if (threads) assert.equal(x.sdnap_threads(threads), threads, `${threads} pool threads`);
  const mem = () => (h.memory ?? x.memory).buffer;
  const pos = x.sdnap_alloc(48), st = x.sdnap_alloc(4), cov = x.sdnap_alloc(288), buf = x.sdnap_alloc(1 << 16), mins = x.sdnap_alloc(8 * COUNT),
    out = x.sdnap_alloc(8 * 42 * COUNT), full = x.sdnap_alloc(8 * 84 * COUNT);
  return {
    async store(r, times) {
      const loaded = await h.invoke({ methodId: "load_epochs", inputs: [configuration({ epochStore: {} }), { portId: "ocm", typeRef: T("OCM"), payload: prefixed(r.bytes) }] });
      assert.equal(loaded.statusCode, 0, `${r.id}: load_epochs ${loaded.errorCode} ${loaded.errorMessage}`);
      return times.map((t) => {
        const [w, f] = split(t);
        assert.equal(x.sdnap_epochs_at(w, f, 0, 1, 0, pos, st, cov), 0, `${r.id}: sdnap_epochs_at`);
        assert.equal(new Int32Array(mem(), st, 1)[0], 0, `${r.id} at ${new Date(t).toISOString()}: status`);
        return { s: Array.from(new Float64Array(mem(), pos, 6)), c: Array.from(new Float64Array(mem(), cov, 36)) };
      });
    },
    exports(r, minutes) {
      new Uint8Array(mem(), buf, r.bytes.length).set(r.bytes);
      new Float64Array(mem(), mins, minutes.length).set(minutes);
      assert.equal(x.sdnap_covariance_at(buf, r.bytes.length, mins, minutes.length, out), 0, `${r.id}: sdnap_covariance_at`);
      const at = Array.from(new Float64Array(mem(), out, 42 * minutes.length));
      const np = Math.round((Math.sqrt(8 * ocmOf(r.bytes).COVARIANCE_DATA.length + 1) - 1) / 2), stride = 6 + (np * (np + 1)) / 2;
      assert.equal(x.sdnap_covariance_full_at(buf, r.bytes.length, mins, minutes.length, full), 0, `${r.id}: sdnap_covariance_full_at`);
      const fu = Array.from(new Float64Array(mem(), full, stride * minutes.length));
      return minutes.map((_, j) => ({
        c: LOWER.map((q) => at[42 * j + 6 + q]),
        full: LOWER.map((q) => { const i = Math.floor(q / 6), c = q % 6; return fu[stride * j + 6 + (i * (i + 1)) / 2 + c]; }),
      }));
    },
    async propagate(r, times) {
      const p = await h.invoke({ methodId: "propagate", inputs: flight([r.bytes], { output: { EPOCHS: times.map((t) => new Date(t).toISOString().replace("Z", "")), FRAME: pcfOutputFrame.TEME } }) });
      assert.equal(p.statusCode, 0, `${r.id}: propagate ${p.errorCode} ${p.errorMessage}`);
      const lines = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p.outputs.find((o) => o.portId === "ephemeris").payload)).unpack().EPHEMERIS_DATA_BLOCK[0].COVARIANCE_MATRIX_LINES;
      assert.equal(lines.length, times.length, `${r.id}: propagate's covariance lines`);
      return lines.map((line) => FIELDS.map((f) => line[f]));
    },
  };
}

const m = await open(wasmPath);
const pooled = await open(wasmPath, 2);
const control = await open(buildDiagnostic("bank-own-tables", " ", (s) => s,
  { "covariance.inc": (t) => t.replace("xpt::TableShareScope borrow(tables);", "xpt::TableShareScope borrow(nullptr);") }));
for (const r of RECORDS) {
  const e = ocmOf(r.bytes).MEAN_ELEMENTS.EPOCH;
  const t0 = Date.parse(e.endsWith("Z") ? e : `${e}Z`);
  assert.equal(t0 % DAY, 0, `${r.id}: its epoch is at midnight`);
  const times = Array.from({ length: COUNT }, (_, j) => t0 + j * STEP);
  const [w0, f0] = split(t0);
  const minutes = times.map((t) => { const [w, f] = split(t); return ((w - w0) + (f - f0)) * 1440; });  // as propagate computes them
  const store = await m.store(r, times), exp = m.exports(r, minutes), prop = await m.propagate(r, times);
  const two = await pooled.store(r, times), own = await control.store(r, times);
  for (let j = 0; j < COUNT; j++) {
    const at = `${r.id}, hour ${j / 2}`;
    assert.ok(same(LOWER.map((q) => store[j].c[q]), prop[j]), `${at}: the store's covariance differs from propagate's`);
    assert.ok(same(exp[j].c, prop[j]), `${at}: sdnap_covariance_at's covariance differs from propagate's`);
    assert.ok(same(exp[j].full, exp[j].c), `${at}: sdnap_covariance_full_at's state block differs from sdnap_covariance_at's`);
    assert.ok(same(two[j].s, store[j].s) && same(two[j].c, store[j].c), `${at}: the store on two pool threads differs`);
    assert.ok(same(own[j].s, store[j].s) && same(own[j].c, store[j].c), `${at}: the bank with its own tables differs`);
  }
  console.log(`${r.id}: ${COUNT} instants, the store's and sdnap_covariance_at's covariance propagate's to the bit, full_at's state block covariance_at's; two pool threads and the bank with its own tables: every state and element equal`);
}
process.exit(0);
