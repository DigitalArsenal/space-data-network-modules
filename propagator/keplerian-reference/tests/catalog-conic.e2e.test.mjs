/**
 * Promoted Lowell astorb $SBD rows through the built catalog WASM, using the
 * committed astorb-sample and JPL Horizons fixtures (heliocentric ICRF; TDB
 * seconds past J2000; state in m and m/s). Horizons supplies the non-element
 * epochs, exercising rebase, and independently checks their drawn positions
 * within 2,000 km, the existing sample's perturbed-path accuracy envelope.
 *
 * These fixtures publish no period. The TEST-ONLY period oracle is Kepler's
 * 2*pi*sqrt(a^3/GM), from each fixture's a in AU (IAU 2012: 149597870700 m)
 * and DE440 BODY10_GM = 1.3271244004127942e11 km^3/s^2:
 * https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/gm_de440.tpc
 * The 0.1% tolerance permits the conic's planetary perturbations after rebase.
 * Equality at the drawing epoch is exact; one-period position and velocity
 * closure each allow 1e-6 relative to their own vector norm (roundoff margin).
 * No application physics runs in JS: the formula below is only a test oracle.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { threadedExports } from "./threaded.mjs";

const fixture = (name) => new URL(`fixtures/${name}`, import.meta.url);
const stream = fs.readFileSync(fixture("astorb-sample.fbs"));
const records = JSON.parse(fs.readFileSync(fixture("astorb-sample.json"), "utf8"));
const horizons = JSON.parse(fs.readFileSync(fixture("horizons-astorb-sample.json"), "utf8"));
const DAY = 86400;
const OUTSIDE_VALIDITY = -10;
// Layout of the existing scene catalog ingest path (small_body_catalog.hpp).
const S = { COUNT: 2, CONTROL: 4, PARAMS: 5, VALIDITY: 12 };
const P = { DATA: 12, LENGTH: 13, H_MIN: 15, H_MAX: 16 };

function relativeVectorError(actual, expected, first) {
  return Math.hypot(...actual.slice(first, first + 3).map((v, i) => v - expected[first + i])) /
    Math.hypot(...expected.slice(first, first + 3));
}

test("promoted catalog conics match the drawn state, escape validity, and close after one period", { timeout: 30000 }, async (t) => {
  const x = await threadedExports(fs.readFileSync(new URL("../dist/isomorphic/module.wasm", import.meta.url)), { threads: 2 });
  t.after(() => x.harness.destroy());
  const table = new Uint32Array(x.memory.buffer, x.kepler_catalog_init(records.length, 32, 2), 16);
  const control = new Int32Array(x.memory.buffer, table[S.CONTROL], 8);
  const params = new Float64Array(x.memory.buffer, table[S.PARAMS], 32);
  const input = x.plugin_alloc(stream.length);
  new Uint8Array(x.memory.buffer, input, stream.length).set(stream);
  params[P.DATA] = input;
  params[P.LENGTH] = stream.length;
  params[P.H_MIN] = params[P.H_MAX] = NaN;
  const seq = x.kepler_catalog_ingest_begin();
  while (Atomics.load(control, 1) < seq) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(Atomics.load(control, 3), records.length);
  assert.equal(table[S.COUNT], records.length);
  x.plugin_free(input, stream.length);
  const validity = Array.from(new Float64Array(x.memory.buffer, table[S.VALIDITY], 2));
  const out = x.plugin_alloc(56);
  t.after(() => x.plugin_free(out, 56));
  const read = () => Array.from(new Float64Array(x.memory.buffer, out, 7));
  let worstPeriod = 0, worstPositionClosure = 0, worstVelocityClosure = 0, checked = 0;

  for (const number of [101955, 433, 4, 1]) {
    const record = records.find((row) => row.number === number);
    const row = x.kepler_catalog_find_number(number);
    assert.ok(row >= 0, `${number} is ingested`);
    assert.equal(x.kepler_catalog_promote(row, 0), 0);
    // Interpret the fixture's calendar label as TDB, without a UTC correction.
    const epoch = (Date.parse(`${record.epoch}Z`) / 86400000 + 2440587.5 - 2451545) * DAY;
    const reference = horizons.rows.find((r) => r.number === number && (r.jd_tdb - 2451545) * DAY > epoch);
    assert.ok(reference, `${number} has a Horizons epoch after the element epoch`);
    const oraclePeriod = 2 * Math.PI * Math.sqrt((record.a_au * 149597870700) ** 3 / 1.3271244004127942e20);

    for (const etOsc of [epoch, (reference.jd_tdb - 2451545) * DAY]) {
      assert.equal(x.kepler_catalog_state(etOsc, 0, out), 0);
      const drawn = read().slice(0, 6);
      assert.equal(x.kepler_catalog_conic_state(etOsc, etOsc, 0, out), 0);
      const start = read();
      assert.deepEqual(start.slice(0, 6), drawn, `${number}: exact drawn-state identity at ${etOsc}`);
      if (etOsc !== epoch) {
        const error = Math.hypot(...drawn.slice(0, 3).map((v, i) => v - reference.position_km[i] * 1000));
        assert.ok(error <= 2e6, `${number}: Horizons position error ${error} m`);
      }
      const periodError = Math.abs(start[6] / oraclePeriod - 1);
      assert.ok(periodError <= 0.001, `${number}: period relative error ${periodError}`);
      worstPeriod = Math.max(worstPeriod, periodError);
      for (const et of [etOsc - 400 * DAY, etOsc + 400 * DAY]) {
        assert.ok(et < validity[0] || et > validity[1]);
        assert.equal(x.kepler_catalog_state(et, 0, out), OUTSIDE_VALIDITY);
        assert.equal(x.kepler_catalog_conic_state(etOsc, et, 0, out), 0);
        assert.ok(read().every(Number.isFinite), `${number}: finite conic outside validity`);
        assert.equal(x.kepler_catalog_conic_state(et, et, 0, out), OUTSIDE_VALIDITY);
      }
      assert.equal(x.kepler_catalog_conic_state(etOsc, etOsc + start[6], 0, out), 0);
      const closed = read();
      const positionError = relativeVectorError(closed, start, 0);
      const velocityError = relativeVectorError(closed, start, 3);
      assert.ok(positionError <= 1e-6, `${number}: one-period position closure ${positionError}`);
      assert.ok(velocityError <= 1e-6, `${number}: one-period velocity closure ${velocityError}`);
      worstPositionClosure = Math.max(worstPositionClosure, positionError);
      worstVelocityClosure = Math.max(worstVelocityClosure, velocityError);
      ++checked;
    }
  }
  t.diagnostic(`${checked} conics: exact state identity; finite at +/-400 days; worst period error=${worstPeriod}; closure position=${worstPositionClosure}, velocity=${worstVelocityClosure}`);
});
