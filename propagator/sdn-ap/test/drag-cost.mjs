// modules-sdn-ap-drag-high-eccentricity-20261103: ms per object-day of `propagate` over 7 days (browser host), the seeded
// HEO sets with drag (B 0.044, NRLMSISE-00), two modules interleaved, median of `runs`. node drag-cost.mjs <before.wasm> <after.wasm> [runs]
import {runModelTruth} from './lib/heo-model-truth.mjs';
import {requireTruth} from './lib/ffm-truth.mjs';
requireTruth('ea4576901f9e8dc21af2c24feb7887645706ef934488cb9756a0b5c21ab47934'); // the model truth: FFM 2.3.0 (modules 48a00fd6), 2.2.1's truth bit for bit
const [before, after, runs = '9'] = process.argv.slice(2);
const FIXTURES = {
  Molniya: {n: 2, e: 0.74, i: 63.4, raan: 300, argp: 270, ma: 10},
  GTO: {n: 2.40, e: 0.72, i: 27, raan: 40, argp: 270, ma: 10},
  'GTO-500': {n: 2.40, e: 0.7081, i: 27, raan: 40, argp: 270, ma: 10},
};
const median = (a) => { const v = a.toSorted((x, y) => x - y), i = v.length >> 1; return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2; };
for (const [name, f] of Object.entries(FIXTURES))
  for (const grid of [60, 1]) {
    const t = {before: [], after: []};
    for (let k = 0; k < Number(runs); ++k)
      for (const [arm, modulePath] of [['before', before], ['after', after]])
        t[arm].push((await runModelTruth({name, ...f, drag: true, mode: 'seed', costGridMinutes: grid, modulePath})).costMs / 7);
    console.log(JSON.stringify({fixture: name, gridMinutes: grid, msPerObjectDay: {before: median(t.before), after: median(t.after)}}));
  }
