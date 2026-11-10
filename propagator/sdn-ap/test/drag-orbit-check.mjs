// modules-sdn-ap-drag-high-eccentricity-20261103: the drag's averaged rates (SPEC 3.4, 16.12) against the module's
// independent integral over one orbit (sdnap_drag_orbit_check) on the HEO fixtures, BTERM pinned at 0.044.
// node drag-orbit-check.mjs [samples] [module]
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('a9133120775291c4dfbf9151d0617850be560934943a178419fdd8e3fed765e4'); // the model truth: FFM 2.2.1 (modules 9cb02c8e)
const [samples = '20000', modulePath] = process.argv.slice(2);
const FIXTURES = {
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10},
  GTO: {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10},
  'GTO-500': {n: 2.40, e: 0.7081, i: 27, raan: 40, argp: 270, ma: 10},
};
const names = ['a', 'a ef', 'a eg', '2a chi', '2a psi', 'a lambda'];
for (const [name, f] of Object.entries(FIXTURES)) {
  const r = await runModelTruth({name, ...f, drag: true, mode: 'seed', seedGridMin: 1440, seedDays: 7, dragCheck: Number(samples), modulePath});
  for (const q of r.dragCheck) {
    const d = q.theory.map((v, k) => v - q.check[k]);
    console.log(`${name} day ${q.day}: per-orbit change m (rates / integral / difference): ` + names.map((n, k) => `${n} ${q.theory[k].toFixed(3)} / ${q.check[k].toFixed(3)} / ${d[k].toFixed(3)}`).join('; ') + `; RMS difference ${Math.sqrt(d.reduce((s, v) => s + v * v, 0) / 6).toFixed(3)} m`);
  }
}
