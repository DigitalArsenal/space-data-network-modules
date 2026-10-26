#!/usr/bin/env node
// All-threads run of a single-threaded engine driver: N copies of one driver
// command start together, each writing its own result file; the per-copy
// CPU seconds per object-day under that load and the wall time of the whole
// set are reported. `{out}` in the command is replaced by each copy's result
// path.
//
//   node tests/evidence/engines/parallel.mjs <copies> <out.json> -- <command ...{out}...>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sep = process.argv.indexOf('--');
const [copiesArg, outArg] = process.argv.slice(2, sep);
const command = process.argv.slice(sep + 1);
const copies = Number(copiesArg), out = path.resolve(outArg);
const dir = `${out}.parts`;
fs.mkdirSync(dir, { recursive: true });
const load0 = os.loadavg();
const w0 = performance.now();
const runs = await Promise.all(Array.from({ length: copies }, (_, i) => new Promise((resolve, reject) => {
  const file = path.join(dir, `${i}.json`);
  const args = command.map((a) => a.replaceAll('{out}', file));
  const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', (code) => (code === 0 ? resolve(file) : reject(new Error(`copy ${i} exited ${code}: ${err.slice(-400)}`))));
})));
const wallS = (performance.now() - w0) / 1000;
const docs = runs.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const perCopy = docs.map((d) => d.results.map((r) => ({ id: r.id, algorithm: r.algorithm, cpuSPerObjectDay: r.cpuSPerObjectDay }))).flat();
const ids = [...new Set(perCopy.map((r) => `${r.id}${r.algorithm ? ` ${r.algorithm}` : ''}`))];
const summary = ids.map((id) => {
  const v = perCopy.filter((r) => `${r.id}${r.algorithm ? ` ${r.algorithm}` : ''}` === id).map((r) => r.cpuSPerObjectDay).sort((a, b) => a - b);
  return { id, copies: v.length, meanCpuSPerObjectDay: v.reduce((a, b) => a + b, 0) / v.length, minCpuSPerObjectDay: v[0], maxCpuSPerObjectDay: v.at(-1) };
});
const doc = { engine: docs[0].engine, version: docs[0].version, copies, logicalCpus: os.availableParallelism(), wallS, loadAverageStart: load0, loadAverageEnd: os.loadavg(), command, summary };
fs.writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
console.log(JSON.stringify({ engine: doc.engine, copies, wallS: Number(wallS.toFixed(2)), summary }, null, 1));
