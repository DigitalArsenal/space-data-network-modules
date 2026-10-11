#!/usr/bin/env node
// How many catalog objects get new orbit data per update cycle: the k of an
// incremental screen. Reads Space-Track gp_history by CREATION_DATE (the
// archive's by-creation files) and, optionally, CelesTrak supplemental GP
// snapshots, and writes aggregates only (counts per cycle; no element set).
//
// An object counts in a cycle when a record created in it carries an element
// set that differs from the object's latest earlier one (epoch or any mean
// element); a record repeating the latest set is a republication. Cycles are
// 15 min, 1 h and 1 day of creation time. The catalog size N is the number of
// objects whose latest epoch is within 30 days (Space-Track's current gp).
//
// usage: node scripts/update-cadence.mjs --gp-history <by-creation dir> --from <ISO> --to <ISO>
//          [--warmup-days 30] [--supgp <celestrak supgp dir>] --out <summary.json>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseArgs } from 'node:util';
import { creationFiles, elementKey as elements, utcMs as utc } from './lib/gpHistory.mjs';

const { values: o } = parseArgs({ options: {
  'gp-history': { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, 'warmup-days': { type: 'string', default: '30' },
  supgp: { type: 'string' }, out: { type: 'string' },
} });
if (!o['gp-history'] || !o.from || !o.to || !o.out) throw new Error('usage: --gp-history <dir> --from <ISO> --to <ISO> --out <json>');
const DAY = 86400e3;
const from = Date.parse(o.from), to = Date.parse(o.to), warmup = from - Number(o['warmup-days']) * DAY;
const files = creationFiles(o['gp-history'], warmup, to);

// Every record in creation order (files overlap only at their edges).
const records = [];
for (const file of files) {
  for (const r of JSON.parse(zlib.gunzipSync(fs.readFileSync(file)))) {
    const created = utc(r.CREATION_DATE);
    if (created >= warmup && created < to) records.push([created, Number(r.NORAD_CAT_ID), utc(r.EPOCH), elements(r), r.GP_ID]);
  }
}
records.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

const latest = new Map();   // norad -> [epoch ms, elements]
const seenGp = new Set();
const bins = { '15min': 900e3, '1h': 3600e3, '1d': DAY };
const cycles = Object.fromEntries(Object.keys(bins).map((k) => [k, new Map()]));   // bin start -> {records, changed:Set, republished}
let catalogAtFrom = null, total = { records: 0, duplicates: 0, republished: 0, changed: 0, newObjects: 0 };
for (const [created, norad, epoch, set, gpId] of records) {
  if (seenGp.has(gpId)) { if (created >= from) total.duplicates++; continue; }   // the same record in two files
  seenGp.add(gpId);
  if (created >= from && catalogAtFrom === null) {
    catalogAtFrom = [...latest.values()].filter(([e]) => e >= from - 30 * DAY).length;
  }
  const prior = latest.get(norad);
  const changed = !prior || prior[1] !== set;
  if (!prior || epoch >= prior[0]) latest.set(norad, [epoch, set]);
  if (created < from) continue;
  total.records++;
  if (!prior) total.newObjects++;
  if (changed) total.changed++; else total.republished++;
  for (const [name, width] of Object.entries(bins)) {
    const start = from + Math.floor((created - from) / width) * width;
    let c = cycles[name].get(start);
    if (!c) cycles[name].set(start, c = { records: 0, changed: new Set(), republished: 0 });
    c.records++;
    if (changed) c.changed.add(norad); else c.republished++;
  }
}
const catalogAtTo = [...latest.values()].filter(([e]) => e >= to - 30 * DAY).length;

const quantile = (xs, q) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1) + 0.5))] : null;
const summary = (name) => {
  const width = bins[name], all = [];
  for (let start = from; start < to; start += width) {
    const c = cycles[name].get(start);
    all.push({ start, records: c?.records ?? 0, k: c?.changed.size ?? 0, republished: c?.republished ?? 0 });
  }
  const ks = all.map((x) => x.k).sort((a, b) => a - b), empty = all.filter((x) => x.k === 0).length;
  const sum = ks.reduce((s, x) => s + x, 0), mean = sum / ks.length;
  // Cycles by k (decades), and the cycles that carry a tenth of the catalog or more (batch publications).
  const edges = [0, 1, 10, 100, 1000, 10000, Infinity];
  const histogram = edges.slice(0, -1).map((lo, i) => ({ k: i === 0 ? '0' : `${lo}-${edges[i + 1] === Infinity ? '' : edges[i + 1] - 1}`,
    cycles: ks.filter((x) => (i === 0 ? x === 0 : x >= lo && x < edges[i + 1])).length }));
  const bursts = ks.filter((x) => x >= 0.1 * catalogAtTo);
  // Pair work per day in full screens: re-screening a cycle's k objects covers
  // 1 - (1 - k/N)^2 of the pairs; a full re-screen of every cycle with an update covers all of them.
  const days = (to - from) / DAY, N = catalogAtTo;
  const pairWork = { incrementalPerDay: +(ks.reduce((s, k) => s + 1 - (1 - Math.min(k, N) / N) ** 2, 0) / days).toFixed(2),
    fullPerDay: +(ks.filter((k) => k > 0).length / days).toFixed(2) };
  return { cycles: all.length, emptyCycles: empty, k: { mean: +mean.toFixed(1), median: quantile(ks, 0.5), p90: quantile(ks, 0.9),
    p99: quantile(ks, 0.99), max: ks.at(-1) }, kOverN: { mean: +(mean / catalogAtTo).toFixed(4), median: +(quantile(ks, 0.5) / catalogAtTo).toFixed(4),
    max: +(ks.at(-1) / catalogAtTo).toFixed(4) }, histogram, pairWork,
    batches: { cycles: bursts.length, perDay: +(bursts.length / ((to - from) / DAY)).toFixed(2), shareOfUpdates: +(bursts.reduce((s, x) => s + x, 0) / sum).toFixed(3),
      kOutside: { mean: +((sum - bursts.reduce((s, x) => s + x, 0)) / Math.max(1, ks.length - bursts.length)).toFixed(1),
        p90: quantile(ks.filter((x) => x < 0.1 * catalogAtTo), 0.9), max: ks.filter((x) => x < 0.1 * catalogAtTo).at(-1) ?? 0 } },
    largest: [...all].sort((a, b) => b.k - a.k).slice(0, 5).map((x) => ({ start: new Date(x.start).toISOString(), k: x.k, records: x.records })) };
};

// CelesTrak supplemental GP: per group, objects whose set changed between consecutive snapshots.
function supgp(dir) {
  const out = {};
  for (const group of fs.readdirSync(dir).filter((g) => !g.startsWith('_') && fs.statSync(path.join(dir, g)).isDirectory())) {
    const snaps = fs.readdirSync(path.join(dir, group)).filter((n) => /^\d{8}T\d{6}Z\.json$/.test(n)).sort();
    let prev = null;
    const steps = [];
    for (const name of snaps) {
      let rows;
      try { rows = JSON.parse(fs.readFileSync(path.join(dir, group, name), 'utf8')); } catch { continue; }
      if (!Array.isArray(rows)) continue;
      const map = new Map(rows.map((r) => [Number(r.NORAD_CAT_ID), elements(r)]));
      const at = Date.parse(`${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(9, 11)}:${name.slice(11, 13)}:${name.slice(13, 15)}Z`);
      if (prev) {
        let k = 0;
        for (const [norad, set] of map) if (prev.map.get(norad) !== set) k++;
        steps.push({ hours: (at - prev.at) / 3600e3, objects: map.size, k });
      }
      prev = { at, map };
    }
    if (steps.length) {
      const ks = steps.map((s) => s.k).sort((a, b) => a - b), hs = steps.map((s) => s.hours).sort((a, b) => a - b);
      out[group] = { snapshots: steps.length + 1, objects: steps.at(-1).objects, intervalHours: { median: +quantile(hs, 0.5).toFixed(2) },
        kPerInterval: { median: quantile(ks, 0.5), max: ks.at(-1) }, kOverObjects: +(quantile(ks, 0.5) / steps.at(-1).objects).toFixed(3) };
    }
  }
  return out;
}

const result = {
  source: 'Space-Track gp_history by CREATION_DATE (aggregates only)', from: o.from, to: o.to, files: files.length,
  catalog: { atFrom: catalogAtFrom, atTo: catalogAtTo, rule: 'objects whose latest epoch is within 30 days' },
  records: total, cycles: Object.fromEntries(Object.keys(bins).map((k) => [k, summary(k)])),
  ...(o.supgp ? { supgp: supgp(o.supgp) } : {}),
};
fs.writeFileSync(o.out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ catalog: result.catalog, records: total, k: Object.fromEntries(Object.entries(result.cycles).map(([n, c]) => [n, c.k])) }));
