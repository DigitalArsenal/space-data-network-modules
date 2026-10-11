// node tests/measure/run.mjs --source iss|starlink|gnss|slr|slr-leo [--fit-hours 24] [--stride-hours 24] [--leads 1,3,7] [--limit N] [--out results/<source>.json]
// Fits SGP4-XP (propagator/sgp4-xp) and SGP4 (analysis/gp-error-model fit_elements) to the same ephemeris windows and
// scores both on the days after the fit. SDN_GP_ERROR_MODEL names the gp-error-model 0.2.0 checkout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule, loadSgp4Fitter } from './lib/modules.mjs';
import * as sources from './lib/sources.mjs';
import { run } from './lib/experiment.mjs';
import { summarize } from './lib/summary.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []));
const source = args.source ?? 'iss';
const fitHours = Number(args['fit-hours'] ?? 24);
const strideHours = Number(args['stride-hours'] ?? fitHours);
const leads = (args.leads ?? '1,3,7').split(',').map(Number);
const limit = args.limit ? Number(args.limit) : undefined;

const objects = source === 'iss' ? await sources.iss()
  : source === 'starlink' ? await sources.starlink({ limit: limit ?? 20 })
  : source === 'gnss' ? sources.gnss({ norads: args.norads?.split(',').map(Number), perConstellation: Number(args.per ?? 2), days: Number(args.days ?? 20) })
  : source === 'slr' ? (args.targets ?? 'lageos1,lageos2,etalon1,etalon2').split(',').flatMap((target) => sources.slr({ target, weeks: Number(args.weeks ?? 3) }))
  : source === 'slr-leo' ? (args.targets ?? 'ajisai,starlette,stella,larets,westpac,lares,lares2').split(',').flatMap((target) => sources.slrLeo({ target, arcs: Number(args.arcs ?? 8) }))
  : (() => { throw new Error(`unknown source ${source}`); })();
console.error(`${source}: ${objects.length} objects, fit ${fitHours} h, stride ${strideHours} h, leads ${leads}`);

const mod = await loadModule();
const gem = args['no-sgp4'] ? null : await loadSgp4Fitter();
const started = performance.now();
const rows = await run({ objects, fitSeconds: fitHours * 3600, strideSeconds: strideHours * 3600, leadDays: leads, mod, gem,
  onRow: (r) => console.error(`${r.object} ${r.start} xp ${r.xp.error ?? `${r.xp.fit.toFixed(4)} d1 ${r.xp.days[1]?.rms.toFixed(3)}`} | sgp4 ${r.sgp4?.error ?? `${r.sgp4?.fit.toFixed(4)} d1 ${r.sgp4?.days[1]?.rms.toFixed(3)}`}`) });
await mod.destroy();
const out = { source, fitHours, strideHours, leads, objects: objects.length, sgp4Fitter: gem ? `analysis/gp-error-model ${gem.version} fit_elements` : null, seconds: (performance.now() - started) / 1000, summary: summarize(rows, leads), rows };
const file = args.out ?? fileURLToPath(new URL(`results/${source}-${fitHours}h.json`, import.meta.url));
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(out.summary, null, 1));
