// One calendar month of one object's element-set history through the detector
// and the plugged propagator, for every options variant (a worker task). Sets
// within `marginDays` of the month are included; events are kept in it.
import fs from 'node:fs';
import { loadModule, sgp4Provider, keplerianProvider, detectWith, unpackMnv, seconds, MODULE_DIR } from './host.mjs';

let detector = null, provider = null;
const histories = new Map();

function history(path) {
  if (!histories.has(path)) histories.set(path, JSON.parse(fs.readFileSync(path, 'utf8')));
  return histories.get(path);
}

export async function run(item, context) {
  detector ??= await loadModule('analysis/maneuver-detection', context.modulesRoot ?? undefined);
  provider ??= context.provider === 'keplerian-reference' ? await keplerianProvider() : await sgp4Provider();
  const lo = seconds(item.from) - context.marginDays * 86400, hi = seconds(item.to) + context.marginDays * 86400;
  const rows = history(item.history).filter((r) => { const t = seconds(r.EPOCH); return t >= lo && t < hi; });
  if (rows.length < 8) return { item, sets: rows.length, variants: Object.fromEntries(context.variants.map((v) => [v.name, []])) };
  const { queries, results } = await detectWith(detector, provider, rows, context.variants.map((v) => v.options));
  const from = seconds(item.from), to = seconds(item.to);
  const variants = {};
  context.variants.forEach((v, k) => {
    variants[v.name] = results[k].maneuvers.map(unpackMnv)
      .filter((m) => { const t = seconds(m.EVENT_START_TIME); return t >= from && t < to; })
      .map((m) => ({ ID: m.ID, SAT_NO: m.SAT_NO, ORIG_OBJECT_ID: m.ORIG_OBJECT_ID, EVENT_START_TIME: m.EVENT_START_TIME,
        EVENT_END_TIME: m.EVENT_END_TIME, DELTA_VEL: m.DELTA_VEL, DELTA_VEL_U: m.DELTA_VEL_U, DELTA_VEL_V: m.DELTA_VEL_V,
        CHARACTERIZATION: m.CHARACTERIZATION, ALGORITHM: m.ALGORITHM, MNVR_ACCELS: m.MNVR_ACCELS }));
  });
  return { item, sets: rows.length, queries, variants };
}
export { MODULE_DIR };
