#!/usr/bin/env node
// E2E (stack #599; SPEC 14.4): a stored set's covariance is propagate's. Four of the synthetic set's fitted AP records (fitted
// on sdn-ap 0.6.50 at tesseral 31 and zonal 70, each carrying its covariance; test/fixtures/synthetic-*.ocm): 300 km circular
// at i 70, 200 km at e 0.01 and i 70, 400 km at e 0.001 and i 0.5, 200 km at e 0.05 and i 98. Each is loaded alone into the
// epoch store and flown with its covariance (sdnap_epochs_at, TEME) at its epoch and every 30 minutes for 120 hours, and
// flown through `propagate` (TEME) at the same instants:
// - every 90 minutes (the epochs are at midnight, so the two entries hold the same time to the bit there) the store's
//   covariance equals propagate's, every element to the bit;
// - at every instant it is within 1e-6 of the matrix's largest element of propagate's. Elsewhere the two entries' times
//   differ in their last bits: the caller's split Julian date against propagate's ISO text. Through 0.6.52 the store's bank
//   built its nominal again from the parameter vector, and the store's covariance was 7.9e-4 off on the first record;
// - a test build whose bank's nominal keeps tables of its own (set 0 outside the slot's TableShareScope) gives the same
//   states and covariance at every instant, to the bit: borrowing the slot's tables changes nothing.
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
const IDS = ["grid-hp300-e0-i70", "grid-hp200-e0.01-i70", "grid-hp400-e0.001-i0.5", "grid-hp200-e0.05-i98"];
const RECORDS = IDS.map((id) => ({ id, bytes: new Uint8Array(fs.readFileSync(new URL(`fixtures/synthetic-${id}.ocm`, import.meta.url))) }));
const DAY = 86400000, STEP = 1800000, COUNT = 241, BOUND = 1e-6;
const jd = (ms) => { const d = ms / DAY; return [Math.floor(d) + 2440587.5, d - Math.floor(d)]; };
const prefixed = (u) => { const b = Buffer.alloc(4 + u.length); b.writeUInt32LE(u.length, 0); Buffer.from(u).copy(b, 4); return b; };
// the 21 elements of an OEM covariance line, in order, and their places in a row-major 6 x 6 matrix
const FIELDS = ["CX_X", "CY_X", "CY_Y", "CZ_X", "CZ_Y", "CZ_Z", "CX_DOT_X", "CX_DOT_Y", "CX_DOT_Z", "CX_DOT_X_DOT", "CY_DOT_X", "CY_DOT_Y", "CY_DOT_Z",
  "CY_DOT_X_DOT", "CY_DOT_Y_DOT", "CZ_DOT_X", "CZ_DOT_Y", "CZ_DOT_Z", "CZ_DOT_X_DOT", "CZ_DOT_Y_DOT", "CZ_DOT_Z_DOT"];
const LOWER = []; for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) LOWER.push(6 * i + j);
const same = (a, b) => a.length === b.length && a.every((v, q) => Object.is(v, b[q]));

async function open(file) {
  const h = await createStandaloneHarness("browser", file, { surface: "direct", maxThreads: 1, enableBrowserWasiThreads: false });
  const x = h.instance.exports;
  const mem = () => (h.memory ?? x.memory).buffer;
  const pos = x.sdnap_alloc(48), st = x.sdnap_alloc(4), cov = x.sdnap_alloc(288);
  // the record's states and covariance from the epoch store, and its covariance lines from propagate
  return async (r, times) => {
    const loaded = await h.invoke({ methodId: "load_epochs", inputs: [configuration({ epochStore: {} }), { portId: "ocm", typeRef: T("OCM"), payload: prefixed(r.bytes) }] });
    assert.equal(loaded.statusCode, 0, `${r.id}: load_epochs ${loaded.errorCode} ${loaded.errorMessage}`);
    const store = times.map((t) => {
      const [w, f] = jd(t);
      assert.equal(x.sdnap_epochs_at(w, f, 0, 1, 0, pos, st, cov), 0, `${r.id}: sdnap_epochs_at`);
      assert.equal(new Int32Array(mem(), st, 1)[0], 0, `${r.id} at ${new Date(t).toISOString()}: status`);
      return { s: Array.from(new Float64Array(mem(), pos, 6)), c: Array.from(new Float64Array(mem(), cov, 36)) };
    });
    const p = await h.invoke({ methodId: "propagate", inputs: flight([r.bytes], { output: { EPOCHS: times.map((t) => new Date(t).toISOString().replace("Z", "")), FRAME: pcfOutputFrame.TEME } }) });
    assert.equal(p.statusCode, 0, `${r.id}: propagate ${p.errorCode} ${p.errorMessage}`);
    const blk = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(p.outputs.find((o) => o.portId === "ephemeris").payload)).unpack().EPHEMERIS_DATA_BLOCK[0];
    assert.equal(blk.COVARIANCE_MATRIX_LINES.length, times.length, `${r.id}: propagate's covariance lines`);
    return { store, propagate: blk.COVARIANCE_MATRIX_LINES.map((line) => FIELDS.map((f) => line[f])) };
  };
}

const fly = await open(wasmPath);
const control = await open(buildDiagnostic("bank-own-tables", " ", (s) => s,
  { "covariance.inc": (t) => t.replace("xpt::TableShareScope borrow(tables);", "xpt::TableShareScope borrow(nullptr);") }));
for (const r of RECORDS) {
  const e = ocmOf(r.bytes).MEAN_ELEMENTS.EPOCH;
  const t0 = Date.parse(e.endsWith("Z") ? e : `${e}Z`);
  assert.equal(t0 % DAY, 0, `${r.id}: its epoch is at midnight`);
  const times = Array.from({ length: COUNT }, (_, j) => t0 + j * STEP);
  const a = await fly(r, times), b = await control(r, times);
  let worst = 0, exact = 0;
  for (let j = 0; j < COUNT; j++) {
    const mine = LOWER.map((q) => a.store[j].c[q]), theirs = a.propagate[j];
    const big = Math.max(...theirs.map(Math.abs)), d = Math.max(...mine.map((v, q) => Math.abs(v - theirs[q])));
    worst = Math.max(worst, d / big);
    assert.ok(d <= BOUND * big, `${r.id}, hour ${j / 2}: the store's covariance is ${(d / big).toExponential(2)} of the largest element from propagate's (bound ${BOUND})`);
    if (j % 3 === 0) {
      assert.ok(same(mine, theirs), `${r.id}, hour ${j / 2} (both entries at the same time): the store's covariance differs from propagate's`);
      exact += 1;
    }
    assert.ok(same(a.store[j].s, b.store[j].s) && same(a.store[j].c, b.store[j].c), `${r.id}, hour ${j / 2}: the bank with its own tables differs`);
  }
  console.log(`${r.id}: the store's covariance against propagate's: equal to the bit at the ${exact} instants every 90 minutes, at most ${worst.toExponential(2)} of the largest element over ${COUNT}; the bank with its own tables: every state and element equal`);
}
process.exit(0);
