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
  if (!provider) {
    if (context.provider === 'keplerian-reference') provider = await keplerianProvider();
    else if (context.provider === 'ffm') provider = await (await import('./ffm-provider.mjs')).ffmProvider({ environment: context.environment });
    else provider = await sgp4Provider();
  }
  // Sets within marginDays of the month, and at least marginSets before and
  // after the month's own sets whatever their age, so a burn in a gap between
  // sets is bracketed. marginSets 0 is the days-only window.
  const lo = seconds(item.from) - context.marginDays * 86400, hi = seconds(item.to) + context.marginDays * 86400;
  const all = history(item.history);
  const firstAt = (t) => { const i = all.findIndex((r) => seconds(r.EPOCH) >= t); return i < 0 ? all.length : i; };
  const lastBefore = (t) => all.findLastIndex((r) => seconds(r.EPOCH) < t);
  const margin = context.marginSets ?? 0;
  const a = Math.min(firstAt(lo), Math.max(0, firstAt(seconds(item.from)) - margin));
  const b = Math.max(lastBefore(hi), Math.min(all.length - 1, lastBefore(seconds(item.to)) + margin));
  const rows = all.slice(a, b + 1);
  if (rows.length < 8) return { item, sets: rows.length, variants: Object.fromEntries(context.variants.map((v) => [v.name, []])) };
  const { queries, results } = await detectWith(detector, provider, rows, context.variants.map((v) => v.options));
  const from = seconds(item.from), to = seconds(item.to);
  const variants = {};
  context.variants.forEach((v, k) => {
    variants[v.name] = results[k].maneuvers.map(unpackMnv)
      .filter((m) => { const t = seconds(m.EVENT_START_TIME); return t >= from && t < to; })
      .map((m) => ({ ID: m.ID, SAT_NO: m.SAT_NO, ORIG_OBJECT_ID: m.ORIG_OBJECT_ID, EVENT_START_TIME: m.EVENT_START_TIME,
        EVENT_END_TIME: m.EVENT_END_TIME, DELTA_VEL: m.DELTA_VEL, DELTA_VEL_V: m.DELTA_VEL_V, DELTA_VEL_W: m.DELTA_VEL_W,
        CHARACTERIZATION: m.CHARACTERIZATION, ALGORITHM: m.ALGORITHM, MNVR_ACCELS: m.MNVR_ACCELS }));
  });
  return { item, sets: rows.length, queries, variants };
}
export { MODULE_DIR };
