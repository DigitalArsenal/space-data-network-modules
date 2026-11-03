// The AP5 GN windows of the 2026-11-03 gap diagnosis (experiments ap-gap, method gn and the FRAME,RESONANCE frame arm),
// replayed on this module: XP2F_CONTROL=1, XM's GN objects and daily cutoffs, the truth's 300 s scoring grid, lead-day
// bins of at least 260 epochs, arcs [cutoff - arc, cutoff] at 90 % coverage thinned to 300 s, USEABLE_START_TIME the
// arc's first state. Exploratory: these windows were read by the diagnosis. Errors are km, forecast minus truth, RTN.
import path from 'node:path';
import {parentPort, workerData} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';

import {experiments} from './experiments.mjs';
export {experiments};
export const archive = '/opt/data/sdn-archive/operator-theory/ap-gap';
const modules = fileURLToPath(new URL('../../../../', import.meta.url));

/** Arms: XP24 and XP72 at the module's default FIT; XP_PRIOR24 the tested constants stated in $PCF FIT. */
export const ARMS = {
  XP24: {hours: 24, fit: null},
  XP_PRIOR24: {hours: 24, fit: {dragPrior: {mean: 0, sigma: 0.05}, srpPrior: {mean: 0, sigma: 0.1}}},
  XP72: {hours: 72, fit: null},
};

async function replay({modulePath, norad, shard, shards, keys}) {
  process.env.XP2F_CONTROL = '1';
  process.env.SDN_MODULES_ROOT = modules;
  const {config, root, HOUR, DAY, iso, ms, rms, XM} = await import(experiments + '/experiments/xp2-fit-design/common.mjs');
  const S = await import(path.join(root, config.xm.dir, 'lib/sds.mjs'));
  const T = await import(path.join(root, config.xm.dir, 'lib/truth.mjs'));
  const {openModules} = await import(path.join(root, config.xm.dir, 'lib/modules.mjs'));
  const {openAp} = await import(experiments + '/experiments/operator-theory/lib/ap.mjs');
  const {windowKey} = await import(experiments + '/experiments/operator-theory/lib/regimes.mjs');
  const m = await openModules(), A = await openAp(modulePath);
  const LEADS = XM.config.scoring.leadDays, GRID = XM.config.scoring.gridSeconds * 1000;
  const MIN_BIN = XM.config.scoring.binMinimumEpochs, MIN_COV = XM.config.fit.minimumCoverage;
  const cutoffs = XM.daysOf(XM.config.period.from, XM.config.period.to);
  const base = XM.config.groups.GN.objects.find((o) => o.norad === norad);
  const o = {...base, group: 'GN', objectId: '', lines: T.series(base, cutoffs[0] - 3 * DAY, cutoffs.at(-1) + 7 * DAY).lines};
  const times = o.lines.map((l) => ms(l.epoch));
  const stepMs = times.length > 1 ? times[1] - times[0] : GRID;
  const gridMs = Math.max(GRID, Math.ceil(GRID / stepMs) * stepMs);
  const minBin = Math.ceil((MIN_BIN / (DAY / GRID)) * (DAY / gridMs));
  const between = (a, b) => { const out = []; for (let i = 0; i < times.length; i += 1) if (times[i] >= a && times[i] <= b) out.push(o.lines[i]); return out; };
  const wanted = new Map(keys.map((k) => [k.key, k.arms]));
  for (const [index, D0] of cutoffs.entries()) {
    if (index % shards !== shard) continue;
    const key = windowKey('GN', o.name, D0), arms = wanted.get(key);
    if (!arms) continue;
    const row = {key, norad, cutoff: iso(D0), arms: {}};
    const after = between(D0 + 1, D0 + 7 * DAY), first = after.length ? ms(after[0].epoch) : 0;
    const grid = after.filter((l) => (ms(l.epoch) - first) % gridMs === 0);
    const bins = Object.fromEntries(LEADS.map((k) => [k, grid.filter((l) => { const t = ms(l.epoch); return t > D0 + (k - 1) * DAY && t <= D0 + k * DAY; })]));
    const entered = LEADS.filter((k) => bins[k].length >= minBin), scored = entered.flatMap((k) => bins[k]);
    const epochs = scored.map((l) => l.epoch), truth = scored.map((l) => ({r: l.r, v: l.v})), sizes = entered.map((k) => bins[k].length);
    const gridB = S.gridBytes(epochs);
    const score = (e) => { const days = {}; let i = 0; entered.forEach((k, j) => { const s = e.slice(i, i + sizes[j]); i += sizes[j]; const ric = [0, 1, 2].map((c) => rms(s.map((q) => q[c]))); days[k] = {e: Math.hypot(...ric), r: ric[0], t: ric[1], n: ric[2]}; }); return days; };
    const arc = (hours) => { const raw = between(D0 - hours * HOUR, D0); const coverage = raw.length > 1 ? raw.length / ((hours * 3600) / ((ms(raw[1].epoch) - ms(raw[0].epoch)) / 1000)) : 0; return coverage >= MIN_COV ? T.thinned(raw).chosen : null; };
    for (const name of arms) {
      const {hours, fit} = ARMS[name];
      try {
        const thin = arc(hours);
        if (!thin || !entered.length) throw new Error('coverage');
        const oem = S.oemBytes({frame: 'GCRF', object: {name: o.name, id: o.objectId, norad: o.norad}, lines: thin, useableStart: thin[0].epoch, useableStop: iso(D0)});
        const pcf = S.pcfBytes({forces: {}, fit});
        const f = await A.fit(oem, pcf, undefined);
        if (!f.ok) throw new Error(f.error);
        const st = await A.propagate(f.omm, gridB, pcf, undefined, epochs.length);
        row.arms[name] = {ok: true, agom: S.readFitOmm(f.omm).agom, days: score(await m.rtn(await m.toAxes(st, epochs, 'GCRF'), truth))};
      } catch (error) {
        row.arms[name] = {ok: false, error: String(error?.message ?? error).slice(0, 180)};
      }
    }
    parentPort.postMessage({row});
  }
  parentPort.postMessage({done: true});
}

if (parentPort && workerData?.gnShortArc) replay(workerData).catch((error) => parentPort.postMessage({error: String(error?.stack ?? error)}));
