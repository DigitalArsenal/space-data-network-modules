// One experiment: windows over an ephemeris, each fitted by SGP4-XP (propagator/sgp4-xp `fit`) and by SDN's SGP4
// fitter (analysis/gp-error-model `fit_elements`) on the same states with the same epoch (the window's first state),
// then scored on the same held-out states by day after the end of the fit interval.
//
// Day k after the fit is the states in (E + (k-1) days, E + k days], E the end of the fit interval. The fit
// statistic is the RMS over the fit interval's states, which is each fitter's own (3D position, km, TEME).
// "At 0, 1, 3 and 7 days" in the results is: day 0 = the fit; days 1, 3 and 7 = those days' RMS.
import { frame, oemBytes, readOmm } from '../../lib/sds.mjs';
import { DAY, iso, ms } from './time.mjs';
import { json } from './modules.mjs';

const OEM_REFERENCE_FRAME = { EME2000: 'EME2000', GCRF: 'GCRF', ITRF: 'ITRF2000', TEME: 'TEMEOFDATE' };

function block(object, lines, from, to, useableStart, useableStop) {
  return oemBytes({
    originator: object.originator, creation: object.creation,
    blocks: [{ frame: OEM_REFERENCE_FRAME[object.frame] ?? object.frame, timeSystem: object.timeSystem, object: { name: object.name, id: object.objectId, norad: object.norad },
      lines, start: from, stop: to, useableStart, useableStop }],
  });
}

const slice = (object, fromMs, toMs) => {
  let lo = 0, hi = object.t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (object.t[mid] < fromMs) lo = mid + 1; else hi = mid; }
  const begin = lo;
  hi = object.t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (object.t[mid] <= toMs) lo = mid + 1; else hi = mid; }
  return object.lines.slice(begin, lo);
};

/** Fit windows of one object: starts every `strideSeconds` from its first state while a day-`minLead` still has states. */
export function windows(object, { fitSeconds, strideSeconds, minLeadDays = 1, offsetSeconds = 0 }) {
  const first = object.t[0] + offsetSeconds * 1000;
  const last = object.t[object.t.length - 1];
  const out = [];
  for (let start = first; start + fitSeconds * 1000 + minLeadDays * DAY <= last + 1; start += strideSeconds * 1000) out.push(start);
  return out;
}

const parameters = (omm) => Object.fromEntries(omm.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]));

/** SGP4-XP: { fit, days: {k: {rms, n}}, bterm, agom, ... } from propagator/sgp4-xp `fit`. */
export async function fitXp(mod, object, startMs, fitSeconds, maxLeadDays) {
  const stopFit = startMs + fitSeconds * 1000;
  const lines = slice(object, startMs, stopFit + maxLeadDays * DAY);
  const bytes = block(object, lines, lines[0].epoch, lines.at(-1).epoch, lines[0].epoch, iso(stopFit));
  const t0 = performance.now();
  let out;
  try { out = await mod.invoke('fit', [frame('ephemeris', 'OEM', bytes)]); } catch (error) { return { error: error.message }; }
  const omm = readOmm(out.elements[0]);
  const p = parameters(omm);
  const days = {};
  for (const key of Object.keys(p)) {
    const m = /^HELD_OUT_DAY(\d+)_RMS_KM$/.exec(key);
    if (m) days[m[1]] = { rms: Number(p[key]), n: Number(p[`HELD_OUT_DAY${m[1]}_STATES`]) };
  }
  return { fit: Number(p.FIT_RMS_KM), fitN: Number(p.FIT_STATES), days, bterm: omm.BSTAR, agom: omm.MEAN_MOTION_DDOT, meanMotion: omm.MEAN_MOTION, converged: p.FIT_CONVERGED === 'true', iterations: Number(p.FIT_ITERATIONS), seconds: (performance.now() - t0) / 1000, epoch: omm.EPOCH };
}

/** SDN's SGP4: { fit, days } from analysis/gp-error-model `fit_elements` then `element_residuals`. */
export async function fitSgp4(gem, object, startMs, fitSeconds, maxLeadDays) {
  const stopFit = startMs + fitSeconds * 1000;
  const lines = slice(object, startMs, stopFit + maxLeadDays * DAY);
  const bytes = block(object, lines, lines[0].epoch, lines.at(-1).epoch, null, null);
  const ephemeris = frame('ephemeris', 'OEM', bytes);
  const t0 = performance.now();
  let fit;
  try {
    fit = await gem.call('fit_elements', [ephemeris, json('options', { from: iso(startMs), to: iso(stopFit), epoch: 'first', fitBstar: true, closure: false })]);
  } catch (error) { return { error: error.message }; }
  const report = JSON.parse(fit.report.toString());
  const f = report.fits?.[0];
  if (!f || !f.converged) return { error: f?.error ?? 'not converged' };
  const windows = [];
  for (let k = 1; k <= maxLeadDays; k += 1) windows.push({ from: iso(stopFit + (k - 1) * DAY + 1), to: iso(stopFit + k * DAY), label: String(k) });
  let residuals;
  try {
    residuals = await gem.call('element_residuals', [{ portId: 'elements', payload: fit.elements, typeRef: { schemaName: 'OMM.fbs', fileIdentifier: '$OMM', rootTypeName: 'OMM', wireFormat: 'flatbuffer' } }, ephemeris,
      json('options', { requests: [{ norad: object.norad, set: f.epoch, windows }] })]);
  } catch (error) { return { error: error.message, fit: f.rms.rms3dKm }; }
  const result = JSON.parse(residuals.residuals.toString()).results[0];
  const days = {};
  for (const w of result.windows) if (w.n > 0) days[w.label] = { rms: w.rms3dKm, n: w.n };
  return { fit: f.rms.rms3dKm, fitN: f.rms.n, days, bstar: f.elements?.BSTAR, meanMotion: f.elements?.MEAN_MOTION, converged: true, seconds: (performance.now() - t0) / 1000, epoch: f.epoch };
}

/** The rows (one per object and window) of an experiment. */
export async function run({ objects, fitSeconds, strideSeconds, leadDays = [1, 3, 7], offsetSeconds = 0, mod, gem, onRow, minCoverage = 0.5 }) {
  const rows = [];
  const maxLead = Math.max(...leadDays);
  for (const object of objects) {
    const stepSeconds = (object.t[1] - object.t[0]) / 1000;
    for (const start of windows(object, { fitSeconds, strideSeconds, minLeadDays: Math.min(...leadDays), offsetSeconds })) {
      const [xp, sgp4] = [await fitXp(mod, object, start, fitSeconds, maxLead), gem ? await fitSgp4(gem, object, start, fitSeconds, maxLead) : null];
      const row = { source: object.source, object: object.id, norad: object.norad, start: iso(start), fitSeconds, stepSeconds, xp, sgp4 };
      rows.push(row);
      onRow?.(row);
    }
  }
  return rows;
}
