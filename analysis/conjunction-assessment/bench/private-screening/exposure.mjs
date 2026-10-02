#!/usr/bin/env node
// What real conjunctions reveal: from an all-vs-all screen's output
// (scripts/run-all-vs-all-cpu.mjs --out), count each object's conjunctions
// and, for each large constellation, how many outside objects come within the
// screen's threshold of its members, and how often. Under private screening
// those are alerts the constellation's operator receives; each places the
// outside object near a known satellite at a known time.
//
//   node exposure.mjs <run.json>
import fs from 'node:fs';

const run = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const constellations = ['STARLINK', 'ONEWEB', 'KUIPER', 'QIANFAN'];
const groupOf = (name) => constellations.find((g) => name.toUpperCase().startsWith(g)) ?? null;
const names = new Map();
const perObject = new Map();
const outsiders = Object.fromEntries(constellations.map((g) => [g, new Map()]));
const within1km = Object.fromEntries(constellations.map((g) => [g, new Set()]));
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
for (const e of run.events) {
  names.set(e.primaryNorad, e.primary);
  names.set(e.secondaryNorad, e.secondary);
  bump(perObject, e.primaryNorad);
  bump(perObject, e.secondaryNorad);
  const ga = groupOf(e.primary), gb = groupOf(e.secondary);
  for (const [g, other] of [[gb, e.primaryNorad], [ga, e.secondaryNorad]]) {
    if (!g || groupOf(names.get(other)) === g) continue;
    bump(outsiders[g], other);
    if (e.missM < 1000) within1km[g].add(other);
  }
}
const quantile = (values, p) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
const members = Object.fromEntries(constellations.map((g) => [g, [...names.values()].filter((n) => groupOf(n) === g).length]));
const counts = [...perObject.values()].sort((a, b) => a - b);
const out = {
  run: { objects: run.objects, excluded: Array.isArray(run.excluded) ? run.excluded.length : run.excluded, days: run.durationDays,
    thresholdKm: 5, events: run.events.length },
  objectsWithConjunctions: perObject.size,
  conjunctionsPerObject: { median: quantile(counts, 0.5), p90: quantile(counts, 0.9), max: counts.at(-1) },
  constellations: Object.fromEntries(constellations.map((g) => {
    const v = [...outsiders[g].values()].sort((a, b) => a - b);
    return [g, { membersInEvents: members[g], outsidersWithConjunctions: v.length,
      perOutsider: v.length ? { median: quantile(v, 0.5), p90: quantile(v, 0.9), max: v.at(-1) } : null,
      outsidersWithAtLeast3: v.filter((x) => x >= 3).length, outsidersWithAtLeast10: v.filter((x) => x >= 10).length,
      outsidersWithin1km: within1km[g].size }];
  })),
};
console.log(JSON.stringify(out, null, 1));
