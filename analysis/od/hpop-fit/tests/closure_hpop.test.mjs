// Closure gate, HPOP fitter (owner 2026-10-10): on maneuver-free ephemerides
// generated with every perturbation on, a fit on the first half reproduces
// every point of the second half within 1 cm. The truth comes from
// propagator/hpop (an independent artifact); the fit reads it as a CCSDS OEM
// KVN in memory. OD_HPOP_SWEEP=<n> adds n randomized cases per regime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFit, loadHpop, hpopTruth, kvn, fit, isoAt } from './lib/harness.mjs';
import { CASES, makeCase } from './closure-cases.mjs';

const GATE_KM = 1e-5;  // 1 cm
const extra = Number(process.env.OD_HPOP_SWEEP ?? 0);
const cases = [...CASES];
for (let n = 0; n < extra; ++n) for (const regime of ['leo-drag', 'leo-upper', 'meo', 'geo', 'heo']) cases.push(makeCase(5000 + 10 * n + cases.length, regime));

for (const c of cases) {
  test(`closure <= 1 cm: ${c.regime} seed ${c.seed}, ${(c.span / 3600).toFixed(1)} h at ${c.step} s${c.jb2008 ? ', JB2008' : ''}`, async (t) => {
    const [hpop, od] = await Promise.all([loadHpop(), loadFit()]);
    t.after(() => { hpop.destroy?.(); od.destroy?.(); });
    const epochs = [];
    for (let s = 0; s <= c.span; s += c.step) epochs.push(isoAt(c.startMs, s));
    const truth = await hpopTruth(hpop, { epochIso: c.epochIso, state: c.state, p: c.p, drag: c.drag, jb2008: c.jb2008, epochs });
    const options = { hpopSpanSeconds: 0, ommSpanSeconds: c.span + 1, dataSource: 'SYNTHETIC', ...(c.jb2008 ? { forces: { atmosphere: 'JB2008' } } : {}) };
    const r = await fit(od, kvn(epochs, truth), options, { drag: c.drag, jb2008: c.jb2008 });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.result.ok, true, `${r.result.failureCode}: ${r.result.failureMessage}`);
    const h = r.result.hpop;
    t.diagnostic(JSON.stringify({ iterations: h.iterations, converged: h.converged, parameters: h.parameters, fitMaxKm: h.stats.max3dKm,
      closureMaxKm: h.closure.secondHalf?.max3dKm, closureRmsKm: h.closure.secondHalf?.rms3dKm, n: h.closure.secondHalf?.n }));
    assert.equal(h.closure.done, true, h.closure.error);
    assert.equal(h.closure.secondHalf.n, epochs.filter((iso) => Date.parse(`${iso}Z`) > Date.parse(`${h.closure.splitEpoch}Z`)).length, 'every second-half point is scored');
    assert.ok(h.closure.secondHalf.max3dKm <= GATE_KM, `closure max ${(h.closure.secondHalf.max3dKm * 1e5).toFixed(3)} cm`);
    // The stored product is the full-span fit, scored on every point.
    assert.equal(h.stats.n, epochs.length);
    assert.ok(h.stats.max3dKm <= GATE_KM);
  });
}
