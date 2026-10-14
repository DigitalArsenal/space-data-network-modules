// Shared study steps: an object's element-set history through the detector in
// calendar months (worker threads), and scoring against truth $MNV.
import fs from 'node:fs';
import path from 'node:path';
import { loadModule, config, TYPES, reportFrom, mnvRecord, MNV } from './host.mjs';
import { runPool, waitForLoad } from './pool.mjs';

export const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);

export function months(from, to) {
  const out = [], start = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  for (let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); m < end; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    out.push({ from: (m < start ? start : m).toISOString(), to: (next > end ? end : next).toISOString() });
  }
  return out;
}

// histories: [{history (path to a GP JSON list), from, to}] -> {variant: events}
export async function detectHistories(histories, variants, { provider = 'sgp4', workers = 6, marginSets = 0, environment } = {}) {
  const items = histories.flatMap((h) => months(h.from, h.to).map((m) => ({ ...m, history: path.resolve(h.history) })));
  await waitForLoad(45, log);
  const started = Date.now();
  const results = await runPool(new URL('./detect-task.mjs', import.meta.url), items, { variants, marginDays: 5, marginSets, provider, environment },
    { workers, onDone: (n, of, item) => { if (n % 10 === 0 || n === of) log(`${n}/${of} ${path.basename(item.history)} ${item.from.slice(0, 7)} ${Math.round((Date.now() - started) / 1000)} s`); } });
  return {
    sets: results.reduce((a, r) => a + r.sets, 0),
    events: Object.fromEntries(variants.map((v) => [v.name, results.flatMap((r) => r.variants[v.name])])),
  };
}

export const eventsMnv = (events) => Buffer.concat(events.map((e) => Buffer.from(mnvRecord({ ...e, STATUS: MNV.maneuverStatus.DETECTED, MNVR_ACCELS: e.MNVR_ACCELS ?? [] }))));

// {variant: events} against one truth stream -> {variant: score report}
export async function scoreVariants(eventsByVariant, truth, options) {
  const scorer = await loadModule('analysis/maneuver-detection');
  const out = {};
  try {
    for (const [name, events] of Object.entries(eventsByVariant)) {
      const r = await scorer.invoke('score_detections', [
        { portId: 'detected', payload: eventsMnv(events), typeRef: TYPES.MNV },
        { portId: 'truth', payload: truth, typeRef: TYPES.MNV },
        config(options),
      ]);
      out[name] = await reportFrom(r);
    }
  } finally {
    await scorer.destroy();
  }
  return out;
}

export function printScores(scores) {
  for (const [name, r] of Object.entries(scores)) {
    const s = r.summary;
    log(`${name.padEnd(10)} recall ${s.detected}/${s.truth} events ${s.events} false ${s.false_alarms} (${(s.false_alarms_per_object_year ?? 0).toFixed(2)}/y) ` +
        `|dt| ${s.time_error_abs_s ? (s.time_error_abs_s.median / 60).toFixed(0) + ' min' : '-'} dv ${s.dv_ratio ? s.dv_ratio.median.toFixed(2) : '-'}`);
  }
}

export const writeJson = (work, name, value) => {
  const file = path.join(work, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 1));
  return file;
};
