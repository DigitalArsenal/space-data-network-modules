#!/usr/bin/env node
// Whole-catalog cost of an engine from its run on the stratified sample
// (catalog-states.mjs): per-object CPU seconds by stratum (the strata of
// scripts/benchmark-catalog.mjs catalogStratum), weighted by each stratum's
// population in the catalog, and the wall time on the same thread count at
// the sample run's measured parallel efficiency. Labeled as extrapolated.
//
//   node tests/evidence/engines/catalog-score.mjs <catalog.json[.gz]> <results.tsv> <run.json> [--days 3]
//
// results.tsv: norad, thread CPU seconds, status (OrekitBench.java catalog).
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { catalogStratum, loadCatalog } from '../../../scripts/benchmark-catalog.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { days: { type: 'string', default: '3' } } });
const [catalogFile, resultsFile, runFile] = positionals;
const { records } = loadCatalog(catalogFile);
const population = new Map(), stratumOf = new Map();
for (const r of records) {
  const s = catalogStratum(r);
  population.set(s, (population.get(s) ?? 0) + 1);
  stratumOf.set(String(Number(r.NORAD_CAT_ID)), s);
}
const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
const by = new Map();
let notOk = 0;
for (const line of fs.readFileSync(resultsFile, 'utf8').trim().split('\n')) {
  const [norad, cpu, status] = line.split('\t');
  if (status !== 'ok') ++notOk;
  const s = stratumOf.get(String(Number(norad)));
  if (!by.has(s)) by.set(s, []);
  by.get(s).push(Number(cpu));
}
const days = Number(o.days);
const strata = [...population.keys()].sort().map((s) => {
  const v = by.get(s) ?? [];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { stratum: s, sampled: v.length, population: population.get(s), cpuSPerObject: mean, cpuSPerObjectDay: mean / days, populationCpuS: mean * population.get(s) };
});
const totalCpuS = strata.reduce((a, s) => a + s.populationCpuS, 0);
const objects = records.length;
const sampleCpuS = [...by.values()].flat().reduce((a, b) => a + b, 0);
const efficiency = sampleCpuS / (run.wallS * run.threads);
const out = { extrapolated: true, objects, days, threads: run.threads, sampleObjects: [...by.values()].flat().length, sampleNotOk: notOk,
  sampleWallS: run.wallS, sampleThreadCpuS: sampleCpuS, parallelEfficiency: efficiency,
  catalogCpuS: totalCpuS, catalogCpuSPerObjectDay: totalCpuS / (objects * days), catalogWallS: totalCpuS / (run.threads * efficiency), strata };
console.log(JSON.stringify(out, null, 1));
