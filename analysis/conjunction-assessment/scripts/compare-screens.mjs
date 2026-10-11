#!/usr/bin/env node
// Matches the conjunctions of two screens (the summary JSON a runner writes
// with --out): the same object pair with TCAs within a window (default 600 s,
// a fraction of any LEO half-orbit), nearest first, each event used once.
// Prints the counts, the TCA and miss-distance differences on matched events,
// and the same per day of TCA from the screen's start. Event bookkeeping only.
//
// usage: node scripts/compare-screens.mjs <a.json> <b.json> [window seconds]
import fs from 'node:fs';
import path from 'node:path';

const [aPath, bPath, windowArg] = process.argv.slice(2);
if (!aPath || !bPath) throw new Error('usage: compare-screens.mjs <a.json> <b.json> [window seconds]');
const window = Number(windowArg ?? 600);
const A = JSON.parse(fs.readFileSync(aPath, 'utf8')), B = JSON.parse(fs.readFileSync(bPath, 'utf8'));

const byPair = (run) => {
  const out = new Map();
  for (const e of run.events) {
    const key = [e.primaryNorad, e.secondaryNorad].sort((x, y) => x - y).join('-');
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(e);
  }
  return out;
};
const pa = byPair(A), pb = byPair(B), matched = [];
for (const [key, ea] of pa) {
  const eb = pb.get(key) ?? [];
  const candidates = [];
  ea.forEach((x, i) => eb.forEach((y, j) => candidates.push([Math.abs(x.tcaJd - y.tcaJd) * 86400, i, j])));
  candidates.sort((p, q) => p[0] - q[0]);
  const tookA = new Set(), tookB = new Set();
  for (const [d, i, j] of candidates) {
    if (d > window) break;
    if (tookA.has(i) || tookB.has(j)) continue;
    tookA.add(i); tookB.add(j);
    matched.push([ea[i], eb[j], d]);
  }
}
const quantile = (v, p) => { const s = [...v].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const median = (v) => quantile(v, 0.5);
const stats = (pairs) => {
  const dt = pairs.map(([, , d]) => d), dm = pairs.map(([x, y]) => Math.abs(x.missM - y.missM));
  return { tcaAbsDiffS: { median: +median(dt).toFixed(3), p95: +quantile(dt, 0.95).toFixed(3), max: +Math.max(...dt).toFixed(3) },
    missAbsDiffM: { median: +median(dm).toFixed(1), p95: +quantile(dm, 0.95).toFixed(1), max: +Math.max(...dm).toFixed(1) } };
};
const start = A.startJd, dayOf = (e) => Math.min(2, Math.max(0, Math.floor(e.tcaJd - start)));
const perDay = [0, 1, 2].map((d) => {
  const m = matched.filter(([, y]) => dayOf(y) === d);
  const aEvents = A.events.filter((e) => dayOf(e) === d).length, bEvents = B.events.filter((e) => dayOf(e) === d).length;
  return { day: d + 1, aEvents, bEvents, matched: m.length, matchedShareOfB: bEvents ? +(m.length / bEvents).toFixed(4) : null, ...(m.length ? stats(m) : {}) };
});
console.log(JSON.stringify({
  a: path.basename(aPath), b: path.basename(bPath), windowS: window,
  aEvents: A.events.length, bEvents: B.events.length, matched: matched.length,
  matchedShareOfA: +(matched.length / A.events.length).toFixed(4), matchedShareOfB: +(matched.length / B.events.length).toFixed(4),
  ...stats(matched), perDayOfTca: perDay,
}, null, 1));
