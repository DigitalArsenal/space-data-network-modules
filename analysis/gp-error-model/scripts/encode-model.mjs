// A model in its readable form (data/e14-s3-kc.json, docs/*.json, a finalize or hpop_coverage output written as JSON) as
// the one $ERM MODEL record the module's model ports take (attach_covariance's models port, calibrate_covariance,
// accumulate, scale_model, screening_evaluation, hpop_arcs, hpop_coverage). `--sources a,b` names the sources whose own
// model it is and `--pooled` marks it the model pooled over all sources, as a recipe uses it.
//
//   node scripts/encode-model.mjs data/e14-s3-kc.json --out data/e14-s3-kc.erm [--sources celestrak-gp,space-track-gp] [--pooled]
import fs from 'node:fs';
import { encode, decode } from './erm-codec.mjs';

const [input, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const value = (name) => (rest.indexOf(`--${name}`) >= 0 ? rest[rest.indexOf(`--${name}`) + 1] : undefined);
if (!input || !value('out')) throw new Error('usage: encode-model.mjs <model.json> --out <model.erm> [--sources a,b] [--pooled]');
const model = JSON.parse(fs.readFileSync(input, 'utf8'));
if (value('sources') !== undefined) model.sources = value('sources').split(',').filter(Boolean);
if (flag('pooled')) model.pooled = true;
const bytes = encode('model', model);
// The record must give back every number of the readable form, bit for bit.
const back = decode(bytes);
const numbers = (x) => (typeof x === 'number' ? [x] : Array.isArray(x) ? x.flatMap(numbers) : x && typeof x === 'object' ? Object.keys(x).sort().flatMap((k) => numbers(x[k])) : []);
for (const key of ['regimes', 'ageBinsDays', 'horizonsDays', 'strata', 'cells', 'factors']) {
  const a = numbers(model[key] ?? []), b = numbers(back[key] ?? []);
  if (a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]))) throw new Error(`${key}: the $ERM record does not give back the numbers`);
}
fs.writeFileSync(value('out'), bytes);
console.log(`wrote ${value('out')}: ${bytes.length} bytes, one $ERM MODEL record (${back.kind}, ${back.strata?.length ?? back.regimes?.length ?? 0} strata)`);
