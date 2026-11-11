// The AP6 windows of the 2026-11-03 gap diagnosis (experiments ap-gap, method ap): GD (ILRS and NSGF laser geodetic),
// DO (the altimetry group, provider E), IG and GE (GFZ MGEX), 72 h arcs, replayed on one or more modules with AP's FORCES (X2 atmosphere, tesseral 31, zonal
// 20) and as-issued $SPW rows: the truth's 300 s scoring grid, lead-day bins of at least 90 % of a day's grid epochs,
// arcs [cutoff - 72 h, cutoff] at 90 % coverage thinned to 300 s. Exploratory: these windows were read by the diagnosis.
// Held objects (ap-gap config.json EXCLUDE_NORADS) are rejected by file name before any byte is read.
import fs from 'node:fs';
import path from 'node:path';
import {parentPort, workerData} from 'node:worker_threads';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

import {experiments} from './experiments.mjs';
export {experiments};
export const archive = '/opt/data/sdn-archive/operator-theory/ap-gap';
const modules = fileURLToPath(new URL('../../../../', import.meta.url));
const HELD = new Set([43567, 37847, 41862, 41174, 43055, 41175, 39451, 39452, 39453, 43476, 43477]);
export const GROUPS = {GD: 5, DO: 10, IG: null, GE: null};

async function libs() {
  delete process.env.XP2F_CONTROL;  // the diagnosis's store: its as-issued RSGA for late 2025
  process.env.SDN_MODULES_ROOT = modules;
  const c = await import(experiments + '/experiments/xp2-fit-design/common.mjs');
  const dir = path.join(c.root, c.config.xm.dir);
  return {
    ...c, S: await import(path.join(dir, 'lib/sds.mjs')), T: await import(path.join(dir, 'lib/truth.mjs')),
    W: await import(path.join(dir, 'lib/weather.mjs')), M: await import(path.join(dir, 'lib/modules.mjs')),
    SRC: await import(pathToFileURL(path.join(c.root, 'experiments/sdn-gp-starlink-ffm-match/lib/sources.mjs')).href),
    R: await import(experiments + '/experiments/operator-theory/lib/regimes.mjs'),
    AP: await import(experiments + '/experiments/operator-theory/lib/ap.mjs'),
  };
}

/** The group's objects as ap-gap's objects() gives them: {name, norad, objectId, lines, cutoffs}. */
function objects(L, group) {
  if (group === 'GD' || group === 'DO') return L.R.STATIC.filter((x) => x.group === group).map((o) => {
    const s = L.SRC.chain(o.files());
    return {name: s.name || o.name, norad: s.norad, objectId: s.objectId ?? '', lines: s.lines, cutoffs: o.cutoffs};
  });
  const base = '/opt/data/sdn-archive/e14-covariance-realism/reference';
  const dirs = Array.from({length: 20}, (_, k) => `GFZ0MGXRAP_2025${274 + k}0000_01D_05M_ORB`).filter((d) => fs.existsSync(path.join(base, d)));
  if (!dirs.length) return [];
  const wanted = group === 'GE' ? /\dG$/ : /\dI$/;
  return fs.readdirSync(path.join(base, dirs[0])).filter((f) => /^\d+\.oem$/.test(f) && !HELD.has(Number(f.slice(0, -4))))
    .map((f) => ({f, head: L.SRC.readReference(path.join(base, dirs[0], f))})).filter((x) => wanted.test(x.head.name))
    .map(({f}) => L.SRC.chain(dirs.map((d) => path.join(base, d, f)).filter((p) => fs.existsSync(p))))
    .map((s) => ({name: s.name, norad: s.norad, objectId: s.objectId ?? '', lines: s.lines, cutoffs: L.R.MGEX_CUTOFFS}));
}

async function replay({group, index, modulePaths, fit = null}) {
  const L = await libs(), {HOUR, DAY, iso, ms, rms, XM, S, T, W} = L;
  const m = await L.M.openModules(), hosts = [];
  const TL = modules + 'propagator/sdn-ap/test/lib/';
  // #386: each arm is scored on its module's own GCRF output (the fit's own rotation, both ways). daysOld: the old path,
  // its TEME output through the pinned foundation/frames 0.2.0 (#389); frames030Meters: the same TEME output through this
  // checkout's foundation/frames 0.3.0 against the module's GCRF output (the consumer's path, a cross-check)
  const X = await import(TL + 'frames-cross.mjs'), frames030 = await X.openCheckoutFrames();
  // each module through the SDK's isomorphic harness as ap.mjs's openAp does, the fit's $OBD kept (SPEC 12.8's diagnostics)
  const SDK = pathToFileURL(createRequire(modules + 'propagator/sdn-ap/package.json').resolve('space-data-module-sdk/testing/isomorphic')).href;
  const O = await import(TL + 'ocm.mjs');
  for (const p of modulePaths) {
    // this build on $OCM (test/lib/ocm.mjs openApOcm); a 0.4 baseline as the vendored openAp drives it, its $OBD kept
    if (!O.legacyBuild(p)) { const A = await O.openApOcm(p); A.ocm = true; hosts.push(A); continue; }
    const A = await L.AP.openAp(p), h = await (await import(SDK)).createStandaloneHarness('browser', p, {surface: 'direct'});
    const weather = (extra) => (extra?.rows ? [{portId: 'space_weather', typeRef: S.TYPE('SPW'), payload: extra.rows}] : []);
    A.fit = async (oem, pcf, extra) => {
      const inputs = [{portId: 'ephemeris', typeRef: S.TYPE('OEM'), payload: oem}, {portId: 'configuration', typeRef: S.TYPE('PCF'), payload: pcf}, ...weather(extra)];
      const r = await h.invoke({methodId: 'fit', inputs});
      if (r.statusCode !== 0) return {ok: false, error: `${r.errorCode}: ${String(r.errorMessage).slice(0, 200)}`};
      const d = r.outputs.find((o) => o.portId === 'determination');
      return {ok: true, omm: new Uint8Array(r.outputs.find((o) => o.portId === 'elements').payload), obd: d ? new Uint8Array(d.payload) : null};
    };
    hosts.push(A);
  }
  const LEADS = XM.config.scoring.leadDays, GRID = XM.config.scoring.gridSeconds * 1000;
  const MIN_BIN = XM.config.scoring.binMinimumEpochs, MIN_COV = XM.config.fit.minimumCoverage;
  const pcf = S.pcfBytes({forces: L.AP.apForces(XM.config.arms.X2.forces, {tesseral: 31, zonal: 20}), fit});
  const list = objects(L, group);
  if (index >= list.length) { parentPort.postMessage({done: true}); return; }
  const o = list[index];
  if (HELD.has(Number(o.norad)) || /STARLINK/i.test(o.name)) throw new Error('excluded object');
  const times = o.lines.map((l) => ms(l.epoch));
  const stepMs = times.length > 1 ? times[1] - times[0] : GRID;
  const gridMs = Math.max(GRID, Math.ceil(GRID / stepMs) * stepMs);
  const minBin = Math.ceil((MIN_BIN / (DAY / GRID)) * (DAY / gridMs));
  const between = (a, b) => { const out = []; for (let i = 0; i < times.length; i += 1) if (times[i] >= a && times[i] <= b) out.push(o.lines[i]); return out; };
  for (const D0 of o.cutoffs) {
    const row = {key: L.R.windowKey(group, o.name, D0), group, norad: o.norad, cutoff: iso(D0), arms: []};
    try {
      const after = between(D0 + 1, D0 + 7 * DAY), first = after.length ? ms(after[0].epoch) : 0;
      const grid = after.filter((l) => (ms(l.epoch) - first) % gridMs === 0);
      const bins = Object.fromEntries(LEADS.map((k) => [k, grid.filter((l) => { const t = ms(l.epoch); return t > D0 + (k - 1) * DAY && t <= D0 + k * DAY; })]));
      const entered = LEADS.filter((k) => bins[k].length >= minBin);
      if (!entered.length) throw new Error('no lead bin');
      const scored = entered.flatMap((k) => bins[k]), epochs = scored.map((l) => l.epoch), truth = scored.map((l) => ({r: l.r, v: l.v}));
      const sizes = entered.map((k) => bins[k].length), gridB = S.gridBytes(epochs);
      const gridG = S.oemBytes({frame: 'GCRF', lines: epochs.map((epoch) => ({epoch, r: [0, 0, 0]}))});
      const R = W.rowsO(D0 - 72 * HOUR - XM.config.conditions.rowsMarginDays * DAY, D0);
      if (R.excluded) throw new Error(R.excluded);
      const ex = {rows: S.spwBytes(R.rows)};
      const score = (e) => { const days = {}; let i = 0; entered.forEach((k, j) => { const s = e.slice(i, i + sizes[j]); i += sizes[j]; const ric = [0, 1, 2].map((c) => rms(s.map((q) => q[c]))); days[k] = {e: Math.hypot(...ric), r: ric[0], t: ric[1], n: ric[2]}; }); return days; };
      const raw = between(D0 - 72 * HOUR, D0);
      const coverage = raw.length > 1 ? raw.length / ((72 * 3600) / ((ms(raw[1].epoch) - ms(raw[0].epoch)) / 1000)) : 0;
      if (coverage < MIN_COV) throw new Error('coverage');
      const thin = T.thinned(raw).chosen;
      const oem = S.oemBytes({frame: 'GCRF', object: {name: o.name, id: o.objectId, norad: o.norad}, lines: thin, useableStart: thin[0].epoch, useableStop: iso(D0)});
      for (const A of hosts) {
        try {
          const t0 = performance.now(), f = await A.fit(oem, pcf, ex), fitMs = performance.now() - t0;
          if (!f.ok) throw new Error(f.error);
          const own = await A.propagate(f.omm, gridG, pcf, ex, epochs.length), st = await A.propagate(f.omm, gridB, pcf, ex, epochs.length);
          const fo = A.ocm ? O.readFitOcm(f.omm) : S.readFitOmm(f.omm), ob = A.ocm ? {sigmaLnB: fo.sigmaLnB} : f.obd ? S.readObd(f.obd) : {};
          const frames030Meters = X.largestMeters(await frames030.convert(st.map((s, k) => ({...s, epoch: epochs[k]})), 'TEME', 'GCRF'), own);
          row.arms.push({ok: true, bterm: fo.bterm, agom: fo.agom, rmsKm: fo.fitRmsKm, comment: fo.u.COMMENT, sigmaLnB: ob.sigmaLnB ?? null,
            bModel: ob.bModel ?? null, fitMs, arcStates: thin.length, days: score(await m.rtn(own, truth)),
            daysOld: score(await m.rtn(await m.toAxes(st, epochs, 'GCRF'), truth)), frames030Meters});
        } catch (error) {
          row.arms.push({ok: false, error: String(error?.message ?? error).slice(0, 180)});
        }
      }
    } catch (error) {
      row.error = String(error?.message ?? error).slice(0, 180);
    }
    parentPort.postMessage({row});
  }
  parentPort.postMessage({done: true});
}

if (parentPort && workerData?.regimeWindows) replay(workerData).catch((error) => parentPort.postMessage({error: String(error?.stack ?? error)}));
